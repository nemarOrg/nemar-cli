/**
 * The runner queue: claim, heartbeat, complete, leases, deadlines and settlement (portable compute, card
 * DM-07; decisions D2, D4 and D6; ADR 0121, decisions 2, 4 and 6; protocol `nemar.runner.v1`).
 *
 * A WAITING runner job is `created` with `runner_claimed_at` NULL (no new state). A registered runner CLAIMS a
 * list of them, keeps each with HEARTBEATS, uploads only under its current LEASE and COMPLETES each, and the
 * job ends in the terminal state the Tapis lifecycle would give it: the same launcher documents, the same
 * `verifyResults`, the same terminal batch (`commitTerminal`), whose `accounting = 'none'` branch writes no
 * ledger entry and stamps the row settled with charge 0. Execution is at least once; ACCEPTANCE IS AT MOST
 * ONCE (a lease is replaced only by a release of an UNSTARTED claim, and a terminal write is a compare on the
 * state the writer read).
 *
 * THE CLAIM IS ONE CONDITIONAL UPDATE per job ({@link CLAIM_RUNNER_JOB_SQL}), the shape of
 * `claimOpenDispatch`: it admits the oldest waiting job of the runner's pool that fits, whose dataset still
 * passes the pipeline eligibility predicate inside the same statement (`PIPELINE_ELIGIBLE_SQL`, joined through
 * the job's stamp: a job with no linked stamp is simply not claimed yet), and only while the runner's
 * registration is unrevoked and its registering owner still stands (`OWNER_STANDING_SQL`). A claim that passed
 * `runnerAccess` before a revoke and commits after it therefore wins nothing. `meta.changes = 1` is the
 * winner test, and each winner has its own lease id.
 *
 * LEASES. A claim's lease lasts `RUNNER_LEASE_SECONDS` on D1's clock; a heartbeat renews it. An unstarted
 * expired lease RELEASES the claim (the count stays counted: at the third the job fails `runner_lost`
 * `claims_exhausted`). A started job whose lease expires is `unreported`, KEEPING its lease id, so a runner
 * that was only partitioned can still land its outputs; an `unreported` job whose outputs completed is
 * verified, one that did not fails `runner_lost` (`runner_revoked` at once when its runner's registration was
 * revoked, which DM-05's revoke batch leaves with the lease cleared and `lease_expires_at` NULL, so the sweep
 * selects by the state and the runner's `revoked_at`; `lease_expired` after `RUNNER_LOST_GIVE_UP_MINUTES`). A
 * started job a grace past its minutes without completed outputs fails `deadline_exceeded`.
 *
 * A CANCEL IS CARRIED BACK ON THE HEARTBEAT. No runner job with a recorded cancel stays live: the sweep ends
 * it when its lease is not current (expired, cleared, or its runner revoked): `cancelled` if its outputs did
 * not complete, verified if they did. A waiting job is ended by `endWaitingRunnerJob` (the lifecycle).
 *
 * EVERY STATEMENT THAT WRITES A LIVE STATE (`running`, `archiving`, `unreported`) TO A RUNNER JOB carries
 * `cancel_requested_at IS NULL`, so a recorded cancel can never be walked back into a live state; a source
 * search test holds this.
 *
 * {@link sweepRunnerLeases} runs on every claim call (so the local stack and staging get it whenever a runner
 * polls) and on the production 30-minute tick; it reads no switch, so turning runners off never strands a
 * claimed job. It is bounded (`RUNNER_SWEEP_BATCH` rows a call, shared by its steps) and logs one line of counts.
 *
 * Logs carry fixed words and counts only: no job id, token, address, specification or name.
 */

import { findRecipe, isSourceCommit } from "../../../shared/compute-recipes.js";
import {
  type ComputeFailureCode,
  type ComputeFailureDetail,
  LAUNCHER_DETAILS,
  LAUNCHER_EXIT_FIRST,
  LAUNCHER_FAILURE_CODES,
  type LauncherFailureCode,
  type RunnerLostDetail,
  canTransitionCompute,
  isPlatformFailure,
  resultRefusalOf,
} from "../../../shared/compute-state.js";
import type { COMPUTE_RUNNER_ATTENTION_WORDS } from "../../../shared/contract/compute-admin.js";
import {
  LEASE_ID_RE,
  RUNNER_DEADLINE_GRACE_MINUTES,
  RUNNER_LEASE_SECONDS,
  RUNNER_LOST_GIVE_UP_MINUTES,
  RUNNER_MAX_CLAIMS,
  RUNNER_SEMVER_RE,
  RUNNER_SWEEP_BATCH,
  type RunnerClaimedJob,
  type RunnerCompleteRequest,
  type RunnerHeartbeatRequest,
} from "../../../shared/contract/compute-runner.js";
import type { Bindings } from "../types/bindings.js";
import { type ComputeJobRow, getJob, writeRecords } from "./compute-jobs.js";
import {
  CANCEL_PENDING_FAILED_MINUTES,
  RECORDS_COPY_RETRY_DAYS,
  STAMP_EXAMINED_SQL,
  type TerminalPlan,
  afterTerminal,
  buildLaunch,
  commitTerminal,
  copyResultRecords,
  endWaitingRunnerJob,
  errorClassName,
  launcherDocumentLimit,
  recordsRetentionYears,
} from "./compute-lifecycle.js";
import { PIPELINE_ELIGIBLE_SQL } from "./compute-pipeline-eligibility.js";
import { recipeJobSpec } from "./compute-pipeline.js";
import { sha256Hex } from "./compute-records.js";
import {
  OWNER_STANDING_SQL,
  type RunnerPrincipal,
  randomHex,
  toProtocolTimestamp,
} from "./compute-runners.js";
import { readRuntimeImage } from "./compute-runtime-image.js";
import { LIVE_STATES_SQL, TERMINAL_STATES_SQL } from "./compute-state-sql.js";
import { readLauncherDocs, verifyResults } from "./compute-verify.js";
import type { TapisJob } from "./tapis/client.js";

// --- Numbers -------------------------------------------------------------------------------------

/** The oldest `nemar-runner` version a claim is served: an older one is refused `runner_outdated`. */
export const RUNNER_MIN_VERSION = "0.1.0";

/** A waiting runner row whose records have not landed is replayed once it is this old, in minutes. */
export const RUNNER_RECORDS_REPLAY_MINUTES = 5;

// --- The claim -----------------------------------------------------------------------------------

/**
 * The terms that make a job claimable, over the alias `a` of `compute_jobs`: a waiting runner job
 * (`created`, unclaimed, records landed, no cancel recorded, claims left) of the runner's pool that fits
 * (`?6` pool, `?7` cores, `?8` memory, `?9` GPUs) and whose dataset, found through the job's own stamp, still
 * passes the pipeline eligibility predicate. Written for both the subselect that picks the oldest and the
 * outer row the UPDATE writes, so the statement is atomic by itself.
 */
const claimable = (a: string): string => `${a}.executor = 'runner' AND ${a}.accounting = 'none'
      AND ${a}.state = 'created' AND ${a}.runner_claimed_at IS NULL
      AND ${a}.records_written_at IS NOT NULL AND ${a}.cancel_requested_at IS NULL
      AND ${a}.claim_attempts < ?5
      AND ${a}.pool = ?6 AND ${a}.cores_per_node <= ?7 AND COALESCE(${a}.memory_mb, 0) <= ?8
      AND ${a}.gpus <= ?9
      AND EXISTS (SELECT 1 FROM compute_pipeline_stamps s JOIN datasets d ON d.dataset_id = s.dataset_id
                   WHERE s.job_id = ${a}.id AND ${PIPELINE_ELIGIBLE_SQL})`;

/**
 * One job's claim. `?1` the runner id, `?2` the runner's backend, `?3` the new lease id, `?4` a fresh
 * webhook nonce (written only when the row has none: DM-05's release does not clear it, but the job token is
 * minted from it), `?5` the most claims, `?6` pool, `?7` cores, `?8` memory in MB, `?9` GPUs.
 *
 * The WHERE clause, in words: the oldest waiting job that fits and whose dataset is still eligible (the
 * subselect), and that same row still waiting (the repeated terms), and ONLY WHILE the registration is
 * unrevoked and its registering owner is still an approved, undeleted owner (`compute_runners` joined to
 * `users`). So a claim that passed `runnerAccess` before a revoke, or before the owner was demoted or
 * deleted, and commits after, changes no row. `meta.changes = 1` is the winner test: D1 serialises two
 * statements, and the second finds the row claimed. A lease lasts `RUNNER_LEASE_SECONDS` on D1's clock.
 */
export const CLAIM_RUNNER_JOB_SQL = `UPDATE compute_jobs SET
    runner_claimed_at = datetime('now'),
    runner_id = ?1,
    runner_backend = ?2,
    lease_id = ?3,
    lease_expires_at = datetime('now', '+${RUNNER_LEASE_SECONDS} seconds'),
    claim_attempts = claim_attempts + 1,
    webhook_nonce = COALESCE(webhook_nonce, ?4)
  WHERE id = (SELECT j.id FROM compute_jobs j
               WHERE ${claimable("j")}
               ORDER BY j.created_at ASC, j.id ASC LIMIT 1)
    AND ${claimable("compute_jobs")}
    AND EXISTS (SELECT 1 FROM compute_runners r JOIN users u ON u.id = r.registered_by
                 WHERE r.id = ?1 AND r.revoked_at IS NULL AND ${OWNER_STANDING_SQL})`;

/** The job a claim just won, found by its own lease id (random, so it names one row). `?1` the lease, `?2` the runner. */
export const CLAIMED_BY_LEASE_SQL =
  "SELECT id FROM compute_jobs WHERE lease_id = ?1 AND runner_id = ?2";

/**
 * The digest of the launch specification a claim answers, written under the lease (a re-claim overwrites it
 * from its own specification): `?1` the job, `?2` the lease, `?3` the runner, `?4` the digest. It writes
 * nothing for a job whose lease was released or replaced, or that got a cancel, so such a job is never
 * answered.
 */
export const LAUNCH_DIGEST_UNDER_LEASE_SQL = `UPDATE compute_jobs SET launch_spec_digest = ?4
  WHERE id = ?1 AND executor = 'runner' AND lease_id = ?2 AND runner_id = ?3 AND state = 'created'
    AND cancel_requested_at IS NULL`;

/** Give a claim back when the launch specification could not be built from configuration: `?1` the job, `?2` the lease. */
export const RELEASE_CLAIM_SQL = `UPDATE compute_jobs SET
    runner_claimed_at = NULL, runner_id = NULL, lease_id = NULL, lease_expires_at = NULL
  WHERE id = ?1 AND executor = 'runner' AND lease_id = ?2 AND state = 'created' AND started_at IS NULL`;

/** The semantic version `v` as numbers and its pre-release text, or null when it is not one. */
function semverParts(v: string): { core: [number, number, number]; pre: string | null } | null {
  const m = RUNNER_SEMVER_RE.exec(v);
  if (!m) return null;
  const core: [number, number, number] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const pre = /-([0-9A-Za-z.-]+)/.exec(v.split("+")[0] as string)?.[1] ?? null;
  return { core, pre };
}

/** Whether version `version` is at least `min` (a pre-release is below its release). A value that is no version is not. */
export function runnerVersionAtLeast(version: string, min: string = RUNNER_MIN_VERSION): boolean {
  const a = semverParts(version);
  const b = semverParts(min);
  if (a === null || b === null) return false;
  for (let i = 0; i < 3; i++) {
    const x = a.core[i] as number;
    const y = b.core[i] as number;
    if (x !== y) return x > y;
  }
  if (a.pre === null) return true;
  return b.pre !== null && a.pre >= b.pre;
}

export interface ClaimResult {
  jobs: RunnerClaimedJob[];
}

const TERMINAL_FAILED = (
  code: ComputeFailureCode,
  detail: ComputeFailureDetail | null,
  over: Partial<TerminalPlan> = {},
): TerminalPlan => ({
  to: "failed",
  failureCode: code,
  failureDetail: detail,
  cancelReason: null,
  platformFailure: isPlatformFailure(code, detail),
  verified: false,
  mismatch: false,
  tapisStatus: null,
  remoteSubmittedAt: null,
  startedAt: null,
  endedAt: null,
  slurmJobId: null,
  // Never read: an `accounting = 'none'` job's batch has no ledger statement (`commitTerminal`).
  settlement: { kind: "release" },
  unsubmittedOnly: false,
  ...over,
});

/**
 * Claim up to `freeSlots` waiting jobs for a runner: one conditional UPDATE each ({@link CLAIM_RUNNER_JOB_SQL}),
 * the launch specification built for each winner and its digest written under the lease. A winner whose
 * specification cannot be built from configuration is given back; one that can never be built ends failed.
 * Never throws for a lost race: a claim that changes no row ends the loop.
 */
export async function claimRunnerJobs(
  env: Bindings,
  runner: RunnerPrincipal,
  freeSlots: number,
): Promise<ClaimResult> {
  const db = env.DB;
  const jobs: RunnerClaimedJob[] = [];
  for (let i = 0; i < freeSlots; i++) {
    const leaseId = randomHex(16);
    const won = await db
      .prepare(CLAIM_RUNNER_JOB_SQL)
      .bind(
        runner.id,
        runner.backend,
        leaseId,
        crypto.randomUUID(),
        RUNNER_MAX_CLAIMS,
        runner.pool,
        runner.cores,
        runner.memory_mb,
        runner.gpus,
      )
      .run();
    if ((won.meta?.changes ?? 0) !== 1) break;
    const named = await db
      .prepare(CLAIMED_BY_LEASE_SQL)
      .bind(leaseId, runner.id)
      .first<{ id: string }>();
    if (!named) continue; // a revoke cleared the claim between the two statements
    const job = await getJob(db, named.id);
    if (!job || job.lease_id !== leaseId) continue;

    const built = await buildLaunch(env, job);
    if (!built.ok) {
      if (built.why === "unconfigured") {
        await db.prepare(RELEASE_CLAIM_SQL).bind(job.id, leaseId).run();
        console.error("[compute-runner-queue] launch_unconfigured");
        break; // the same for every job: stop asking
      }
      // The recorded specification can never launch: the job is over, as a Tapis job that cannot be submitted is.
      console.error("[compute-runner-queue] launch_unbuildable");
      await endRunnerJob(env, job, { kind: "launch_unbuildable" });
      continue;
    }
    const wrote = await db
      .prepare(LAUNCH_DIGEST_UNDER_LEASE_SQL)
      .bind(job.id, leaseId, runner.id, built.launch.digest)
      .run();
    if ((wrote.meta?.changes ?? 0) !== 1) continue;
    jobs.push({
      id: job.id,
      lease_id: leaseId,
      lease_expires_at: toProtocolTimestamp(job.lease_expires_at as string),
      launch_spec_env: built.launch.launchSpecEnv,
      image: built.launch.image,
      cores: job.cores_per_node,
      memory_mb: job.memory_mb,
      gpus: job.gpus,
      minutes: job.minutes,
    });
  }
  return { jobs };
}

// --- The heartbeat -------------------------------------------------------------------------------

/**
 * `started`: `created -> running`, with `started_at`. Only while no cancel is recorded. `?1` the job, `?2`
 * the runner, `?3` the lease.
 */
export const HEARTBEAT_STARTED_SQL = `UPDATE compute_jobs SET
    state = 'running', started_at = COALESCE(started_at, datetime('now'))
  WHERE id = ?1 AND executor = 'runner' AND runner_id = ?2 AND lease_id = ?3
    AND state = 'created' AND cancel_requested_at IS NULL`;

/** `uploading`: `running -> archiving`. Only while no cancel is recorded. `?1` the job, `?2` the runner, `?3` the lease. */
export const HEARTBEAT_UPLOADING_SQL = `UPDATE compute_jobs SET state = 'archiving'
  WHERE id = ?1 AND executor = 'runner' AND runner_id = ?2 AND lease_id = ?3
    AND state = 'running' AND cancel_requested_at IS NULL`;

/**
 * Renew the lease of a live job the runner holds: `?1` the job, `?2` the runner, `?3` the lease. A job that
 * is terminal, or whose lease is not this one, changes no row, and that is the `lease_lost` answer.
 */
export const HEARTBEAT_RENEW_SQL = `UPDATE compute_jobs SET
    lease_expires_at = datetime('now', '+${RUNNER_LEASE_SECONDS} seconds')
  WHERE id = ?1 AND executor = 'runner' AND runner_id = ?2 AND lease_id = ?3
    AND state IN (${LIVE_STATES_SQL})`;

export type HeartbeatResult =
  | { ok: true; lease_expires_at: string; cancel: boolean }
  | { ok: false; refusal: "lease_lost" };

/** A heartbeat: the phase's state write, then the renewal, in one batch; the answer says whether to stop. */
export async function heartbeatRunnerJob(
  env: Bindings,
  runner: RunnerPrincipal,
  body: RunnerHeartbeatRequest,
): Promise<HeartbeatResult> {
  const db = env.DB;
  const phase = body.phase === "started" ? HEARTBEAT_STARTED_SQL : HEARTBEAT_UPLOADING_SQL;
  const results = await db.batch([
    db.prepare(phase).bind(body.job_id, runner.id, body.lease_id),
    db.prepare(HEARTBEAT_RENEW_SQL).bind(body.job_id, runner.id, body.lease_id),
  ]);
  if ((results[1]?.meta?.changes ?? 0) !== 1) return { ok: false, refusal: "lease_lost" };
  const row = await db
    .prepare("SELECT lease_expires_at, cancel_requested_at FROM compute_jobs WHERE id = ?1")
    .bind(body.job_id)
    .first<{ lease_expires_at: string | null; cancel_requested_at: string | null }>();
  if (!row || row.lease_expires_at === null) return { ok: false, refusal: "lease_lost" };
  return {
    ok: true,
    lease_expires_at: toProtocolTimestamp(row.lease_expires_at),
    cancel: row.cancel_requested_at !== null,
  };
}

// --- Ending a runner job -------------------------------------------------------------------------

/** What ends a runner job, decided before the terminal batch is built. */
export type RunnerEnd =
  /** The runner's own report of how the job ended. */
  | {
      kind: "complete";
      exit: number;
      code: LauncherFailureCode | null;
      detail: string | null;
    }
  /** Outputs completed and the runner is silent: the verification the Tapis path runs for a `FINISHED` job. */
  | { kind: "verify" }
  | { kind: "lost"; detail: RunnerLostDetail }
  | { kind: "cancelled" }
  | { kind: "launch_unbuildable" };

/** The record `verifyResults` reads an exit number from, for a runner job (the Tapis path reads Tapis's). */
function runnerRecord(exit: number | null): TapisJob {
  return {
    uuid: "runner",
    status: "FINISHED",
    ...(exit === null ? {} : { remoteResultInfo: exit }),
  } as unknown as TapisJob;
}

/** The launcher code whose exit number is `n` (the inverse of `launcherExitNumber`), or null. */
export function launcherCodeOfExit(n: number): LauncherFailureCode | null {
  const index = n - LAUNCHER_EXIT_FIRST;
  return index >= 0 && index < LAUNCHER_FAILURE_CODES.length
    ? (LAUNCHER_FAILURE_CODES[index] as LauncherFailureCode)
    : null;
}

/**
 * Whether a code and a detail are declared together in `LAUNCHER_DETAILS`: the detail is absent, or one of
 * the words declared for that code.
 */
function declaredTogether(code: LauncherFailureCode, detail: string | null): boolean {
  if (detail === null) return true;
  return (LAUNCHER_DETAILS[code] as readonly string[]).includes(detail);
}

/**
 * Why a runner job whose runner says it FAILED failed, as `resolveFailure` does for a Tapis job: the
 * Worker's own recorded refusal first; then the launcher's `result.json` when it is TRUSTED (this job's id,
 * a provenance whose launch specification digest is the one NEMAR stored, and an exit number that agrees with
 * the runner's); then the runner's own code and detail only if they are declared together; then the code the
 * exit number names; and else `runner_lost` `lease_expired` (nothing to say what happened).
 */
async function resolveRunnerFailure(
  env: Bindings,
  job: ComputeJobRow,
  report: { exit: number; code: LauncherFailureCode | null; detail: string | null },
): Promise<{ code: ComputeFailureCode; detail: ComputeFailureDetail | null; mismatch: boolean }> {
  const refusal = resultRefusalOf(job.failure_detail);
  if (refusal !== null) return { code: "result_upload_failed", detail: refusal, mismatch: false };
  let mismatch = false;
  if (env.COMPUTE_RESULTS) {
    const docs = await readLauncherDocs(
      env.COMPUTE_RESULTS,
      job.id,
      await launcherDocumentLimit(env),
    );
    if (docs.result.kind === "ok") {
      const result = docs.result.value;
      const provenanceBad =
        docs.provenance.kind === "ok" &&
        (docs.provenance.value.job_id !== job.id ||
          job.launch_spec_digest === null ||
          docs.provenance.value.launch_spec_digest !== job.launch_spec_digest);
      if (result.job_id !== job.id || provenanceBad || report.exit !== result.exit_number) {
        mismatch = true;
      } else if (result.failure_code !== null) {
        return {
          code: result.failure_code,
          detail: result.detail as ComputeFailureDetail | null,
          mismatch,
        };
      }
    }
  }
  if (report.code !== null && declaredTogether(report.code, report.detail)) {
    return { code: report.code, detail: report.detail as ComputeFailureDetail | null, mismatch };
  }
  const named = launcherCodeOfExit(report.exit);
  if (named !== null) return { code: named, detail: null, mismatch };
  return {
    code: "runner_lost",
    detail: "lease_expired" as unknown as ComputeFailureDetail,
    mismatch,
  };
}

/** The plan for a job whose outputs are to be verified (the `FINISHED` branch of the Tapis path). */
async function verifiedPlan(
  env: Bindings,
  job: ComputeJobRow,
  exit: number | null,
): Promise<TerminalPlan> {
  if (!env.COMPUTE_RESULTS || !env.COMPUTE_RECORDS) {
    return TERMINAL_FAILED("records_unavailable", "records_unreadable", { platformFailure: true });
  }
  const verdict = await verifyResults(
    env.COMPUTE_RESULTS,
    env.COMPUTE_RECORDS,
    job,
    runnerRecord(exit),
    await launcherDocumentLimit(env),
  );
  if (verdict.ok) {
    return {
      ...TERMINAL_FAILED("runner_lost", null),
      to: "finished",
      failureCode: null,
      platformFailure: false,
      verified: true,
    };
  }
  // A Worker-recorded refusal is the reason a launcher that was refused did not complete.
  const refusal = resultRefusalOf(job.failure_detail);
  const code: ComputeFailureCode = refusal !== null ? "result_upload_failed" : verdict.code;
  const detail = (refusal ?? verdict.reason) as ComputeFailureDetail;
  return TERMINAL_FAILED(code, detail, { mismatch: verdict.mismatch });
}

/** The plan for an end. */
async function planOf(env: Bindings, job: ComputeJobRow, end: RunnerEnd): Promise<TerminalPlan> {
  // `ComputeFailureDetail` does not name the `runner_lost` details (DM-04's type), which are fixed words the
  // Worker itself chooses and `RUNNER_LOST_DETAILS` declares: the cast is the one place they enter it.
  const lost = (detail: RunnerLostDetail) => detail as unknown as ComputeFailureDetail;
  const cancelled = (): TerminalPlan => ({
    ...TERMINAL_FAILED("runner_lost", null),
    to: "cancelled",
    failureCode: null,
    platformFailure: false,
    cancelReason: job.cancel_reason ?? "user",
  });
  switch (end.kind) {
    case "lost":
      return TERMINAL_FAILED("runner_lost", lost(end.detail));
    case "launch_unbuildable":
      return TERMINAL_FAILED("launch_failed", "invalid_spec");
    case "cancelled":
      return cancelled();
    case "verify":
      return verifiedPlan(env, job, null);
    case "complete": {
      const succeeded = end.exit === 0 && end.code === null;
      // A requested cancel ends the job cancelled, unless the job in fact finished and its outputs are in.
      if (job.cancel_requested_at !== null && !(succeeded && job.outputs_completed_at !== null)) {
        return cancelled();
      }
      if (succeeded) return verifiedPlan(env, job, end.exit);
      const failure = await resolveRunnerFailure(env, job, end);
      return TERMINAL_FAILED(failure.code, failure.detail, { mismatch: failure.mismatch });
    }
  }
}

/**
 * End a runner job: decide the plan, commit the terminal batch (the Tapis path's, with no ledger statement),
 * and answer the plan when THIS writer won the transition (null when another writer did, or the edge does not
 * exist). The records copy and the rest follow in `afterTerminal` and are the caller's to schedule.
 */
export async function endRunnerJob(
  env: Bindings,
  job: ComputeJobRow,
  end: RunnerEnd,
): Promise<TerminalPlan | null> {
  const plan = await planOf(env, job, end);
  if (!canTransitionCompute(job.state, plan.to)) return null;
  const won = await commitTerminal(env, job, plan, await recordsRetentionYears(env));
  return won ? plan : null;
}

// --- Complete ------------------------------------------------------------------------------------

/** The usage a runner measured, written once under the lease: `?1` job, `?2` runner, `?3` lease, `?4`..`?6` the numbers. */
export const RECORD_USAGE_SQL = `UPDATE compute_jobs SET
    runner_wall_seconds = ?4, runner_cpu_seconds = ?5, runner_max_rss_mb = ?6
  WHERE id = ?1 AND executor = 'runner' AND runner_id = ?2 AND lease_id = ?3
    AND state IN (${LIVE_STATES_SQL}) AND runner_wall_seconds IS NULL`;

export type CompleteResult =
  | { ok: true; state: string; after: (() => Promise<void>) | null }
  | { ok: false; refusal: "lease_lost" };

/**
 * A runner's completion. The lease must be the job's (`lease_lost` otherwise, a job of another runner
 * included); a repeat for `(job, lease_id)` answers the stored state and writes nothing (the lease is kept
 * after completion). The usage is recorded once, then the job ends as {@link planOf} says.
 */
export async function completeRunnerJob(
  env: Bindings,
  runner: RunnerPrincipal,
  body: RunnerCompleteRequest,
): Promise<CompleteResult> {
  const job = await getJob(env.DB, body.job_id);
  if (
    !job ||
    job.executor !== "runner" ||
    job.runner_id !== runner.id ||
    job.lease_id === null ||
    !LEASE_ID_RE.test(body.lease_id) ||
    job.lease_id !== body.lease_id
  ) {
    return { ok: false, refusal: "lease_lost" };
  }
  if (TERMINAL_STATES.has(job.state)) return { ok: true, state: job.state, after: null };

  await env.DB.prepare(RECORD_USAGE_SQL)
    .bind(
      job.id,
      runner.id,
      body.lease_id,
      body.usage.wall_seconds,
      body.usage.cpu_seconds,
      body.usage.max_rss_mb,
    )
    .run();
  const fresh = (await getJob(env.DB, job.id)) ?? job;
  const plan = await endRunnerJob(env, fresh, {
    kind: "complete",
    exit: body.exit_number,
    code: body.launcher_failure_code,
    detail: body.launcher_detail,
  });
  const after = await getJob(env.DB, job.id);
  const state = after?.state ?? fresh.state;
  if (plan === null || after === null) return { ok: true, state, after: null };
  return { ok: true, state, after: () => afterTerminal(env, after, plan) };
}

const TERMINAL_STATES: ReadonlySet<string> = new Set(["finished", "failed", "cancelled"]);

// --- The sweep -----------------------------------------------------------------------------------

/** Terms: a registration revoked, for a job `j`. */
const REVOKED = (a: string) =>
  `EXISTS (SELECT 1 FROM compute_runners r WHERE r.id = ${a}.runner_id AND r.revoked_at IS NOT NULL)`;

/**
 * Runner jobs with a recorded cancel whose lease is not current, so nobody is left to carry the cancel out:
 * unclaimed, cleared, expired or its runner revoked. `?1` the limit. NO RUNNER JOB WITH A RECORDED CANCEL
 * STAYS LIVE: the one with a current lease has a runner whose heartbeat is about to be told.
 */
export const CANCELLED_ROWS_SQL = `SELECT j.id FROM compute_jobs j
  WHERE j.executor = 'runner' AND j.state IN (${LIVE_STATES_SQL}) AND j.cancel_requested_at IS NOT NULL
    AND (j.runner_claimed_at IS NULL OR j.lease_id IS NULL OR j.lease_expires_at IS NULL
         OR j.lease_expires_at <= datetime('now') OR ${REVOKED("j")})
  ORDER BY j.cancel_requested_at ASC, j.id ASC LIMIT ?1`;

/**
 * Unstarted claims whose lease expired and that have claims left: the claim is cleared and the job waits again
 * (`claim_attempts` stays counted). `?1` the most claims, `?2` the limit.
 */
export const RELEASE_EXPIRED_CLAIMS_SQL = `UPDATE compute_jobs SET
    runner_claimed_at = NULL, runner_id = NULL, lease_id = NULL, lease_expires_at = NULL
  WHERE id IN (SELECT id FROM compute_jobs
                WHERE executor = 'runner' AND state = 'created' AND runner_claimed_at IS NOT NULL
                  AND started_at IS NULL AND cancel_requested_at IS NULL
                  AND lease_expires_at <= datetime('now') AND claim_attempts < ?1
                ORDER BY lease_expires_at ASC LIMIT ?2)
    AND executor = 'runner' AND state = 'created' AND runner_claimed_at IS NOT NULL
    AND started_at IS NULL AND cancel_requested_at IS NULL
    AND lease_expires_at <= datetime('now') AND claim_attempts < ?1`;

/**
 * Waiting or unstarted jobs that have no claims left: unclaimed (a revoke or an expiry gave the last claim
 * back) or claimed with the lease expired. They fail `claims_exhausted`. `?1` the most claims, `?2` the limit.
 */
export const EXHAUSTED_ROWS_SQL = `SELECT id FROM compute_jobs
  WHERE executor = 'runner' AND state = 'created' AND cancel_requested_at IS NULL
    AND claim_attempts >= ?1
    AND (runner_claimed_at IS NULL
         OR (started_at IS NULL AND lease_expires_at IS NOT NULL AND lease_expires_at <= datetime('now')))
  ORDER BY created_at ASC, id ASC LIMIT ?2`;

/**
 * A started job whose lease expired is `unreported` and KEEPS its lease id (a partitioned runner may still
 * land its outputs). Only a job with no recorded cancel. `?1` the limit.
 */
export const UNREPORT_EXPIRED_SQL = `UPDATE compute_jobs SET state = 'unreported'
  WHERE id IN (SELECT id FROM compute_jobs
                WHERE executor = 'runner' AND state IN ('running', 'archiving')
                  AND started_at IS NOT NULL AND cancel_requested_at IS NULL
                  AND lease_expires_at <= datetime('now')
                ORDER BY lease_expires_at ASC LIMIT ?1)
    AND executor = 'runner' AND state IN ('running', 'archiving')
    AND started_at IS NOT NULL AND cancel_requested_at IS NULL
    AND lease_expires_at <= datetime('now')`;

/**
 * `unreported` runner jobs with no recorded cancel that are due: their outputs completed (verify), their
 * runner's registration was revoked (DM-05's revoke batch left the state, `runner_id` and
 * `runner_claimed_at` and cleared the lease, so the selection never uses `lease_expires_at` alone), or the
 * give-up wait has passed. `revoked` is 1 for a revoked runner. `?1` the limit.
 */
export const UNREPORTED_ROWS_SQL = `SELECT j.id, ${REVOKED("j")} AS revoked FROM compute_jobs j
  WHERE j.executor = 'runner' AND j.state = 'unreported' AND j.cancel_requested_at IS NULL
    AND (j.outputs_completed_at IS NOT NULL OR ${REVOKED("j")}
         OR COALESCE(j.lease_expires_at, j.runner_claimed_at, j.created_at)
              <= datetime('now', '-${RUNNER_LOST_GIVE_UP_MINUTES} minutes'))
  ORDER BY COALESCE(j.lease_expires_at, j.runner_claimed_at, j.created_at) ASC, j.id ASC LIMIT ?1`;

/**
 * Started jobs past `started_at` plus their minutes plus the grace, without completed outputs and with no
 * recorded cancel. `?1` the limit.
 */
export const DEADLINE_ROWS_SQL = `SELECT id FROM compute_jobs
  WHERE executor = 'runner' AND state IN ('running', 'archiving', 'unreported')
    AND started_at IS NOT NULL AND outputs_completed_at IS NULL AND cancel_requested_at IS NULL
    AND datetime(started_at, '+' || (minutes + ${RUNNER_DEADLINE_GRACE_MINUTES}) || ' minutes')
          <= datetime('now')
  ORDER BY started_at ASC, id ASC LIMIT ?1`;

/**
 * Waiting runner rows whose records never landed (the dispatch answered `recordsWritten: false`), old enough
 * that the dispatch's own retry is over. `?1` the limit.
 */
export const REPLAY_ROWS_SQL = `SELECT id FROM compute_jobs
  WHERE executor = 'runner' AND state = 'created' AND runner_claimed_at IS NULL
    AND records_written_at IS NULL AND cancel_requested_at IS NULL
    AND created_at <= datetime('now', '-${RUNNER_RECORDS_REPLAY_MINUTES} minutes')
  ORDER BY created_at ASC, id ASC LIMIT ?1`;

/** Terminal runner rows whose launcher files were never copied into the records, in rotation. `?1` the limit. */
export const RUNNER_UNCOPIED_SQL = `SELECT id FROM compute_jobs
  WHERE executor = 'runner' AND state IN (${TERMINAL_STATES_SQL}) AND result_records_at IS NULL
    AND settled_provisional_at IS NOT NULL AND records_deleted_at IS NULL
    AND ended_at >= datetime('now', '-${RECORDS_COPY_RETRY_DAYS} days')
  ORDER BY examined_at ASC, ended_at ASC LIMIT ?1`;

/**
 * Live runner rows whose recorded cancel is still not carried out {@link CANCEL_PENDING_FAILED_MINUTES} minutes
 * after it was asked for: the count of `GET /admin/compute/status`'s `runner_cancel_pending_failed`.
 */
export const RUNNER_CANCEL_PENDING_FAILED_SQL = `SELECT COUNT(*) AS n FROM compute_jobs
  WHERE executor = 'runner' AND state IN (${LIVE_STATES_SQL}) AND cancel_requested_at IS NOT NULL
    AND cancel_requested_at < datetime('now', '-${CANCEL_PENDING_FAILED_MINUTES} minutes')`;

/**
 * Terminal runner rows whose records copy never happened and no longer will (past the window the Tapis
 * `copy_abandoned` uses): the count of `runner_copy_abandoned`.
 */
export const RUNNER_COPY_ABANDONED_SQL = `SELECT COUNT(*) AS n FROM compute_jobs
  WHERE executor = 'runner' AND state IN (${TERMINAL_STATES_SQL}) AND result_records_at IS NULL
    AND settled_provisional_at IS NOT NULL AND records_deleted_at IS NULL
    AND ended_at < datetime('now', '-${RECORDS_COPY_RETRY_DAYS} days')`;

/** The two runner attention counts, by their contract words. */
export const RUNNER_ATTENTION_COUNTS: ReadonlyArray<
  readonly [word: (typeof COMPUTE_RUNNER_ATTENTION_WORDS)[number], sql: string]
> = [
  ["runner_cancel_pending_failed", RUNNER_CANCEL_PENDING_FAILED_SQL],
  ["runner_copy_abandoned", RUNNER_COPY_ABANDONED_SQL],
];

export interface RunnerSweepResult {
  replayed: number;
  cancelled: number;
  released: number;
  exhausted: number;
  unreported: number;
  verified: number;
  lost_revoked: number;
  lost_expired: number;
  lost_deadline: number;
  copied: number;
  errors: number;
}

const emptySweep = (): RunnerSweepResult => ({
  replayed: 0,
  cancelled: 0,
  released: 0,
  exhausted: 0,
  unreported: 0,
  verified: 0,
  lost_revoked: 0,
  lost_expired: 0,
  lost_deadline: 0,
  copied: 0,
  errors: 0,
});

/**
 * A waiting job's specification, rebuilt the way the dispatch built it from the job's own stamp (the tuple the
 * dispatch claimed: dataset, version tag and recipe), the configured runtime image and, for a Zarr recipe, the
 * commit the dataset row records. Null when any of it is gone. Only a candidate: the caller accepts it only
 * when its digest is the one the row holds.
 */
async function rebuiltSpec(env: Bindings, jobId: string) {
  const stamp = await env.DB.prepare(
    "SELECT dataset_id, version, recipe FROM compute_pipeline_stamps WHERE job_id = ?1",
  )
    .bind(jobId)
    .first<{ dataset_id: string; version: string; recipe: string }>();
  const recipe = stamp === null ? null : findRecipe(stamp.recipe);
  const image = readRuntimeImage(env);
  if (stamp === null || recipe === null || image.state !== "ok") return null;
  let sourceCommit: string | null = null;
  if (recipe.input === "zarr") {
    const row = await env.DB.prepare(
      "SELECT zarr_source_commit FROM datasets WHERE dataset_id = ?1",
    )
      .bind(stamp.dataset_id)
      .first<{ zarr_source_commit: string | null }>();
    if (!isSourceCommit(row?.zarr_source_commit)) return null;
    sourceCommit = row?.zarr_source_commit ?? null;
  }
  try {
    return recipeJobSpec(recipe, {
      datasetId: stamp.dataset_id,
      tag: stamp.version,
      image: { ref: image.ref, digest: image.digest },
      sourceCommit,
    });
  } catch {
    return null;
  }
}

/** Rebuild a waiting job's specification from its stamp, and finish its records if it is the one recorded. */
async function replayRecords(env: Bindings, job: ComputeJobRow): Promise<boolean> {
  const spec = await rebuiltSpec(env, job.id);
  if (spec === null) return false;
  const text = JSON.stringify(spec);
  if ((await sha256Hex(new TextEncoder().encode(text))) !== job.spec_digest) return false;
  return writeRecords(env, job, text, false);
}

/**
 * One pass over the runner queue's leases, deadlines, cancels and copies, bounded by `RUNNER_SWEEP_BATCH`
 * rows shared by its steps, in this order (the order is load-bearing: a row an earlier step moves is picked up
 * by a later one in the same call):
 *   1. replay the records of waiting rows whose records never landed;
 *   2. end every recorded cancel whose lease is not current (`cancelled`, or verified when outputs completed);
 *   3. release expired unstarted claims, and fail the ones with no claims left (`claims_exhausted`);
 *   4. move started jobs whose lease expired to `unreported`;
 *   5. settle `unreported` jobs: verify those with outputs, `runner_revoked` for a revoked runner, and
 *      `lease_expired` after the give-up wait;
 *   6. fail started jobs past their deadline;
 *   7. copy the records of terminal runner rows that were not copied.
 * Reads no switch. Never throws: a row's failure is counted and the next row goes on. `db` is the database
 * the statements run on (the Worker's own, `env.DB`).
 */
export async function sweepRunnerLeases(
  env: Bindings,
  db: D1Database = env.DB,
): Promise<RunnerSweepResult> {
  const r = emptySweep();
  let left = RUNNER_SWEEP_BATCH;
  const ids = async (sql: string, ...binds: unknown[]): Promise<string[]> =>
    (
      await db
        .prepare(sql)
        .bind(...binds, left)
        .all<{ id: string }>()
    ).results.map((x) => x.id);

  const each = async (rows: string[], step: (job: ComputeJobRow) => Promise<void>) => {
    for (const id of rows) {
      left--;
      try {
        const job = await getJob(db, id);
        if (job) await step(job);
      } catch (err) {
        r.errors++;
        console.error(`[compute-runner-queue] sweep_step_failed class=${errorClassName(err)}`);
      }
    }
  };

  const finish = async (job: ComputeJobRow, end: RunnerEnd): Promise<boolean> => {
    const plan = await endRunnerJob(env, job, end);
    if (plan === null) return false;
    const done = (await getJob(db, job.id)) ?? job;
    await afterTerminal(env, done, plan);
    return true;
  };

  try {
    // 1. Records that never landed.
    if (left > 0) {
      await each(await ids(REPLAY_ROWS_SQL), async (job) => {
        if (await replayRecords(env, job)) r.replayed++;
      });
    }

    // 2. A recorded cancel with nobody left to carry it out.
    if (left > 0) {
      await each(await ids(CANCELLED_ROWS_SQL), async (job) => {
        if (job.runner_claimed_at === null) {
          if (
            await endWaitingRunnerJob(env, job, job.cancel_reason === "user" ? "user" : "admin")
          ) {
            r.cancelled++;
          }
        } else if (job.outputs_completed_at !== null) {
          if (await finish(job, { kind: "verify" })) r.verified++;
        } else if (await finish(job, { kind: "cancelled" })) {
          r.cancelled++;
        }
      });
    }

    // 3. Unstarted claims: released, or out of claims.
    if (left > 0) {
      const released = await db
        .prepare(RELEASE_EXPIRED_CLAIMS_SQL)
        .bind(RUNNER_MAX_CLAIMS, left)
        .run();
      const n = released.meta?.changes ?? 0;
      r.released += n;
      left -= n;
    }
    if (left > 0) {
      await each(await ids(EXHAUSTED_ROWS_SQL, RUNNER_MAX_CLAIMS), async (job) => {
        if (await finish(job, { kind: "lost", detail: "claims_exhausted" })) r.exhausted++;
      });
    }

    // 4. Started jobs with an expired lease.
    if (left > 0) {
      const moved = await db.prepare(UNREPORT_EXPIRED_SQL).bind(left).run();
      const n = moved.meta?.changes ?? 0;
      r.unreported += n;
      left -= n;
    }

    // 5. `unreported` jobs that are due.
    if (left > 0) {
      const due = (
        await db.prepare(UNREPORTED_ROWS_SQL).bind(left).all<{ id: string; revoked: number }>()
      ).results;
      const revoked = new Map(due.map((x) => [x.id, x.revoked === 1]));
      await each(
        due.map((x) => x.id),
        async (job) => {
          if (job.outputs_completed_at !== null) {
            if (await finish(job, { kind: "verify" })) r.verified++;
          } else if (revoked.get(job.id) === true) {
            if (await finish(job, { kind: "lost", detail: "runner_revoked" })) r.lost_revoked++;
          } else if (await finish(job, { kind: "lost", detail: "lease_expired" })) {
            r.lost_expired++;
          }
        },
      );
    }

    // 6. Past the deadline.
    if (left > 0) {
      await each(await ids(DEADLINE_ROWS_SQL), async (job) => {
        if (await finish(job, { kind: "lost", detail: "deadline_exceeded" })) r.lost_deadline++;
      });
    }

    // 7. Records of terminal rows, in rotation.
    if (left > 0) {
      await each(await ids(RUNNER_UNCOPIED_SQL), async (job) => {
        await db.prepare(STAMP_EXAMINED_SQL).bind(job.id).run();
        try {
          await copyResultRecords(env, job);
          r.copied++;
        } catch (err) {
          r.errors++;
          console.error(`[compute-runner-queue] records_copy_failed class=${errorClassName(err)}`);
        }
      });
    }
  } catch (err) {
    r.errors++;
    console.error(`[compute-runner-queue] sweep_failed class=${errorClassName(err)}`);
  }
  return r;
}

/** The one log line of a sweep, or null when it did and failed nothing. Counts only. */
export function runnerLeaseLogLine(
  r: RunnerSweepResult,
): { level: "info" | "error"; line: string } | null {
  const total = Object.values(r).reduce((a, b) => a + b, 0);
  if (total === 0) return null;
  const parts = Object.entries(r).map(([k, v]) => `${k}=${v}`);
  return {
    level: r.errors > 0 ? "error" : "info",
    line: `[compute-runner-queue] ${parts.join(" ")}`,
  };
}
