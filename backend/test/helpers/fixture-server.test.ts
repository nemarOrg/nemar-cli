/**
 * Small self-test for `fixture-server.ts` (epic #1065 phase 3, issue
 * #1295): before other suites trust it as a stand-in S3/GitHub-raw
 * upstream, confirm its HEAD/Range/logging behavior against a real
 * `Bun.serve()` instance.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type FixtureServer, startFixtureServer } from "./fixture-server.js";

describe("fixture-server", () => {
  let server: FixtureServer;

  beforeAll(() => {
    const bytes = new Uint8Array(100);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i;
    server = startFixtureServer({ "dataset/object.bin": bytes });
  });

  afterAll(() => {
    server.stop();
  });

  test("GET answers 200 with the full body", async () => {
    const res = await fetch(`${server.url}/dataset/object.bin`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe("100");
    const body = new Uint8Array(await res.arrayBuffer());
    expect(body.length).toBe(100);
    expect(body[0]).toBe(0);
    expect(body[99]).toBe(99);
  });

  test("HEAD answers Content-Length with no body", async () => {
    const res = await fetch(`${server.url}/dataset/object.bin`, { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe("100");
    const body = await res.arrayBuffer();
    expect(body.byteLength).toBe(0);
  });

  test("a bounded Range answers 206 with the right slice and Content-Range", async () => {
    const res = await fetch(`${server.url}/dataset/object.bin`, {
      headers: { Range: "bytes=10-19" },
    });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 10-19/100");
    expect(res.headers.get("content-length")).toBe("10");
    const body = new Uint8Array(await res.arrayBuffer());
    expect(Array.from(body)).toEqual(Array.from({ length: 10 }, (_, i) => 10 + i));
  });

  test("a suffix Range (bytes=-N) answers the last N bytes", async () => {
    const res = await fetch(`${server.url}/dataset/object.bin`, {
      headers: { Range: "bytes=-5" },
    });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 95-99/100");
  });

  test("a malformed Range (non-numeric) answers 416 with Content-Range: bytes */<len> (item 22)", async () => {
    const res = await fetch(`${server.url}/dataset/object.bin`, {
      headers: { Range: "bytes=abc-def" },
    });
    expect(res.status).toBe(416);
    expect(res.headers.get("content-range")).toBe("bytes */100");
  });

  test("an out-of-range Range (start past the end) answers 416 with Content-Range: bytes */<len> (item 22)", async () => {
    const res = await fetch(`${server.url}/dataset/object.bin`, {
      headers: { Range: "bytes=200-300" },
    });
    expect(res.status).toBe(416);
    expect(res.headers.get("content-range")).toBe("bytes */100");
  });

  test("an unknown key answers 404", async () => {
    const res = await fetch(`${server.url}/dataset/missing.bin`);
    expect(res.status).toBe(404);
  });

  test("the request log records method, url, and range", async () => {
    const before = server.requestLog.length;
    await fetch(`${server.url}/dataset/object.bin`, { headers: { Range: "bytes=0-4" } });
    const entry = server.requestLog[before];
    expect(entry.method).toBe("GET");
    expect(entry.url).toBe("dataset/object.bin");
    expect(entry.range).toBe("bytes=0-4");
  });

  test("files registered after start() are servable (index-rewrite pattern)", async () => {
    const extra = new Uint8Array([1, 2, 3]);
    server.files.set("dataset/added-later.bin", extra);
    const res = await fetch(`${server.url}/dataset/added-later.bin`);
    expect(res.status).toBe(200);
    const body = new Uint8Array(await res.arrayBuffer());
    expect(Array.from(body)).toEqual([1, 2, 3]);
  });
});
