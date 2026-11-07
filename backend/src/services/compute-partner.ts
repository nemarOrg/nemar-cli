/**
 * The partner contract (epic #2021 phase D4, #2025; ADR 0118, the amendment of this phase; design section
 * 6): the logic behind `POST /compute/holds`, `POST /compute/jobs/:id/report` and
 * `DELETE /compute/holds/:id`. The routes (`routes/compute/partner.ts`) own HTTP; this module owns the
 * ORDER, which is the contract.
 *
 * THE PARTNER IS TREATED AS HOSTILE OR COMPROMISED. It can mint a Tapis token for any username, so the
 * owner and the tag of a Tapis job prove nothing alone: only the bound uuid and NEMAR's own read of the
 * job do (`compute-report-verify.ts`). Everything below fails closed:
 *
 *  - A reservation is ONE conditional INSERT (`createJob`): the person's compute access, the balance, the
 *    platform budget, the person's live-job limit, the client's open-reservation cap and its UTC-day cap
 *    are all in the hold's own WHERE, and the idempotency claim is in the same batch. A refusal writes
 *    nothing; the reason is read AFTER it.
 *  - A job that is not the caller's person AND client is `job_not_found`, the same answer as an absent
 *    one: no route is an oracle for a job id.
 *  - A report binds a Tapis uuid with one conditional UPDATE (a unique index refuses a uuid bound to
 *    another row, and a job that is NEMAR's own is never bound), then NEMAR reads the job back. Until the
 *    read matches, the row is `pending` and NOTHING is charged beyond the hold; a mismatch cancels the
 *    Tapis job and charges what ran to the partner's pool. A partner's files enter `records/` only after
 *    the read matched.
 *  - A release is refused for a bound job (`hold_bound`), and a late report after a release is refused
 *    (`hold_released`): a job launched under a released reservation is a job that skipped the reservation,
 *    which the tenant sweep cancels and charges to the partner.
 *
 * THE COMPUTE SWITCH IS NOT READ HERE (`compute-source-scan.test.ts` pins that). With compute off a hold is
 * taken and expires like a person's submission; the routes work.
 *
 * NOTHING THE PARTNER SENT IS LOGGED: a log line carries a job id and a fixed word.
 */

import {
  canUseCompute,
  isComputeAccessState,
} from "../../../shared/compute-access-state.js";
import { isTerminalComputeState } from "../../../shared/compute-state.js";
import {
  COMPUTE_PARTNER_TAG_PREFIX,
  type ComputePartnerErrorCode,
  type ComputePartnerHoldResponse,
  type ComputePartnerReleaseResponse,
  type ComputePartnerReportResponse,
  type ComputeReportMismatch,
  holdIdForJob,
  jobIdForHold,
} from "../../../shared/contract/compute-partner.js";
import {
  ComputeHoldRequestSchema,
  type ComputeReportFile,
  type ComputeReportRequest,
} from "../../../shared/contract/compute-partner-request.js";
import { COMPUTE_JOB_ID_RE, type ComputePolicy } from "../../../shared/contract/compute.js";
import type { Bindings } from "../types/bindings.js";
import {
  ACCOUNT_LIVE_COUNT_SQL,
  ComputeJobError,
  type ComputeJobRow,
  IDEMPOTENCY_BY_KEY_SQL,
  type PartnerCaps,
  type PartnerCreateResult,
  createJob,
  getJob,
  jobCeilingRefusal,
} from "./compute-jobs.js";
import { endPartnerReservation, REQUEST_READ, tapisAccess } from "./compute-lifecycle.js";
import { fieldPath, getPolicy } from "./compute-policy.js";
import {
  type DeclaredFile,
  checkPartnerFiles,
  finalizeSubmittedFiles,
  presignIncomingUploads,
  sha256Hex,
} from "./compute-records.js";
import {
  finishMismatch,
  isNemarsOwnJob,
  tapisUsernameForSub,
  verifyBoundJob,
} from "./compute-report-verify.js";
import { ComputeS3Error } from "./compute-s3.js";
import { getClient } from "./oidc-clients.js";
import { type TapisJob, getJob as getTapisJob } from "./tapis/client.js";
import { TapisError } from "./tapis/errors.js";

// --- Shapes ----------------------------------------------------------------------------------------

export interface PartnerRefusal {
  ok: false;
  code: ComputePartnerErrorCode;
  /** The name of the field of the request, for `invalid_spec`; never a value. */
  field?: string;
  /** For `report_mismatch`: why the report did not match. */
  mismatch?: ComputeReportMismatch;
  /** The job a refusal is about, when the caller owns one (a mismatch). */
  job_id?: string;
}

const refuse = (code: ComputePartnerErrorCode, extra: Partial<PartnerRefusal> = {}): PartnerRefusal => ({
  ok: false,
  code,
  ...extra,
});

/** The client a partner token names, by its public id. */
export interface PartnerCaller {
  userId: number;
  clientId: string;
  /** The client's own idempotency scope. */
  scope: string;
}

export const partnerScope = (clientId: string): string => `client:${clientId}`;

/** The request hash: the method, the path, the person and the exact body. A key is a replay only when it is the same. */
export async function requestHash(
  method: string,
  path: string,
  userId: number,
  body: string,
): Promise<string> {
  return sha256Hex(new TextEncoder().encode(`${method} ${path}\n${userId}\n${body}`));
}

// --- A person's standing ---------------------------------------------------------------------------

const ACCOUNT_FACTS_SQL = `SELECT compute_access, oidc_subject FROM users WHERE id = ?1 AND deleted_at IS NULL`;

interface AccountFacts {
  compute_access: string | null;
  oidc_subject: string | null;
}

/**
 * Whether the person may use compute NOW: `suspended` for a paused grant and `no_compute_access` for any
 * other state (never asked, asked, denied, revoked, a deleted account). The hold repeats it in its own
 * statement; this read puts the word first in the order the contract states.
 */
async function standing(
  db: D1Database,
  userId: number,
): Promise<{ refusal: "no_compute_access" | "suspended" | null; facts: AccountFacts | null }> {
  const facts = await db.prepare(ACCOUNT_FACTS_SQL).bind(userId).first<AccountFacts>();
  const state = facts?.compute_access;
  if (isComputeAccessState(state) && canUseCompute(state)) return { refusal: null, facts };
  return { refusal: state === "suspended" ? "suspended" : "no_compute_access", facts };
}

// --- The client's caps -------------------------------------------------------------------------------

/**
 * The caps a client's reservations are held to. The owner's policy (`clients`, the strict, versioned,
 * audited record `nemar admin compute policy set` writes) is the source, and a client that has no entry
 * has NO reservations: closed by default, as the policy is. The client's own record (`nemar admin oidc
 * clients add --cap-open-reservations --cap-su-per-day`) is a second ceiling when it is set: the smaller
 * of the two stands. An unreadable policy throws (`ComputePolicyUnreadable`): never the default.
 */
export async function effectiveCaps(
  env: Bindings,
  clientId: string,
  policy?: ComputePolicy,
): Promise<PartnerCaps> {
  const stated = (policy ?? (await getPolicy(env.DB)).policy).clients[clientId];
  if (stated === undefined) return { maxOpenReservations: 0, maxReservedMilliPerDay: 0 };
  let maxOpen = stated.maxOpenReservations;
  let maxMilli = stated.maxReservedMilliPerDay;
  const client = await getClient(env.DB, clientId);
  if (client?.cap_open_reservations != null) maxOpen = Math.min(maxOpen, client.cap_open_reservations);
  if (client?.cap_su_per_day != null) {
    maxMilli = Math.min(maxMilli, client.cap_su_per_day * 1000);
  }
  return { maxOpenReservations: maxOpen, maxReservedMilliPerDay: maxMilli };
}

// --- A reservation ---------------------------------------------------------------------------------

/** A time as the database writes its own, `minutes` after another. */
export function plusMinutes(sqlTime: string, minutes: number): string {
  const ms = Date.parse(`${sqlTime.replace(" ", "T")}Z`) + minutes * 60_000;
  return new Date(ms).toISOString().slice(0, 19).replace("T", " ");
}

function holdAnswer(job: ComputeJobRow, policy: ComputePolicy, replayed: boolean) {
  const body: ComputePartnerHoldResponse = {
    job_id: job.id,
    hold_id: holdIdForJob(job.id),
    tag: `${COMPUTE_PARTNER_TAG_PREFIX}${job.id}`,
    expires_at: plusMinutes(job.created_at, policy.reservationWaitMinutes),
    ...(replayed ? { replayed: true as const } : {}),
  };
  return { ok: true as const, replayed, body };
}

export type ReserveResult =
  | { ok: true; replayed: boolean; body: ComputePartnerHoldResponse }
  | PartnerRefusal;

/**
 * `POST /compute/holds`. In order (the first failing check is the answer, and a refusal writes nothing):
 *   1. the person's compute access (`no_compute_access`, `suspended`);
 *   2. the body, through the contract (`invalid_spec`, the field);
 *   3. A REPEATED KEY finds its reservation (the same request is that reservation, nothing below is asked
 *      again; any other request is `idempotency_conflict`);
 *   4. the owner's ceilings (`partition_not_offered`, `over_job_limit`);
 *   5. the person's live jobs against the owner's limit (`over_concurrency`);
 *   6. THE HOLD, one conditional INSERT that also carries the client's caps and the platform budget:
 *      `no_compute_access` or `suspended` again if access ended in between, `insufficient_balance`,
 *      `over_concurrency`, `client_cap_reached`, `platform_budget_exhausted`, told apart by a read AFTER the
 *      refusal and never by a pre-check.
 */
export async function reserveHold(
  env: Bindings,
  caller: PartnerCaller,
  key: string,
  bodyText: string,
): Promise<ReserveResult> {
  const db = env.DB;
  // 1. The person.
  const { refusal, facts } = await standing(db, caller.userId);
  if (refusal !== null) return refuse(refusal);
  const sub = facts?.oidc_subject ?? null;
  if (sub === null) return refuse("no_compute_access");

  // 2. The body.
  let value: unknown;
  try {
    value = JSON.parse(bodyText);
  } catch {
    return refuse("invalid_spec", { field: "body" });
  }
  const parsed = ComputeHoldRequestSchema.safeParse(value);
  if (!parsed.success) {
    const path = parsed.error.issues[0]?.path ?? [];
    return refuse("invalid_spec", { field: path.length > 0 ? fieldPath(path) : "body" });
  }
  const body = parsed.data;

  const policyView = await getPolicy(db);
  const policy = policyView.policy;
  const hash = await requestHash("POST", "/compute/holds", caller.userId, bodyText);

  // 3. A repeated key: the reservation again, or a conflict. Nothing below is asked.
  const claimed = await db
    .prepare(IDEMPOTENCY_BY_KEY_SQL)
    .bind(caller.scope, key)
    .first<{ request_hash: string }>();

  if (claimed === null) {
    // 4. The owner's ceilings.
    const over = jobCeilingRefusal(policy, {
      partition: body.partition,
      nodes: body.nodes,
      cores: body.cores,
      gpus: body.gpus,
      minutes: body.minutes,
    });
    if (over !== null) return refuse(over);
    // 5. The person's live jobs.
    const live =
      (await db.prepare(ACCOUNT_LIVE_COUNT_SQL).bind(caller.userId).first<{ n: number }>())?.n ?? 0;
    if (live >= policy.maxLiveJobsPerPerson) return refuse("over_concurrency");
  }

  // 6. The hold.
  const caps = await effectiveCaps(env, caller.clientId, policy);
  let created: PartnerCreateResult;
  try {
    created = await createReservation(env, caller, key, bodyText, hash, sub, caps);
  } catch (err) {
    if (err instanceof ComputeJobError) {
      if (err.code === "idempotency_conflict") return refuse("idempotency_conflict");
      if (err.code === "pool_not_found") return refuse("compute_disabled");
    }
    throw err;
  }
  if (!created.ok) return refuse(created.code as ComputePartnerErrorCode, { field: created.field });
  if (!created.recordsWritten) {
    // The hold stands and the record did not land: a repeat of the key finishes it.
    return refuse("storage_unavailable", { job_id: created.job.id });
  }
  return holdAnswer(created.job, policy, created.replayed);
}

async function createReservation(
  env: Bindings,
  caller: PartnerCaller,
  key: string,
  bodyText: string,
  hash: string,
  sub: string,
  caps: PartnerCaps,
) {
  return createJob(env, {
    source: "partner",
    accountId: caller.userId,
    clientId: caller.clientId,
    tapisOwner: tapisUsernameForSub(sub),
    holdBody: bodyText,
    requireActiveAccess: true,
    caps,
    idempotency: { scope: caller.scope, key, requestHash: hash },
  });
}

// --- Ownership --------------------------------------------------------------------------------------

/**
 * The reservation this person and this client own, or null for any other reason: another person's, another
 * client's, an absent one, a job that is not a partner's, a malformed id. The answer never says which.
 */
export async function ownReservation(
  env: Bindings,
  caller: PartnerCaller,
  jobId: string,
): Promise<ComputeJobRow | null> {
  if (!COMPUTE_JOB_ID_RE.test(jobId)) return null;
  const job = await getJob(env.DB, jobId);
  if (
    job === null ||
    job.source !== "partner" ||
    job.account_id !== caller.userId ||
    job.client_id !== caller.clientId
  ) {
    return null;
  }
  return job;
}

const CLAIM_SQL = `INSERT INTO compute_idempotency_keys (scope, key, request_hash, job_id)
  VALUES (?1, ?2, ?3, ?4) ON CONFLICT (scope, key) DO NOTHING`;

/**
 * Claim an `Idempotency-Key` for a request about a job the caller owns. A key that is new is claimed; a key
 * that is held by the SAME request (the same hash) is a repeat, which the caller answers from the job's
 * state; a key held by another request is `idempotency_conflict`. Written only for a job that exists and is
 * the caller's, so an absent job leaves no row.
 */
async function claimKey(
  db: D1Database,
  caller: PartnerCaller,
  key: string,
  hash: string,
  jobId: string,
): Promise<"new" | "repeat" | "conflict"> {
  const wrote = await db.prepare(CLAIM_SQL).bind(caller.scope, key, hash, jobId).run();
  if ((wrote.meta?.changes ?? 0) === 1) return "new";
  const row = await db
    .prepare(IDEMPOTENCY_BY_KEY_SQL)
    .bind(caller.scope, key)
    .first<{ request_hash: string }>();
  return row?.request_hash === hash ? "repeat" : "conflict";
}

// --- A report -----------------------------------------------------------------------------------------

/** Another row holds this uuid as its Tapis job or its orphan. `?1` the uuid, `?2` this job. */
const UUID_TAKEN_SQL = `SELECT 1 AS taken FROM compute_jobs
  WHERE id <> ?2 AND (tapis_uuid = ?1 OR orphan_tapis_uuid = ?1) LIMIT 1`;

/**
 * Bind the uuid to the reservation: one conditional UPDATE. The reservation must be live and still
 * unbound, not cancelled, and the person's compute access must be `active` in this statement (a late
 * report after a suspension or a revocation binds nothing). `?1` the job, `?2` the uuid, `?3` Tapis's status
 * (or NULL when the read could not be made).
 */
export const BIND_REPORT_SQL = `UPDATE compute_jobs SET
    tapis_uuid = ?2, partner_state = 'pending', partner_flag = NULL,
    tapis_status = COALESCE(?3, tapis_status), submitted_at = datetime('now'), examined_at = NULL
  WHERE id = ?1 AND source = 'partner' AND state = 'created' AND tapis_uuid IS NULL
    AND partner_state IS NULL AND cancel_requested_at IS NULL
    AND EXISTS (SELECT 1 FROM users u WHERE u.id = compute_jobs.account_id
                  AND u.compute_access = 'active' AND u.deleted_at IS NULL)`;

const looksUnique = (err: unknown) => /UNIQUE constraint failed/i.test(String(err));

export type ReportResult =
  | { ok: true; status: 200 | 202; body: ComputePartnerReportResponse }
  | PartnerRefusal;

const UPLOAD_METHOD = "PUT" as const;

type FilesAnswer = NonNullable<ComputePartnerReportResponse["files"]>;

/** The upload addresses for declared files, or the refusal. */
async function addressesFor(
  env: Bindings,
  job: ComputeJobRow,
  files: ComputeReportFile[],
): Promise<{ ok: true; files: FilesAnswer } | PartnerRefusal> {
  try {
    const signed = await presignIncomingUploads(env, job.id, files as DeclaredFile[]);
    if (!signed.ok) return filesRefusal(signed.code, signed.field);
    return {
      ok: true,
      files: {
        state: "awaiting_upload",
        expires_at: signed.expires_at,
        uploads: signed.uploads.map((u) => ({
          path: u.path,
          url: u.url,
          method: UPLOAD_METHOD,
          headers: u.headers,
        })),
      },
    };
  } catch (err) {
    if (err instanceof ComputeS3Error) return refuse("storage_unavailable");
    throw err;
  }
}

function filesRefusal(code: string, field?: string): PartnerRefusal {
  switch (code) {
    case "invalid_spec":
      return refuse("invalid_spec", { field: field ?? "files" });
    case "bundle_too_many_files":
      return refuse("bundle_too_many_files");
    case "bundle_too_large":
      return refuse("bundle_too_large");
    case "bad_state":
      // The address or the copy is refused for a state: either the records are already written (a repeat
      // with other files) or the files are not all there; the caller decides which it is.
      return refuse("invalid_spec", { field: field ?? "files" });
    default:
      return refuse("storage_unavailable");
  }
}

/**
 * What became of the files of a VERIFIED job: copied into the record if every declared file is there at
 * its declared size, otherwise addresses to upload to. Called only after the read-back matched.
 */
async function settleFiles(
  env: Bindings,
  job: ComputeJobRow,
  files: ComputeReportFile[],
): Promise<{ ok: true; files: FilesAnswer } | PartnerRefusal> {
  try {
    const done = await finalizeSubmittedFiles(env, job.id, { files });
    if (done.ok) return { ok: true, files: { state: "recorded" } };
    if (done.code === "bad_state" && done.field !== undefined && job.records_written_at === null) {
      // A declared file is not uploaded yet: upload it and send the same report again.
      return addressesFor(env, job, files);
    }
    if (done.code === "bad_state" && job.records_written_at !== null) {
      // The record already holds other files: they are never replaced.
      return refuse("invalid_spec", { field: "files" });
    }
    return filesRefusal(done.code, done.field);
  } catch (err) {
    if (err instanceof ComputeS3Error) return refuse("storage_unavailable");
    throw err;
  }
}

function reportBody(
  job: ComputeJobRow,
  verification: "verified" | "pending",
  files: FilesAnswer | undefined,
  replayed: boolean,
): ComputePartnerReportResponse {
  return {
    job_id: job.id,
    verification,
    state: job.state,
    ...(files === undefined ? {} : { files }),
    ...(replayed ? { replayed: true as const } : {}),
  };
}

/** The mismatch a refused reservation carries, as the partner is told it. */
function mismatchWord(job: ComputeJobRow): ComputeReportMismatch {
  const flag = job.partner_flag;
  return flag === "app_mismatch" || flag === "resources_mismatch" ? flag : "owner_mismatch";
}

/**
 * `POST /compute/jobs/:id/report`. In order:
 *   1. the job is this person's AND this client's, else `job_not_found`;
 *   2. the key (`idempotency_conflict`);
 *   3. a reservation that was refused before is `report_mismatch` again; one that ended unbound is
 *      `hold_released`; a cancelled one is `hold_cancelled`; one whose person's compute ended is
 *      `suspended`/`no_compute_access`;
 *   4. the uuid: the same one is a repeat, another is `already_bound`;
 *   5. NEMAR reads the Tapis job (8 seconds): a job that is NEMAR's own, or another reservation's, is
 *      `tapis_job_in_use` and is never bound or cancelled; a job Tapis does not have is `tapis_job_not_found`;
 *      a Tapis that cannot be read binds the row `pending` (202) for the tick;
 *   6. the bind (one conditional UPDATE, a unique index behind it), then the verification: a match is
 *      `verified` (200), a mismatch is `report_mismatch` (409, the Tapis job being cancelled);
 *   7. the files, only after the match.
 */
export async function reportJob(
  env: Bindings,
  caller: PartnerCaller,
  jobId: string,
  key: string,
  bodyText: string,
  body: ComputeReportRequest,
): Promise<ReportResult> {
  const db = env.DB;
  const found = await ownReservation(env, caller, jobId);
  if (found === null) return refuse("job_not_found");
  let job = found;
  const hash = await requestHash("POST", `/compute/jobs/${jobId}/report`, caller.userId, bodyText);
  const claim = await claimKey(db, caller, key, hash, jobId);
  if (claim === "conflict") return refuse("idempotency_conflict");
  const replayed = claim === "repeat";
  const uuid = body.tapis_job_id;

  // Declared files are judged BEFORE anything is bound: a list the owner's limits or the path rule refuse
  // is refused whole (traversal in any encoding, too many, too large, a digest that is not one), so a
  // hostile list leaves no binding behind.
  if (body.files !== undefined && job.records_written_at === null) {
    const bad = await checkPartnerFiles(env, job.id, body.files);
    if (bad !== null) return filesRefusal(bad.code, bad.field);
  }

  // A reservation that was refused is refused again, and the cancel is asked again (idempotent).
  if (job.partner_state === "mismatch") {
    await finishMismatch(env, job.id, REQUEST_READ);
    return refuse("report_mismatch", { mismatch: mismatchWord(job), job_id: job.id });
  }
  if (job.tapis_uuid === null) {
    if (isTerminalComputeState(job.state)) return refuse("hold_released");
    if (job.cancel_requested_at !== null) return refuse("hold_cancelled");
    const { refusal } = await standing(db, caller.userId);
    if (refusal !== null) return refuse(refusal);
  } else if (job.tapis_uuid !== uuid) {
    return refuse("already_bound", { job_id: job.id });
  }

  // Bind, if this is the first report of the uuid.
  let rec: TapisJob | null = null;
  let unreadable = false;
  if (job.tapis_uuid === null) {
    const ctx = tapisAccess(env, REQUEST_READ);
    if (ctx === null) unreadable = true;
    else {
      try {
        rec = await getTapisJob(ctx, uuid);
      } catch (err) {
        if (err instanceof TapisError && err.kind === "not_found") {
          return refuse("tapis_job_not_found");
        }
        unreadable = true;
      }
      // NEMAR's own job, or another reservation's: never bound, never cancelled on a partner's word.
      if (rec !== null && isNemarsOwnJob(ctx as NonNullable<typeof ctx>, rec, job.id)) {
        return refuse("tapis_job_in_use");
      }
    }
    if ((await db.prepare(UUID_TAKEN_SQL).bind(uuid, job.id).first()) !== null) {
      return refuse("tapis_job_in_use");
    }
    try {
      const bound = await db.prepare(BIND_REPORT_SQL).bind(job.id, uuid, rec?.status ?? null).run();
      if ((bound.meta?.changes ?? 0) !== 1) {
        const now = await getJob(db, job.id);
        if (now?.tapis_uuid === uuid) {
          // Another request bound this very uuid first: a repeat.
        } else if (now?.tapis_uuid != null) {
          return refuse("already_bound", { job_id: job.id });
        } else if (now !== null && isTerminalComputeState(now.state)) {
          return refuse("hold_released");
        } else if (now?.cancel_requested_at != null) {
          return refuse("hold_cancelled");
        } else {
          const { refusal } = await standing(db, caller.userId);
          return refuse(refusal ?? "hold_released");
        }
      }
    } catch (err) {
      if (looksUnique(err)) return refuse("tapis_job_in_use");
      throw err;
    }
    job = (await getJob(db, job.id)) ?? job;
  }

  let files: FilesAnswer | undefined;

  // The read-back.
  let verification: "verified" | "pending" = "pending";
  if (job.partner_state === "verified") verification = "verified";
  else if (job.partner_state === "pending" && !unreadable) {
    const outcome = await verifyBoundJob(env, job.id, {
      ...(rec === null ? {} : { record: rec }),
      read: REQUEST_READ,
    });
    job = outcome.job ?? job;
    if (outcome.kind === "mismatch") {
      // The intent is recorded; the cancel is made now, and retried by the tick if Tapis does not take it.
      await finishMismatch(env, job.id, REQUEST_READ);
      return refuse("report_mismatch", { mismatch: outcome.flag, job_id: job.id });
    }
    if (outcome.kind === "verified") verification = "verified";
    if (outcome.kind === "skipped" && job.partner_state === null) {
      // The binding was withdrawn: the job is NEMAR's own.
      return refuse("tapis_job_in_use");
    }
  }

  // The files enter the record only after the match. A job NEMAR cannot read back yet is given addresses
  // to upload to (nothing is copied), and the same report again, once it is verified, finishes the copy.
  if (body.files !== undefined) {
    const settled =
      verification === "verified"
        ? await settleFiles(env, job, body.files)
        : job.records_written_at === null
          ? await addressesFor(env, job, body.files)
          : null;
    if (settled !== null) {
      if (!settled.ok) return settled;
      files = settled.files;
    }
  }
  job = (await getJob(db, job.id)) ?? job;
  return {
    ok: true,
    status: verification === "verified" ? 200 : 202,
    body: reportBody(job, verification, files, replayed),
  };
}

// --- A release ----------------------------------------------------------------------------------------

export type ReleaseResult =
  | { ok: true; body: ComputePartnerReleaseResponse }
  | PartnerRefusal;

/**
 * `DELETE /compute/holds/:id`. The id is the hold id the reservation was answered with. A reservation
 * with no Tapis job is released through the lifecycle's own release (the hold given back in full, the job
 * `cancelled`); one already released answers 200 again; one a Tapis job is bound to is `hold_bound`. The
 * release statement binds "no Tapis job" itself, so a report that bound a job in the meantime wins.
 */
export async function releaseReservation(
  env: Bindings,
  caller: PartnerCaller,
  holdId: string,
  key: string,
): Promise<ReleaseResult> {
  const jobId = jobIdForHold(holdId);
  if (jobId === null) return refuse("job_not_found");
  const found = await ownReservation(env, caller, jobId);
  if (found === null) return refuse("job_not_found");
  let job = found;
  const hash = await requestHash("DELETE", `/compute/holds/${holdId}`, caller.userId, "");
  const claim = await claimKey(env.DB, caller, key, hash, jobId);
  if (claim === "conflict") return refuse("idempotency_conflict");

  const answer = (replayed: boolean): ReleaseResult => ({
    ok: true,
    body: {
      job_id: job.id,
      hold_id: holdIdForJob(job.id),
      released: true,
      state: job.state,
      ...(replayed ? { replayed: true as const } : {}),
    },
  });

  if (job.tapis_uuid !== null || job.partner_state !== null) return refuse("hold_bound");
  if (isTerminalComputeState(job.state)) {
    // Released already (by the partner, by the reaper or by the person's cancel): the same answer again.
    return answer(true);
  }
  const ended = await endPartnerReservation(env, job, "partner_release");
  job = (await getJob(env.DB, job.id)) ?? job;
  if (ended) return answer(false);
  // The release lost to a report that bound a job, or to another release.
  if (job.tapis_uuid !== null || job.partner_state !== null) return refuse("hold_bound");
  return isTerminalComputeState(job.state) ? answer(true) : refuse("hold_bound");
}
