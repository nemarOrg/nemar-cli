/**
 * Structural assertions on migration 0023 (backfill nemar_catalog from
 * datasets + enrichment_json).
 *
 * The migration itself can't run inside a Bun unit test (D1 isn't in scope)
 * but the SQL file's structure is the bug surface that has historically
 * regressed: the author-extraction clause needs both an object-form path
 * (json_each on $.authors with json_type = 'object') and a legacy array-form
 * path (json_each on $.authors with json_type = 'array' and json_extract
 * on the array element's .name). Drop either guard and every freshly-
 * enriched dataset misses its author backfill silently.
 *
 * These tests assert the load-bearing clauses are present in the file.
 * Pair with the api.test.ts post-deploy assertions to verify the migration
 * actually ran against the prod D1.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATION_PATH = join(
  import.meta.dir,
  "..",
  "backend/src/db/migrations/0023_backfill_nemar_catalog_from_enrichment.sql",
);
const sql = readFileSync(MIGRATION_PATH, "utf8");

describe("migration 0023 structure", () => {
  test("backfills modalities from datasets.modalities when catalog is empty", () => {
    expect(sql).toContain("UPDATE nemar_catalog");
    expect(sql).toContain("SET modalities = COALESCE");
    expect(sql).toMatch(/WHERE \(modalities IS NULL OR modalities = ''\)/);
  });

  test("backfills participants from datasets.subject_count", () => {
    // Column name differs between the two tables: nemar_catalog.participants
    // vs datasets.subject_count. A future refactor that renamed one but not
    // the other would silently break the backfill; pin both names.
    expect(sql).toContain("SET participants =");
    expect(sql).toContain("d.subject_count FROM datasets d");
  });

  test("backfills tasks and file_size and total_files", () => {
    expect(sql).toContain("SET tasks =");
    expect(sql).toContain("SET file_size = COALESCE(NULLIF(file_size, 0)");
    expect(sql).toContain("total_files = COALESCE(NULLIF(total_files, 0)");
  });

  test("backfills authors from the OBJECT shape (current enrichment output)", () => {
    // Object form: {"Name": {orcid: ...}, ...}. GROUP_CONCAT over keys.
    expect(sql).toMatch(/GROUP_CONCAT\(je\.key,\s*', '\)/);
    expect(sql).toContain("json_type(d.enrichment_json, '$.authors') = 'object'");
  });

  test("backfills authors from the legacy ARRAY shape ([{name: ...}])", () => {
    // Array form: [{"name": "X"}, ...]. GROUP_CONCAT over json_extract($.name).
    expect(sql).toMatch(/GROUP_CONCAT\(json_extract\(je\.value, '\$\.name'\),\s*', '\)/);
    expect(sql).toContain("json_type(d.enrichment_json, '$.authors') = 'array'");
  });

  test("age guard updates the row if EITHER bound is missing (not both)", () => {
    // The original draft of this migration used `AND` here, which silently
    // skipped any row with one age already set in the catalog. The
    // user-facing impact is small but the bug surface is sneaky enough that
    // it deserves a pinned test.
    expect(sql).toMatch(
      /WHERE \(\(age_min IS NULL OR age_min = 0\) OR \(age_max IS NULL OR age_max = 0\)\)/,
    );
  });

  test("uses COALESCE-preserve semantics so existing values aren't clobbered", () => {
    // Every backfill UPDATE wraps the target column in COALESCE to preserve
    // whatever catalog-sync.ts already wrote. A migration that overwrote
    // existing values would be a one-way data destruction.
    const coalesceCount = (sql.match(/COALESCE/g) ?? []).length;
    expect(coalesceCount).toBeGreaterThanOrEqual(5);
  });

  test("touches synced_at on every UPDATE for observability", () => {
    // Operators rely on synced_at to spot stale rows. A migration that
    // forgot to bump it would render its own work invisible to ops.
    const syncedAtCount = (sql.match(/synced_at = datetime\('now'\)/g) ?? []).length;
    expect(syncedAtCount).toBeGreaterThanOrEqual(5);
  });
});
