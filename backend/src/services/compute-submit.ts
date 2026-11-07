/**
 * A person's job submission (epic #2021 phase D3, #2024; ADR 0118, the amendment of this phase): the
 * logic behind `POST /compute/jobs` and `POST /compute/jobs/:id/finalize`. The routes
 * (`routes/compute/jobs.ts`) own HTTP; this module owns the ORDER, which is the contract.
 *
 * THE ORDER OF REFUSAL for `POST /compute/jobs`; the first check that fails is the answer, and nothing
 * is written by a refusal. (1 and 2 are the route's, before the body is read.)
 *   1. compute access: `canUseCompute(users.compute_access)` (`no_compute_access`, `suspended`);
 *   2. the `Idempotency-Key` header's shape (`invalid_spec`, field `Idempotency-Key`);
 *   3. the body and the specification through the contract (`invalid_spec`, the field, `spec.*` and
 *      `manifest.*`; a manifest without a bundle, or a bundle without a manifest);
 *   4. A REPEATED KEY: the key finds its job; the same specification is that job again (nothing below is
 *      asked, so a replay does not depend on the world having stayed the same), another is
 *      `idempotency_conflict` (422);
 *   5. runtime and mode: a recipe is NEMAR's own (`invalid_spec`), `matlab` and a `python` job while NEMAR's
 *      runtime image is not configured are `runtime_unavailable`, an image from a registry the owner's
 *      list does not name is `registry_not_allowed`;
 *   6. `partition_not_offered`, then `over_job_limit`;
 *   7. `over_concurrency`: the person's live jobs against the owner's limit;
 *   8. the bundle: the manifest's shape and caps and `entry_not_in_bundle`, then the archive's own size
 *      (`invalid_spec`, `bundle_too_many_files`, `bundle_too_large`, `entry_not_in_bundle`);
 *   9. the datasets, through the SAME gate the pipelines use (`resolveRun`): `dataset_not_eligible`,
 *      `version_not_found`, `version_untagged`, `too_many_files`, all before any hold;
 *  10. THE HOLD (`createJob`, with `requireActiveAccess` read in the hold's own statement): `no_compute_access`
 *      or `suspended` again if the access ended in between, `insufficient_balance`, `over_concurrency`,
 *      `platform_budget_exhausted`.
 * Only after the hold commits does the upload address exist: `presignIncomingUploads` reads the job's
 * row, which exists only with its hold, so no address can be issued before a hold (a refused hold has no
 * job to sign for). The address is for the one key `incoming/<id>/bundle.tar.gz`, never one a person
 * names.
 *
 * THE COMPUTE SWITCH IS NOT READ HERE. A job made while compute is off is made (the hold is taken) and
 * `submitComputeJob`, the one place the switch is read, refuses to send it to the cluster; it waits for
 * the reservation wait and then fails `submit_timeout` with its hold released.
 *
 * NOTHING A PERSON CHOSE IS LOGGED: a log line carries a job id and a fixed word.
 */

import { canUseCompute, isComputeAccessState } from "../../../shared/compute-access-state.js";
import { type ComputeState, isTerminalComputeState } from "../../../shared/compute-state.js";
import {
  BUNDLE_ARCHIVE_FILE,
  BundleManifestSchema,
  checkBundleManifest,
} from "../../../shared/contract/compute-bundle.js";
import { launchSpecFits } from "../../../shared/contract/compute-launch.js";
import type {
  ComputeFinalizeResponse,
  ComputeSubmitResponse,
  ComputeSubmitSentenceCode,
  ComputeUpload,
} from "../../../shared/contract/compute-submit.js";
import {
  type ComputePolicy,
  type JobSpec,
  JobSpecSchema,
  datasetVersionWithoutTag,
} from "../../../shared/contract/compute.js";
import type { Bindings } from "../types/bindings.js";
import {
  ComputeJobError,
  type ComputeJobRow,
  JOB_BY_KEY_SQL,
  LIVE_JOBS_GUARD_SQL,
  createJob,
  getJob,
  jobCeilingRefusal,
} from "./compute-jobs.js";
import { endUploadExpired, submitComputeJob } from "./compute-lifecycle.js";
import { PERSON_EXCEPT_TERMS } from "./compute-pipeline-eligibility.js";
import { resolveRun } from "./compute-pipeline.js";
import { fieldPath, getPolicy } from "./compute-policy.js";
import {
  BUNDLE_ARCHIVE_NAME,
  ComputeRecordError,
  copyableLimit,
  finalizeBundle,
  incomingKey,
  presignIncomingUploads,
  submittedPathProblem,
} from "./compute-records.js";
import { readRuntimeImage } from "./compute-runtime-image.js";
import { ComputeS3Error } from "./compute-s3.js";
import { uploadWindowPassed } from "./compute-uploads.js";
import { readRecordedSpec } from "./compute-verify.js";
import { nemarJobTag } from "./tapis/client.js";

/** The Tapis application a person's job runs under: NEMAR's one launcher (the recipes use the same). */
export const PERSON_APP_ID = "nemar-launch";
export const PERSON_APP_VERSION = "1.0.0";

export interface SubmitRefusal {
  ok: false;
  code: ComputeSubmitSentenceCode;
  /** The name of the field of the request, for `invalid_spec`; never a value. */
  field?: string;
  /**
   * The job the refusal is about, when one EXISTS (its hold stands): only `storage_unavailable` after the
   * hold. A repeat of the `Idempotency-Key` finishes it; without a key, the job is ended by the upload
   * window an hour after it was made.
   */
  job_id?: string;
}

const refuse = (code: ComputeSubmitSentenceCode, field?: string): SubmitRefusal =>
  field === undefined ? { ok: false, code } : { ok: false, code, field };

const refuseJob = (code: ComputeSubmitSentenceCode, jobId: string): SubmitRefusal => ({
  ok: false,
  code,
  job_id: jobId,
});

// --- Step 1: compute access ----------------------------------------------------------------------

export const COMPUTE_ACCESS_READ_SQL =
  "SELECT compute_access FROM users WHERE id = ?1 AND deleted_at IS NULL";

/**
 * Whether the account may use compute, from its row: `null` when it may (`active`), `suspended` for a
 * paused grant and `no_compute_access` for anything else (never asked, asked, denied, revoked, a deleted
 * account, an unreadable value). The freeze on the pools is a SECOND line, not this one.
 */
export async function accessRefusal(
  db: D1Database,
  userId: number,
): Promise<"no_compute_access" | "suspended" | null> {
  const row = await db.prepare(COMPUTE_ACCESS_READ_SQL).bind(userId).first<{
    compute_access: string | null;
  }>();
  const state = row?.compute_access;
  if (isComputeAccessState(state) && canUseCompute(state)) return null;
  return state === "suspended" ? "suspended" : "no_compute_access";
}

// --- Step 5: runtime and mode --------------------------------------------------------------------

/** The registry path of an image reference, without the scheme and the digest: `ghcr.io/team/tool`. */
function imageRepository(image: string): string {
  return image.replace(/^docker:\/\//, "").replace(/@sha256:[0-9a-f]{64}$/, "");
}

/** Whether the owner's list names the image's registry (or a path prefix of it, by whole segments). */
export function registryAllowed(image: string, registries: readonly string[]): boolean {
  const repository = imageRepository(image);
  return registries.some((r) => repository === r || repository.startsWith(`${r}/`));
}

function runtimeRefusal(env: Bindings, spec: JobSpec, policy: ComputePolicy): SubmitRefusal | null {
  // A recipe is NEMAR's own pipeline (phase A6); a person runs code or an image.
  if (spec.recipe !== undefined) return refuse("invalid_spec", "spec.recipe");
  if (spec.runtime === "matlab") return refuse("runtime_unavailable");
  if (spec.runtime === "python" && readRuntimeImage(env).state !== "ok") {
    return refuse("runtime_unavailable");
  }
  if (
    spec.runtime === "image" &&
    (spec.image === undefined || !registryAllowed(spec.image, policy.registries))
  ) {
    return refuse("registry_not_allowed");
  }
  return null;
}

// --- Step 7: concurrency (read; the hold's own guard is the authority) ----------------------------

async function concurrencyRefusal(
  db: D1Database,
  userId: number,
  policy: ComputePolicy,
): Promise<SubmitRefusal | null> {
  const row = await db
    .prepare(`SELECT ${LIVE_JOBS_GUARD_SQL} AS ok`)
    .bind(userId, policy.maxLiveJobsPerPerson)
    .first<{ ok: number }>();
  return row?.ok === 1 ? null : refuse("over_concurrency");
}

// --- Step 8: the bundle ----------------------------------------------------------------------------

/**
 * The manifest's refusals against the OWNER's limits: the shared rule (shape, caps, entry), then the
 * path rule the records bucket applies (`submittedPathProblem`, which also refuses a traversal hidden
 * in a percent-encoding). `prefix` names the manifest in a field.
 */
export function manifestRefusal(
  files: unknown,
  policy: ComputePolicy,
  entry: string | undefined,
  prefix: string,
): SubmitRefusal | null {
  // The shared rule without the entry, then the records bucket's path rule (a traversal hidden in a
  // percent-encoding), and only then the entry: a bad path is reported before a missing entry.
  const verdict = checkBundleManifest(files, policy.bundleLimits);
  if (!verdict.ok) {
    return refuse(verdict.code, "field" in verdict ? `${prefix}${verdict.field}` : undefined);
  }
  const list = files as Array<{ path: string }>;
  for (let i = 0; i < list.length; i++) {
    if (submittedPathProblem((list[i] as { path: string }).path) !== null) {
      return refuse("invalid_spec", `${prefix}files.${i}.path`);
    }
  }
  if (entry !== undefined && !list.some((f) => f.path === entry)) {
    return refuse("entry_not_in_bundle");
  }
  return null;
}

// --- Step 9: the datasets ---------------------------------------------------------------------------

/** The datasets through the pipelines' own gate, in order; the first refusal is the answer. */
async function datasetRefusal(db: D1Database, spec: JobSpec): Promise<SubmitRefusal | null> {
  for (let i = 0; i < spec.datasets.length; i++) {
    const dataset = spec.datasets[i] as JobSpec["datasets"][number];
    const run = await resolveRun(db, dataset.id, dataset.version, PERSON_EXCEPT_TERMS);
    if (run.ok) continue;
    // One answer for every reason a dataset is not eligible: which term failed (anonymous, withdrawn,
    // private) is not told.
    const field =
      run.code === "dataset_not_eligible" || run.code === "too_many_files"
        ? `spec.datasets.${i}.id`
        : `spec.datasets.${i}.version`;
    return refuse(run.code, field);
  }
  return null;
}

// --- The job's answer -------------------------------------------------------------------------------

const BUNDLE_UPLOAD_FLIP_SQL = `UPDATE compute_jobs SET state = 'uploading'
  WHERE id = ?1 AND state = 'created' AND tapis_uuid IS NULL AND cancel_requested_at IS NULL`;

/** Whether the job is waiting for its bundle: it has one to upload, its records are not written, it is live. */
function awaitsUpload(job: ComputeJobRow, spec: JobSpec): boolean {
  return (
    spec.bundle !== undefined &&
    job.records_written_at === null &&
    job.cancel_requested_at === null &&
    job.tapis_uuid === null &&
    (job.state === "created" || job.state === "uploading")
  );
}

/**
 * The upload address of a job that is waiting for its bundle: the state is `uploading` first (one
 * conditional UPDATE: a job that was cancelled in between is not), then ONE address for the fixed key.
 * A repeated call signs again (a fresh hour); nothing is stored.
 */
async function issueUpload(
  env: Bindings,
  job: ComputeJobRow,
  spec: JobSpec,
): Promise<
  | { ok: true; job: ComputeJobRow; upload: ComputeUpload }
  | SubmitRefusal
  | { ok: "none"; job: ComputeJobRow }
> {
  const bundle = spec.bundle as NonNullable<JobSpec["bundle"]>;
  if (job.state === "created") {
    await env.DB.prepare(BUNDLE_UPLOAD_FLIP_SQL).bind(job.id).run();
  }
  const fresh = (await getJob(env.DB, job.id)) ?? job;
  if (fresh.state !== "uploading" || fresh.cancel_requested_at !== null) {
    return { ok: "none", job: fresh };
  }
  let signed: Awaited<ReturnType<typeof presignIncomingUploads>>;
  try {
    signed = await presignIncomingUploads(env, job.id, [
      { path: BUNDLE_ARCHIVE_NAME, size: bundle.size, sha256: bundle.sha256 },
    ]);
  } catch (err) {
    if (err instanceof ComputeS3Error) return refuseJob("storage_unavailable", job.id);
    throw err;
  }
  if (!signed.ok) return refuse(signed.code, signed.field);
  const first = signed.uploads[0];
  if (!first) return refuseJob("storage_unavailable", job.id);
  return {
    ok: true,
    job: fresh,
    upload: {
      url: first.url,
      method: "PUT",
      headers: first.headers,
      expires_at: signed.expires_at,
      size: bundle.size,
    },
  };
}

async function answerFor(
  env: Bindings,
  job: ComputeJobRow,
  spec: JobSpec,
  replayed: boolean,
): Promise<{ ok: true; replayed: boolean; body: ComputeSubmitResponse } | SubmitRefusal> {
  let current = job;
  let upload: ComputeUpload | undefined;
  // The window is the job's own clock: a repeat after the hour ends the job here, on the spot, whether or
  // not the release has run, and is answered with the failed job and no address.
  if (awaitsUpload(current, spec) && uploadWindowPassed(current)) {
    await endUploadExpired(env, current);
    current = (await getJob(env.DB, current.id)) ?? current;
  } else if (awaitsUpload(current, spec)) {
    const issued = await issueUpload(env, current, spec);
    if (issued.ok === true) {
      current = issued.job;
      upload = issued.upload;
    } else if (issued.ok === "none") {
      current = issued.job;
    } else {
      return issued;
    }
  } else if (spec.bundle === undefined && current.state === "created" && !current.tapis_uuid) {
    // A job with no bundle goes to the cluster at once. When it cannot (compute off, Tapis down) it
    // stays `created` and the 30-minute tick submits it; the answer says which.
    try {
      await submitComputeJob(env, current.id);
    } catch (err) {
      console.warn(`[compute-submit] submit_threw job=${current.id} class=${errorClass(err)}`);
    }
    current = (await getJob(env.DB, current.id)) ?? current;
  }
  const body: ComputeSubmitResponse = {
    job_id: current.id,
    state: current.state,
    tag: nemarJobTag(current.id),
    name: spec.name,
    ...(upload === undefined ? {} : { upload }),
    ...(replayed ? { replayed: true as const } : {}),
  };
  return { ok: true, replayed, body };
}

const errorClass = (err: unknown): string => (err instanceof Error ? err.name : typeof err);

// --- POST /compute/jobs -----------------------------------------------------------------------------

const TOP_KEYS = new Set(["spec", "manifest"]);

export type SubmitResult =
  | { ok: true; replayed: boolean; body: ComputeSubmitResponse }
  | SubmitRefusal;

/**
 * Steps 3 to 10 of the order above, for a person whose access the route has already checked. `body` is
 * the parsed request object; `key` the validated `Idempotency-Key` or null.
 */
export async function submitPersonJob(
  env: Bindings,
  userId: number,
  body: Record<string, unknown>,
  key: string | null,
): Promise<SubmitResult> {
  // 3. The body and the specification.
  if (Object.keys(body).some((k) => !TOP_KEYS.has(k))) return refuse("invalid_spec", "body");
  const parsed = JobSpecSchema.safeParse(body.spec);
  if (!parsed.success) {
    const path = parsed.error.issues[0]?.path ?? [];
    return refuse("invalid_spec", path.length > 0 ? `spec.${fieldPath(path)}` : "spec");
  }
  const spec = parsed.data;
  // The launch rules the schema leaves to the caller (the dataset version tag, the 64 KiB launch
  // specification), before any hold: the same two checks `createJob` makes, named in this body's fields.
  const untagged = datasetVersionWithoutTag(spec.datasets);
  if (untagged !== null) return refuse("invalid_spec", `spec.${untagged}`);
  if (!launchSpecFits(spec)) return refuse("invalid_spec", "spec");
  if (spec.bundle === undefined && body.manifest !== undefined) {
    return refuse("invalid_spec", "manifest");
  }
  if (spec.bundle !== undefined && body.manifest === undefined) {
    return refuse("invalid_spec", "manifest");
  }
  let files: unknown;
  if (spec.bundle !== undefined) {
    const shape = BundleManifestSchema.safeParse(body.manifest);
    // A manifest that is not `{ files: [...] }` is named by the manifest; what is wrong INSIDE its files
    // is the shared rule's, in step 8, with the same field names.
    const m = body.manifest;
    if (
      !shape.success &&
      (typeof m !== "object" ||
        m === null ||
        Array.isArray(m) ||
        Object.keys(m).some((k) => k !== "files"))
    ) {
      return refuse("invalid_spec", "manifest");
    }
    files = (m as { files?: unknown }).files;
  }

  const input = {
    source: "cli" as const,
    accountId: userId,
    appId: PERSON_APP_ID,
    appVersion: PERSON_APP_VERSION,
    spec,
    idempotencyKey: key,
    requireActiveAccess: true,
    bornUploading: true,
  };

  // 4. A repeated key.
  if (key !== null) {
    const existing = await env.DB.prepare(JOB_BY_KEY_SQL).bind(userId, key).first<ComputeJobRow>();
    // A key that finds a job is answered from that job and nothing below is asked. `createJob` compares
    // the specification's digest with the job's (the request hash) and throws `idempotency_conflict` for
    // another request, which `replayOf` answers.
    if (existing) return replayOf(env, input, spec);
  }

  let policy: ComputePolicy;
  try {
    policy = (await getPolicy(env.DB)).policy;
  } catch {
    return refuse("policy_unavailable");
  }

  // 5 to 9: what the world allows, all before any hold.
  const runtime = runtimeRefusal(env, spec, policy);
  if (runtime) return runtime;
  const over = jobCeilingRefusal(policy, spec);
  if (over !== null) return refuse(over);
  const live = await concurrencyRefusal(env.DB, userId, policy);
  if (live) return live;
  if (spec.bundle !== undefined) {
    const manifest = manifestRefusal(files, policy, spec.entry, "manifest.");
    if (manifest) return manifest;
    if (spec.bundle.size > copyableLimit(policy.bundleLimits.maxTotalBytes)) {
      return refuse("bundle_too_large");
    }
  }
  const dataset = await datasetRefusal(env.DB, spec);
  if (dataset) return dataset;

  // 10. The hold.
  let created: Awaited<ReturnType<typeof createJob>>;
  try {
    created = await createJob(env, input);
  } catch (err) {
    if (err instanceof ComputeJobError) {
      if (err.code === "idempotency_conflict") return refuse("idempotency_conflict");
      if (err.code === "pool_not_found") return refuse("compute_disabled");
    }
    throw err;
  }
  if (!created.ok) return refuse(created.code, created.field);
  if (!created.recordsWritten) {
    // The hold stands and the records did not land: a repeat of the key finishes them. No address.
    console.error(`[compute-submit] records_unavailable job=${created.job.id}`);
    return refuseJob("storage_unavailable", created.job.id);
  }
  return answerFor(env, created.job, spec, created.replayed);
}

async function replayOf(
  env: Bindings,
  input: Parameters<typeof createJob>[1],
  spec: JobSpec,
): Promise<SubmitResult> {
  let again: Awaited<ReturnType<typeof createJob>>;
  try {
    again = await createJob(env, input);
  } catch (err) {
    if (err instanceof ComputeJobError && err.code === "idempotency_conflict") {
      return refuse("idempotency_conflict");
    }
    throw err;
  }
  if (!again.ok) return refuse(again.code, again.field);
  if (!again.recordsWritten) return refuseJob("storage_unavailable", again.job.id);
  return answerFor(env, again.job, spec, true);
}

// --- POST /compute/jobs/:id/finalize ------------------------------------------------------------------

export type FinalizeOutcome = { ok: true; body: ComputeFinalizeResponse } | SubmitRefusal;

const FinalizeBodySchema = BundleManifestSchema;

async function submitAndAnswer(
  env: Bindings,
  job: ComputeJobRow,
  spec: JobSpec | null,
  replayed: boolean,
): Promise<FinalizeOutcome> {
  let current = job;
  if (current.tapis_uuid === null && current.cancel_requested_at === null) {
    try {
      await submitComputeJob(env, current.id);
    } catch (err) {
      console.warn(`[compute-submit] submit_threw job=${current.id} class=${errorClass(err)}`);
    }
    current = (await getJob(env.DB, current.id)) ?? current;
  }
  return {
    ok: true,
    body: {
      job_id: current.id,
      state: current.state,
      ...(spec === null ? {} : { name: spec.name }),
      submitted: current.tapis_uuid !== null,
      replayed,
    },
  };
}

/**
 * Finalize the upload of a job the caller owns. In order:
 *  - a job past the upload is returned unchanged (`replayed: true`); a failed or cancelled one is
 *    `upload_expired` (the window closed) or `bad_state`;
 *  - a job whose records are already written (finalized, waiting to be submitted) is submitted again and
 *    returned, with no body asked;
 *  - otherwise the body is the manifest (the shared rule against the owner's limits, and the job's
 *    `entry`), the uploaded object must be there with the declared size (`bundle_incomplete`, and
 *    NOTHING is copied), and only then does `finalizeBundle` copy the archive once into the records and
 *    write `bundle-manifest.json`, after which the job is submitted.
 * `body` is the parsed request object, or null for no body.
 */
export async function finalizePersonJob(
  env: Bindings,
  job: ComputeJobRow,
  body: Record<string, unknown> | null,
): Promise<FinalizeOutcome> {
  const records = env.COMPUTE_RECORDS;
  if (!records) return refuse("compute_disabled");
  const state: ComputeState = job.state;
  if (state !== "created" && state !== "uploading") {
    if (isTerminalComputeState(state)) {
      return job.failure_code === "upload_expired" ? refuse("upload_expired") : refuse("bad_state");
    }
    const spec = await readRecordedSpec(records, job).catch(() => null);
    return {
      ok: true,
      body: {
        job_id: job.id,
        state,
        ...(spec === null ? {} : { name: spec.name }),
        submitted: job.tapis_uuid !== null,
        replayed: true,
      },
    };
  }
  if (job.cancel_requested_at !== null) return refuse("bad_state");
  // The upload window is the only clock before a finalize. A finalize that arrives after it ends the job
  // here, on the spot, as the submitter's `upload_expired` with the hold released (the release may not
  // have run yet), and is refused; one that arrives inside it is never a platform failure, however long
  // the reservation wait is.
  if (uploadWindowPassed(job)) {
    await endUploadExpired(env, job);
    return refuse("upload_expired");
  }

  let spec: JobSpec | null;
  try {
    spec = await readRecordedSpec(records, job);
  } catch {
    return refuse("storage_unavailable");
  }
  if (spec === null) return refuse("storage_unavailable");
  if (spec.bundle === undefined) return refuse("bad_state");

  if (job.records_written_at !== null) return submitAndAnswer(env, job, spec, true);

  if (body === null) return refuse("invalid_spec", "files");
  const shape = FinalizeBodySchema.safeParse(body);
  if (!shape.success && Object.keys(body).some((k) => k !== "files")) {
    return refuse("invalid_spec", "body");
  }
  let policy: ComputePolicy;
  try {
    policy = (await getPolicy(env.DB)).policy;
  } catch {
    return refuse("policy_unavailable");
  }
  const bad = manifestRefusal(body.files, policy, spec.entry, "");
  if (bad) return bad;
  const files = body.files as Array<{ path: string; size: number; sha256: string }>;

  // The object, by the binding's HEAD: absent or short is `bundle_incomplete`, and nothing is copied.
  let uploaded: R2Object | null;
  try {
    uploaded = await records.head(incomingKey(job.id, BUNDLE_ARCHIVE_NAME));
  } catch {
    return refuse("storage_unavailable");
  }
  if (uploaded === null) return refuse("bundle_incomplete");
  if (uploaded.size > spec.bundle.size) {
    // LARGER than declared can only be a wrong or a hostile object, and no PUT of this address can make
    // it (the length is signed): it is deleted, so it holds no space and is never copied. A SHORTER one
    // is left, because the person may still be uploading.
    try {
      await records.delete(incomingKey(job.id, BUNDLE_ARCHIVE_NAME));
    } catch (err) {
      console.error(`[compute-submit] oversize_delete_failed job=${job.id} class=${errorClass(err)}`);
    }
    return refuse("bundle_incomplete");
  }
  if (uploaded.size !== spec.bundle.size) return refuse("bundle_incomplete");

  let finalized: Awaited<ReturnType<typeof finalizeBundle>>;
  try {
    finalized = await finalizeBundle(env, job.id, {
      archive: { sha256: spec.bundle.sha256, size: spec.bundle.size },
      files,
    });
  } catch (err) {
    if (err instanceof ComputeS3Error || err instanceof ComputeRecordError) {
      console.error(`[compute-submit] finalize_failed job=${job.id} class=${errorClass(err)}`);
      return refuse("storage_unavailable");
    }
    throw err;
  }
  if (!finalized.ok) return refuse(finalized.code, finalized.field);
  const fresh = (await getJob(env.DB, job.id)) ?? job;
  return submitAndAnswer(env, fresh, spec, finalized.replayed);
}

// --- Results ---------------------------------------------------------------------------------------
