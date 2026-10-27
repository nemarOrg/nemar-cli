/**
 * The first step of executing a re-pull (ADR 0111, decision 2): the reviewed plan file is read,
 * proved to be the plan that was reviewed, and made again from live sources.
 *
 * What the file is trusted for: its body, and only once the body's digest is recomputed and equals
 * the one the file states (`plan-tampered` otherwise), so execution runs the reviewed plan and no
 * other. What it is never trusted for: its preflight and its `executable`. Both sit outside the
 * digest (they depend on the token the operator holds, not on the dataset), so the planner runs
 * again with the plan's own options and the LIVE answers decide; the file's two fields are not
 * read at all.
 *
 * The live plan must be the reviewed one. When NEMAR's `main` moved since the plan, the rule of
 * decision 2 applies, read narrowly: the bodies may differ only in `main`'s commit and tree, and
 * the commits between the two may touch only `.nemar/**` other than the privacy ledger
 * (`.nemar/corrections.jsonl`), whose new line can change what the plan refuses; execution then
 * bases on the live `main`. Anything else, a moved git-annex branch included, is `plan-stale`:
 * plan again and review the new digest.
 *
 * Refusals are {@link ExecuteRefused}, before anything is written anywhere: no API write, no push,
 * no upload. Their messages carry counts and fixed words, never a path or a key.
 */

import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { RunStep } from "../../../../shared/repull-state.js";
import {
  PLANNER_VERSION,
  PLAN_FILE_VERSION,
  PLAN_SCHEMA,
  type PlanBody,
  type PlanFile,
  planDigest,
  readPlanFile,
} from "../digest.js";
import type { ComputedBytes } from "../edits.js";
import { type CatalogFacts, RepullCannotPlan, planRepull } from "../plan.js";
import type { ReleaseFacts } from "../preflight.js";
import { readOnlyGit } from "../read-only.js";
import { preflightLines } from "../render.js";
import { type Env, listTree, originUrl, planSources, remoteEnv } from "../sources.js";

/** A refusal of execution: a fixed code, and a message with no path, key or value. */
export class ExecuteRefused extends Error {
  constructor(
    readonly code: string,
    message: string,
    /** Lines an operator reads beside the message (the live preflight), when there are any. */
    readonly lines: string[] = [],
  ) {
    super(message);
    this.name = "ExecuteRefused";
  }

  /**
   * Set once the record exists: the refusal left it as it was, with why on it, and a later run can
   * take it up again (the command's exit 3). Unset, nothing was written (exit 1).
   */
  resumable = false;

  /** The step of a dispatched run that met it: its report's word when `code` is not listed. */
  step?: RunStep;
}

/** Name the step `err` met, unless a step inside it already did; returns `err`. */
export function inStep<T>(err: T, step: RunStep): T {
  if (err instanceof ExecuteRefused) err.step ??= step;
  return err;
}

/** Where the live plan comes from, and what it may read. */
export interface LiveSources {
  catalog: CatalogFacts;
  github: { token: string | null; apiBase: string };
  /** The API this execution talks to (`getApiUrl()`); the plan must have been made against it. */
  environment: string;
  env: Env;
  /** Where the planner's scratch clones go; they are kept for materialization. */
  workRoot: string;
  collect: ComputedBytes;
  openNeuroGraphqlUrl?: string;
  /** The planner's fetch bound; the plan's own default when absent. */
  maxFetchBytes?: number;
  /**
   * Only for `execute --supersede`: whether a refused `release-pr` check is the superseded record's
   * own release branch and pull request, and nothing else's, judged from what that check read (no
   * second read). Asked only when that check is the one thing that keeps the live plan from being
   * executable; anything else still refuses.
   */
  ownRelease?: (facts: ReleaseFacts) => { ok: true } | { ok: false; why: string };
}

export interface VerifiedPlan {
  /** The plan file as read, every field. */
  file: Record<string, unknown>;
  /** The file's body: the reviewed plan, its digest proved. */
  body: PlanBody;
  /** The plan made again from live sources; its preflight and `executable` are the ones that count. */
  live: PlanFile;
  /** The live `main` execution bases on when it moved by `.nemar/**` only; null when it did not move. */
  rebasedOnto: string | null;
  /** The planner's kept scratch directory: `nemar.git` and `upstream.git`. */
  workdir: string;
}

export type PlanComparison = "equal" | "nemar-only-moved" | "different";

type NemarFacts = { main_commit?: unknown; main_tree?: unknown; annex_commit?: unknown };

function nemarOf(body: PlanBody): NemarFacts {
  const n = body.nemar;
  return n && typeof n === "object" && !Array.isArray(n) ? (n as NemarFacts) : {};
}

/**
 * How the live plan relates to the reviewed one. `equal`: the same body. `nemar-only-moved`: the
 * bodies differ only in `main`'s commit and tree, the git-annex branch is where it was; whether the
 * commits between touch only `.nemar/**` is the caller's to check, in the clone. Anything else,
 * a moved git-annex branch included, is `different`.
 */
export function comparePlans(fileBody: PlanBody, liveBody: PlanBody): PlanComparison {
  if (planDigest(fileBody) === planDigest(liveBody)) return "equal";
  const fileNemar = nemarOf(fileBody);
  // Only main's commit and tree are aligned: a git-annex branch that moved stays a difference.
  const aligned: PlanBody = {
    ...liveBody,
    nemar: {
      ...(liveBody.nemar as Record<string, PlanBody[string]>),
      main_commit: fileNemar.main_commit as PlanBody[string],
      main_tree: fileNemar.main_tree as PlanBody[string],
    },
  };
  return planDigest(aligned) === planDigest(fileBody) ? "nemar-only-moved" : "different";
}

/**
 * Whether the paths that differ between two `main` trees allow execution to base on the newer one
 * (decision 2's `.nemar/**` rule): every one is under `.nemar/`, and none is the privacy ledger.
 */
export function onlyNemarMoved(changed: readonly string[]): boolean {
  return (
    changed.length > 0 &&
    changed.every((p) => p.startsWith(".nemar/") && p !== ".nemar/corrections.jsonl")
  );
}

/** The paths whose entries differ between two trees (an add, a removal or a change). */
export function changedPaths(
  a: ReadonlyMap<string, { mode: string; oid: string }>,
  b: ReadonlyMap<string, { mode: string; oid: string }>,
): string[] {
  const out = new Set<string>();
  for (const [p, e] of a) {
    const o = b.get(p);
    if (!o || o.mode !== e.mode || o.oid !== e.oid) out.add(p);
  }
  for (const p of b.keys()) if (!a.has(p)) out.add(p);
  return [...out].sort();
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function objectOf(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** Read the file and prove its body is the reviewed one; no network. */
function readReviewed(path: string): { file: Record<string, unknown>; body: PlanBody } {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    throw new ExecuteRefused(
      "plan-unreadable",
      `The plan file could not be read${typeof code === "string" ? ` (${code})` : ""}.`,
    );
  }
  let read: ReturnType<typeof readPlanFile>;
  try {
    read = readPlanFile(text);
  } catch {
    throw new ExecuteRefused("plan-unreadable", "The plan file is not JSON.");
  }
  const { file, body, digest } = read;
  if (file.schema !== PLAN_SCHEMA || file.version !== PLAN_FILE_VERSION) {
    throw new ExecuteRefused(
      "plan-schema",
      `The file is not a re-pull plan this build reads (${PLAN_SCHEMA} version ${PLAN_FILE_VERSION}).`,
    );
  }
  if (body.planner !== PLANNER_VERSION) {
    throw new ExecuteRefused(
      "planner-version",
      `The plan was made by planner ${String(body.planner)}, and this build executes plans of planner ${PLANNER_VERSION} only: plan again, so the plan is made under the rules it is executed with.`,
    );
  }
  if (typeof file.digest !== "string" || file.digest !== digest) {
    throw new ExecuteRefused(
      "plan-tampered",
      "The plan's body does not hash to the digest the file states, so it is not the plan that was reviewed. Plan again.",
    );
  }
  return { file, body };
}

/**
 * The dataset and the digest a plan file names, proved as its body is in {@link readExecutablePlan}
 * (and so refused the same way), for the caller that needs them before it plans: where the
 * execution directory is and which catalog row to read.
 */
export function peekPlan(path: string): { datasetId: string; digest: string } {
  const { file, body } = readReviewed(path);
  const datasetId = str(body.dataset);
  if (!datasetId || !/^[a-z]{2}\d{6}$/.test(datasetId)) {
    throw new ExecuteRefused("plan-schema", "The plan names no dataset id.");
  }
  return { datasetId, digest: file.digest as string };
}

/**
 * An anonymous deposit is never re-pulled (ADR 0065): N.0.0 takes upstream's authors and README.
 * The Worker refuses it too; this stops it before anything is cloned or written. Only a row that
 * says `anonymous` is exactly 0 is not anonymous: an absent or unreadable field is unknown, never
 * clean.
 */
export function assertNotAnonymous(catalog: CatalogFacts): void {
  if (!catalog.dataset) {
    throw new ExecuteRefused(
      "dataset-missing",
      "The NEMAR API has no dataset row for the plan's dataset.",
    );
  }
  const anonymous = catalog.dataset.anonymous;
  if (anonymous !== 0) {
    throw new ExecuteRefused(
      anonymous === 1 ? "anonymous-dataset" : "anonymity-unknown",
      anonymous === 1
        ? "An anonymous dataset is never re-pulled: the re-pull takes upstream's authors and README, which would undo the blind."
        : "The dataset row does not say whether it is an anonymous deposit, and an anonymous one is never re-pulled.",
    );
  }
}

/**
 * The reviewed plan, proved without planning again: its body hashes to its digest, it was made by
 * this planner, against this API and from the same kind of remotes. What a run past `prepared`
 * reads, where a live plan would see the re-pull's own registration and branch.
 */
export function readReviewedPlan(
  path: string,
  live: Pick<LiveSources, "environment" | "env" | "openNeuroGraphqlUrl">,
): { file: Record<string, unknown>; body: PlanBody } {
  // 1. The file, and the proof that its body is the reviewed one.
  const { file, body } = readReviewed(path);

  // 2. Where it was made: against this API, and from the same kind of remotes.
  if (file.environment !== live.environment) {
    throw new ExecuteRefused(
      "plan-environment",
      "The plan was made against another NEMAR API than the one this execution talks to.",
    );
  }
  const sources = planSources(live.env, live.openNeuroGraphqlUrl);
  if (file.sources !== sources) {
    throw new ExecuteRefused(
      "plan-sources",
      `The plan was made from ${String(file.sources)} and this execution reads ${sources}; a plan made from test bases never executes against the real remotes, nor the reverse.`,
    );
  }
  return { file, body };
}

/**
 * Read the reviewed plan and make it again from live sources; refuse unless the live plan is the
 * reviewed one (or it differs by a `.nemar/**`-only move of `main`) and is executable now.
 */
export async function readExecutablePlan(path: string, live: LiveSources): Promise<VerifiedPlan> {
  const { file, body } = readReviewedPlan(path, live);
  assertNotAnonymous(live.catalog);

  // 3. The live plan, with the plan's own options.
  const upstream = objectOf(body.upstream);
  const copy = objectOf(body.copy);
  const datasetId = str(body.dataset);
  const toTag = str(upstream.to_tag);
  if (!datasetId || !toTag) {
    throw new ExecuteRefused("plan-schema", "The plan names no dataset or no to_tag.");
  }
  let outcome: Awaited<ReturnType<typeof planRepull>>;
  try {
    outcome = await planRepull({
      datasetId,
      toTag,
      // A from-tag the plan was given by flag is given again, and the live check refuses it.
      fromTag:
        upstream.from_tag_source === "flag" ? (str(upstream.from_tag) ?? undefined) : undefined,
      presence: copy.presence_basis === "bucket-listing" ? "bucket-listing" : "location-log",
      ...(live.maxFetchBytes !== undefined ? { maxFetchBytes: live.maxFetchBytes } : {}),
      keepWorkdir: true,
      workRoot: live.workRoot,
      env: live.env,
      catalog: live.catalog,
      github: live.github,
      environment: live.environment,
      openNeuroGraphqlUrl: live.openNeuroGraphqlUrl,
      collect: live.collect,
    });
  } catch (err) {
    throw new ExecuteRefused(
      "not-planned",
      err instanceof RepullCannotPlan
        ? `The plan could not be made again: ${err.message}.`
        : `The plan could not be made again: ${err instanceof Error ? err.name : "error"}.`,
    );
  }
  const workdir = outcome.workdir;
  const discard = () => {
    if (workdir) rmSync(workdir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  };
  if (!outcome.planned || !workdir) {
    discard();
    throw new ExecuteRefused(
      "not-planned",
      outcome.planned
        ? "The planner kept no scratch clones."
        : `Nothing was planned from live sources: ${outcome.reason}.`,
      outcome.planned ? [] : preflightLines(outcome.preflight),
    );
  }
  try {
    // 4. The live plan is the reviewed one, or differs by a `.nemar/**`-only move of `main`.
    const verdict = comparePlans(body, outcome.file.body);
    let rebasedOnto: string | null = null;
    if (verdict === "different") throw stale();
    if (verdict === "nemar-only-moved") {
      const fileMain = str(nemarOf(body).main_commit);
      const liveMain = str(nemarOf(outcome.file.body).main_commit);
      if (!fileMain || !liveMain) throw stale();
      const changed = await mainMoves(join(workdir, "nemar.git"), datasetId, fileMain, liveMain, {
        env: live.env,
        token: live.github.token,
      });
      if (changed === null || !onlyNemarMoved(changed)) throw stale();
      rebasedOnto = liveMain;
    }

    // 5. Executable now, by the live answers; the file's preflight and `executable` are not read.
    const tolerated = outcome.file.executable
      ? null
      : ownReleaseOnly(outcome.file, outcome.release, live);
    if (!outcome.file.executable && tolerated?.ok !== true) {
      const refusals = (outcome.file.body.refusals as Array<{ code?: unknown }> | undefined) ?? [];
      const unpinned = (objectOf(outcome.file.body.copy).unpinned as unknown[] | undefined) ?? [];
      throw new ExecuteRefused(
        "not-executable",
        `The plan is not executable now: ${[
          ...outcome.file.preflight.filter((c) => c.status !== "ok").map((c) => c.code ?? c.name),
          ...refusals.map((r) => String(r.code)),
          ...(unpinned.length > 0 ? [`${unpinned.length} unpinned key(s)`] : []),
        ].join(", ")}.`,
        [
          ...preflightLines(outcome.file.preflight),
          ...(tolerated && !tolerated.ok ? [`Not superseded: ${tolerated.why}.`] : []),
        ],
      );
    }
    return { file, body, live: outcome.file, rebasedOnto, workdir };
  } catch (err) {
    discard();
    throw err;
  }
}

/**
 * Whether the one thing that keeps the live plan from being executable is a `release-pr` refusal
 * (its two refusal words, which no other check uses) for a release branch or pull request that the
 * superseded record owns (`ownRelease`, judged from what the check read), with every other check
 * `ok`, no plan refusal and no unpinned key. Without `ownRelease` it is never so; when it is not, why
 * is said beside the live preflight.
 */
function ownReleaseOnly(
  live: PlanFile,
  facts: ReleaseFacts,
  sources: LiveSources,
): { ok: true } | { ok: false; why: string } | null {
  if (!sources.ownRelease) return null;
  const failing = live.preflight.filter((c) => c.status !== "ok");
  const refusals = (live.body.refusals as unknown[] | undefined) ?? [];
  const unpinned = (objectOf(live.body.copy).unpinned as unknown[] | undefined) ?? [];
  if (refusals.length > 0 || unpinned.length > 0 || failing.length !== 1) {
    return {
      ok: false,
      why: "the plan is not executable for more than the superseded record's own release",
    };
  }
  const code = failing[0]?.code;
  if (code !== "release-branch-exists" && code !== "release-pr-open") {
    return {
      ok: false,
      why: "the plan is not executable for another reason than a release branch or pull request",
    };
  }
  return sources.ownRelease(facts);
}

function stale(): ExecuteRefused {
  return new ExecuteRefused(
    "plan-stale",
    "The live sources no longer give the reviewed plan: plan again and review the new digest.",
  );
}

/**
 * The paths that differ between the plan's `main` and the live one, read in the planner's bare
 * clone of NEMAR (which holds the live `main`; the plan's commit is fetched at depth 1). Null when
 * the plan's commit cannot be fetched: then nothing can show the move is `.nemar/**` only.
 */
async function mainMoves(
  repo: string,
  datasetId: string,
  fileMain: string,
  liveMain: string,
  ctx: { env: Env; token: string | null },
): Promise<string[] | null> {
  const env = remoteEnv(originUrl(datasetId, ctx.env), ctx.token);
  const fetched = await readOnlyGit(
    ["fetch", "--quiet", "--depth=1", "--no-tags", "origin", fileMain],
    { cwd: repo, env },
  );
  if (fetched.exitCode !== 0) return null;
  try {
    const [a, b] = await Promise.all([listTree(repo, fileMain), listTree(repo, liveMain)]);
    // `.github/**` is NEMAR's too, but it is not `.nemar/**`: a workflow change counts as a move.
    return changedPaths(a, b);
  } catch {
    return null;
  }
}
