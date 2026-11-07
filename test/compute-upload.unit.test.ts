/**
 * The bundle upload (epic #2021 phase D3b, #2024; `src/lib/compute/upload.ts`) against a real HTTP server
 * that stands where the store stands: it records the method, the headers and the body of each request and
 * answers as the test says. Through the real Worker and the real local S3 interface it is exercised by
 * `compute-user-e2e-cli.test.ts`; what is pinned HERE is the client's side of the contract: exactly the
 * issued headers plus Content-Length, no credential, three retries on a 5xx or a failure to connect, no
 * retry on a 4xx, an expired address aborts before any request, and a wrong-length body is never sent.
 */

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import type { ComputeUpload } from "../shared/contract/compute-submit";
import { UPLOAD_BACKOFF_MS, uploadBundle } from "../src/lib/compute/upload";

interface Seen {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: Uint8Array;
}

let seen: Seen[] = [];
let answers: number[] = [];

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: async (req) => {
    const headers: Record<string, string> = {};
    req.headers.forEach((v, k) => {
      headers[k] = v;
    });
    seen.push({
      method: req.method,
      path: new URL(req.url).pathname,
      headers,
      body: new Uint8Array(await req.arrayBuffer()),
    });
    if (new URL(req.url).pathname === "/redirect") {
      return Response.redirect(`http://127.0.0.1:${server.port}/landing`, 307);
    }
    const status = answers.shift() ?? 200;
    return new Response(status === 200 ? "" : "<Error>no</Error>", { status });
  },
});
afterAll(() => server.stop(true));
beforeEach(() => {
  seen = [];
  answers = [];
});

const archive = new TextEncoder().encode("archive bytes, any bytes");
const address = (over: Partial<ComputeUpload> = {}): ComputeUpload => ({
  url: `http://127.0.0.1:${server.port}/incoming/job/bundle.tar.gz?X-Amz-Signature=abc`,
  method: "PUT",
  headers: { "x-amz-checksum-sha256": "c2lnbmVk" },
  expires_at: new Date(Date.now() + 3_600_000).toISOString(),
  size: archive.length,
  ...over,
});

const noSleep = () => {
  const slept: number[] = [];
  return { slept, sleep: async (ms: number) => void slept.push(ms) };
};

describe("the request", () => {
  test("PUT with exactly the issued headers and the length, the bytes as the body, and no credential", async () => {
    const out = await uploadBundle(
      address({ headers: { "x-amz-checksum-sha256": "c2lnbmVk", "x-extra": "1" } }),
      archive,
    );
    expect(out).toEqual({ ok: true, attempts: 1 });
    expect(seen).toHaveLength(1);
    const request = seen[0] as Seen;
    expect(request.method).toBe("PUT");
    expect(request.headers["x-amz-checksum-sha256"]).toBe("c2lnbmVk");
    expect(request.headers["x-extra"]).toBe("1");
    expect(request.headers["content-length"]).toBe(String(archive.length));
    expect(Buffer.from(request.body).equals(Buffer.from(archive))).toBe(true);
    expect(request.headers.authorization).toBeUndefined();
    expect(request.headers.cookie).toBeUndefined();
    expect(request.headers["x-cli-version"]).toBeUndefined();
  });
});

describe("retries", () => {
  test("a 503 twice and then success is one upload; the waits are 1 s and 2 s", async () => {
    answers = [503, 500];
    const { slept, sleep } = noSleep();
    expect(await uploadBundle(address(), archive, { sleep })).toEqual({ ok: true, attempts: 3 });
    expect(slept).toEqual([1000, 2000]);
    expect(seen).toHaveLength(3);
  });

  test("a 5xx on every attempt is three retries and then failed", async () => {
    answers = [502, 502, 502, 502, 502];
    const { slept, sleep } = noSleep();
    expect(await uploadBundle(address(), archive, { sleep })).toEqual({
      ok: false,
      kind: "failed",
      status: 502,
      attempts: 4,
    });
    expect(slept).toEqual([...UPLOAD_BACKOFF_MS]);
    expect(seen).toHaveLength(4);
  });

  test("no answer at all is retried the same way and ends failed with no status", async () => {
    const dead = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
    const url = `http://127.0.0.1:${dead.port}/x`;
    dead.stop(true);
    const { slept, sleep } = noSleep();
    expect(await uploadBundle(address({ url }), archive, { sleep })).toEqual({
      ok: false,
      kind: "failed",
      status: null,
      attempts: 4,
    });
    expect(slept).toHaveLength(3);
  });

  test("a 403 is the address expired: no retry; any other 4xx is a refusal: no retry", async () => {
    answers = [403];
    expect(await uploadBundle(address(), archive)).toEqual({
      ok: false,
      kind: "expired",
      attempts: 1,
    });
    answers = [400];
    expect(await uploadBundle(address(), archive)).toEqual({
      ok: false,
      kind: "refused",
      status: 400,
      attempts: 1,
    });
    expect(seen).toHaveLength(2);
  });
});

describe("before any request", () => {
  test("an address long past its time is expired and nothing is sent", async () => {
    const out = await uploadBundle(
      address({ expires_at: new Date(Date.now() - 10 * 60_000).toISOString() }),
      archive,
    );
    expect(out).toEqual({ ok: false, kind: "expired", attempts: 0 });
    expect(seen).toHaveLength(0);
  });

  test("within the clock-skew margin the store decides: a request is sent, and its 403 is expired", async () => {
    answers = [403];
    const out = await uploadBundle(
      address({ expires_at: new Date(Date.now() - 60_000).toISOString() }),
      archive,
    );
    expect(out).toEqual({ ok: false, kind: "expired", attempts: 1 });
    expect(seen).toHaveLength(1);
    answers = [];
    const fine = await uploadBundle(
      address({ expires_at: new Date(Date.now() - 60_000).toISOString() }),
      archive,
    );
    expect(fine).toEqual({ ok: true, attempts: 1 });
  });

  test("the clock is injectable", async () => {
    const soon = new Date(Date.now() + 60_000).toISOString();
    const out = await uploadBundle(address({ expires_at: soon }), archive, {
      now: () => Date.now() + 10 * 60_000,
    });
    expect(out).toEqual({ ok: false, kind: "expired", attempts: 0 });
  });

  test("a body that is not the signed length is never sent", async () => {
    expect(await uploadBundle(address({ size: archive.length + 1 }), archive)).toEqual({
      ok: false,
      kind: "wrong_size",
      attempts: 0,
    });
    expect(seen).toHaveLength(0);
  });

  test("an address that is not https (and not this machine) is never used", async () => {
    const out = await uploadBundle(
      address({ url: "http://store.example.org/x?X-Amz-Signature=a" }),
      archive,
    );
    expect(out).toEqual({ ok: false, kind: "insecure_address", attempts: 0 });
    expect(seen).toHaveLength(0);
  });

  test("a redirect is not followed: the signed headers never go to another host", async () => {
    answers = [];
    const out = await uploadBundle(
      address({ url: `http://127.0.0.1:${server.port}/redirect` }),
      archive,
      {
        sleep: async () => {},
      },
    );
    expect(out).toMatchObject({ ok: false, kind: "failed", status: null });
    expect(seen.map((s) => s.method)).toEqual(["PUT", "PUT", "PUT", "PUT"]);
    expect(seen.some((s) => s.path === "/landing")).toBe(false);
    expect(seen.every((s) => s.headers.host === `127.0.0.1:${server.port}`)).toBe(true);
  });
});
