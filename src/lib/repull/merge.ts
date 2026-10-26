/**
 * The one gate every merge of an upstream re-pull's pull request goes through (ADR 0111, decisions
 * 1, 6 and 7; ADR 0093 for the administrator's merge; epic #1046 phase 6), whether
 * `nemar admin repull merge <id>` or `nemar admin pr-reviews` (`approve --merge`, `y` in `next`)
 * asks for it. Each merge mints a version DOI that cannot be withdrawn, so nothing here merges
 * unless all of these hold, read in this order, and a refusal before the claim writes nothing:
 *
 *  1. the record is `gates_clear` for N.0.0's pull request, or `patch_gates_clear` for N.0.1's
 *     (its screened head recorded; `resume` gets it there);
 *  2. the dataset is not an anonymous deposit (the catalog row says `anonymous` is exactly 0);
 *  3. GitHub's live pull request is open, not a draft, the record's release branch into `main`,
 *     from and into the dataset's own repository (a fork, a deleted one included, is refused),
 *     with its head at the screened commit;
 *  4. NEMAR's `main` is the pull request's base (the record's for N.0.0, N.0.1's own for N.0.1),
 *     or moved by enrichment-shaped commits only (`head.ts`), and none of them outside `.nemar/`
 *     and `.github/` (`merge-main-moved`: the squash would tag a tree the gates did not clear;
 *     resume makes the commit again on the new `main`);
 *  5. the automated review (ADR 0107) read for that head, at the time of the merge: one that
 *     failed, is running or cannot be read needs `force`, as `approve` asks;
 *  6. the identifier screen of that head is clear, or carries a recorded acknowledgment (the
 *     Worker checks it is this administrator's at the claim), or the dataset is `xx`, which is
 *     not screened (ADR 0086);
 *  7. GitHub reports the pull request `clean`;
 *  8. the squash message, which the gate writes itself, ends with both of the re-pull commit's
 *     trailers as git reads them (`trailers.ts`), so the privacy ledger's fresh-clone proof reads
 *     the merge on `main` as the re-pull's own commit;
 * then the review read once more and the administrator's confirmation (one irreversible DOI);
 * then, holding the record's lock (the one `resume` and `execute` take), one unit of the day's
 * merge cap claimed from the Worker, which reads the live head, the screen and the dataset fences
 * again in the statement that claims; then the squash merge at the screened `sha`, so GitHub
 * refuses a head that moved after the gate read it; then the merge recorded through the Worker's
 * verified route, which reads it on GitHub. The merge commit GitHub wrote is read back at the
 * release (`release.ts`), because the message sent is not proof of the message committed.
 *
 * A merge over a failed BIDS validation (`bidsFailureReason`, the administrator's own reason; ADR
 * 0111, the Phase 7g amendment) is for a record an administrator opened. Step 7 then needs GitHub's
 * `unstable` instead of `clean` and refuses `blocked`, where a rule requires the check and the
 * merge would be a bypass, which a re-pull never uses; the claim carries the reason, and the Worker
 * records it only after reading, at the claimed head, BIDS validation completed with `failure`,
 * `version-check` with `success` and the state `unstable`; a claim already held is not used for
 * it; and the merge is sent only while GitHub still says `unstable`.
 *
 * A claim already held for the screened head (a merge whose answer was lost, a run that stopped
 * after its claim) is used again, without a second claim, since a pull request merges once, but
 * only after the Worker reads again, for it, what the claim's statement read when it was made (the
 * dataset fences, the screen for this administrator, the live head) and only while it is younger
 * than 25 minutes, so no merge goes out under a claim `resume` may be expiring. A merge GitHub did
 * not make keeps its claim (it is seconds old, younger than any release the Worker allows): a merge
 * sent again within 25 minutes uses it, and `resume` expires it at 30 minutes. One whose outcome is
 * unknown keeps it too, and `resume` reads GitHub and records the merge.
 */

import { dirname, join } from "node:path";
import { repullSquashMessage } from "../../../shared/repull-squash.js";
import {
  PULL_REQUEST_COLUMNS,
  type RepullPullRequest,
  type RepullRow,
  pullRequestOfGatesStatus,
} from "../../../shared/repull-state.js";
import { getPrReview } from "../api/admin.js";
import { ApiError } from "../api/errors.js";
import {
  checkRepullMergeClaim,
  getRepull,
  listRepullScreens,
  listRepulls,
  recordRepullMerged,
  repullErrorCode,
  transitionRepull,
} from "../api/repull.js";
import {
  type ApprovalGate,
  DATASETS_ORG,
  type MergeResult,
  type WriteOutcome,
  approvalGate,
  checkMergeable,
  fetchPullRequest,
  mergeCheckOf,
  mergeWhenClean,
  reviewForApproval,
  settleMergeState,
} from "../pr-review-approve.js";
import { readCatalogFacts } from "./execute/catalog.js";
import { changedOutsideNemar } from "./execute/head.js";
import { openOriginScratch } from "./execute/origin.js";
import { checkMain } from "./execute/pull-request.js";
import { ExecuteRefused, assertNotAnonymous } from "./execute/verify-plan.js";
import { acquireLock, privateDir, withIsolatedGit, workPaths } from "./execute/workdir.js";
import { PATCH_TRAILER } from "./patch.js";
import type { Env } from "./sources.js";
import { trailersProblem } from "./trailers.js";

/**
 * Where the gate stopped. `checkRepullMerge` writes nothing, whatever its stage. In
 * `sendRepullMerge`, `review` and `declined` come before the claim and write nothing, and `cap` is
 * the claim refused, which writes nothing either (ADR 0099). A stop after a claim was made or
 * reused (`github`, and `not-ready` or `screen` on a held claim's check) leaves the claim held, and
 * `claimHeld` says so.
 */
export type MergeStage =
  | "not-ready"
  | "review"
  | "screen"
  | "main-moved"
  | "merge-main-moved"
  | "github"
  | "bids"
  | "message"
  | "declined"
  | "cap";

export type GateRefusal = { ok: false; stage: MergeStage; reason: string };

/** What the gate read, for the merge it allows. */
export interface RepullMergeCheck {
  row: RepullRow;
  /** Which of the record's pull requests: N.0.0's or N.0.1's. */
  pr: RepullPullRequest;
  /** The version its merge mints. */
  version: string;
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
  /**
   * The administrator's reason for a merge over a failed BIDS validation (ADR 0111, the Phase 7g
   * amendment; `nemar admin repull merge --bids-failure-reason`), for a record an administrator
   * opened, only while GitHub reports the pull request `unstable` and never `blocked`. The claim
   * carries it, and the Worker checks, at the claimed head, that BIDS validation failed,
   * `version-check` passed and the state is `unstable` before it records the claim and the reason.
   */
  bidsFailureReason?: string;
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
  if (args.headRef === "") {
    return {
      kind: "refused",
      reason:
        "GitHub's answer did not name the pull request's head branch, so whether it is an upstream re-pull's cannot be told, and a re-pull's merges only through its gate.",
    };
  }
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

/**
 * The squash commit the gate sends: its title and a message whose last paragraph is the trailers
 * (N.0.1's with its own `Repull-Patch:` beside them, when the record says how many corrections).
 * Built in `shared/repull-squash.ts`, which the Worker's merge of an automatic re-pull builds its
 * message with too.
 */
export function squashMessage(
  row: RepullRow,
  prNumber: number,
  pr: RepullPullRequest = "n0",
): { title: string; message: string } {
  return repullSquashMessage(row, prNumber, pr, "gate");
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
 * `prNumber`, when given, must be one of the record's two pull requests.
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
  const named: RepullPullRequest | null = given
    ? row.pr_number === given.prNumber
      ? "n0"
      : row.patch_pr_number === given.prNumber
        ? "n1"
        : null
    : pullRequestOfGatesStatus(row.status);
  if (given && named === null) {
    return stopAt(
      "not-ready",
      `Pull request #${given.prNumber} is not one of re-pull #${row.id}'s pull requests.`,
    );
  }
  const pr: RepullPullRequest = named ?? "n0";
  const c = PULL_REQUEST_COLUMNS[pr];
  if (row.status !== c.gatesClear) {
    return stopAt(
      "not-ready",
      row.status === "pr_open" || row.status === "patch_synthesized"
        ? `Re-pull #${row.id}'s gates are not recorded: run nemar admin repull resume ${id} (the identifier screen and GitHub's state).`
        : `Re-pull #${row.id} is ${row.status}; its ${pr === "n0" ? "N.0.0" : "N.0.1"} pull request is merged only from ${c.gatesClear}.`,
    );
  }
  const prNumber = row[c.number] as number;
  const head = row[c.gates] as string;
  const branch = row[c.branch] as string;
  const base = (pr === "n0" ? row.base_sha : row.patch_base_sha) as string;
  // A merge over a failed BIDS validation is an administrator's, for a re-pull an administrator
  // opened: the automatic path never merges over a failed check, and its pull request is not
  // merged over one by anyone.
  if (ctx.bidsFailureReason !== undefined && row.origin !== "administrator") {
    return stopAt(
      "bids",
      `Re-pull #${row.id} was opened by the automatic path, and its pull request is not merged over a failed BIDS validation; nothing was claimed or merged. Merge it once BIDS validation passes, or abandon it (nemar admin repull abandon ${id}) and re-pull it by hand.`,
    );
  }

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
  if (live.value.state !== "open") {
    return stopAt(
      "not-ready",
      `Pull request #${prNumber} is ${live.value.state}; run nemar admin repull resume ${id}, which records it.`,
    );
  }
  if (live.value.draft) return stopAt("not-ready", `Pull request #${prNumber} is a draft.`);
  if (live.value.baseRef !== "main" || live.value.headRef !== branch) {
    return stopAt("not-ready", `Pull request #${prNumber} is not ${branch} into main.`);
  }
  // From and into the dataset's own repository: a fork's branch of the same name is not the
  // re-pull's, and one whose repository GitHub no longer names (a deleted fork) fails closed too.
  if (!isOwnRepo(live.value.headRepo, id) || !isOwnRepo(live.value.baseRepo, id)) {
    return stopAt(
      "not-ready",
      `Pull request #${prNumber} is not from and into ${DATASETS_ORG}/${id} itself (its head is ${live.value.headRepo ?? "a repository GitHub no longer names"}, its base ${live.value.baseRepo ?? "a repository GitHub no longer names"}): a fork's pull request is never merged as a re-pull's. Nothing was claimed or merged.`,
    );
  }
  if (live.value.headSha !== head) {
    return stopAt(
      "not-ready",
      `Pull request #${prNumber} is at ${live.value.headSha.slice(0, 12)}, not the screened ${head.slice(0, 12)}: run nemar admin repull resume ${id}.`,
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
    const main = await checkMain({ work: scratch.dir, baseSha: base, env: scratch.env });
    // Enrichment may move `main` after the gates, on a path outside NEMAR's own (a `.bidsignore`
    // line, a placeholder `participants.tsv`). The squash would then tag main's tree with the pull
    // request's changes, which outside `.nemar/` and `.github/` is no longer the screened head, and
    // the release would refuse it after the DOI is minted. With no such path changed since the
    // base, main's tree plus the pull request's changes is the screened head there, so this one
    // reading decides both.
    if (main !== base) {
      const moved = await changedOutsideNemar(scratch.dir, base, main);
      if (moved === null) {
        return stopAt(
          "github",
          "Whether NEMAR's main moved outside .nemar/ and .github/ since the gates could not be read; nothing was claimed or merged.",
        );
      }
      if (moved.length > 0) {
        return stopAt(
          "merge-main-moved",
          `NEMAR's main moved by enrichment since the gates, on ${moved.length} path(s) outside .nemar/ and .github/, so the squash would tag a tree the gates did not clear; nothing was claimed or merged. Run nemar admin repull resume ${id}: it makes the commit again on the new main, whose screen and gates run again.`,
        );
      }
    }
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
    const screen = screens.screens.find((s) => s.pr === pr && s.sha === head);
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

  // 7. GitHub's own state: `clean`, or, for a merge over a failed BIDS validation, `unstable`.
  if (ctx.bidsFailureReason !== undefined) {
    const refused = await unstableOnly(ctx, prNumber, head, live.value.mergeableState);
    if (refused) return refused;
  } else {
    const clean = await checkMergeable(
      ctx.token,
      id,
      prNumber,
      { headSha: head, mergeableState: live.value.mergeableState },
      { base: ctx.base, ...(ctx.sleep ? { sleep: ctx.sleep } : {}) },
    );
    if (!clean.ok) return stopAt("github", `${clean.why} Nothing was claimed or merged.`);
  }

  // 8. The squash message, read as git reads it. N.0.1's carries the count of corrections, which
  // the record must state: unknown is never a count.
  const corrections = row.counts?.corrections;
  if (
    pr === "n1" &&
    (typeof corrections !== "number" || !Number.isSafeInteger(corrections) || corrections < 0)
  ) {
    return stopAt(
      "message",
      `Re-pull #${row.id} does not state how many corrections N.0.1 replays, so its squash message would not carry ${PATCH_TRAILER}:; nothing was claimed or merged.`,
    );
  }
  const squash = squashMessage(row, prNumber, pr);
  const problem = await trailersProblem(`${squash.title}\n\n${squash.message}`, row);
  if (problem) {
    return stopAt(
      "message",
      `The squash message would not carry the re-pull's trailers: ${problem}.`,
    );
  }
  return {
    ok: true,
    check: {
      row,
      pr,
      version: row[c.version] as string,
      prNumber,
      head,
      squash,
      heldClaim: row[c.claimSha] === head,
      warnings,
    },
  };
}

/**
 * Whether `repo` (GitHub's `owner/name`, or null when it names none) is the dataset's own
 * repository, compared without case as GitHub compares names (as `execute/pull-request.ts` judges
 * the release pull request's head).
 */
function isOwnRepo(repo: string | null, datasetId: string): boolean {
  return repo !== null && repo.toLowerCase() === `${DATASETS_ORG}/${datasetId}`.toLowerCase();
}

/**
 * Step 7 for a merge over a failed BIDS validation: GitHub's state, asked again while it is
 * `unknown`, must be `unstable`, which is a check that is not required failing. `blocked` is a rule
 * that requires the check, where merging would be a bypass, which a re-pull never uses; `clean` is
 * no failing check, so the override is not needed; every other state is refused as the ordinary
 * gate refuses it. Null when the merge may go on to the claim.
 */
async function unstableOnly(
  ctx: GateContext,
  prNumber: number,
  head: string,
  seen: string,
): Promise<GateRefusal | null> {
  const read = await settleMergeState(
    ctx.token,
    ctx.datasetId,
    prNumber,
    { headSha: head, mergeableState: seen },
    { base: ctx.base, ...(ctx.sleep ? { sleep: ctx.sleep } : {}) },
  );
  if (!read.ok) {
    if (read.kind === "unreadable") {
      return stopAt(
        "github",
        `Pull request #${prNumber} could not be read: ${read.reason} Nothing was claimed or merged.`,
      );
    }
    return stopAt(
      "not-ready",
      read.kind === "moved"
        ? `Pull request #${prNumber} changed since it was read; run the merge again. Nothing was claimed or merged.`
        : `Pull request #${prNumber} is no longer open; nothing was claimed or merged.`,
    );
  }
  if (read.state === "unstable") return null;
  if (read.state === "blocked") {
    return stopAt(
      "bids",
      "GitHub reports the pull request blocked: this dataset's rules require BIDS validation, and merging would be a bypass, which a re-pull never uses. Nothing was claimed or merged.",
    );
  }
  if (read.state === "clean") {
    return stopAt(
      "bids",
      "GitHub reports the pull request clean, so no check fails: merge it without --bids-failure-reason. Nothing was claimed or merged.",
    );
  }
  const check = mergeCheckOf(read.state);
  return stopAt(
    "github",
    `${check.ok ? "GitHub's state is not unstable." : check.why} Nothing was claimed or merged.`,
  );
}

function errorText(err: unknown): string {
  return err instanceof ApiError
    ? `HTTP ${err.statusCode}`
    : err instanceof Error
      ? err.message
      : String(err);
}

/** The words of the merge's confirmation: one irreversible DOI. */
export function doiLine(row: RepullRow, pr: RepullPullRequest = "n0"): string {
  return `This merge mints one irreversible version DOI, v${row[PULL_REQUEST_COLUMNS[pr].version]}, and takes one unit of today's re-pull merge cap.`;
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
  const { row, prNumber } = check;
  const review = await reviewGate(ctx.datasetId, prNumber, check.head);
  if ("ok" in review) return { merged: false, stage: review.stage, reason: review.reason };
  if (review.kind === "needs_force" && !ctx.force) {
    return { merged: false, stage: "review", reason: review.reason };
  }
  if (opts.confirm) {
    const lines = [doiLine(row, check.pr), ...check.warnings];
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
  // One run on a record at a time: the merge holds the lock `resume` and `execute` take, from the
  // claim to the record of the merge, so no resume expires the claim or moves the head while the
  // merge is out.
  const paths = workPaths(ctx.configDir, ctx.datasetId, row.plan_digest);
  privateDir(dirname(paths.lock), join(ctx.configDir, "repull"));
  let unlock: () => void;
  try {
    unlock = acquireLock(paths.lock);
  } catch (err) {
    if (!(err instanceof ExecuteRefused)) throw err;
    return {
      merged: false,
      stage: "not-ready",
      reason: `${err.message} A resume or an execution of re-pull #${row.id} runs now; nothing was claimed or merged.`,
    };
  }
  try {
    return await sendUnderLock(ctx, check, opts);
  } finally {
    unlock();
  }
}

/**
 * The claim's refusal words. No usable answer (no answer at all, which the API client reports as
 * status 0, or a 5xx a gateway may send after the Worker wrote) may have left a claim, so it says
 * so and counts as held; a 4xx is the Worker's refusal, which writes nothing.
 */
function claimRefused(err: unknown, datasetId: string): Extract<MergeOutcome, { merged: false }> {
  const code = repullErrorCode(err);
  if (!(err instanceof ApiError) || err.statusCode === 0 || err.statusCode >= 500) {
    return {
      merged: false,
      stage: "github",
      claimHeld: true,
      reason: `The claim to merge got no usable answer (${errorText(err)}), so a claim may be held. Nothing was merged. nemar admin repull resume ${datasetId} reads the record, and expires a claim nothing merged under once it is 30 minutes old.`,
    };
  }
  const reason = `The claim to merge was refused (${code ?? errorText(err)}): ${err.message} Nothing was merged.`;
  if (code === "merge-cap" || code === "merge-cap-unreadable") {
    return { merged: false, stage: "cap", reason };
  }
  if (code === "screen-not-clear" || code === "screen-changed") {
    return { merged: false, stage: "screen", reason };
  }
  if (code?.startsWith("bids-override-")) return { merged: false, stage: "bids", reason };
  return { merged: false, stage: "not-ready", reason };
}

/** A held claim that may not be used now: it stays held, and nothing was sent. */
function heldClaimRefused(
  err: unknown,
  datasetId: string,
): Extract<MergeOutcome, { merged: false }> {
  const code = repullErrorCode(err);
  const why = err instanceof Error ? err.message : String(err);
  const stage: MergeStage =
    code === "screen-not-clear"
      ? "screen"
      : !(err instanceof ApiError) ||
          err.statusCode === 0 ||
          err.statusCode >= 500 ||
          code === "github-unreadable"
        ? "github"
        : "not-ready";
  return {
    merged: false,
    stage,
    claimHeld: true,
    reason: `The claim to merge already held was not used (${code ?? errorText(err)}): ${why} Nothing was merged. nemar admin repull resume ${datasetId} reads GitHub, records a merge that happened, and expires the claim once it is 30 minutes old.`,
  };
}

/** Why a merge the gate sent did not happen, in the gate's own words (no approval is involved). */
function notMergedWhy(merged: Extract<MergeResult, { ok: false }>): string {
  if (merged.outcome === "refused") return `GitHub refused the merge: ${merged.reason}`;
  if (merged.merge) return merged.merge.why;
  return merged.status === 409
    ? "The pull request changed after the gate read it (its head moved, or it was closed), so the merge was not sent."
    : `GitHub could not be read at the last look before the merge (${merged.status === 0 ? "no answer" : `HTTP ${merged.status}`}), so the merge was not sent.`;
}

async function sendUnderLock(
  ctx: GateContext,
  check: RepullMergeCheck,
  opts: { out: (line: string) => void; tries?: number },
): Promise<MergeOutcome> {
  const { row, prNumber, head, pr } = check;
  const c = PULL_REQUEST_COLUMNS[pr];
  const reason = ctx.bidsFailureReason;
  if (reason !== undefined && check.heldClaim) {
    // The reason is recorded with the claim it is made for, so a merge over a failed BIDS
    // validation makes its own claim and never sends under one made without it.
    return {
      merged: false,
      stage: "bids",
      claimHeld: true,
      reason: `A claim to merge ${head.slice(0, 12)} is already held, and a merge over a failed BIDS validation is sent only under a claim of its own, which records its reason. Nothing was merged. nemar admin repull resume ${ctx.datasetId} records a merge that happened, or expires the claim once it is 30 minutes old; then run this again.`,
    };
  }
  if (!check.heldClaim) {
    try {
      await transitionRepull(row.id, {
        from: c.gatesClear,
        to: c.gatesClear,
        fields: { [c.claimSha]: head },
        ...(reason !== undefined ? { override: { kind: "bids-failure" as const, reason } } : {}),
      });
    } catch (err) {
      return claimRefused(err, ctx.datasetId);
    }
    opts.out(`Claimed one unit of today's re-pull merge cap for ${head.slice(0, 12)}.`);
    if (reason !== undefined) {
      opts.out("Recorded with the claim: the merge is over a failed BIDS validation, and why.");
    }
  } else {
    // The claim was made earlier: the Worker reads again what its statement held then (the
    // dataset fences, the screen for THIS administrator, the live head) and the claim's age.
    try {
      await checkRepullMergeClaim(row.id, { pr, sha: head });
    } catch (err) {
      return heldClaimRefused(err, ctx.datasetId);
    }
    opts.out(
      `A claim to merge ${head.slice(0, 12)} is already held; the merge is sent again under it.`,
    );
  }

  const merged = await mergeWhenClean(ctx.token, ctx.datasetId, prNumber, head, "squash", {
    base: ctx.base,
    commit: check.squash,
    // Over a failed BIDS validation the merge is sent only while GitHub still says `unstable`.
    ...(reason !== undefined ? { state: "unstable" as const } : {}),
    ...(ctx.sleep ? { sleep: ctx.sleep } : {}),
    ...(opts.tries !== undefined ? { tries: opts.tries } : {}),
  });
  if (merged.ok) {
    try {
      const recorded = await recordRepullMerged(row.id, pr);
      return {
        merged: true,
        row: recorded.repull,
        mergeSha: recorded.repull[c.mergeSha],
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
  // GitHub did not merge it. The claim stays: it is seconds old, younger than the Worker lets any
  // caller release, and a merge sent again under it uses no second unit.
  return {
    merged: false,
    stage: "github",
    outcome: merged.outcome,
    claimHeld: true,
    reason: `${notMergedWhy(merged)} The claim to merge is kept: run nemar admin repull merge ${ctx.datasetId} again within 25 minutes of the claim to send the merge under it, once GitHub reports the pull request clean at the same head; if the head moved, nemar admin repull resume ${ctx.datasetId} expires the claim once it is 30 minutes old and then records the new head.`,
  };
}
