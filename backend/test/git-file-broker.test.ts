/**
 * The data plane's git-file broker (#1403, epic #1406).
 *
 * Real engines: a real `Bun.serve()` stands in for the raw content host and
 * for api.github.com (reached through the `NEMAR_GITHUB_API_URL` override the
 * other GitHub-facing suites use), and the route test drives the real
 * `dataRoutes` Hono app against a real D1. Nothing is mocked; the server
 * records every request, so the assertions are about what was actually sent.
 *
 * What is NOT covered here, deliberately: a full end-to-end stream through
 * the route, because `getManifest` addresses S3 by a hardcoded
 * `<bucket>.s3.<region>.amazonaws.com` URL with no endpoint seam, so reaching
 * the streaming branch would mean either a real S3 read or a mock. That path
 * is covered against real GitHub by the live tier instead (an exemplar whose
 * repo is private), which is the only place it can be exercised honestly.
 */

import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { Hono } from "hono";
import { dataRoutes } from "../src/routes/data";
import { fetchGitTrackedFile } from "../src/services/github/git-file-broker";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

const BLOB_SHA = "1f401a7ca0456812df0499c38c51eeb08fc11d1e";
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

describe("the visibility gate runs before anything reaches GitHub", () => {
  function app(db: Database) {
    const hono = new Hono<{ Bindings: Bindings; Variables: Variables }>();
    hono.route("/", dataRoutes);
    return hono;
  }

  function env(db: Database): Bindings {
    return {
      DB: realD1(db),
      ENVIRONMENT: "test",
      GITHUB_RAW_BASE: base,
      S3_BUCKET: "nemar",
      AWS_REGION: "us-east-2",
    } as Bindings;
  }

  test("a private dataset 404s without a single upstream request", async () => {
    const db = freshDb();
    db.prepare(
      `INSERT INTO datasets (dataset_id, name, owner_user_id, status, visibility, is_sandbox)
       VALUES ('nm000860', 'private one', 1, 'active', 'private', 0)`,
    ).run();
    reset({ [rawPath]: () => new Response(FILE_BODY, { status: 200 }) });

    const res = await app(db).request("/nm000860/v1.0.0/dataset_description.json", {}, env(db));

    expect(res.status).toBe(404);
    // The gate has to come first for the token never to be minted on behalf
    // of a dataset the catalog will not serve.
    expect(seen).toHaveLength(0);
  });

  test("an unknown dataset 404s without a single upstream request", async () => {
    const db = freshDb();
    reset({ [rawPath]: () => new Response(FILE_BODY, { status: 200 }) });

    const res = await app(db).request("/nm000861/v1.0.0/dataset_description.json", {}, env(db));

    expect(res.status).toBe(404);
    expect(seen).toHaveLength(0);
  });
});
