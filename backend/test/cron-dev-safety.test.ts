/**
 * Dev/staging cron safety tests (epic #923, Phase 7 / #930).
 *
 * Phase 7 enables a daily cron on the dev/staging worker for the first time.
 * That worker's D1 is a partial PRODUCTION MIRROR (real nm* dataset rows, real
 * user email addresses) and the worker holds a live RESEND_API_KEY, so the
 * daily job set has to be narrowed before the trigger is safe to add.
 *
 * These tests pin the two guarantees that keep it safe:
 *   1. Outside production the sandbox cleanup only ever selects ids in the dev
 *      EPHEMERAL band (xx090001-xx099899), never the curated exemplar fleet
 *      (xx099900+), never prod's sandbox band, never a real nm/on/ds row. This
 *      matters because deleteDatasetCascade's GitHub half is NOT env-scoped: a
 *      stray match deletes a real nemarDatasets repository.
 *   2. archiveRetrySweep and reconcileReservedVersionDois refuse to run outside
 *      production even when called directly, so the guarantee does not depend on
 *      the cron's allowlist being the only caller.
 *
 * The band test runs the ACTUAL cleanup SQL from index.ts against real
 * in-memory SQLite with the full migrated schema (no mocks): if the query in
 * index.ts changes, this test has to change with it.
 */

import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
// The queries are imported from the production module, NOT retyped here, so a
// change to the real SQL cannot silently leave this test asserting stale text.
import {
  NON_PROD_SANDBOX_CLEANUP_QUERY as NON_PROD_SANDBOX_QUERY,
  PROD_SANDBOX_CLEANUP_QUERY as PROD_SANDBOX_QUERY,
} from "../src/index";
import { archiveRetrySweep } from "../src/services/archive-retry";
import {
  DEV_EPHEMERAL_BAND_END,
  DEV_EPHEMERAL_BAND_START,
  isDevEphemeralSandboxId,
} from "../src/services/datasetId";
import { reconcileReservedVersionDois } from "../src/services/doi-reconcile";
import { sweepBlockedBidsValidationRequests } from "../src/services/publication-sweep";
import type { Bindings } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

/** Seed an aged, active dataset row (old enough to be a cleanup candidate). */
function seedAged(db: Database, ids: string[], isExemplar = 0): void {
  const stmt = db.query(
    `INSERT INTO datasets (dataset_id, name, owner_user_id, status, is_exemplar, created_at)
     VALUES (?, 'test', 1, 'active', ?, datetime('now', '-30 days'))`,
  );
  for (const id of ids) stmt.run(id, isExemplar);
}

describe("isDevEphemeralSandboxId", () => {
  test("accepts the ephemeral band only", () => {
    expect(isDevEphemeralSandboxId("xx090001")).toBe(true); // floor
    expect(isDevEphemeralSandboxId("xx095000")).toBe(true);
    expect(isDevEphemeralSandboxId("xx099899")).toBe(true); // last before exemplars
  });

  test("rejects the exemplar fleet band", () => {
    expect(isDevEphemeralSandboxId("xx099900")).toBe(false); // first exemplar
    expect(isDevEphemeralSandboxId("xx099950")).toBe(false);
    expect(isDevEphemeralSandboxId("xx099999")).toBe(false); // last exemplar
  });

  test("rejects prod's sandbox band and the dev floor boundary", () => {
    expect(isDevEphemeralSandboxId("xx090000")).toBe(false); // below floor
    expect(isDevEphemeralSandboxId("xx089999")).toBe(false); // prod ceiling
    expect(isDevEphemeralSandboxId("xx000001")).toBe(false);
  });

  test("rejects non-sandbox prefixes", () => {
    expect(isDevEphemeralSandboxId("nm090001")).toBe(false);
    expect(isDevEphemeralSandboxId("on090001")).toBe(false);
    expect(isDevEphemeralSandboxId("ds090001")).toBe(false);
  });

  test("band constants are half-open and ordered", () => {
    expect(DEV_EPHEMERAL_BAND_START < DEV_EPHEMERAL_BAND_END).toBe(true);
    expect(isDevEphemeralSandboxId(DEV_EPHEMERAL_BAND_START)).toBe(true);
    expect(isDevEphemeralSandboxId(DEV_EPHEMERAL_BAND_END)).toBe(false);
  });
});

describe("non-production sandbox cleanup query", () => {
  test("selects only ephemeral-band ids, sparing exemplars and real datasets", async () => {
    const db = freshDb();
    seedAged(db, [
      "xx090001", // ephemeral, deletable
      "xx095555", // ephemeral, deletable
      "xx099899", // ephemeral, deletable (last)
      "xx089999", // prod sandbox band, must survive
      "xx000042", // prod sandbox band, must survive
    ]);
    seedAged(db, ["xx099900", "xx099906"], 1); // exemplar fleet, must survive
    // The rows that make the dev D1 dangerous: real production datasets.
    seedAged(db, ["nm000155", "on003805", "ds000117"]);

    const rows = await realD1(db)
      .prepare(NON_PROD_SANDBOX_QUERY)
      .bind(DEV_EPHEMERAL_BAND_START, DEV_EPHEMERAL_BAND_END, 10)
      .all<{ dataset_id: string }>();

    expect(rows.results.map((r) => r.dataset_id).sort()).toEqual([
      "xx090001",
      "xx095555",
      "xx099899",
    ]);
  });

  test("spares an exemplar even if its is_exemplar flag were cleared", async () => {
    // Belt and suspenders: the band alone must exclude the fleet, so a bad
    // is_exemplar write cannot make a curated exemplar deletable.
    const db = freshDb();
    seedAged(db, ["xx099900", "xx099999"], 0);

    const rows = await realD1(db)
      .prepare(NON_PROD_SANDBOX_QUERY)
      .bind(DEV_EPHEMERAL_BAND_START, DEV_EPHEMERAL_BAND_END, 10)
      .all<{ dataset_id: string }>();

    expect(rows.results).toEqual([]);
  });

  test("production query still sweeps the whole xx space", async () => {
    // The narrowing must be non-production only; prod keeps its 14-day sweep
    // across xx000001-xx089999 (prod never has exemplar rows).
    const db = freshDb();
    seedAged(db, ["xx000042", "xx089999"]);

    const rows = await realD1(db)
      .prepare(PROD_SANDBOX_QUERY)
      .bind(10)
      .all<{ dataset_id: string }>();

    expect(rows.results.map((r) => r.dataset_id).sort()).toEqual(["xx000042", "xx089999"]);
  });
});

describe("production-only daily jobs are environment-gated", () => {
  // Both jobs swallow their own query errors, so "resolved without throwing" is
  // NOT evidence the guard fired. Observe whether D1 was reached at all.
  function probe(): { db: D1Database; touched: () => boolean } {
    let reached = false;
    const db = {
      prepare() {
        reached = true;
        throw new Error("probe: candidate query reached");
      },
    } as unknown as D1Database;
    return { db, touched: () => reached };
  }

  // Recognized non-production values: the job must not touch D1 at all.
  for (const environment of ["development", "staging", "test"]) {
    test(`archiveRetrySweep never queries D1 when ENVIRONMENT=${environment}`, async () => {
      const p = probe();
      await archiveRetrySweep({ ENVIRONMENT: environment, DB: p.db } as unknown as Bindings);
      expect(p.touched()).toBe(false);
    });

    test(`reconcileReservedVersionDois never queries D1 when ENVIRONMENT=${environment}`, async () => {
      const p = probe();
      await reconcileReservedVersionDois({
        ENVIRONMENT: environment,
        DB: p.db,
      } as unknown as Bindings);
      expect(p.touched()).toBe(false);
    });

    // Its candidate query also has no dataset-id prefix filter, so on the
    // prod-mirror D1 it would read real repos through the shared nemarDatasets
    // token and rewrite real publication_requests rows.
    test(`sweepBlockedBidsValidationRequests never queries D1 when ENVIRONMENT=${environment}`, async () => {
      const p = probe();
      const r = await sweepBlockedBidsValidationRequests({
        ENVIRONMENT: environment,
        DB: p.db,
      } as unknown as Bindings);
      expect(p.touched()).toBe(false);
      expect(r).toEqual({ scanned: 0, unblocked: 0, reblocked: 0, errors: 0 });
    });
  }

  // isNonProductionEnv is an allow-list and fails CLOSED: production, and any
  // unset/unrecognized value, are treated as production so these backstops keep
  // running rather than silently disabling themselves on a config typo.
  for (const environment of ["production", "", undefined, "prod", "Production"]) {
    test(`archiveRetrySweep still runs when ENVIRONMENT=${JSON.stringify(environment)}`, async () => {
      const p = probe();
      await archiveRetrySweep({ ENVIRONMENT: environment, DB: p.db } as unknown as Bindings);
      expect(p.touched()).toBe(true);
    });

    test(`reconcileReservedVersionDois still runs when ENVIRONMENT=${JSON.stringify(environment)}`, async () => {
      const p = probe();
      await reconcileReservedVersionDois({
        ENVIRONMENT: environment,
        DB: p.db,
      } as unknown as Bindings);
      expect(p.touched()).toBe(true);
    });

    test(`sweepBlockedBidsValidationRequests still runs when ENVIRONMENT=${JSON.stringify(environment)}`, async () => {
      const p = probe();
      await sweepBlockedBidsValidationRequests({
        ENVIRONMENT: environment,
        DB: p.db,
      } as unknown as Bindings);
      expect(p.touched()).toBe(true);
    });
  }
});
