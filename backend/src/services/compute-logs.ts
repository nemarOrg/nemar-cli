/**
 * A job's log for its owner (epic #2021 phase D3, #2024; ADR 0118, the amendment of this phase): the
 * text of `tapisjob.out`, the entry's own standard output and error, at most 1 MiB.
 *
 * WHERE IT COMES FROM. A job that has ended and whose files were copied has its log in the records
 * bucket (`logs/<id>/tapisjob.out`, copied by `copyResultRecords`, which keeps at most 5 MiB); that copy
 * is the answer, read with a range so no more than the bound is ever read. Otherwise, a job that has a
 * Tapis job is read from Tapis (`downloadOutputPrefix`, which stops at the bound). A job with no Tapis
 * job and no copy has not started: `logs_not_available`.
 *
 * WHAT IT RETURNS IS THE FIRST 1 MiB. `truncated` says there was more. The bytes are the job's own text
 * and are untrusted: they are returned as they are (as `text/plain`, `nosniff`), never parsed, never
 * decoded here and NEVER LOGGED. A failure is one fixed word; a Tapis error is logged by its kind only.
 */

import { COMPUTE_LOG_MAX_BYTES } from "../../../shared/contract/compute-submit.js";
import type { Bindings } from "../types/bindings.js";
import type { ComputeJobRow } from "./compute-jobs.js";
import { REQUEST_READ, tapisAccess } from "./compute-lifecycle.js";
import { logKey } from "./compute-records.js";
import { downloadOutputPrefix } from "./tapis/client.js";
import { TapisError } from "./tapis/errors.js";
import { TAPIS_JOB_UUID_RE } from "./tapis/schemas.js";

export type JobLogResult =
  | { ok: true; bytes: Uint8Array; truncated: boolean }
  | { ok: false; code: "logs_not_available" | "storage_unavailable" };

const unavailable = { ok: false, code: "logs_not_available" } as const;

/** The records copy of the log, or null when there is none. Reads at most the bound plus one byte. */
async function recordsCopy(
  records: R2Bucket,
  jobId: string,
): Promise<{ bytes: Uint8Array; truncated: boolean } | null> {
  const key = logKey(jobId, "tapisjob.out");
  const head = await records.head(key);
  if (head === null) return null;
  const object =
    head.size > COMPUTE_LOG_MAX_BYTES
      ? await records.get(key, { range: { offset: 0, length: COMPUTE_LOG_MAX_BYTES } })
      : await records.get(key);
  if (object === null) return null;
  return {
    bytes: new Uint8Array(await object.arrayBuffer()),
    truncated: head.size > COMPUTE_LOG_MAX_BYTES,
  };
}

export async function readJobLog(env: Bindings, job: ComputeJobRow): Promise<JobLogResult> {
  // A partner's job is the person's to read ONLY once NEMAR verified it (phase D4, #2025): a job a partner
  // reported and NEMAR has not matched (pending), or refused (mismatch), may be another owner's job, and
  // its output is not this person's. A reservation with no job has none.
  if (job.source === "partner" && job.partner_state !== "verified") return unavailable;
  try {
    if (env.COMPUTE_RECORDS && job.result_records_at !== null) {
      const copy = await recordsCopy(env.COMPUTE_RECORDS, job.id);
      if (copy !== null) return { ok: true, ...copy };
      // The files were copied and the job wrote no log.
      return unavailable;
    }
  } catch (err) {
    console.error(`[compute-logs] records_read_failed job=${job.id} class=${errorClass(err)}`);
    return { ok: false, code: "storage_unavailable" };
  }
  if (job.tapis_uuid === null || !TAPIS_JOB_UUID_RE.test(job.tapis_uuid)) return unavailable;
  const ctx = tapisAccess(env, REQUEST_READ);
  if (ctx === null) return { ok: false, code: "storage_unavailable" };
  try {
    const log = await downloadOutputPrefix(
      ctx,
      job.tapis_uuid,
      "tapisjob.out",
      COMPUTE_LOG_MAX_BYTES,
    );
    return { ok: true, bytes: log.bytes, truncated: log.truncated };
  } catch (err) {
    if (err instanceof TapisError && err.kind === "not_found") return unavailable;
    console.warn(
      `[compute-logs] tapis_read_failed job=${job.id} kind=${err instanceof TapisError ? err.kind : errorClass(err)}`,
    );
    return { ok: false, code: "storage_unavailable" };
  }
}

const errorClass = (err: unknown): string => (err instanceof Error ? err.name : typeof err);
