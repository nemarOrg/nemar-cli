/**
 * Unit tests for buildReindexFilterQuery (epic #417 phase 3).
 *
 * Pins the filter matrix for the bulk reindex admin endpoint. Pure
 * function — no D1 harness needed.
 */

import { describe, expect, test } from "bun:test";
import {
  buildReindexFilterQuery,
  extractEnrichmentSubErrors,
  looksLikeTagRef,
} from "../backend/src/services/dataset-reindex";

describe("buildReindexFilterQuery", () => {
  test("filter=all returns unfiltered SQL with no params", () => {
    const q = buildReindexFilterQuery("all");
    expect(q.params).toEqual([]);
    expect(q.sql).toContain("FROM datasets");
    expect(q.sql).toContain("github_repo IS NOT NULL");
    // OpenNeuro datasets are NOW included (#512): runDatasetSync skips the
    // nemar.org push for them but still refreshes D1 metadata columns +
    // enrichment, which is what the website catalog needs.
    expect(q.sql).not.toContain("dataset_id NOT LIKE 'on%'");
    // Sandbox datasets must still be excluded — they're not eligible for
    // nemar.org sync and pollute the live datapipeline if included.
    expect(q.sql).toContain("dataset_id NOT LIKE 'xx%'");
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

  test("every filter excludes xx% datasets but includes on%", () => {
    // Regression guard: xx% (sandbox) must stay excluded — they pollute the
    // live datapipeline. on% (OpenNeuro) is now INCLUDED (#512): runDatasetSync
    // skips the nemar.org push for them but still refreshes D1 metadata
    // columns and triggers enrichment, which is what the catalog needs.
    for (const filter of ["all", "missing-metadata", "stale"] as const) {
      const q = buildReindexFilterQuery(filter);
      expect(q.sql).not.toContain("dataset_id NOT LIKE 'on%'");
      expect(q.sql).toContain("dataset_id NOT LIKE 'xx%'");
    }
  });

  test("filter=stale accepts 0 (boundary)", () => {
    // The guard is `< 0`, so 0 is valid and reads as "anything not updated
    // in the last 0 days" -- effectively every row, useful for a forced
    // bulk refresh. Pin the boundary so a future tightening to `<= 0`
    // breaks loudly.
    expect(() => buildReindexFilterQuery("stale", { olderThanDays: 0 })).not.toThrow();
  });
});

describe("extractEnrichmentSubErrors", () => {
  // The enrichment webhook returns HTTP 200 with embedded *_error fields
  // when individual sub-steps fail. This pure helper turns that body into
  // a list of "<field>: <message>" strings; runEnrichmentForDataset uses
  // it to decide ok vs failed.

  test("returns empty for a clean body", () => {
    expect(extractEnrichmentSubErrors({ ok: true })).toEqual([]);
  });

  test("returns empty for non-object input", () => {
    expect(extractEnrichmentSubErrors(null)).toEqual([]);
    expect(extractEnrichmentSubErrors(undefined)).toEqual([]);
    expect(extractEnrichmentSubErrors("oops")).toEqual([]);
    expect(extractEnrichmentSubErrors(42)).toEqual([]);
  });

  test("returns one entry for a single populated *_error field", () => {
    expect(extractEnrichmentSubErrors({ commit_error: "rate limited" })).toEqual([
      "commit_error: rate limited",
    ]);
  });

  test("joins multiple populated error fields preserving the canonical order", () => {
    const errors = extractEnrichmentSubErrors({
      commit_error: "rate limited",
      doi_sync_error: "ezid down",
      bidsignore_error: "merge conflict",
    });
    // Preserves the canonical field order from the implementation so
    // operators see a consistent ordering across log lines.
    expect(errors).toEqual([
      "commit_error: rate limited",
      "doi_sync_error: ezid down",
      "bidsignore_error: merge conflict",
    ]);
  });

  test("skips falsy / non-string error fields", () => {
    expect(
      extractEnrichmentSubErrors({
        commit_error: "",
        openrouter_error: null,
        doi_sync_error: undefined,
        cache_error: 0,
        bidsignore_error: false,
        metadata_columns_error: { msg: "oops" },
      }),
    ).toEqual([]);
  });

  test("ignores unknown fields so the body shape can evolve", () => {
    expect(
      extractEnrichmentSubErrors({
        commit_error: "x",
        unrelated_field: "y",
        future_error: "z",
      }),
    ).toEqual(["commit_error: x"]);
  });

  test("covers metadata_columns_error and issue_creation_error", () => {
    // These two are the newer (phase 2 / earlier) additions; the
    // canonical list in dataset-reindex.ts must include them so admin
    // reindex surfaces them too.
    expect(
      extractEnrichmentSubErrors({
        metadata_columns_error: "d1 down",
        issue_creation_error: "no perms",
      }),
    ).toEqual([
      "metadata_columns_error: d1 down",
      "issue_creation_error: no perms",
    ]);
  });
});

describe("looksLikeTagRef", () => {
  // Used by runEnrichmentForDataset to force client_commits=true when the
  // ref is a (immutable) version tag, so the Worker doesn't try to commit
  // back to refs/heads/v1.0.0 or worse, fall through to the bare Contents
  // API and silently land tag-era metadata on main.

  test("matches semver-style version tags", () => {
    expect(looksLikeTagRef("v1.0.0")).toBe(true);
    expect(looksLikeTagRef("v0.0.1")).toBe(true);
    expect(looksLikeTagRef("v10.20.30")).toBe(true);
    expect(looksLikeTagRef("v1.0.0-rc1")).toBe(true);
    expect(looksLikeTagRef("v1")).toBe(true);
  });

  test("rejects branch-shaped refs", () => {
    expect(looksLikeTagRef("main")).toBe(false);
    expect(looksLikeTagRef("master")).toBe(false);
    expect(looksLikeTagRef("dev")).toBe(false);
    expect(looksLikeTagRef("release/v1.0.0")).toBe(false);
    expect(looksLikeTagRef("feature/my-branch")).toBe(false);
    expect(looksLikeTagRef("verify-something")).toBe(false); // starts with v but not a tag pattern
  });

  test("rejects empty / non-digit-suffixed v refs", () => {
    expect(looksLikeTagRef("")).toBe(false);
    expect(looksLikeTagRef("v")).toBe(false);
    expect(looksLikeTagRef("version")).toBe(false);
    expect(looksLikeTagRef("vNext")).toBe(false);
  });
});
