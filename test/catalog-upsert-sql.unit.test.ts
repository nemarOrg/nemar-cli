/**
 * Structural assertions on syncNemarCatalogFromEnrichment's SQL.
 *
 * The function moved from UPDATE-only to UPSERT in #546 specifically so a
 * freshly-enriched dataset that doesn't yet have a nemar_catalog row gets
 * one inserted on first call. The two load-bearing properties:
 *   1. ON CONFLICT(id) DO UPDATE present (the UPSERT branch)
 *   2. COALESCE-preserve on every updatable column (so a null input on the
 *      UPDATE path doesn't clobber a previously-better value)
 *
 * Both are easy to revert by accident during a refactor. Pin them here.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

const SOURCE_PATH = join(
  import.meta.dir,
  "..",
  "backend/src/services/dataset-metadata-columns.ts",
);
const source = readFileSync(SOURCE_PATH, "utf8");

describe("syncNemarCatalogFromEnrichment SQL", () => {
  test("uses INSERT ... ON CONFLICT(id) DO UPDATE", () => {
    expect(source).toMatch(/INSERT INTO nemar_catalog/);
    expect(source).toMatch(/ON CONFLICT\(id\) DO UPDATE SET/);
  });

  test("COALESCE-preserves every updatable column on the UPDATE path", () => {
    // If any of these stops using COALESCE(excluded.X, nemar_catalog.X), a
    // caller passing null would clobber the existing value, which is the
    // exact bug #541/#546 set out to prevent.
    const preservedColumns = [
      "name",
      "description",
      "modalities",
      "participants",
      "age_min",
      "age_max",
      "tasks",
      "authors",
      "license",
      "file_size",
      "file_size_formatted",
      "total_files",
    ];
    for (const col of preservedColumns) {
      const expected = `${col} = COALESCE(excluded.${col}, nemar_catalog.${col})`;
      expect(source).toContain(expected);
    }
  });

  test("updates synced_at unconditionally so stale rows are observable", () => {
    expect(source).toMatch(/synced_at = datetime\('now'\)/);
  });
});
