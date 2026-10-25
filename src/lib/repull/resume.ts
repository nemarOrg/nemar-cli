/**
 * `nemar admin repull resume <id>`: take an open re-pull up where it stopped, past its open pull
 * request (ADR 0111, decisions 2, 3, 6 and 7; epic #1046 phase 6). It runs on the administrator's
 * machine with their own GitHub token, reads GitHub and NEMAR's origin itself, and records each
 * step through the Worker, which reads again what it can. It never merges: a merge mints a version
 * DOI that cannot be withdrawn, and is `nemar admin repull merge`'s (or `nemar admin pr-reviews`'),
 * through the one gate in `merge.ts`.
 *
 * From the recorded status, each step checks its own end state before it acts:
 *
 *   pr_open      the pull request read on GitHub: merged is recorded through the Worker's verified
 *                route (a merge outside the tools, never written by hand); closed unmerged ends
 *                the record `abandoned`; a head moved by enrichment (the three shapes
 *                `run-enrichment.yml` writes, `head.ts`) is recorded, and any other head is
 *                `head-foreign`. `main` must be the base or an enrichment-shaped descendant
 *                (`main-moved` otherwise); when it moved and GitHub reports the pull request
 *                `dirty` or `behind`, the commit is made again on the new `main` and pushed with a
 *                lease (`resynthesize.ts`). The identifier screen of the head is dispatched when
 *                none exists or it produced no verdict, and acknowledged when the administrator
 *                gives a reason for a verdict that asks for one. When the screen passes and GitHub
 *                reports `clean`, `pr_open -> gates_clear` (the Worker reads the live head and the
 *                screen again); then it stops: "Ready to merge".
 *   gates_clear  a held claim to merge is resolved from GitHub: merged is recorded; a claim whose
 *                merge GitHub says did not happen expires once it is old enough (the Worker's own
 *                bound); a head that moved goes back to `pr_open`.
 *   merged       the tag and the version row waited for, the tagged tree compared, the release
 *                recorded through the Worker's verified route (`release.ts`);
 *   released     N.0.0's objects locked and the count recorded, then `complete` when the plan had
 *                no corrections (N.0.1 is a later slice's).
 *
 * It waits, up to `waitMinutes`, for the screen and for GitHub's state, reading again on each
 * turn; still waiting at the bound is the command's exit 3, with what it waits for. A step that
 * fails records why on the row (`[gates:<code>]`, never `[prepare:`, which only a preparation
 * clears) and refuses.
 */

import { dirname, join } from "node:path";
import type { RepullRow } from "../../../shared/repull-state.js";
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
import { readCatalogFacts } from "./execute/catalog.js";
import { type OriginScratch, openOriginScratch } from "./execute/origin.js";
import { acceptsHead, checkMain, releaseRefOf } from "./execute/pull-request.js";
import { resynthesize } from "./execute/resynthesize.js";
import { ExecuteRefused, assertNotAnonymous } from "./execute/verify-plan.js";
import { acquireLock, privateDir, withIsolatedGit, workPaths } from "./execute/workdir.js";
import { lockTurn, releaseTurn } from "./release.js";
import {
  type ResumeContext,
  type ResumeOptions,
  type ResumeResult,
  type Turn,
  apiRefused,
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
    return { row: latest, outcome: "nothing" };
  }
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
  try {
    return await walk(ctx, open);
  } finally {
    (scratch as OriginScratch | null)?.close();
    release();
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
      return gatesTurn(ctx, row);
    case "gates_clear":
      return claimTurn(ctx, row);
    case "merged":
      return releaseTurn(ctx, row);
    case "released":
      return lockTurn(ctx, row);
    default:
      throw new ExecuteRefused(
        "not-built",
        `Re-pull #${row.id} is ${row.status}: N.0.1 is not built yet.`,
      );
  }
}

/** The pull request, read with the administrator's token; unreadable is a resumable refusal. */
async function readPull(ctx: ResumeContext, row: RepullRow): Promise<PullRequestFacts> {
  const live = await fetchPullRequest(ctx.token, ctx.datasetId, row.pr_number as number, ctx.base);
  if (!live.ok) {
    throw refused(
      "github-unreadable",
      `Pull request #${row.pr_number} could not be read on GitHub (${live.reason})`,
    );
  }
  return live.value;
}

/** Record GitHub's merge through the Worker's verified route. */
async function recordMerge(ctx: ResumeContext, row: RepullRow): Promise<Turn> {
  let res: Awaited<ReturnType<typeof recordRepullMerged>>;
  try {
    res = await recordRepullMerged(row.id, "n0");
  } catch (err) {
    throw apiRefused(err, `The merge of pull request #${row.pr_number} could not be recorded`);
  }
  const notes = [
    res.merged_outside_tool ? "no NEMAR tool held a claim for it" : null,
    res.merged_unscreened_head ? "at a head other than the screened one" : null,
  ].filter(Boolean);
  ctx.opts.out(
    `Pull request #${row.pr_number} is merged; re-pull #${row.id} records it${notes.length > 0 ? ` (${notes.join(", ")})` : ""}.`,
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

/** A closed, unmerged pull request ends the record: decision 3's `abandoned`. */
async function closedUnmerged(ctx: ResumeContext, row: RepullRow): Promise<Turn> {
  const ended = await move(row, "abandoned", {}, "The record could not be ended");
  ctx.opts.out(
    `Pull request #${row.pr_number} was closed without being merged: re-pull #${row.id} is abandoned. Plan the dataset again to re-pull it.`,
  );
  return { kind: "done", result: { row: ended, outcome: "ended" } };
}

/** At `pr_open`: the head, `main`, the screen and GitHub's state, then the gates. */
async function gatesTurn(ctx: ResumeContext, row: RepullRow): Promise<Turn> {
  const live = await readPull(ctx, row);
  if (live.state === "merged") return recordMerge(ctx, row);
  if (live.state === "closed") return closedUnmerged(ctx, row);
  if (live.baseRef !== "main" || live.headRef !== row.branch) {
    const err = refused(
      "pr-foreign",
      `Pull request #${row.pr_number} is not ${row.branch} into main.`,
    );
    await recordStepError(row, resumeErrorWords("gates", err), ctx.opts.out);
    throw err;
  }

  // The head: the recorded one, or an enrichment-shaped descendant of the re-pull's commit.
  if (live.headSha !== row.head_sha) {
    if (ctx.replaced.has(live.headSha)) {
      return { kind: "wait", row, waitingFor: "GitHub to show the re-synthesized head" };
    }
    const scratch = await ctx.origin();
    const verdict = await acceptsHead({
      work: scratch.dir,
      from: row.synth_sha as string,
      head: live.headSha,
      ref: releaseRefOf(row.to_version),
      env: scratch.env,
    });
    if (verdict !== "ok") {
      const err =
        verdict === "unreadable"
          ? refused(
              "branch-unreadable",
              `Whether the head of ${row.branch} is this re-pull's commit and enrichment's could not be read.`,
            )
          : refused(
              "head-foreign",
              `${row.branch} holds a commit enrichment does not make: this re-pull cannot be merged as it is, and its record has to be abandoned (no command to abandon a record is built yet).`,
            );
      await recordStepError(row, resumeErrorWords("gates", err), ctx.opts.out);
      throw err;
    }
    const moved = await move(
      row,
      "pr_open",
      { branch: row.branch, pr_number: row.pr_number, head_sha: live.headSha },
      "The moved head could not be recorded",
    );
    ctx.opts.out(
      `${row.branch} moved by enrichment to ${live.headSha.slice(0, 12)}; re-pull #${row.id} records it.`,
    );
    return { kind: "next", row: moved };
  }

  // `main`: the base, or an enrichment-shaped descendant of it.
  const scratch = await ctx.origin();
  let main: string;
  try {
    main = await checkMain({ work: scratch.dir, baseSha: row.base_sha, env: scratch.env });
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
    row.pr_number as number,
    { headSha: live.headSha, mergeableState: live.mergeableState },
    { base: ctx.base, sleep: ctx.sleep },
  );
  if (!settled.ok) {
    if (settled.kind === "unreadable") {
      throw refused(
        "github-unreadable",
        `GitHub could not say whether #${row.pr_number} can be merged.`,
      );
    }
    // Moved or closed in between: wait a turn, then read it again from the top.
    return { kind: "wait", row, waitingFor: `pull request #${row.pr_number} to settle on GitHub` };
  }
  const state = settled.state;
  if (main !== row.base_sha && (state === "dirty" || state === "behind")) {
    return resynthesizeTurn(ctx, row, main, live.headSha, state);
  }

  const screen = await screenTurn(ctx, row);
  const waits: string[] = [];
  if (screen !== null) waits.push(screen);
  if (state !== "clean") {
    waits.push(`GitHub to report pull request #${row.pr_number} clean (it reports '${state}')`);
  }
  if (waits.length > 0) return { kind: "wait", row, waitingFor: waits.join(", and ") };

  let gated: RepullRow;
  try {
    gated = await transitionRepull(row.id, {
      from: "pr_open",
      to: "gates_clear",
      fields: { gates_sha: row.head_sha },
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
  ctx.opts.out(
    `The identifier screen and GitHub pass for ${String(row.head_sha).slice(0, 12)}: re-pull #${row.id} is gates_clear.`,
  );
  return {
    kind: "done",
    result: { row: gated, outcome: "ready" },
  };
}

/**
 * The screen of the recorded head: null when it passes, else what it waits for. Dispatched when
 * there is none or it produced no verdict (the Worker decides which); acknowledged when it asks for
 * a person and the administrator gave a reason. A direct identifier refuses.
 */
async function screenTurn(ctx: ResumeContext, row: RepullRow): Promise<string | null> {
  const head = row.head_sha as string;
  let listed: Awaited<ReturnType<typeof listRepullScreens>>;
  try {
    listed = await listRepullScreens(row.id);
  } catch (err) {
    throw apiRefused(err, "The identifier screens could not be read");
  }
  if (listed.exempt) return null;
  let screen: RepullScreen | null =
    listed.screens.find((s) => s.pr === "n0" && s.sha === head) ?? null;
  if (screen === null || screen.gate === "rerun") {
    try {
      const sent = await dispatchRepullScreen(row.id, { pr: "n0", sha: head });
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
          pr: "n0",
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

/** `main` moved by enrichment and the pull request cannot merge as it is: make the commit again. */
async function resynthesizeTurn(
  ctx: ResumeContext,
  row: RepullRow,
  main: string,
  liveHead: string,
  state: string,
): Promise<Turn> {
  if (
    ctx.opts.confirm &&
    !(await ctx.opts.confirm(
      `NEMAR's main moved by enrichment since re-pull #${row.id} was prepared, and GitHub reports its pull request '${state}'. Make the re-pull's commit again on the new main and push ${row.branch} with a lease (nothing outside .nemar/ changes)?`,
    ))
  ) {
    throw new ExecuteRefused("declined", "Not confirmed; nothing was pushed.");
  }
  const scratch = await ctx.origin();
  let made: { synthSha: string; synthTree: string };
  try {
    made = await resynthesize({ scratch, row, newMain: main, liveHead });
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
    "pr_open",
    {
      branch: row.branch,
      pr_number: row.pr_number,
      head_sha: made.synthSha,
      synth_sha: made.synthSha,
      synth_tree: made.synthTree,
      base_sha: main,
    },
    "The re-synthesized commit could not be recorded",
  );
  ctx.opts.out(
    `Made re-pull #${row.id}'s commit again on the new main (${made.synthSha.slice(0, 12)}) and pushed ${row.branch}; its identifier screen runs again for the new head.`,
  );
  return { kind: "next", row: next };
}

/**
 * At `gates_clear`. A held claim is resolved from GitHub first: merged is recorded; a merge that
 * did not happen expires the claim once the Worker says it is old enough. Then the pull request as
 * it is: merged, closed, a moved head, or ready.
 */
async function claimTurn(ctx: ResumeContext, row: RepullRow): Promise<Turn> {
  const live = await readPull(ctx, row);
  if (live.state === "merged") return recordMerge(ctx, row);
  if (row.merge_claim_sha !== null) {
    try {
      const freed = await releaseRepullMergeClaim(row.id, {
        pr: "n0",
        sha: row.merge_claim_sha,
        outcome: "expired",
      });
      ctx.opts.out(
        `The claim to merge made at ${row.merge_claimed_at} expired: GitHub says pull request #${row.pr_number} did not merge, and its unit of today's merge cap is free.`,
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
            waitingFor: `the claim to merge made at ${row.merge_claimed_at} to be resolved: run nemar admin repull merge ${ctx.datasetId} to send the merge again under it, or resume later to expire it`,
          },
        };
      }
      throw apiRefused(err, "The claim to merge could not be resolved");
    }
  }
  if (live.state === "closed") return closedUnmerged(ctx, row);
  if (live.headSha !== row.gates_sha) {
    const scratch = await ctx.origin();
    const verdict = await acceptsHead({
      work: scratch.dir,
      from: row.synth_sha as string,
      head: live.headSha,
      ref: releaseRefOf(row.to_version),
      env: scratch.env,
    });
    if (verdict !== "ok") {
      // Not recorded: a foreign head is never written as the row's, and `gates_clear` records no
      // error; the merge gate refuses a head that is not the screened one.
      throw refused(
        verdict === "unreadable" ? "branch-unreadable" : "head-foreign",
        `${row.branch} moved since its gates were recorded, ${verdict === "unreadable" ? "and whether by enrichment only could not be read" : "by a commit enrichment does not make"}.`,
      );
    }
    const back = await move(
      row,
      "pr_open",
      { branch: row.branch, pr_number: row.pr_number, head_sha: live.headSha },
      "The moved head could not be recorded",
    );
    ctx.opts.out(
      `${row.branch} moved by enrichment since its gates were recorded; re-pull #${row.id} is pr_open again, and its screen runs for the new head.`,
    );
    return { kind: "next", row: back };
  }
  return { kind: "done", result: { row, outcome: "ready" } };
}
