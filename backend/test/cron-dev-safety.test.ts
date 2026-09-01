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
 *   3. The blocked-publication sweep is SCOPED rather than disabled outside
 *      production: staging needs it (an exemplar published while its BIDS
 *      validation is still running lands in 'blocked' and would otherwise stay
 *      stuck), so it narrows to the dev range instead of skipping.
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
import { deleteDatasetCascade } from "../src/services/deletion";
import { reconcileReservedVersionDois } from "../src/services/doi-reconcile";
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
  }
});

describe("prod-safety gates use the fail-closed helper, not a literal comparison", () => {
  // `ENVIRONMENT === "production"` is true ONLY for that exact string, so an
  // unset/blank/typo'd binding silently turns the gate off. `isNonProductionEnv`
  // is an allow-list that treats anything unrecognized AS production, so the
  // same drift leaves the gate on. Both files below guard something that must
  // still happen when the env var goes missing: the exemplar-leak alarm (the
  // only environment-aware backstop behind the env-blind visibility carve-outs)
  // and the prod webhook dev-range short-circuit. A structural pin, matching
  // this repo's admin-route-inventory / api-export-surface convention.
  // Extended in #1167: the three sweep services gained their own
  // isNonProductionEnv guards (issue #1166), so they are now exactly the
  // kind of file this pin exists for. They were clean when added; this
  // keeps them that way.
  const FILES = [
    "../src/index.ts",
    "../src/routes/webhooks/github.ts",
    "../src/services/availability-report.ts",
    "../src/services/recording-stats-sweep.ts",
    "../src/services/signal-defaults-sweep.ts",
  ];

  for (const rel of FILES) {
    test(`${rel} has no raw ENVIRONMENT === "production" gate`, async () => {
      const src = await Bun.file(new URL(rel, import.meta.url)).text();
      const offenders = src
        .split("\n")
        .map((line, i) => ({ line: line.trim(), n: i + 1 }))
        // Skip comments: the fixed sites deliberately NAME the rejected pattern
        // in a comment explaining why the helper is used instead.
        .filter(({ line }) => !line.startsWith("//") && !line.startsWith("*"))
        .filter(({ line }) => /ENVIRONMENT\s*===\s*["']production["']/.test(line));
      expect(offenders).toEqual([]);
    });
  }
});

describe("deleteDatasetCascade prod-repo fence", () => {
  // The cascade's GitHub half is NOT environment-scoped: it always deletes
  // nemarDatasets/<id>. The manual delete endpoints (admin delete-dataset,
  // bulk-delete, draft delete, import rollback) all funnel through here, and
  // dev's D1 is a prod mirror, so without this fence deleting a real id from
  // the dev worker would destroy the real repository.
  const env = (environment: string) =>
    ({ ENVIRONMENT: environment, DB: {}, S3_BUCKET: "nemar-dev" }) as unknown as Bindings;

  for (const id of ["nm000103", "nm000155", "on003805", "xx000042", "xx089999"]) {
    test(`refuses ${id} on a non-production worker`, async () => {
      await expect(deleteDatasetCascade({} as D1Database, env("development"), id)).rejects.toThrow(
        /non-production worker/,
      );
    });
  }

  test("refuses before touching GitHub, S3 or D1", async () => {
    // The throw must precede every side effect; a D1 that explodes on use
    // proves nothing ran before the guard.
    const explodes = {
      prepare() {
        throw new Error("must not be reached");
      },
    } as unknown as D1Database;
    await expect(deleteDatasetCascade(explodes, env("development"), "nm000103")).rejects.toThrow(
      /non-production worker/,
    );
  });

  test("allows dev-range ids off-prod (the exemplar reset path)", async () => {
    // Must NOT throw the fence error. It fails later on the stub D1/GitHub,
    // which is fine: we only assert the fence let it through.
    const explodes = {
      prepare() {
        throw new Error("reached-d1");
      },
    } as unknown as D1Database;
    await expect(
      deleteDatasetCascade(explodes, env("development"), "xx099900"),
    ).rejects.not.toThrow(/non-production worker/);
  });
});

describe("blocked publication sweep scopes by dataset range, not by skipping", () => {
  // This sweep must keep working on staging (an exemplar published while its
  // BIDS validation is still running lands in 'blocked' and would otherwise
  // stay stuck), while never touching the real datasets in the prod-mirror D1.
  function seedBlocked(db: Database, ids: string[]): void {
    const ds = db.query(
      "INSERT INTO datasets (dataset_id, name, owner_user_id, github_repo) VALUES (?, 'test', 1, ?)",
    );
    const pr = db.query(
      "INSERT INTO publication_requests (dataset_id, status, block_reason, requested_by) VALUES (?, 'blocked', 'bids_validation_pending', 1)",
    );
    for (const id of ids) {
      ds.run(id, `nemarDatasets/${id}`);
      pr.run(id);
    }
  }

  /** The candidate query as built for each environment (see publication-sweep.ts). */
  function candidateQuery(devRangeOnly: boolean): string {
    return `SELECT pr.dataset_id
              FROM publication_requests pr
              JOIN datasets d ON d.dataset_id = pr.dataset_id
             WHERE pr.status = 'blocked'
               AND pr.block_reason IN ('bids_validation_pending')
               ${devRangeOnly ? "AND pr.dataset_id LIKE 'xx09%'" : ""}
             ORDER BY pr.updated_at ASC`;
  }

  test("non-production sees only dev-range requests", async () => {
    const db = freshDb();
    seedBlocked(db, ["xx099900", "xx090001", "nm000155", "on003805"]);

    const rows = await realD1(db)
      .prepare(candidateQuery(true))
      .bind()
      .all<{ dataset_id: string }>();

    expect(rows.results.map((r) => r.dataset_id).sort()).toEqual(["xx090001", "xx099900"]);
  });

  test("production still sees every blocked request", async () => {
    const db = freshDb();
    seedBlocked(db, ["xx099900", "nm000155", "on003805"]);

    const rows = await realD1(db)
      .prepare(candidateQuery(false))
      .bind()
      .all<{ dataset_id: string }>();

    expect(rows.results.map((r) => r.dataset_id).sort()).toEqual([
      "nm000155",
      "on003805",
      "xx099900",
    ]);
  });
});
