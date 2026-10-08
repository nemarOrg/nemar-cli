/**
 * The size bound of the two identifier-screen callbacks (`readBoundedJsonObject`, epic #1610).
 *
 * The bound is counted on the stream as it arrives, so the edges are the point: a body that ends
 * exactly at the bound is read, one byte more is not, an empty body and a missing body are bad
 * JSON, a declared length that lies in either direction cannot move the bound, and a stream that
 * goes past the bound is cancelled (the source is told to stop, not left to run to its end).
 * Driven through a real Hono request, as the routes receive it.
 */

import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import {
  MAX_CALLBACK_BODY_BYTES,
  readBoundedJsonObject,
} from "../src/routes/callbacks/bounded-json";

const MAX = 100;
const encoder = new TextEncoder();

function app(max: number = MAX) {
  const hono = new Hono();
  hono.post("/", async (c) => {
    const read = await readBoundedJsonObject(c, max);
    return read.ok
      ? c.json({ ok: true, body: read.body })
      : c.json({ error: read.error }, read.status);
  });
  return hono;
}

/** A JSON object of exactly `bytes` bytes (ASCII). */
function objectOf(bytes: number): string {
  const frame = '{"p":""}'.length;
  return `{"p":"${"x".repeat(bytes - frame)}"}`;
}

/** A pull-driven stream of `chunks` chunks of `size` bytes; it records what was pulled and whether it was cancelled. */
function counted(chunks: number, size: number, fill = 120) {
  const state = { pulled: 0, cancelled: false };
  const chunk = new Uint8Array(size).fill(fill);
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (state.pulled >= chunks) {
          controller.close();
          return;
        }
        state.pulled++;
        controller.enqueue(chunk);
      },
      cancel() {
        state.cancelled = true;
      },
    },
    // No read-ahead: a chunk is pulled only when the reader asks for one.
    { highWaterMark: 0 },
  );
  return { stream, state };
}

function post(hono: Hono, body: BodyInit | null, headers: Record<string, string> = {}) {
  return hono.request("/", {
    method: "POST",
    headers,
    body,
    // @ts-expect-error `duplex` is required for a streamed body and is not in the DOM typings.
    duplex: "half",
  });
}

describe("readBoundedJsonObject", () => {
  test("the bound is the default screen callbacks use", () => {
    expect(MAX_CALLBACK_BODY_BYTES).toBe(256 * 1024);
  });

  test("a body of exactly the bound is read, and one byte more is refused", async () => {
    const exact = objectOf(MAX);
    expect(encoder.encode(exact).length).toBe(MAX);
    const ok = await post(app(), exact);
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { body: { p: string } }).body.p.length).toBe(MAX - 8);

    const over = objectOf(MAX + 1);
    expect(encoder.encode(over).length).toBe(MAX + 1);
    const refused = await post(app(), over);
    expect(refused.status).toBe(413);
    expect(await refused.json()).toEqual({ error: "Body too large" });
  });

  test("the same edge holds for a stream with no length, however it is cut into chunks", async () => {
    // Seven bytes a chunk: the bound falls in the middle of a chunk, not on a boundary.
    const cut = (text: string) => {
      const bytes = encoder.encode(text);
      let at = 0;
      return new ReadableStream<Uint8Array>({
        pull(controller) {
          if (at >= bytes.length) return controller.close();
          controller.enqueue(bytes.slice(at, at + 7));
          at += 7;
        },
      });
    };
    const ok = await post(app(), cut(objectOf(MAX)));
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { body: { p: string } }).body.p).toBe("x".repeat(MAX - 8));
    expect((await post(app(), cut(objectOf(MAX + 1)))).status).toBe(413);
  });

  test("an empty body and a missing body are invalid JSON, never a pass", async () => {
    for (const body of ["", null]) {
      const res = await post(app(), body);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "Invalid JSON in request body" });
    }
  });

  test("a declared length over the bound is refused before the body is read", async () => {
    const { stream, state } = counted(3, 10);
    const res = await post(app(), stream, { "Content-Length": String(MAX + 1) });
    expect(res.status).toBe(413);
    expect(state.pulled).toBe(0);
  });

  test("a declared length under the bound does not let a longer body through", async () => {
    const res = await post(app(), objectOf(MAX * 3), { "Content-Length": "10" });
    expect(res.status).toBe(413);
    // The twin: the same declared length with a body that fits is read.
    const fits = await post(app(), objectOf(MAX), { "Content-Length": "10" });
    expect(fits.status).toBe(200);
  });

  test("a stream past the bound is cancelled at the bound, not read to its end", async () => {
    // 4 KB chunks against a 100 byte bound: the first chunk is already over it.
    const { stream, state } = counted(400, 4096);
    const res = await post(app(), stream);
    expect(res.status).toBe(413);
    expect(state.cancelled).toBe(true);
    // No read-ahead, so what was pulled is what the route asked for: the first chunk, and no more.
    expect(state.pulled).toBe(1);
  });

  test("a stream that ends inside the bound is not cancelled", async () => {
    const { stream, state } = counted(2, 10);
    const res = await post(app(), stream);
    // Not JSON (twenty 'x'), but it was read to its end and released.
    expect(res.status).toBe(400);
    expect(state.pulled).toBe(2);
    expect(state.cancelled).toBe(false);
  });

  test("a stream that fails part way is invalid JSON, not an unhandled error", async () => {
    let sent = false;
    const failing = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sent) {
          sent = true;
          controller.enqueue(encoder.encode('{"p":'));
          return;
        }
        controller.error(new Error("client went away"));
      },
    });
    const res = await post(app(), failing);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid JSON in request body" });
  });

  test("a body inside the bound that is not an object is refused", async () => {
    for (const text of ["[1,2]", "7", '"x"', "null"]) {
      const res = await post(app(), text);
      expect(res.status, text).toBe(400);
      expect(await res.json()).toEqual({ error: "Body must be a JSON object" });
    }
  });
});
