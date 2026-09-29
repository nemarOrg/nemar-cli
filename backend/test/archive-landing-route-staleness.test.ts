/**
 * The data-plane landing route (`GET /<id>`, `routes/data.ts`) does not
 * advertise a 'ready' archive that predates the dataset's current latest
 * version (#1514, the nm000284 incident: v1.0.0's zip marked ready, then
 * v1.0.1 published, and the page kept advertising a "ready" download that
 * 404'd on click).
 *
 * `buildLandingPayload`'s own staleness logic is covered purely in
 * `landing-payload-archive.test.ts`; this test exercises the ENTRY POINT
 * (`loadPublishedDataset` -> `buildLandingPayload`) end to end against real
 * D1, so a wiring mistake in `data.ts` (e.g. forgetting to pass
 * `archive_checked_at` through) fails here even though the pure function
 * would still pass on its own.
 */

import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { dataRoutes } from "../src/routes/data";
import type { Bindings } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

function seedUser(db: Database): void {
  db.prepare(
    `INSERT INTO users (id, username, email, github_username, status)
     VALUES (1, 'alice', 'alice@nemar.org', 'alice', 'approved')`,
  ).run();
}

function seedDataset(db: Database, datasetId: string): void {
  db.prepare(
    `INSERT INTO datasets (dataset_id, owner_user_id, name, visibility, is_sandbox)
     VALUES (?, 1, ?, 'public', 0)`,
  ).run(datasetId, datasetId);
}

function seedVersion(db: Database, datasetId: string, version: string, createdAt: string): void {
  db.prepare(
    `INSERT INTO dataset_versions (dataset_id, version, doi, provider, created_at)
     VALUES (?, ?, ?, 'ezid', ?)`,
  ).run(datasetId, version, `10.82901/nemar.${datasetId}.v${version}`, createdAt);
}

function markArchiveReady(db: Database, datasetId: string, size: number, checkedAt: string): void {
  db.prepare(
    `UPDATE datasets
        SET archive_status = 'ready', archive_size = ?,
            sweep_stamps = json_set(COALESCE(sweep_stamps, '{}'), '$.archive_checked_at', ?)
      WHERE dataset_id = ?`,
  ).run(size, checkedAt, datasetId);
}

interface LandingJson {
  archive: { status: string | null; size: number | null; skip_reason: string | null };
}

async function getLandingJson(db: Database, datasetId: string): Promise<LandingJson> {
  const req = new Request(`http://localhost/${datasetId}`, {
    headers: { Accept: "application/json" },
  });
  const res = await dataRoutes.fetch(req, { DB: realD1(db) } as Bindings);
  expect(res.status).toBe(200);
  return (await res.json()) as LandingJson;
}

describe("GET /<id>: a stale 'ready' archive is not advertised for a newer version", () => {
  test("v1.0.0 ready, then v1.0.1 published before its own archive completes: hidden", async () => {
    const db = freshDb();
    seedUser(db);
    seedDataset(db, "nm000284");
    seedVersion(db, "nm000284", "1.0.0", "2026-01-01 00:00:00");
    // v1.0.0's build completes and is marked ready.
    markArchiveReady(db, "nm000284", 345_096_030_514, "2026-01-01 01:00:00");

    // Confirm it's advertised for v1.0.0 alone, before v1.0.1 exists.
    const beforeNewVersion = await getLandingJson(db, "nm000284");
    expect(beforeNewVersion.archive.status).toBe("ready");

    // v1.0.1 is published (dataset_versions row created), but its own
    // archive build hasn't reported back yet -- exactly the nm000284 window.
    seedVersion(db, "nm000284", "1.0.1", "2026-09-28 19:43:14");

    const afterNewVersion = await getLandingJson(db, "nm000284");
    expect(afterNewVersion.archive.status).toBeNull();
    expect(afterNewVersion.archive.size).toBeNull();
  });

  test("once v1.0.1's own archive reports ready, it is advertised again", async () => {
    const db = freshDb();
    seedUser(db);
    seedDataset(db, "nm000284");
    seedVersion(db, "nm000284", "1.0.0", "2026-01-01 00:00:00");
    markArchiveReady(db, "nm000284", 345_096_030_514, "2026-01-01 01:00:00");
    seedVersion(db, "nm000284", "1.0.1", "2026-09-28 19:43:14");

    // v1.0.1's build finishes AFTER its own version row landed.
    markArchiveReady(db, "nm000284", 400_000_000_000, "2026-09-28 20:30:00");

    const landing = await getLandingJson(db, "nm000284");
    expect(landing.archive.status).toBe("ready");
    expect(landing.archive.size).toBe(400_000_000_000);
  });

  test("a single-version dataset's ready archive is unaffected", async () => {
    const db = freshDb();
    seedUser(db);
    seedDataset(db, "nm000001");
    seedVersion(db, "nm000001", "1.0.0", "2026-01-01 00:00:00");
    markArchiveReady(db, "nm000001", 1024, "2026-01-02 00:00:00");

    const landing = await getLandingJson(db, "nm000001");
    expect(landing.archive.status).toBe("ready");
  });
});
