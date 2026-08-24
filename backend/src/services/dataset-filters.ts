/**
 * Dataset filter-clause builder (#646), relocated in #1145 (epic #1144 phase 1).
 *
 * Moved verbatim from `backend/src/routes/datasets/catalog.ts`, where it
 * originally lived alongside the `GET /datasets` list handler. `dataset-search.ts`
 * needs to apply these same clauses inside its own queries (threading filters
 * into the search endpoint's SQL, rather than filtering in JS after the fact),
 * but `catalog.ts` (a route module) already imports from `dataset-search.ts`
 * (a service module) -- so a service importing back from a route module would
 * be both a circular import and a layering inversion. This file is the shared
 * home both sides import from; `catalog.ts` re-exports both names so the
 * existing test files that import them from there
 * (`datasets-search.unit.test.ts`, `data-complete-filter.test.ts`,
 * `has-hed-filter.test.ts`, `license-tier.test.ts`) keep passing unchanged.
 */

import type { LicenseTier } from "../lib/license";
import { buildFtsMatch } from "./dataset-search";

// Escape SQLite LIKE wildcards in user input so a literal '%' or '_' in the
// search term means itself rather than "match everything" / "match any
// character". Paired with `ESCAPE '\\'` on every LIKE predicate that uses
// these patterns. Exported for unit testing.
export function escapeLikePattern(raw: string): string {
  return raw.replace(/[\\%_]/g, "\\$&");
}

/**
 * Options accepted by {@link buildDatasetFilterClauses}. Named so both the
 * catalog list endpoint and the search endpoint's SQL-side filtering (#1145)
 * can share the exact same shape rather than each hand-rolling a subset.
 */
export interface DatasetFilterOptions {
  search?: string;
  modality?: string;
  author?: string;
  task?: string;
  hasDoi?: boolean;
  hasHed?: boolean;
  dataComplete?: boolean;
  recent?: number;
  licenseTiers?: LicenseTier[];
}

/**
 * #646 filter clauses for the single-table `datasets` list.
 * Reads d.* only (no nemar_catalog), and routes free-text `search` through the
 * FTS5 index (`d.id IN (SELECT rowid FROM datasets_fts WHERE … MATCH …)`) plus
 * dataset_id/source_id LIKE, replacing the old `c.search_text` LIKE.
 */
export function buildDatasetFilterClauses(
  params: (string | number)[],
  opts: DatasetFilterOptions,
): string {
  let clauses = "";

  if (opts.search) {
    const pattern = `%${escapeLikePattern(opts.search.toLowerCase())}%`;
    const match = buildFtsMatch(opts.search);
    if (match) {
      clauses +=
        " AND (LOWER(d.dataset_id) LIKE ? ESCAPE '\\'" +
        " OR LOWER(COALESCE(d.source_id, '')) LIKE ? ESCAPE '\\'" +
        " OR d.id IN (SELECT rowid FROM datasets_fts WHERE datasets_fts MATCH ?))";
      params.push(pattern, pattern, match);
    } else {
      // No FTS-usable tokens (e.g. all punctuation): fall back to id/name LIKE.
      clauses +=
        " AND (LOWER(d.dataset_id) LIKE ? ESCAPE '\\'" +
        " OR LOWER(COALESCE(d.source_id, '')) LIKE ? ESCAPE '\\'" +
        " OR LOWER(d.name) LIKE ? ESCAPE '\\'" +
        " OR LOWER(COALESCE(d.description, '')) LIKE ? ESCAPE '\\')";
      params.push(pattern, pattern, pattern, pattern);
    }
  }

  if (opts.modality) {
    clauses += " AND LOWER(COALESCE(d.modalities, '')) LIKE ?";
    params.push(`%${opts.modality.toLowerCase()}%`);
  }
  if (opts.author) {
    clauses += " AND LOWER(COALESCE(d.authors, '')) LIKE ?";
    params.push(`%${opts.author.toLowerCase()}%`);
  }
  if (opts.task) {
    clauses += " AND LOWER(COALESCE(d.tasks, '')) LIKE ?";
    params.push(`%${opts.task.toLowerCase()}%`);
  }
  if (opts.licenseTiers && opts.licenseTiers.length > 0) {
    // OR across tiers = IN (...). Tiers are pre-validated against LICENSE_TIERS
    // by parseLicenseTierFilter, so they're a safe, bounded placeholder list.
    // license_tier is NOT NULL (migration 0034), so no NULL branch is needed.
    const placeholders = opts.licenseTiers.map(() => "?").join(", ");
    clauses += ` AND d.license_tier IN (${placeholders})`;
    params.push(...opts.licenseTiers);
  }
  if (opts.hasDoi) {
    clauses += " AND (d.concept_doi IS NOT NULL AND d.concept_doi != '')";
  }
  if (opts.hasHed) {
    // #869: has_hed is nullable (NULL = not classified yet), so `= 1` cleanly
    // excludes both 0 (checked, no HED) and NULL. Backed by idx_datasets_has_hed.
    clauses += " AND d.has_hed = 1";
  }
  if (opts.dataComplete) {
    // #970: same nullable-safe idiom as has_hed -- `= 1` excludes both 0
    // (checked, incomplete) and NULL (not audited yet). Backed by
    // idx_datasets_data_complete.
    clauses += " AND d.data_complete = 1";
  }
  if (opts.recent) {
    // #646: folded catalog rows carry publish_date (from nemar.org); managed
    // rows leave it NULL so this falls through to created_at. Preserves the old
    // UNION's per-branch recency (catalog = publish_date, managed = created_at).
    clauses += " AND COALESCE(d.publish_date, d.created_at) > datetime('now', ?)";
    params.push(`-${opts.recent} days`);
  }

  return clauses;
}
