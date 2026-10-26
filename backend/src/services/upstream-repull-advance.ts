/**
 * The automatic re-pull's advance tick (epic #1046 phase 7, #1913; ADR 0111, decisions 6 and 7):
 * every 30 minutes, in production only, take each open automatic re-pull one step on, or say why it
 * waits where it is.
 *
 * WHAT IT DOES, for each row it examines:
 *  - a row that stalled before its pull request opened (`planned` to `registered`): dispatch the
 *    central workflow again to resume it, under the conditions below;
 *  - a row at `pr_open`: read the machine-clean facts of its head at the gates
 *    (`gatherMachineCleanFacts`) and ask the rule (`machineClean`). Clean: write
 *    `pr_open -> gates_clear` with `gates_sha` the head, as the system user, through the record's
 *    own transition, which reads the screen bound to the row, the dataset fences and GitHub's live
 *    head again and re-asserts the screen's verdict in the statement that writes. Not clean: start
 *    what the gates are waiting for (below), then record the first rule that does not hold as the
 *    row's hold. Only a clean verdict writes `gates_clear`: an unknown fact, a `not-clean`
 *    mergeable state and every other word hold, and a clean row whose edge the transition refuses
 *    holds `gates-refused`. A row cleared on one tick is merged on a later one, from its own facts;
 *  - a row at `gates_clear` that holds no claim to merge: the Worker's merge (`workerMergeRepull`,
 *    `upstream-repull-merge.ts`), which reads both switches, the bound on its merges, the
 *    machine-clean facts at the merge stage and the day's merge cap itself, and says why it did not
 *    merge as the row's hold. One that holds a claim is resolved from GitHub
 *    (`reconcileWorkerClaim`): a merge GitHub made is recorded, a merge whose answer was lost is
 *    sent again only under the same claim and only while that claim is young, and a claim whose
 *    merge GitHub refused, or under which nothing was sent, is released;
 *  - a row at `merged` or `released`: the central workflow's finish run (`finishAfterMerge`), which
 *    records the release, the lineage and the lock and completes the record, dispatched once the
 *    merge's version DOI is recorded, at most three times, and then held `finish-exhausted`;
 *  - a row a live dispatch is working on (its run is still out, settling its head): nothing is read
 *    from GitHub, and no hold is recorded for it, because nothing holds it but its own run; a hold
 *    it had is cleared, which is a write, with its audit row.
 *
 * RESUMING A STALLED ROW. Its run ended without opening the pull request: no dispatch of the
 * dataset is live, and the row's last dispatch `failed`, went `unreported` or was refused by
 * GitHub before it ran (`dispatch_failed`), or it has none, so nothing is working on it. Then, in
 * order:
 *  - the record and the dataset must pass the machine-clean rule's own rules for them (an
 *    automatic record with no correction, of a named, not withdrawn, mirror with no import that has
 *    not settled), read by the rule's own reader; a row that fails one holds with its word;
 *  - a last run that `refused` holds `resume-refused`: it said in a fixed word why it would not go
 *    on, and another run would meet the same refusal, so an administrator looks;
 *  - fewer than {@link AUTOMATIC_OPEN_DISPATCHES_MAX} `open` dispatches for the row, or it holds
 *    `resume-exhausted`. The one that created the row counts, so a row is resumed twice at most;
 *    a run that failed or never reported counts, and so does a send GitHub refused for its payload
 *    or its target (404, 422); a send GitHub turned away for the Worker's credential, permission
 *    or rate (any other 4xx, `dispatch-deferred`) does not, since nothing about the row was tried;
 *  - neither the row nor its latest dispatch (its report, or its send) has moved for
 *    {@link RESUME_QUIET_MINUTES} minutes, and the UTC hour is within
 *    {@link RESUME_WINDOW_UTC}, so the run opens its pull request on the UTC day whose unit of the
 *    open cap it claims (the timing the dispatch record's open cap relies on); otherwise it waits;
 *  - the dispatch record's own claim (`claimOpenDispatch`, naming the row), which counts against
 *    `REPULL_DAILY_OPEN_CAP` in the statement that claims, so a resume can never pass the cap; a
 *    full day holds `cap-exhausted`, a cap set to something unreadable holds `cap-unreadable` (and
 *    is an error), and no later row of the tick claims;
 *  - the send, as the scheduler sends a first dispatch: GitHub's 4xx ends the claim as
 *    `dispatch_failed` (its unit freed, its code `dispatch-refused` or `dispatch-deferred`) and
 *    stops the tick's sends, and a lost answer keeps the dispatch and its unit.
 * The run continues the row the dispatch names; the automatic create returns that row to it and
 * never a second one.
 *
 * WHAT THE GATES WAIT FOR, and when the tick starts it. Only once every rule before the screen holds
 * (the switches, the record, the dataset, the recorded pull request opened by the App at the
 * recorded head, `main` unmoved, and both checks green), so neither a screen run nor a model call is
 * spent on a pull request the Worker would not take on anyway:
 *  - the identifier screen of the head (`startRepullScreen`, `ref` the head, `request_id` 0), when
 *    the head has no verdict (no screen, a screen that errored, or one that never reported), at most
 *    {@link AUTOMATIC_SCREENS_MAX} times for one head, counted from the screen's own audit rows, so a
 *    workflow that always fails is not run again on every tick; past that an administrator can
 *    dispatch it again by hand. A verdict that asks for a person is not run again here: it never
 *    passes machine clean, and the same commit would be asked the same question;
 *  - the ADR 0107 review of the head (`startRepullPullRequestReview`, the one start that admits the
 *    App's pull request), when the head has none, or its dispatch failed (GitHub never ran it) at
 *    least {@link REVIEW_RETRY_MINUTES} minutes ago, and only once the screen of the head is
 *    `clear`, so on a later tick than the screen: a screen still out may yet block or ask for a
 *    person, and one that errored, blocks or asks for a person means this head is not machine clean
 *    now, so a review would be a model call spent on a head that may never pass. When the review's
 *    own start declines (the review switched off, a dataset it may not read, GitHub unreadable,
 *    another author or head), its reason is counted and logged, so a row held `review-absent` says
 *    why.
 *
 * HOLDS. A hold is an observation, never a transition: a fixed word (`REPULL_HOLD_REASONS`) and
 * since when, on the row (`hold_reason`, `hold_since`). Writing one does not move the row, does not
 * bump its `revision` and does not touch `updated_at`, so the record's own compare-and-set and the
 * times other slices read are left as they were. It is written only when the word changes, with
 * one audit row (`repull_hold`) per change, so a row that waits for the same reason tick after tick
 * keeps the time it began and writes nothing more (clearing a hold is a change too, with its audit
 * row); and only to the row as the tick read it (its
 * `revision`), so a row that moved while the tick looked at it is not overwritten with a reason
 * about what it was. An edge into another status clears the hold (`prepareTransition`); a self-edge
 * keeps it until the next tick reads the row again.
 *
 * WHICH ROWS. Only automatic rows (`origin = 'automatic'`) are read: an administrator's row is
 * never read, held or advanced here, because the Worker never takes an administrator's re-pull on
 * (decision 7). At most {@link ADVANCE_ROWS_PER_TICK} rows of each kind a tick, in three rotations
 * by id ({@link advanceSelection}): the rows at `pr_open` and the rows past their gates each turn
 * every half hour, and the stalled rows are read only inside the resume window and turn once per
 * half hour of it, so every stalled row is read inside the window whatever the number of rows of
 * any kind. A row that waits on an administrator for days never keeps a newer row from being read:
 * most automatic pull requests will wait for one, because most mirrors' screens ask for an
 * acknowledgment (ADR 0111, Consequences). A row is taken on by the kind the list read it in: one
 * that reached another kind between the list and its own read is left for the next tick.
 *
 * PRODUCTION ONLY. Outside `ENVIRONMENT` exactly `production` the tick returns null before it reads
 * or writes anything: the `nemarDatasets` organization is shared with dev. It is called only from
 * the 30-minute tick's production block, absent from `DEV_CRON_ALLOWLIST`. In production with
 * `AUTO_REPULL_ENABLED` not exactly `"1"`, GitHub is asked nothing, nothing is claimed or sent,
 * and every row it examines is held `switch-off`, a row a run is still out for included, but for the
 * rows a merge minted a DOI for, or may have: a row that holds a claim to merge, whose merge GitHub
 * is asked about, and a row that merged, whose finish run is dispatched, whatever the switches say,
 * so turning them off never strands a minted DOI's lineage, lock and `complete`; nothing is merged
 * while they are off. With the open switch on and `AUTO_REPULL_MERGE_ENABLED` not exactly `"1"`, a
 * row at `gates_clear` with no claim is held `merge-switch-off`, and nothing is read for it. Each
 * production tick that could list its rows stamps `upstream_repull_scheduler.last_advance_at`.
 *
 * COST on the 30-minute tick, which shares one subrequest allowance with every job on it, measured
 * over five rows at `pr_open` (`upstream-repull-advance.test.ts` pins it): 67 D1 statements and 25
 * GitHub requests when each starts its screen, 37 and 20 while each waits, 82 and 35 when each
 * starts its review (the most), 52 and 25 when each is cleared; a stalled row's resume is eight
 * statements and one dispatch, and the tick itself two statements (the list of rows, the stamp).
 * Past the gates (`upstream-repull-worker-merge.test.ts` pins it), a row that waits at the merge is
 * seven statements and four requests, one merged sixteen and seven, and a finish dispatched eight
 * and one, so five merges on one tick are 82 and 35. Plus one request to mint the App's
 * installation token on a cold isolate, when the App's credential is configured: the suites use a
 * personal token, so the figures leave it out.
 *
 * NO MAIL. Nothing here imports a mail service (`repull-no-mail-scan.test.ts`).
 */

import pkg from "../../../package.json" with { type: "json" };
import { normalizeUpstreamTag } from "../../../shared/openneuro-tag.js";
import {
  MACHINE_CLEAN_HOLDS,
  type MachineCleanFacts,
  type ScreenFact,
  machineClean,
} from "../../../shared/repull-machine-clean.js";
import {
  type DispatchStatus,
  type HoldReason,
  NEMAR_VERSION_RE,
  type RepullRow,
  type RepullStatus,
} from "../../../shared/repull-state.js";
import { AUDIT_IF_PREVIOUS_CHANGED_SQL, auditLogParams } from "../db/audit-log.js";
import { SYSTEM_USER_ID } from "../lib/constants.js";
import type { Bindings } from "../types/bindings.js";
import { getDatasetsToken } from "./github-auth.js";
import {
  UPSTREAM_REPULL_DISPATCH_TIMEOUT_MS,
  buildUpstreamRepullPayload,
  errorClassName,
  triggerUpstreamRepullRun,
} from "./github/dispatch.js";
import { startRepullPullRequestReview } from "./pr-review-start.js";
import { autoRepullEnabled, isExactProduction } from "./repull-switches.js";
import {
  REFUSED_FOR_THE_DISPATCH,
  claimOpenDispatch,
  markDispatchSendFailed,
} from "./upstream-repull-dispatch.js";
import { gatherMachineCleanFacts } from "./upstream-repull-facts.js";
import {
  type WorkerMergeOutcome,
  finishAfterMerge,
  reconcileWorkerClaim,
  workerMergeRepull,
} from "./upstream-repull-merge.js";
import { startRepullScreen } from "./upstream-repull-screen.js";
import { commitTransition, getRepull, isRefusal, prepareTransition } from "./upstream-repull.js";

/** Rows of each kind (at `pr_open`, stalled before it) one tick examines at most. */
export const ADVANCE_ROWS_PER_TICK = 5;

/** The tick's cadence, which turns its time into a place in the rotation. */
export const ADVANCE_TICK_MINUTES = 30;

/** The statuses before the pull request opened: a row the tick finds stalled there is resumed. */
export const RESUMABLE_STATUSES = [
  "planned",
  "prepared",
  "copied",
  "registered",
] as const satisfies readonly RepullStatus[];

/**
 * The statuses past the gates: a row at `gates_clear` is merged by the Worker when it is machine
 * clean, and one at `merged` or `released` is walked to `complete` by the finish run
 * (`upstream-repull-merge.ts`).
 */
export const PAST_GATES_STATUSES = [
  "gates_clear",
  "merged",
  "released",
] as const satisfies readonly RepullStatus[];

/** The statuses the tick examines. */
export const ADVANCE_STATUSES = [
  ...RESUMABLE_STATUSES,
  "pr_open",
  ...PAST_GATES_STATUSES,
] as const satisfies readonly RepullStatus[];

/** Which of the tick's rotations a status is in, or null for one the tick does not examine. */
export type AdvanceKind = "open" | "stalled" | "past-gates";

export function advanceKindOf(status: string): AdvanceKind | null {
  if (status === "pr_open") return "open";
  if ((RESUMABLE_STATUSES as readonly string[]).includes(status)) return "stalled";
  if ((PAST_GATES_STATUSES as readonly string[]).includes(status)) return "past-gates";
  return null;
}

/**
 * The `open` dispatches one row may have, at most. The first, which created the row, is one of
 * them, so a row is resumed twice at most. A dispatch counts when its run ran (it failed, refused
 * or never reported) or when GitHub refused the send for its payload or its target (404, 422), so a
 * refusal that repeats cannot dispatch for ever; one GitHub turned away for the Worker's credential,
 * permission or rate (`dispatch-deferred`) does not count. The bound relies on the creating
 * dispatch being linked to the row, which the automatic create does in the batch that inserts the
 * row and which rolls back without it, so an automatic row is never without it.
 */
export const AUTOMATIC_OPEN_DISPATCHES_MAX = 3;

/**
 * The UTC hours a resume is dispatched in, both included. The daily first dispatches go at 03:00
 * UTC; a run dispatched by 15:59 has its 330 minutes and an hour of queueing before the UTC day
 * ends, so it opens its pull request on the day whose unit of the open cap it claimed.
 */
export const RESUME_WINDOW_UTC = { from: 3, to: 15 } as const;

/** How long a stalled row must not have moved before it is resumed. */
export const RESUME_QUIET_MINUTES = 60;

/** The last dispatch of a row after which nothing is working on it, and a resume may follow. */
const RESUME_AFTER: ReadonlySet<DispatchStatus> = new Set([
  "failed",
  "unreported",
  "dispatch_failed",
]);

/** The rules of machine clean about the switches, the record and the dataset, before any of its pull request. */
const BEFORE_PULL_REQUEST: ReadonlySet<HoldReason> = new Set(
  MACHINE_CLEAN_HOLDS.slice(0, MACHINE_CLEAN_HOLDS.indexOf("pr-unreadable")),
);

/** How many times the tick dispatches the identifier screen of one head, at most. */
export const AUTOMATIC_SCREENS_MAX = 3;

/** How long a review whose dispatch failed waits before the tick asks for it again. */
export const REVIEW_RETRY_MINUTES = 60;

/**
 * The hold words that mean every rule before the screen holds: the screen's, the review's and
 * GitHub's own `not-clean`, the last three rules of machine clean. Only then is gate work started.
 */
export const GATE_WORK_HOLDS: ReadonlySet<HoldReason> = new Set(
  MACHINE_CLEAN_HOLDS.slice(MACHINE_CLEAN_HOLDS.indexOf("screen-pending")),
);

/** A screen with no verdict for the head, which the tick may dispatch (again). */
const SCREEN_TO_START: ReadonlySet<ScreenFact> = new Set(["absent", "error", "unreported"]);

const quoted = (words: readonly string[]) => words.map((w) => `'${w}'`).join(", ");

// ----------------------------------------------------------------------------
// SQL. Exported so a test runs the statement the tick runs, never a copy.
// ----------------------------------------------------------------------------

/**
 * The automatic rows the tick may examine, by id, with their status, which says which rotation
 * each is in. An administrator's row is never among them. One open row per dataset (migration
 * 0105) and only `on` datasets are automatic, so the list is never longer than the fleet of mirrors.
 */
export const ADVANCE_ROWS_SQL = `SELECT id, status FROM upstream_repulls
  WHERE origin = 'automatic' AND status IN (${quoted(ADVANCE_STATUSES)})
  ORDER BY id`;

/**
 * A row's dispatches, as one row of facts: `?1` its dataset, `?2` its id. `live` counts the
 * dataset's live dispatches (a run is out for it); `opens` the row's `open` dispatches that spend an
 * attempt, every one but a send GitHub turned away for the Worker (`dispatch-deferred`);
 * `last_status` the status of its latest one, by id, and `last_at` when that one last moved (its
 * report, or its send when it has none), each NULL when it has none.
 */
export const ROW_DISPATCHES_SQL = `SELECT
  (SELECT COUNT(*) FROM upstream_repull_dispatches WHERE dataset_id = ?1 AND nonce IS NOT NULL) AS live,
  (SELECT COUNT(*) FROM upstream_repull_dispatches WHERE repull_id = ?2 AND kind = 'open'
    AND NOT (status = 'dispatch_failed' AND code = 'dispatch-deferred')) AS opens,
  (SELECT status FROM upstream_repull_dispatches WHERE repull_id = ?2 AND kind = 'open'
    ORDER BY id DESC LIMIT 1) AS last_status,
  (SELECT COALESCE(reported_at, dispatched_at) FROM upstream_repull_dispatches
    WHERE repull_id = ?2 AND kind = 'open' ORDER BY id DESC LIMIT 1) AS last_at`;

/**
 * Record why an automatic row waits: `?1` its id, `?2` the revision the tick read, `?3` the word it
 * read (NULL for none), `?4` the word now (NULL when nothing holds it). It applies only when the
 * word changes and only to the row as it was read, so `hold_since` is kept while the word is the
 * same, the audit row that follows it is written once per change, and a row that moved meanwhile
 * (any transition bumps its revision) is not written. It touches neither `revision` nor
 * `updated_at`: a hold is an observation, not a transition. Only an automatic row is ever held, as
 * migration 0111's CHECK also says.
 */
export const REPULL_HOLD_SQL = `UPDATE upstream_repulls
  SET hold_reason = ?4,
      hold_since = CASE WHEN ?4 IS NULL THEN NULL ELSE datetime('now') END
  WHERE id = ?1 AND revision = ?2 AND origin = 'automatic'
    AND hold_reason IS ?3 AND ?4 IS NOT ?3`;

/**
 * How many times the identifier screen of one head of N.0.0 was dispatched: `?1` the re-pull's id
 * as text (`String(id)`, as `resource_id` is written), `?2` the head. Counted from the audit row
 * the screen's own claim writes with each dispatch (`repull_screen_dispatched`), an
 * administrator's included.
 */
export const SCREEN_DISPATCHES_SQL = `SELECT COUNT(*) AS n FROM audit_log
  WHERE action = 'repull_screen_dispatched' AND resource_type = 'upstream_repull'
    AND resource_id = ?1 AND json_extract(details, '$.pr') = 'n0'
    AND json_extract(details, '$.sha') = ?2`;

/**
 * Whether the review of one head is one whose dispatch failed (GitHub never ran it) long enough ago
 * to ask again: `?1` the dataset, `?2` the pull request, `?3` the head. The review's own start tries
 * such a review again, and nothing else it has.
 */
export const REVIEW_RETRYABLE_SQL = `SELECT COUNT(*) AS n FROM pr_reviews
  WHERE dataset_id = ?1 AND pr_number = ?2 AND head_sha = ?3
    AND state = 'errored' AND detail = 'dispatch_failed'
    AND decided_at < datetime('now', '-${REVIEW_RETRY_MINUTES} minutes')`;

/** The tick ran: the scheduler's row says when, for the observability slice. */
export const ADVANCE_STAMP_SQL =
  "UPDATE upstream_repull_scheduler SET last_advance_at = datetime('now') WHERE id = 1";

// ----------------------------------------------------------------------------
// The tick
// ----------------------------------------------------------------------------

/**
 * What a tick failed at, as a fixed word, never a message. Each of the first group is a word of the
 * dispatch record or of the scheduler:
 *  - `dispatch-unconfigured`: the Worker has no callback secret (or, for a screen, no API address
 *    or GitHub credential), so nothing could be signed or sent;
 *  - `dispatch-failed`: a screen's dispatch failed (the screen's own word, recorded on its row as an
 *    error it is run again from), or a resume's payload could not be built after its claim;
 *  - `dispatch-refused`: GitHub refused a resume's send for the dispatch itself (404, 422);
 *  - `dispatch-deferred`: GitHub turned a resume's send away for the Worker (any other 4xx);
 *  - `cli-unreleased`: the Worker is not a release build, so a run could not install its CLI;
 *  - `no-github-token`: no GitHub token could be had for a resume's send;
 *  - `cap-unreadable`: the open cap is set to something its reader cannot take;
 *  - `to-tag-malformed`: a recorded tag is not a tag;
 *  - `repull-mismatch`: the claim does not find the row the tick read stalled with its tags.
 * Then the tick's own: a stalled row's time or its last dispatch's that does not parse
 * (`time-unreadable`), a row whose step threw, the tick itself (it could not list its rows), its
 * stamp.
 */
export const ADVANCE_FAILURES = [
  "dispatch-unconfigured",
  "dispatch-failed",
  "dispatch-refused",
  "dispatch-deferred",
  "cli-unreleased",
  "no-github-token",
  "cap-unreadable",
  "to-tag-malformed",
  "repull-mismatch",
  "time-unreadable",
  "row-failed",
  "tick-failed",
  "stamp-failed",
] as const;
export type AdvanceFailure = (typeof ADVANCE_FAILURES)[number];

export interface AdvanceTickResult {
  /** Rows the tick looked at. */
  examined: number;
  /**
   * Of them, rows a run is out for (a live dispatch of the dataset, or one that started while the
   * tick claimed): nothing was read for them from GitHub, and any hold they had was cleared.
   */
  running: number;
  /**
   * Of them, rows with nothing to send this tick. A stalled row, its hold cleared: the row or its
   * last dispatch moved within the quiet time, the tick's sends stopped after a refusal, or the last
   * dispatch is in a state no resume follows. A row that merged, at `merged` or `released`: the
   * tick's sends stopped after a refusal, or, at `merged` only, its version is not minted yet (the
   * finish waits for its DOI).
   */
  notDue: number;
  /** Identifier screens dispatched. */
  screensStarted: number;
  /** ADR 0107 reviews dispatched. */
  reviewsStarted: number;
  /** Reviews the review's own start declined to dispatch, by its reason (`pr_review_disabled`, ...). */
  reviewRefused: Record<string, number>;
  /** Rows moved `pr_open -> gates_clear`. */
  gatesCleared: number;
  /** Stalled rows whose resume GitHub took. */
  resumed: number;
  /** Stalled rows whose resume got no answer: the dispatch stays, and keeps its unit of the cap. */
  unconfirmed: number;
  /** Merges the Worker sent to GitHub. */
  mergesSent: number;
  /** Rows recorded `merged` by the Worker. */
  merged: number;
  /** Merges sent whose answer did not say what became of them: each claim is kept. */
  mergeUnknown: number;
  /**
   * Merges GitHub refused (405, 409 or 422): nothing merged, the claim is kept and the row holds
   * `merge-refused` for an administrator, so each is logged at error level.
   */
  mergeRefused: number;
  /** Claims the Worker held and released, GitHub having said their merge did not happen. */
  claimsReleased: number;
  /** Finish runs GitHub took, for rows that merged. */
  finishes: number;
  /** Finish runs whose dispatch got no answer: each stays live, and may still run. */
  finishUnconfirmed: number;
  /**
   * Clean rows whose edge into `gates_clear`, or whose claim to merge, the record refused, by its
   * code (a `DISPATCH_CODES` word).
   */
  refused: Record<string, number>;
  /** Rows held this tick, by word, whether the word is new or not. */
  held: Record<string, number>;
  /** Hold words written or cleared this tick: one audit row each. */
  holdsChanged: number;
  /** What failed, in fixed words. */
  errors: AdvanceFailure[];
  /** The class of the last error ({@link errorClassName}), never its message. */
  errorClass: string | null;
}

export interface AdvanceOptions {
  /**
   * The tick's time: its place in the rotation and the hour a resume is weighed in. Now by default;
   * a test passes a real instant.
   */
  now?: Date;
  /** The CLI version a resumed run installs; the Worker's own (`package.json`) by default. */
  cliVersion?: string;
  /** How long a resume's dispatch waits for GitHub; the scheduler's by default. */
  dispatchTimeoutMs?: number;
}

interface Tick {
  env: Bindings;
  now: Date;
  cliVersion: string;
  dispatchTimeoutMs: number;
  r: AdvanceTickResult;
  /**
   * A claim found the day's open cap used (`cap-exhausted`) or set to something unreadable
   * (`cap-unreadable`): no later row of this tick claims, and each holds this word.
   */
  capHold: HoldReason | null;
  /** A send was refused, or could not be made: no later row of this tick sends. */
  sendStopped: boolean;
}

/**
 * The rows of `ids` (sorted) that turn `turn` of a rotation examines: all of them when they fit,
 * and otherwise {@link ADVANCE_ROWS_PER_TICK} of them, starting at a place that moves on by that
 * many each turn and wraps, so every row of a stable set is examined at least once in every
 * ceil(n / {@link ADVANCE_ROWS_PER_TICK}) consecutive turns, however long any of them waits.
 */
export function rotate(ids: readonly number[], turn: number): number[] {
  const n = ids.length;
  if (n <= ADVANCE_ROWS_PER_TICK) return [...ids];
  const start = (((turn * ADVANCE_ROWS_PER_TICK) % n) + n) % n;
  return Array.from({ length: ADVANCE_ROWS_PER_TICK }, (_, k) => ids[(start + k) % n] as number);
}

/** The half hours of a UTC day a resume is dispatched in: 03:00 to 15:30, 26 of them. */
const WINDOW_FIRST = RESUME_WINDOW_UTC.from * 2;
const WINDOW_LAST = RESUME_WINDOW_UTC.to * 2 + 1;
const WINDOW_TURNS_PER_DAY = WINDOW_LAST - WINDOW_FIRST + 1;

/**
 * Which half hour of the resume windows since the epoch `now` falls in, counting only the half
 * hours inside {@link RESUME_WINDOW_UTC}, or null outside it. Consecutive ticks inside the window
 * are consecutive numbers, across days too, so a rotation turned by it covers every stalled row
 * inside the window; one turned by the half hour of the day would meet the same rows at the same
 * hours every day (48 ticks a day, five rows each, comes back to the same place in a set of 240)
 * and some rows would never be read while a resume may be sent.
 */
export function resumeWindowTurn(now: Date): number | null {
  const halfHour = now.getUTCHours() * 2 + (now.getUTCMinutes() >= 30 ? 1 : 0);
  if (halfHour < WINDOW_FIRST || halfHour > WINDOW_LAST) return null;
  const day = Math.floor(now.getTime() / 86_400_000);
  return day * WINDOW_TURNS_PER_DAY + (halfHour - WINDOW_FIRST);
}

/**
 * The rows a tick at `now` examines, from the automatic rows listed: three rotations of their own,
 * so no kind can crowd out another. The rows at `pr_open`, and the rows past their gates, each turn
 * every half hour. The rows stalled before their pull request opened are read only inside the
 * resume window, the only time one can be resumed, and turn by {@link resumeWindowTurn}, so each
 * is read inside the window within ceil(n / {@link ADVANCE_ROWS_PER_TICK}) window ticks, however
 * many rows of any kind there are.
 */
export function advanceSelection(
  rows: ReadonlyArray<{ id: number; status: string }>,
  now: Date,
): number[] {
  const of = (kind: AdvanceKind) =>
    rows.filter((x) => advanceKindOf(x.status) === kind).map((x) => x.id);
  const slot = Math.floor(now.getTime() / (ADVANCE_TICK_MINUTES * 60_000));
  const turn = resumeWindowTurn(now);
  return [
    ...rotate(of("open"), slot),
    ...(turn === null ? [] : rotate(of("stalled"), turn)),
    ...rotate(of("past-gates"), slot),
  ];
}

/**
 * Record `word` as why `row` waits (null: nothing holds it), when it is not the word already
 * recorded, with its audit row in the same batch. A row that moved since it was read is not
 * written.
 */
async function observe(t: Tick, row: RepullRow, word: HoldReason | null): Promise<void> {
  if (word !== null) t.r.held[word] = (t.r.held[word] ?? 0) + 1;
  const db = t.env.DB;
  const [update] = await db.batch([
    db.prepare(REPULL_HOLD_SQL).bind(row.id, row.revision, row.hold_reason, word),
    db.prepare(AUDIT_IF_PREVIOUS_CHANGED_SQL).bind(
      ...auditLogParams({
        userId: SYSTEM_USER_ID,
        action: "repull_hold",
        resourceType: "upstream_repull",
        resourceId: String(row.id),
        details: JSON.stringify({
          dataset_id: row.dataset_id,
          status: row.status,
          from: row.hold_reason,
          to: word,
        }),
      }),
    ),
  ]);
  if ((update?.meta?.changes ?? 0) > 0) t.r.holdsChanged++;
}

interface RowDispatches {
  live: number;
  opens: number;
  last_status: DispatchStatus | null;
  last_at: string | null;
}

/** The row's dispatches ({@link ROW_DISPATCHES_SQL}); a count that cannot be read throws. */
async function rowDispatches(db: D1Database, row: RepullRow): Promise<RowDispatches> {
  const d = await db
    .prepare(ROW_DISPATCHES_SQL)
    .bind(row.dataset_id, row.id)
    .first<RowDispatches>();
  if (typeof d?.live !== "number" || typeof d.opens !== "number") {
    throw new Error("the row's dispatches could not be read");
  }
  return d;
}

/** Whether a run is out for the row's dataset (a dispatch holds its nonce). */
async function dispatchLive(db: D1Database, row: RepullRow): Promise<boolean> {
  return (await rowDispatches(db, row)).live > 0;
}

/** Whether the UTC hour of `now` is one a resume is dispatched in. */
export function inResumeWindow(now: Date): boolean {
  const hour = now.getUTCHours();
  return hour >= RESUME_WINDOW_UTC.from && hour <= RESUME_WINDOW_UTC.to;
}

/**
 * Whether neither the row nor its latest dispatch has moved for {@link RESUME_QUIET_MINUTES}
 * minutes, or null when either time cannot be read. Both are D1's UTC `datetime`s. The dispatch is
 * read as well as the row because a run that fails before it writes anything leaves the row's
 * `updated_at` where it was, hours old, and the row would otherwise be resumed on the next tick
 * after every failure.
 */
function quietSince(updatedAt: string, lastDispatchAt: string | null, now: Date): boolean | null {
  const at = (stamp: string) => Date.parse(`${stamp.replace(" ", "T")}Z`);
  const moved = [updatedAt, lastDispatchAt].filter((x): x is string => x !== null).map(at);
  if (moved.some((x) => !Number.isFinite(x))) return null;
  return now.getTime() - Math.max(...moved) >= RESUME_QUIET_MINUTES * 60_000;
}

/**
 * Claim and send the dispatch that resumes `row`; the hold it now has (null: none). Called only
 * once every condition of the module comment holds but the claim and the send.
 */
async function resume(t: Tick, row: RepullRow): Promise<HoldReason | null> {
  const { env, r } = t;
  // A run installs the Worker's own CLI, so a development build dispatches nothing.
  if (!NEMAR_VERSION_RE.test(t.cliVersion)) {
    r.errors.push("cli-unreleased");
    t.sendStopped = true;
    return null;
  }
  // The token is had before the claim, so a claim is never made that could not then be sent.
  let pat: string;
  try {
    pat = await getDatasetsToken(env);
  } catch (err) {
    r.errors.push("no-github-token");
    r.errorClass = errorClassName(err);
    t.sendStopped = true;
    return null;
  }
  const claim = await claimOpenDispatch(env, {
    datasetId: row.dataset_id,
    upstreamDs: row.upstream_ds,
    fromTag: row.from_tag,
    toTag: row.to_tag,
    repullId: row.id,
  });
  if ("refused" in claim) {
    switch (claim.refused) {
      case "off":
        return "switch-off";
      case "cap":
        t.capHold = "cap-exhausted";
        return t.capHold;
      case "cap-unreadable":
        // A fault in the configuration, not a full day: said as such, on the row and in the log.
        t.capHold = "cap-unreadable";
        r.errors.push("cap-unreadable");
        return t.capHold;
      case "unconfigured":
        r.errors.push("dispatch-unconfigured");
        t.sendStopped = true;
        return null;
      case "candidate":
        r.errors.push("to-tag-malformed");
        return null;
      case "live":
        // A run started for the dataset meanwhile: it is working on this row.
        r.running++;
        return null;
      default:
        // `row` (and `open-row`, which a resume cannot meet): the claim's own statement does not
        // find this row stalled with these tags, though the tick just read it so. Said, never
        // waited on in silence, because it would be met again on every tick.
        r.errors.push("repull-mismatch");
        return null;
    }
  }
  const sent = await sendResumeDispatch(env, row, claim, pat, {
    cliVersion: t.cliVersion,
    timeoutMs: t.dispatchTimeoutMs,
  });
  switch (sent.kind) {
    case "sent":
      r.resumed++;
      return null;
    case "unknown":
      r.unconfirmed++;
      return null;
    case "unbuilt":
      r.errors.push("dispatch-failed");
      r.errorClass = sent.errorClass;
      return null;
    case "refused":
      r.errors.push(sent.code);
      t.sendStopped = true;
      return null;
  }
}

/** What sending a claimed resume came to. */
export type ResumeSend =
  /** GitHub took it. */
  | { kind: "sent" }
  /** Its answer was lost: the dispatch stays `dispatched` and keeps its unit, as it may be running. */
  | { kind: "unknown" }
  /** GitHub refused it (a 4xx): the claim is ended `dispatch_failed` with this code, its unit freed. */
  | { kind: "refused"; status: number; code: "dispatch-refused" | "dispatch-deferred" }
  /** Its payload could not be built: nothing was sent, and the claim is ended `dispatch-failed`. */
  | { kind: "unbuilt"; errorClass: string };

/**
 * Build and send the dispatch that resumes `row` under `claim`, and end the claim when nothing ran:
 * a payload that cannot be built (every field was checked before the claim, so this guards drift
 * between the two checks) ends it `dispatch-failed`; GitHub's refusal of the dispatch itself (404,
 * 422) ends it `dispatch-refused`, which spends one of the row's dispatches, and any other 4xx,
 * about the Worker's credential, permission or rate, ends it `dispatch-deferred`, which does not.
 */
export async function sendResumeDispatch(
  env: Bindings,
  row: Pick<RepullRow, "id" | "dataset_id" | "upstream_ds" | "from_tag" | "to_tag">,
  claim: { id: number; token: string },
  pat: string,
  opts: { cliVersion: string; timeoutMs: number },
): Promise<ResumeSend> {
  let payload: ReturnType<typeof buildUpstreamRepullPayload>;
  try {
    payload = buildUpstreamRepullPayload({
      mode: "open",
      datasetId: row.dataset_id,
      upstreamDs: row.upstream_ds,
      fromTag: normalizeUpstreamTag(row.from_tag),
      toTag: normalizeUpstreamTag(row.to_tag),
      dispatchId: claim.id,
      repullId: row.id,
      token: claim.token,
      cliVersion: opts.cliVersion,
    });
  } catch (err) {
    // Nothing was sent: the claim must not hold its unit and the live slot until the watchdog.
    await markDispatchSendFailed(env.DB, claim.id, "dispatch-failed");
    return { kind: "unbuilt", errorClass: errorClassName(err) };
  }
  const sent = await triggerUpstreamRepullRun(payload, pat, { timeoutMs: opts.timeoutMs });
  if (sent === "sent" || sent === "unknown") return { kind: sent };
  const code = REFUSED_FOR_THE_DISPATCH.has(sent.refused)
    ? "dispatch-refused"
    : "dispatch-deferred";
  await markDispatchSendFailed(env.DB, claim.id, code);
  return { kind: "refused", status: sent.refused, code };
}

/** A row that stalled before its pull request opened: resume it, or say why it waits. */
async function advanceStalled(t: Tick, row: RepullRow): Promise<void> {
  const { env, r } = t;
  if (!autoRepullEnabled(env)) return observe(t, row, "switch-off");
  const d = await rowDispatches(env.DB, row);
  // A run is out for the dataset: it is working on this row, or on nothing else.
  if (d.live > 0) {
    r.running++;
    return observe(t, row, null);
  }
  // The record and the dataset, by the machine-clean rule's own rules and reader. The row has no
  // pull request, so the rule asks GitHub nothing for it.
  const verdict = machineClean(await gatherMachineCleanFacts(env, row, "gates"));
  if (!verdict.clean && BEFORE_PULL_REQUEST.has(verdict.hold)) {
    return observe(t, row, verdict.hold);
  }
  if (d.last_status === "refused") return observe(t, row, "resume-refused");
  if (d.last_status !== null && !RESUME_AFTER.has(d.last_status)) {
    r.notDue++;
    return observe(t, row, null);
  }
  if (d.opens >= AUTOMATIC_OPEN_DISPATCHES_MAX) return observe(t, row, "resume-exhausted");
  const quiet = quietSince(row.updated_at, d.last_at, t.now);
  if (quiet === null) {
    // D1 writes every one of these times itself, so this is a fault to see, not a wait: unknown is
    // never read as "not yet", which would leave the row unresumed for good with nothing said.
    r.errors.push("time-unreadable");
    return observe(t, row, null);
  }
  if (!inResumeWindow(t.now) || !quiet || t.sendStopped) {
    r.notDue++;
    return observe(t, row, null);
  }
  if (t.capHold !== null) return observe(t, row, t.capHold);
  return observe(t, row, await resume(t, row));
}

/** How many times the screen of `head` was dispatched for re-pull `id`. */
async function screenDispatches(db: D1Database, id: number, head: string): Promise<number> {
  const n = (await db.prepare(SCREEN_DISPATCHES_SQL).bind(String(id), head).first<{ n: number }>())
    ?.n;
  if (typeof n !== "number") throw new Error("the screen's dispatches could not be counted");
  return n;
}

/** Whether the review of `head` failed to dispatch long enough ago to be asked for again. */
async function reviewRetryable(db: D1Database, row: RepullRow, head: string): Promise<boolean> {
  const n = (
    await db
      .prepare(REVIEW_RETRYABLE_SQL)
      .bind(row.dataset_id, row.pr_number, head)
      .first<{ n: number }>()
  )?.n;
  if (typeof n !== "number") throw new Error("the review could not be read");
  return n > 0;
}

/**
 * Start what the gates of `row`'s head wait for (see the module comment), and return the facts as
 * they now are: a screen or a review this started is on its way. Called only once every rule before
 * the screen holds, so the head is the recorded one and the pull request the App's.
 */
async function startGateWork(
  t: Tick,
  row: RepullRow,
  facts: MachineCleanFacts,
): Promise<MachineCleanFacts> {
  const { env, r } = t;
  const head = row.head_sha;
  if (head === null || row.pr_number === null) return facts;
  let screen = facts.screen;
  if (
    SCREEN_TO_START.has(screen) &&
    (await screenDispatches(env.DB, row.id, head)) < AUTOMATIC_SCREENS_MAX
  ) {
    const started = await startRepullScreen(env, row, "n0", head, SYSTEM_USER_ID);
    if (started.kind === "dispatched") {
      r.screensStarted++;
      screen = "pending";
    } else if (started.kind === "failed") {
      r.errors.push(started.error);
      screen = "error";
    }
  }
  let review = facts.review;
  // Only behind a clear screen: one still out, errored, blocking or asking for a person is not.
  if (
    facts.screen === "clear" &&
    (review === "absent" || (review === "error" && (await reviewRetryable(env.DB, row, head))))
  ) {
    const started = await startRepullPullRequestReview(env, row);
    if (started.dispatched) {
      r.reviewsStarted++;
      review = "running";
    } else {
      r.reviewRefused[started.reason] = (r.reviewRefused[started.reason] ?? 0) + 1;
    }
  }
  return { ...facts, screen, review };
}

/**
 * `pr_open -> gates_clear` for a row the rule found clean, through the record's own transition and
 * on the row as the tick read it (its revision), as the system user. The transition reads the
 * dataset fences, the screen bound to the row and GitHub's live head again, and re-asserts the
 * screen's verdict in the statement that writes. A refusal writes no edge: the rule and the record
 * disagree, which should not happen, so it is counted by its code, logged at error level and held
 * `gates-refused`, unless the row moved meanwhile (then the hold is not written either).
 */
async function clearGates(t: Tick, row: RepullRow, head: string): Promise<void> {
  const { env, r } = t;
  const prepared = await prepareTransition(
    env,
    { id: SYSTEM_USER_ID },
    row,
    { from: "pr_open", to: "gates_clear", fields: { gates_sha: head } },
    { auditDetails: { automatic: true } },
  );
  const done = isRefusal(prepared) ? prepared : await commitTransition(env.DB, prepared);
  if (isRefusal(done)) {
    r.refused[done.code] = (r.refused[done.code] ?? 0) + 1;
    return observe(t, row, "gates-refused");
  }
  r.gatesCleared++;
}

/** A row at `pr_open`: its machine-clean verdict at the gates, and what it waits for. */
async function advanceOpenPullRequest(t: Tick, row: RepullRow): Promise<void> {
  const { env } = t;
  // With the open switch off nothing is read from GitHub, and the row says why it waits.
  if (!autoRepullEnabled(env)) return observe(t, row, "switch-off");
  // A run still out for the dataset is settling the head it opened: nothing is read until it ends.
  if (await dispatchLive(env.DB, row)) {
    t.r.running++;
    return observe(t, row, null);
  }
  let facts = await gatherMachineCleanFacts(env, row, "gates");
  let verdict = machineClean(facts);
  // Only a clean verdict takes the edge; every other answer, an unknown fact's included, holds.
  if (verdict.clean && row.head_sha !== null) return clearGates(t, row, row.head_sha);
  if (!verdict.clean && GATE_WORK_HOLDS.has(verdict.hold)) {
    facts = await startGateWork(t, row, facts);
    verdict = machineClean(facts);
  }
  return observe(t, row, verdict.clean ? null : verdict.hold);
}

/** Count what the Worker's merge came to. */
function tallyMerge(t: Tick, o: WorkerMergeOutcome): void {
  const { r } = t;
  if (o.sent) r.mergesSent++;
  if (o.kind === "merged") r.merged++;
  if (o.kind === "unknown") r.mergeUnknown++;
  if (o.kind === "refused") r.mergeRefused++;
  if (o.kind === "released") r.claimsReleased++;
  if (o.hold === "cap-unreadable") {
    // A fault in the configuration, not a full day: said as such, on the row and in the log.
    r.errors.push("cap-unreadable");
  } else if (o.code !== undefined && o.hold !== "cap-exhausted") {
    // The record refused a clean row's claim, or the record of a merge GitHub made: the rule and
    // the record disagree, which is counted by the record's word and logged at error level.
    r.refused[o.code] = (r.refused[o.code] ?? 0) + 1;
  }
}

/**
 * A row that merged (`merged`, `released`): the finish run that walks it to `complete`
 * (`finishAfterMerge`), whatever the switches say, and `finish-exhausted` once it was dispatched as
 * often as the automatic path dispatches one. A send GitHub refused, or one that could not be made,
 * stops the tick's sends, as a resume's does.
 */
async function finish(t: Tick, row: RepullRow): Promise<void> {
  const { r } = t;
  if (t.sendStopped) {
    r.notDue++;
    return;
  }
  const o = await finishAfterMerge(t.env, row, {
    cliVersion: t.cliVersion,
    timeoutMs: t.dispatchTimeoutMs,
  });
  switch (o.kind) {
    case "skipped":
      return;
    case "exhausted":
      return observe(t, row, "finish-exhausted");
    case "live":
      r.running++;
      break;
    case "waiting":
      r.notDue++;
      break;
    case "dispatched":
      r.finishes++;
      break;
    case "unconfirmed":
      r.finishUnconfirmed++;
      break;
    case "refused":
      r.errors.push(o.code);
      t.sendStopped = true;
      break;
    case "failed":
      r.errors.push(o.error);
      t.sendStopped = true;
      break;
  }
  return observe(t, row, null);
}

/**
 * A row past its gates. At `gates_clear` with no claim held, the Worker's merge
 * (`workerMergeRepull`), which reads the switches, the machine-clean facts at the merge stage and
 * the day's cap itself; with a claim held, GitHub says what became of its merge
 * (`reconcileWorkerClaim`), whatever the switches say.
 */
async function advancePastGates(t: Tick, row: RepullRow): Promise<void> {
  if (row.status !== "gates_clear") return finish(t, row);
  const o =
    row.merge_claim_sha !== null
      ? await reconcileWorkerClaim(t.env, row)
      : await workerMergeRepull(t.env, row);
  tallyMerge(t, o);
  // A merge recorded is an edge into another status, which ended the hold already.
  if (o.kind === "skipped" || o.kind === "merged") return;
  return observe(t, o.row, o.hold);
}

async function advanceRow(t: Tick, id: number, listed: string): Promise<void> {
  const row = await getRepull(t.env.DB, id);
  // Read again by id: a row that ended, moved to another kind or is an administrator's since the
  // list is left, for the next tick to read as it is.
  if (!row || row.origin !== "automatic") return;
  const kind = advanceKindOf(row.status);
  if (kind === null || kind !== advanceKindOf(listed)) return;
  t.r.examined++;
  if (kind === "open") await advanceOpenPullRequest(t, row);
  else if (kind === "stalled") await advanceStalled(t, row);
  else await advancePastGates(t, row);
}

/**
 * The advance tick. Null outside exact production, with nothing read, written or sent. In
 * production it examines at most {@link ADVANCE_ROWS_PER_TICK} automatic rows of each kind
 * ({@link advanceSelection}) and stamps the scheduler's row; a failure is a fixed word in the result, never a throw, so the 30-minute tick's
 * other jobs run on, and one row that fails does not stop the others.
 */
export async function runRepullAdvanceCron(
  env: Bindings,
  opts: AdvanceOptions = {},
): Promise<AdvanceTickResult | null> {
  if (!isExactProduction(env)) return null;
  const r: AdvanceTickResult = {
    examined: 0,
    running: 0,
    notDue: 0,
    screensStarted: 0,
    reviewsStarted: 0,
    reviewRefused: {},
    gatesCleared: 0,
    resumed: 0,
    unconfirmed: 0,
    mergesSent: 0,
    merged: 0,
    mergeUnknown: 0,
    mergeRefused: 0,
    claimsReleased: 0,
    finishes: 0,
    finishUnconfirmed: 0,
    refused: {},
    held: {},
    holdsChanged: 0,
    errors: [],
    errorClass: null,
  };
  const t: Tick = {
    env,
    now: opts.now ?? new Date(),
    cliVersion: opts.cliVersion ?? pkg.version,
    dispatchTimeoutMs: opts.dispatchTimeoutMs ?? UPSTREAM_REPULL_DISPATCH_TIMEOUT_MS,
    r,
    capHold: null,
    sendStopped: false,
  };
  try {
    const { results } = await env.DB.prepare(ADVANCE_ROWS_SQL).all<{
      id: number;
      status: string;
    }>();
    const listed = new Map(results.map((x) => [x.id, x.status]));
    for (const id of advanceSelection(results, t.now)) {
      try {
        await advanceRow(t, id, listed.get(id) ?? "");
      } catch (err) {
        // The row by its id (an operator reads the record with it), never its dataset, and the
        // error by its class, never its message; the next row is taken up.
        r.errors.push("row-failed");
        r.errorClass = errorClassName(err);
        console.error(`[repull-advance] re-pull ${id}: its step failed (${r.errorClass})`);
      }
    }
  } catch (err) {
    r.errors.push("tick-failed");
    r.errorClass = errorClassName(err);
  }
  // Stamped only for a tick that went through its rows: one that could not list them did not run.
  if (!r.errors.includes("tick-failed")) {
    try {
      const res = await env.DB.prepare(ADVANCE_STAMP_SQL).run();
      if (res.meta?.changes !== 1) throw new Error("the scheduler's row is missing");
    } catch (err) {
      r.errors.push("stamp-failed");
      r.errorClass = errorClassName(err);
    }
  }
  return r;
}

/**
 * The tick's one log line, or null when it changed nothing and nothing failed, so a tick that only
 * found the same rows waiting for the same reasons says nothing. Error level when anything failed,
 * the record refused a clean row's edge or claim, or GitHub refused a merge; a resume, a merge or a
 * finish whose answer was lost is an error too, as the scheduler's is. Counts and fixed words only:
 * no dataset id, no message.
 */
export function repullAdvanceLogLine(
  r: AdvanceTickResult,
): { level: "info" | "error"; line: string } | null {
  const failed =
    r.errors.length > 0 ||
    r.unconfirmed > 0 ||
    r.mergeUnknown > 0 ||
    r.mergeRefused > 0 ||
    r.finishUnconfirmed > 0 ||
    Object.keys(r.refused).length > 0;
  const acted =
    r.screensStarted +
    r.reviewsStarted +
    r.gatesCleared +
    r.resumed +
    r.mergesSent +
    r.merged +
    r.claimsReleased +
    r.finishes +
    r.holdsChanged;
  const declined = Object.keys(r.refused).length + Object.keys(r.reviewRefused).length;
  if (!failed && acted === 0 && declined === 0) return null;
  const words = (counts: Record<string, number>) =>
    Object.entries(counts)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([word, n]) => `${word}:${n}`)
      .join(",") || "none";
  const fields = [
    `examined=${r.examined}`,
    `running=${r.running}`,
    `not_due=${r.notDue}`,
    `screens=${r.screensStarted}`,
    `reviews=${r.reviewsStarted}`,
    `review_refused=${words(r.reviewRefused)}`,
    `gates_cleared=${r.gatesCleared}`,
    `resumed=${r.resumed}`,
    `unconfirmed=${r.unconfirmed}`,
    `merges=${r.mergesSent}`,
    `merged=${r.merged}`,
    `merge_unknown=${r.mergeUnknown}`,
    `merge_refused=${r.mergeRefused}`,
    `claims_released=${r.claimsReleased}`,
    `finishes=${r.finishes}`,
    `finish_unconfirmed=${r.finishUnconfirmed}`,
    `holds_changed=${r.holdsChanged}`,
    `held=${words(r.held)}`,
    `refused=${words(r.refused)}`,
  ];
  if (r.errors.length > 0) fields.push(`errors=${r.errors.join(",")}`);
  if (r.errorClass !== null) fields.push(`error_class=${r.errorClass}`);
  return { level: failed ? "error" : "info", line: `[repull-advance] ${fields.join(" ")}` };
}
