/**
 * The automatic re-pull's scheduler (epic #1046 phase 7, #1913; ADR 0111, decision 6 and the
 * Phase 7 slices): once a day, in production only, find mirrors that upstream has moved past and
 * dispatch the central workflow that opens their re-pull pull requests.
 *
 * WHAT IS A CANDIDATE. A row the staleness report (`upstream-status.ts`, the same service the
 * route and the weekly section read) calls `stale_ready`: a known recorded tag, a newer snapshot
 * by OpenNeuro's own creation order, and that snapshot already on OpenNeuro's GitHub mirror. No
 * other state is ever a candidate: `mirror_lag` and `stale_unverified` cannot be planned yet,
 * `unknown` and `not_examined` have no tag to pull from, and `unpublished` has no version row, so
 * a never-published mirror is left to the import retry, which prepares it again at the latest tag
 * in place (ADR 0111, decision 10). Withdrawn mirrors, imports in flight and open re-pulls never
 * reach `stale_ready` either. The pull goes to the latest tag the report read.
 *
 * WHAT IS NOT DISPATCHED, re-read per candidate in one statement ({@link CANDIDATE_BLOCKERS_SQL}):
 * a dataset that is not exactly non-anonymous (`anonymous`, or `missing` when its row is gone), one
 * holding a merge nothing reconciled (the create's own rule, imported), one with an open re-pull or
 * a live dispatch, one whose run already refused this tag for content (a content refusal ends the
 * automatic path for that tag), one whose last {@link REPULL_UNREPORTED_STREAK} dispatches all
 * ended `unreported` (a run that never reports would be sent again on every rotation), and one
 * with a re-pull created, or a first dispatch sent, in the last {@link REPULL_WINDOW_DAYS} days,
 * except a dispatch GitHub refused (it never ran). Then the create's dataset fences are read again
 * (a mirror of that `ds`, not withdrawn, no import in flight) through the record's own function.
 * The automatic create checks everything again when the run arrives.
 *
 * THE CAP. Every dispatch goes through the dispatch record's claim (`claimOpenDispatch`), which
 * counts the UTC day's `open` dispatches on D1's clock in the statement that claims the unit, so
 * nothing here can dispatch past `REPULL_DAILY_OPEN_CAP`. The day's count is also read once before
 * the scan, only so a day that is already full costs no OpenNeuro request (`cap-reached`); the
 * claim alone decides a unit. A dispatch GitHub refused (a 4xx) frees its unit; one whose answer
 * was lost (a 5xx, a lost connection, the timeout) keeps it, because it may be running. A refusal
 * the next mirror would meet too (401, 403, 404: the credential; 429: the rate limit; or a second
 * refusal in one tick) stops the tick before that mirror (`send-refused`).
 *
 * PRODUCTION ONLY. Outside `ENVIRONMENT` exactly `production` the tick returns null before it
 * reads or writes anything, and it is called only from the production-only daily block, absent
 * from `DEV_CRON_ALLOWLIST`: the `nemarDatasets` organization is shared with dev. In production it
 * acts only while `AUTO_REPULL_ENABLED` is exactly `"1"`; it dispatches nothing until both of the
 * re-pulls the design record's gate G4 names ({@link REPULL_G4_DATASETS}) have been run by an
 * administrator to `complete` with their tags ({@link MANUAL_RUN_PROOF_SQL}), and nothing from a
 * Worker that is not a release build (the run installs the Worker's own version of the CLI).
 *
 * THE CURSOR. A tick examines at most {@link REPULL_SCAN_PAGES} pages of the report from where the
 * last one stopped (`upstream_repull_scheduler.scan_after`), so the fleet is covered in rotation,
 * and wraps to the start after the last mirror. The GitHub probes that turn a stale row into
 * `stale_ready` are bounded per tick ({@link REPULL_SCAN_PROBE_BUDGET}); a stale row the budget did
 * not reach reads `stale_unverified`, so the cursor stops before the first such row and the next
 * tick probes it, rather than passing it by until the next rotation (which would starve every
 * stale mirror behind ten ineligible ones). The tick is `blind`, dispatches nothing from what it
 * could not see and does not move the cursor past it, in three cases: OpenNeuro failed a batch
 * (the page carries `errors`), the probes had no GitHub credential, or every probe the tick made
 * came back unverified. A mirror the report could not compare on its own (`unchecked`, with no
 * batch failure) is passed by and counted, so one dataset that always fails cannot hold the
 * cursor. A candidate whose own reads throw holds the tick (the cursor stays before it), and so
 * does a tick whose every probe came back unverified, but each holds at most two ticks at one
 * place in {@link REPULL_WINDOW_DAYS} days; the third passes it by (a candidate as
 * `candidate-error`), so neither one mirror that always throws nor one whose OpenNeuro repository
 * is gone can hold the rotation for good.
 *
 * COST on the daily tick, which shares one subrequest allowance with every daily job, counted from
 * the code: 3 D1 statements before the first page (the proof, the day's count, the cursor) and 1
 * after it (the stamp); per page, 3 D1 statements and at most 2 GraphQL requests; at most 10 tag
 * probes and, for a tag that is not there, 10 control reads; one token for an App credential (none
 * for a token); and per `stale_ready` mirror (at most 10, one per probe) 2 D1 statements to skip
 * it, or 4 and the send to dispatch it (the blockers, the fences, the claim's batch and its read-
 * back), one more when GitHub refuses. A tick of three pages, ten probes and ten dispatches
 * measures 79 (`upstream-repull-scheduler.test.ts` pins it), and by the count above no tick can
 * exceed about 85.
 *
 * NO MAIL. Nothing here imports a mail service (`repull-no-mail-scan.test.ts`), and nothing here
 * reaches discovery or the auto-import (`repull-discovery-separation.test.ts`).
 */

import pkg from "../../../package.json" with { type: "json" };
import { normalizeUpstreamTag } from "../../../shared/openneuro-tag.js";
import {
  DISPATCH_FINAL_CODES,
  type SchedulerOutcome,
  TERMINAL_STATUSES,
} from "../../../shared/repull-state.js";
import { STALE_STATES, type UpstreamStatusRow } from "../../../shared/upstream-staleness.js";
import type { Bindings } from "../types/bindings.js";
import {
  UPSTREAM_REPULL_DISPATCH_TIMEOUT_MS,
  buildUpstreamRepullPayload,
  errorClassName,
  triggerUpstreamRepullRun,
} from "./github/dispatch.js";
import { autoRepullEnabled, isExactProduction, repullOpenCap } from "./repull-switches.js";
import {
  OPEN_DISPATCHES_TODAY_SQL,
  claimOpenDispatch,
  markDispatchSendFailed,
} from "./upstream-repull-dispatch.js";
import { MERGE_UNRECONCILED_SQL, datasetFenceRefusal } from "./upstream-repull.js";
import { CURSOR_RE, type ProbeAuth, runUpstreamStatusPage } from "./upstream-status.js";

/** Pages of the staleness report one tick examines: at most 300 mirrors a day, in rotation. */
export const REPULL_SCAN_PAGES = 3;
/** GitHub tag probes one tick makes, for the whole scan (each may add one control read). */
export const REPULL_SCAN_PROBE_BUDGET = 10;
/** A dataset gets at most one first dispatch, or one re-pull, in this many days. */
export const REPULL_WINDOW_DAYS = 30;
/**
 * A dataset whose last this-many dispatches all ended `unreported` is not dispatched again
 * (`unreported-streak`), and the tick's log line is raised to warn while it skips one. Nothing
 * clears the streak: only a later dispatch that reports would, and the scheduler sends that dataset
 * none. The mirror stays on the administrator's path: an administrator re-pulls it by hand (`nemar
 * admin repull plan`, then `execute`), and a later staleness of it is the administrator's again.
 */
export const REPULL_UNREPORTED_STREAK = 3;
/**
 * A candidate whose own reads throw, or a tick whose every probe failed, is held at one place for
 * fewer than this many ticks in {@link REPULL_WINDOW_DAYS} days: the first two stop there, and the
 * third passes it by.
 */
export const REPULL_CANDIDATE_HOLD_TICKS = 3;
/**
 * The two first re-pulls, which the design record's gate G4 says are run by hand before anything
 * runs on its own (`on004362` and `on003645`, either first, as upstream's snapshots allow). Both
 * must have been run by an administrator to `complete` with their tags before the scheduler
 * dispatches.
 */
export const REPULL_G4_DATASETS = ["on003645", "on004362"] as const;

/**
 * Refusals the next mirror would meet as well, so the tick stops before the mirror instead of
 * spending its unit: 401, 403 and 404 say the credential cannot reach the central repository, and
 * 429 is GitHub's rate limit.
 */
const STOPPING_REFUSALS: ReadonlySet<number> = new Set([401, 403, 404, 429]);
/** A version the run can install from npm as a release. */
const RELEASE_VERSION = /^\d+\.\d+\.\d+$/;
/** The outcomes an operator must see: the tick could not do its work, or was not configured to. */
const TROUBLE: ReadonlySet<SchedulerOutcome> = new Set([
  "blind",
  "error",
  "send-refused",
  "cap-unreadable",
  "cli-unreleased",
  "unconfigured",
]);

const quoted = (words: readonly string[]) => words.map((w) => `'${w}'`).join(", ");

// ----------------------------------------------------------------------------
// SQL. Exported so a test runs the statement the service runs, never a copy.
// ----------------------------------------------------------------------------

/**
 * The create's own rule for a merge nothing reconciled (`MERGE_UNRECONCILED_SQL`), imported and
 * never retyped, with its one dataset parameter numbered `?1` so it nests in a statement that
 * binds `?1` and `?2`. A bare `?` there would take the number after the largest one bound so far,
 * so the rewrite is checked: one placeholder, at the dataset, or the module refuses to load.
 */
const UNRECONCILED_FOR_DATASET_1 = (() => {
  const marks = MERGE_UNRECONCILED_SQL.match(/\?/g) ?? [];
  const atDataset = MERGE_UNRECONCILED_SQL.match(/dataset_id = \?(?!\d)/g) ?? [];
  if (marks.length !== 1 || atDataset.length !== 1) {
    throw new Error("MERGE_UNRECONCILED_SQL no longer binds exactly one dataset parameter");
  }
  return MERGE_UNRECONCILED_SQL.replace(/dataset_id = \?(?!\d)/, "dataset_id = ?1");
})();

/**
 * Why a `stale_ready` mirror is not dispatched, as one row of facts; `?1` the dataset, `?2` the
 * tag the dispatch would pull, as the dispatch record stores it (without a leading `v`; bind it
 * through {@link readCandidateBlockers}, which normalizes it). Each count is 0, never NULL;
 * `anonymous` is NULL only when the dataset's row is gone.
 */
export const CANDIDATE_BLOCKERS_SQL = `SELECT
  (SELECT anonymous FROM datasets WHERE dataset_id = ?1) AS anonymous,
  (SELECT COUNT(*) FROM (${UNRECONCILED_FOR_DATASET_1})) AS unreconciled,
  (SELECT COUNT(*) FROM upstream_repulls
    WHERE dataset_id = ?1 AND status NOT IN (${quoted(TERMINAL_STATUSES)})) AS open_rows,
  (SELECT COUNT(*) FROM upstream_repull_dispatches
    WHERE dataset_id = ?1 AND nonce IS NOT NULL) AS live,
  (SELECT COUNT(*) FROM upstream_repull_dispatches
    WHERE dataset_id = ?1 AND to_tag = ?2 AND status = 'refused'
      AND code IN (${quoted(DISPATCH_FINAL_CODES)})) AS final_refusals,
  (SELECT COUNT(*) FROM (SELECT status FROM upstream_repull_dispatches
      WHERE dataset_id = ?1 ORDER BY id DESC LIMIT ${REPULL_UNREPORTED_STREAK}) AS last_sent
    WHERE last_sent.status = 'unreported') AS unreported_last,
  (SELECT COUNT(*) FROM upstream_repulls
    WHERE dataset_id = ?1
      AND created_at > datetime('now', '-${REPULL_WINDOW_DAYS} days')) AS recent_rows,
  (SELECT COUNT(*) FROM upstream_repull_dispatches
    WHERE dataset_id = ?1 AND kind = 'open' AND repull_id IS NULL
      AND status <> 'dispatch_failed'
      AND dispatched_at > datetime('now', '-${REPULL_WINDOW_DAYS} days')) AS recent_dispatches`;

/**
 * The design record's gate G4 (the first two re-pulls are run by hand, the new major's DOI then
 * resolves with `IsDerivedFrom`, and the previous version still serves), as far as the database
 * can show it: each of the two re-pulls ({@link REPULL_G4_DATASETS}) was run by an administrator to
 * `complete`, its tag recorded. The scheduler dispatches nothing (`waiting-for-manual-run`) until
 * `n` is the number of datasets named; one of them alone, two runs of one, or any other mirror's
 * re-pull does not open it. The DOI and the previous version are read by the owner before turning
 * the switch on, which is the act that opens the path.
 */
export const MANUAL_RUN_PROOF_SQL = `SELECT COUNT(DISTINCT dataset_id) AS n FROM upstream_repulls
  WHERE origin = 'administrator' AND status = 'complete' AND tag_sha IS NOT NULL
    AND dataset_id GLOB 'on[0-9][0-9][0-9][0-9][0-9][0-9]'
    AND dataset_id IN (${quoted(REPULL_G4_DATASETS)})`;

/** Where the last tick stopped: a dataset id, or '' for the start of the fleet. */
export const SCHEDULER_CURSOR_SQL = "SELECT scan_after FROM upstream_repull_scheduler WHERE id = 1";

/**
 * Stamp the tick, in one statement: `?1` the new cursor (NULL keeps the stored one, for a tick
 * that stopped before its scan or did not move), `?2` the outcome.
 */
export const SCHEDULER_STAMP_SQL = `UPDATE upstream_repull_scheduler
  SET scan_after = COALESCE(?1, scan_after), last_tick_at = datetime('now'), last_outcome = ?2
  WHERE id = 1`;

/** The ticks a candidate held in the window: `?` the dataset. */
export const CANDIDATE_HELD_COUNT_SQL = `SELECT COUNT(*) AS n FROM audit_log
  WHERE action = 'repull_scheduler_held' AND resource_type = 'dataset' AND resource_id = ?
    AND timestamp > datetime('now', '-${REPULL_WINDOW_DAYS} days')`;

/**
 * One tick a candidate held: `?1` the dataset, `?2` its error's class (a fixed word, never the
 * message), `?3` how many ticks it has held, this one included.
 */
export const CANDIDATE_HELD_AUDIT_SQL = `INSERT INTO audit_log (user_id, action, resource_type, resource_id, details)
  VALUES (NULL, 'repull_scheduler_held', 'dataset', ?1,
    json_object('error_class', ?2, 'held_ticks', ?3))`;

/** The ticks held in the window because every probe failed, at one cursor: `?` the cursor. */
export const PROBES_HELD_COUNT_SQL = `SELECT COUNT(*) AS n FROM audit_log
  WHERE action = 'repull_scheduler_probes_held' AND resource_type = 'scheduler_cursor'
    AND resource_id = ? AND timestamp > datetime('now', '-${REPULL_WINDOW_DAYS} days')`;

/** One tick held because every probe failed: `?1` the cursor it held, `?2` the probes, `?3` the ticks held. */
export const PROBES_HELD_AUDIT_SQL = `INSERT INTO audit_log (user_id, action, resource_type, resource_id, details)
  VALUES (NULL, 'repull_scheduler_probes_held', 'scheduler_cursor', ?1,
    json_object('probed', ?2, 'held_ticks', ?3))`;

// ----------------------------------------------------------------------------
// One candidate
// ----------------------------------------------------------------------------

/** One row of {@link CANDIDATE_BLOCKERS_SQL}. */
export interface CandidateBlockers {
  anonymous: number | null;
  unreconciled: number;
  open_rows: number;
  live: number;
  final_refusals: number;
  unreported_last: number;
  recent_rows: number;
  recent_dispatches: number;
}

/** The words a `stale_ready` mirror is skipped with before any claim. */
export type CandidateSkip =
  | "missing"
  | "anonymous"
  | "unreconciled"
  | "open-row"
  | "live"
  | "final-refusal"
  | "unreported-streak"
  | "recent";

const COUNTS = [
  "unreconciled",
  "open_rows",
  "live",
  "final_refusals",
  "unreported_last",
  "recent_rows",
  "recent_dispatches",
] as const satisfies readonly (keyof CandidateBlockers)[];

/**
 * The blockers of one candidate, with the tag normalized as the dispatch record stores it: a
 * refusal recorded at `1.0.0` blocks a pull to `v1.0.0`, which names the same snapshot.
 */
export function readCandidateBlockers(
  db: D1Database,
  datasetId: string,
  toTag: string,
): Promise<CandidateBlockers | null> {
  return db
    .prepare(CANDIDATE_BLOCKERS_SQL)
    .bind(datasetId, normalizeUpstreamTag(toTag))
    .first<CandidateBlockers>();
}

/**
 * Why the facts forbid a dispatch, or null when they allow one. A dataset is dispatched only when
 * it says `anonymous` is exactly 0: a NULL (the row is gone) is `missing`, and any other value is
 * `anonymous`, because unknown is never clean. A count that is not a number is a defect, and it
 * throws rather than read as zero (the tick then holds at that candidate).
 */
export function candidateSkip(b: CandidateBlockers | null): CandidateSkip | null {
  if (b === null || b.anonymous === null) return "missing";
  for (const k of COUNTS) {
    if (typeof b[k] !== "number") throw new Error(`the candidate's ${k} count could not be read`);
  }
  if (b.anonymous !== 0) return "anonymous";
  if (b.unreconciled > 0) return "unreconciled";
  if (b.open_rows > 0) return "open-row";
  if (b.live > 0) return "live";
  if (b.final_refusals > 0) return "final-refusal";
  if (b.unreported_last >= REPULL_UNREPORTED_STREAK) return "unreported-streak";
  if (b.recent_rows > 0 || b.recent_dispatches > 0) return "recent";
  return null;
}

/** What considering one `stale_ready` mirror came to. */
type Considered =
  /** Not dispatched, for this word; the cursor moves past it. */
  | { kind: "skip"; word: string }
  /** GitHub took the dispatch. */
  | { kind: "dispatched" }
  /** GitHub's answer was lost: the dispatch stays `dispatched` and keeps its unit. */
  | { kind: "unconfirmed" }
  /** GitHub refused it (a 4xx, with its status): ended `dispatch_failed`, its unit freed. */
  | { kind: "send-failed"; status: number }
  /** The claim says the tick cannot go on (the day is full, or the Worker cannot claim at all). */
  | { kind: "stop"; outcome: SchedulerOutcome };

interface TickContext {
  env: Bindings;
  cliVersion: string;
  timeoutMs: number;
  /** The probes' GitHub credential, which the dispatch is sent with. */
  probeAuth: ProbeAuth;
}

async function considerCandidate(ctx: TickContext, row: UpstreamStatusRow): Promise<Considered> {
  const { env } = ctx;
  const ds = row.ds;
  const fromTag = row.recorded?.tag ?? null;
  const toTag = row.upstream?.latest_tag ?? null;
  if (ds === null || fromTag === null || toTag === null) {
    return { kind: "skip", word: "incomplete" };
  }

  const skip = candidateSkip(await readCandidateBlockers(env.DB, row.dataset_id, toTag));
  if (skip) return { kind: "skip", word: skip };
  const fenced = await datasetFenceRefusal(env.DB, { dataset_id: row.dataset_id, upstream_ds: ds });
  if (fenced) return { kind: "skip", word: fenced.code };

  // A row is `stale_ready` only after a probe of OpenNeuro's GitHub mirror answered, and the probe
  // sets the pass's credential first; it is read before the claim, so a claim is never made that
  // could not then be sent.
  const pat = ctx.probeAuth.pat;
  if (pat === undefined) throw new Error("a stale_ready row without the probes' credential");
  const claim = await claimOpenDispatch(env, {
    datasetId: row.dataset_id,
    upstreamDs: ds,
    fromTag,
    toTag,
  });
  if ("refused" in claim) {
    switch (claim.refused) {
      case "candidate":
      case "live":
        return { kind: "skip", word: claim.refused };
      case "open-row":
      case "row":
        return { kind: "skip", word: "open-row" };
      case "cap":
        return { kind: "stop", outcome: "cap-reached" };
      case "cap-unreadable":
        return { kind: "stop", outcome: "cap-unreadable" };
      case "unconfigured":
        return { kind: "stop", outcome: "unconfigured" };
      case "off":
        return { kind: "stop", outcome: "switch-off" };
    }
  }

  let payload: ReturnType<typeof buildUpstreamRepullPayload>;
  try {
    payload = buildUpstreamRepullPayload({
      mode: "open",
      datasetId: row.dataset_id,
      upstreamDs: ds,
      fromTag: normalizeUpstreamTag(fromTag),
      toTag: normalizeUpstreamTag(toTag),
      dispatchId: claim.id,
      repullId: null,
      token: claim.token,
      cliVersion: ctx.cliVersion,
    });
  } catch (err) {
    // Every field was checked before the claim, so this guards drift between the builder's rules
    // and the claim's. Nothing was sent: the claim must not hold its unit and the live slot until
    // the watchdog.
    await markDispatchSendFailed(env.DB, claim.id, "dispatch-failed");
    throw err;
  }
  const sent = await triggerUpstreamRepullRun(payload, pat, { timeoutMs: ctx.timeoutMs });
  if (sent === "sent") return { kind: "dispatched" };
  if (sent === "unknown") return { kind: "unconfirmed" };
  await markDispatchSendFailed(env.DB, claim.id, "dispatch-refused");
  return { kind: "send-failed", status: sent.refused };
}

// ----------------------------------------------------------------------------
// The tick
// ----------------------------------------------------------------------------

/** Why a tick failed or saw nothing, in fixed words; never a message. */
export type SchedulerError =
  | "openneuro-unreadable"
  | "probe-credential-missing"
  | "probes-unverified"
  | "candidate-failed"
  | "tick-failed"
  | "stamp-failed";

export interface SchedulerTickResult {
  outcome: SchedulerOutcome;
  /** Mirrors the cursor moved past this tick. */
  scanned: number;
  /** Of them, the `stale_ready` ones (dispatched or skipped). */
  staleReady: number;
  /**
   * Of them, the ones the report could not compare with upstream (`unchecked`) with no batch
   * failure: passed by, so one mirror that always fails cannot hold the cursor, and met again on
   * the next rotation.
   */
  unchecked: number;
  /** Stale rows the tick's probes reached. */
  probed: number;
  /** Of them, the ones whose probe could not answer (`stale_unverified`). */
  probeUnverified: number;
  /** Dispatches GitHub took. */
  dispatched: number;
  /** Dispatches GitHub refused (a 4xx): ended `dispatch_failed`, their units freed. */
  sendFailed: number;
  /** The status of the last refusal, or null. */
  refusedStatus: number | null;
  /** Dispatches whose answer was lost: still `dispatched`, their units kept. */
  unconfirmed: number;
  /** Candidates whose own reads threw (held, or passed by as `candidate-error`). */
  candidateErrors: number;
  /** Why each `stale_ready` mirror that was not dispatched was skipped, by word. */
  skipped: Record<string, number>;
  /** The probe budget ran out before the stale rows did; the next tick starts at the first left. */
  deferred: boolean;
  /** Why the tick failed or saw nothing, as a fixed word. */
  error: SchedulerError | null;
  /** The class of the error that failed it ({@link errorClassName}), never its message. */
  errorClass: string | null;
}

export interface SchedulerOptions {
  /** The CLI version the run installs; the Worker's own (`package.json`) by default. */
  cliVersion?: string;
  /** How long a dispatch waits for GitHub; {@link UPSTREAM_REPULL_DISPATCH_TIMEOUT_MS} by default. */
  dispatchTimeoutMs?: number;
}

const isStale = (row: UpstreamStatusRow) => (STALE_STATES as readonly string[]).includes(row.state);

/**
 * The index of the first stale row the probes did not reach, or the page's length. The report
 * probes the stale rows of a page in dataset order, up to the budget it was given, and `attempted`
 * is how many it probed; with no credential it probed none. So the first `attempted` stale rows
 * were probed, and the next one, if any, was not.
 */
function probedPrefix(rows: readonly UpstreamStatusRow[], attempted: number): number {
  let stale = 0;
  for (let i = 0; i < rows.length; i++) {
    if (isStale(rows[i] as UpstreamStatusRow)) {
      if (stale === attempted) return i;
      stale++;
    }
  }
  return rows.length;
}

async function tick(
  env: Bindings,
  opts: SchedulerOptions,
  r: SchedulerTickResult,
  moved: { cursor: string | null },
): Promise<SchedulerOutcome> {
  if (!autoRepullEnabled(env)) return "switch-off";
  const cap = repullOpenCap(env);
  if (cap.source === "unreadable") return "cap-unreadable";
  if (cap.value === 0) return "cap-zero";
  const cliVersion = opts.cliVersion ?? pkg.version;
  if (!RELEASE_VERSION.test(cliVersion)) return "cli-unreleased";
  if (!env.PRESCREEN_CALLBACK_SECRET) return "unconfigured";

  const db = env.DB;
  const proof = await db.prepare(MANUAL_RUN_PROOF_SQL).first<{ n: number }>();
  if (typeof proof?.n !== "number") throw new Error("the manual-run proof could not be read");
  if (proof.n < REPULL_G4_DATASETS.length) return "waiting-for-manual-run";
  // Advisory: a day already full costs no OpenNeuro request. The claim alone decides a unit.
  const used = (await db.prepare(OPEN_DISPATCHES_TODAY_SQL).first<{ used: number }>())?.used;
  if (typeof used !== "number") throw new Error("today's open dispatches could not be counted");
  let remaining = cap.value - used;
  if (remaining <= 0) return "cap-reached";

  const stored = await db.prepare(SCHEDULER_CURSOR_SQL).first<{ scan_after: string }>();
  if (!stored) throw new Error("the scheduler's row is missing");
  // A stored cursor that is not a dataset id restarts the rotation; it is never guessed at.
  const start = CURSOR_RE.test(stored.scan_after) ? stored.scan_after : "";
  let cursor = start;

  const ctx: TickContext = {
    env,
    cliVersion,
    timeoutMs: opts.dispatchTimeoutMs ?? UPSTREAM_REPULL_DISPATCH_TIMEOUT_MS,
    probeAuth: {},
  };
  const advance = (row: UpstreamStatusRow) => {
    r.scanned++;
    if (row.state === "stale_ready") r.staleReady++;
    if (row.state === "unchecked") r.unchecked++;
    cursor = row.dataset_id;
    moved.cursor = cursor;
  };

  let outcome: SchedulerOutcome = "ran";
  let probesLeft = REPULL_SCAN_PROBE_BUDGET;
  scan: for (let page = 0; page < REPULL_SCAN_PAGES && probesLeft > 0; page++) {
    const p = await runUpstreamStatusPage(env, {
      after: cursor,
      probeBudget: probesLeft,
      probeAuth: ctx.probeAuth,
    });
    // A batch OpenNeuro failed: its mirrors were not seen, so neither they nor the rest of the page
    // are passed by. A page whose rows are all `unchecked` with no batch failure is per-dataset
    // trouble, and is passed by below.
    if (p.errors.length > 0) {
      r.error = "openneuro-unreadable";
      outcome = "blind";
      break;
    }
    const reached = probedPrefix(p.rows, p.probes.attempted);
    for (const row of p.rows.slice(0, reached)) {
      if (isStale(row)) {
        r.probed++;
        if (row.state === "stale_unverified") r.probeUnverified++;
      }
      if (row.state !== "stale_ready") {
        advance(row);
        continue;
      }
      let c: Considered;
      try {
        c = await considerCandidate(ctx, row);
      } catch (err) {
        r.candidateErrors++;
        r.errorClass = errorClassName(err);
        const held =
          (await db.prepare(CANDIDATE_HELD_COUNT_SQL).bind(row.dataset_id).first<{ n: number }>())
            ?.n ?? 0;
        if (held >= REPULL_CANDIDATE_HOLD_TICKS - 1) {
          // It has held the rotation long enough: pass it by, so everything behind it is reached.
          r.skipped["candidate-error"] = (r.skipped["candidate-error"] ?? 0) + 1;
          advance(row);
          continue;
        }
        await db
          .prepare(CANDIDATE_HELD_AUDIT_SQL)
          .bind(row.dataset_id, r.errorClass, held + 1)
          .run();
        r.error = "candidate-failed";
        outcome = "error";
        break scan;
      }
      switch (c.kind) {
        case "skip":
          r.skipped[c.word] = (r.skipped[c.word] ?? 0) + 1;
          advance(row);
          break;
        case "dispatched":
        case "unconfirmed":
          if (c.kind === "dispatched") r.dispatched++;
          else r.unconfirmed++;
          advance(row);
          remaining--;
          if (remaining <= 0) break scan;
          break;
        case "send-failed":
          r.sendFailed++;
          r.refusedStatus = c.status;
          // A refusal the next mirror would meet too stops the tick before this mirror, so the
          // next tick starts with it; one other refusal frees its unit and the scan goes on.
          if (STOPPING_REFUSALS.has(c.status) || r.sendFailed > 1) {
            outcome = "send-refused";
            break scan;
          }
          advance(row);
          break;
        case "stop":
          outcome = c.outcome;
          break scan;
      }
    }
    if (reached < p.rows.length) {
      // Stale rows the probes did not reach: the next tick starts with the first of them.
      if (ctx.probeAuth.failure !== undefined) {
        r.error = "probe-credential-missing";
        outcome = "blind";
      } else {
        r.deferred = true;
      }
      break;
    }
    probesLeft -= p.probes.attempted;
    if (p.next_cursor === null) {
      // The end of the fleet: the next tick starts again from the first mirror.
      cursor = "";
      moved.cursor = "";
      break;
    }
  }
  if (outcome === "ran" && r.probed > 0 && r.probeUnverified === r.probed) {
    // Every probe failed (an expired token, GitHub's raw host down, a credential that cannot read
    // OpenNeuro's repositories): no stale mirror was seen, so none is passed by. The hold is
    // bounded like a candidate's, because a stale mirror whose OpenNeuro repository is gone probes
    // unverified on every pass, and holding for it alone would stop the rotation for good.
    r.error = "probes-unverified";
    // Held before anything is read or written: if the count or the audit row fails, the tick
    // stamps no new cursor, so nothing it could not see is passed by on one database error.
    const passed = moved.cursor;
    moved.cursor = null;
    const held =
      (await db.prepare(PROBES_HELD_COUNT_SQL).bind(start).first<{ n: number }>())?.n ?? 0;
    if (held < REPULL_CANDIDATE_HOLD_TICKS - 1) {
      await db
        .prepare(PROBES_HELD_AUDIT_SQL)
        .bind(start, r.probed, held + 1)
        .run();
      return "blind";
    }
    // Held long enough at this place: pass on, as far as the scan reached.
    moved.cursor = passed;
  }
  return outcome;
}

/**
 * The scheduler's daily tick. Null outside exact production, with nothing read, written or sent.
 * In production it always stamps `upstream_repull_scheduler` with its outcome and the time, and
 * with where the next tick starts when it moved the cursor; a failure is the outcome `error`,
 * never a throw, so the cron's other jobs run on.
 */
export async function runRepullSchedulerCron(
  env: Bindings,
  opts: SchedulerOptions = {},
): Promise<SchedulerTickResult | null> {
  if (!isExactProduction(env)) return null;
  const r: SchedulerTickResult = {
    outcome: "error",
    scanned: 0,
    staleReady: 0,
    unchecked: 0,
    probed: 0,
    probeUnverified: 0,
    dispatched: 0,
    sendFailed: 0,
    refusedStatus: null,
    unconfirmed: 0,
    candidateErrors: 0,
    skipped: {},
    deferred: false,
    error: null,
    errorClass: null,
  };
  const moved: { cursor: string | null } = { cursor: null };
  try {
    r.outcome = await tick(env, opts, r, moved);
  } catch (err) {
    r.outcome = "error";
    r.error = "tick-failed";
    r.errorClass = errorClassName(err);
  }
  try {
    const res = await env.DB.prepare(SCHEDULER_STAMP_SQL).bind(moved.cursor, r.outcome).run();
    if (res.meta?.changes !== 1) throw new Error("the scheduler's row is missing");
  } catch (err) {
    r.outcome = "error";
    r.error = "stamp-failed";
    r.errorClass = errorClassName(err);
  }
  return r;
}

/**
 * The tick's one log line, and its level: error for an outcome that means the tick could not do
 * its work or was not configured to, and for any dispatch GitHub refused or did not answer, any
 * mirror the report could not compare, any probe that could not answer and any candidate that
 * threw. Warn, short of that, while it skips a mirror for `unreported-streak`, which only an
 * administrator's re-pull by hand takes care of. Counts and fixed words only: the error is a
 * {@link SchedulerError} word and its class a plain identifier, never a message.
 */
export function repullSchedulerLogLine(r: SchedulerTickResult): {
  level: "info" | "warn" | "error";
  line: string;
} {
  const skipped =
    Object.entries(r.skipped)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([word, n]) => `${word}:${n}`)
      .join(",") || "none";
  const fields = [
    `outcome=${r.outcome}`,
    `scanned=${r.scanned}`,
    `stale_ready=${r.staleReady}`,
    `unchecked=${r.unchecked}`,
    `probed=${r.probed}`,
    `probe_unverified=${r.probeUnverified}`,
    `dispatched=${r.dispatched}`,
    `send_failed=${r.sendFailed}`,
    `unconfirmed=${r.unconfirmed}`,
    `candidate_error=${r.candidateErrors}`,
    `deferred=${r.deferred}`,
    `skipped=${skipped}`,
  ];
  if (r.refusedStatus !== null) fields.push(`refused_status=${r.refusedStatus}`);
  if (r.error !== null) fields.push(`error=${r.error}`);
  if (r.errorClass !== null) fields.push(`error_class=${r.errorClass}`);
  const line = `[repull-scheduler] ${fields.join(" ")}`;
  const trouble =
    TROUBLE.has(r.outcome) ||
    r.sendFailed > 0 ||
    r.unconfirmed > 0 ||
    r.unchecked > 0 ||
    r.probeUnverified > 0 ||
    r.candidateErrors > 0;
  if (trouble) return { level: "error", line };
  return { level: (r.skipped["unreported-streak"] ?? 0) > 0 ? "warn" : "info", line };
}
