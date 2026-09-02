/**
 * The datasets column budget (#1182).
 *
 * D1 caps a table at 100 columns; local SQLite allows 2000, so no local run
 * can ever reproduce the cap that blocked every deploy when
 * 0071_signal_defaults (now 0072) failed to apply in production. This
 * numeric pin IS the tripwire: the next migration that widens `datasets`
 * past the ceiling fails here, in CI, instead of at deploy time.
 *
 * The exact-count pin (=== 81) is deliberate alongside the ceiling (<= 97):
 * an unexpected column count in EITHER direction means a migration changed
 * the table shape without this file being updated to acknowledge it. Raise
 * the pin consciously with each widening migration; never past the ceiling.
 * The ceiling sits at 97, not 99, to keep headroom for an emergency ALTER
 * on a table that is expensive to rebuild.
 */

import type { Database } from "bun:sqlite";
import { beforeAll, describe, expect, test } from "bun:test";
import { freshDb } from "./helpers/d1";

let db: Database;

beforeAll(() => {
  db = freshDb();
});

describe("datasets column budget", () => {
  test("exactly 81 columns after all migrations", () => {
    // 92 after 0072; 0073 collapses the 12 sweep stamps into one
    // sweep_stamps JSON column (#1183): 92 + 1 - 12 = 81.
    const count = db
      .query("SELECT COUNT(*) AS n FROM pragma_table_info('datasets')")
      .get() as { n: number };
    expect(count.n).toBe(81);
  });

  test("stays under the 97-column ceiling (D1 hard cap is 100)", () => {
    const count = db
      .query("SELECT COUNT(*) AS n FROM pragma_table_info('datasets')")
      .get() as { n: number };
    expect(count.n).toBeLessThanOrEqual(97);
  });

  test("index set is exactly the 22 surviving 0073", () => {
    const names = (
      db
        .query(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'datasets' AND sql IS NOT NULL ORDER BY name",
        )
        .all() as { name: string }[]
    ).map((r) => r.name);
    expect(names).toEqual([
      "idx_datasets_archive_complete",
      "idx_datasets_archive_status",
      "idx_datasets_data_complete",
      "idx_datasets_electrode_system",
      "idx_datasets_embedding_dirty",
      "idx_datasets_has_hed",
      "idx_datasets_id",
      "idx_datasets_is_exemplar",
      "idx_datasets_license_tier",
      "idx_datasets_modalities",
      "idx_datasets_n_channels",
      "idx_datasets_owner",
      "idx_datasets_publish_date",
      "idx_datasets_records_status",
      "idx_datasets_sandbox",
      "idx_datasets_source_id",
      "idx_datasets_status",
      "idx_datasets_subject_count",
      "idx_datasets_visibility",
      "idx_datasets_zarr_failed_at",
      "idx_datasets_zarr_status",
      "idx_datasets_zenodo_concept",
    ]);
  });

  test("trigger set is exactly the 4 the rebuild recreates", () => {
    const names = (
      db
        .query(
          "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'datasets' ORDER BY name",
        )
        .all() as { name: string }[]
    ).map((r) => r.name);
    expect(names).toEqual([
      "datasets_embed_dirty_au",
      "datasets_fts_ad",
      "datasets_fts_ai",
      "datasets_fts_au",
    ]);
  });
});
