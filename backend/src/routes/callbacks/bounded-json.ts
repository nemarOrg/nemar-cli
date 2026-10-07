/**
 * Read a callback's JSON object body under a size bound, before anything in it
 * is trusted (epic #1610). The two identifier-screen callbacks, the publication
 * request's and the scheduled sweep's, both take a report from a workflow; a
 * real report is a few kilobytes, so anything near the bound is not one, and
 * reading it would only spend the Worker's memory on an attacker's payload.
 *
 * Bounded twice: by the declared length, and by the bytes that actually arrived
 * (a declared length can be absent or wrong). The answers are fixed words.
 */

import type { Context } from "hono";

/** The largest body a screen callback reads. */
export const MAX_CALLBACK_BODY_BYTES = 256 * 1024;

export type BoundedJson =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; status: 400 | 413; error: string };

export async function readBoundedJsonObject(
  c: Context,
  max: number = MAX_CALLBACK_BODY_BYTES,
): Promise<BoundedJson> {
  const declared = Number(c.req.header("Content-Length") ?? "0");
  if (Number.isFinite(declared) && declared > max) {
    return { ok: false, status: 413, error: "Body too large" };
  }
  let body: unknown;
  try {
    const raw = new Uint8Array(await c.req.arrayBuffer());
    if (raw.byteLength > max) return { ok: false, status: 413, error: "Body too large" };
    body = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return { ok: false, status: 400, error: "Invalid JSON in request body" };
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, status: 400, error: "Body must be a JSON object" };
  }
  return { ok: true, body: body as Record<string, unknown> };
}
