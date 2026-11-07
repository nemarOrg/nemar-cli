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
 *       - no Tapis job that no row accounts for, affirmatively (the search succeeded and found none): the
 *         hold is released, with the ledger reason `expired` (`endPartnerReservation`);
 *       - exactly one: it is bound to the reservation as if the partner had reported it and then verified
 *         (the same read-back), or, when it is owned by someone else, when the reservation was cancelled or
 *         when the person's compute has ended since, refused (`owner_mismatch` / `hold_ended`): cancelled
 *         at Tapis, the hold released, what ran charged to the partner's pool;
 *       - several: flagged `ambiguous_tag` and the hold KEPT (a person looks; the tenant sweep accounts the
 *         ones that skipped the reservation, and then none is left to be ambiguous);
 *       - ANY Tapis error: the hold is KEPT, `tapis_unreachable` is recorded, and the next tick asks again.
 *         NOTHING IS EVER RELEASED ON AN ERROR.
 *  2. `pending` rows (a Tapis job bound and not yet verified, because Tapis could not be read when the
 *     partner reported): verified now. A binding whose job Tapis keeps answering 404 for is withdrawn after
 *     a time: the row is a reservation again, and branch 1 resolves it by tag.
 *  3. `mismatch` rows (a refusal recorded as intent): carried out (`finishMismatch`): the Tapis job
 *     cancelled, the hold released and what ran charged to the partner's pool.
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
  finishMismatch,
  isNemarsOwnJob,
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
 * How long past the reservation wait the tenant sweep still leaves a partner's job alone while its
 * reservation waits for the report: the reaper (which runs on the same tick) resolves a reservation the
 * first tick after the wait, and the grace is two ticks so the sweep never indexes and cancels a job the
 * reaper is about to bind.
 */
export const SWEEP_DEFER_GRACE_MINUTES = 60;

/**
 * Whether a Tapis job no row is bound to is a partner's job launched under a LIVE reservation whose report
 * has not come yet: the sweep (phase A7) leaves it alone, because the report that is about to bind it, or the
 * reaper that binds it after the wait, accounts for it, and cancelling it as one that skipped the reservation
 * would refuse a legitimate report (`tapis_job_in_use`). It is deferred only when the job's owner is the
 * reservation's Tapis username, the reservation is unbound, not cancelled and not flagged ambiguous, and
 * it is not older than the wait and the grace; anything else is a job that skipped the reservation. A
 * tag proves nothing, so the owner must agree; the verification that follows proves the rest.
 */
export async function isAwaitingPartnerReport(env: Bindings, rec: TapisJob): Promise<boolean> {
  const ids = (rec.tags ?? [])
    .filter((t): t is string => typeof t === "string" && t.startsWith("nemar_job:"))
    .map((t) => t.slice("nemar_job:".length));
  if (ids.length !== 1 || !/^job_[0-9a-f]{24}$/.test(ids[0] as string)) return false;
  const row = await getJob(env.DB, ids[0] as string);
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
    rec.owner !== row.tapis_owner
  ) {
    return false;
  }
  const wait = (await getPolicy(env.DB)).policy.reservationWaitMinutes;
  const madeMs = Date.parse(`${row.created_at.replace(" ", "T")}Z`);
  return (
    Number.isFinite(madeMs) && Date.now() - madeMs < (wait + SWEEP_DEFER_GRACE_MINUTES) * 60_000
  );
}

/** Rows of each list one tick takes at most. */
export const REAPER_ROWS_PER_LIST = 25;

/** A binding whose Tapis job keeps answering 404 for this long is withdrawn (the row is a reservation again). */
export const PENDING_GONE_GIVE_UP_MINUTES = 240;

/**
 * The reservations to resolve: `created`, no Tapis job, not yet reported, older than the wait `?1` (minutes)
 * or with a cancel recorded; least recently examined first. The partial index `compute_jobs_partner_open`
 * serves it (it states the same three terms).
 */
export const OPEN_RESERVATIONS_SQL = `SELECT id FROM compute_jobs
  WHERE source = 'partner' AND tapis_uuid IS NULL AND state = 'created' AND partner_state IS NULL
    AND (created_at < datetime('now', '-' || ?1 || ' minutes') OR cancel_requested_at IS NOT NULL)
  ORDER BY examined_at ASC, created_at ASC LIMIT ?2`;

/** The rows `pending` or `mismatch` and not yet over, least recently examined first. */
export const UNVERIFIED_ROWS_SQL = `SELECT id FROM compute_jobs
  WHERE partner_state IN ('pending', 'mismatch') AND state = 'created'
  ORDER BY examined_at ASC, created_at ASC LIMIT ?1`;

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
    // None, affirmatively: the search succeeded and no Tapis job is unaccounted for. Release with the
    // reason `expired`. The statement binds "no Tapis job" itself, so a report that bound one since wins.
    const fresh = (await getJob(db, job.id)) ?? job;
    if (await endPartnerReservation(env, fresh, "hold_expired")) r.released++;
    return;
  }
  if (unaccounted.length > 1) {
    r.ambiguous++;
    await db.prepare(AMBIGUOUS_SQL).bind(job.id).run();
    return;
  }

  // Exactly one. Read it in full (a search answer is a summary), then bind it.
  const listed = unaccounted[0] as TapisJob;
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
    if ((await finishMismatch(env, job.id, TICK_READ)) === "ended") r.ended++;
    return;
  }
  const outcome = await verifyBoundJob(env, job.id, { record: rec, read: TICK_READ });
  if (outcome.kind === "verified") r.verified++;
  else if (outcome.kind === "mismatch") {
    r.refused++;
    if ((await finishMismatch(env, job.id, TICK_READ)) === "ended") r.ended++;
  }
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
  const outcome = await verifyBoundJob(env, job.id, { read: TICK_READ });
  if (outcome.kind === "verified") {
    r.verified++;
  } else if (outcome.kind === "mismatch") {
    r.refused++;
    if ((await finishMismatch(env, job.id, TICK_READ)) === "ended") r.ended++;
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
    const wait = (await getPolicy(db)).policy.reservationWaitMinutes;

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
          await resolveReservation(env, ctx, job, r);
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
          if ((await finishMismatch(env, id, TICK_READ)) === "ended") r.ended++;
        }
      } catch (err) {
        r.errors.push("unverified_failed");
        r.errorClass = errorClassName(err);
        console.error(`[compute-reaper] an unverified row failed (${r.errorClass})`);
      }
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
    r.released + r.adopted + r.ambiguous + r.unreachable + r.pending + r.mismatches + r.withdrawn;
  if (acted === 0 && r.errors.length === 0) return null;
  const level =
    r.errors.length > 0 ? "error" : r.unreachable > 0 || r.ambiguous > 0 ? "warn" : "info";
  return {
    level,
    line:
      `[compute-reaper] examined=${r.examined} released=${r.released} adopted=${r.adopted}` +
      ` ambiguous=${r.ambiguous} unreachable=${r.unreachable} pending=${r.pending}` +
      ` verified=${r.verified} refused=${r.refused} withdrawn=${r.withdrawn}` +
      ` mismatches=${r.mismatches} ended=${r.ended}` +
      ` errors=${r.errors.length > 0 ? r.errors.join(",") : "none"}${r.errorClass === null ? "" : ` class=${r.errorClass}`}`,
  };
}
