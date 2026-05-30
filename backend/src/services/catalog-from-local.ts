/**
 * Build `nemar_catalog` from the local source of truth (D1 `datasets` row +
 * `enrichment_json` blob), without any HTTP fetch to legacy nemar.org.
 *
 * This is the architectural counterpart to `catalog-sync.ts`, which pulls
 * from `https://nemar.org/api/dataexplorer/datapipeline`. The legacy pull
 * never sees datasets created via the new in-process pipeline, so it left
 * 100+ rows missing from the catalog (#544). This module reads only from
 * D1 so every active dataset gets a coherent catalog row regardless of
 * how it was created.
 *
 * Two entry points:
 * - `buildCatalogRecordFromLocal()` -- pure projection, exported for tests
 * - `syncCatalogFromLocal()` -- iterates all active public datasets and
 *   upserts each via the same shape catalog-sync.ts uses, with no
 *   external dependency.
 */

import { SYSTEM_USER_ID } from "../lib/constants.js";
import { authorsFromEnrichment, formatFileSize } from "./dataset-metadata-columns.js";

const BATCH_SIZE = 10;

/**
 * D1 row shape that `syncCatalogFromLocal` reads. Matches the SELECT below
 * and is exported so the unit tests can construct fixtures without a DB.
 */
export interface LocalDatasetRow {
  dataset_id: string;
  name: string | null;
  description: string | null;
  concept_doi: string | null;
  modalities: string | null;
  subject_count: number | null;
  age_min: number | null;
  age_max: number | null;
  tasks: string | null;
  file_size: number | null;
  total_files: number | null;
  created_at: string | null;
  /**
   * First-version timestamp from dataset_versions.created_at (when the
   * dataset earned its v1.0.0 row). Null for unpublished datasets;
   * `buildCatalogRecordFromLocal` falls back to `created_at` when null
   * so the list endpoint's COALESCE-driven sort still has a value.
   *
   * The legacy `datasets.published_at` column doesn't exist in D1;
   * publication is tracked exclusively via dataset_versions.
   */
  first_version_at: string | null;
  source: string | null;
  source_id: string | null;
  is_sandbox: number | null;
  enrichment_json: string | null;
  owner_username: string | null;
}

/** Subset of nemar_catalog columns we INSERT OR REPLACE in the local sync path. */
export interface LocalCatalogRecord {
  id: string;
  name: string;
  description: string | null;
  modalities: string | null;
  participants: number;
  age_min: number;
  age_max: number;
  tasks: string | null;
  authors: string | null;
  doi: string | null;
  license: string | null;
  file_size: number;
  file_size_formatted: string | null;
  total_files: number;
  source: string;
  source_id: string | null;
  uploader: string | null;
  created_date: string | null;
  publish_date: string | null;
  search_text: string;
}

/**
 * Pure transformation: D1 row + parsed enrichment -> catalog record shape.
 * No DB or network access. Callers parse enrichment_json upstream so the
 * function stays trivially testable.
 *
 * Enrichment can be null when a dataset hasn't been enriched yet; in that
 * case only the BIDS-derived fields (subject_count, modalities, tasks,
 * file_size) carry information and the LLM-derived fields (authors,
 * license) stay null.
 */
export function buildCatalogRecordFromLocal(
  row: LocalDatasetRow,
  enrichment: Record<string, unknown> | null,
): LocalCatalogRecord {
  const authors = authorsFromEnrichment(enrichment);
  const license = enrichment && typeof enrichment.license === "string" ? enrichment.license : null;
  const enrichmentDescription =
    enrichment && typeof enrichment.description === "string" ? enrichment.description : null;
  const enrichmentName =
    enrichment && typeof enrichment.title === "string" ? enrichment.title : null;

  const source = row.source ?? "nemar.org";
  const name = enrichmentName || row.name || row.dataset_id;
  const description = enrichmentDescription ?? row.description;

  const searchTextParts = [
    row.dataset_id,
    row.source_id,
    name,
    description,
    authors,
    row.tasks,
    row.modalities,
  ].filter((p): p is string => Boolean(p));
  const searchText = searchTextParts.join(" ").toLowerCase();

  return {
    id: row.dataset_id,
    name,
    description,
    modalities: row.modalities,
    participants: row.subject_count ?? 0,
    age_min: row.age_min ?? 0,
    age_max: row.age_max ?? 0,
    tasks: row.tasks,
    authors,
    doi: row.concept_doi,
    license,
    file_size: row.file_size ?? 0,
    file_size_formatted: formatFileSize(row.file_size),
    total_files: row.total_files ?? 0,
    source,
    source_id: row.source_id,
    uploader: row.owner_username,
    created_date: row.created_at,
    // publish_date prefers the first dataset_versions.created_at (the
    // moment v1.0.0 was minted) when known; unpublished rows fall back to
    // created_at so newest-first ordering still has a sortable value.
    publish_date: row.first_version_at ?? row.created_at,
    search_text: searchText,
  };
}

export interface SyncCatalogFromLocalResult {
  scanned: number;
  upserted: number;
  errors: Array<{ dataset_id: string; error: string }>;
  // #646 Phase 5: true when the rebuild was skipped because this env reads from
  // `datasets` (READ_FROM_DATASETS on) -- nemar_catalog is never consulted, so
  // re-projecting `datasets` back into it would be a write to an unread cache.
  skipped?: boolean;
}

/**
 * Walk every active public dataset and INSERT OR REPLACE its catalog row
 * from local data. Idempotent; safe to re-run.
 *
 * Skips sandbox (xx*) and private datasets to match the policy used by
 * migration 0024 and the list-endpoint visibility filter. Also skips folded
 * legacy catalog rows (owner = SYSTEM_USER_ID, #646): they are themselves
 * cache projections, so re-projecting them back into nemar_catalog would be
 * circular and would clobber the real uploader with 'nemar-system'.
 *
 * Batches D1 statements to stay under the bound-parameter ceiling.
 * INSERT OR REPLACE rebuilds the row from scratch on every call, which
 * is the right behavior for a "cache rebuild from source" sweep; for
 * the hot path (enrichment + reindex), syncNemarCatalogFromEnrichment
 * uses COALESCE-preserve UPSERT instead.
 *
 * #646 Phase 5: when `readFromDatasets` is true (this env reads from the
 * `datasets` source of truth) the whole rebuild is skipped -- nemar_catalog is
 * not consulted, so projecting `datasets` back into it would be wasted work.
 * Phase 6 removes the cache and this path entirely.
 */
export async function syncCatalogFromLocal(
  db: D1Database,
  readFromDatasets = false,
): Promise<SyncCatalogFromLocalResult> {
  if (readFromDatasets) {
    console.log(
      "[catalog-from-local] rebuild skipped (READ_FROM_DATASETS on); nemar_catalog is not consulted",
    );
    return { scanned: 0, upserted: 0, errors: [], skipped: true };
  }

  const result: SyncCatalogFromLocalResult = { scanned: 0, upserted: 0, errors: [] };

  const rows = await db
    .prepare(
      `SELECT d.dataset_id,
              d.name,
              d.description,
              d.concept_doi,
              d.modalities,
              d.subject_count,
              d.age_min,
              d.age_max,
              d.tasks,
              d.file_size,
              d.total_files,
              d.created_at,
              (
                SELECT MIN(dv.created_at)
                FROM dataset_versions dv
                WHERE dv.dataset_id = d.dataset_id
              ) AS first_version_at,
              d.source,
              d.source_id,
              d.is_sandbox,
              d.enrichment_json,
              u.username AS owner_username
       FROM datasets d
       LEFT JOIN users u ON u.id = d.owner_user_id
       WHERE d.status = 'active'
         AND d.visibility = 'public'
         AND (d.is_sandbox = 0 OR d.is_sandbox IS NULL)
         AND d.owner_user_id != ?`,
    )
    .bind(SYSTEM_USER_ID)
    .all<LocalDatasetRow>();

  result.scanned = rows.results.length;

  const records: LocalCatalogRecord[] = [];
  for (const row of rows.results) {
    try {
      const enrichment = row.enrichment_json
        ? (JSON.parse(row.enrichment_json) as Record<string, unknown>)
        : null;
      records.push(buildCatalogRecordFromLocal(row, enrichment));
    } catch (err) {
      result.errors.push({
        dataset_id: row.dataset_id,
        error: `parse-enrichment: ${(err as Error).message ?? err}`,
      });
    }
  }

  for (let i = 0; i < records.length; i += BATCH_SIZE) {
    const batch = records.slice(i, i + BATCH_SIZE);
    // UPSERT (not INSERT OR REPLACE) so columns this path doesn't manage --
    // bids_version, sessions_count, latest_version, readme, is_processed --
    // are preserved on rows that catalog-sync.ts populated from the legacy
    // nemar.org pipeline. INSERT OR REPLACE would silently null them.
    const statements = batch.map((r) =>
      db
        .prepare(
          `INSERT INTO nemar_catalog (
             id, name, description, modalities, participants, age_min, age_max,
             tasks, authors, doi, license, file_size, file_size_formatted,
             total_files, source, source_id, uploader, created_date,
             publish_date, search_text, synced_at
           )
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
           ON CONFLICT(id) DO UPDATE SET
             name = excluded.name,
             description = excluded.description,
             modalities = excluded.modalities,
             participants = excluded.participants,
             age_min = excluded.age_min,
             age_max = excluded.age_max,
             tasks = excluded.tasks,
             authors = excluded.authors,
             doi = excluded.doi,
             license = excluded.license,
             file_size = excluded.file_size,
             file_size_formatted = excluded.file_size_formatted,
             total_files = excluded.total_files,
             source = excluded.source,
             source_id = excluded.source_id,
             uploader = excluded.uploader,
             created_date = excluded.created_date,
             publish_date = excluded.publish_date,
             search_text = excluded.search_text,
             synced_at = datetime('now')`,
        )
        .bind(
          r.id,
          r.name,
          r.description,
          r.modalities,
          r.participants,
          r.age_min,
          r.age_max,
          r.tasks,
          r.authors,
          r.doi,
          r.license,
          r.file_size,
          r.file_size_formatted,
          r.total_files,
          r.source,
          r.source_id,
          r.uploader,
          r.created_date,
          r.publish_date,
          r.search_text,
        ),
    );
    try {
      await db.batch(statements);
      result.upserted += batch.length;
    } catch (err) {
      for (const r of batch) {
        result.errors.push({
          dataset_id: r.id,
          error: `upsert: ${(err as Error).message ?? err}`,
        });
      }
    }
  }

  return result;
}
