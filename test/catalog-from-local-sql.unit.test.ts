/**
 * Structural assertions on the SQL emitted by syncCatalogFromLocal.
 *
 * The function is database-bound so we can't easily run it inside a Bun
 * unit test, but the load-bearing decisions in the SQL string -- UPSERT
 * (not INSERT OR REPLACE) so legacy columns aren't clobbered, and the
 * deliberate column omission set -- are the parts that historically
 * regress. Pinning them via source-string assertions costs nothing and
 * catches the most likely refactor mistakes.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

const SOURCE_PATH = join(
  import.meta.dir,
  "..",
  "backend/src/services/catalog-from-local.ts",
);
const source = readFileSync(SOURCE_PATH, "utf8");

describe("catalog-from-local SQL", () => {
  test("uses UPSERT, not INSERT OR REPLACE", () => {
    // INSERT OR REPLACE in SQLite is DELETE + INSERT, which would clobber
    // every column not in the statement. The list-endpoint relies on some
    // of those columns (readme, bids_version) being populated by the
    // legacy catalog-sync.ts. UPSERT preserves them.
    expect(source).not.toMatch(/INSERT OR REPLACE INTO nemar_catalog/);
    expect(source).toMatch(/INSERT INTO nemar_catalog/);
    expect(source).toMatch(/ON CONFLICT\(id\) DO UPDATE SET/);
  });

  test("deliberately omits the legacy-only columns from the INSERT", () => {
    // These columns are populated by catalog-sync.ts (legacy nemar.org pull)
    // and are NOT produced by the local enrichment pipeline. The UPSERT
    // doesn't touch them so existing values survive. If a future refactor
    // adds one of these to the INSERT column list without a real source
    // for the value, this test fails loudly.
    const omittedColumns = [
      "bids_version",
      "sessions_count",
      "latest_version",
      "readme",
      "is_processed",
    ];
    for (const col of omittedColumns) {
      // The INSERT column list lives between "INSERT INTO nemar_catalog (" and
      // the matching ")". Extract it and assert the column isn't in there.
      const m = source.match(/INSERT INTO nemar_catalog \(([\s\S]*?)\)/);
      expect(m).not.toBeNull();
      const insertColumnList = m?.[1] ?? "";
      expect(insertColumnList).not.toContain(col);
    }
  });

  test("UPSERT updates synced_at on conflict so stale rows are observable", () => {
    expect(source).toMatch(/synced_at = datetime\('now'\)/);
  });

  test("SELECT derives first_version_at from dataset_versions (no fictional d.published_at)", () => {
    // datasets has no published_at column; publication is tracked via
    // dataset_versions. Pin the correlated subquery so the SELECT can't
    // regress to referencing a non-existent column.
    expect(source).toMatch(/SELECT MIN\(dv\.created_at\)\s+FROM dataset_versions dv/);
    expect(source).not.toMatch(/d\.published_at/);
  });
});
