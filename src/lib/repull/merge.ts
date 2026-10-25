/**
 * The one gate every merge of an upstream re-pull's pull request goes through (ADR 0111, decisions
 * 1, 6 and 7; ADR 0093 for the administrator's merge; epic #1046 phase 6), whether
 * `nemar admin repull merge <id>` or `nemar admin pr-reviews` (`approve --merge`, `y` in `next`)
 * asks for it. Each merge mints a version DOI that cannot be withdrawn, so nothing here merges
 * unless all of these hold, read in this order, and a refusal before the claim writes nothing:
 *
 *  1. the record is `gates_clear` (its screened head recorded; `resume` gets it there);
 *  2. the dataset is not an anonymous deposit (the catalog row says `anonymous` is exactly 0);
 *  3. GitHub's live pull request is open, not a draft, the record's release branch into `main`,
 *     with its head at the screened commit;
 *  4. NEMAR's `main` is the record's base, or moved by enrichment-shaped commits only (`head.ts`);
 *  5. the automated review (ADR 0107) read for that head, at the time of the merge: one that
 *     failed, is running or cannot be read needs `force`, as `approve` asks;
 *  6. the identifier screen of that head is clear, or carries a recorded acknowledgment (the
 *     Worker checks it is this administrator's at the claim), or the dataset is `xx`, which is
 *     not screened (ADR 0086);
 *  7. GitHub reports the pull request `clean`;
 *  8. the squash message, which the gate writes itself, ends with both of the re-pull commit's
 *     trailers as git reads them (`trailers.ts`), so the privacy ledger's fresh-clone proof reads
 *     the merge on `main` as the re-pull's own commit;
 * then the administrator's confirmation (one irreversible DOI), then one unit of the day's merge
 * cap claimed from the Worker, which reads the live head, the screen and the dataset fences again
 * in the statement that claims; then the squash merge at the screened `sha`, so GitHub refuses a
 * head that moved after the gate read it; then the merge recorded through the Worker's verified
 * route, which reads it on GitHub.
 *
 * A claim already held for the screened head (a merge whose answer was lost, a run that stopped
 * after its claim) is used again: the merge is sent under it, without a second claim, since a pull
 * request merges once. A merge GitHub did not make releases the claim when the Worker allows it;
 * one whose outcome is unknown keeps it, and `resume` reads GitHub and records the merge, or
 * expires the claim once nothing can be in flight.
 */

import type { RepullRow } from "../../../shared/repull-state.js";
import { getPrReview } from "../api/admin.js";
import { ApiError } from "../api/errors.js";
import {
  getRepull,
  listRepullScreens,
  listRepulls,
  recordRepullMerged,
  releaseRepullMergeClaim,
  repullErrorCode,
  transitionRepull,
} from "../api/repull.js";
import {
  type ApprovalGate,
  type WriteOutcome,
  approvalGate,
  checkMergeable,
  fetchPullRequest,
  mergeWhenClean,
  reviewForApproval,
} from "../pr-review-approve.js";
import { readCatalogFacts } from "./execute/catalog.js";
import { openOriginScratch } from "./execute/origin.js";
import { checkMain } from "./execute/pull-request.js";
import { ExecuteRefused, assertNotAnonymous } from "./execute/verify-plan.js";
import { withIsolatedGit } from "./execute/workdir.js";
import type { Env } from "./sources.js";
import { repullTrailerLines, trailersProblem } from "./trailers.js";

/** Where the gate stopped. Every stage before `declined` and `cap` wrote nothing. */
export type MergeStage =
  | "not-ready"
  | "review"
  | "screen"
  | "main-moved"
  | "github"
  | "message"
  | "declined"
  | "cap";

export type GateRefusal = { ok: false; stage: MergeStage; reason: string };

/** What the gate read, for the merge it allows. */
export interface RepullMergeCheck {
  row: RepullRow;
  prNumber: number;
  /** The screened head: the claim names it, and the merge is sent at it. */
  head: string;
  squash: { title: string; message: string };
  /** A claim for this head is already held: the merge is sent again under it. */
  heldClaim: boolean;
  /** What the confirmation shows beside the DOI line (a review that did not pass, say). */
  warnings: string[];
}

export type MergeOutcome =
  | { merged: true; row: RepullRow; mergeSha: string | null; recorded: boolean }
  | {
      merged: false;
      stage: MergeStage;
      reason: string;
      /** What is known of a merge that was claimed and sent. */
      outcome?: WriteOutcome;
      /** True while the claim to merge is held (a lost answer, a release the Worker deferred). */
      claimHeld?: boolean;
    };

export interface GateContext {
  datasetId: string;
  /** The administrator's own GitHub token, checked by the caller. */
  token: string;
  /** GitHub's API origin (a loopback stand-in in tests). */
  base: string;
  env: Env;
  configDir: string;
  /** Merge although the automated review failed, is running or could not be read. */
  force: boolean;
  /** Tests only: how GitHub's lazily computed state is waited for. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * A stop of the gate at `stage`. Stages are the gate's own words for its caller, not refusal codes
 * a dispatched run reports: the automatic path never merges through this gate.
 */
const stopAt = (stage: MergeStage, reason: string): GateRefusal => ({ ok: false, stage, reason });

/**
 * The re-pull record whose pull request `prNumber` is, in any status, or null when no record of
 * the dataset names it (an ordinary release pull request). Throws when the NEMAR API cannot be
 * read: a caller must then refuse the merge of a `release/*` pull request, never merge it
 * unguarded.
 */
export async function repullForPullRequest(
  datasetId: string,
  prNumber: number,
): Promise<{ row: RepullRow; pr: "n0" | "n1" } | null> {
  let after: number | undefined;
  for (let page = 0; page < 20; page++) {
    const listed = await listRepulls({ dataset: datasetId, limit: 50, after });
    for (const row of listed.repulls) {
      if (row.pr_number === prNumber) return { row, pr: "n0" };
      if (row.patch_pr_number === prNumber) return { row, pr: "n1" };
    }
    if (listed.next_after === null) return null;
    after = listed.next_after;
  }
  throw new Error("the re-pull records of this dataset could not be read to the end");
}

/** What `nemar admin pr-reviews` learns of a pull request it is asked to merge. */
export type PrReviewsGate =
  /** Not a re-pull's: it merges as any other pull request does. */
  | { kind: "ordinary" }
  /** A re-pull's, and the gate allows it: the merge is `sendRepullMerge`'s. */
  | { kind: "repull"; ctx: GateContext; check: RepullMergeCheck }
  /** A re-pull's (or one that could be), and nothing may be approved or merged. */
  | { kind: "refused"; reason: string };

/**
 * The gate as `nemar admin pr-reviews` meets it (ADR 0111, decision 7): a pull request whose head
 * branch is `release/*` may be a re-pull's, and is looked up in the re-pull records; a NEMAR API
 * that cannot be read refuses its merge ("could not tell"), never merges it unguarded. A re-pull's
 * pull request runs the gate's checks, which write nothing, so a refusal leaves nothing approved.
 * An ordinary release pull request is unaffected.
 */
export async function prReviewsGate(args: {
  datasetId: string;
  prNumber: number;
  headRef: string;
  token: string;
  base: string;
  env: Env;
  configDir: string;
  force: boolean;
}): Promise<PrReviewsGate> {
  if (!args.headRef.startsWith("release/")) return { kind: "ordinary" };
  let found: Awaited<ReturnType<typeof repullForPullRequest>>;
  try {
    found = await repullForPullRequest(args.datasetId, args.prNumber);
  } catch (err) {
    return {
      kind: "refused",
      reason: `Could not tell whether this is an upstream re-pull's pull request (the NEMAR API answered ${errorText(err)}), and a re-pull's merges only through its gate.`,
    };
  }
  if (!found) return { kind: "ordinary" };
  if (found.pr !== "n0") {
    return {
      kind: "refused",
      reason: `This is re-pull #${found.row.id}'s N.0.1 pull request, and merging N.0.1 is not built yet.`,
    };
  }
  const ctx: GateContext = {
    datasetId: args.datasetId,
    token: args.token,
    base: args.base,
    env: args.env,
    configDir: args.configDir,
    force: args.force,
  };
  const checked = await checkRepullMerge(ctx, { row: found.row, prNumber: args.prNumber });
  if (!checked.ok) {
    return {
      kind: "refused",
      reason: `This is upstream re-pull #${found.row.id}'s pull request, which merges only through its gate, and the gate refuses (${checked.stage}): ${checked.reason}`,
    };
  }
  return { kind: "repull", ctx, check: checked.check };
}

/** The squash commit the gate sends: its title and a message whose last paragraph is the trailers. */
export function squashMessage(
  row: RepullRow,
  prNumber: number,
): { title: string; message: string } {
  const [snapshot, plan] = repullTrailerLines(row);
  return {
    title: `Release v${row.to_version} (#${prNumber})`,
    message: [
      `Re-pull of upstream ${row.upstream_ds} from snapshot ${row.from_tag} to ${row.to_tag} (re-pull #${row.id}), squash-merged through the re-pull's merge gate (ADR 0111).`,
      "",
      snapshot,
      plan,
    ].join("\n"),
  };
}

/** The automated review of `head`, read now, as `approve` gates on it (ADR 0093, ADR 0107). */
async function reviewGate(
  datasetId: string,
  prNumber: number,
  head: string,
): Promise<ApprovalGate | GateRefusal> {
  let unread: string | undefined;
  let verdict: Parameters<typeof approvalGate>[0]["verdict"] = "not_reviewed";
  let staleVerdict: Parameters<typeof approvalGate>[0]["staleVerdict"] = null;
  try {
    const read = reviewForApproval(await getPrReview(datasetId, prNumber, head), head);
    if (read.ok) {
      verdict = read.verdict;
      staleVerdict = read.staleVerdict;
    } else {
      unread = read.why;
    }
  } catch (err) {
    const word = repullErrorCode(err);
    if (
      word === "not_owned_here" ||
      word === "github_unavailable" ||
      word === "no_such_pull_request"
    ) {
      unread = err instanceof Error ? err.message : "the NEMAR API did not answer";
    } else {
      return stopAt(
        "review",
        `The automated review of ${head.slice(0, 12)} could not be read (${err instanceof ApiError ? `HTTP ${err.statusCode}` : "no answer"}); nothing was claimed or merged.`,
      );
    }
  }
  return approvalGate({ verdict, staleVerdict, unread });
}

/**
 * Steps 1 to 8 of the module comment, for `row` (or the dataset's open record). Writes nothing.
 * `prNumber`, when given, must be the record's N.0.0 pull request.
 */
export async function checkRepullMerge(
  ctx: GateContext,
  given?: { row: RepullRow; prNumber: number },
): Promise<{ ok: true; check: RepullMergeCheck } | GateRefusal> {
  return withIsolatedGit(() => check(ctx, given));
}

async function check(
  ctx: GateContext,
  given?: { row: RepullRow; prNumber: number },
): Promise<{ ok: true; check: RepullMergeCheck } | GateRefusal> {
  const id = ctx.datasetId;
  // 1. The record.
  let row: RepullRow | null;
  try {
    row = given
      ? await getRepull(given.row.id)
      : ((await listRepulls({ dataset: id, open: true, limit: 1 })).repulls[0] ?? null);
  } catch (err) {
    return stopAt("not-ready", `The re-pull record could not be read (${errorText(err)}).`);
  }
  if (!row) return stopAt("not-ready", `${id} has no open re-pull.`);
  if (given && row.pr_number !== given.prNumber) {
    return stopAt(
      "not-ready",
      `Pull request #${given.prNumber} is not re-pull #${row.id}'s N.0.0 pull request; N.0.1 is not built yet.`,
    );
  }
  if (row.status !== "gates_clear") {
    return stopAt(
      "not-ready",
      row.status === "pr_open"
        ? `Re-pull #${row.id}'s gates are not recorded: run nemar admin repull resume ${id} (the identifier screen and GitHub's state).`
        : `Re-pull #${row.id} is ${row.status}, and only a gates_clear record is merged.`,
    );
  }
  const prNumber = row.pr_number as number;
  const head = row.gates_sha as string;

  // 2. The dataset, every run: an anonymous deposit is never re-pulled.
  try {
    assertNotAnonymous(await readCatalogFacts(id));
  } catch (err) {
    return stopAt("not-ready", err instanceof Error ? err.message : String(err));
  }

  // 3. The pull request on GitHub, with the administrator's token.
  const live = await fetchPullRequest(ctx.token, id, prNumber, ctx.base);
  if (!live.ok)
    return stopAt("github", `Pull request #${prNumber} could not be read: ${live.reason}`);
  const pr = live.value;
  if (pr.state !== "open") {
    return stopAt(
      "not-ready",
      `Pull request #${prNumber} is ${pr.state}; run nemar admin repull resume ${id}, which records it.`,
    );
  }
  if (pr.draft) return stopAt("not-ready", `Pull request #${prNumber} is a draft.`);
  if (pr.baseRef !== "main" || pr.headRef !== row.branch) {
    return stopAt("not-ready", `Pull request #${prNumber} is not ${row.branch} into main.`);
  }
  if (pr.headSha !== head) {
    return stopAt(
      "not-ready",
      `Pull request #${prNumber} is at ${pr.headSha.slice(0, 12)}, not the screened ${head.slice(0, 12)}: run nemar admin repull resume ${id}.`,
    );
  }

  // 4. `main`, in a scratch repository of origin.
  const scratch = await openOriginScratch({
    configDir: ctx.configDir,
    datasetId: id,
    digest: row.plan_digest,
    purpose: "merge",
    env: ctx.env,
    token: ctx.token,
  });
  try {
    await checkMain({ work: scratch.dir, baseSha: row.base_sha, env: scratch.env });
  } catch (err) {
    if (err instanceof ExecuteRefused && err.code === "main-moved") {
      return stopAt("main-moved", `${err.message} Nothing was claimed or merged.`);
    }
    return stopAt("github", err instanceof Error ? err.message : String(err));
  } finally {
    scratch.close();
  }

  // 5. The automated review, read for this head.
  const review = await reviewGate(id, prNumber, head);
  if ("ok" in review) return review;
  if (review.kind === "needs_force" && !ctx.force) return stopAt("review", review.reason);
  const warnings =
    review.kind === "confirm"
      ? [review.warning]
      : review.kind === "needs_force"
        ? ["Merging anyway (--force): the automated review failed, is running or was not read."]
        : [];

  // 6. The identifier screen of this head.
  let screens: Awaited<ReturnType<typeof listRepullScreens>>;
  try {
    screens = await listRepullScreens(row.id);
  } catch (err) {
    return stopAt("screen", `The identifier screen could not be read (${errorText(err)}).`);
  }
  if (!screens.exempt) {
    const screen = screens.screens.find((s) => s.pr === "n0" && s.sha === head);
    const passes =
      screen !== undefined &&
      (screen.gate === "clear" ||
        (screen.gate === "acknowledge" && screen.acknowledged_at !== null));
    if (!passes) {
      return stopAt(
        "screen",
        `${screen ? screen.headline : "No identifier screen of this head is recorded"}; run nemar admin repull resume ${id}.`,
      );
    }
  }

  // 7. GitHub's own state.
  const clean = await checkMergeable(
    ctx.token,
    id,
    prNumber,
    { headSha: head, mergeableState: pr.mergeableState },
    { base: ctx.base, ...(ctx.sleep ? { sleep: ctx.sleep } : {}) },
  );
  if (!clean.ok) return stopAt("github", `${clean.why} Nothing was claimed or merged.`);

  // 8. The squash message, read as git reads it.
  const squash = squashMessage(row, prNumber);
  const problem = await trailersProblem(`${squash.title}\n\n${squash.message}`, row);
  if (problem) {
    return stopAt(
      "message",
      `The squash message would not carry the re-pull's trailers: ${problem}.`,
    );
  }
  return {
    ok: true,
    check: { row, prNumber, head, squash, heldClaim: row.merge_claim_sha === head, warnings },
  };
}

function errorText(err: unknown): string {
  return err instanceof ApiError
    ? `HTTP ${err.statusCode}`
    : err instanceof Error
      ? err.message
      : String(err);
}

/** The words of the merge's confirmation: one irreversible DOI. */
export function doiLine(row: RepullRow): string {
  return `This merge mints one irreversible version DOI, v${row.to_version}, and takes one unit of today's re-pull merge cap.`;
}

/**
 * Claim one unit of the day's cap (or use the claim already held), merge at the screened head
 * with the gate's squash message, and record the merge. `check` is what `checkRepullMerge` read;
 * the review is read once more right before the claim, because an administrator can reset a
 * stored pass on the same head (`pr-reviews start --redo`).
 */
export async function sendRepullMerge(
  ctx: GateContext,
  check: RepullMergeCheck,
  opts: {
    confirm?: (question: string) => Promise<boolean>;
    out: (line: string) => void;
    tries?: number;
  },
): Promise<MergeOutcome> {
  const { row, prNumber, head } = check;
  const review = await reviewGate(ctx.datasetId, prNumber, head);
  if ("ok" in review) return { merged: false, stage: review.stage, reason: review.reason };
  if (review.kind === "needs_force" && !ctx.force) {
    return { merged: false, stage: "review", reason: review.reason };
  }
  if (opts.confirm) {
    const lines = [doiLine(row), ...check.warnings];
    if (
      !(await opts.confirm(
        `${lines.join(" ")} Merge pull request #${prNumber} of ${ctx.datasetId}?`,
      ))
    ) {
      return {
        merged: false,
        stage: "declined",
        reason: "Not confirmed; nothing was claimed or merged.",
      };
    }
  }

  if (!check.heldClaim) {
    try {
      await transitionRepull(row.id, {
        from: "gates_clear",
        to: "gates_clear",
        fields: { merge_claim_sha: head },
      });
    } catch (err) {
      const code = repullErrorCode(err);
      const reason = `The claim to merge was refused (${code ?? errorText(err)}): ${err instanceof Error ? err.message : String(err)} Nothing was merged.`;
      if (code === "merge-cap" || code === "merge-cap-unreadable") {
        return { merged: false, stage: "cap", reason };
      }
      if (code === "screen-not-clear" || code === "screen-changed") {
        return { merged: false, stage: "screen", reason };
      }
      return {
        merged: false,
        stage: code === "github-unreadable" ? "github" : "not-ready",
        reason,
      };
    }
    opts.out(`Claimed one unit of today's re-pull merge cap for ${head.slice(0, 12)}.`);
  } else {
    opts.out(
      `A claim to merge ${head.slice(0, 12)} is already held; the merge is sent again under it.`,
    );
  }

  const merged = await mergeWhenClean(ctx.token, ctx.datasetId, prNumber, head, "squash", {
    base: ctx.base,
    commit: check.squash,
    ...(ctx.sleep ? { sleep: ctx.sleep } : {}),
    ...(opts.tries !== undefined ? { tries: opts.tries } : {}),
  });
  if (merged.ok) {
    try {
      const recorded = await recordRepullMerged(row.id, "n0");
      return {
        merged: true,
        row: recorded.repull,
        mergeSha: recorded.repull.merge_sha,
        recorded: true,
      };
    } catch (err) {
      opts.out(
        `GitHub merged pull request #${prNumber}, and the merge could not be recorded yet (${repullErrorCode(err) ?? errorText(err)}); nemar admin repull resume ${ctx.datasetId} records it.`,
      );
      return { merged: true, row, mergeSha: null, recorded: false };
    }
  }
  if (merged.outcome === "unknown" || merged.outcome === "different") {
    return {
      merged: false,
      stage: "github",
      outcome: merged.outcome,
      claimHeld: true,
      reason: `${merged.reason} GitHub may have merged it: the claim is kept, and nemar admin repull resume ${ctx.datasetId} reads GitHub and records the merge.`,
    };
  }
  // GitHub did not merge it (not sent after a last look, or refused): free the unit when allowed.
  try {
    await releaseRepullMergeClaim(row.id, { pr: "n0", sha: head, outcome: merged.outcome });
    return {
      merged: false,
      stage: "github",
      outcome: merged.outcome,
      claimHeld: false,
      reason: `${merged.reason} The claim to merge was released.`,
    };
  } catch (err) {
    return {
      merged: false,
      stage: "github",
      outcome: merged.outcome,
      claimHeld: true,
      reason: `${merged.reason} The claim to merge is kept for now (${repullErrorCode(err) ?? errorText(err)}): run nemar admin repull merge ${ctx.datasetId} again to send the merge under it, or resume to expire it once it is old enough.`,
    };
  }
}
