/**
 * Tests for the pure availability-report builder (epic #999 Phase 1, #1000):
 * buildAvailabilityReport. No mocks -- real manifest objects + hand-built
 * DatasetVersionIntegrityResult values, mirroring
 * backend/test/import-integrity.test.ts's style for the primitive it wraps.
 */

import { describe, expect, test } from "bun:test";
import {
  buildAvailabilityReport,
  runAvailabilityReportSweep,
  runAvailabilityReportSweepCron,
} from "../src/services/availability-report";
import type { DatasetVersionIntegrityResult } from "../src/services/import-integrity";
import type { Bindings } from "../src/types/bindings";

const GENERATED_AT = "2026-07-22T00:00:00.000Z";

describe("buildAvailabilityReport", () => {
  test("fully complete: missing is empty, complete is true, pct_bytes is bytesPresent/declaredBytes", () => {
    const manifest = {
      "sub-01/eeg/a.edf": { key: "SHA256E-s100--aaa.edf", size: 100 },
      "dataset_description.json": { key: "git:deadbeef", size: 42 },
    };
    const integrity: DatasetVersionIntegrityResult = {
      complete: true,
      missingKeys: [],
      zeroByteKeys: [],
      expectedCount: 1,
      presentCount: 1,
      bytesPresent: 100,
      declaredBytes: 142,
      declaredFiles: 2,
      version: "1.0.0",
    };
    const report = buildAvailabilityReport({
      datasetId: "nm000103",
      version: "1.0.0",
      source: null,
      integrity,
      manifest,
      generatedAt: GENERATED_AT,
    });
    expect(report).toEqual({
      dataset_id: "nm000103",
      version: "1.0.0",
      generated_at: GENERATED_AT,
      source: null,
      complete: true,
      completeness: {
        files_present: 1,
        files_declared: 1,
        bytes_present: 100,
        bytes_declared: 142,
        pct_bytes: 100 / 142,
      },
      missing: [],
    });
  });

  test("partial: mix of zero_byte and absent keys, sorted by path, declared_size sourced from the manifest", () => {
    const manifest = {
      "sub-01/eeg/a.edf": { key: "SHA256E-s10--a.edf", size: 10 },
      "sub-02/eeg/b.edf": { key: "SHA256E-s20--b.edf", size: 20 },
      "sub-03/eeg/c.edf": { key: "SHA256E-s30--c.edf", size: 30 },
    };
    const integrity: DatasetVersionIntegrityResult = {
      complete: false,
      // Deliberately out of path order so the sort is actually exercised.
      missingKeys: ["SHA256E-s30--c.edf", "SHA256E-s20--b.edf"],
      zeroByteKeys: ["SHA256E-s20--b.edf"],
      expectedCount: 3,
      presentCount: 1,
      bytesPresent: 10,
      declaredBytes: 60,
      declaredFiles: 3,
      version: "2.0.0",
    };
    const report = buildAvailabilityReport({
      datasetId: "on000123",
      version: "2.0.0",
      source: { type: "openneuro", id: "ds000123" },
      integrity,
      manifest,
      generatedAt: GENERATED_AT,
      blocklistReason: "OpenNeuro source is publicly listed but returns 403",
    });
    expect(report.complete).toBe(false);
    expect(report.source).toEqual({ type: "openneuro", id: "ds000123" });
    expect(report.blocklist_reason).toBe("OpenNeuro source is publicly listed but returns 403");
    expect(report.missing).toEqual([
      {
        path: "sub-02/eeg/b.edf",
        key: "SHA256E-s20--b.edf",
        declared_size: 20,
        reason: "zero_byte",
      },
      {
        path: "sub-03/eeg/c.edf",
        key: "SHA256E-s30--c.edf",
        declared_size: 30,
        reason: "absent",
      },
    ]);
    expect(report.completeness).toEqual({
      files_present: 1,
      files_declared: 3,
      bytes_present: 10,
      bytes_declared: 60,
      pct_bytes: 10 / 60,
    });
  });

  test("no manifest (integrity.version null) -> minimal honest report, not a bogus zero", () => {
    const integrity: DatasetVersionIntegrityResult = {
      complete: false,
      missingKeys: [],
      zeroByteKeys: [],
      expectedCount: 0,
      presentCount: 5,
      bytesPresent: 500,
      declaredBytes: 0,
      declaredFiles: 0,
      version: null,
    };
    const report = buildAvailabilityReport({
      datasetId: "nm000999",
      version: null,
      source: null,
      integrity,
      manifest: null,
      generatedAt: GENERATED_AT,
    });
    expect(report).toEqual({
      dataset_id: "nm000999",
      version: null,
      generated_at: GENERATED_AT,
      source: null,
      complete: false,
      completeness: {
        files_present: 5,
        files_declared: 0,
        bytes_present: 500,
        bytes_declared: 0,
        pct_bytes: null,
      },
      missing: [],
    });
  });

  test("manifest null but integrity.version non-null (defensive) still falls back to the minimal report", () => {
    // Shouldn't happen from writeAvailabilityReport (both come from the same
    // resolved version), but the pure builder must not crash on the
    // combination -- Object.entries(null) would throw without this guard.
    const integrity: DatasetVersionIntegrityResult = {
      complete: true,
      missingKeys: [],
      zeroByteKeys: [],
      expectedCount: 0,
      presentCount: 0,
      bytesPresent: 0,
      declaredBytes: 0,
      declaredFiles: 0,
      version: "1.0.0",
    };
    const report = buildAvailabilityReport({
      datasetId: "nm000001",
      version: "1.0.0",
      source: null,
      integrity,
      manifest: null,
      generatedAt: GENERATED_AT,
    });
    expect(report.version).toBeNull();
    expect(report.complete).toBe(false);
    expect(report.missing).toEqual([]);
  });

  test("blocklist_reason is omitted entirely (not present as a key) when not given", () => {
    const integrity: DatasetVersionIntegrityResult = {
      complete: true,
      missingKeys: [],
      zeroByteKeys: [],
      expectedCount: 0,
      presentCount: 0,
      bytesPresent: 0,
      declaredBytes: 0,
      declaredFiles: 0,
      version: "1.0.0",
    };
    const report = buildAvailabilityReport({
      datasetId: "nm000001",
      version: "1.0.0",
      source: null,
      integrity,
      manifest: {},
      generatedAt: GENERATED_AT,
    });
    expect("blocklist_reason" in report).toBe(false);
  });

  test("a missing key absent from the manifest entirely (defensive) yields no entry for it, others still report", () => {
    // Shouldn't happen in practice -- every key in integrity.missingKeys comes
    // from the same manifest compareManifestToListing walked -- but the pure
    // builder walks manifest PATHS, so a key with no matching manifest entry
    // simply produces no row rather than a synthetic path:null placeholder.
    const manifest = {
      "sub-01/eeg/a.edf": { key: "SHA256E-s10--a.edf", size: 10 },
    };
    const integrity: DatasetVersionIntegrityResult = {
      complete: false,
      missingKeys: ["SHA256E-sUNKNOWN--x.edf", "SHA256E-s10--a.edf"],
      zeroByteKeys: [],
      expectedCount: 2,
      presentCount: 0,
      bytesPresent: 0,
      declaredBytes: 10,
      declaredFiles: 1,
      version: "1.0.0",
    };
    const report = buildAvailabilityReport({
      datasetId: "nm000001",
      version: "1.0.0",
      source: null,
      integrity,
      manifest,
      generatedAt: GENERATED_AT,
    });
    expect(report.missing).toEqual([
      { path: "sub-01/eeg/a.edf", key: "SHA256E-s10--a.edf", declared_size: 10, reason: "absent" },
    ]);
  });

  test("two paths sharing one annex key (git-annex content-addressing, e.g. duplicate calibration files) both missing -> both reported, neither dropped nor duplicated onto one path", () => {
    const manifest = {
      "sub-01/eeg/calib.edf": { key: "SHA256E-s50--shared.edf", size: 50 },
      "sub-02/eeg/calib.edf": { key: "SHA256E-s50--shared.edf", size: 50 },
      "sub-03/eeg/data.edf": { key: "SHA256E-s90--other.edf", size: 90 },
    };
    const integrity: DatasetVersionIntegrityResult = {
      complete: false,
      // compareManifestToListing emits one missingKeys entry per manifest
      // entry, so a shared key that's missing appears twice here.
      missingKeys: ["SHA256E-s50--shared.edf", "SHA256E-s50--shared.edf"],
      zeroByteKeys: [],
      expectedCount: 3,
      presentCount: 1,
      bytesPresent: 90,
      declaredBytes: 190,
      declaredFiles: 3,
      version: "1.0.0",
    };
    const report = buildAvailabilityReport({
      datasetId: "nm000001",
      version: "1.0.0",
      source: null,
      integrity,
      manifest,
      generatedAt: GENERATED_AT,
    });
    expect(report.missing).toEqual([
      {
        path: "sub-01/eeg/calib.edf",
        key: "SHA256E-s50--shared.edf",
        declared_size: 50,
        reason: "absent",
      },
      {
        path: "sub-02/eeg/calib.edf",
        key: "SHA256E-s50--shared.edf",
        declared_size: 50,
        reason: "absent",
      },
    ]);
  });

  test("pct_bytes is null for a real (non-empty) manifest whose declared bytes are 0 -- not just the no-manifest fallback", () => {
    const manifest = {
      "sub-01/eeg/empty.json": { key: "SHA256E-s0--aaa.json", size: 0 },
    };
    const integrity: DatasetVersionIntegrityResult = {
      complete: true,
      missingKeys: [],
      zeroByteKeys: [],
      expectedCount: 1,
      presentCount: 1,
      bytesPresent: 0,
      declaredBytes: 0,
      declaredFiles: 1,
      version: "1.0.0",
    };
    const report = buildAvailabilityReport({
      datasetId: "nm000001",
      version: "1.0.0",
      source: null,
      integrity,
      manifest,
      generatedAt: GENERATED_AT,
    });
    expect(report.version).toBe("1.0.0");
    expect(report.completeness.pct_bytes).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Cron-only wrapper guard (issue #1166, Option 2) -- mirrors
// cron-dev-safety.test.ts's probe pattern. `runAvailabilityReportSweep`
// itself is intentionally left unguarded (the admin route needs it on
// staging); `runAvailabilityReportSweepCron` is the thing `scheduled()`
// actually calls, and only IT carries the isNonProductionEnv fence.
// ---------------------------------------------------------------------------

describe("runAvailabilityReportSweepCron", () => {
  // Mirrors cron-dev-safety.test.ts's probe(): a D1 whose prepare() throws the
  // instant it is reached, so "resolved/rejected without D1 being touched" (a
  // caught error, a truthy `null` return) cannot be mistaken for "the guard
  // fired" -- only `touched()` proves that.
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

  for (const environment of ["development", "staging", "test"]) {
    test(`never reaches D1 when ENVIRONMENT=${environment}`, async () => {
      const p = probe();
      const result = await runAvailabilityReportSweepCron({
        ENVIRONMENT: environment,
        DB: p.db,
      } as unknown as Bindings);
      expect(p.touched()).toBe(false);
      expect(result).toBeNull();
    });
  }

  // isNonProductionEnv is an allow-list and fails CLOSED: production, and any
  // unset/unrecognized value, are treated as production so the wrapper still
  // delegates rather than silently disabling the daily job on a config typo.
  for (const environment of ["production", "", undefined, "prod", "Production"]) {
    test(`reaches D1 when ENVIRONMENT=${JSON.stringify(environment)}`, async () => {
      const p = probe();
      // runAvailabilityReportSweep does not catch a candidate-query failure
      // (by design -- see its doc comment), so the wrapper's delegated call
      // rejects here too; the probe firing is what matters, not the outcome.
      await expect(
        runAvailabilityReportSweepCron({
          ENVIRONMENT: environment,
          DB: p.db,
        } as unknown as Bindings),
      ).rejects.toThrow(/probe: candidate query reached/);
      expect(p.touched()).toBe(true);
    });
  }

  test("the raw sweep still reaches D1 under development -- the admin backfill route is unaffected", async () => {
    // This is the asymmetry Option 2 exists for. If a future change added an
    // internal guard to runAvailabilityReportSweep itself, this is the test
    // that would catch it: staging's POST
    // /admin/datasets/availability-report-sweep calls the exported sweep
    // directly, not the cron wrapper, so a guard here would silently break
    // that backfill with nothing else failing.
    const p = probe();
    await expect(
      runAvailabilityReportSweep({
        ENVIRONMENT: "development",
        DB: p.db,
      } as unknown as Bindings),
    ).rejects.toThrow(/probe: candidate query reached/);
    expect(p.touched()).toBe(true);
  });
});
