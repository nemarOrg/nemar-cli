/**
 * The one PUT of the bundle (epic #2021 phase D3b, #2024; ADR 0118, the amendment of phase D3, item 5).
 *
 * The Worker issues ONE address for the archive. The request is `PUT upload.url` with EXACTLY the headers it
 * returned (they carry the signed `x-amz-checksum-sha256`: none is added and none is dropped) and
 * `Content-Length: upload.size` (the length is signed into the address, so a body of another length is
 * refused with 403). No NEMAR credential goes with it: the address is the credential, it works for one
 * hour and for that one object, and it is a bearer secret, so it is never printed, never logged and never
 * put in an error message here.
 *
 * An address that is not `https:` (loopback `http:` aside), and a redirect, are refused. Three retries (four attempts) on a 5xx or a network failure, with 1, 2 and 4 seconds between. A 4xx is
 * not retried: a 403 is the store saying the address has expired (or the body is not what was signed), and
 * the answer is to run the command again, which makes a NEW job with a new key; any other 4xx is a refusal.
 */

import type { ComputeUpload } from "../../../shared/contract/compute-submit.js";
import { isStoreUrlAllowed } from "./store-url.js";

export const UPLOAD_RETRIES = 3;
export const UPLOAD_BACKOFF_MS = [1000, 2000, 4000] as const;

/** One attempt may take this long (a 100 MiB archive on a slow link). */
const ATTEMPT_TIMEOUT_MS = 15 * 60 * 1000;

export type UploadOutcome =
  | { ok: true; attempts: number }
  | { ok: false; kind: "expired"; attempts: number }
  /** The store refused the bytes or the address (a 4xx other than 403). */
  | { ok: false; kind: "refused"; status: number; attempts: number }
  /** A 5xx or no answer on every attempt. */
  | { ok: false; kind: "failed"; status: number | null; attempts: number }
  /** The archive is not the length the address was signed for: nothing was sent. */
  | { ok: false; kind: "wrong_size"; attempts: 0 }
  /** The address is not `https:` (or loopback): it is not used. */
  | { ok: false; kind: "insecure_address"; attempts: 0 };

export interface UploadOptions {
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * How far past its time an address must be, by THIS machine's clock, before it is not even tried. The
 * clock here may be wrong, so the store's answer decides inside this margin (a 403 is `expired`).
 */
export const CLOCK_SKEW_MS = 5 * 60 * 1000;

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function uploadBundle(
  upload: ComputeUpload,
  archive: Uint8Array,
  options: UploadOptions = {},
): Promise<UploadOutcome> {
  const sleep = options.sleep ?? wait;
  const now = options.now ?? Date.now;
  if (archive.length !== upload.size) return { ok: false, kind: "wrong_size", attempts: 0 };
  if (!isStoreUrlAllowed(upload.url)) return { ok: false, kind: "insecure_address", attempts: 0 };
  const expires = Date.parse(upload.expires_at);
  if (Number.isFinite(expires) && expires + CLOCK_SKEW_MS <= now()) {
    return { ok: false, kind: "expired", attempts: 0 };
  }
  const headers = { ...upload.headers, "Content-Length": String(upload.size) };

  let status: number | null = null;
  for (let attempt = 1; attempt <= UPLOAD_RETRIES + 1; attempt++) {
    try {
      const response = await fetch(upload.url, {
        method: "PUT",
        headers,
        body: archive,
        // The address is the authority and the signed headers go with it only to that host.
        redirect: "error",
        signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
      });
      status = response.status;
      // The body of a store's answer is read and dropped so the connection is released.
      await response.arrayBuffer().catch(() => undefined);
      if (response.ok) return { ok: true, attempts: attempt };
      if (response.status === 403) return { ok: false, kind: "expired", attempts: attempt };
      if (response.status < 500) {
        return { ok: false, kind: "refused", status: response.status, attempts: attempt };
      }
    } catch {
      // No answer: the error text can name the address, so it is not kept.
      status = null;
    }
    if (attempt <= UPLOAD_RETRIES) await sleep(UPLOAD_BACKOFF_MS[attempt - 1] as number);
  }
  return { ok: false, kind: "failed", status, attempts: UPLOAD_RETRIES + 1 };
}
