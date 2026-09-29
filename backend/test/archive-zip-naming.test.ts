/**
 * `/<id>/<version>.zip` under the #1491 archive rename and the #1518
 * latest-only retention policy.
 *
 * Real engines: the actual `dataRoutes` Hono app, a real D1 (every
 * migration applied via `freshDb`/`realD1`), and a real local HTTP server
 * standing in for S3 through `S3_ENDPOINT_URL` (the same origin-override
 * idiom `data-route-manifest-stream.test.ts` and the zarr suites use).
 * `headArchiveKey`'s SigV4-signed HEAD requests land on this server, which
 * does not verify the signature -- exactly like the manifest stand-in,
 * this tests which URL our code calls and how it reads the response, not
 * AWS's own auth.
 *
 * #1491: archives moved from `<id>/archives/v<version>.zip` to
 * `<id>/archives/<id>_v<version>.zip`. `resolveArchiveKey` (services/s3.ts)
 * tries the new name first and falls back to the old one during the
 * transition window before the lead's rename sweep runs; that ordering is
 * the thing under test here (see "prefers the new key when both exist").
 *
 * #1518: only the latest version keeps a retained archive. A request for
 * an older version's zip must say so plainly instead of a "not yet
 * available" 404 that reads like the build is still in flight.
 */

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { dataRoutes } from "../src/routes/data";
import { archiveKey, legacyArchiveKey } from "../src/services/s3";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";
import { type FixtureServer, startFixtureServer } from "./helpers/fixture-server";

const DATASET = "nm000132";

describe("archiveKey / legacyArchiveKey (pure, #1491)", () => {
  test("archiveKey embeds the dataset id in the file name and normalizes the version tag", () => {
    expect(archiveKey("on002718", "1.0.0")).toBe("on002718/archives/on002718_v1.0.0.zip");
    expect(archiveKey("on002718", "v1.0.0")).toBe("on002718/archives/on002718_v1.0.0.zip");
  });

  test("legacyArchiveKey is the pre-#1491 shape, no dataset id in the file name", () => {
    expect(legacyArchiveKey("on002718", "1.0.0")).toBe("on002718/archives/v1.0.0.zip");
    expect(legacyArchiveKey("on002718", "v1.0.0")).toBe("on002718/archives/v1.0.0.zip");
  });
});

let db: Database;
let s3: FixtureServer;

function seed(versions: [string, string][]): void {
  db.prepare(
    `INSERT INTO datasets (dataset_id, name, owner_user_id, status, visibility, is_sandbox)
     VALUES (?, ?, 1, 'active', 'public', 0)`,
  ).run(DATASET, DATASET);
  for (const [version, createdAt] of versions) {
    db.prepare(
      `INSERT INTO dataset_versions (dataset_id, version, doi, provider, created_at)
       VALUES (?, ?, ?, 'ezid', ?)`,
    ).run(DATASET, version, `10.5072/FK2${DATASET}${version}`, createdAt);
  }
}

beforeEach(() => {
  db = freshDb();
  s3 = startFixtureServer();
  seed([
    ["1.0.0", "2026-03-14 12:20:43"],
    ["1.0.1", "2026-04-04 06:05:15"], // latest
  ]);
});

afterEach(() => {
  s3.stop();
});

function app(): Hono<{ Bindings: Bindings; Variables: Variables }> {
  const hono = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  hono.route("/", dataRoutes);
  return hono;
}

function env(): Bindings {
  return {
    DB: realD1(db),
    ENVIRONMENT: "test",
    DATA_BASE_URL: "https://data.nemar.org",
    S3_ENDPOINT_URL: s3.url,
    S3_BUCKET: "nemar",
    AWS_REGION: "us-east-2",
    AWS_ACCESS_KEY_ID: "AKIATEST",
    AWS_SECRET_ACCESS_KEY: "secret",
  } as Bindings;
}

async function getZip(version: string): Promise<Response> {
  return app().request(
    `https://data.nemar.org/${DATASET}/${version}.zip`,
    { redirect: "manual" },
    env(),
  );
}

describe("latest version: new-name-first with pre-#1491 fallback", () => {
  test("302s to the #1491 key when only the new name exists", async () => {
    s3.files.set(`${DATASET}/archives/${DATASET}_v1.0.1.zip`, new Uint8Array([1]));
    const res = await getZip("v1.0.1");
    expect(res.status).toBe(302);
    const loc = res.headers.get("Location") ?? "";
    expect(loc).toContain(`/${DATASET}/archives/${DATASET}_v1.0.1.zip?`);
  });

  test("falls back to the pre-#1491 key when only the old name exists", async () => {
    s3.files.set(`${DATASET}/archives/v1.0.1.zip`, new Uint8Array([1]));
    const res = await getZip("v1.0.1");
    expect(res.status).toBe(302);
    const loc = res.headers.get("Location") ?? "";
    expect(loc).toContain(`/${DATASET}/archives/v1.0.1.zip?`);
    expect(loc).not.toContain(`${DATASET}_v1.0.1.zip`);
  });

  // Order-sensitive: this is the assertion a swapped or dropped fallback
  // check breaks (see the PR's mutation-testing note).
  test("prefers the new key when both the new and old names exist", async () => {
    s3.files.set(`${DATASET}/archives/${DATASET}_v1.0.1.zip`, new Uint8Array([1]));
    s3.files.set(`${DATASET}/archives/v1.0.1.zip`, new Uint8Array([2]));
    const res = await getZip("v1.0.1");
    expect(res.status).toBe(302);
    const loc = res.headers.get("Location") ?? "";
    expect(loc).toContain(`/${DATASET}/archives/${DATASET}_v1.0.1.zip?`);
  });

  test("404s cleanly when neither name exists yet", async () => {
    const res = await getZip("v1.0.1");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("not yet available");
  });
});

describe("#1518: an older version has no retained archive", () => {
  test("says so plainly instead of a bare 404, even if a zip exists under the old key", async () => {
    // Simulates the pre-#1518 world where an older version's zip might
    // still be sitting in S3: the route must not even look for it.
    s3.files.set(`${DATASET}/archives/v1.0.0.zip`, new Uint8Array([1]));
    const res = await getZip("v1.0.0");
    expect(res.status).toBe(404);
    const body = (await res.json()) as {
      error: string;
      version: string;
      reason: string;
      latest_version: string;
      browse_url: string;
    };
    expect(body.error).toContain("Only the latest version has a downloadable archive");
    expect(body.reason).toBe("not_latest_version");
    expect(body.version).toBe("v1.0.0");
    expect(body.latest_version).toBe("v1.0.1");
    expect(body.browse_url).toBe(`/${DATASET}/v1.0.0/`);
    // Never HEADed S3 for the older version's archive.
    expect(s3.requestLog.some((r) => r.url.includes("archives/"))).toBe(false);
  });

  test("the latest version itself is unaffected by the older-version guard", async () => {
    s3.files.set(`${DATASET}/archives/${DATASET}_v1.0.1.zip`, new Uint8Array([1]));
    const res = await getZip("v1.0.1");
    expect(res.status).toBe(302);
  });
});

describe("a well-formed but never-published version (review finding)", () => {
  test("404s plainly rather than answering not_latest_version with a dead browse_url", async () => {
    // v99.99.99 passes resolveVersion's shape check (VERSION_TAG_RE) but was
    // never inserted into dataset_versions by `seed` above. Before the fix,
    // this fell into the #1518 not-latest branch and answered
    // `reason: "not_latest_version"` with a `browse_url` that itself 404s,
    // rather than a plain "Version not found."
    const res = await getZip("v99.99.99");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string; reason?: string };
    expect(body.error).toContain("Version not found");
    expect(body.reason).not.toBe("not_latest_version");
    // Never even asked whether it was the latest, let alone HEADed S3.
    expect(s3.requestLog.some((r) => r.url.includes("archives/"))).toBe(false);
  });
});
