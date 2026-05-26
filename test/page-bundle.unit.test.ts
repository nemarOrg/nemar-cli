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
  isBundleComplete,
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

describe("isBundleComplete", () => {
  const ok = <T>(data: T): PageBundleComponent<T> => ({ ok: true, data });
  const fail = (error: string): PageBundleComponent<never> => ({ ok: false, error });

  test("all ok + published version + summary present -> true", () => {
    expect(
      isBundleComplete({
        landing: ok({}),
        metadata: ok({}),
        summary: ok({ schema_version: "1.1" }),
        catalogRow: ok({}),
        resolvedVersion: "1.0.0",
      }),
    ).toBe(true);
  });

  test("all ok + no published version + summary null -> true (healthy unpublished)", () => {
    // The bundle for a dataset with zero published versions ships summary
    // ok=true data=null on purpose; complete=true means "this IS the truth,
    // safe to cache."
    expect(
      isBundleComplete({
        landing: ok({}),
        metadata: ok({}),
        summary: ok(null),
        catalogRow: ok({}),
        resolvedVersion: null,
      }),
    ).toBe(true);
  });

  test("all ok + published version + summary null -> false (S3 gap = backfill needed)", () => {
    // Caching this with the success header for 24h SWR would lock in a
    // broken bundle for any visitor at the affected PoP. The whole purpose
    // of this predicate is to flip this case to no-store.
    expect(
      isBundleComplete({
        landing: ok({}),
        metadata: ok({}),
        summary: ok(null),
        catalogRow: ok({}),
        resolvedVersion: "1.0.0",
      }),
    ).toBe(false);
  });

  test("landing failed -> false", () => {
    // Today landing can only fail by exception (which throws past the
    // bundle assembler entirely), but pin the contract anyway in case a
    // future refactor moves landing into the allSettled fanout.
    expect(
      isBundleComplete({
        landing: fail("nope"),
        metadata: ok({}),
        summary: ok({}),
        catalogRow: ok({}),
        resolvedVersion: "1.0.0",
      }),
    ).toBe(false);
  });

  test("metadata failed -> false", () => {
    expect(
      isBundleComplete({
        landing: ok({}),
        metadata: fail("D1 timeout"),
        summary: ok({ schema_version: "1.1" }),
        catalogRow: ok({}),
        resolvedVersion: "1.0.0",
      }),
    ).toBe(false);
  });

  test("summary failed -> false (with version)", () => {
    expect(
      isBundleComplete({
        landing: ok({}),
        metadata: ok({}),
        summary: fail("S3 503"),
        catalogRow: ok({}),
        resolvedVersion: "1.0.0",
      }),
    ).toBe(false);
  });

  test("catalog failed -> false", () => {
    expect(
      isBundleComplete({
        landing: ok({}),
        metadata: ok({}),
        summary: ok({ schema_version: "1.1" }),
        catalogRow: fail("D1 error"),
        resolvedVersion: "1.0.0",
      }),
    ).toBe(false);
  });
});
