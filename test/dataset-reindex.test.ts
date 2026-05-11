/**
 * Unit tests for buildReindexFilterQuery (epic #417 phase 3).
 *
 * Pins the filter matrix for the bulk reindex admin endpoint. Pure
 * function — no D1 harness needed.
 */

import { describe, expect, test } from "bun:test";
import { buildReindexFilterQuery } from "../backend/src/services/dataset-reindex";

describe("buildReindexFilterQuery", () => {
  test("filter=all returns unfiltered SQL with no params", () => {
    const q = buildReindexFilterQuery("all");
    expect(q.params).toEqual([]);
    expect(q.sql).toContain("FROM datasets");
    expect(q.sql).toContain("github_repo IS NOT NULL");
    // OpenNeuro datasets are always excluded — they need alternate_id mapping.
    expect(q.sql).toContain("dataset_id NOT LIKE 'on%'");
    expect(q.sql).toContain("ORDER BY dataset_id");
  });

  test("filter=missing-metadata predicates every NULL column", () => {
    const q = buildReindexFilterQuery("missing-metadata");
    expect(q.params).toEqual([]);
    expect(q.sql).toContain("subject_count IS NULL");
    expect(q.sql).toContain("modalities IS NULL");
    expect(q.sql).toContain("file_size IS NULL");
    expect(q.sql).toContain("total_files IS NULL");
    // The predicates are OR'd so any single NULL field triggers a match.
    const between = q.sql.split("subject_count IS NULL")[1] ?? "";
    expect(between.toUpperCase()).toContain(" OR ");
  });

  test("filter=stale uses default 30 days when not overridden", () => {
    const q = buildReindexFilterQuery("stale");
    expect(q.params).toEqual(["-30 days"]);
    expect(q.sql).toContain("metadata_updated_at IS NULL");
    expect(q.sql).toContain("metadata_updated_at < datetime('now', ?)");
  });

  test("filter=stale honors olderThanDays override", () => {
    expect(buildReindexFilterQuery("stale", { olderThanDays: 7 }).params).toEqual(["-7 days"]);
    expect(buildReindexFilterQuery("stale", { olderThanDays: 0 }).params).toEqual(["-0 days"]);
    expect(buildReindexFilterQuery("stale", { olderThanDays: 365 }).params).toEqual(["-365 days"]);
  });

  test("filter=stale rejects negative and non-finite older_than_days", () => {
    expect(() => buildReindexFilterQuery("stale", { olderThanDays: -1 })).toThrow(
      /Invalid older_than_days/,
    );
    expect(() => buildReindexFilterQuery("stale", { olderThanDays: Number.NaN })).toThrow(
      /Invalid older_than_days/,
    );
    expect(() =>
      buildReindexFilterQuery("stale", { olderThanDays: Number.POSITIVE_INFINITY }),
    ).toThrow(/Invalid older_than_days/);
  });

  test("unknown filter throws", () => {
    // @ts-expect-error - testing the runtime guard for an invalid filter value
    expect(() => buildReindexFilterQuery("nope")).toThrow(/Unknown reindex filter/);
  });

  test("all queries select only dataset_id (callers iterate it)", () => {
    for (const filter of ["all", "missing-metadata", "stale"] as const) {
      const q = buildReindexFilterQuery(filter);
      // The SELECT clause must be just dataset_id so the caller doesn't
      // accidentally rely on other columns that aren't projected.
      expect(q.sql.split("FROM")[0]?.trim()).toBe("SELECT dataset_id");
    }
  });
});
