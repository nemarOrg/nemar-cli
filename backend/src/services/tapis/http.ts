/**
 * The one way a request leaves for Tapis (epic #2005 phase A4, #2009): a timeout, a bounded body, no
 * redirect, and a `TapisError` for everything that is not a success.
 *
 *  - TIMEOUT. Every request, the answer's body included, ends inside `effectiveTimeoutMs` (15
 *    seconds, which no caller can lengthen): a hung upstream must not hang a Worker request.
 *  - BOUNDED READ. The body is read as a stream and stops at `maxBytes` (a `Content-Length` over it is
 *    refused before a byte is read), so a tenant that sends without end cannot fill the Worker's
 *    memory. A body over the bound is `invalid_response`.
 *  - NO REDIRECT. A 3xx is not followed: the token travels in a header, and a header that is not
 *    `Authorization` is not removed when a runtime follows a redirect to another origin.
 *  - NO BODY IN A MESSAGE. A non-2xx answer is classified by its status alone and its body is
 *    discarded unread; see errors.ts for why.
 */

import { errorForStatus, invalidResponse, transportError } from "./errors";

/** The longest any one request to Tapis may take, in milliseconds. */
export const TAPIS_TIMEOUT_MS = 15_000;

/** The largest JSON answer read: a job record with its parameters and 64 KiB of notes fits many times. */
export const TAPIS_MAX_JSON_BYTES = 2 * 1024 * 1024;

/** The timeout a call uses: the one asked for when it is a positive number, never more than 15 s. */
export function effectiveTimeoutMs(requested: number | undefined): number {
  if (typeof requested !== "number" || !Number.isFinite(requested) || requested <= 0) {
    return TAPIS_TIMEOUT_MS;
  }
  return Math.min(Math.floor(requested), TAPIS_TIMEOUT_MS) || 1;
}

export interface SendOptions {
  url: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  /** A JSON text, sent as it is. */
  body?: string;
  /** A fixed phrase naming the call, for the error message: never a value from a request. */
  what: string;
  timeoutMs?: number;
  maxBytes: number;
}

/** Read a body to its end or to `maxBytes`, whichever comes first; null when it is longer. */
async function readBounded(res: Response, maxBytes: number): Promise<Uint8Array | null> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    return null;
  }
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export interface SendResult {
  /** The 2xx status of the answer. */
  status: number;
  bytes: Uint8Array;
}

/**
 * One request. Returns the status and bytes of a 2xx answer; throws a `TapisError` otherwise:
 * `unavailable` for a timeout, a failed connection or a body that broke off, the status's own kind for
 * a non-2xx answer, `invalid_response` for a body over the bound.
 */
export async function send(options: SendOptions): Promise<SendResult> {
  const signal = AbortSignal.timeout(effectiveTimeoutMs(options.timeoutMs));
  let res: Response;
  try {
    res = await fetch(options.url, {
      method: options.method,
      headers: options.headers,
      body: options.body,
      redirect: "manual",
      signal,
    });
  } catch {
    throw transportError(options.what, signal.aborted);
  }
  if (res.status < 200 || res.status >= 300) {
    await res.body?.cancel().catch(() => {});
    throw errorForStatus(res.status, options.what);
  }
  let bytes: Uint8Array | null;
  try {
    bytes = await readBounded(res, options.maxBytes);
  } catch {
    // A timeout while the body was coming, or a connection that closed in the middle of it.
    throw transportError(options.what, signal.aborted);
  }
  if (bytes === null) throw invalidResponse(options.what, res.status);
  return { status: res.status, bytes };
}

/** The text of a body as JSON (UTF-8 that is not valid is refused, not repaired), or `invalid_response`. */
export function parseJsonBody(bytes: Uint8Array, what: string, status: number | null): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    throw invalidResponse(what, status);
  }
}

// --- What a caller may ask for -----------------------------------------------------------------

/** The most times a read is tried. */
export const TAPIS_MAX_ATTEMPTS = 3;

/** The wait between the attempts of a read when none is asked for, and the longest one allowed. */
export const TAPIS_RETRY_DELAY_DEFAULT_MS = 500;
export const TAPIS_RETRY_DELAY_MAX_MS = 5000;

/**
 * How many times a read is tried: a whole number from 1 to 3. A value that is not a finite number is
 * the default (3); anything else is rounded down and kept within 1 and 3, so a caller's knob can
 * neither stop a read from running at all nor make it run more than the design says.
 */
export function attemptsFor(requested: number | undefined): number {
  if (typeof requested !== "number" || !Number.isFinite(requested)) return TAPIS_MAX_ATTEMPTS;
  return Math.min(Math.max(Math.floor(requested), 1), TAPIS_MAX_ATTEMPTS);
}

/**
 * The wait between the attempts of a read, in milliseconds: the default when the value is not a
 * finite number, otherwise kept within 0 and 5 seconds, so a caller's knob cannot make a Worker request
 * sit and wait.
 */
export function retryDelayFor(requested: number | undefined): number {
  if (typeof requested !== "number" || !Number.isFinite(requested)) {
    return TAPIS_RETRY_DELAY_DEFAULT_MS;
  }
  return Math.min(Math.max(Math.floor(requested), 0), TAPIS_RETRY_DELAY_MAX_MS);
}
