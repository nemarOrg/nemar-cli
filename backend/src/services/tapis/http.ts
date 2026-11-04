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

/**
 * One request. Returns the bytes of a 2xx answer; throws a `TapisError` otherwise: `unavailable` for
 * a timeout or a failed connection, the status's own kind for a non-2xx answer, `invalid_response` for
 * a body over the bound.
 */
export async function send(options: SendOptions): Promise<Uint8Array> {
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
    throw transportError(options.what, signal.aborted);
  }
  if (bytes === null) throw invalidResponse(options.what, res.status);
  return bytes;
}

/** The text of a body as JSON, or `invalid_response`. */
export function parseJsonBody(bytes: Uint8Array, what: string): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    throw invalidResponse(what, null);
  }
}
