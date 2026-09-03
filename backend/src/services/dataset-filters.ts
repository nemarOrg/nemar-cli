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
 *
 * This file has NO imports from `dataset-search.ts` (review round 3 caught an
 * earlier version that imported `buildFtsMatch` back from there, recreating a
 * two-file cycle one layer down -- harmless at runtime since both are hoisted
 * function declarations, but it contradicted this docstring, so `buildFtsMatch`
 * lives here now instead). `dataset-search.ts` imports FROM this file only.
 */

import type { LicenseTier } from "../lib/license";
import type { AuthUser } from "../types/bindings";
import { hasRole } from "../types/bindings";
import { type FacetFilterValues, buildFacetClauses } from "./dataset-facets";
import { ZARR_VERIFY_STATUS_PATH } from "./sweep-stamps";

/** Build an injection-safe FTS5 MATCH expression: tokenize to alphanumerics
 *  (dropping all FTS5 operator chars), quote each token and prefix-match it,
 *  OR them for recall. Returns null when there is nothing to match. Lives
 *  here (not dataset-search.ts) so this file has no outgoing imports from
 *  dataset-search.ts -- the whole point of the #1145 move was to let
 *  dataset-search.ts depend on this file, not the other way around. */
export function buildFtsMatch(query: string): string | null {
  const tokens = query
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter((t) => t.length >= 2);
  if (tokens.length === 0) return null;
  return tokens.map((t) => `"${t}"*`).join(" OR ");
}

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
  /** Only datasets with a ready Zarr copy holding at least one store (issue
   *  #1062, epic #1181 phase 2). Same nullable-safe bespoke-filter shape as
   *  hasHed/dataComplete above -- not a facet-table entry, because the
   *  underlying `zarr` facet (dataset-facets.ts) already exists as an ENUM
   *  match on the raw `zarr_status` value; this is a distinct derived
   *  predicate (ready AND store_count > 0). `hasZarr`'s meaning is STABLE:
   *  phase 8 adds a SEPARATE `has_zarr_verified` filter for "converted AND
   *  verified" rather than redefining this one out from under existing
   *  callers (PR #1201 review, item 9). */
  hasZarr?: boolean;
  /** Only datasets whose Zarr copy has PASSED the standing fidelity
   *  verification sweep (issue #1068, epic #1181 phase 8):
   *  `has_zarr AND zarr_verify_status = 'verified'`. A strict narrowing of
   *  `hasZarr` above, not a replacement for it -- a fresh conversion is
   *  `has_zarr=true` with `zarr_verify_status` still null until the daily
   *  sweep (services/zarr-fidelity-sweep.ts) reaches it; the viewer keeps
   *  reading index.json regardless (ADR 0005). Same nullable-safe
   *  bespoke-filter shape as `hasZarr`, not a facet-table entry. */
  hasZarrVerified?: boolean;
  dataComplete?: boolean;
  recent?: number;
  licenseTiers?: LicenseTier[];
  /**
   * The declared facet vocabulary (epic #1144 phase 3, #1147) --
   * `shared/facets.ts` + `dataset-facets.ts`. Kept separate from the flat
   * legacy fields above rather than folded in: those nine fields have
   * irregular, bespoke semantics (FTS routing, LIKE-joined comma lists) that
   * don't fit a declared table, while every facet here shares one of five
   * regular shapes. See ADR 0032.
   */
  facets?: FacetFilterValues;
  /** Widens every ACTIVE facet's predicate with its declared NULL test
   *  (D4/ADR 0005): a NULL never satisfies a SQL comparison, so unknown rows
   *  are excluded by default, and this is the explicit escape hatch. Has no
   *  effect on the legacy filters above (none of them are facet-table
   *  entries) or when `facets` is empty/absent. */
  includeUnknown?: boolean;
}

/**
 * #646 filter clauses for the single-table `datasets` list -- and, since
 * #1145 (epic #1144 phase 1), for every GET /datasets/search tier too
 * (exact-id, FTS, semantic-hydration all call this via dataset-search.ts).
 * Reads d.* only (no nemar_catalog), and routes free-text `search` through the
 * FTS5 index (`d.id IN (SELECT rowid FROM datasets_fts WHERE … MATCH …)`) plus
 * dataset_id/source_id LIKE, replacing the old `c.search_text` LIKE.
 */
/** D1's per-statement bound-parameter ceiling. */
export const MAX_BOUND_PARAMS = 100;

/** Throw before binding if a statement would exceed {@link MAX_BOUND_PARAMS}.
 *
 *  Local SQLite allows far more variables than D1 does, so a query that
 *  overflows on D1 runs fine in tests -- which is how #1193 shipped: every
 *  faceted text search 500'd in production with D1's opaque
 *  `too many SQL variables`, and no local test could reproduce it. Applied
 *  centrally in {@link buildDatasetFilterClauses} rather than per call site,
 *  because the facet vocabulary is a growing surface and a new caller should
 *  inherit the ceiling instead of having to remember it (#1195 review I5). */
export function assertBoundParamBudget(params: readonly unknown[], context: string): void {
  if (params.length > MAX_BOUND_PARAMS) {
    throw new Error(
      `${context}: ${params.length} bound parameters exceeds D1's limit of ${MAX_BOUND_PARAMS}. Collapse per-item placeholder lists into a single json_each parameter.`,
    );
  }
}

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
  if (opts.hasZarr) {
    // #1062: zarr_status is nullable (NULL/'pending'/'failed' all excluded by
    // `= 'ready'`); COALESCE'd store_count guards a 'ready' row whose count
    // was never populated (an older converter run). Backed by the existing
    // idx_datasets_zarr_status (migration 0035/0071) -- no new index needed.
    clauses += " AND d.zarr_status = 'ready' AND COALESCE(d.zarr_store_count, 0) > 0";
  }
  if (opts.hasZarrVerified) {
    // #1068: has_zarr's predicate ANDed with the sweep's stamped verdict.
    // json_extract returns SQL NULL for a never-swept row (sweep_stamps NULL
    // or the key absent/JSON-null -- ADR 0035), which never equals the
    // string literal, so an unswept or non-'verified' row is excluded, same
    // as has_hed/has_zarr's own NULL-excludes-by-default convention.
    clauses += ` AND d.zarr_status = 'ready' AND COALESCE(d.zarr_store_count, 0) > 0 AND json_extract(d.sweep_stamps, '${ZARR_VERIFY_STATUS_PATH}') = 'verified'`;
  }
  if (opts.dataComplete) {
    // #970: same nullable-safe idiom as has_hed -- `= 1` excludes both 0
    // (checked, incomplete) and NULL (not audited yet). Backed by
    // idx_datasets_data_complete.
    clauses += " AND d.data_complete = 1";
  }
  if (opts.recent && opts.recent > 0) {
    // #646: folded catalog rows carry publish_date (from nemar.org); managed
    // rows leave it NULL so this falls through to created_at. Preserves the old
    // UNION's per-branch recency (catalog = publish_date, managed = created_at).
    // Guarded to > 0 (#1145 review S4): a negative value would build
    // `datetime('now', '--5 days')`, a malformed SQLite modifier that
    // silently matches nothing rather than erroring loudly.
    clauses += " AND COALESCE(d.publish_date, d.created_at) > datetime('now', ?)";
    params.push(`-${opts.recent} days`);
  }

  // Epic #1144 phase 3 (#1147): the declared facet table's generic walk,
  // appended after the bespoke clauses above rather than merged into them --
  // see the `facets` field doc comment on DatasetFilterOptions and ADR 0032.
  clauses += buildFacetClauses(params, opts.facets, opts.includeUnknown ?? false);

  assertBoundParamBudget(params, "dataset filter query");
  return clauses;
}

/**
 * FROM/JOIN/WHERE base for the public (non-`?mine`) `GET /datasets`
 * population. Extracted out of that handler's own `buildPublicBase()`
 * closure in epic #1144 phase 5a (#1170, D4): the facets vocabulary
 * (`dataset-facet-vocabulary.ts`) must count over EXACTLY the population an
 * anonymous caller can already list, and a hand-copied second WHERE clause
 * is exactly how the vocabulary would end up advertising a value no list
 * query can actually return. The list handler now calls this with its own
 * request-scoped `status`/`user`/`owner`; the facets endpoint calls it with
 * the literal `("active", undefined, undefined)` -- no `?status=` override,
 * no admin bypass, no `?owner=` filter, which is precisely the anonymous
 * default.
 *
 * `user` only needs `role` (not the full `AuthUser`) but takes the whole
 * shape so callers can pass `c.get("user")` directly without picking fields.
 */
export function buildPublicCatalogBase(
  status: string,
  user: AuthUser | undefined,
  owner: string | undefined,
): { from: string; params: (string | number)[] } {
  const prefixParams: (string | number)[] = [status];
  let from = `
    FROM datasets d
    LEFT JOIN users u ON d.owner_user_id = u.id
    WHERE d.status = ?
      AND (d.is_sandbox = 0 OR d.is_sandbox IS NULL OR d.is_exemplar = 1)
  `;
  if (!user || !hasRole(user.role, "admin")) {
    from += " AND d.visibility = 'public'";
  }
  if (owner) {
    // The uploader column was dropped in #1182 (0 non-null rows in
    // production); the owning user's username is the only owner label.
    from += " AND u.username = ?";
    prefixParams.push(owner);
  }
  return { from, params: prefixParams };
}
