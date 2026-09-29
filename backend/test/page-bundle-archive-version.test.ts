/**
 * Entry-point coverage for page-bundle.json's #1518 archive-field override
 * (PR review finding: the pure `archiveForRequestedVersion` helper was
 * unit-tested directly in landing-payload-archive.test.ts, but nothing
 * drove it through the actual route the way a real client does -- the
 * `isLatestVersion` wiring in `buildPageBundle` was untested).
 *
 * Real `dataRoutes` app, real D1 (every migration applied), and a real
 * local HTTP stand-in for S3, following the same pattern as
 * archive-zip-naming.test.ts. `loadSummary`/`loadCatalogRow`/
 * `loadEnrichedMetadata` are allowed to fail against the (empty) fixture
 * server -- `landing.data.archive`, which this suite asserts on, is built
 * synchronously from D1 before the S3 fan-out and does not depend on them.
 */

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { dataRoutes } from "../src/routes/data";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";
import { type FixtureServer, startFixtureServer } from "./helpers/fixture-server";

const DATASET = "nm000132";

let db: Database;
let s3: FixtureServer;

function seed(): void {
  db.prepare(
    `INSERT INTO datasets (dataset_id, name, owner_user_id, status, visibility, is_sandbox, archive_status, archive_size)
     VALUES (?, ?, 1, 'active', 'public', 0, 'ready', 123456)`,
  ).run(DATASET, DATASET);
  for (const [version, createdAt] of [
    ["1.0.0", "2026-03-14 12:20:43"],
    ["1.0.1", "2026-04-04 06:05:15"], // latest
  ] as const) {
    db.prepare(
      `INSERT INTO dataset_versions (dataset_id, version, doi, provider, created_at)
       VALUES (?, ?, ?, 'ezid', ?)`,
    ).run(DATASET, version, `10.5072/FK2${DATASET}${version}`, createdAt);
  }
}

beforeEach(() => {
  db = freshDb();
  s3 = startFixtureServer();
  seed();
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

interface BundleArchive {
  status: string | null;
  size: number | null;
  skip_reason: string | null;
}
interface BundleBody {
  version: string | null;
  landing: { ok: boolean; data?: { archive: BundleArchive } };
}

async function getBundle(versionQuery?: string): Promise<BundleBody> {
  const path = versionQuery
    ? `/${DATASET}/page-bundle.json?v=${versionQuery}`
    : `/${DATASET}/page-bundle.json`;
  const res = await app().request(`https://data.nemar.org${path}`, {}, env());
  expect(res.status).toBe(200);
  return (await res.json()) as BundleBody;
}

describe("#1518: page-bundle.json archive field only describes the latest version", () => {
  test("default (no ?v=) resolves to latest and keeps the real archive state", async () => {
    const body = await getBundle();
    expect(body.version).toBe("1.0.1");
    expect(body.landing.ok).toBe(true);
    expect(body.landing.data?.archive).toEqual({
      status: "ready",
      size: 123456,
      skip_reason: null,
    });
  });

  test("?v=<latest> keeps the real archive state", async () => {
    const body = await getBundle("v1.0.1");
    expect(body.version).toBe("1.0.1");
    expect(body.landing.data?.archive).toEqual({
      status: "ready",
      size: 123456,
      skip_reason: null,
    });
  });

  test("?v=<older> overrides to a no-archive note instead of leaking the latest build's ready state", async () => {
    const body = await getBundle("v1.0.0");
    expect(body.version).toBe("1.0.0");
    const archive = body.landing.data?.archive;
    expect(archive?.status).toBeNull();
    expect(archive?.size).toBeNull();
    expect(archive?.skip_reason).toContain("v1.0.1");
    expect(archive?.skip_reason).toContain("download files directly");
  });
});
