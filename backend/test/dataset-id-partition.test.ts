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
  DEV_EPHEMERAL_BAND_END,
  DEV_SANDBOX_RANGE_RE,
  generateDatasetId,
  isDevEphemeralSandboxId,
  isDevRangeDatasetId,
  isReservedFixtureId,
  isValidDatasetId,
  RESERVED_FIXTURE_FLOOR,
} from "../src/services/datasetId";
import { freshDb, realD1 } from "./helpers/d1";

function seedIds(db: Database, ids: string[]): void {
  const stmt = db.query(
    "INSERT INTO datasets (dataset_id, name, owner_user_id) VALUES (?, 'test', 1)",
  );
  for (const id of ids) stmt.run(id);
}

/**
 * Seed every id in [from, to] for a prefix, inclusive, in one statement.
 *
 * Exists so the allocator can be tested against a FULL band. The reserved-band
 * tests below are the only ones that need it, and they need it for the reason
 * the reservation exists: a band is only crossed when everything below it is
 * gone, so a test that seeds a handful of rows never reaches the boundary it
 * claims to be testing.
 */
function seedRange(db: Database, prefix: string, from: number, to: number): void {
  db.run(
    `INSERT INTO datasets (dataset_id, name, owner_user_id)
     WITH RECURSIVE n(x) AS (SELECT ? UNION ALL SELECT x + 1 FROM n WHERE x < ?)
     SELECT ? || substr('000000' || x, -6), 'test', 1 FROM n`,
    [from, to, prefix],
  );
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

describe("isReservedFixtureId", () => {
  test("the boundary is exact for both reserving prefixes", () => {
    expect(isReservedFixtureId("nm099899")).toBe(false);
    expect(isReservedFixtureId("nm099900")).toBe(true);
    expect(isReservedFixtureId("nm099998")).toBe(true); // the anonymous deposit
    expect(isReservedFixtureId("nm099999")).toBe(true); // the e2e dataset
    expect(isReservedFixtureId("xx099899")).toBe(false);
    expect(isReservedFixtureId("xx099900")).toBe(true); // the exemplar fleet
  });

  test("on is not a reserving prefix: its ids are mirrored, never allocated", () => {
    expect(isReservedFixtureId("on099900")).toBe(false);
    expect(isReservedFixtureId("on099999")).toBe(false);
  });

  test("an invalid id is not reserved, whatever its digits", () => {
    expect(isReservedFixtureId("nm100000")).toBe(false); // over the validity cap
    expect(isReservedFixtureId("zz099900")).toBe(false);
    expect(isReservedFixtureId("nm99900")).toBe(false); // 5 digits
    expect(isReservedFixtureId("")).toBe(false);
  });

  test("reserved means not ALLOCATABLE, not invalid (ADR 0068)", () => {
    // Routes must still serve these ids; only generateDatasetId is bound.
    expect(isValidDatasetId("nm099998")).toBe(true);
    expect(isValidDatasetId("nm099999")).toBe(true);
    expect(isValidDatasetId("xx099907")).toBe(true);
  });

  test("the cleanup cron's boundary IS the allocator's boundary", () => {
    // DEV_EPHEMERAL_BAND_END is derived from RESERVED_FIXTURE_FLOOR. Pinned as a
    // literal here so the derivation cannot quietly change what the dev cleanup
    // cron is allowed to delete.
    expect(DEV_EPHEMERAL_BAND_END).toBe("xx099900");
    expect(RESERVED_FIXTURE_FLOOR).toBe(99900);
    expect(isDevEphemeralSandboxId("xx099899")).toBe(true);
    expect(isDevEphemeralSandboxId("xx099900")).toBe(false);
  });
});

describe("generateDatasetId reserved fixture band (ADR 0068)", () => {
  test("nm exhausts at 99899 rather than minting a fixture id", async () => {
    // The whole allocatable nm band is taken and the reserved band is EMPTY,
    // which is the shape production is in today: 203 nm rows and no nm099900+
    // except nm099999. Before the reservation this call returned nm099900.
    const raw = freshDb();
    seedRange(raw, "nm", 108, 99899);
    await expect(generateDatasetId(realD1(raw), false)).rejects.toThrow(/108 to 99899/);
  });

  test("the exhaustion error names the reservation, not just the ceiling", async () => {
    const raw = freshDb();
    seedRange(raw, "nm", 108, 99899);
    // A caller told "all IDs from 108 to 99899 are allocated" with no further
    // explanation would reasonably conclude the cap is a bug, since MAX_NUMBER
    // is 99999. The clause is what stops someone from "fixing" it.
    await expect(generateDatasetId(realD1(raw), false)).rejects.toThrow(
      /nm099900-nm099999 is the reserved fixture band/,
    );
  });

  test("nm still allocates normally one id below the band", async () => {
    const raw = freshDb();
    seedRange(raw, "nm", 108, 99898);
    expect(await generateDatasetId(realD1(raw), false)).toBe("nm099899");
  });

  test("dev xx (floor 90001, NO ceiling) stops below the exemplar fleet", async () => {
    // The live dev configuration: SANDBOX_ID_FLOOR=90001 and no
    // SANDBOX_ID_CEILING, so the window was [90001, 99999] and ran straight
    // through the fleet. Seeding the last two allocatable ids makes the old
    // behavior return xx099900, which is a real exemplar.
    const raw = freshDb();
    seedRange(raw, "xx", 99898, 99899);
    await expect(
      generateDatasetId(realD1(raw), true, { sandboxIdFloor: 99898 }),
    ).rejects.toThrow(/xx099900-xx099999 is the reserved fixture band/);
  });

  test("dev xx still allocates the last id below the fleet", async () => {
    const raw = freshDb();
    seedRange(raw, "xx", 99898, 99898);
    expect(await generateDatasetId(realD1(raw), true, { sandboxIdFloor: 99898 })).toBe("xx099899");
  });

  test("an explicit ceiling inside the band cannot raise the cap", async () => {
    // resolveRange takes the MINIMUM of the caller's ceiling and the reserved
    // cap, so a caller cannot opt back into the band by asking for it.
    const raw = freshDb();
    seedRange(raw, "xx", 99898, 99899);
    await expect(
      generateDatasetId(realD1(raw), true, { sandboxIdFloor: 99898, sandboxIdCeiling: 99999 }),
    ).rejects.toThrow(/99898 to 99899/);
  });

  test("an existing fixture row does not drag allocation into the band", async () => {
    // What EXCLUDED_IDS was there for: nm099999 contributes candidate 100000,
    // and its neighbors contribute candidates inside the band. None may win.
    const raw = freshDb();
    seedIds(raw, ["nm099998", "nm099999"]);
    const id = await generateDatasetId(realD1(raw), false);
    expect(id).toBe("nm000108");
    expect(isReservedFixtureId(id)).toBe(false);
  });

  test("the fleet's own ids do not open the band to the allocator", async () => {
    const raw = freshDb();
    seedIds(raw, ["xx099900", "xx099901", "xx099907"]);
    const id = await generateDatasetId(realD1(raw), true, { sandboxIdFloor: 90001 });
    expect(id).toBe("xx090001");
    expect(isReservedFixtureId(id)).toBe(false);
  });
});
