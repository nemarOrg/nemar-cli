/**
 * The partner's hold reaper (epic #2021 phase D4, #2025; ADR 0118, the amendment of this phase; design
 * section 6): `reapExpiredHolds(env)`, called from the 30-minute tick's production block. It resolves
 * the three things the partner contract leaves open between two ticks, each a bounded list, each row
 * stamped BEFORE its step (so a row that cannot be resolved goes to the back of the line and never holds a
 * slot for good):
 *
 *  1. RESERVATIONS that no Tapis job was reported under: a `created` partner job older than the owner's
 *     reservation wait (`policy.reservationWaitMinutes`, 30 minutes by default), or one the person
 *     cancelled. Tapis is ASKED FIRST, by the reservation's tag (`nemar_job:<id>`), and the answer decides:
 *       - no Tapis job that no row accounts for, affirmatively (the search succeeded and found none) AND
 *         the owner has confirmed that NEMAR's service identity can see the tenant's jobs
 *         (`policy.partner.tapisVisibilityConfirmed`): the hold is released, with the ledger reason
 *         `expired` (`endPartnerReservation`). Unconfirmed, an empty answer proves nothing (a tenant NEMAR
 *         cannot see into answers empty for a job that is running) and the hold is KEPT, logged at warn;
 *       - exactly one: it is bound to the reservation as if the partner had reported it and then verified
 *         (the same read-back), or, when it is owned by someone else, when the reservation was cancelled or
 *         when the person's compute has ended since, refused (`owner_mismatch` / `hold_ended`): cancelled
 *         at Tapis, the hold released, what ran charged to the partner's pool;
 *       - several owned by the reservation's Tapis username (a tagged job another owner submitted does not
 *         make a reservation ambiguous; the tenant sweep accounts for it): flagged `ambiguous_tag` and the
 *         hold KEPT (a person looks; the tenant sweep accounts the
 *         ones that skipped the reservation, and then none is left to be ambiguous);
 *       - ANY Tapis error: the hold is KEPT, `tapis_unreachable` is recorded, and the next tick asks again.
 *         NOTHING IS EVER RELEASED ON AN ERROR.
 *  2. `pending` rows (a Tapis job bound and not yet verified, because Tapis could not be read when the
 *     partner reported): verified now. A binding whose job Tapis keeps answering 404 for is withdrawn after
 *     a time: the row is a reservation again, and branch 1 resolves it by tag. A job NEMAR cannot read for
 *     two hours is refused as `unverifiable` (cancelled blind, the hold released, the partner's pool
 *     charged), logged at warn.
 *  3. `mismatch` rows (a refusal recorded as intent): carried out (`finishMismatch`): the Tapis job
 *     cancelled, the hold released and what ran charged to the partner's pool. A cancel that does not take
 *     keeps the row (its slot is NOT released until a read shows the job over) and is counted in
 *     `cancel_pending_failed` after an hour, which the status view and the cancel sweep's line carry.
 *  4. Idempotency keys older than {@link IDEMPOTENCY_KEEP_DAYS} days are deleted, a bounded batch a tick.
 *
 * A TAPIS CALL NEVER RUNS INSIDE A BATCH: every batch records an intent or a state, and a retried tick
 * performs the call. TAPIS HAS NO IDEMPOTENCY KEY: a reservation is searched before it is released, and a
 * cancel is asked again until a read shows the job is over.
 *
 * PRODUCTION ONLY, and deliberately NOT in `DEV_CRON_ALLOWLIST`: it moves the allocation ledger and
 * cancels jobs in a tenant, and the dev database shares real users. It refuses outside exact production on
 * its own and reads no compute switch (a hold is released and a refusal carried out whether or not compute
 * is on). BOUNDED: `REAPER_ROWS_PER_LIST` rows of each list a tick, each costing a handful of Tapis
 * requests, far below the Worker's allowance of 10,000 subrequests an invocation. One log line a tick,
 * only when it acted or failed: counts and fixed words, never a job id, a tag or a name.
 */

import type { Bindings } from "../types/bindings.js";
import { type ComputeJobRow, getJob } from "./compute-jobs.js";
import {
  STAMP_EXAMINED_SQL,
  TICK_READ,
  endPartnerReservation,
  errorClassName,
  tapisAccess,
} from "./compute-lifecycle.js";
import { getPolicy } from "./compute-policy.js";
import {
  BIND_ADOPT_SQL,
  checkReport,
  finishMismatch,
  isNemarsOwnJob,
  pinOf,
  recordMismatch,
  verifyBoundJob,
} from "./compute-report-verify.js";
import { isExactProduction } from "./repull-switches.js";
import {
  type TapisContext,
  type TapisJob,
  getJob as getTapisJob,
  nemarJobTag,
  searchJobsByTag,
} from "./tapis/client.js";
import { TapisError } from "./tapis/errors.js";
import { TAPIS_JOB_UUID_RE } from "./tapis/schemas.js";

/**
 * How long past a reservation's expiry the tenant sweep still leaves a partner's job alone while its
 * reservation waits for the report: the reaper (which runs on the same tick) resolves a reservation the
 * first tick after the expiry, and the grace is two ticks so the sweep never indexes and cancels a job the
 * reaper is about to bind.
 */
export const SWEEP_DEFER_GRACE_MINUTES = 60;

/** The reaper's tick, in minutes: one backlog of {@link REAPER_ROWS_PER_LIST} reservations a tick. */
export const REAPER_TICK_MINUTES = 30;

/** The most the grace is extended for a backlog the reaper has not drained (six ticks). */
export const SWEEP_DEFER_BACKLOG_MAX_MINUTES = 6 * REAPER_TICK_MINUTES;

/** The most deferral candidates one sweep reads in full; one beyond it is not deferred. */
export const SWEEP_DEFER_MAX_READS = 100;

/** Reservations ahead of one in the reaper's line: expired, unreported, unbound, and expiring earlier. `?1` its expiry. */
const BACKLOG_AHEAD_SQL = `SELECT COUNT(*) AS n FROM compute_jobs INDEXED BY compute_jobs_partner_open
  WHERE source = 'partner' AND tapis_uuid IS NULL AND state = 'created' AND partner_state IS NULL
    AND partner_expires_at < ?1 AND partner_expires_at < datetime('now')`;

const NEMAR_TAG_PREFIX = "nemar_job:";

/** The ids of the NEMAR tags a record carries (every tag that begins with the prefix, valid or not). */
function nemarTagsOf(rec: Pick<TapisJob, "tags">): string[] {
  return (rec.tags ?? [])
    .filter((t): t is string => typeof t === "string" && t.startsWith(NEMAR_TAG_PREFIX))
    .map((t) => t.slice(NEMAR_TAG_PREFIX.length));
}

/** The Tapis usernames of the reservations that are open (unbound, not refused): who a sheltered job may belong to. */
const OPEN_OWNERS_SQL = `SELECT DISTINCT tapis_owner FROM compute_jobs INDEXED BY compute_jobs_partner_open
  WHERE source = 'partner' AND tapis_uuid IS NULL AND state = 'created' AND partner_state IS NULL
    AND cancel_requested_at IS NULL AND tapis_owner IS NOT NULL LIMIT 1000`;

/**
 * Which of the unbound Tapis jobs of a tenant listing are partner jobs launched under a LIVE reservation
 * whose report has not come yet: the sweep (phase A7) leaves those alone, because the report about to bind
 * one, or the reaper that binds it after the expiry, accounts for it, and cancelling it as a job that
 * skipped the reservation would refuse a legitimate report (`tapis_job_in_use`). A tag proves nothing, and
 * anything can write one, so a job is deferred ONLY when all of this holds:
 *   - its listed owner is the Tapis username of an open reservation (the listing carries no tags, so the
 *     owner is the cheap first cut) and NEMAR's read of it shows exactly one NEMAR tag;
 *   - a search of the tenant by that tag finds exactly ONE job, this one (a second job under the tag makes
 *     the reservation ambiguous, and nothing is sheltered);
 *   - the tag names a partner reservation that is unbound, not cancelled, not flagged, whose Tapis username
 *     is the job's owner, and which is inside its expiry plus the grace (extended while the reaper has a
 *     backlog it has not drained, at most {@link SWEEP_DEFER_BACKLOG_MAX_MINUTES});
 *   - and the read passes the report check (`checkReport`), so a job that is the wrong application, queue
 *     or size is not sheltered.
 * The caller removes these BEFORE it takes its per-run slice, so a sheltered job never uses a slot. At most
 * {@link SWEEP_DEFER_MAX_READS} candidates are read in full; one past that is not deferred (it goes the
 * sweep's own way, which is the safe one).
 */
export async function awaitingPartnerReports(
  env: Bindings,
  ctx: TapisContext,
  candidates: TapisJob[],
): Promise<Set<string>> {
  const awaiting = new Set<string>();
  if (candidates.length === 0) return awaiting;
  const owners = new Set(
    (await env.DB.prepare(OPEN_OWNERS_SQL).all<{ tapis_owner: string }>()).results.map(
      (r) => r.tapis_owner,
    ),
  );
  if (owners.size === 0) return awaiting;
  const policy = (await getPolicy(env.DB)).policy;
  const pin = policy.partner;
  const wait = policy.reservationWaitMinutes;
  let reads = 0;
  for (const cand of candidates) {
    if (typeof cand.owner !== "string" || !owners.has(cand.owner)) continue;
    if (reads >= SWEEP_DEFER_MAX_READS) break;
    reads++;
    try {
      const full = await getTapisJob(ctx, cand.uuid);
      const tags = nemarTagsOf(full);
      const id = tags[0];
      if (full.uuid !== cand.uuid || tags.length !== 1 || id === undefined) continue;
      if (!/^job_[0-9a-f]{24}$/.test(id)) continue;
      const row = await getJob(env.DB, id);
      if (
        row === null ||
        row.source !== "partner" ||
        row.flag_unreserved === 1 ||
        row.state !== "created" ||
        row.tapis_uuid !== null ||
        row.partner_state !== null ||
        row.cancel_requested_at !== null ||
        (row.partner_flag !== null && row.partner_flag !== "tapis_unreachable") ||
        row.tapis_owner === null ||
        full.owner !== row.tapis_owner ||
        isNemarsOwnJob(ctx, full, row.id)
      ) {
        continue;
      }
      const expiresAt = row.partner_expires_at ?? plusMinutesOf(row.created_at, wait);
      const expiresMs = Date.parse(`${expiresAt.replace(" ", "T")}Z`);
      if (!Number.isFinite(expiresMs)) continue;
      let grace = SWEEP_DEFER_GRACE_MINUTES;
      if (Date.now() >= expiresMs) {
        const ahead =
          (await env.DB.prepare(BACKLOG_AHEAD_SQL).bind(expiresAt).first<{ n: number }>())?.n ?? 0;
        grace += Math.min(
          SWEEP_DEFER_BACKLOG_MAX_MINUTES,
          Math.floor(ahead / REAPER_ROWS_PER_LIST) * REAPER_TICK_MINUTES,
        );
      }
      if (Date.now() >= expiresMs + grace * 60_000) continue;
      const tagged = await searchJobsByTag(ctx, nemarJobTag(row.id));
      if (tagged.length !== 1 || tagged[0]?.uuid !== cand.uuid) continue;
      if (checkReport(row, full, pinOf(pin)).ok) awaiting.add(cand.uuid);
    } catch {
      // Not read: not deferred. The job goes through the sweep's own path, which reads it again.
    }
  }
  return awaiting;
}

function plusMinutesOf(sqlTime: string, minutes: number): string {
  return new Date(Date.parse(`${sqlTime.replace(" ", "T")}Z`) + minutes * 60_000)
    .toISOString()
    .slice(0, 19)
    .replace("T", " ");
}

/** Rows of each list one tick takes at most. */
export const REAPER_ROWS_PER_LIST = 25;

/** A binding whose Tapis job keeps answering 404 for this long is withdrawn (the row is a reservation again). */
export const PENDING_GONE_GIVE_UP_MINUTES = 240;

/**
 * The reservations to resolve: `created`, no Tapis job, not yet reported, older than the wait `?1` (minutes)
 * or with a cancel recorded; least recently examined first. Past its EXPIRY is the time stored on the row when
 * the reservation was made (the wait of that day, not today's). The statement NAMES the partial index
 * `compute_jobs_partner_open` (the planner otherwise takes the unique index on the Tapis uuid and sorts), and
 * `compute-partner-migration.test.ts` pins the plan.
 */
export const OPEN_RESERVATIONS_SQL = `SELECT id FROM compute_jobs INDEXED BY compute_jobs_partner_open
  WHERE source = 'partner' AND tapis_uuid IS NULL AND state = 'created' AND partner_state IS NULL
    AND (COALESCE(partner_expires_at, datetime(created_at, '+' || ?1 || ' minutes')) < datetime('now')
         OR cancel_requested_at IS NOT NULL)
  ORDER BY examined_at ASC, created_at ASC LIMIT ?2`;

/** The rows `pending` or `mismatch` and not yet over, least recently examined first. */
export const UNVERIFIED_ROWS_SQL = `SELECT id FROM compute_jobs INDEXED BY compute_jobs_partner_unverified
  WHERE partner_state IN ('pending', 'mismatch') AND state = 'created'
  ORDER BY examined_at ASC, created_at ASC LIMIT ?1`;

/** A partner's `Idempotency-Key` is replayable for this many days; older rows are deleted. */
export const IDEMPOTENCY_KEEP_DAYS = 7;

/** Idempotency rows one tick deletes at most. */
export const PRUNE_KEYS_PER_TICK = 500;

/** The oldest idempotency keys past their keep. `?1` the days, `?2` the most rows. */
export const PRUNE_KEYS_SQL = `DELETE FROM compute_idempotency_keys WHERE rowid IN (
  SELECT rowid FROM compute_idempotency_keys
  WHERE created_at < datetime('now', '-' || ?1 || ' days') ORDER BY created_at ASC LIMIT ?2)`;

/** A Tapis uuid some row accounts for (as its job or its orphan): not the reaper's to adopt. `?1` the uuid. */
const ACCOUNTED_SQL =
  "SELECT 1 AS accounted FROM compute_jobs WHERE tapis_uuid = ?1 OR orphan_tapis_uuid = ?1 LIMIT 1";

/** The flag a reservation carries while Tapis could not be asked. `?1` the job. */
const UNREACHABLE_SQL = `UPDATE compute_jobs SET partner_flag = 'tapis_unreachable'
  WHERE id = ?1 AND tapis_uuid IS NULL AND partner_state IS NULL AND state = 'created'`;

/** The flag a reservation carries when several Tapis jobs sit under its tag. `?1` the job. */
const AMBIGUOUS_SQL = `UPDATE compute_jobs SET partner_flag = 'ambiguous_tag', flag_mismatch = 1
  WHERE id = ?1 AND tapis_uuid IS NULL AND partner_state IS NULL AND state = 'created'`;

/** A look that succeeded clears an earlier `tapis_unreachable`. `?1` the job. */
const REACHABLE_SQL = `UPDATE compute_jobs SET partner_flag = NULL
  WHERE id = ?1 AND partner_flag = 'tapis_unreachable' AND partner_state IS NULL`;

/** A binding withdrawn: the row is a reservation again. `?1` the job, `?2` the uuid. */
const WITHDRAW_SQL = `UPDATE compute_jobs SET tapis_uuid = NULL, partner_state = NULL,
    partner_flag = 'tapis_job_not_found', tapis_status = NULL, flag_mismatch = 1
  WHERE id = ?1 AND tapis_uuid = ?2 AND partner_state = 'pending' AND state = 'created'`;

export interface HoldReaperResult {
  /** Reservations taken this tick. */
  examined: number;
  /** Released, nothing found under the tag. */
  released: number;
  /** One Tapis job found under the tag and bound to the reservation (it is then verified or refused). */
  adopted: number;
  /** Several Tapis jobs under one tag: kept and flagged. */
  ambiguous: number;
  /** Tapis could not be asked: kept. */
  unreachable: number;
  /** `pending` rows taken, and how many were verified or refused this tick. */
  pending: number;
  verified: number;
  refused: number;
  /** Withdrawn bindings (a Tapis job that never existed). */
  withdrawn: number;
  /** Bound jobs NEMAR could not read, on three ticks over two hours, refused as `unverifiable`. */
  unverifiable: number;
  /** Jobs refused as `unverifiable` that could be read, matched and were verified after all. */
  recovered: number;
  /** Empty searches that were NOT acted on because the owner has not confirmed NEMAR can see the tenant. */
  unconfirmed: number;
  /** Idempotency keys deleted. */
  pruned: number;
  /** `mismatch` rows taken, and how many were ended. */
  mismatches: number;
  ended: number;
  /** Fixed words; never a message. */
  errors: string[];
  errorClass: string | null;
}

const empty = (): HoldReaperResult => ({
  examined: 0,
  released: 0,
  adopted: 0,
  ambiguous: 0,
  unreachable: 0,
  pending: 0,
  verified: 0,
  refused: 0,
  withdrawn: 0,
  unverifiable: 0,
  recovered: 0,
  unconfirmed: 0,
  pruned: 0,
  mismatches: 0,
  ended: 0,
  errors: [],
  errorClass: null,
});

function tapisKind(err: unknown): string {
  return err instanceof TapisError ? err.kind : errorClassName(err);
}

/** Resolve one reservation. Never releases on an error. */
async function resolveReservation(
  env: Bindings,
  ctx: TapisContext | null,
  job: ComputeJobRow,
  r: HoldReaperResult,
  visibilityConfirmed: boolean,
): Promise<void> {
  const db = env.DB;
  if (ctx === null) {
    r.unreachable++;
    await db.prepare(UNREACHABLE_SQL).bind(job.id).run();
    return;
  }
  // 1. ASK TAPIS FIRST. The tag search is the authority; a failed search is not an answer.
  let found: TapisJob[];
  try {
    found = await searchJobsByTag(ctx, nemarJobTag(job.id));
  } catch (err) {
    r.unreachable++;
    console.warn(`[compute-reaper] search_failed kind=${tapisKind(err)}`);
    await db.prepare(UNREACHABLE_SQL).bind(job.id).run();
    return;
  }
  await db.prepare(REACHABLE_SQL).bind(job.id).run();

  // The ones no row accounts for are the reservation's to resolve; one a row already holds (a report, an
  // orphan, the tenant sweep's index) is accounted.
  const unaccounted: TapisJob[] = [];
  for (const listed of found) {
    if (!TAPIS_JOB_UUID_RE.test(listed.uuid)) continue;
    const taken = await db.prepare(ACCOUNTED_SQL).bind(listed.uuid).first();
    if (taken === null) unaccounted.push(listed);
  }

  if (unaccounted.length === 0) {
    // None, affirmatively: the search succeeded and no Tapis job is unaccounted for. That is evidence only
    // when NEMAR's identity can see the tenant's jobs, which the owner confirms (`policy.partner`); until
    // then an empty answer is kept, not acted on.
    if (!visibilityConfirmed) {
      r.unconfirmed++;
      return;
    }
    // Release with the reason `expired`. The statement binds "no Tapis job" itself, so a report that bound
    // one since wins.
    const fresh = (await getJob(db, job.id)) ?? job;
    if (await endPartnerReservation(env, fresh, "hold_expired")) r.released++;
    return;
  }
  // Ambiguity is counted among the jobs the reservation's Tapis username owns: a job another owner tagged is
  // not this person's and cannot keep a reservation open by being added (the sweep accounts for it); when
  // none is the person's, the tagged jobs are all there is.
  const own = unaccounted.filter((u) => u.owner === job.tapis_owner);
  const candidates = own.length > 0 ? own : unaccounted;
  if (candidates.length > 1) {
    r.ambiguous++;
    await db.prepare(AMBIGUOUS_SQL).bind(job.id).run();
    return;
  }

  // Exactly one. Read it in full (a search answer is a summary), then bind it.
  const listed = candidates[0] as TapisJob;
  let rec: TapisJob;
  try {
    rec = await getTapisJob(ctx, listed.uuid);
  } catch (err) {
    r.unreachable++;
    console.warn(`[compute-reaper] read_failed kind=${tapisKind(err)}`);
    await db.prepare(UNREACHABLE_SQL).bind(job.id).run();
    return;
  }
  if (isNemarsOwnJob(ctx, rec, job.id)) {
    // NEMAR's own job under a partner's tag: never bound, never cancelled on a tag. A person looks.
    r.ambiguous++;
    await db.prepare(AMBIGUOUS_SQL).bind(job.id).run();
    return;
  }
  const bound = await db
    .prepare(BIND_ADOPT_SQL)
    .bind(job.id, rec.uuid, rec.status)
    .run()
    .catch((err) => {
      if (/UNIQUE constraint failed/i.test(String(err))) return null;
      throw err;
    });
  if (bound === null || (bound.meta?.changes ?? 0) !== 1) return; // accounted since, or the row moved
  r.adopted++;
  const row = (await getJob(db, job.id)) as ComputeJobRow;
  const ended = await personStandingEnded(db, row);
  if (ended || row.cancel_requested_at !== null) {
    // The reservation was cancelled, or the person's compute ended after it was made: the job is not
    // verified into a live one. It is refused, cancelled at Tapis and charged to the partner.
    await recordMismatch(env, row, rec.uuid, "hold_ended", rec);
    r.refused++;
    await carryOut(env, job.id, r);
    return;
  }
  const outcome = await verifyBoundJob(env, job.id, { record: rec, read: TICK_READ });
  if (outcome.kind === "verified") r.verified++;
  else if (outcome.kind === "mismatch") {
    r.refused++;
    await carryOut(env, job.id, r);
  }
}

/** Carry a recorded refusal out, and count how it ended. */
async function carryOut(env: Bindings, id: string, r: HoldReaperResult): Promise<void> {
  const outcome = await finishMismatch(env, id, TICK_READ);
  if (outcome === "ended") r.ended++;
  else if (outcome === "recovered") r.recovered++;
}

const STANDING_SQL = "SELECT compute_access FROM users WHERE id = ?1 AND deleted_at IS NULL";

/** Whether the person's compute is no longer `active` (suspended, revoked, denied, or the account deleted). */
async function personStandingEnded(db: D1Database, job: ComputeJobRow): Promise<boolean> {
  if (job.account_id === null) return true;
  const row = await db
    .prepare(STANDING_SQL)
    .bind(job.account_id)
    .first<{ compute_access: string }>();
  return row?.compute_access !== "active";
}

/** Verify one `pending` row, or withdraw a binding Tapis keeps saying it does not have. */
async function resolvePending(
  env: Bindings,
  job: ComputeJobRow,
  r: HoldReaperResult,
): Promise<void> {
  r.pending++;
  const outcome = await verifyBoundJob(env, job.id, { read: TICK_READ, tick: true });
  if (outcome.kind === "verified") {
    r.verified++;
  } else if (outcome.kind === "mismatch") {
    r.refused++;
    if (outcome.flag === "unverifiable") r.unverifiable++;
    await carryOut(env, job.id, r);
  } else if (outcome.kind === "pending" && outcome.gone === true && job.tapis_uuid !== null) {
    const boundAt = Date.parse(`${(job.submitted_at ?? job.created_at).replace(" ", "T")}Z`);
    if (Number.isFinite(boundAt) && Date.now() - boundAt > PENDING_GONE_GIVE_UP_MINUTES * 60_000) {
      const wrote = await env.DB.prepare(WITHDRAW_SQL).bind(job.id, job.tapis_uuid).run();
      if ((wrote.meta?.changes ?? 0) === 1) r.withdrawn++;
    }
  }
}

/**
 * One tick. Null outside exact production, before anything is read or written. A row's failure is a fixed
 * word and the error's class and never stops the rest.
 */
export async function reapExpiredHolds(env: Bindings): Promise<HoldReaperResult | null> {
  if (!isExactProduction(env)) return null;
  const r = empty();
  const db = env.DB;
  try {
    const policy = (await getPolicy(db)).policy;
    const wait = policy.reservationWaitMinutes;
    const confirmed = policy.partner?.tapisVisibilityConfirmed === true;

    const reservations = (
      await db.prepare(OPEN_RESERVATIONS_SQL).bind(wait, REAPER_ROWS_PER_LIST).all<{ id: string }>()
    ).results;
    r.examined = reservations.length;
    const ctx = reservations.length > 0 ? tapisAccess(env, TICK_READ) : null;
    for (const { id } of reservations) {
      try {
        await db.prepare(STAMP_EXAMINED_SQL).bind(id).run();
        const job = await getJob(db, id);
        if (job && job.partner_state === null && job.tapis_uuid === null) {
          await resolveReservation(env, ctx, job, r, confirmed);
        }
      } catch (err) {
        r.errors.push("reservation_failed");
        r.errorClass = errorClassName(err);
        console.error(`[compute-reaper] a reservation failed (${r.errorClass})`);
      }
    }

    const unverified = (
      await db.prepare(UNVERIFIED_ROWS_SQL).bind(REAPER_ROWS_PER_LIST).all<{ id: string }>()
    ).results;
    for (const { id } of unverified) {
      try {
        await db.prepare(STAMP_EXAMINED_SQL).bind(id).run();
        const job = await getJob(db, id);
        if (job?.partner_state === "pending") await resolvePending(env, job, r);
        else if (job?.partner_state === "mismatch") {
          r.mismatches++;
          await carryOut(env, id, r);
        }
      } catch (err) {
        r.errors.push("unverified_failed");
        r.errorClass = errorClassName(err);
        console.error(`[compute-reaper] an unverified row failed (${r.errorClass})`);
      }
    }
    // Keys nobody can replay any more: a bounded batch a tick, oldest first.
    try {
      const gone = await db
        .prepare(PRUNE_KEYS_SQL)
        .bind(IDEMPOTENCY_KEEP_DAYS, PRUNE_KEYS_PER_TICK)
        .run();
      r.pruned = gone.meta?.changes ?? 0;
    } catch (err) {
      r.errors.push("prune_failed");
      r.errorClass = errorClassName(err);
    }
  } catch (err) {
    r.errors.push("tick_failed");
    r.errorClass = errorClassName(err);
  }
  return r;
}

/** The tick's one log line, or null when it did nothing and nothing failed. Counts and fixed words only. */
export function holdReaperLogLine(
  r: HoldReaperResult,
): { level: "info" | "warn" | "error"; line: string } | null {
  const acted =
    r.released +
    r.adopted +
    r.ambiguous +
    r.unreachable +
    r.pending +
    r.mismatches +
    r.withdrawn +
    r.unverifiable +
    r.recovered +
    r.unconfirmed +
    r.pruned;
  if (acted === 0 && r.errors.length === 0) return null;
  const level =
    r.errors.length > 0
      ? "error"
      : r.unreachable > 0 ||
          r.ambiguous > 0 ||
          r.unverifiable > 0 ||
          r.recovered > 0 ||
          r.unconfirmed > 0
        ? "warn"
        : "info";
  return {
    level,
    line:
      `[compute-reaper] examined=${r.examined} released=${r.released} adopted=${r.adopted}` +
      ` ambiguous=${r.ambiguous} unreachable=${r.unreachable} pending=${r.pending}` +
      ` verified=${r.verified} refused=${r.refused} withdrawn=${r.withdrawn}` +
      ` unverifiable=${r.unverifiable} recovered=${r.recovered} unconfirmed=${r.unconfirmed} pruned=${r.pruned}` +
      ` mismatches=${r.mismatches} ended=${r.ended}` +
      ` errors=${r.errors.length > 0 ? r.errors.join(",") : "none"}${r.errorClass === null ? "" : ` class=${r.errorClass}`}`,
  };
}
