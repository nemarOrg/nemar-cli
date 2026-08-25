/**
 * Real-entry-point coverage for the five signal_defaults columns' D1 SELECT
 * on the two HTTP handlers that build `row` for `buildDatasetMetadata`
 * (#1162 PR review, I6).
 *
 * Before this file, every `signal_defaults` test drove `buildDatasetMetadata`
 * with a hand-built row object -- never a real D1 read. Deleting
 * `sampling_frequency` from either handler's `SELECT` column list left the
 * full backend suite green (`undefined` still passes the `!== null` gate in
 * `buildDatasetMetadata`'s gate, so the field would silently ship as
 * `undefined` rather than an honest `null`). This drives the REAL
 * `dataRoutes` Hono router -- `GET /:id/metadata.json` (routes/data.ts) and
 * `GET /:id/page-bundle.json` (services/page-bundle.ts via routes/data.ts)
 * -- against a real D1 (bun:sqlite behind realD1), with zero network calls
 * (the seeded dataset has no `dataset_versions` row, so neither handler
 * reaches S3).
 *
 * Deliberately narrow (`.rules/testing.md`'s "supplement, never the
 * coverage" cuts both ways: a full route suite is out of scope here, see
 * the review) -- this exists ONLY to prove the five-column SELECT actually
 * reaches the wire on both real handlers, not to re-cover
 * `buildDatasetMetadata`'s own gating logic (already covered in
 * test/data-route.unit.test.ts).
 */

import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { dataRoutes } from "../src/routes/data";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

function seedPublicDataset(db: Database, id: string): void {
  db.prepare(
    `INSERT INTO datasets
       (dataset_id, name, owner_user_id, status, visibility, is_sandbox,
        sampling_frequency, power_line_frequency, eeg_reference,
        placement_scheme, electrode_system)
     VALUES (?, ?, 1, 'active', 'public', 0, ?, ?, ?, ?, ?)`,
  ).run(id, id, 500, 60, "average", "extended 10-10% system", "10-20");
}

function appWithRealD1(db: Database): { app: Hono<{ Bindings: Bindings; Variables: Variables }> } {
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/", dataRoutes);
  return { app };
}

function env(db: Database): Bindings {
  return { DB: realD1(db), ENVIRONMENT: "test" } as Bindings;
}

describe("GET /:id/metadata.json real-D1 entry point: signal_defaults columns arrive (#1162 review, I6)", () => {
  test("the five seeded columns are present in the real JSON response", async () => {
    const db = freshDb();
    seedPublicDataset(db, "nm000850");
    const { app } = appWithRealD1(db);

    const res = await app.request("/nm000850/metadata.json", {}, env(db));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { signal_defaults: Record<string, unknown> | null };

    expect(body.signal_defaults).not.toBeNull();
    expect(body.signal_defaults?.sampling_frequency).toBe(500);
    expect(body.signal_defaults?.power_line_frequency).toBe(60);
    expect(body.signal_defaults?.reference).toBe("average");
    expect(body.signal_defaults?.placement_scheme).toBe("extended 10-10% system");
    expect(body.signal_defaults?.channel_system).toBe("10-20");
    db.close();
  });

  test("a dataset with none of the five columns set serves signal_defaults: null through the real route", async () => {
    const db = freshDb();
    db.prepare(
      `INSERT INTO datasets (dataset_id, name, owner_user_id, status, visibility, is_sandbox)
       VALUES ('nm000851', 'nm000851', 1, 'active', 'public', 0)`,
    ).run();
    const { app } = appWithRealD1(db);

    const res = await app.request("/nm000851/metadata.json", {}, env(db));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { signal_defaults: unknown };
    expect(body.signal_defaults).toBeNull();
    db.close();
  });
});

describe("GET /:id/page-bundle.json real-D1 entry point: signal_defaults columns arrive (#1162 review, I6)", () => {
  test("the five seeded columns are present in the real JSON response's metadata.data", async () => {
    const db = freshDb();
    seedPublicDataset(db, "nm000852");
    const { app } = appWithRealD1(db);

    const res = await app.request("/nm000852/page-bundle.json", {}, env(db));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      metadata: { ok: boolean; data?: { signal_defaults: Record<string, unknown> | null } };
    };

    expect(body.metadata.ok).toBe(true);
    const signalDefaults = body.metadata.data?.signal_defaults;
    expect(signalDefaults).not.toBeNull();
    expect(signalDefaults?.sampling_frequency).toBe(500);
    expect(signalDefaults?.power_line_frequency).toBe(60);
    expect(signalDefaults?.reference).toBe("average");
    expect(signalDefaults?.placement_scheme).toBe("extended 10-10% system");
    expect(signalDefaults?.channel_system).toBe("10-20");
    db.close();
  });
});
