/**
 * What the compute routes that have a person behind them share (epic #2021 phase D3, #2024): the job a
 * signed-in person owns, and the refusal body.
 */

import type { Context } from "hono";
import { COMPUTE_REFUSAL_STATUS } from "../../../../shared/compute-state.js";
import {
  COMPUTE_JOB_STANDS_NOTE,
  COMPUTE_SUBMIT_SENTENCES,
  type ComputeSubmitSentenceCode,
} from "../../../../shared/contract/compute-submit.js";
import { COMPUTE_JOB_ID_RE } from "../../../../shared/contract/compute.js";
import { getJob } from "../../services/compute-jobs.js";
import type { Bindings, Variables } from "../../types/bindings.js";

export type ComputeCtx = Context<{ Bindings: Bindings; Variables: Variables }>;

/** The job a signed-in person owns, or null for any other reason (never says which). */
export async function ownJob(env: Bindings, id: string, userId: number) {
  if (!COMPUTE_JOB_ID_RE.test(id)) return null;
  const job = await getJob(env.DB, id);
  return job && job.account_id === userId ? job : null;
}

/** What a response that may hold an upload address or a bearer link is sent with: never cached. */
export const NO_STORE = { "Cache-Control": "no-store", Pragma: "no-cache" } as const;

/** `{ error: <sentence>, code: <word> }` and, for `invalid_spec`, `field`; the status is the word's. */
export function refuseWith(
  c: { json: (body: unknown, status: number, headers?: Record<string, string>) => Response },
  code: ComputeSubmitSentenceCode,
  field?: string,
  status: number = COMPUTE_REFUSAL_STATUS[code],
  jobId?: string,
): Response {
  return c.json(
    {
      error: COMPUTE_SUBMIT_SENTENCES[code],
      code,
      ...(field === undefined ? {} : { field }),
      // A refusal after the hold names the job that stands and what finishes it (phase D3, #2024).
      ...(jobId === undefined ? {} : { job_id: jobId, note: COMPUTE_JOB_STANDS_NOTE }),
    },
    status,
    { ...NO_STORE },
  );
}
