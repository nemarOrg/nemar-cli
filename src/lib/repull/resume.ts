/**
 * `nemar admin repull resume <id>`: take an open re-pull up where it stopped, past its open pull
 * request (ADR 0111, decisions 1, 2, 3, 6 and 7; epic #1046 phase 6). It runs on the
 * administrator's machine with their own GitHub token, reads GitHub and NEMAR's origin itself, and
 * records each step through the Worker, which reads again what it can. It never merges: a merge
 * mints a version DOI that cannot be withdrawn, and is `nemar admin repull merge`'s (or
 * `nemar admin pr-reviews`'), through the one gate in `merge.ts`.
 *
 * From the recorded status, each step checks its own end state before it acts. N.0.0's pull
 * request (`n0`) and N.0.1's (`n1`) take the same steps, each on its own columns:
 *
 *   pr_open            the pull request read on GitHub: merged is recorded through the Worker's
 *   patch_synthesized  verified route (a merge outside the tools, never written by hand); closed
 *                      unmerged ends the record (`abandoned` for N.0.0, `patch_declined` for
 *                      N.0.1); a head moved by enrichment (the three shapes `run-enrichment.yml`
 *                      writes, `head.ts`) is recorded, and any other head is `head-foreign`. `main`
 *                      must be the base (N.0.0's, or N.0.1's) or an enrichment-shaped descendant
 *                      (`main-moved` otherwise); when it moved and GitHub reports the pull request
 *                      `dirty` or `behind`, or enrichment changed a path outside `.nemar/` and
 *                      `.github/`, the commit is made again on the new `main` and pushed with a
 *                      lease (`resynthesize.ts`, `patch.ts`). The identifier screen of the
 *                      head is dispatched when none exists or it produced no verdict, and
 *                      acknowledged when the administrator gives a reason for a verdict that asks
 *                      for one. When the screen passes and GitHub reports `clean`, the gates are
 *                      recorded (the Worker reads the live head and the screen again); then it
 *                      stops: "Ready to merge". On a record an administrator opened, `unstable`
 *                      because BIDS validation failed and nothing else does (`bids-only.ts`) is
 *                      recorded too, and that pull request merges with `--bids-failure-reason`.
 *   gates_clear        a held claim to merge is resolved from GitHub: merged is recorded; a claim
 *   patch_gates_clear  whose merge GitHub says did not happen expires once it is old enough (the
 *                      Worker's own bound); a head that moved, or a `main` enrichment moved
 *                      outside `.nemar/` and `.github/` (which the merge gate refuses), goes back
 *                      to the open status. Otherwise it is ready, and the ready line names
 *                      `--bids-failure-reason` while GitHub reports the pull request `unstable`
 *                      for BIDS validation alone.
 *   merged             the merge commit's trailers read back, the tag and the version row waited
 *   patch_merged       for, the tagged tree compared (N.0.0's for lineage; N.0.1's must be its
 *                      gated head, or `--accept-tag-tree` given), the release recorded through the
 *                      Worker's verified route (`release.ts`);
 *   released           the objects N.0.0's copy and uploads wrote (the staging manifest's, never
 *                      the whole prefix) locked and the count recorded; then N.0.1 is made from the
 *                      reviewed plan (`patch-turn.ts`), or the record completes when the plan had no
 *                      correction and no conflict an administrator resolved;
 *   patch_released     `complete`: N.0.1 copied nothing, so there is nothing of its own to lock.
 *
 * It waits, up to `waitMinutes`, for the screen and for GitHub's state, reading again on each
 * turn; still waiting at the bound is the command's exit 3, with what it waits for. A step that
 * fails records why on the row (`[gates:<code>]`, `[release:<code>]`, `[lock:<code>]`,
 * `[patch:<code>]`, never `[prepare:`, which only a preparation clears) and refuses. A
 * re-synthesis an earlier run pushed and could not record is recognized, byte for byte, and
 * recorded.
 */

import { dirname, join } from "node:path";
import { NEMAR_DATASETS_ORG, isOwnDatasetRepo } from "../../../shared/nemar-app.js";
import {
  PULL_REQUEST_COLUMNS,
  type RepullPullRequest,
  type RepullRow,
  type RepullStatus,
} from "../../../shared/repull-state.js";
import type { ApiError } from "../api/errors.js";
import {
  type RepullScreen,
  acknowledgeRepullScreen,
  dispatchRepullScreen,
  getRepull,
  listRepullScreens,
  listRepulls,
  recordRepullMerged,
  releaseRepullMergeClaim,
  repullErrorCode,
  transitionRepull,
} from "../api/repull.js";
import { getConfigDir } from "../config.js";
import {
  type PullRequestFacts,
  adminGitHubToken,
  fetchPullRequest,
  githubApiBase,
  settleMergeState,
} from "../pr-review-approve.js";
import { readBidsOnly } from "./bids-only.js";
import { readCatalogFacts } from "./execute/catalog.js";
import { MOVED_REF_FETCH_DEPTH, changedOutsideNemar } from "./execute/head.js";
import { type OriginScratch, fetchInto, openOriginScratch } from "./execute/origin.js";
import { acceptsHead, checkMain, releaseRefOf } from "./execute/pull-request.js";
import { guardedPush, pushCauseWords } from "./execute/push.js";
import { recognizeResynthesis, resynthesize } from "./execute/resynthesize.js";
import { ExecuteRefused, assertNotAnonymous } from "./execute/verify-plan.js";
import { acquireLock, privateDir, withIsolatedGit, workPaths } from "./execute/workdir.js";
import { patchTurn } from "./patch-turn.js";
import { findPatchCommit, patchResynthesizedCommit, recognizePatchResynthesis } from "./patch.js";
import { lockTurn, releaseTurn } from "./release.js";
import {
  type ResumeContext,
  type ResumeOptions,
  type ResumeResult,
  type Turn,
  apiRefused,
  openFacts,
  recordStepError,
  refused,
  resumeErrorWords,
} from "./steps.js";

/** The dataset's one open record, or null. */
async function openRecord(datasetId: string): Promise<RepullRow | null> {
  try {
    return (await listRepulls({ dataset: datasetId, open: true, limit: 1 })).repulls[0] ?? null;
  } catch (err) {
    throw apiRefused(err, "The NEMAR API could not list the re-pulls");
  }
}

export type { ResumeOptions, ResumeOutcome, ResumeResult } from "./steps.js";

/** Resume the dataset's open re-pull. See the module comment. */
export async function resumeRepull(opts: ResumeOptions): Promise<ResumeResult> {
  return withIsolatedGit(() => resume(opts));
}

async function resume(opts: ResumeOptions): Promise<ResumeResult> {
  const env = opts.env ?? process.env;
  const base = githubApiBase(env);
  const token = await adminGitHubToken(env);
  if (!token.ok) {
    throw new ExecuteRefused(
      "no-github-token",
      `No GitHub token (${token.reason}): resume reads the pull request with the administrator's own (GH_TOKEN, or gh auth login).`,
    );
  }
  // Every run, before anything is written: an anonymous dataset is never re-pulled.
  assertNotAnonymous(await readCatalogFacts(opts.datasetId));
  const open = await openRecord(opts.datasetId);
  if (!open) {
    const latest = (await listRepulls({ dataset: opts.datasetId, limit: 1 })).repulls[0] ?? null;
    // A finish whose re-pull already completed (an earlier attempt that could not report) is
    // complete, and says so; any other record is not the finish's to take up.
    const finish = opts.automaticFinish;
    if (finish && !(latest?.id === finish.repullId && latest.status === "complete")) {
      throw new ExecuteRefused(
        "finish-not-merged",
        `Re-pull #${finish.repullId} is not open: a finish takes up only a merged re-pull.`,
      );
    }
    return { row: latest, outcome: finish ? "complete" : "nothing" };
  }
  if (opts.automaticFinish) assertFinishable(open, opts.automaticFinish.repullId);
  const configDir = getConfigDir();
  const paths = workPaths(configDir, opts.datasetId, open.plan_digest);
  privateDir(dirname(paths.lock), join(configDir, "repull"));
  // One run on a plan at a time: an execute and a resume of one record must not both push.
  const release = acquireLock(paths.lock);
  let scratch: OriginScratch | null = null;
  const ctx: ResumeContext = {
    datasetId: opts.datasetId,
    token: token.token,
    base,
    env,
    configDir,
    opts,
    origin: async () => {
      scratch ??= await openOriginScratch({
        configDir,
        datasetId: opts.datasetId,
        digest: open.plan_digest,
        purpose: "resume",
        env,
        token: token.token,
      });
      return scratch;
    },
    replaced: new Set(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
  if (((opts.takeOurs?.length ?? 0) > 0 || opts.keepUpstream) && open.status.startsWith("patch_")) {
    opts.out(
      `Re-pull #${open.id} is ${open.status}: N.0.1 is already made, so --take-ours and --keep-upstream change nothing now.`,
    );
  }
  try {
    return await walk(ctx, open);
  } finally {
    (scratch as OriginScratch | null)?.close();
    release();
  }
}

/**
 * A dispatched finish takes up the automatic re-pull its dispatch names and nothing else, and only
 * past its merge: from `merged` or `released` the walk only releases, locks and completes.
 */
function assertFinishable(open: RepullRow, repullId: number): void {
  if (open.id !== repullId || open.origin !== "automatic") {
    throw new ExecuteRefused(
      "repull-mismatch",
      `The dataset's open re-pull is #${open.id} (origin ${open.origin}); the finish takes up only #${repullId}, an automatic re-pull.`,
    );
  }
  if (open.status !== "merged" && open.status !== "released") {
    throw new ExecuteRefused(
      "finish-not-merged",
      `Re-pull #${open.id} is ${open.status}: a finish takes up only a merged re-pull.`,
    );
  }
}

/** Walk from the recorded status, waiting up to the bound. */
async function walk(ctx: ResumeContext, start: RepullRow): Promise<ResumeResult> {
  const deadline = Date.now() + Math.max(0, ctx.opts.waitMinutes) * 60_000;
  const poll = Math.max(100, ctx.opts.pollMs ?? 15_000);
  let row = start;
  for (let nexts = 0; ; ) {
    // A bound on turns in a row that do not wait, so a defect that keeps answering "next" cannot
    // spin against GitHub and the Worker.
    if (nexts > 20) {
      throw refused("resume-looped", `Re-pull #${row.id} did not settle; run resume again.`);
    }
    const turn = await stepOnce(ctx, row);
    if (turn.kind === "done") return turn.result;
    if (turn.kind === "next") {
      row = turn.row;
      nexts++;
      continue;
    }
    nexts = 0;
    if (Date.now() + poll > deadline) {
      return { row: turn.row, outcome: "waiting", waitingFor: turn.waitingFor };
    }
    ctx.opts.out(`Waiting for ${turn.waitingFor}.`);
    await ctx.sleep(poll);
    try {
      row = await getRepull(turn.row.id);
    } catch (err) {
      throw apiRefused(err, "The NEMAR API could not read the re-pull");
    }
  }
}

/** One step from `row`'s status. */
export async function stepOnce(ctx: ResumeContext, row: RepullRow): Promise<Turn> {
  switch (row.status) {
    case "planned":
    case "prepared":
    case "copied":
    case "registered":
      throw new ExecuteRefused(
        "use-execute",
        `Re-pull #${row.id} is ${row.status}: it is taken up by nemar admin repull execute <plan-file>, with the plan it was made from.`,
      );
    case "pr_open":
      return gatesTurn(ctx, row, "n0");
    case "patch_synthesized":
      return gatesTurn(ctx, row, "n1");
    case "gates_clear":
      return claimTurn(ctx, row, "n0");
    case "patch_gates_clear":
      return claimTurn(ctx, row, "n1");
    case "merged":
      return releaseTurn(ctx, row, "n0");
    case "patch_merged":
      return releaseTurn(ctx, row, "n1");
    case "released": {
      const locked = await lockTurn(ctx, row);
      return locked.kind === "next" ? patchTurn(ctx, locked.row) : locked;
    }
    case "patch_released":
      return completeTurn(ctx, row);
    default:
      throw new ExecuteRefused(
        "not-built",
        `Re-pull #${row.id} is ${row.status}, which resume does not take on.`,
      );
  }
}

/** The facts of one of the record's pull requests, by its columns. */
interface Pull {
  pr: RepullPullRequest;
  number: number;
  branch: string;
  head: string;
  gates: string | null;
  claimSha: string | null;
  claimedAt: string | null;
  version: string;
  /** The commit `main` must be, or descend from by enrichment, for the pull request to merge. */
  base: string;
  /** What a new head must be, or descend from by enrichment: the re-pull's commit, or N.0.1's head. */
  anchor: string;
  /** The status the record ends with when the pull request is found closed unmerged. */
  closedTo: RepullStatus;
}

/** One pull request's facts, as the record holds them. */
export function pullOf(row: RepullRow, pr: RepullPullRequest): Pull {
  const c = PULL_REQUEST_COLUMNS[pr];
  return {
    pr,
    number: row[c.number] as number,
    branch: row[c.branch] as string,
    head: row[c.head] as string,
    gates: row[c.gates],
    claimSha: row[c.claimSha],
    claimedAt: row[c.claimedAt],
    version: row[c.version] as string,
    base: (pr === "n0" ? row.base_sha : row.patch_base_sha) as string,
    anchor: (pr === "n0" ? row.synth_sha : row.patch_head_sha) as string,
    closedTo: pr === "n0" ? "abandoned" : "patch_declined",
  };
}

/** The pull request, read with the administrator's token; unreadable is a resumable refusal. */
async function readPull(ctx: ResumeContext, p: Pull): Promise<PullRequestFacts> {
  const live = await fetchPullRequest(ctx.token, ctx.datasetId, p.number, ctx.base);
  if (!live.ok) {
    throw refused(
      "github-unreadable",
      `Pull request #${p.number} could not be read on GitHub (${live.reason})`,
    );
  }
  return live.value;
}

/** Record GitHub's merge through the Worker's verified route. */
async function recordMerge(ctx: ResumeContext, row: RepullRow, p: Pull): Promise<Turn> {
  let res: Awaited<ReturnType<typeof recordRepullMerged>>;
  try {
    res = await recordRepullMerged(row.id, p.pr);
  } catch (err) {
    throw apiRefused(err, `The merge of pull request #${p.number} could not be recorded`);
  }
  const notes = [
    res.merged_outside_tool ? "no NEMAR tool held a claim for it" : null,
    res.merged_unscreened_head ? "at a head other than the screened one" : null,
  ].filter(Boolean);
  ctx.opts.out(
    `Pull request #${p.number} is merged; re-pull #${row.id} records it${notes.length > 0 ? ` (${notes.join(", ")})` : ""}.`,
  );
  return { kind: "next", row: res.repull };
}

/** Move the record along one edge, its refusal kept as the step's. */
async function move(
  row: RepullRow,
  to: RepullRow["status"],
  fields: Record<string, unknown>,
  what: string,
): Promise<RepullRow> {
  try {
    return await transitionRepull(row.id, { from: row.status, to, fields });
  } catch (err) {
    throw apiRefused(err, what);
  }
}

/** The open status's self-edge with a new head (and, after a re-synthesis, a new base). */
function openFields(
  row: RepullRow,
  p: Pull,
  head: string,
  moved?: { synthSha: string; synthTree: string; baseSha: string },
): Record<string, unknown> {
  const fields = { ...openFacts(row) };
  if (p.pr === "n0") {
    fields.head_sha = head;
    if (moved) {
      fields.synth_sha = moved.synthSha;
      fields.synth_tree = moved.synthTree;
      fields.base_sha = moved.baseSha;
    }
  } else {
    fields.patch_head_sha = head;
    if (moved) fields.patch_base_sha = moved.baseSha;
  }
  return fields;
}

/**
 * A closed, unmerged pull request ends the record (ADR 0111: a declined re-pull is abandoned):
 * `abandoned` for N.0.0's, and
 * `patch_declined` for N.0.1's (N.0.0 stays released).
 */
async function closedUnmerged(ctx: ResumeContext, row: RepullRow, p: Pull): Promise<Turn> {
  const ended = await move(row, p.closedTo, {}, "The record could not be ended");
  ctx.opts.out(
    p.pr === "n0"
      ? `Pull request #${p.number} was closed without being merged: re-pull #${row.id} is abandoned. Plan the dataset again to re-pull it.`
      : `N.0.1's pull request #${p.number} was closed without being merged: re-pull #${row.id} is patch_declined, and v${row.to_version} stays released; its corrections remain corrections in the next plan.`,
  );
  return { kind: "done", result: { row: ended, outcome: "ended" } };
}

/** Whether `head` descends from `p.anchor` by enrichment only, read in the scratch repository. */
async function headVerdict(scratch: OriginScratch, p: Pull, head: string) {
  return acceptsHead({
    work: scratch.dir,
    from: p.anchor,
    head,
    ref: releaseRefOf(p.version),
    env: scratch.env,
  });
}

/**
 * A head that is not the anchor's descendant may be a re-synthesis an earlier run pushed and could
 * not record (a fresh scratch repository may not even hold the anchor, so the verdict can read
 * unreadable); it is recognized, byte for byte, and returned for the record.
 */
async function recognized(
  scratch: OriginScratch,
  row: RepullRow,
  p: Pull,
  head: string,
): Promise<{ synthSha: string; synthTree: string; baseSha: string } | null> {
  if (p.pr === "n0") return recognizeResynthesis({ scratch, row, head });
  const recorded = await recordedPatchCommit(scratch, row, p);
  if (!recorded) return null;
  const found = await recognizePatchResynthesis({ dir: scratch.dir, row, recorded, head });
  return found ? { synthSha: found.sha, synthTree: found.tree, baseSha: found.baseSha } : null;
}

/** N.0.1's own commit beneath its recorded head (the head may carry enrichment commits on it). */
async function recordedPatchCommit(
  scratch: OriginScratch,
  row: RepullRow,
  p: Pull,
): Promise<string | null> {
  if (!(await fetchInto(scratch, p.anchor, MOVED_REF_FETCH_DEPTH))) return null;
  await fetchInto(scratch, row.merge_sha as string, MOVED_REF_FETCH_DEPTH);
  return (await findPatchCommit({ dir: scratch.dir, row, head: p.anchor }))?.commit ?? null;
}

/** At `pr_open` or `patch_synthesized`: the head, `main`, the screen and GitHub's state, then the gates. */
async function gatesTurn(ctx: ResumeContext, row: RepullRow, pr: RepullPullRequest): Promise<Turn> {
  const p = pullOf(row, pr);
  const live = await readPull(ctx, p);
  if (live.state === "merged") return recordMerge(ctx, row, p);
  if (live.state === "closed") return closedUnmerged(ctx, row, p);
  if (live.baseRef !== "main" || live.headRef !== p.branch) {
    const err = refused("pr-foreign", `Pull request #${p.number} is not ${p.branch} into main.`);
    await recordStepError(row, resumeErrorWords("gates", err), ctx.opts.out);
    throw err;
  }
  // From and into the dataset's own repository, at the first read: a fork's branch of the recorded
  // name is not the re-pull's, and the Worker's gates would refuse it on every turn without
  // saying a fork is why.
  if (
    !isOwnDatasetRepo(live.headRepo, row.dataset_id) ||
    !isOwnDatasetRepo(live.baseRepo, row.dataset_id)
  ) {
    const err = refused(
      "pr-foreign",
      `Pull request #${p.number} is not from and into ${NEMAR_DATASETS_ORG}/${row.dataset_id} itself (its head is ${live.headRepo ?? "a repository GitHub no longer names"}, its base ${live.baseRepo ?? "a repository GitHub no longer names"}): a fork's pull request is never merged as a re-pull's.`,
    );
    await recordStepError(row, resumeErrorWords("gates", err), ctx.opts.out);
    throw err;
  }

  // The head: the recorded one, or an enrichment-shaped descendant of the re-pull's commit.
  if (live.headSha !== p.head) {
    if (ctx.replaced.has(live.headSha)) {
      return { kind: "wait", row, waitingFor: "GitHub to show the re-synthesized head" };
    }
    const scratch = await ctx.origin();
    const verdict = await headVerdict(scratch, p, live.headSha);
    if (verdict !== "ok") {
      const ours = await recognized(scratch, row, p, live.headSha);
      if (ours) {
        const recorded = await move(
          row,
          row.status,
          openFields(row, p, live.headSha, ours),
          "The re-synthesized commit could not be recorded",
        );
        ctx.opts.out(
          `${p.branch} holds this re-pull's commit made again on a moved main (${ours.synthSha.slice(0, 12)}), pushed by an earlier run; re-pull #${row.id} records it.`,
        );
        return { kind: "next", row: recorded };
      }
      const err =
        verdict === "unreadable"
          ? refused(
              "branch-unreadable",
              `Whether the head of ${p.branch} is this re-pull's commit and enrichment's could not be read.`,
            )
          : refused(
              "head-foreign",
              `${p.branch} holds a commit enrichment does not make: this pull request cannot be merged as it is; end the record with nemar admin repull abandon ${ctx.datasetId}.`,
            );
      await recordStepError(row, resumeErrorWords("gates", err), ctx.opts.out);
      throw err;
    }
    const moved = await move(
      row,
      row.status,
      openFields(row, p, live.headSha),
      "The moved head could not be recorded",
    );
    ctx.opts.out(
      `${p.branch} moved by enrichment to ${live.headSha.slice(0, 12)}; re-pull #${row.id} records it.`,
    );
    return { kind: "next", row: moved };
  }

  // `main`: the base, or an enrichment-shaped descendant of it.
  const scratch = await ctx.origin();
  let main: string;
  try {
    main = await checkMain({ work: scratch.dir, baseSha: p.base, env: scratch.env });
  } catch (err) {
    if (err instanceof ExecuteRefused) {
      err.resumable = true;
      await recordStepError(row, resumeErrorWords("gates", err), ctx.opts.out);
    }
    throw err;
  }
  const settled = await settleMergeState(
    ctx.token,
    ctx.datasetId,
    p.number,
    { headSha: live.headSha, mergeableState: live.mergeableState },
    { base: ctx.base, sleep: ctx.sleep },
  );
  if (!settled.ok) {
    if (settled.kind === "unreadable") {
      throw refused(
        "github-unreadable",
        `GitHub could not say whether #${p.number} can be merged.`,
      );
    }
    // Moved or closed in between: wait a turn, then read it again from the top.
    return { kind: "wait", row, waitingFor: `pull request #${p.number} to settle on GitHub` };
  }
  const state = settled.state;
  // Enrichment on a path outside NEMAR's own makes the commit again even when GitHub can merge it
  // as it is: the merge gate refuses such a main (merge-main-moved), because the squash would tag a
  // tree the screen did not read.
  const outside = main === p.base ? [] : await changedOutsideNemar(scratch.dir, p.base, main);
  if (outside === null) {
    throw refused(
      "main-unreadable",
      "Whether NEMAR's main moved outside .nemar/ and .github/ could not be read; run resume again.",
    );
  }
  if (main !== p.base && (state === "dirty" || state === "behind" || outside.length > 0)) {
    return resynthesizeTurn(
      ctx,
      row,
      p,
      main,
      live.headSha,
      outside.length > 0
        ? `enrichment changed ${outside.length} path(s) outside .nemar/ and .github/ on it`
        : `GitHub reports its pull request '${state}'`,
    );
  }

  const screen = await screenTurn(ctx, row, p);
  const waits: string[] = [];
  if (screen !== null) waits.push(screen);
  // GitHub's state: `clean`, or, on a record an administrator opened, `unstable` because BIDS
  // validation failed and nothing else does, which is what `nemar admin repull merge
  // --bids-failure-reason` merges over (ADR 0111, the #1983 review amendment), read by the rule the
  // merge gate and the Worker's claim read. No `clean` comes while the validation fails, so without
  // this the override could not be reached. Every other state waits, an automatic record's included.
  const overBids =
    state === "unstable" && row.origin === "administrator"
      ? await readBidsOnly({
          token: ctx.token,
          base: ctx.base,
          datasetId: ctx.datasetId,
          sha: p.head,
          origin: row.origin,
          mergeableState: state,
          prNumber: p.number,
        })
      : null;
  if (state !== "clean" && overBids?.kind !== "bids-only") {
    waits.push(
      `GitHub to report pull request #${p.number} clean (it reports '${state}'${overBids ? `: ${overBids.why}` : ""})`,
    );
  }
  if (waits.length > 0) return { kind: "wait", row, waitingFor: waits.join(", and ") };

  const c = PULL_REQUEST_COLUMNS[pr];
  let gated: RepullRow;
  try {
    gated = await transitionRepull(row.id, {
      from: c.open,
      to: c.gatesClear,
      fields: { [c.gates]: p.head },
    });
  } catch (err) {
    const code = repullErrorCode(err);
    // The Worker read the live head or the screen itself and they changed: read them again.
    if (code === "head-moved" || code === "screen-changed") return { kind: "next", row };
    if (code === "screen-not-clear") {
      return { kind: "wait", row, waitingFor: "the identifier screen to pass for this head" };
    }
    throw apiRefused(err, "The gates could not be recorded");
  }
  if (state === "clean") {
    ctx.opts.out(
      `The identifier screen and GitHub pass for ${p.head.slice(0, 12)}: re-pull #${row.id} is ${c.gatesClear}.`,
    );
    return { kind: "done", result: { row: gated, outcome: "ready" } };
  }
  ctx.opts.out(
    `The identifier screen passes for ${p.head.slice(0, 12)}, and GitHub reports its pull request unstable only because BIDS validation failed: re-pull #${row.id} is ${c.gatesClear}. It merges over the failed validation with a reason, once you have read it, or without one once the validation passes.`,
  );
  return { kind: "done", result: { row: gated, outcome: "ready", bidsFailure: true } };
}

/**
 * The screen of the recorded head: null when it passes, else what it waits for. Dispatched when
 * there is none or it produced no verdict (the Worker decides which); acknowledged when it asks for
 * a person and the administrator gave a reason. A direct identifier refuses.
 */
async function screenTurn(ctx: ResumeContext, row: RepullRow, p: Pull): Promise<string | null> {
  const head = p.head;
  let listed: Awaited<ReturnType<typeof listRepullScreens>>;
  try {
    listed = await listRepullScreens(row.id);
  } catch (err) {
    throw apiRefused(err, "The identifier screens could not be read");
  }
  if (listed.exempt) return null;
  let screen: RepullScreen | null =
    listed.screens.find((s) => s.pr === p.pr && s.sha === head) ?? null;
  if (screen === null || screen.gate === "rerun") {
    try {
      const sent = await dispatchRepullScreen(row.id, { pr: p.pr, sha: head });
      if (sent.exempt) return null;
      ctx.opts.out(`Dispatched the identifier screen of ${head.slice(0, 12)}.`);
      screen = sent.screen;
    } catch (err) {
      if (repullErrorCode(err) !== "screen-exists") {
        throw apiRefused(err, "The identifier screen could not be dispatched");
      }
      screen = ((err as ApiError).rawBody as { screen?: RepullScreen } | null)?.screen ?? null;
    }
    if (screen === null || screen.gate === "rerun" || screen.gate === "wait") {
      return `the identifier screen of ${head.slice(0, 12)}`;
    }
  }
  switch (screen.gate) {
    case "clear":
      return null;
    case "wait":
      return `the identifier screen of ${head.slice(0, 12)} (running)`;
    case "blocks": {
      const err = refused(
        "screen-blocks",
        `${screen.headline}. A direct identifier cannot be acknowledged: this commit is not merged.`,
      );
      await recordStepError(row, resumeErrorWords("gates", err), ctx.opts.out);
      throw err;
    }
    case "acknowledge": {
      if (screen.acknowledged_at !== null) return null;
      if (!ctx.opts.acknowledgment) {
        return `an administrator's reason for the identifier screen (${screen.headline}); read it with nemar admin repull status ${ctx.datasetId}, then run nemar admin repull resume ${ctx.datasetId} --acknowledge-identifier-screen "<reason>"`;
      }
      try {
        await acknowledgeRepullScreen(row.id, {
          pr: p.pr,
          sha: head,
          reason: ctx.opts.acknowledgment,
        });
      } catch (err) {
        throw apiRefused(err, "The acknowledgment could not be recorded");
      }
      ctx.opts.out(
        `Recorded your acknowledgment of the identifier screen of ${head.slice(0, 12)}.`,
      );
      return null;
    }
    default:
      return `the identifier screen of ${head.slice(0, 12)}`;
  }
}

/** N.0.1's commit made again on `main` and pushed with a lease on the live head. */
async function resynthesizePatch(
  scratch: OriginScratch,
  row: RepullRow,
  p: Pull,
  main: string,
  liveHead: string,
): Promise<{ synthSha: string; synthTree: string }> {
  const recorded = await recordedPatchCommit(scratch, row, p);
  if (!recorded) {
    throw new ExecuteRefused(
      "origin-unreadable",
      "N.0.1's commit could not be found beneath its recorded head on NEMAR's repository.",
    );
  }
  const made = await patchResynthesizedCommit({
    dir: scratch.dir,
    commit: recorded,
    newMain: main,
  });
  const ref = releaseRefOf(p.version);
  const pushed = await guardedPush(
    scratch.dir,
    [`${made.sha}:${ref}`],
    { versions: [p.version] },
    scratch.env,
    [`--force-with-lease=${ref}:${liveHead}`],
  );
  if (pushed.outcome === "rejected") {
    throw new ExecuteRefused(
      "branch-moved",
      `release/v${p.version} moved while it was re-synthesized; nothing was replaced. Run resume again.`,
    );
  }
  if (pushed.outcome === "remote-rejected" || pushed.outcome === "failed") {
    throw new ExecuteRefused(
      "push-failed",
      `The re-synthesized release/v${p.version} could not be pushed (${pushCauseWords(pushed.cause)}).`,
    );
  }
  return { synthSha: made.sha, synthTree: made.tree };
}

/** `main` moved by enrichment and the pull request cannot merge as it is: make the commit again. */
async function resynthesizeTurn(
  ctx: ResumeContext,
  row: RepullRow,
  p: Pull,
  main: string,
  liveHead: string,
  why: string,
): Promise<Turn> {
  if (
    ctx.opts.confirm &&
    !(await ctx.opts.confirm(
      `NEMAR's main moved by enrichment since re-pull #${row.id}'s ${p.pr === "n0" ? "commit" : "N.0.1 commit"} was made, and ${why}. Make the commit again on the new main and push ${p.branch} with a lease (nothing enrichment wrote is undone)?`,
    ))
  ) {
    throw new ExecuteRefused("declined", "Not confirmed; nothing was pushed.");
  }
  const scratch = await ctx.origin();
  let made: { synthSha: string; synthTree: string };
  try {
    made =
      p.pr === "n0"
        ? await resynthesize({ scratch, row, newMain: main, liveHead })
        : await resynthesizePatch(scratch, row, p, main, liveHead);
  } catch (err) {
    if (err instanceof ExecuteRefused) {
      err.resumable = true;
      await recordStepError(row, resumeErrorWords("gates", err), ctx.opts.out);
    }
    throw err;
  }
  ctx.replaced.add(liveHead);
  const next = await move(
    row,
    row.status,
    openFields(row, p, made.synthSha, { ...made, baseSha: main }),
    "The re-synthesized commit could not be recorded",
  );
  ctx.opts.out(
    `Made re-pull #${row.id}'s commit again on the new main (${made.synthSha.slice(0, 12)}) and pushed ${p.branch}; its identifier screen runs again for the new head.`,
  );
  return { kind: "next", row: next };
}

/**
 * At `gates_clear` or `patch_gates_clear`. A held claim is resolved from GitHub first: merged is
 * recorded; a merge that did not happen expires the claim once the Worker says it is old enough.
 * Then the pull request as it is: merged, closed, a moved head, or ready.
 */
async function claimTurn(ctx: ResumeContext, row: RepullRow, pr: RepullPullRequest): Promise<Turn> {
  const p = pullOf(row, pr);
  const live = await readPull(ctx, p);
  if (live.state === "merged") return recordMerge(ctx, row, p);
  if (p.claimSha !== null) {
    try {
      const freed = await releaseRepullMergeClaim(row.id, {
        pr,
        sha: p.claimSha,
        outcome: "expired",
      });
      ctx.opts.out(
        `The claim to merge made at ${p.claimedAt} expired: GitHub says pull request #${p.number} did not merge, and its unit of today's merge cap is free.`,
      );
      return { kind: "next", row: freed };
    } catch (err) {
      const code = repullErrorCode(err);
      if (code === "pull-request-merged") return { kind: "next", row };
      if (code === "claim-too-recent") {
        return {
          kind: "done",
          result: {
            row,
            outcome: "waiting",
            waitingFor: `the claim to merge made at ${p.claimedAt} to be resolved: run nemar admin repull merge ${ctx.datasetId} to send the merge again under it, or resume later to expire it`,
          },
        };
      }
      throw apiRefused(err, "The claim to merge could not be resolved");
    }
  }
  if (live.state === "closed") return closedUnmerged(ctx, row, p);
  if (live.headSha !== p.gates) {
    const scratch = await ctx.origin();
    const verdict = await headVerdict(scratch, p, live.headSha);
    if (verdict !== "ok") {
      // Not recorded: a foreign head is never written as the row's, and a gates-clear status
      // records no error; the merge gate refuses a head that is not the screened one.
      throw refused(
        verdict === "unreadable" ? "branch-unreadable" : "head-foreign",
        `${p.branch} moved since its gates were recorded, ${verdict === "unreadable" ? "and whether by enrichment only could not be read" : "by a commit enrichment does not make"}.`,
      );
    }
    const back = await move(
      row,
      PULL_REQUEST_COLUMNS[pr].open,
      openFields({ ...row, status: PULL_REQUEST_COLUMNS[pr].open }, p, live.headSha),
      "The moved head could not be recorded",
    );
    ctx.opts.out(
      `${p.branch} moved by enrichment since its gates were recorded; re-pull #${row.id} is ${PULL_REQUEST_COLUMNS[pr].open} again, and its screen runs for the new head.`,
    );
    return { kind: "next", row: back };
  }
  // `main` moved by enrichment outside NEMAR's own paths since the gates: the merge gate refuses it
  // (merge-main-moved), so the record goes back to its open status, where the commit is made again
  // on the new main and screened and gated again.
  const scratch = await ctx.origin();
  let main: string;
  try {
    main = await checkMain({ work: scratch.dir, baseSha: p.base, env: scratch.env });
  } catch (err) {
    if (err instanceof ExecuteRefused) err.resumable = true;
    throw err;
  }
  const outside = main === p.base ? [] : await changedOutsideNemar(scratch.dir, p.base, main);
  if (outside === null) {
    throw refused(
      "main-unreadable",
      "Whether NEMAR's main moved outside .nemar/ and .github/ since the gates could not be read; run resume again.",
    );
  }
  if (outside.length > 0) {
    const open = PULL_REQUEST_COLUMNS[pr].open;
    const back = await move(
      row,
      open,
      openFields({ ...row, status: open }, p, live.headSha),
      "The return to the open pull request could not be recorded",
    );
    ctx.opts.out(
      `NEMAR's main moved by enrichment since the gates, on ${outside.length} path(s) outside .nemar/ and .github/: re-pull #${row.id} is ${open} again, and its commit is made again on the new main.`,
    );
    return { kind: "next", row: back };
  }
  const bidsFailure = await readyOverBids(ctx, row, p, live);
  return {
    kind: "done",
    result: { row, outcome: "ready", ...(bidsFailure ? { bidsFailure: true as const } : {}) },
  };
}

/**
 * Whether a pull request at its gates merges now only over a failed BIDS validation: GitHub
 * reports it `unstable` and BIDS validation is the one check that fails at its head, on a record an
 * administrator opened (`bids-only.ts`, the rule its gates were recorded by). The ready line then
 * names `--bids-failure-reason`, which the merge gate needs while GitHub says `unstable`. Any
 * other state, a read that fails included, leaves the ordinary ready line, and the gate says why
 * it refuses when it does.
 */
async function readyOverBids(
  ctx: ResumeContext,
  row: RepullRow,
  p: Pull,
  live: PullRequestFacts,
): Promise<boolean> {
  if (row.origin !== "administrator") return false;
  const settled = await settleMergeState(
    ctx.token,
    ctx.datasetId,
    p.number,
    { headSha: live.headSha, mergeableState: live.mergeableState },
    { base: ctx.base, sleep: ctx.sleep },
  );
  if (!settled.ok || settled.state !== "unstable") return false;
  const only = await readBidsOnly({
    token: ctx.token,
    base: ctx.base,
    datasetId: ctx.datasetId,
    sha: live.headSha,
    origin: row.origin,
    mergeableState: settled.state,
    prNumber: p.number,
  });
  return only.kind === "bids-only";
}

/** At `patch_released`: N.0.1 copied nothing of its own, so the record is complete. */
async function completeTurn(ctx: ResumeContext, row: RepullRow): Promise<Turn> {
  let done: RepullRow;
  try {
    done = await transitionRepull(row.id, { from: "patch_released", to: "complete" });
  } catch (err) {
    throw apiRefused(err, "The record could not be completed");
  }
  ctx.opts.out(
    `Re-pull #${row.id} of ${ctx.datasetId} is complete: v${row.to_version} and v${row.patch_version} are released.`,
  );
  return { kind: "done", result: { row: done, outcome: "complete" } };
}
