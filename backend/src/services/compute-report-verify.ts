/**
 * NEMAR's own verification of a partner's report (epic #2021 phase D4, #2025; ADR 0118, the amendment of
 * this phase; design section 6): what makes a Tapis job the partner says it launched under a reservation
 * a job NEMAR will follow and charge the person for, and what NEMAR does when it is not.
 *
 * THE PARTNER IS NOT TRUSTED. It can mint a Tapis token for any username, so the Tapis `owner` and the
 * tag prove nothing alone. The identity is the BOUND UUID (a unique index of `compute_jobs`) and NEMAR's
 * OWN read of that job from Tapis: its owner is the person's Tapis username, its application and version
 * are the reservation's, its queue is the reservation's partition and its resources do not exceed the
 * hold. Until that read matches, NOTHING is charged beyond the hold, and no generic path of the
 * lifecycle reads, cancels or settles the row (`isUnverifiedPartnerJob`).
 *
 *   `checkReport`     the pure rule (owner, application, queue and resources).
 *   `verifyBoundJob`  read the bound job back and decide. A match is ONE batch (`pending` to `verified`,
 *                     the job `submitted`); NEMAR's webhook is subscribed after it. A mismatch is ONE batch
 *                     that records the intent (the flag word, the cancel intent, one audit row) and nothing
 *                     else. A Tapis that cannot be read leaves the row `pending`.
 *   `finishMismatch`  carry a recorded mismatch out: cancel the Tapis job (only a job the record shows is
 *                     not NEMAR's own), read it back, and when it has ended end the row in ONE batch
 *                     (`commitPartnerMismatchEnd`): the person's hold released, what ran charged to the
 *                     partner's pool as an `overrun`, never to the person. A Tapis call NEVER runs inside a
 *                     batch: the batch records intent, and a retried tick performs the call.
 *
 * NO RELEASE ON AN ERROR. An unreadable Tapis keeps everything as it is. A job that may have run is never
 * released with no charge (the lost-record rule): when its record is gone the row's own evidence decides
 * (`partnerLostSettlement`), and a job that cannot be shown not to have run is charged the minimum to the
 * partner's pool.
 */

import { isTerminalComputeState } from "../../../shared/compute-state.js";
import type { ComputeReportMismatch } from "../../../shared/contract/compute-partner.js";
import {
  type ComputePool,
  PARTITIONS,
  PARTITION_NAMES,
  type PartitionName,
  RATE_TABLE_V1,
  suMilliFor,
} from "../../../shared/contract/compute.js";
import {
  AUDIT_IF_PREVIOUS_CHANGED_SQL,
  type AuditLogEntry,
  auditLogParams,
} from "../db/audit-log.js";
import type { Bindings } from "../types/bindings.js";
import { ACCESS_REPORT_PENDING_SQL } from "./access-attributes.js";
import { type ComputeJobRow, getJob } from "./compute-jobs.js";
import {
  type Provisional,
  REQUEST_READ,
  TICK_READ,
  commitPartnerMismatchEnd,
  errorClassName,
  provisionalCharge,
  sqliteTime,
  subscribeVerifiedJob,
  tapisAccess,
} from "./compute-lifecycle.js";
import { getPolicy } from "./compute-policy.js";
import {
  type TapisContext,
  type TapisJob,
  cancelJob,
  getJob as getTapisJob,
} from "./tapis/client.js";
import { TapisError } from "./tapis/errors.js";
import { TAPIS_JOB_UUID_RE } from "./tapis/schemas.js";

/**
 * The flag of a job NEMAR could not read back for {@link UNVERIFIABLE_AFTER_MINUTES} minutes after it was
 * bound: a job that cannot be shown to match is refused like one that does not (the cancel is attempted,
 * the hold released, the use charged to the partner's pool), because the alternative is a job that runs
 * unbilled while it pins the person's hold and live-job slot.
 */
export const UNVERIFIABLE_FLAG = "unverifiable";

/** Minutes a bound job may stay unreadable (a Tapis that is down, a record NEMAR may not read) before it is refused. */
export const UNVERIFIABLE_AFTER_MINUTES = 120;

/** The audit action of a refused report: one row, written in the batch that records the mismatch. */
export const PARTNER_MISMATCH_ACTION = "compute.partner.mismatch";

/** The tag prefix of NEMAR's jobs (`nemar_job:<id>`), the part before the id. */
const NEMAR_TAG = "nemar_job:";

// --- The rule ---------------------------------------------------------------------------------------

/** The Tapis username a person's compute credential carries: the OIDC `sub`, or a fixed reversible transform of it (ADR 0119 rule 11). */
export function tapisUsernameForSub(sub: string): string {
  // The identity transform. The partner may apply a fixed one (a change of case or of separator) that NEMAR
  // can undo; the day the partner names it, this is the one place that learns it, and a test pins it.
  return sub;
}

export type ReportCheck = { ok: true } | { ok: false; flag: ComputeReportMismatch };

/** A whole non-negative number, or null. */
const whole = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;

/**
 * Whether a Tapis record is the job the reservation holds for. In order, the first failure is the flag:
 * `owner_mismatch` (the record's owner is not the person's Tapis username), `app_mismatch` (the application
 * or its version is not the reservation's), `resources_mismatch` (the queue is not the reservation's
 * partition, or the nodes, the cores per node, the memory, the minutes or the price of the record's
 * resources exceed the hold's; a figure the record does not carry cannot be shown within it, so it
 * fails). THE SCHEDULER OPTIONS are read through the narrow accessor `schedulerArgsOf` and held to an
 * ALLOWLIST: at most one `--gpus=N` with N no more than the hold's GPUs, and the exact strings the owner
 * listed (`policy.partner.allowedSchedulerArgs`, for options Tapis merges from the app or the system, such as
 * an account), and nothing else (a partner that adds `--exclusive`, `--mem` or a second GPU option is
 * changing what the scheduler allocates and the accounting charges, which the record's own figures do not
 * show); a record whose options cannot be read is
 * never verified. When the owner pinned the execution system (`policy.partner.execSystemId`), a record on
 * another system is a `resources_mismatch`.
 */
export function checkReport(
  job: Pick<
    ComputeJobRow,
    | "tapis_owner"
    | "app_id"
    | "app_version"
    | "partition"
    | "nodes"
    | "cores_per_node"
    | "memory_mb"
    | "gpus"
    | "minutes"
    | "held_milli"
  >,
  rec: Pick<
    TapisJob,
    | "owner"
    | "appId"
    | "appVersion"
    | "execSystemLogicalQueue"
    | "nodeCount"
    | "coresPerNode"
    | "memoryMB"
    | "maxMinutes"
    | "execSystemId"
    | "schedulerArgs"
  >,
  pin: SchedulerPin = {},
): ReportCheck {
  if (job.tapis_owner === null || rec.owner !== job.tapis_owner) {
    return { ok: false, flag: "owner_mismatch" };
  }
  if (rec.appId !== job.app_id || rec.appVersion !== job.app_version) {
    return { ok: false, flag: "app_mismatch" };
  }
  const nodes = whole(rec.nodeCount);
  const cores = whole(rec.coresPerNode);
  const memory = whole(rec.memoryMB);
  const minutes = whole(rec.maxMinutes);
  const resources = { ok: false, flag: "resources_mismatch" } as const;
  if (rec.execSystemLogicalQueue !== job.partition) return resources;
  if (pin.execSystemId !== undefined && rec.execSystemId !== pin.execSystemId) return resources;
  if (!schedulerArgsWithin(rec.schedulerArgs, job.gpus, pin.allowedSchedulerArgs)) return resources;
  if (nodes === null || cores === null || memory === null || minutes === null) return resources;
  if (nodes < 1 || nodes > job.nodes) return resources;
  if (cores > job.cores_per_node) return resources;
  if (minutes < 1 || minutes > job.minutes) return resources;
  if (job.memory_mb !== null && memory > job.memory_mb) return resources;
  // The record's resources, for every minute it may run, priced as the hold was: never above the hold.
  // (This is what catches a memory larger than the hold on a partition priced by memory.)
  try {
    const price = suMilliFor(
      job.partition as PartitionName,
      { nodes, cores, memory_mb: memory, gpus: job.gpus },
      minutes * 60,
    );
    if (price > job.held_milli) return resources;
  } catch {
    return resources;
  }
  return { ok: true };
}

/**
 * Whether a record's scheduler options are the ones a reservation allows: readable (`undefined` and `null`
 * are not), at most one, and that one `--gpus=N` with N no more than the hold's GPUs.
 */
export function schedulerArgsWithin(
  args: string[] | null | undefined,
  holdGpus: number,
  allowed: readonly string[] = [],
): boolean {
  if (!Array.isArray(args)) return false;
  let gpuOptions = 0;
  for (const arg of args) {
    if (allowed.includes(arg)) continue;
    const m = /^--gpus=([0-9]{1,2})$/.exec(arg);
    if (m === null || Number(m[1]) > holdGpus) return false;
    gpuOptions += 1;
    if (gpuOptions > 1) return false;
  }
  return true;
}

/** What the owner pinned about where and how a partner's job runs (`policy.partner`). */
export interface SchedulerPin {
  execSystemId?: string | undefined;
  allowedSchedulerArgs?: readonly string[] | undefined;
}

/** The pin of a policy: the one place that reads `policy.partner` for the check. */
export const pinOf = (
  partner:
    | { execSystemId?: string | undefined; allowedSchedulerArgs?: string[] | undefined }
    | undefined,
): SchedulerPin => ({
  execSystemId: partner?.execSystemId,
  allowedSchedulerArgs: partner?.allowedSchedulerArgs,
});

/** True when a Tapis record carries a `nemar_job:<id>` tag for a job other than `jobId`. */
export function carriesForeignNemarTag(rec: Pick<TapisJob, "tags">, jobId: string): boolean {
  return (rec.tags ?? []).some(
    (tag) => typeof tag === "string" && tag.startsWith(NEMAR_TAG) && tag !== `${NEMAR_TAG}${jobId}`,
  );
}

/**
 * True when the record is NEMAR's own job and not the partner's to report: it is owned by the NEMAR
 * service identity (a partner's job is owned by a person's Tapis username) or it names another NEMAR job
 * in its tags. NEMAR must never cancel, bind or charge such a job on a partner's word.
 */
export function isNemarsOwnJob(
  ctx: Pick<TapisContext, "owner">,
  rec: TapisJob,
  jobId: string,
): boolean {
  return rec.owner === ctx.owner || carriesForeignNemarTag(rec, jobId);
}

// --- The decision --------------------------------------------------------------------------------------

/**
 * The match: `pending` to `verified`, the job `submitted` (and its times as Tapis reports them), in one
 * conditional UPDATE. `?1` the job, `?2` the bound uuid, `?3` Tapis's status, `?4` and `?5` the submit and
 * start times (or NULL), `?6` the Slurm id (or NULL). It writes only for the row that is still `pending`
 * with this uuid and `created`, so a repeat or a concurrent verifier changes nothing. A cancel intent
 * already recorded stays: the generic cancel carries it out now that the job is an ordinary one.
 */
export const VERIFIED_SQL = `UPDATE compute_jobs SET
    partner_state = 'verified', partner_flag = NULL, partner_verified_at = datetime('now'),
    state = 'submitted', submitted_at = datetime('now'), tapis_status = ?3,
    tapis_synced_at = datetime('now'),
    remote_submitted_at = COALESCE(?4, remote_submitted_at),
    started_at = COALESCE(?5, started_at),
    slurm_job_id = COALESCE(slurm_job_id, ?6)
  WHERE id = ?1 AND tapis_uuid = ?2 AND partner_state = 'pending' AND state = 'created'`;

/**
 * The mismatch, as intent only: the flag word, the job flagged `mismatch`, the cancel intent (the first
 * recorded reason stands) and what Tapis last showed. `?1` the job, `?2` the bound uuid, `?3` the flag,
 * `?4` Tapis's status, `?5` the start time (or NULL). The audit row follows in the same batch, only if
 * this statement changed the row.
 */
export const MISMATCH_SQL = `UPDATE compute_jobs SET
    partner_state = 'mismatch', partner_flag = ?3, flag_mismatch = 1,
    cancel_requested_at = COALESCE(cancel_requested_at, datetime('now')),
    cancel_reason = COALESCE(cancel_reason, 'unreserved'),
    tapis_status = COALESCE(?4, tapis_status), started_at = COALESCE(?5, started_at)
  WHERE id = ?1 AND tapis_uuid = ?2 AND partner_state = 'pending'`;

export type VerifyOutcome =
  /** The read matched: the job is `verified` and `submitted`; the webhook is subscribed. */
  | { kind: "verified"; job: ComputeJobRow }
  /** The read did not match: the intent is recorded (the cancel is carried out by `finishMismatch`). */
  | { kind: "mismatch"; flag: ComputeReportMismatch | typeof UNVERIFIABLE_FLAG; job: ComputeJobRow }
  /** Tapis could not be read just now (or the row is not ready): still `pending`, nothing charged. */
  | { kind: "pending"; job: ComputeJobRow; gone?: boolean }
  /** The row is not a partner job waiting to be verified (already verified, refused, ended or none). */
  | { kind: "skipped"; job: ComputeJobRow | null };

/** The audit entry of a refused report: shape only, never a value the partner sent. */
function mismatchAudit(job: ComputeJobRow, flag: string): AuditLogEntry {
  return {
    userId: null,
    action: PARTNER_MISMATCH_ACTION,
    resourceType: "compute_job",
    resourceId: job.id,
    details: JSON.stringify({ flag, client: job.client_id, partition: job.partition }),
  };
}

/**
 * Verify a bound, pending partner job against NEMAR's own read of it. The record may be handed in (the
 * report route has just read it); otherwise it is read here, with `read` as the budget. Never throws for
 * what Tapis does.
 */
export async function verifyBoundJob(
  env: Bindings,
  jobId: string,
  options: { record?: TapisJob; read?: { maxAttempts: number; timeoutMs: number } } = {},
): Promise<VerifyOutcome> {
  let job = await getJob(env.DB, jobId);
  if (job === null || job.source !== "partner" || job.partner_state !== "pending") {
    return { kind: "skipped", job };
  }
  const uuid = job.tapis_uuid;
  if (uuid === null) return { kind: "skipped", job };
  const ctx = tapisAccess(env, options.read ?? REQUEST_READ);
  let rec = options.record ?? null;
  if (rec === null) {
    if (ctx === null) return unreadable(env, job, uuid, false);
    try {
      rec = await getTapisJob(ctx, uuid);
    } catch (err) {
      console.warn(
        `[compute-partner] verify_read_failed job=${job.id} kind=${err instanceof TapisError ? err.kind : errorClassName(err)}`,
      );
      // A 404 is "Tapis has no such job": the tick may withdraw a binding that stays that way. Any other
      // failure is "cannot read it": pending, until the limit, and then refused (`unverifiable`).
      return unreadable(env, job, uuid, err instanceof TapisError && err.kind === "not_found");
    }
  }
  // Tapis answered for another job than the one bound: that is no read of this job.
  if (rec.uuid !== uuid) return unreadable(env, job, uuid, false);

  // A record that is NEMAR's own job is never judged or cancelled on a partner's word: the binding is
  // withdrawn (the row is a reservation again) and the partner is told it is in use.
  if (ctx !== null && isNemarsOwnJob(ctx, rec, job.id)) {
    await env.DB.prepare(UNBIND_SQL).bind(job.id, uuid, "tapis_job_in_use").run();
    return { kind: "skipped", job: await getJob(env.DB, job.id) };
  }

  const pin = (await getPolicy(env.DB)).policy.partner;
  const verdict = checkReport(job, rec, pinOf(pin));
  if (verdict.ok) {
    const slurm =
      typeof rec.remoteJobId === "string" && rec.remoteJobId !== "" ? rec.remoteJobId : null;
    const verified = env.DB.prepare(VERIFIED_SQL).bind(
      job.id,
      uuid,
      rec.status,
      sqliteTime(rec.remoteSubmitted),
      sqliteTime(rec.remoteStarted),
      slurm,
    );
    const results = await env.DB.batch([
      verified,
      ...(slurm === null ? [] : [env.DB.prepare(ACCESS_REPORT_PENDING_SQL).bind(job.id)]),
    ]);
    job = (await getJob(env.DB, job.id)) ?? job;
    if ((results[0]?.meta?.changes ?? 0) === 1 && ctx !== null) {
      // After the commit, never inside it: NEMAR's own webhook is a hint, subscribed once.
      await subscribeVerifiedJob(env, ctx, job, uuid);
    }
    return job.partner_state === "verified" ? { kind: "verified", job } : { kind: "skipped", job };
  }

  job = await recordMismatch(env, job, uuid, verdict.flag, rec);
  if (job.partner_state !== "mismatch") return { kind: "skipped", job };
  return { kind: "mismatch", flag: verdict.flag, job };
}

/** Minutes since the job was bound (`submitted_at` is the bind time of a pending partner row). */
function boundMinutes(job: Pick<ComputeJobRow, "submitted_at" | "created_at">): number {
  const raw = (job.submitted_at ?? job.created_at).replace(" ", "T");
  const ms = Date.parse(/(?:[zZ]|[+-]\d\d:?\d\d)$/.test(raw) ? raw : `${raw}Z`);
  return Number.isFinite(ms) ? (Date.now() - ms) / 60_000 : 0;
}

/**
 * NEMAR could not read the bound job back. Until {@link UNVERIFIABLE_AFTER_MINUTES} it stays `pending`
 * (nothing is charged beyond the hold, no generic path takes the row); past it a job that cannot be shown
 * to match is refused as `unverifiable` (the intent is recorded here, one audit row; `finishMismatch`
 * cancels it, releases the hold and charges the partner's pool). A 404 (`gone`) is the other case: the
 * tick withdraws that binding after a time (`compute-hold-reaper.ts`), since a job Tapis does not have is
 * not running.
 */
async function unreadable(
  env: Bindings,
  job: ComputeJobRow,
  uuid: string,
  gone: boolean,
): Promise<VerifyOutcome> {
  if (gone || boundMinutes(job) < UNVERIFIABLE_AFTER_MINUTES) {
    return { kind: "pending", job, ...(gone ? { gone: true } : {}) };
  }
  console.warn("[compute-partner] unverifiable");
  const refused = await recordMismatch(env, job, uuid, UNVERIFIABLE_FLAG, null);
  return refused.partner_state === "mismatch"
    ? { kind: "mismatch", flag: UNVERIFIABLE_FLAG, job: refused }
    : { kind: "skipped", job: refused };
}

/**
 * Record a refusal as intent, in one batch with its audit row, for a row that is `pending` with this
 * uuid: the flag word, the job flagged `mismatch`, the cancel intent. NO Tapis call and no ledger entry:
 * `finishMismatch` carries it out and a retried tick repeats it. Returns the row as it stands.
 */
export async function recordMismatch(
  env: Bindings,
  job: ComputeJobRow,
  uuid: string,
  flag: string,
  rec: Pick<TapisJob, "status" | "remoteStarted"> | null,
): Promise<ComputeJobRow> {
  const audit = auditLogParams(mismatchAudit(job, flag));
  await env.DB.batch([
    env.DB.prepare(MISMATCH_SQL).bind(
      job.id,
      uuid,
      flag,
      rec?.status ?? null,
      sqliteTime(rec?.remoteStarted),
    ),
    env.DB.prepare(AUDIT_IF_PREVIOUS_CHANGED_SQL).bind(...audit),
  ]);
  return (await getJob(env.DB, job.id)) ?? job;
}

/**
 * Bind a Tapis job found under a reservation's tag to the reservation, `pending`: the reaper's own bind
 * (a report is `BIND_REPORT_SQL`, which also refuses a cancelled reservation and a person whose compute
 * ended). Here those two are not reasons to leave a live Tapis job unaccounted: the row takes it and the
 * caller refuses it (`recordMismatch`) or verifies it. `?1` the job, `?2` the uuid, `?3` Tapis's status.
 */
export const BIND_ADOPT_SQL = `UPDATE compute_jobs SET
    tapis_uuid = ?2, partner_state = 'pending', partner_flag = NULL,
    tapis_status = COALESCE(?3, tapis_status), submitted_at = datetime('now'), examined_at = NULL
  WHERE id = ?1 AND source = 'partner' AND state = 'created' AND tapis_uuid IS NULL
    AND partner_state IS NULL`;

/**
 * Withdraw a binding that was never safe to keep: the row is a reservation again (`partner_state` NULL,
 * no uuid, a flag word that says why; the cancel intent THIS refusal recorded is withdrawn, one a person's
 * cancel or the end of an account recorded stands). `?1` the job, `?2` the uuid, `?3` the flag. Only
 * the row that is still bound to that uuid and not yet ended.
 */
export const UNBIND_SQL = `UPDATE compute_jobs SET
    tapis_uuid = NULL, partner_state = NULL, partner_flag = ?3, tapis_status = NULL,
    cancel_requested_at = CASE WHEN cancel_reason = 'unreserved' THEN NULL ELSE cancel_requested_at END,
    cancel_reason = CASE WHEN cancel_reason = 'unreserved' THEN NULL ELSE cancel_reason END,
    flag_mismatch = 1
  WHERE id = ?1 AND tapis_uuid = ?2 AND partner_state IN ('pending', 'mismatch')
    AND state = 'created'`;

// --- Carrying a mismatch out ---------------------------------------------------------------------------

/**
 * What the row's own evidence says a job did when its Tapis record cannot be found. A job that ran is
 * never released: a start time or a Slurm id, or a status that is `RUNNING`, `ARCHIVING` or `FINISHED`,
 * is evidence, and then the contract's minimum is charged to the partner's pool; nothing shows it ran,
 * the hold is released with no charge.
 */
export function partnerLostSettlement(
  job: Pick<ComputeJobRow, "started_at" | "slurm_job_id" | "tapis_status">,
): Provisional {
  const evidence =
    job.started_at !== null ||
    job.slurm_job_id !== null ||
    job.tapis_status === "RUNNING" ||
    job.tapis_status === "ARCHIVING" ||
    job.tapis_status === "FINISHED";
  return evidence
    ? { kind: "charge", milli: RATE_TABLE_V1.minChargeMilli, seconds: 0, fallback: true }
    : { kind: "release" };
}

const TAPIS_ENDED = new Set(["FINISHED", "CANCELLED", "FAILED"]);

export type MismatchEnd =
  /** The row is over: the hold released and what ran charged to the partner's pool. */
  | "ended"
  /** The cancel is not shown to have taken, or the record is unreadable: kept, the next tick asks again. */
  | "pending"
  /** Nothing was owed here. */
  | "skipped";

/**
 * Carry a recorded mismatch out, as far as it can go now. The Tapis job is read FIRST: a job the record
 * shows is NEMAR's own is never cancelled (the binding is withdrawn), a live one is cancelled (a 409 is
 * "already over"), and the row is ended only when a read shows the job has ended, with the record's own
 * resources priced by `provisionalCharge`. Never throws for what Tapis does; nothing is released on an
 * error.
 */
export async function finishMismatch(
  env: Bindings,
  jobId: string,
  mode: { maxAttempts: number; timeoutMs: number } = TICK_READ,
): Promise<MismatchEnd> {
  // The row as it stands BEFORE Tapis is asked: the ending binds exactly this state, so a second writer
  // (a retried tick, a concurrent report) that lost changes nothing.
  const job = await getJob(env.DB, jobId);
  if (
    job === null ||
    job.source !== "partner" ||
    job.partner_state !== "mismatch" ||
    job.tapis_uuid === null ||
    isTerminalComputeState(job.state)
  ) {
    return "skipped";
  }
  const uuid = job.tapis_uuid;
  if (!TAPIS_JOB_UUID_RE.test(uuid)) return "skipped";
  const ctx = tapisAccess(env, mode);
  if (ctx === null) return "pending";
  const unverifiable = job.partner_flag === UNVERIFIABLE_FLAG;

  let rec: TapisJob | null = null;
  let unread = false;
  try {
    rec = await getTapisJob(ctx, uuid);
  } catch (err) {
    if (err instanceof TapisError && err.kind === "not_found") {
      // The record is gone. The row's own evidence decides what it was (below); a 404 is not a release.
    } else if (unverifiable) {
      // A job NEMAR could not read for hours is cancelled blind: the cancel needs only the uuid.
      unread = true;
    } else {
      return "pending";
    }
  }

  if (rec !== null && isNemarsOwnJob(ctx, rec, job.id)) {
    await env.DB.prepare(UNBIND_SQL).bind(job.id, uuid, "tapis_job_in_use").run();
    return "skipped";
  }

  if (unread) {
    try {
      await cancelJob(ctx, uuid);
    } catch (err) {
      if (!(err instanceof TapisError && err.status === 409)) {
        console.warn(
          `[compute-partner] cancel_unclear job=${job.id} kind=${err instanceof TapisError ? err.kind : errorClassName(err)}`,
        );
        return "pending";
      }
    }
  } else if (rec !== null && !TAPIS_ENDED.has(rec.status)) {
    try {
      await cancelJob(ctx, uuid);
    } catch (err) {
      // Only a 409 means "already over". Any other answer did not take it; the read below decides, and
      // if the job is still live the row is kept and the next tick asks again.
      if (!(err instanceof TapisError && err.status === 409)) {
        console.warn(
          `[compute-partner] cancel_unclear job=${job.id} kind=${err instanceof TapisError ? err.kind : errorClassName(err)}`,
        );
      }
    }
    try {
      rec = await getTapisJob(ctx, uuid);
    } catch {
      return "pending";
    }
    if (!TAPIS_ENDED.has(rec.status)) return "pending";
  }

  // What ran is priced from what the RECORD shows where it is readable (its queue and its GPUs), else from
  // the hold; a job that could not be read at all is charged the minimum (it cannot be shown not to have run).
  const priced = pricedAs(job, rec);
  const settlement: Provisional = unread
    ? { kind: "charge", milli: RATE_TABLE_V1.minChargeMilli, seconds: 0, fallback: true }
    : rec === null
      ? partnerLostSettlement(job)
      : provisionalCharge(priced.job, rec);
  const won = await commitPartnerMismatchEnd(env, job, rec, settlement, priced.pool);
  return won ? "ended" : "skipped";
}

/**
 * The job as the use of a refused partner job is priced: on the QUEUE the record shows when it is one of
 * ours (a GPU queue is the gpu pool whatever the hold asked for) and with the GPUs of its `--gpus=N`
 * option when readable, else the hold's partition and GPUs.
 */
export function pricedAs(
  job: ComputeJobRow,
  rec: TapisJob | null,
): { job: ComputeJobRow; pool: ComputePool } {
  const queue = rec?.execSystemLogicalQueue;
  if (typeof queue !== "string" || !(PARTITION_NAMES as readonly string[]).includes(queue)) {
    return { job, pool: job.pool };
  }
  const partition = queue as PartitionName;
  const pool = PARTITIONS[partition].pool;
  const args = rec?.schedulerArgs;
  const given = Array.isArray(args)
    ? args.map((a) => /^--gpus=([0-9]{1,2})$/.exec(a)?.[1]).find((g) => g !== undefined)
    : undefined;
  const gpus = given !== undefined ? Number(given) : pool === "gpu" ? Math.max(job.gpus, 1) : 0;
  return { job: { ...job, partition, pool, gpus }, pool };
}
