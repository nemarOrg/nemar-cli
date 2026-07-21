/**
 * Dataset-ID sandbox partition tests (epic #923, phase 1 / #930).
 *
 * Verifies the xx-range partition that keeps dev/test-created sandbox datasets
 * (xx090001-xx099999) from colliding with prod-created ones (xx000001-xx089999)
 * in the shared nemarDatasets GitHub org, plus the isDevRangeDatasetId helper the
 * prod webhook receiver uses to refuse dispatching against staging repos.
 *
 * Real in-memory SQLite via the shared realD1 helper (no mocks); every result
 * comes from SQLite executing the production allocation SQL against the full
 * migrated schema.
 */

import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
  DEV_SANDBOX_RANGE_RE,
  generateDatasetId,
  isDevRangeDatasetId,
} from "../src/services/datasetId";
import { freshDb, realD1 } from "./helpers/d1";

function seedIds(db: Database, ids: string[]): void {
  const stmt = db.query(
    "INSERT INTO datasets (dataset_id, name, owner_user_id) VALUES (?, 'test', 1)",
  );
  for (const id of ids) stmt.run(id);
}

describe("isDevRangeDatasetId / DEV_SANDBOX_RANGE_RE", () => {
  test("matches the dev/test band xx090000-xx099999", () => {
    expect(isDevRangeDatasetId("xx090000")).toBe(true);
    expect(isDevRangeDatasetId("xx090001")).toBe(true);
    expect(isDevRangeDatasetId("xx099900")).toBe(true); // exemplar sub-band
    expect(isDevRangeDatasetId("xx099999")).toBe(true);
  });

  test("rejects the prod sandbox band and other prefixes", () => {
    expect(isDevRangeDatasetId("xx089999")).toBe(false); // prod ceiling
    expect(isDevRangeDatasetId("xx000001")).toBe(false);
    expect(isDevRangeDatasetId("nm090000")).toBe(false);
    expect(isDevRangeDatasetId("on090000")).toBe(false);
    expect(isDevRangeDatasetId("xx900001")).toBe(false); // out-of-cap, xx90.. not xx09..
    expect(isDevRangeDatasetId("")).toBe(false);
  });

  test("the regex and helper agree on the exact boundary", () => {
    // xx089999 -> prod, xx090000 -> dev: the two adjacent numbers straddle the line.
    expect(DEV_SANDBOX_RANGE_RE.test("xx089999")).toBe(false);
    expect(DEV_SANDBOX_RANGE_RE.test("xx090000")).toBe(true);
  });
});

describe("generateDatasetId sandbox partition", () => {
  test("dev floor allocates from xx090001 on an empty DB", async () => {
    const db = realD1(freshDb());
    const id = await generateDatasetId(db, true, { sandboxIdFloor: 90001 });
    expect(id).toBe("xx090001");
    expect(isDevRangeDatasetId(id)).toBe(true);
  });

  test("prod sandbox (no floor, ceiling 89999) still allocates low", async () => {
    const db = realD1(freshDb());
    const id = await generateDatasetId(db, true, { sandboxIdCeiling: 89999 });
    expect(id).toBe("xx000001");
    expect(isDevRangeDatasetId(id)).toBe(false);
  });

  test("dev floor skips pre-existing low (legacy) xx rows, no reuse below floor", async () => {
    const raw = freshDb();
    seedIds(raw, ["xx000001", "xx000002"]); // legacy dev-era low ids
    const id = await generateDatasetId(realD1(raw), true, { sandboxIdFloor: 90001 });
    expect(id).toBe("xx090001"); // does NOT gap-fill xx000003
  });

  test("gap-fills within the floored range", async () => {
    const raw = freshDb();
    seedIds(raw, ["xx090001", "xx090003"]); // gap at 90002
    const id = await generateDatasetId(realD1(raw), true, { sandboxIdFloor: 90001 });
    expect(id).toBe("xx090002");
  });

  test("advances past contiguous floored ids", async () => {
    const raw = freshDb();
    seedIds(raw, ["xx090001", "xx090002"]);
    const id = await generateDatasetId(realD1(raw), true, { sandboxIdFloor: 90001 });
    expect(id).toBe("xx090003");
  });

  test("throws with the effective range when a narrow band is exhausted", async () => {
    const raw = freshDb();
    seedIds(raw, ["xx090001", "xx090002"]);
    await expect(
      generateDatasetId(realD1(raw), true, { sandboxIdFloor: 90001, sandboxIdCeiling: 90002 }),
    ).rejects.toThrow(/90001 to 90002/);
  });

  test("nm allocation ignores sandbox range opts", async () => {
    const db = realD1(freshDb());
    const id = await generateDatasetId(db, false, {
      sandboxIdFloor: 90001,
      sandboxIdCeiling: 90002,
    });
    expect(id).toBe("nm000108"); // START_NUMBER.nm, unaffected
  });

  test("bad/absent range strings do not corrupt allocation (clamped)", async () => {
    const db = realD1(freshDb());
    // Undefined bounds -> full xx range, starts at xx000001.
    const id = await generateDatasetId(db, true, {});
    expect(id).toBe("xx000001");
  });

  test("non-finite bounds are treated as absent at the function layer", async () => {
    // Pins the resolveRange guarantee independent of upload.ts's parseRangeBound:
    // NaN/Infinity floor must NOT disable the lower bound; it falls back to the
    // natural xx start (1), so allocation stays inside the valid id range.
    const db1 = realD1(freshDb());
    expect(await generateDatasetId(db1, true, { sandboxIdFloor: Number.NaN })).toBe("xx000001");
    const db2 = realD1(freshDb());
    expect(
      await generateDatasetId(db2, true, {
        sandboxIdFloor: Number.POSITIVE_INFINITY,
        sandboxIdCeiling: Number.NaN,
      }),
    ).toBe("xx000001");
  });
});
