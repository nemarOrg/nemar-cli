/**
 * The data plane's git-file broker (#1403, epic #1406).
 *
 * Real engines: a real `Bun.serve()` stands in for the raw content host and
 * for api.github.com (reached through the `NEMAR_GITHUB_API_URL` override the
 * other GitHub-facing suites use), and the route test drives the real
 * `dataRoutes` Hono app against a real D1. Nothing is mocked; the server
 * records every request, so the assertions are about what was actually sent.
 *
 * The route half is DIFFERENTIAL on purpose. An earlier version asserted
 * only that a private dataset produced no upstream request, and that assertion
 * held for the wrong reason: the test env carried no S3 credentials, so
 * `loadManifest` failed three steps before the gate mattered, and the same
 * test passed for a PUBLIC dataset too. It would have stayed green with the
 * visibility check deleted outright. So the public case now serves a real
 * manifest (through `S3_ENDPOINT_URL`, the same origin-override idiom the
 * zarr suites use) and MUST reach GitHub; the private one must not. Only the
 * pair proves the ordering.
 *
 * WHAT THIS SUITE CANNOT SEE, stated here because it is what a reader needs
 * before trusting a green run. It drives the route in-process, where no HTTP
 * serialization happens at all, so `headers.set("Content-Length", ...)`
 * always sticks. That makes it structurally blind to what caused #1419:
 * workerd DROPS a hand-set `Content-Length` when the body is a stream. A
 * green run here is not evidence about the deployed data plane; the oracle
 * for that is `test/git-broker-live.test.ts`, which is what caught #1419 and
 * what will confirm the fix once it reaches the staging worker. That file
 * SKIPS until then, so its silence on a feature branch is not evidence
 * either.
 *
 * What this suite can do about that class is pin the INTENT: the header is
 * asserted present on the buffered branch and asserted null on the streamed
 * one. Without the second assertion, restoring the unconditional set that
 * #1420 shipped passes every test here -- measured, not supposed.
 */

import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { Hono } from "hono";
import { dataRoutes } from "../src/routes/data";
import { fetchGitTrackedFile } from "../src/services/github/git-file-broker";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

/**
 * The real `git hash-object` of FILE_BODY, not an arbitrary 40 hex digits.
 * Since #1419 the route verifies that the bytes it brokered ARE the blob the
 * manifest named, so a fixture whose SHA does not match its body would 502
 * every happy path. Recompute with:
 *   printf '%s' '<FILE_BODY>' | git hash-object --stdin
 */
const BLOB_SHA = "8cb31ee475b57f9caf41c02a1e4de7862cde420c";
const FILE_BODY = '{"Name":"A dataset","BIDSVersion":"1.11.0"}';

interface Seen {
  method: string;
  path: string;
  authorization: string | null;
  accept: string | null;
}

let server: Server;
let base: string;
let seen: Seen[] = [];
/** Per-path behavior the current test wants from the stand-in. */
let routes: Record<string, () => Response> = {};

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      seen.push({
        method: request.method,
        path: url.pathname,
        authorization: request.headers.get("Authorization"),
        accept: request.headers.get("Accept"),
      });
      const handler = routes[url.pathname];
      return handler ? handler() : new Response("no route", { status: 404 });
    },
  });
  base = `http://127.0.0.1:${server.port}`;
  (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL = base;
});

afterAll(() => {
  (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL = undefined;
  server.stop(true);
});

function reset(next: Record<string, () => Response>): void {
  seen = [];
  routes = next;
}

const rawPath = "/nemarDatasets/nm099999/v1.0.0/dataset_description.json";
const blobPath = `/repos/nemarDatasets/nm099999/git/blobs/${BLOB_SHA}`;

function request(over: Partial<Parameters<typeof fetchGitTrackedFile>[0]> = {}) {
  return fetchGitTrackedFile({
    repo: "nm099999",
    ref: "v1.0.0",
    path: "dataset_description.json",
    blobSha: BLOB_SHA,
    token: "test-installation-token",
    rawBase: base,
    ...over,
  });
}

describe("fetchGitTrackedFile", () => {
  test("serves from the raw host and sends the installation token", async () => {
    reset({ [rawPath]: () => new Response(FILE_BODY, { status: 200 }) });

    const out = await request();

    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") throw new Error("unreachable");
    expect(out.source).toBe("raw");
    expect(await new Response(out.body).text()).toBe(FILE_BODY);
    // The token is what makes a private repo readable; without it this whole
    // phase does nothing that the old redirect did not.
    expect(seen).toHaveLength(1);
    expect(seen[0].authorization).toBe("Bearer test-installation-token");
    // The REST API must not be touched on the happy path: its budget is
    // shared with publishing and one download is thousands of files.
    expect(seen.some((s) => s.path.startsWith("/repos/"))).toBe(false);
  });

  test("reads anonymously when no token is configured", async () => {
    reset({ [rawPath]: () => new Response(FILE_BODY, { status: 200 }) });

    const out = await request({ token: null });

    expect(out.kind).toBe("ok");
    expect(seen[0].authorization).toBeNull();
  });

  test("falls back to the blob SHA when the path is not at that ref", async () => {
    reset({
      [rawPath]: () => new Response("not found", { status: 404 }),
      [blobPath]: () => new Response(FILE_BODY, { status: 200 }),
    });

    const out = await request();

    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") throw new Error("unreachable");
    expect(out.source).toBe("blob");
    // The fallback asks for the object the manifest named, by SHA, with the
    // media type that returns bytes rather than base64 JSON.
    const blobCall = seen.find((s) => s.path === blobPath);
    expect(blobCall?.accept).toBe("application/vnd.github.raw");
  });

  test("absent means both sources answered 404, not one", async () => {
    reset({
      [rawPath]: () => new Response("not found", { status: 404 }),
      [blobPath]: () => new Response("not found", { status: 404 }),
    });

    const out = await request();

    expect(out.kind).toBe("absent");
    expect(seen.map((s) => s.path)).toEqual([rawPath, blobPath]);
  });

  test("a throttle is reported as unavailable, never as absence", async () => {
    // The distinction ADR 0005 draws: telling a user their file does not
    // exist because we were rate limited is the failure worth preventing.
    reset({
      [rawPath]: () =>
        new Response("rate limited", { status: 429, headers: { "Retry-After": "42" } }),
    });

    const out = await request();

    expect(out.kind).toBe("unavailable");
    if (out.kind !== "unavailable") throw new Error("unreachable");
    expect(out.status).toBe(503);
    expect(out.retryAfter).toBe("42");
    // No blob fallback: a 429 says nothing about whether the path is there.
    expect(seen.some((s) => s.path === blobPath)).toBe(false);
  });

  test("a refused credential is a 502, and does not fall through to the blob", async () => {
    reset({ [rawPath]: () => new Response("bad credentials", { status: 401 }) });

    const out = await request();

    expect(out.kind).toBe("unavailable");
    if (out.kind !== "unavailable") throw new Error("unreachable");
    expect(out.status).toBe(502);
    expect(seen.some((s) => s.path === blobPath)).toBe(false);
  });

  test("an unreachable host is unavailable, not absent", async () => {
    reset({});
    // Port 1 with nothing listening: a real connection failure, not a status.
    const out = await request({ rawBase: "http://127.0.0.1:1" });

    expect(out.kind).toBe("unavailable");
    if (out.kind !== "unavailable") throw new Error("unreachable");
    expect(out.status).toBe(502);
  });

  test("a path with a space is encoded per segment", async () => {
    const encoded = "/nemarDatasets/nm099999/v1.0.0/sub-01/eeg/sub-01_task-rest%20events.tsv";
    reset({ [encoded]: () => new Response("onset\tduration\n", { status: 200 }) });

    const out = await request({ path: "sub-01/eeg/sub-01_task-rest events.tsv" });

    // The space has to reach the wire percent-encoded, and the slashes have
    // to survive: a whole-path encode would send %2F and miss the file.
    expect(out.kind).toBe("ok");
    expect(seen[0].path).toBe(encoded);
  });
});

describe("the route: the gate, then the bytes", () => {
  const VERSION = "v1.0.0";
  const PATH = "dataset_description.json";
  const manifestKey = `/nm000862/version/${VERSION}.json`;
  const publicRawPath = `/nemarDatasets/nm000862/${VERSION}/${PATH}`;

  /** The empty file: its git object name is the SHA-1 of `blob 0\0`. */
  function emptyManifestBody(): string {
    const emptySha = "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391";
    return JSON.stringify({
      dataset_id: "nm000862",
      version: "1.0.0",
      doi: null,
      concept_doi: null,
      created: "2026-01-01T00:00:00Z",
      files: { [PATH]: { key: `git:${emptySha}`, size: 0, checksum: `git:${emptySha}` } },
    });
  }

  function manifestBody(size = FILE_BODY.length): string {
    return JSON.stringify({
      dataset_id: "nm000862",
      version: "1.0.0",
      doi: null,
      concept_doi: null,
      created: "2026-01-01T00:00:00Z",
      files: { [PATH]: { key: `git:${BLOB_SHA}`, size, checksum: `git:${BLOB_SHA}` } },
    });
  }

  function seed(db: Database, id: string, visibility: "public" | "private"): void {
    db.prepare(
      `INSERT INTO datasets (dataset_id, name, owner_user_id, status, visibility, is_sandbox)
       VALUES (?, ?, 1, 'active', ?, 0)`,
    ).run(id, id, visibility);
    db.prepare(
      `INSERT INTO dataset_versions (dataset_id, version, doi, provider, created_at)
       VALUES (?, '1.0.0', '10.5072/FK2test', 'ezid', datetime('now'))`,
    ).run(id);
  }

  function app(): Hono<{ Bindings: Bindings; Variables: Variables }> {
    const hono = new Hono<{ Bindings: Bindings; Variables: Variables }>();
    hono.route("/", dataRoutes);
    return hono;
  }

  function env(db: Database): Bindings {
    return {
      DB: realD1(db),
      ENVIRONMENT: "test",
      GITHUB_RAW_BASE: base,
      S3_ENDPOINT_URL: base,
      S3_BUCKET: "nemar",
      AWS_REGION: "us-east-2",
      AWS_ACCESS_KEY_ID: "AKIATEST",
      AWS_SECRET_ACCESS_KEY: "secret",
      GITHUB_ADMIN_PAT: "test-pat",
    } as Bindings;
  }

  test("a public dataset's git file is streamed, and it DOES reach GitHub", async () => {
    const db = freshDb();
    seed(db, "nm000862", "public");
    reset({
      [manifestKey]: () => new Response(manifestBody(), { status: 200 }),
      [publicRawPath]: () =>
        new Response(FILE_BODY, {
          status: 200,
          headers: { "Content-Length": String(FILE_BODY.length) },
        }),
    });

    const res = await app().request(`/nm000862/${VERSION}/${PATH}`, {}, env(db));

    expect(res.status).toBe(200);
    expect(await res.text()).toBe(FILE_BODY);
    // The other half of the differential: this request MUST have gone
    // upstream. Without it, the private case below proves nothing.
    expect(seen.some((s) => s.path === publicRawPath)).toBe(true);
    expect(seen.find((s) => s.path === publicRawPath)?.authorization).toBe("Bearer test-pat");
  });

  test("the streamed response carries the headers that keep it inert and cacheable-but-revocable", async () => {
    const db = freshDb();
    seed(db, "nm000862", "public");
    reset({
      [manifestKey]: () => new Response(manifestBody(), { status: 200 }),
      [publicRawPath]: () =>
        new Response(FILE_BODY, {
          status: 200,
          headers: { "Content-Length": String(FILE_BODY.length), "Content-Type": "text/plain" },
        }),
    });

    const res = await app().request(`/nm000862/${VERSION}/${PATH}`, {}, env(db));

    expect(res.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Content-Security-Policy")).toBe("default-src 'none'; sandbox");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    // Deliberately NOT immutable: visibility can be revoked and nothing
    // purges the edge, so the staleness bound on an authorization decision
    // stays where the redirect had it.
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=300");
    expect(res.headers.get("ETag")).toBe(`"git:${BLOB_SHA}"`);
  });

  test("a length that disagrees with the manifest is refused, not served", async () => {
    const db = freshDb();
    seed(db, "nm000862", "public");
    reset({
      [manifestKey]: () => new Response(manifestBody(999), { status: 200 }),
      [publicRawPath]: () =>
        new Response(FILE_BODY, {
          status: 200,
          headers: { "Content-Length": String(FILE_BODY.length) },
        }),
    });

    const res = await app().request(`/nm000862/${VERSION}/${PATH}`, {}, env(db));

    expect(res.status).toBe(502);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  /**
   * A body the stand-in sends WITHOUT declaring a length, which is what the
   * broker actually meets in production: workerd owns `Accept-Encoding`, the
   * raw host gzips, and the runtime strips `Content-Length` when it decodes.
   * A `Response` built from a stream is chunked, so the client sees no length
   * -- the same shape, reproduced with a real server rather than asserted.
   */
  function streamed(text: string): Response {
    const bytes = new TextEncoder().encode(text);
    return new Response(
      new ReadableStream<Uint8Array>({
        async start(controller) {
          // Two chunks with a turn of the event loop between them. A stream
          // that closes synchronously is small enough for Bun to buffer and
          // declare a length for, which would make these tests pass through
          // the header check they are here to bypass; yielding forces the
          // chunked response the runtime actually hands the broker.
          controller.enqueue(bytes.subarray(0, 1));
          await Bun.sleep(1);
          controller.enqueue(bytes.subarray(1));
          controller.close();
        },
      }),
    );
  }

  /** A stand-in whose body fails partway, which is what a dropped upstream
   *  connection looks like to the route: bytes, then an error. */
  function diesMidBody(prefix: string): Response {
    return new Response(
      new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(new TextEncoder().encode(prefix));
          await Bun.sleep(1);
          controller.error(new Error("upstream died"));
        },
      }),
    );
  }

  // The control for `streamed()`. Everything below that targets the
  // measurement depends on the stand-in really sending a chunked body with no
  // length; if Bun ever buffers it anyway, three tests would silently reroute
  // through the upstream-header fast path and keep passing while proving
  // something else. This fails in milliseconds when that happens.
  test("the stand-in really sends a chunked body with no declared length", async () => {
    reset({ [publicRawPath]: () => streamed(FILE_BODY) });

    const direct = await fetch(`${base}${publicRawPath}`);

    expect(direct.headers.get("Content-Length")).toBeNull();
    expect(direct.headers.get("Transfer-Encoding")).toBe("chunked");
    await direct.text();
  });

  test("a length upstream never declared is still declared to the client", async () => {
    const db = freshDb();
    seed(db, "nm000862", "public");
    reset({
      [manifestKey]: () => new Response(manifestBody(), { status: 200 }),
      [publicRawPath]: () => streamed(FILE_BODY),
    });

    const res = await app().request(`/nm000862/${VERSION}/${PATH}`, {}, env(db));

    expect(res.status).toBe(200);
    // What this pins is the BUFFERED branch declaring a length it measured,
    // with upstream declaring none. It does not pin #1419 itself: under Bun
    // the pre-fix code declared the header too (mutation-tested), which is
    // why the streamed-branch assertion below exists and why the live test is
    // the oracle.
    expect(res.headers.get("Content-Length")).toBe(String(FILE_BODY.length));
    expect(await res.text()).toBe(FILE_BODY);
  });

  test("a body shorter than the manifest is refused, not served", async () => {
    const db = freshDb();
    seed(db, "nm000862", "public");
    reset({
      // Upstream declares nothing, so the header check cannot fire and only
      // the measurement stands between a truncated file and a 200 that looks
      // healthy.
      [manifestKey]: () => new Response(manifestBody(FILE_BODY.length + 10), { status: 200 }),
      [publicRawPath]: () => streamed(FILE_BODY),
    });

    const res = await app().request(`/nm000862/${VERSION}/${PATH}`, {}, env(db));

    expect(res.status).toBe(502);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  test("a body longer than the manifest is refused, not served", async () => {
    const db = freshDb();
    seed(db, "nm000862", "public");
    reset({
      [manifestKey]: () => new Response(manifestBody(4), { status: 200 }),
      [publicRawPath]: () => streamed(FILE_BODY),
    });

    const res = await app().request(`/nm000862/${VERSION}/${PATH}`, {}, env(db));

    expect(res.status).toBe(502);
  });

  test("the right number of bytes is not enough: a same-size edit is refused", async () => {
    const db = freshDb();
    seed(db, "nm000862", "public");
    const sameLength = FILE_BODY.replace("1.11.0", "1.10.0");
    expect(sameLength.length).toBe(FILE_BODY.length);
    expect(sameLength).not.toBe(FILE_BODY);
    reset({
      [manifestKey]: () => new Response(manifestBody(), { status: 200 }),
      [publicRawPath]: () => streamed(sameLength),
    });

    const res = await app().request(`/nm000862/${VERSION}/${PATH}`, {}, env(db));

    // The scenario the length check was written for and could not see. The
    // raw fetch is by REF, so a moved tag serves the new blob at the same
    // path; when the edit does not change the size, every length comparison
    // passes and the response would carry an ETag naming the OLD blob.
    expect(res.status).toBe(502);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  test("a body that dies mid-read is refused, and says so distinctly", async () => {
    const db = freshDb();
    seed(db, "nm000862", "public");
    reset({
      [manifestKey]: () => new Response(manifestBody(), { status: 200 }),
      [publicRawPath]: () => diesMidBody("partial"),
    });

    const res = await app().request(`/nm000862/${VERSION}/${PATH}`, {}, env(db));

    expect(res.status).toBe(502);
    // Never cacheable: a transient upstream drop pinned at the edge would
    // turn one dropped connection into five minutes of failure per URL.
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    // Its own sentence, not the "refused us" one, and a hint about when to
    // come back -- this is the most transient failure in the function.
    expect(await res.json()).toMatchObject({
      error: "Upstream content host dropped the transfer",
    });
    expect(res.headers.get("Retry-After")).toBe("5");
  });

  test("a zero-length file is served, with a zero length", async () => {
    const db = freshDb();
    seed(db, "nm000862", "public");
    reset({
      [manifestKey]: () => new Response(emptyManifestBody(), { status: 200 }),
      [publicRawPath]: () => new Response("", { status: 200 }),
    });

    const res = await app().request(`/nm000862/${VERSION}/${PATH}`, {}, env(db));

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Length")).toBe("0");
    expect(await res.text()).toBe("");
  });

  test("a body larger than the manifest is not read past what was promised", async () => {
    const db = freshDb();
    seed(db, "nm000862", "public");
    // The failure this guards: both size gates test the MANIFEST's number, so
    // nothing bounds what upstream sends. Draining first and comparing after
    // would read a retagged recording into a 128 MB isolate in full -- a kill
    // that cannot even be caught and logged, taking every unrelated in-flight
    // request with it.
    const CHUNK = 64 * 1024;
    const TOTAL = 256;
    let pushed = 0;
    reset({
      [manifestKey]: () => new Response(manifestBody(), { status: 200 }),
      [publicRawPath]: () =>
        new Response(
          new ReadableStream<Uint8Array>({
            async pull(controller) {
              if (pushed >= TOTAL) {
                controller.close();
                return;
              }
              pushed++;
              controller.enqueue(new Uint8Array(CHUNK));
              await Bun.sleep(0);
            },
          }),
        ),
    });

    const res = await app().request(`/nm000862/${VERSION}/${PATH}`, {}, env(db));

    expect(res.status).toBe(502);
    // The assertion that makes this a test rather than a duplicate of the
    // short/long ones: it is 502 either way, so only the byte count shows
    // whether the read was bounded. The manifest promised 43 bytes; a
    // bounded read stops within a chunk or two of that.
    expect(pushed).toBeLessThan(TOTAL);
    expect(pushed * CHUNK).toBeLessThan(4 * CHUNK);
  });

  test("above the buffer ceiling it streams, with NO declared length", async () => {
    const db = freshDb();
    seed(db, "nm000862", "public");
    reset({
      [manifestKey]: () => new Response(manifestBody(), { status: 200 }),
      [publicRawPath]: () => streamed(FILE_BODY),
    });

    const res = await app().request(
      `/nm000862/${VERSION}/${PATH}`,
      {},
      { ...env(db), BROKER_BUFFER_MAX_BYTES: String(FILE_BODY.length - 1) },
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toBe(FILE_BODY);
    // THE assertion of this PR. Without it, restoring the unconditional
    // `headers.set("Content-Length", ...)` that #1420 shipped -- the change
    // that deployed and did not work -- passes the entire suite.
    expect(res.headers.get("Content-Length")).toBeNull();
  });

  test("a file exactly at the ceiling is buffered, not streamed", async () => {
    const db = freshDb();
    seed(db, "nm000862", "public");
    reset({
      [manifestKey]: () => new Response(manifestBody(), { status: 200 }),
      [publicRawPath]: () => streamed(FILE_BODY),
    });

    const res = await app().request(
      `/nm000862/${VERSION}/${PATH}`,
      {},
      { ...env(db), BROKER_BUFFER_MAX_BYTES: String(FILE_BODY.length) },
    );

    // "At or below" is the documented boundary, so the ceiling itself
    // buffers. Pins `>` against a drift to `>=`.
    expect(res.headers.get("Content-Length")).toBe(String(FILE_BODY.length));
  });

  test("a ceiling that is not a byte count falls back to the default", async () => {
    const db = freshDb();
    seed(db, "nm000862", "public");
    reset({
      [manifestKey]: () => new Response(manifestBody(), { status: 200 }),
      [publicRawPath]: () => streamed(FILE_BODY),
    });

    // "8MB" is the obvious spelling and the one this binding's doc comment
    // writes in prose. `Number.parseInt` would read it as EIGHT BYTES, put
    // every file in the catalog on the streamed branch, and reproduce #1419's
    // production symptom through a config typo, silently.
    const res = await app().request(
      `/nm000862/${VERSION}/${PATH}`,
      {},
      { ...env(db), BROKER_BUFFER_MAX_BYTES: "8MB" },
    );

    expect(res.headers.get("Content-Length")).toBe(String(FILE_BODY.length));
  });

  test("above the ceiling, a short body still fails the transfer", async () => {
    const db = freshDb();
    seed(db, "nm000862", "public");
    reset({
      [manifestKey]: () => new Response(manifestBody(FILE_BODY.length + 10), { status: 200 }),
      [publicRawPath]: () => streamed(FILE_BODY),
    });

    const res = await app().request(
      `/nm000862/${VERSION}/${PATH}`,
      {},
      { ...env(db), BROKER_BUFFER_MAX_BYTES: "0" },
    );

    // Streamed: the status is committed before the length is known, so the
    // only honest refusal left is a transfer the client cannot complete. A
    // ceiling of 0 reaches this branch without a multi-megabyte fixture; what
    // it does NOT reproduce is the real shape, an 8-32 MB body arriving in
    // many chunks under backpressure.
    expect(res.status).toBe(200);
    expect(res.text()).rejects.toThrow(/did not match the manifest/);
  });

  test("above the ceiling, an upstream-declared mismatch is still a clean 502", async () => {
    const db = freshDb();
    seed(db, "nm000862", "public");
    reset({
      [manifestKey]: () => new Response(manifestBody(999), { status: 200 }),
      [publicRawPath]: () =>
        new Response(FILE_BODY, {
          status: 200,
          headers: { "Content-Length": String(FILE_BODY.length) },
        }),
    });

    const res = await app().request(
      `/nm000862/${VERSION}/${PATH}`,
      {},
      { ...env(db), BROKER_BUFFER_MAX_BYTES: "0" },
    );

    // The only place the upstream-header fast path is still observable: on
    // the buffered branch it produces the same 502 as the measurement, so
    // deleting it changes nothing there. Here it is the difference between a
    // clean refusal and a 200 that aborts mid-transfer.
    expect(res.status).toBe(502);
  });

  test("a refused body is not recorded as bytes delivered, and a served one is", async () => {
    const db = freshDb();
    seed(db, "nm000862", "public");
    const points: Array<{ blobs: string[]; doubles: number[] }> = [];
    const collecting = {
      ...env(db),
      ANALYTICS: {
        writeDataPoint: (p: { blobs: string[]; doubles: number[] }) => {
          points.push(p);
        },
      },
    } as unknown as Bindings;

    // Refused: the manifest promises more than upstream sends.
    reset({
      [manifestKey]: () => new Response(manifestBody(FILE_BODY.length + 10), { status: 200 }),
      [publicRawPath]: () => streamed(FILE_BODY),
    });
    const refused = await app().request(`/nm000862/${VERSION}/${PATH}`, {}, collecting);
    expect(refused.status).toBe(502);
    expect(points).toEqual([]);

    // Served: the same collector, so the negative half above cannot pass by
    // `recordAccess` having been deleted outright.
    reset({
      [manifestKey]: () => new Response(manifestBody(), { status: 200 }),
      [publicRawPath]: () => streamed(FILE_BODY),
    });
    const served = await app().request(`/nm000862/${VERSION}/${PATH}`, {}, collecting);
    expect(served.status).toBe(200);
    expect(points).toHaveLength(1);
    expect(points[0].doubles[0]).toBe(FILE_BODY.length);
  });

  test("an upstream throttle is a 5xx with Retry-After, never a 404", async () => {
    const db = freshDb();
    seed(db, "nm000862", "public");
    reset({
      [manifestKey]: () => new Response(manifestBody(), { status: 200 }),
      [publicRawPath]: () =>
        new Response("slow down", { status: 429, headers: { "Retry-After": "30" } }),
    });

    const res = await app().request(`/nm000862/${VERSION}/${PATH}`, {}, env(db));

    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("30");
  });

  test("a file that is genuinely gone is a 404", async () => {
    const db = freshDb();
    seed(db, "nm000862", "public");
    reset({
      [manifestKey]: () => new Response(manifestBody(), { status: 200 }),
      [publicRawPath]: () => new Response("nope", { status: 404 }),
      [`/repos/nemarDatasets/nm000862/git/blobs/${BLOB_SHA}`]: () =>
        new Response("nope", { status: 404 }),
    });

    const res = await app().request(`/nm000862/${VERSION}/${PATH}`, {}, env(db));

    expect(res.status).toBe(404);
  });

  test("a private dataset 404s without a single upstream request", async () => {
    const db = freshDb();
    seed(db, "nm000862", "private");
    reset({
      [manifestKey]: () => new Response(manifestBody(), { status: 200 }),
      [publicRawPath]: () => new Response(FILE_BODY, { status: 200 }),
    });

    const res = await app().request(`/nm000862/${VERSION}/${PATH}`, {}, env(db));

    expect(res.status).toBe(404);
    // Not even the manifest is read: the gate is the first thing that runs,
    // so no token is minted and nothing about this dataset leaves the Worker.
    expect(seen).toHaveLength(0);
  });

  test("an unknown dataset 404s without a single upstream request", async () => {
    const db = freshDb();
    reset({ [manifestKey]: () => new Response(manifestBody(), { status: 200 }) });

    const res = await app().request(`/nm000863/${VERSION}/${PATH}`, {}, env(db));

    expect(res.status).toBe(404);
    expect(seen).toHaveLength(0);
  });
});
