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
 * automatic path for that tag), and one with a re-pull created, or a first dispatch sent, in the
 * last {@link REPULL_WINDOW_DAYS} days, except a dispatch GitHub refused (it never ran). Then the
 * create's dataset fences are read again (a mirror of that `ds`, not withdrawn, no import in
 * flight) through the record's own function. The automatic create checks everything again when
 * the run arrives.
 *
 * THE CAP. Every dispatch goes through the dispatch record's claim (`claimOpenDispatch`), which
 * counts the UTC day's `open` dispatches on D1's clock in the statement that claims the unit, so
 * nothing here can dispatch past `REPULL_DAILY_OPEN_CAP`. The day's count is also read once before
 * the scan, only so a day that is already full costs no OpenNeuro request (`cap-reached`); the
 * claim alone decides a unit. A dispatch GitHub refused (a 4xx) frees its unit; one whose answer
 * was lost (a 5xx, a lost connection, the timeout) keeps it, because it may be running.
 *
 * PRODUCTION ONLY. Outside `ENVIRONMENT` exactly `production` the tick returns null before it
 * reads or writes anything, and it is called only from the production-only daily block, absent
 * from `DEV_CRON_ALLOWLIST`: the `nemarDatasets` organization is shared with dev. In production it
 * acts only while `AUTO_REPULL_ENABLED` is exactly `"1"`, and dispatches nothing until a re-pull
 * has been run by hand to `complete` with its tag ({@link MANUAL_RUN_PROOF_SQL}), and nothing from
 * a Worker that is not a release build (the run installs the Worker's own version of the CLI).
 *
 * THE CURSOR. A tick examines at most {@link REPULL_SCAN_PAGES} pages of the report from where the
 * last one stopped (`upstream_repull_scheduler.scan_after`), so the fleet is covered in rotation,
 * and wraps to the start after the last mirror. The GitHub probes that turn a stale row into
 * `stale_ready` are bounded per tick ({@link REPULL_SCAN_PROBE_BUDGET}); a stale row the budget did
 * not reach reads `stale_unverified`, so the cursor stops before the first such row and the next
 * tick probes it, rather than passing it by until the next rotation (which would starve every
 * stale mirror behind ten ineligible ones). A page OpenNeuro could not answer, or a pass with no
 * GitHub credential, is `blind`: nothing is dispatched from what it could not see, and the cursor
 * does not move past it.
 *
 * COST on the daily tick, which shares one subrequest allowance with every daily job: per page, at
 * most 2 GraphQL requests and 3 D1 statements; at most 10 tag probes and 10 control reads; one
 * token; 6 D1 statements before the scan and one after; and per `stale_ready` mirror (at most 10,
 * one per probe) 2 statements to skip it, or about 5 to dispatch it (the blockers, the fences, the
 * claim's batch and read-back, the send), one more when GitHub refuses. About 100 in the worst case.
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
import { getDatasetsToken } from "./github-auth.js";
import {
  UPSTREAM_REPULL_DISPATCH_TIMEOUT_MS,
  buildUpstreamRepullPayload,
  triggerUpstreamRepullRun,
} from "./github/dispatch.js";
import { errorMessage } from "./repo-metadata.js";
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

/** GitHub answers these when the credential cannot reach the central repository at all. */
const SYSTEMIC_REFUSALS: ReadonlySet<number> = new Set([401, 403, 404]);
/** A version the run can install from npm as a release. */
const RELEASE_VERSION = /^\d+\.\d+\.\d+$/;
/** The outcomes an operator must see: the tick could not do its work, or was not configured to. */
const TROUBLE: ReadonlySet<SchedulerOutcome> = new Set([
  "blind",
  "error",
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
 * tag the dispatch would pull (as the dispatch record stores it, without a leading `v`). Each
 * count is 0, never NULL; `anonymous` is NULL only when the dataset's row is gone.
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
  (SELECT COUNT(*) FROM upstream_repulls
    WHERE dataset_id = ?1
      AND created_at > datetime('now', '-${REPULL_WINDOW_DAYS} days')) AS recent_rows,
  (SELECT COUNT(*) FROM upstream_repull_dispatches
    WHERE dataset_id = ?1 AND kind = 'open' AND repull_id IS NULL
      AND status <> 'dispatch_failed'
      AND dispatched_at > datetime('now', '-${REPULL_WINDOW_DAYS} days')) AS recent_dispatches`;

/**
 * The proof that the first re-pulls were run by hand (gate G4 of the design record, encoded): a
 * re-pull of an `on` mirror an administrator ran to `complete`, its tag recorded. Until one exists
 * in this database the scheduler dispatches nothing (`waiting-for-manual-run`).
 */
export const MANUAL_RUN_PROOF_SQL = `SELECT COUNT(*) AS n FROM upstream_repulls
  WHERE origin = 'administrator' AND status = 'complete' AND tag_sha IS NOT NULL
    AND dataset_id GLOB 'on[0-9][0-9][0-9][0-9][0-9][0-9]'`;

/** Where the last tick stopped: a dataset id, or '' for the start of the fleet. */
export const SCHEDULER_CURSOR_SQL = "SELECT scan_after FROM upstream_repull_scheduler WHERE id = 1";

/**
 * Stamp the tick, in one statement: `?1` the new cursor (NULL keeps the stored one, for a tick
 * that stopped before its scan), `?2` the outcome.
 */
export const SCHEDULER_STAMP_SQL = `UPDATE upstream_repull_scheduler
  SET scan_after = COALESCE(?1, scan_after), last_tick_at = datetime('now'), last_outcome = ?2
  WHERE id = 1`;

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
  | "recent";

const COUNTS = [
  "unreconciled",
  "open_rows",
  "live",
  "final_refusals",
  "recent_rows",
  "recent_dispatches",
] as const satisfies readonly (keyof CandidateBlockers)[];

/**
 * Why the facts forbid a dispatch, or null when they allow one. A dataset is dispatched only when
 * it says `anonymous` is exactly 0: a NULL (the row is gone) is `missing`, and any other value is
 * `anonymous`, because unknown is never clean. A count that is not a number is a defect, and the
 * tick stops rather than read it as zero.
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
  /** GitHub refused it (a 4xx): ended `dispatch_failed`, its unit freed. */
  | { kind: "send-failed"; systemic: boolean }
  /** The claim says the tick cannot go on (the day is full, or the Worker cannot claim at all). */
  | { kind: "stop"; outcome: SchedulerOutcome };

interface TickContext {
  env: Bindings;
  cliVersion: string;
  timeoutMs: number;
  /** The GitHub credential of the tick: the probes' token, or minted once for the dispatch. */
  pat: () => Promise<string>;
}

async function considerCandidate(ctx: TickContext, row: UpstreamStatusRow): Promise<Considered> {
  const { env } = ctx;
  const ds = row.ds;
  const fromTag = row.recorded?.tag ?? null;
  const toTag = row.upstream?.latest_tag ?? null;
  if (ds === null || fromTag === null || toTag === null)
    return { kind: "skip", word: "incomplete" };
  const to = normalizeUpstreamTag(toTag);

  const blockers = await env.DB.prepare(CANDIDATE_BLOCKERS_SQL)
    .bind(row.dataset_id, to)
    .first<CandidateBlockers>();
  const skip = candidateSkip(blockers);
  if (skip) return { kind: "skip", word: skip };
  const fenced = await datasetFenceRefusal(env.DB, { dataset_id: row.dataset_id, upstream_ds: ds });
  if (fenced) return { kind: "skip", word: fenced.code };

  // The credential first: a claim made and then not sent would hold a unit and the live slot.
  const pat = await ctx.pat();
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
      toTag: to,
      dispatchId: claim.id,
      repullId: null,
      token: claim.token,
      cliVersion: ctx.cliVersion,
    });
  } catch (err) {
    // Nothing was sent, so the claim must not hold its unit and the live slot until the watchdog.
    await markDispatchSendFailed(env.DB, claim.id, "dispatch-failed");
    throw err;
  }
  const sent = await triggerUpstreamRepullRun(payload, pat, { timeoutMs: ctx.timeoutMs });
  if (sent === "sent") return { kind: "dispatched" };
  if (sent === "unknown") return { kind: "unconfirmed" };
  await markDispatchSendFailed(env.DB, claim.id, "dispatch-refused");
  return { kind: "send-failed", systemic: SYSTEMIC_REFUSALS.has(sent.refused) };
}

// ----------------------------------------------------------------------------
// The tick
// ----------------------------------------------------------------------------

export interface SchedulerTickResult {
  outcome: SchedulerOutcome;
  /** Mirrors the cursor moved past this tick. */
  scanned: number;
  /** Of them, the `stale_ready` ones (dispatched or skipped). */
  staleReady: number;
  /** Dispatches GitHub took. */
  dispatched: number;
  /** Dispatches GitHub refused (a 4xx): ended `dispatch_failed`, their units freed. */
  sendFailed: number;
  /** Dispatches whose answer was lost: still `dispatched`, their units kept. */
  unconfirmed: number;
  /** Why each `stale_ready` mirror that was not dispatched was skipped, by word. */
  skipped: Record<string, number>;
  /** The probe budget ran out before the stale rows did; the next tick starts at the first left. */
  deferred: boolean;
  /** For `error`: what failed. */
  error: string | null;
}

export interface SchedulerOptions {
  /** The CLI version the run installs; the Worker's own (`package.json`) by default. */
  cliVersion?: string;
  /** How long a dispatch waits for GitHub; {@link UPSTREAM_REPULL_DISPATCH_TIMEOUT_MS} by default. */
  dispatchTimeoutMs?: number;
}

/**
 * The index of the first stale row the probes did not reach, or the page's length. The report
 * probes the stale rows of a page in dataset order, up to the budget it was given, and `attempted`
 * is how many it probed; with no credential it probed none. So the first `attempted` stale rows
 * were probed, and the next one, if any, was not.
 */
function probedPrefix(rows: readonly UpstreamStatusRow[], attempted: number): number {
  let stale = 0;
  for (let i = 0; i < rows.length; i++) {
    if ((STALE_STATES as readonly string[]).includes((rows[i] as UpstreamStatusRow).state)) {
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
  if (proof.n === 0) return "waiting-for-manual-run";
  // Advisory: a day already full costs no OpenNeuro request. The claim alone decides a unit.
  const used = (await db.prepare(OPEN_DISPATCHES_TODAY_SQL).first<{ used: number }>())?.used;
  if (typeof used !== "number") throw new Error("today's open dispatches could not be counted");
  let remaining = cap.value - used;
  if (remaining <= 0) return "cap-reached";

  const stored = await db.prepare(SCHEDULER_CURSOR_SQL).first<{ scan_after: string }>();
  if (!stored) throw new Error("the scheduler's row is missing");
  // A stored cursor that is not a dataset id restarts the rotation; it is never guessed at.
  let cursor = CURSOR_RE.test(stored.scan_after) ? stored.scan_after : "";

  const probeAuth: ProbeAuth = {};
  let minted: Promise<string> | null = null;
  const ctx: TickContext = {
    env,
    cliVersion,
    timeoutMs: opts.dispatchTimeoutMs ?? UPSTREAM_REPULL_DISPATCH_TIMEOUT_MS,
    pat: () => {
      if (probeAuth.pat !== undefined) return Promise.resolve(probeAuth.pat);
      minted ??= getDatasetsToken(env);
      return minted;
    },
  };
  const advance = (row: UpstreamStatusRow) => {
    r.scanned++;
    if (row.state === "stale_ready") r.staleReady++;
    cursor = row.dataset_id;
    moved.cursor = cursor;
  };

  let probesLeft = REPULL_SCAN_PROBE_BUDGET;
  for (let page = 0; page < REPULL_SCAN_PAGES && probesLeft > 0; page++) {
    const p = await runUpstreamStatusPage(env, {
      after: cursor,
      probeBudget: probesLeft,
      probeAuth,
    });
    if (!p.ok) return "blind";
    const reached = probedPrefix(p.rows, p.probes.attempted);
    for (const row of p.rows.slice(0, reached)) {
      if (row.state !== "stale_ready") {
        advance(row);
        continue;
      }
      const c = await considerCandidate(ctx, row);
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
          if (remaining <= 0) return "ran";
          break;
        case "send-failed":
          r.sendFailed++;
          // A credential that cannot reach the central repository is no fault of this mirror:
          // stop, and leave the cursor before it so the next tick starts with it.
          if (c.systemic) return "ran";
          advance(row);
          break;
        case "stop":
          return c.outcome;
      }
    }
    if (reached < p.rows.length) {
      // Stale rows the probes did not reach: the next tick starts with the first of them.
      if (probeAuth.failure !== undefined) return "blind";
      r.deferred = true;
      return "ran";
    }
    probesLeft -= p.probes.attempted;
    if (p.next_cursor === null) {
      // The end of the fleet: the next tick starts again from the first mirror.
      cursor = "";
      moved.cursor = "";
      return "ran";
    }
  }
  return "ran";
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
    dispatched: 0,
    sendFailed: 0,
    unconfirmed: 0,
    skipped: {},
    deferred: false,
    error: null,
  };
  const moved: { cursor: string | null } = { cursor: null };
  try {
    r.outcome = await tick(env, opts, r, moved);
  } catch (err) {
    r.outcome = "error";
    r.error = errorMessage(err);
  }
  try {
    const res = await env.DB.prepare(SCHEDULER_STAMP_SQL).bind(moved.cursor, r.outcome).run();
    if (res.meta?.changes !== 1) throw new Error("the scheduler's row is missing");
  } catch (err) {
    r.error = [r.error, `the tick could not be stamped: ${errorMessage(err)}`]
      .filter((e) => e !== null)
      .join("; ");
    r.outcome = "error";
  }
  return r;
}

/**
 * The tick's one log line, and its level: error for an outcome that means the tick could not do
 * its work or was not configured to, and for any dispatch GitHub refused or did not answer.
 * Counts and fixed words only.
 */
export function repullSchedulerLogLine(r: SchedulerTickResult): {
  level: "info" | "error";
  line: string;
} {
  const skipped =
    Object.entries(r.skipped)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([word, n]) => `${word}:${n}`)
      .join(",") || "none";
  const line =
    `[repull-scheduler] outcome=${r.outcome} scanned=${r.scanned} stale_ready=${r.staleReady} ` +
    `dispatched=${r.dispatched} send_failed=${r.sendFailed} unconfirmed=${r.unconfirmed} ` +
    `deferred=${r.deferred} skipped=${skipped}${r.error ? ` error=${JSON.stringify(r.error)}` : ""}`;
  const trouble = TROUBLE.has(r.outcome) || r.sendFailed > 0 || r.unconfirmed > 0;
  return { level: trouble ? "error" : "info", line };
}
