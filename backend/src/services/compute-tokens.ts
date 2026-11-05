/**
 * The two per-job tokens of the compute gateway (epic #2005 phase A5, #2010; ADR 0118).
 *
 * Both are HMAC-SHA256 hex digests over a job id and the job's `webhook_nonce`, signed with the
 * callback secret (`PRESCREEN_CALLBACK_SECRET`, one fewer secret to provision on two Workers) and
 * DOMAIN-SEPARATED the way every other callback token is (`services/github/callback-tokens.ts`): the
 * message begins with a tag line that no other kind's message begins with, so a token minted for one
 * purpose answers for no other, and neither can answer for a GitHub callback or the reverse.
 *
 *   `compute-webhook`  in the address Tapis posts a status hint to: `/webhooks/tapis/<job id>/<token>`.
 *                      A token in a URL reaches Worker logs, so it is bound to the nonce and expires
 *                      with it (the sweep clears the nonce one day after the job is terminal).
 *   `compute-job`      the launcher's `job_token`, sent in the `X-Compute-Job-Token` header (never a
 *                      URL) to the bundle, outputs and complete routes. It stops working the moment the
 *                      job is terminal, whatever the nonce says (the routes read the state).
 *
 * There is NO clock inside either token: validity is the row's (a non-null nonce, and for the job
 * token a job that is not terminal), so a replay after the end has nothing to verify against. The
 * message is three lines, so no field may carry a line break; the signer refuses one and the verifier
 * answers false.
 */

import { timingSafeEqual } from "../lib/constant-time.js";

/** The first line of every webhook message. Never shared with another token kind. */
export const COMPUTE_WEBHOOK_TOKEN_DOMAIN = "compute-webhook";

/** The first line of every job-token message. Never shared with another token kind. */
export const COMPUTE_JOB_TOKEN_DOMAIN = "compute-job";

export type ComputeTokenKind = "webhook" | "job";

/**
 * The nonce a verification uses when the job has none (no such job, or its nonce was cleared): a value
 * no job has, so a missing job costs the same HMAC a real one does and a route can answer them alike.
 */
export const NO_NONCE = "00000000-0000-0000-0000-000000000000";

const DOMAIN: Readonly<Record<ComputeTokenKind, string>> = {
  webhook: COMPUTE_WEBHOOK_TOKEN_DOMAIN,
  job: COMPUTE_JOB_TOKEN_DOMAIN,
};

export interface ComputeTokenPayload {
  jobId: string;
  nonce: string;
}

const hasLineBreak = (payload: ComputeTokenPayload): boolean =>
  [payload.jobId, payload.nonce].some((field) => /[\r\n]/.test(String(field)));

function toHex(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let out = "";
  for (let i = 0; i < view.length; i++) out += (view[i] as number).toString(16).padStart(2, "0");
  return out;
}

/** The canonical, domain-tagged message, pinned so signer and verifier agree. */
export function encodeComputeTokenPayload(
  kind: ComputeTokenKind,
  payload: ComputeTokenPayload,
): string {
  return `${DOMAIN[kind]}\n${payload.jobId}\n${payload.nonce}`;
}

/** Sign a token of `kind` for a job and its nonce (hex digest). */
export async function signComputeToken(
  kind: ComputeTokenKind,
  payload: ComputeTokenPayload,
  secret: string,
): Promise<string> {
  if (!secret) throw new Error("signComputeToken: secret is required");
  if (hasLineBreak(payload)) throw new Error("signComputeToken: a field holds a line break");
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(encodeComputeTokenPayload(kind, payload)),
  );
  return toHex(signature);
}

/** Verify a token of `kind` (constant-time). False for anything that is not exactly the token. */
export async function verifyComputeToken(
  kind: ComputeTokenKind,
  token: string,
  payload: ComputeTokenPayload,
  secret: string,
): Promise<boolean> {
  if (!token || !secret || typeof token !== "string" || hasLineBreak(payload)) return false;
  const expected = await signComputeToken(kind, payload, secret);
  return timingSafeEqual(token, expected);
}
