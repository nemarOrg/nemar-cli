/**
 * Triage sweep for import-failure tracking issues (epic #1306, issue #1310).
 *
 * Walks the open PER-DATASET `import-failure` issues on `nemarDatasets/.github`,
 * verifies each one's dataset against S3, and closes the recovered ones /
 * relabels the ones whose cause has changed. Dry run by default.
 *
 * Per-cause ROLLUP issues are not verified row-by-row -- they are filtered out
 * before the loop, because a rollup covers many datasets and no single verdict
 * applies to it. They get the other half of the lifecycle instead: this sweep is
 * what CLOSES a rollup, once the backlog has drained enough that
 * `decideIssueMode` releases. That close is what gives the hysteresis a writer;
 * see the note on `decideIssueMode`.
 *
 * ## Why a sweep, and not a hook on the success callback
 *
 * `POST /webhooks/import-state` has no post-success action at all today -- its
 * only side-effect block is gated on `status === "failed"`. A `complete` hook
 * would be the responsive option, but it would only ever catch recoveries that
 * pass through that webhook. A manual `nemar admin recover`, an operator's
 * forced verify, and every one of the issues that accumulated before this existed
 * (ADR 0050 records the count and the date) would all be missed. One sweep covers
 * all of them through one tested path, and keeps GitHub I/O off a webhook route
 * that already carries two `waitUntil` calls. The cost is up to a day's latency
 * before a healed issue closes, which does not matter for a tracker.
 *
 * ## Fail-open on the row, never on the verdict
 *
 * Mirrors `zarr-fidelity-sweep`: a transient S3, D1 or GitHub error aborts THAT
 * issue only. It lands in `errors` and is still a candidate next run. The
 * failure mode this protects against is closing an issue for a dataset that is
 * actually still broken, which would discard a live problem silently -- so every
 * uncertainty resolves to "keep".
 *
 * A DECIDING failure (D1, S3) leaves the issue byte-for-byte as it was, because
 * nothing has been written yet. An ACTING failure cannot promise that, and this
 * module does not pretend otherwise -- see the ordering note on
 * {@link applyOneIssue}.
 *
 * ## The counts describe what happened, not what was planned
 *
 * `closed` / `relabelled` / `kept` are incremented only after the state change
 * has landed, so a run whose writes all 403'd reports `closed: 0` with the rows
 * in `errors`. An earlier draft counted from the plan and reported `closed: 15,
 * errors: 15` for a run that closed nothing -- and `importIssueSweepLogLines`
 * printed `CLOSE #105` for each. `errors[].stage` says which half broke, and a
 * plan entry that did not land is marked `failed`.
 *
 * ## Bounds, and why the window rotates
 *
 * `verifyDatasetVersionS3` does one fully-paginated `listObjectSizes` walk per
 * dataset, i.e. O(pages) Worker subrequests. The existing `data-integrity-sweep`
 * bounds itself to 15 per request (max 30) for exactly that reason and this uses
 * the same numbers.
 *
 * A bounded window over a fresh listing does NOT drain a backlog on its own,
 * which an earlier draft of this comment claimed: only a CLOSE removes an issue
 * from the candidate set, so `slice(0, limit)` re-examines the same head every
 * run and a permanently-broken head starves the rest forever. `windowStart`
 * rotates the window by the calendar day instead -- see its note for what that
 * does and does not guarantee.
 *
 * ## The counts on a dry run are "would" counts
 *
 * `closed` / `relabelled` / `kept` are incremented from the plan when nothing is
 * being written, because on a dry run the plan IS the answer. `applied` is what
 * distinguishes the two readings, and the CLI renames the fields accordingly.
 * `attempted` is zero on a dry run by definition.
 */

import { auditLogStatement } from "../db/audit-log.js";
import type { Bindings } from "../types/bindings.js";
import { isNonProductionEnv } from "./environment.js";
import { getDatasetsToken } from "./github-auth.js";
import {
  type GitHubIssue,
  addIssueComment,
  closeIssue,
  issueLabelNames,
  listOpenIssuesByLabel,
  setIssueLabels,
} from "./github.js";
import { classifyImportFailure } from "./import-failure-cause.js";
import { type DatasetVersionIntegrityResult, verifyDatasetVersionS3 } from "./import-integrity.js";
import {
  IMPORT_ROLLUP_ISSUE_LABEL,
  type ImportIssueAction,
  type ImportIssueMode,
  type IssueVerifyState,
  buildRecoveryCloseComment,
  buildRelabelComment,
  buildRollupReleaseComment,
  decideIssueAction,
  decideIssueMode,
} from "./import-issue-accrual.js";
import {
  IMPORT_FAILURE_ISSUES_REPO,
  IMPORT_FAILURE_ISSUE_LABEL,
  parseImportFailureIssueTitle,
} from "./import-issue-identity.js";

export const IMPORT_ISSUE_SWEEP_DEFAULT_LIMIT = 15;
export const IMPORT_ISSUE_SWEEP_MAX_LIMIT = 30;

export interface ImportIssueSweepPlanEntry {
  issueNumber: number;
  datasetId: string | null;
  title: string;
  kind: ImportIssueAction["kind"];
  reason: string;
  labels?: string[];
  /** The verdict this entry was decided from, carried so the comment written on
   *  apply quotes the REAL numbers rather than restating the summary line. */
  verify?: IssueVerifyState;
  /** The classified cause's one-line explanation, for the relabel comment. */
  causeSummary?: string;
  /** Set when this entry's action was attempted and did NOT land. The counts
   *  exclude it, and the log line reads `FAILED CLOSE` rather than `CLOSE`. */
  failed?: boolean;
}

export interface ImportIssueSweepError {
  issue: number;
  dataset_id: string | null;
  /**
   * Which half broke, because the three are operationally different:
   *
   * - `plan`  -- deciding failed (D1 or S3). Nothing was written; the issue is
   *   byte-for-byte as it was.
   * - `apply` -- the state change itself failed. The issue is unchanged, and it
   *   is not counted as closed or relabelled.
   * - `comment` -- the state change LANDED and only its explanatory comment did
   *   not. The action IS counted, because it happened.
   */
  stage: "plan" | "apply" | "comment";
  error: string;
}

export interface ImportIssueSweepResult {
  /** False on a dry run: nothing was written to GitHub. */
  applied: boolean;
  /** Open per-dataset issues seen (excludes rollups). */
  openIssues: number;
  /**
   * Filing mode implied by that count, AGGREGATE across causes.
   *
   * Not quite "what a new failure would do": the filer asks the same question
   * per cause (`rollupOpen` there is *this cause's* rollup), so inside the
   * hysteresis band a cause with no rollup of its own still files per-dataset
   * while this reports `rollup`. Reported as the repo's pressure reading, which
   * is what an operator wants from a triage run.
   */
  mode: ImportIssueMode;
  /**
   * Open per-cause rollup issues seen this run, reported so they are visible
   * rather than invisible. Closed by this sweep once the mode releases.
   *
   * `outcome` carries what actually happened, for the same reason plan entries
   * carry `failed`: deriving the printed verb from `mode`/`applied` alone made a
   * release whose `close` 403'd still print `RELEASE`.
   */
  rollups: { number: number; title: string; outcome?: "released" | "failed" }[];
  /** Rollups closed because the mode released. On a dry run, would be closed. */
  rollupsReleased: number;
  examined: number;
  /**
   * WRITES tried: on an applied run, every non-keep entry plus every rollup
   * release. Zero on a dry run, which attempts nothing by definition.
   *
   * The denominator for "did everything we tried to change fail?". A `keep`
   * attempts nothing and so cannot fail, which is why it is excluded: counting
   * keeps is what let an all-writes-403 run answer 200. Decision failures are
   * excluded too -- they are counted per stage in `errors` and judged separately,
   * because folding them in here made every dry-run error a total failure.
   */
  attempted: number;
  closed: number;
  relabelled: number;
  kept: number;
  plan: ImportIssueSweepPlanEntry[];
  errors: ImportIssueSweepError[];
  /** Candidates outside this run's window. They are examined by a later run: the
   *  window rotates daily, so this is a deferral rather than an exclusion. */
  remaining: number;
}

/**
 * Injection seams for tests. Every real caller omits them.
 *
 * These replace TRANSPORT only -- the GitHub client calls and the S3 verify.
 * The decisions, the SQL and the content builders all run for real, so a test
 * exercises the same code production does (`.rules/testing.md`).
 */
export interface ImportIssueSweepDeps {
  listOpenIssues?: typeof listOpenIssuesByLabel;
  close?: typeof closeIssue;
  setLabels?: typeof setIssueLabels;
  comment?: typeof addIssueComment;
  verify?: (env: Bindings, datasetId: string) => Promise<DatasetVersionIntegrityResult>;
  token?: (env: Bindings) => Promise<string>;
}

/**
 * Where this run's window starts inside the candidate list.
 *
 * The window has to move, and there is nothing to move it. There is no cursor
 * this sweep could keep, and only a CLOSE removes a candidate, so a `keep` or a
 * `relabel` leaves the issue exactly where it was. Take the first `limit` every
 * run and a head of permanently-broken issues pins the window: the caller sorts
 * oldest-first, so with 29 open and a limit of 15 it is the 14 NEWEST that would
 * never be examined again -- and since a fresh failure files a new issue at the
 * tail, the newest are the ones most likely to still be actionable.
 *
 * Storing a cursor is the obvious fix and the wrong one here: ADR 0034 says
 * derive rather than store, and a cursor in D1 is a second source of truth that
 * drifts against a list this sweep does not own. The calendar day is already a
 * monotonic counter both callers share, and the cron runs daily, so the window
 * advances by `limit` per day: `start_{d+1} = (start_d + limit) mod count`, which
 * tiles the circle contiguously and reaches every candidate within
 * `ceil(count / limit)` days.
 *
 * **That bound assumes a stable `count`, and `count` is the modulus.** It is not
 * stable: closes shrink it and new failures grow it, so two runs on the same
 * calendar day over a changed backlog get DIFFERENT windows, and the deadline is
 * approximate rather than guaranteed. The property being bought is that no
 * candidate is permanently excluded, which is what a fixed prefix got wrong;
 * an exact schedule is not on offer without the cursor this deliberately avoids.
 */
export function windowStart(count: number, limit: number, now: Date): number {
  if (count <= limit) return 0;
  const daysSinceEpoch = Math.floor(now.getTime() / 86_400_000);
  return (daysSinceEpoch * limit) % count;
}

/** The `import_jobs` fields the sweep needs to judge one issue. */
interface ImportJobRow {
  source_id: string;
  stage: string;
  last_error: string | null;
}

export async function runImportIssueSweep(
  env: Bindings,
  opts: { limit?: number; apply?: boolean } = {},
  deps: ImportIssueSweepDeps = {},
): Promise<ImportIssueSweepResult> {
  const listOpenIssues = deps.listOpenIssues ?? listOpenIssuesByLabel;
  const close = deps.close ?? closeIssue;
  const setLabels = deps.setLabels ?? setIssueLabels;
  const comment = deps.comment ?? addIssueComment;
  const verify = deps.verify ?? verifyDatasetVersionS3;
  const token = deps.token ?? getDatasetsToken;

  const apply = opts.apply === true;
  const limit = Math.min(
    Math.max(opts.limit ?? IMPORT_ISSUE_SWEEP_DEFAULT_LIMIT, 1),
    IMPORT_ISSUE_SWEEP_MAX_LIMIT,
  );

  const pat = await token(env);

  // A listing failure is fatal to the whole run, not to one row: without it
  // there is nothing to iterate and no honest count to report.
  const open = await listOpenIssues(IMPORT_FAILURE_ISSUES_REPO, IMPORT_FAILURE_ISSUE_LABEL, pat);

  // Every one of these was fetched BY label, so a response in which not one of
  // them reports a label cannot be true of the real world -- it means the shape
  // changed, or a proxy stripped fields. `issueLabelNames` tolerating a missing
  // `labels` is right for a single hand-built fixture and wrong here: left
  // tolerated, this degrades the whole run into a clean-looking "nothing to do",
  // because every issue then reads as human-authored (no `import-failure` label)
  // and every rollup counts as a per-dataset issue, which shifts the mode too.
  if (open.length > 0 && open.every((i) => issueLabelNames(i).length === 0)) {
    throw new Error(
      `Listed ${open.length} ${IMPORT_FAILURE_ISSUE_LABEL} issue(s) on ${IMPORT_FAILURE_ISSUES_REPO} but none reported any labels; refusing to triage on a response that cannot be right`,
    );
  }

  // A rollup carries the tracking label too, so it would otherwise count itself
  // and latch the mode on forever.
  // Typed from the result rather than inferred, because the release loop below
  // stamps `outcome` onto these same objects.
  const rollups: ImportIssueSweepResult["rollups"] = open
    .filter((i) => issueLabelNames(i).includes(IMPORT_ROLLUP_ISSUE_LABEL))
    .map((i) => ({ number: i.number, title: i.title }));
  // Sorted by issue number, i.e. oldest first, so the candidate order is this
  // sweep's own and not GitHub's default `sort=created&direction=desc`. The
  // rotation below is only meaningful over a stable order.
  const perDataset = open
    .filter((i) => !issueLabelNames(i).includes(IMPORT_ROLLUP_ISSUE_LABEL))
    .sort((a, b) => a.number - b.number);

  const result: ImportIssueSweepResult = {
    applied: apply,
    openIssues: perDataset.length,
    mode: decideIssueMode({
      openPerDatasetCount: perDataset.length,
      rollupOpen: rollups.length > 0,
    }),
    rollups,
    rollupsReleased: 0,
    examined: 0,
    attempted: 0,
    closed: 0,
    relabelled: 0,
    kept: 0,
    plan: [],
    errors: [],
    remaining: Math.max(perDataset.length - limit, 0),
  };

  const start = windowStart(perDataset.length, limit, new Date());
  const rotated = [...perDataset.slice(start), ...perDataset.slice(0, start)];

  for (const issue of rotated.slice(0, limit)) {
    result.examined++;
    const datasetId = parseImportFailureIssueTitle(issue.title);
    let entry: ImportIssueSweepPlanEntry | null = null;
    try {
      entry = await planOneIssue(env, issue, datasetId, verify);
      result.plan.push(entry);

      if (apply && entry.kind !== "keep") {
        result.attempted++;
        const outcome = await applyOneIssue(issue, entry, { close, setLabels, comment }, pat);
        if (outcome.commentError) {
          result.errors.push({
            issue: issue.number,
            dataset_id: datasetId,
            stage: "comment",
            error: outcome.commentError,
          });
        }
      }

      // After the write, never before: see the counts note in the file header.
      if (entry.kind === "close") result.closed++;
      else if (entry.kind === "relabel") result.relabelled++;
      else result.kept++;
    } catch (err) {
      // Fail open on this row: the issue is unchanged and stays a candidate.
      //
      // A plan failure is deliberately NOT an attempt. `attempted` counts writes
      // tried, and adding decision failures to it made the ratio degenerate on a
      // dry run, where no write is ever tried: every error was a plan error and
      // every plan error also incremented `attempted`, so `failedAttempts ===
      // attempted` held identically and ONE transient S3 error turned a read-only
      // run into a 502 that discarded the other fourteen rows' plan.
      if (entry) entry.failed = true;
      result.errors.push({
        issue: issue.number,
        dataset_id: datasetId,
        stage: entry ? "apply" : "plan",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Release the valve. `mode` is `decideIssueMode`'s verdict for this listing, so
  // "per-dataset" with a rollup open means the backlog has drained to RESUME or
  // fewer and the rollup is no longer suppressing per-dataset filing. Closing it
  // is what gives `rollupOpen` a writer; without one the mode latches on for good
  // and the cap quietly becomes RESUME (see decideIssueMode's note).
  //
  // Counted after the write like every other action, and a failure is a row error
  // rather than fatal: the per-dataset work above already happened and must still
  // be reported.
  if (result.mode === "per-dataset") {
    // The count the release comment quotes is the POST-run one: this loop runs
    // after the per-dataset loop, which may itself have closed issues, so
    // `perDataset.length` alone would quote a number that was already stale by
    // the time the comment was written.
    const openAfterRun = perDataset.length - result.closed;
    for (const rollup of rollups) {
      result.rollupsReleased++;
      if (!apply) continue;
      result.attempted++;
      try {
        await close(IMPORT_FAILURE_ISSUES_REPO, rollup.number, pat);
        rollup.outcome = "released";
        console.log(
          `[import-issue-sweep] released rollup ${IMPORT_FAILURE_ISSUES_REPO}#${rollup.number}`,
        );
        const commented = await commentAfter(
          comment,
          rollup.number,
          buildRollupReleaseComment(openAfterRun, new Date().toISOString()),
          pat,
          "close",
        );
        if (commented.commentError) {
          result.errors.push({
            issue: rollup.number,
            dataset_id: null,
            stage: "comment",
            error: commented.commentError,
          });
        }
      } catch (err) {
        result.rollupsReleased--;
        rollup.outcome = "failed";
        result.errors.push({
          issue: rollup.number,
          dataset_id: null,
          stage: "apply",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  return result;
}

/** Decide what should happen to one issue. Throws on a transient failure, which
 *  the caller records as a row-level error rather than a verdict. */
async function planOneIssue(
  env: Bindings,
  issue: GitHubIssue,
  datasetId: string | null,
  verify: NonNullable<ImportIssueSweepDeps["verify"]>,
): Promise<ImportIssueSweepPlanEntry> {
  const base = { issueNumber: issue.number, datasetId, title: issue.title };

  // The title did not match `Import failure: on###### (ds######)`, so it cannot
  // be matched to a row: somebody's hand-written issue. Left alone, without
  // spending an S3 walk on it. This rests on the same invariant
  // `fileImportFailureIssueIfNeeded` already relies on -- the filer only ever
  // writes `on`/`ds` ids -- so an id outside those shapes would be skipped here
  // forever rather than triaged.
  if (!datasetId) {
    return { ...base, kind: "keep", reason: "title is not machine-generated" };
  }

  const job = await env.DB.prepare(
    "SELECT source_id, stage, last_error FROM import_jobs WHERE dataset_id = ?",
  )
    .bind(datasetId)
    .first<ImportJobRow>();
  if (!job) {
    // No row to judge against -- e.g. the `no-import-row` class in the triage
    // doc. Nothing to verify and nothing to reclassify.
    return { ...base, kind: "keep", reason: "no import_jobs row for this dataset" };
  }

  const integrity = await verify(env, datasetId);
  const classified = classifyImportFailure({ stage: job.stage, lastError: job.last_error });
  const verifyState: IssueVerifyState = {
    complete: integrity.complete,
    version: integrity.version,
    expectedCount: integrity.expectedCount,
    presentCount: integrity.presentCount,
  };

  const action = decideIssueAction({
    datasetId,
    sourceId: job.source_id,
    issueTitle: issue.title,
    currentLabels: issueLabelNames(issue),
    causeLabel: classified.label,
    verify: verifyState,
  });

  return {
    ...base,
    kind: action.kind,
    reason: action.reason,
    labels: action.labels,
    verify: verifyState,
    causeSummary: classified.summary,
  };
}

/**
 * Perform a planned action. Called only for `close` and `relabel`.
 *
 * ## The state change is the commit point, and it goes FIRST
 *
 * An earlier draft commented first, so that no issue was ever closed without the
 * record of why alongside it. That reads well and is wrong, because the two
 * writes are not a transaction: a comment that lands ahead of a close that 403s
 * leaves an OPEN issue carrying a bot comment reading "Recovered: closing
 * automatically" -- a permanent lie a human triaging it has to disbelieve. Worse,
 * the decision is recomputed from world state every run and the world state did
 * not change, so it re-comments daily. The realistic trigger is not a blip: an
 * expired or de-scoped PAT (the incident this epic came from), an archived
 * `.github` repo, or a sustained secondary rate limit all leave reads working
 * while writes 403, which is 15 issues x 30 days of comments asserting a state
 * change that never happened.
 *
 * Mutating first inverts every one of those properties, because both mutations
 * are idempotent AND self-healing:
 *
 *   - `closeIssue` on a closed issue is a no-op 200, and a closed issue is no
 *     longer in `listOpenIssuesByLabel`, so it leaves the candidate set and
 *     cannot be re-commented.
 *   - after a successful relabel, `computeLabelUpdate` returns null, so the row
 *     decides `keep` next run and attempts nothing.
 *
 * So the worst case flips from "a permanent false claim, repeated daily" to "a
 * correct state change whose explanation is missing, once" -- which is reported
 * as a `comment`-stage error and logged with the issue number.
 */
async function applyOneIssue(
  issue: GitHubIssue,
  entry: ImportIssueSweepPlanEntry,
  io: {
    close: typeof closeIssue;
    setLabels: typeof setIssueLabels;
    comment: typeof addIssueComment;
  },
  pat: string,
): Promise<{ commentError?: string }> {
  const nowIso = new Date().toISOString();

  if (entry.kind === "close") {
    // entry.verify is always set on a close: decideIssueAction cannot return
    // "close" without a verdict to base it on.
    if (!entry.verify) throw new Error(`close planned for #${issue.number} with no verdict`);
    await io.close(IMPORT_FAILURE_ISSUES_REPO, issue.number, pat);
    console.log(`[import-issue-sweep] closed ${IMPORT_FAILURE_ISSUES_REPO}#${issue.number}`);
    return commentAfter(
      io.comment,
      issue.number,
      buildRecoveryCloseComment(entry.verify, nowIso),
      pat,
      "close",
    );
  }

  // Symmetrical with the close branch's guard rather than a silent `if
  // (entry.labels)`: unreachable today, but a decision that ever returned
  // "relabel" without labels would otherwise be a clean-looking no-op that
  // still counted as relabelled.
  if (!entry.labels) throw new Error(`relabel planned for #${issue.number} with no label set`);
  await io.setLabels(IMPORT_FAILURE_ISSUES_REPO, issue.number, entry.labels, pat);
  console.log(
    `[import-issue-sweep] relabelled ${IMPORT_FAILURE_ISSUES_REPO}#${issue.number} -> ${entry.labels.join(",")}`,
  );
  return commentAfter(
    io.comment,
    issue.number,
    buildRelabelComment(
      { kind: "relabel", reason: entry.reason },
      entry.causeSummary ?? "",
      nowIso,
    ),
    pat,
    "relabel",
  );
}

/** Write the explanation for a state change that already landed. Reported, never
 *  thrown: throwing would un-count an action that really happened. */
async function commentAfter(
  comment: typeof addIssueComment,
  issueNumber: number,
  body: string,
  pat: string,
  what: "close" | "relabel",
): Promise<{ commentError?: string }> {
  try {
    await comment(IMPORT_FAILURE_ISSUES_REPO, issueNumber, body, pat);
    return {};
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      `[import-issue-sweep] ${what} landed on ${IMPORT_FAILURE_ISSUES_REPO}#${issueNumber} but its comment did not: ${msg}`,
    );
    return { commentError: `${what} landed; explanatory comment failed: ${msg}` };
  }
}

/**
 * The cron's entry point: apply the changes, and refuse outside production.
 *
 * Split from {@link runImportIssueSweep} the same way `runRecordingStatsSweepCron`
 * is (issue #1166, Option 2). The raw sweep stays unguarded so the admin route
 * can dry-run it on staging; this wrapper carries both the `apply` and the
 * environment guard, so a dev worker cannot close or relabel real issues on the
 * shared nemarDatasets org even if the caller's own guard were wrong. The route
 * carries its own `apply` guard too -- two independent fences, because the repo is
 * shared with production rather than environment-scoped.
 *
 * `deps` is threaded through so a test can assert the guard in BOTH directions:
 * without it the production half is unreachable, and a guard whose polarity is
 * inverted or whose environment list is narrowed silently returns the tracker to
 * accumulate-only, which is the exact regression this epic exists to fix.
 */
export async function runImportIssueSweepCron(
  env: Bindings,
  deps: ImportIssueSweepDeps = {},
): Promise<ImportIssueSweepResult | null> {
  if (isNonProductionEnv(env)) {
    console.log("[import-issue-sweep] skipped (non-production)");
    return null;
  }
  const result = await runImportIssueSweep(env, { apply: true }, deps);
  await recordCronActivity(env, result);
  return result;
}

/**
 * Persist what the CRON did, which nothing used to record.
 *
 * The admin route has always written an `import_issue_triage` audit row, but a cron
 * run has no acting user, so the daily path wrote nothing: the only trace of an
 * automated close was a Worker log line with finite retention. That made "how many
 * issues recovered this week" unanswerable from D1 -- which phase 4's weekly report
 * needs, and which is also just a gap in the durable record of a job that closes
 * real issues.
 *
 * **Written on EVERY run, including one that changed nothing.** Gating it on change
 * looks tidier and destroys the signal: a week in which the cron ran seven times with
 * nothing to close would produce zero rows, which is exactly what a cron that never
 * ran produces. The weekly report (#1312) cannot then tell a quiet week from a dead
 * job -- the discrimination this epic exists to provide, absent from the one place
 * that shows the daily jobs are alive. A row a day is 365 rows a year, which is
 * nothing next to being able to prove liveness.
 *
 * `userId: null` marks it system-initiated, the same convention `import-retry.ts`
 * uses. Best-effort: this is bookkeeping about work that already happened, so a
 * failed write must not turn a successful sweep into an error.
 */
async function recordCronActivity(env: Bindings, result: ImportIssueSweepResult): Promise<void> {
  try {
    await auditLogStatement(env.DB, {
      userId: null,
      action: "import_issue_triage",
      resourceType: "issue",
      resourceId: result.plan
        .filter((e) => e.kind !== "keep" && !e.failed)
        .map((e) => e.datasetId ?? `#${e.issueNumber}`)
        .join(","),
      details: JSON.stringify({
        source: "cron",
        closed: result.closed,
        relabelled: result.relabelled,
        kept: result.kept,
        rollups_released: result.rollupsReleased,
        errors: result.errors.length,
      }),
    }).run();
  } catch (err) {
    console.error("[import-issue-sweep] audit row failed after applying:", err);
  }
}

/**
 * One-line-per-issue summary for the CLI and the cron log.
 *
 * The verb comes from what happened to THIS entry, not from `result.applied`: an
 * applied run whose close 403'd prints `FAILED CLOSE`, because printing `CLOSE`
 * for it asserted an action that did not happen. Open rollups are listed after
 * the plan, since nothing else in the output mentions them.
 */
export function importIssueSweepLogLines(result: ImportIssueSweepResult): string[] {
  const lines = result.plan.map((e) => {
    const verb = e.failed ? "FAILED " : result.applied ? "" : "WOULD ";
    const action =
      e.kind === "close" ? `${verb}CLOSE` : e.kind === "relabel" ? `${verb}RELABEL` : "KEEP";
    return `${action.padEnd(15)} #${e.issueNumber} ${e.datasetId ?? "(unknown)"}  ${e.reason}`;
  });
  for (const r of result.rollups) {
    // From the rollup's own outcome where there is one, exactly as the plan
    // entries' verb comes from `failed` rather than from `result.applied`.
    const verb =
      r.outcome === "failed"
        ? "FAILED RELEASE"
        : r.outcome === "released"
          ? "RELEASE"
          : result.mode === "per-dataset"
            ? "WOULD RELEASE"
            : "ROLLUP";
    lines.push(`${verb.padEnd(15)} #${r.number} ${r.title}`);
  }
  return lines;
}
