/**
 * Execute a reviewed re-pull plan, through the open pull request (ADR 0111, decisions 2, 3 and 8;
 * epic #1046 phase 6). It runs on the administrator's machine, with the administrator's own GitHub
 * token and ambient AWS credentials; the Worker records each step and checks what it can read
 * itself. It never merges.
 *
 *   S0  read the plan file, prove it is the reviewed one, plan again from live sources
 *       (`verify-plan.ts`); no API write, push or upload happens before this passes (the scratch
 *       directory for the planner's clones is a local write);
 *   S1  `POST /admin/repulls`: the record, or the open one for this same plan (`planned`);
 *   S2  a working clone at the base, the delta materialized, scrubbed, uploaded where the scrub
 *       re-keyed or annexed, and synthesized into one commit; the checkpoint saved; then
 *       `planned -> prepared` with the commit, its tree, the copy manifest's digest and counts;
 *   S3 to S5  the copy, the registration and the pull request (`advance.ts`), to `pr_open`.
 *
 * A dispatched run (`opts.automatic`, the central workflow's; `automatic.ts`) adds three things and
 * changes nothing else: before anything is written, the LIVE plan must be one the automatic path
 * takes (`assertAutomaticPlan`); S1 presents the dispatch, so the Worker records the re-pull as
 * automatic; and at `pr_open`, still holding the lock, the release head is settled (`settle.ts`)
 * before the run reports it.
 *
 * A record past `prepared` is not planned again: the registration moved origin's git-annex branch
 * and the release branch exists, so a live plan would differ by what this execution itself wrote.
 * Such a run proves the file (`readReviewedPlan`: its digest, planner, API and remotes), and takes
 * the record for the same digest up where it stopped, from the working clone or its checkpoint.
 * Every run refuses an anonymous dataset first, from the catalog row, before anything is written.
 *
 * The uploads preparation makes are those of the import's own scrub and annex policy, to
 * `<id>/objects/` only. Every git and git-annex call it makes, the planner's included, reads
 * neither the administrator's global configuration nor the system's.
 *
 * Only a `prepared` row resumes preparation from what is on disk: one whose working clone still
 * holds its commit is left as it is; otherwise the clone is restored from the checkpoint, or
 * prepared again, which must give the same tree, commit and manifest (`prepare-not-reproducible`
 * otherwise: the row stays, its error set, and abandoning the record is the way out; no command for it is built yet). A `planned` row is
 * prepared again from scratch, which re-clones, re-scrubs and re-uploads, deterministically. A step
 * that fails records why on the row (a self-edge with the facts it already holds) and refuses; the
 * message names counts, never a path. One execution of a plan runs at a time (a lock beside its
 * working directory).
 */

import { existsSync, readdirSync, rmdirSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  PROVENANCE_PATH,
  PROVENANCE_README_PATH,
} from "../../../../shared/privacy-correction-text.js";
import type { RepullRow, RepullStatus } from "../../../../shared/repull-state.js";
import { getApiUrl } from "../../api/client.js";
import { ApiError } from "../../api/errors.js";
import { createRepull, listRepulls, repullErrorCode, transitionRepull } from "../../api/repull.js";
import { getConfigDir } from "../../config.js";
import { fleetCloneEnv } from "../../fleet-key-registration.js";
import { listAnnexedKeys } from "../../git-annex/transfer.js";
import { NORMALIZE_MAX_BYTES } from "../../import-normalize.js";
import { describeError, httpUpstreamReader } from "../../import-scrub.js";
import { awsCliUpload } from "../../normalize-dataset.js";
import { adminGitHubToken, githubApiBase } from "../../pr-review-approve.js";
import type { PlanBody } from "../digest.js";
import { nemarRemoteOf } from "../plan.js";
import {
  type Env,
  openNeuroGraphqlUrl as openNeuroUrlFromEnv,
  originUrl,
  readRemoteLog,
  upstreamUrl,
} from "../sources.js";
import {
  type AdvanceContext,
  EXECUTE_STATUSES,
  advancePrepared,
  reached,
  removeWorkdir,
} from "./advance.js";
import { assertAutomaticCounts, assertAutomaticPlan } from "./automatic.js";
import { copyItems, copySection, planCounts, planFacts } from "./body.js";
import { readCatalogFacts } from "./catalog.js";
import { commitMaterialized, materializeDelta } from "./materialize.js";
import { openOriginScratch } from "./origin.js";
import { heldKeys, scrubDelta } from "./scrub-delta.js";
import { type SettleOptions, type Settled, settleReleaseHead } from "./settle.js";
import { type Entry, readIndex, readTree, rowTime, synthesizeCommit } from "./synthesize.js";
import {
  ExecuteRefused,
  assertNotAnonymous,
  peekPlan,
  readExecutablePlan,
  readReviewedPlan,
} from "./verify-plan.js";
import {
  type WorkPaths,
  acquireLock,
  git,
  privateDir,
  removeTree,
  restoreCheckpoint,
  saveCheckpoint,
  withIsolatedGit,
  workClone,
  workPaths,
} from "./workdir.js";

/** What the administrator confirms before a run writes anything. */
export interface ExecuteSummary {
  datasetId: string;
  fromTag: string;
  toTag: string;
  toVersion: string;
  /** The version DOIs the re-pull's merges mint (N.0.0, and N.0.1 when there are corrections). */
  doiCount: number;
  /** The keys the plan copies, an upper bound because the scrub's re-keyed recordings are uploaded instead of copied. */
  copyItems: number;
  /** The record's status when the run starts, or null when it creates the record. */
  status: RepullStatus | null;
  until: RepullStatus;
}

export interface ExecuteOptions {
  planPath: string;
  /** Stop after this status; `pr_open` (the default) is the furthest execution goes. */
  until?: RepullStatus;
  /**
   * Keep the planner's scratch clones after the run, and the working directory after `pr_open`
   * (it is always kept before, so a stopped run can resume from it).
   */
  keepWorkdir?: boolean;
  /** The bound on bytes this host downloads and uploads for the scrub and the annex policy. */
  normalizeMaxBytes?: number;
  /** The planner's bound on large blobs fetched for its checks. */
  maxFetchBytes?: number;
  /** Test bases and their stand-ins, the token and the API overrides; the process's by default. */
  env?: Env;
  /**
   * Asked once, before the run writes anything; false stops it with nothing written
   * (`declined`). Absent: the run proceeds (the command passes one unless `--yes`).
   */
  confirm?: (summary: ExecuteSummary) => Promise<boolean>;
  /** Tests only: the copy's single-copy bound and part size. */
  copy?: { singleCopyMax?: number; partBytes?: number };
  /**
   * A dispatched run (ADR 0111, decision 6): the dispatch the automatic create presents, the
   * re-pull a resume dispatch continues (null for a first dispatch), and how the release head is
   * settled at `pr_open`. Absent for an administrator's run.
   */
  automatic?: AutomaticExecution;
  out: (line: string) => void;
}

export interface AutomaticExecution {
  dispatchId: number;
  /** The dispatch token: a secret, sent only in the create's body. */
  token: string;
  repullId: number | null;
  settle: SettleOptions;
}

/** Where a run stopped, and, for a dispatched run at `pr_open`, how its release head settled. */
export interface ExecuteResult {
  row: RepullRow;
  stoppedAt: RepullStatus;
  settled?: Settled;
}

/** The statuses a run prepares from: before them the record is made, after them it is advanced. */
const PREPARING: readonly RepullStatus[] = ["planned", "prepared"];

/**
 * Upstream's object endpoint for the scrub's pinned reads: the real one, or a test's stand-in
 * through `NEMAR_REPULL_UPSTREAM_OBJECTS_BASE`, honored only for a loopback http address (the
 * `NEMAR_GITHUB_API_URL` rule); a set value that is not one refuses rather than being ignored.
 */
export function upstreamObjectsBase(env: Env): string | undefined {
  const value = env.NEMAR_REPULL_UPSTREAM_OBJECTS_BASE?.trim();
  if (!value) return undefined;
  try {
    const u = new URL(value);
    if (u.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname)) {
      return value.replace(/\/+$/, "");
    }
  } catch {
    // refused below
  }
  throw new ExecuteRefused(
    "test-base-refused",
    "NEMAR_REPULL_UPSTREAM_OBJECTS_BASE is set but is not an http://127.0.0.1, http://localhost or http://[::1] address. It is only for tests, so it is refused rather than ignored.",
  );
}

/** What a preparation produced, as the row records it. */
interface Prepared {
  synthSha: string;
  synthTree: string;
  manifestDigest: string;
  counts: Record<string, number>;
}

/** What every step of one run shares. */
interface RunContext {
  env: Env;
  token: string | null;
  datasetId: string;
  digest: string;
  body: PlanBody;
  paths: WorkPaths;
  plannerDir: string;
  computed: Map<string, Buffer>;
  /** Upstream's object endpoint for pinned reads (a loopback stand-in in tests), else S3's own. */
  objectsBase: string | undefined;
  normalizeMaxBytes: number;
  automatic: AutomaticExecution | undefined;
  out: (line: string) => void;
}

function recordRefused(err: unknown): ExecuteRefused {
  const code = repullErrorCode(err);
  return new ExecuteRefused(
    code ?? "record-refused",
    `The NEMAR API refused the record${code ? ` (${code})` : ""}: ${err instanceof Error ? err.message : String(err)}`,
  );
}

/**
 * How every error this preparation records on a row begins: `[prepare:<code>]`. A run that finds
 * the row's facts hold again clears only an error that begins so; one a later step wrote stays.
 */
export const PREPARE_ERROR_PREFIX = "[prepare:";

/**
 * A failure's words for `last_error`: the preparation's prefix with the refusal's code and its
 * message, else its class only.
 */
export function errorWords(err: unknown): string {
  if (err instanceof ExecuteRefused) return `${PREPARE_ERROR_PREFIX}${err.code}] ${err.message}`;
  return `${PREPARE_ERROR_PREFIX}prepare-failed] The preparation failed: ${describeError(err)}.`;
}

/** Remove a directory the run made, telling the operator rather than failing the run when it cannot. */
function removeQuietly(path: string, out: (line: string) => void): void {
  try {
    removeTree(path);
  } catch (err) {
    out(
      `The scratch directory ${path} could not be removed (${err instanceof ExecuteRefused ? err.code : describeError(err)}); remove it by hand.`,
    );
  }
}

/** Remove `dir` when it is empty; nothing otherwise. */
function removeIfEmpty(dir: string): void {
  try {
    if (readdirSync(dir).length === 0) rmdirSync(dir);
  } catch {
    // absent, or not empty: left as it is
  }
}

/** Run through `pr_open` (or `opts.until`); never further. See the module comment. */
export async function executeRepull(opts: ExecuteOptions): Promise<ExecuteResult> {
  const env = opts.env ?? process.env;
  const until = opts.until ?? "pr_open";
  if (!(EXECUTE_STATUSES as readonly RepullStatus[]).includes(until)) {
    throw new ExecuteRefused(
      "until-not-allowed",
      `Execution stops at ${EXECUTE_STATUSES.join(", ")}; it never goes past the open pull request.`,
    );
  }
  return withIsolatedGit(() => execute(opts, env, until));
}

/**
 * A dispatched run's record must be the automatic path's own, and the one its dispatch continues
 * when it names one: an administrator's record of the same plan is never taken up by a run, which
 * would push and open its pull request as the App.
 */
function assertAutomaticRecord(a: AutomaticExecution, row: RepullRow): void {
  if (row.origin !== "automatic") {
    throw new ExecuteRefused(
      "repull-in-flight",
      `Re-pull #${row.id} of ${row.dataset_id} is an administrator's: a dispatched run never takes it up.`,
    );
  }
  if (a.repullId !== null && row.id !== a.repullId) {
    throw new ExecuteRefused(
      "repull-mismatch",
      `The dispatch continues re-pull #${a.repullId}, and the record found is #${row.id}.`,
    );
  }
}

/**
 * A dispatched run at `pr_open`: settle the release head before the run reports it, holding the
 * run's lock, in a scratch repository of origin's. A failure to read or record is resumable: the
 * pull request is open, and a later run takes the record up at `pr_open` and settles again.
 */
async function settleOpened(
  opts: ExecuteOptions,
  env: Env,
  token: string | null,
  digest: string,
  row: RepullRow,
): Promise<Settled | undefined> {
  if (!opts.automatic || row.status !== "pr_open") return undefined;
  const scratch = await openOriginScratch({
    configDir: getConfigDir(),
    datasetId: row.dataset_id,
    digest,
    purpose: "settle",
    env,
    token,
  });
  try {
    return await settleReleaseHead({ scratch, row, opts: opts.automatic.settle, out: opts.out });
  } catch (err) {
    throw resumable(err);
  } finally {
    scratch.close();
  }
}

/** The dataset's open record, if any (a GET, before anything is written). */
async function openRecord(datasetId: string): Promise<RepullRow | null> {
  try {
    return (await listRepulls({ dataset: datasetId, open: true, limit: 1 })).repulls[0] ?? null;
  } catch (err) {
    if (err instanceof ApiError) throw recordRefused(err);
    throw err;
  }
}

/** Ask the administrator, when the caller gave a way to; refuse (`declined`) on no. */
async function confirmed(
  opts: ExecuteOptions,
  body: PlanBody,
  status: RepullStatus | null,
  until: RepullStatus,
): Promise<void> {
  if (!opts.confirm) return;
  const facts = planFacts(body);
  const ok = await opts.confirm({
    datasetId: facts.datasetId,
    fromTag: facts.fromTag,
    toTag: facts.toTag,
    toVersion: facts.toVersion,
    doiCount: planCounts(body).doi_count ?? 1,
    copyItems: copyItems(body).filter((i) => i.purpose === "copy").length,
    status,
    until,
  });
  if (!ok) throw new ExecuteRefused("declined", "Not confirmed; nothing was written.");
}

/** Mark a refusal that left a record behind as resumable (the command's exit 3). */
function resumable(err: unknown): unknown {
  if (err instanceof ExecuteRefused) err.resumable = true;
  return err;
}

async function execute(
  opts: ExecuteOptions,
  env: Env,
  until: RepullStatus,
): Promise<ExecuteResult> {
  // S0. The reviewed plan, made again from live sources. No API write, push or upload happens
  // before it passes; a test override that is set and not a loopback address refuses here.
  const { datasetId, digest } = peekPlan(opts.planPath);
  const apiBase = githubApiBase(env);
  const openNeuroGraphqlUrl = openNeuroUrlFromEnv(env);
  const objectsBase = upstreamObjectsBase(env);
  const configDir = getConfigDir();
  const paths = workPaths(configDir, datasetId, digest);
  const top = join(configDir, "repull");
  privateDir(dirname(paths.lock), top);
  const release = acquireLock(paths.lock);
  try {
    const token = await adminGitHubToken(env);
    if (!token.ok) opts.out(`No GitHub token (${token.reason}); release-pr will be unchecked.`);
    const catalog = await readCatalogFacts(datasetId);
    // Every run, before anything is written: the Worker refuses an anonymous dataset too.
    assertNotAnonymous(catalog);

    // A record of this plan past `prepared` is taken up where it stopped, without planning again.
    const open = await openRecord(datasetId);
    if (open && open.plan_digest === digest && !PREPARING.includes(open.status)) {
      const { body } = readReviewedPlan(opts.planPath, {
        environment: getApiUrl(),
        env,
        openNeuroGraphqlUrl,
      });
      if (opts.automatic) {
        assertAutomaticRecord(opts.automatic, open);
        // No live plan exists past `prepared` (the registration moved the branch the planner
        // reads): the reviewed body's counts are read instead.
        assertAutomaticCounts(body);
      }
      const advance: AdvanceContext = {
        env,
        token: token.ok ? token.token : null,
        datasetId,
        digest,
        body,
        paths,
        apiBase,
        keepWorkdir: opts.keepWorkdir === true,
        out: opts.out,
        ...(opts.copy ? { copy: opts.copy } : {}),
      };
      opts.out(`Found re-pull #${open.id} of ${datasetId}, ${open.status}.`);
      // The pull request is open: the working clone, which holds the delta's unscrubbed
      // originals, is of no further use. A run killed before it removed it finds it here.
      if (reached(open.status, "pr_open")) removeWorkdir(paths, advance.keepWorkdir, opts.out);
      if (reached(open.status, until)) {
        if (!(EXECUTE_STATUSES as readonly RepullStatus[]).includes(open.status)) {
          opts.out(
            `Re-pull #${open.id} is past the open pull request; execute never merges. Take it on with: nemar admin repull resume ${datasetId}`,
          );
        }
        const settled = await settleOpened(opts, env, advance.token, digest, open);
        return {
          row: settled?.row ?? open,
          stoppedAt: open.status,
          ...(settled ? { settled } : {}),
        };
      }
      await confirmed(opts, body, open.status, until);
      let row: RepullRow;
      try {
        row = await advancePrepared(advance, open, until, recorder(opts.out));
      } catch (err) {
        throw resumable(err);
      }
      const settled = await settleOpened(opts, env, advance.token, digest, row);
      return {
        row: settled?.row ?? row,
        stoppedAt: row.status,
        ...(settled ? { settled } : {}),
      };
    }

    removeTree(paths.plan);
    privateDir(paths.plan, top);
    const computed = new Map<string, Buffer>();
    let verified: Awaited<ReturnType<typeof readExecutablePlan>>;
    try {
      verified = await readExecutablePlan(opts.planPath, {
        catalog,
        github: { token: token.ok ? token.token : null, apiBase },
        environment: getApiUrl(),
        env,
        workRoot: paths.plan,
        collect: { computed },
        openNeuroGraphqlUrl,
        ...(opts.maxFetchBytes !== undefined ? { maxFetchBytes: opts.maxFetchBytes } : {}),
      });
      // A dispatched run takes only a plan the automatic path takes, read from the LIVE plan
      // this run just made, before anything is written.
      if (opts.automatic) assertAutomaticPlan(verified.live);
    } catch (err) {
      // Refused before anything was prepared: leave no empty directory behind it.
      removeQuietly(paths.plan, opts.out);
      removeIfEmpty(paths.root);
      removeIfEmpty(dirname(paths.root));
      throw err;
    }
    const ctx: RunContext = {
      env,
      token: token.ok ? token.token : null,
      datasetId,
      digest,
      body: verified.live.body,
      paths,
      plannerDir: verified.workdir,
      computed,
      objectsBase,
      normalizeMaxBytes: opts.normalizeMaxBytes ?? NORMALIZE_MAX_BYTES,
      automatic: opts.automatic,
      out: opts.out,
    };
    try {
      await confirmed(opts, ctx.body, open?.plan_digest === digest ? open.status : null, until);
      const prepared = await recordAndPrepare(ctx, verified.rebasedOnto, until);
      if (reached(prepared.row.status, until)) {
        const settled = await settleOpened(opts, env, ctx.token, digest, prepared.row);
        return settled ? { ...prepared, row: settled.row, settled } : prepared;
      }
      let row: RepullRow;
      try {
        row = await advancePrepared(
          {
            env,
            token: ctx.token,
            datasetId,
            digest,
            body: ctx.body,
            paths,
            apiBase,
            keepWorkdir: opts.keepWorkdir === true,
            out: opts.out,
            ...(opts.copy ? { copy: opts.copy } : {}),
          },
          prepared.row,
          until,
          recorder(opts.out),
        );
      } catch (err) {
        throw resumable(err);
      }
      const settled = await settleOpened(opts, env, ctx.token, digest, row);
      return {
        row: settled?.row ?? row,
        stoppedAt: row.status,
        ...(settled ? { settled } : {}),
      };
    } finally {
      if (!opts.keepWorkdir) removeQuietly(paths.plan, opts.out);
    }
  } finally {
    release();
  }
}

/** S1 and S2: the record, then `prepared`. */
async function recordAndPrepare(
  ctx: RunContext,
  rebasedOnto: string | null,
  until: RepullStatus,
): Promise<{ row: RepullRow; stoppedAt: RepullStatus }> {
  const facts = planFacts(ctx.body);
  const baseSha = rebasedOnto ?? facts.mainCommit;
  if (rebasedOnto) {
    ctx.out("NEMAR's main moved by .nemar/** only since the plan; executing on the live main.");
  }

  // S1. The record. Its `delta_paths` count is the plan's (paths written, deletions aside); the
  // `prepared` edge replaces it with what the preparation wrote, deleted and edited.
  const counts = planCounts(ctx.body);
  let created: Awaited<ReturnType<typeof createRepull>>;
  try {
    created = await createRepull({
      dataset_id: ctx.datasetId,
      upstream_ds: facts.ds,
      from_tag: facts.fromTag,
      to_tag: facts.toTag,
      from_version: facts.fromVersion,
      to_version: facts.toVersion,
      plan_digest: ctx.digest,
      planner: facts.planner,
      base_sha: baseSha,
      lineage_recordable: facts.lineageRecordable,
      counts: {
        delta_paths: counts.delta_paths ?? 0,
        unexplained: counts.unexplained ?? 0,
        conflicts: counts.conflicts ?? 0,
        corrections: counts.corrections ?? 0,
        // The automatic create bounds the copy by its stated size (`assertAutomaticPlan` has
        // proved it known); an administrator's record does not need it.
        ...(ctx.automatic && counts.copy_bytes !== undefined
          ? { copy_bytes: counts.copy_bytes }
          : {}),
      },
      // A dispatched run presents its dispatch: the one way a record is the automatic path's.
      ...(ctx.automatic
        ? { dispatch_id: ctx.automatic.dispatchId, dispatch_token: ctx.automatic.token }
        : {}),
    });
  } catch (err) {
    if (err instanceof ApiError) throw recordRefused(err);
    throw err;
  }
  let row = created.repull;
  if (ctx.automatic) assertAutomaticRecord(ctx.automatic, row);
  ctx.out(
    created.created
      ? `Recorded re-pull #${row.id} of ${ctx.datasetId} (${facts.fromTag} -> ${facts.toTag}), planned.`
      : `Found re-pull #${row.id} of ${ctx.datasetId}, ${row.status}.`,
  );
  // A record past `prepared` is the caller's to advance; one that has reached `until` stops here.
  if (until === "planned" || !PREPARING.includes(row.status)) {
    return { row, stoppedAt: row.status };
  }

  // S2. Prepared.
  try {
    privateDir(ctx.paths.root, dirname(dirname(ctx.paths.lock)));
    if (row.status === "planned") {
      row = await prepareFromPlanned(ctx, row, baseSha);
    } else {
      row = await resumePrepared(ctx, row, baseSha);
    }
  } catch (err) {
    throw resumable(err);
  }
  return { row, stoppedAt: row.status };
}

/** The record's writes, as the steps past `prepared` make them. */
function recorder(out: (line: string) => void) {
  return {
    transition: (row: RepullRow, to: RepullStatus, fields: Record<string, unknown>) =>
      transition(row, to, fields),
    async recordError(row: RepullRow, words: string): Promise<void> {
      // A `prepared` self-edge carries the stage's facts; `copied` and `registered` carry none.
      const fields = row.status === "prepared" ? recordedFacts(row) : {};
      try {
        await transitionRepull(row.id, { from: row.status, to: row.status, fields, error: words });
      } catch (recordErr) {
        out(
          `The failure could not be recorded on re-pull #${row.id} (${repullErrorCode(recordErr) ?? (recordErr instanceof ApiError ? `HTTP ${recordErr.statusCode}` : describeError(recordErr))}); its record keeps the last error it had.`,
        );
      }
    },
  };
}

/** `planned -> prepared`, recording why on the row when the preparation fails. */
async function prepareFromPlanned(
  ctx: RunContext,
  row: RepullRow,
  baseSha: string,
): Promise<RepullRow> {
  let prepared: Prepared;
  try {
    prepared = await prepareOnce(ctx, row, baseSha);
  } catch (err) {
    await recordError(ctx, row, "planned", {}, err);
    throw err;
  }
  const next = await transition(row, "prepared", {
    synth_tree: prepared.synthTree,
    synth_sha: prepared.synthSha,
    manifest_digest: prepared.manifestDigest,
    ...(baseSha !== row.base_sha ? { base_sha: baseSha } : {}),
    counts: prepared.counts,
  });
  ctx.out(`Prepared re-pull #${row.id}: commit ${prepared.synthSha.slice(0, 12)}.`);
  return next;
}

/** The facts a `prepared` row holds, as the self-edge sends them again. */
function recordedFacts(row: RepullRow): {
  synth_tree: string;
  synth_sha: string;
  manifest_digest: string;
} {
  return {
    synth_tree: row.synth_tree as string,
    synth_sha: row.synth_sha as string,
    manifest_digest: row.manifest_digest as string,
  };
}

/**
 * A `prepared` row whose facts were shown to hold again: when the error it carries is one an
 * earlier preparation recorded (it begins {@link PREPARE_ERROR_PREFIX}), the self-edge records the
 * stage again with no error, which the Worker takes as clearing it. An error any other step wrote
 * is not this run's to clear, and the row is left as it is.
 */
async function restate(row: RepullRow): Promise<RepullRow> {
  if (row.last_error === null || !row.last_error.startsWith(PREPARE_ERROR_PREFIX)) return row;
  return transition(row, "prepared", recordedFacts(row));
}

/**
 * A row already `prepared`: on the same base, its working clone (or checkpoint) must hold its
 * commit, or a preparation from scratch must give the same tree, commit and manifest; on a base
 * that moved by `.nemar/**` only, it is prepared again there and the self-edge records the new
 * facts.
 */
async function resumePrepared(
  ctx: RunContext,
  row: RepullRow,
  baseSha: string,
): Promise<RepullRow> {
  const recorded = recordedFacts(row);
  if (baseSha !== row.base_sha) {
    let prepared: Prepared;
    try {
      prepared = await prepareOnce(ctx, row, baseSha);
    } catch (err) {
      await recordError(ctx, row, "prepared", recorded, err);
      throw err;
    }
    ctx.out(`Re-pull #${row.id} prepared again onto the live main.`);
    return transition(row, "prepared", {
      synth_tree: prepared.synthTree,
      synth_sha: prepared.synthSha,
      manifest_digest: prepared.manifestDigest,
      base_sha: baseSha,
      counts: prepared.counts,
    });
  }
  const held = await cloneHolds(ctx.paths.repo, recorded.synth_sha, recorded.synth_tree);
  if (held === null) {
    ctx.out(`Re-pull #${row.id} is prepared, and its working clone holds its commit.`);
    if (!existsSync(ctx.paths.bundle))
      await saveCheckpoint(ctx.paths.repo, ctx.paths.bundle, baseSha);
    return restate(row);
  }
  ctx.out(`Re-pull #${row.id}'s working clone is not usable (${held}).`);
  const restored = await restoreCheckpoint({
    dir: ctx.paths.repo,
    bundle: ctx.paths.bundle,
    originUrl: originUrl(ctx.datasetId, ctx.env),
    baseSha,
    token: ctx.token,
    annexCommit: planFacts(ctx.body).annexCommit,
    synthSha: recorded.synth_sha,
    synthTree: recorded.synth_tree,
  });
  if (restored === null) {
    ctx.out(`Re-pull #${row.id} is prepared; its working clone was restored from the checkpoint.`);
    return restate(row);
  }
  ctx.out(`Re-pull #${row.id}'s checkpoint was not used (${restored}); preparing again.`);
  let again: Prepared;
  try {
    again = await prepareOnce(ctx, row, baseSha);
  } catch (err) {
    await recordError(ctx, row, "prepared", recorded, err);
    throw err;
  }
  if (
    again.synthTree !== recorded.synth_tree ||
    again.synthSha !== recorded.synth_sha ||
    again.manifestDigest !== recorded.manifest_digest
  ) {
    const err = new ExecuteRefused(
      "prepare-not-reproducible",
      "Preparing again from the same plan and base gave another tree, commit or copy manifest than the one recorded; this re-pull cannot continue: its record has to be abandoned and the dataset planned again (no command to abandon a record is built yet).",
    );
    await recordError(ctx, row, "prepared", recorded, err);
    throw err;
  }
  ctx.out(
    `Re-pull #${row.id} is prepared; its working clone was prepared again, to the same commit.`,
  );
  return restate(row);
}

/**
 * Null when the working clone's branch is the recorded commit and tree; otherwise why not, in
 * fixed words for the operator.
 */
async function cloneHolds(
  repo: string,
  synthSha: string,
  synthTree: string,
): Promise<"no-working-clone" | "clone-at-another-commit" | null> {
  let head: string;
  let tree: string;
  try {
    head = (await git(repo, ["rev-parse", "--verify", "--quiet", "HEAD"], { ok: true })).stdout;
    tree = (await git(repo, ["rev-parse", "--verify", "--quiet", "HEAD^{tree}"], { ok: true }))
      .stdout;
  } catch {
    return "no-working-clone";
  }
  return head.trim() === synthSha && tree.trim() === synthTree ? null : "clone-at-another-commit";
}

async function transition(
  row: RepullRow,
  to: RepullStatus,
  fields: Record<string, unknown>,
  error?: string,
): Promise<RepullRow> {
  try {
    return await transitionRepull(row.id, {
      from: row.status,
      to,
      fields,
      ...(error ? { error } : {}),
    });
  } catch (err) {
    if (err instanceof ApiError) throw recordRefused(err);
    throw err;
  }
}

/**
 * Record why a step failed on the row, as a self-edge. When the API refuses or cannot be reached
 * the operator is told; the failure itself is still what the caller reports.
 */
async function recordError(
  ctx: RunContext,
  row: RepullRow,
  status: "planned" | "prepared",
  fields: Record<string, unknown>,
  err: unknown,
): Promise<void> {
  try {
    await transitionRepull(row.id, {
      from: status,
      to: status,
      fields,
      error: errorWords(err).slice(0, 2000),
    });
  } catch (recordErr) {
    ctx.out(
      `The failure could not be recorded on re-pull #${row.id} (${repullErrorCode(recordErr) ?? (recordErr instanceof ApiError ? `HTTP ${recordErr.statusCode}` : describeError(recordErr))}); its record keeps the last error it had.`,
    );
  }
}

/**
 * One preparation from scratch: the working clone at `baseSha`, the delta materialized, scrubbed
 * and uploaded where the scrub needs it, the commit synthesized and checked, and the checkpoint.
 */
async function prepareOnce(ctx: RunContext, row: RepullRow, baseSha: string): Promise<Prepared> {
  const { body, datasetId, paths } = ctx;
  const facts = planFacts(body);
  const repo = await workClone({
    dir: paths.repo,
    originUrl: originUrl(datasetId, ctx.env),
    baseSha,
    token: ctx.token,
    annexCommit: facts.annexCommit,
  });

  // NEMAR's bucket and the uuid uploads register against: what remote.log names, as the plan read.
  const remote = nemarRemoteOf(await readRemoteLog(repo), datasetId);
  const bucket = remote.record?.bucket;
  if (!remote.uuid || !bucket) {
    throw new ExecuteRefused("no-nemar-s3", "NEMAR's remote.log names no single nemar-s3 bucket.");
  }
  const prefix = `${datasetId}/objects/`;
  if (copySection(body).destinationPrefix !== prefix || remote.prefix !== prefix) {
    throw new ExecuteRefused(
      "destination-prefix",
      `The plan's destination is not ${prefix}, the only prefix a re-pull uploads to.`,
    );
  }
  const upload = awsCliUpload({
    bucket,
    datasetId,
    region: remote.region,
    remoteUuid: remote.uuid,
    workDir: paths.upload,
  });
  const reader = httpUpstreamReader({ baseUrl: ctx.objectsBase });

  // NEMAR's side as it is at the base, before anything is written.
  const baseKeys = await listAnnexedKeys(repo);
  const base = await readTree(repo, baseSha, baseKeys);
  const oursKeys = new Set(baseKeys.values());

  const scratch = join(paths.root, "scratch");
  removeTree(scratch);
  privateDir(scratch, paths.root);
  const mat = await materializeDelta({
    work: repo,
    body,
    upstreamBare: join(ctx.plannerDir, "upstream.git"),
    upstreamEnv: fleetCloneEnv(upstreamUrl(facts.ds, ctx.env), null),
    computed: ctx.computed,
    reader,
    scratch,
  });
  if (mat.nemarOwned.left.length > 0) {
    ctx.out(
      `NEMAR-owned edit(s) the plan listed and the preparation left as they are: ${mat.nemarOwned.left.length} (${mat.nemarOwned.left.join(", ")}).`,
    );
  }
  // The scope: every path written or deleted, and the provenance files the scrub annotates when a
  // header changes (they may not be delta paths; the scrub refuses rather than leave them out).
  const scope = new Set(mat.deltaPaths);
  const tracked = await git(repo, [
    "ls-files",
    "-z",
    "--",
    PROVENANCE_PATH,
    PROVENANCE_README_PATH,
  ]);
  for (const p of tracked.stdout.split("\0")) if (p) scope.add(p);
  const now = rowTime(row.created_at);
  await commitMaterialized(repo, baseSha, scope, now);
  const preScrub = new Map<string, Entry>();
  for (const [p, e] of await readIndex(repo)) if (scope.has(p)) preScrub.set(p, e);

  const { scrub, uploaded } = await scrubDelta({
    work: repo,
    datasetId,
    scope,
    body,
    oursKeys,
    annexFromGit: mat.annexFromGit,
    reader,
    upload,
    bucket,
    now,
    maxBytes: ctx.normalizeMaxBytes,
    upstreamBare: join(ctx.plannerDir, "upstream.git"),
  });
  removeTree(scratch);

  const held = heldKeys(body, oursKeys);
  const synth = await synthesizeCommit({
    work: repo,
    baseSha,
    createdAt: row.created_at,
    body,
    digest: ctx.digest,
    scrub,
    uploaded,
    held,
    base,
    expected: mat.expected,
    preScrub,
    scope,
    counts: { written: mat.written, deleted: mat.deleted },
  });
  await saveCheckpoint(repo, paths.bundle, baseSha);

  const sizes = (list: Array<{ size: number | null }>) =>
    list.every((i) => i.size !== null)
      ? { known: true, bytes: list.reduce((n, i) => n + (i.size ?? 0), 0) }
      : { known: false, bytes: 0 };
  const copyBytes = sizes(synth.manifest.items);
  const localBytes = sizes(synth.manifest.local);
  const c = scrub.counts;
  return {
    synthSha: synth.synthSha,
    synthTree: synth.synthTree,
    manifestDigest: synth.manifestDigest,
    counts: {
      // At `prepared`: the paths written, deleted and edited (the NEMAR-owned edit included).
      delta_paths: mat.deltaPaths.size,
      written: mat.written,
      deleted: mat.deleted,
      annex_copy_items: synth.manifest.items.length,
      ...(copyBytes.known ? { copy_bytes: copyBytes.bytes } : {}),
      local_uploads: synth.manifest.local.length,
      ...(localBytes.known ? { local_upload_bytes: localBytes.bytes } : {}),
      scrubbed_recordings: c.headers_scrubbed,
      dated_recordings: c.headers_dates_normalized,
      scrubbed_json: c.json_files_blanked,
      headers_not_read_nemar_held: c.headers_not_read_nemar_held,
      headers_not_read_no_source: c.headers_not_read_no_source,
      // What the scrub could not read or prove: unknown is never recorded as nothing.
      json_files_unread: c.json_files_unread,
      json_files_annexed: c.json_files_annexed,
      scans_tables_unread: c.scans_tables_unread,
      headers_dates_unproven: c.headers_dates_unproven,
      headers_dates_left: c.headers_dates_left,
      nemar_owned_edits: mat.nemarOwned.applied,
      nemar_owned_edits_left: mat.nemarOwned.left.length,
    },
  };
}
