/**
 * Unit tests for the pure helpers in page-bundle. Per project policy, the
 * full `buildPageBundle` (D1 query + S3 fetch fan-in) is not unit-tested
 * with a mocked database — it's covered by the E2E smoke against the
 * deployed `/admin/summary/coverage` + a live `/<id>/page-bundle.json`
 * call after merge.
 *
 * The branchy bits worth pinning here:
 *   - pickVersion: how the consumer's `?v=` interacts with the version list
 *   - settled: how PromiseSettledResult collapses into the component wrapper
 */

import { describe, expect, test } from "bun:test";

import {
  type PageBundleComponent,
  pickVersion,
  settled,
} from "../backend/src/services/page-bundle";
import type { DatasetVersionRow } from "../backend/src/services/data-router";

function rows(...versions: string[]): DatasetVersionRow[] {
  // dataset_versions are returned ORDER BY created_at DESC, so [0] is latest.
  return versions.map((version, i) => ({
    version,
    doi: `10.82901/nemar.nm000999.v${version}`,
    created_at: `2026-05-${20 - i}T00:00:00Z`,
  }));
}

describe("pickVersion", () => {
  test("no published versions -> null", () => {
    expect(pickVersion(null, [])).toBeNull();
    expect(pickVersion("1.0.0", [])).toBeNull();
  });

  test("requested matches an existing version", () => {
    expect(pickVersion("1.0.0", rows("1.1.0", "1.0.0"))).toBe("1.0.0");
  });

  test("requested with v prefix is normalised", () => {
    // Consumers like the website pass `v1.0.0` (the canonical form used in
    // S3 paths). Internally version rows are stored without the prefix.
    expect(pickVersion("v1.0.0", rows("1.0.0"))).toBe("1.0.0");
  });

  test("requested unknown version -> falls back to latest", () => {
    // Don't 404 the whole bundle when only the version is bad. The bundle
    // ships landing.latest so the consumer can recover (e.g. render a
    // "version not found, showing latest" banner).
    expect(pickVersion("9.9.9", rows("1.1.0", "1.0.0"))).toBe("1.1.0");
  });

  test("no requested version + existing versions -> latest", () => {
    expect(pickVersion(null, rows("2.0.0", "1.0.0"))).toBe("2.0.0");
  });

  test("empty string treated as no request", () => {
    // `?v=` (empty) shouldn't 404 the whole bundle either.
    expect(pickVersion("", rows("1.0.0"))).toBe("1.0.0");
  });
});

describe("settled", () => {
  test("fulfilled -> ok with data", () => {
    const r: PromiseSettledResult<number> = { status: "fulfilled", value: 42 };
    const out = settled(r, "test");
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.data).toBe(42);
  });

  test("rejected with Error -> ok=false with .message", () => {
    const r: PromiseSettledResult<number> = {
      status: "rejected",
      reason: new Error("boom"),
    };
    const out = settled(r, "test");
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toBe("boom");
  });

  test("rejected with non-Error -> string-coerced reason", () => {
    const r: PromiseSettledResult<number> = { status: "rejected", reason: "raw string" };
    const out = settled(r, "test");
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toBe("raw string");
  });

  test("fulfilled with null -> ok=true and data=null (NOT collapsed to error)", () => {
    // The summary component for a dataset with no published versions
    // intentionally resolves to {ok: true, data: null}. Pin this so a
    // future refactor that conflates "no data" with "failed" can't ship.
    const r: PromiseSettledResult<unknown> = { status: "fulfilled", value: null };
    const out: PageBundleComponent<unknown> = settled(r, "summary");
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.data).toBeNull();
  });
});
