/**
 * Public catalog: listing with filters, hybrid search, source-id resolution,
 * and the dataset detail endpoint. GET /search must stay registered before
 * GET /:id (monolith order preserved within this file).
 *
 * Moved verbatim from routes/datasets.ts (#906, epic #902); the only
 * intentional changes are import paths and the register-function wrapper.
 */

import { toVersionTag } from "../../../../shared/contract/index.js";
import { SYSTEM_USER_ID } from "../../lib/constants";
import { type LicenseTier, parseLicenseTierFilter } from "../../lib/license";
import { optionalAuthMiddleware } from "../../middleware/auth";
import {
  type SearchResult,
  buildFtsMatch,
  ftsSearch,
  lookupDatasetById,
  rrfFuse,
  semanticSearchHydrated,
} from "../../services/dataset-search";
import { isValidDatasetId } from "../../services/datasetId";
import { hasRole } from "../../types/bindings";
import type { DatasetsRouter } from "./shared";

/**
 * Emit `latest_version` in the canonical `vX.Y.Z` tag form (epic #896 #899).
 * D1's `dataset_versions.version` stores a mix of bare (`1.0.0`) and tagged
 * (`v1.0.0`) rows; the catalog plane historically forwarded them raw while the
 * data plane already normalized to the tag. Consumers that build data-plane
 * URLs from this value (hallu-sync `archives/<v>.zip`, hallu-zarr) need the tag
 * form, and the website double-prefixed a bare value as `v1.0.0` but an
 * already-tagged one as `vv1.0.0`. Idempotent; leaves null untouched.
 * Exported for unit testing.
 */
export function withCanonicalLatestVersion<T extends Record<string, unknown>>(row: T): T {
  const v = row.latest_version;
  return typeof v === "string" && v ? { ...row, latest_version: toVersionTag(v) } : row;
}

// Escape SQLite LIKE wildcards in user input so a literal '%' or '_' in the
// search term means itself rather than "match everything" / "match any
// character". Paired with `ESCAPE '\\'` on every LIKE predicate that uses
// these patterns. Exported for unit testing.
export function escapeLikePattern(raw: string): string {
  return raw.replace(/[\\%_]/g, "\\$&");
}

/**
 * #646 filter clauses for the single-table `datasets` list.
 * Reads d.* only (no nemar_catalog), and routes free-text `search` through the
 * FTS5 index (`d.id IN (SELECT rowid FROM datasets_fts WHERE … MATCH …)`) plus
 * dataset_id/source_id LIKE, replacing the old `c.search_text` LIKE.
 */
export function buildDatasetFilterClauses(
  params: (string | number)[],
  opts: {
    search?: string;
    modality?: string;
    author?: string;
    task?: string;
    hasDoi?: boolean;
    hasHed?: boolean;
    dataComplete?: boolean;
    recent?: number;
    licenseTiers?: LicenseTier[];
  },
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

function buildSortClause(sort: string): string {
  switch (sort) {
    case "oldest":
      return " ORDER BY d.created_at ASC";
    case "name":
      return " ORDER BY d.name ASC";
    case "participants":
      return " ORDER BY participants DESC";
    case "size":
      return " ORDER BY file_size DESC";
    case "citations":
      // Most-cited first; ties fall back to newest so the order is stable (#804).
      return " ORDER BY COALESCE(d.num_citations, 0) DESC, d.created_at DESC";
    default:
      return " ORDER BY d.created_at DESC";
  }
}

async function executeAndReturn(
  c: { json: (data: unknown, status?: number) => Response },
  db: D1Database,
  baseQuery: string,
  baseParams: (string | number)[],
  pagination: { limit: number; offset: number },
) {
  const { limit, offset } = pagination;
  try {
    const paginatedQuery = `${baseQuery} LIMIT ? OFFSET ?`;
    const countQuery = `SELECT COUNT(*) AS total FROM (${baseQuery})`;

    // Run main query and count in parallel; use allSettled so a count
    // failure does not prevent returning the main results.
    const [mainSettled, countSettled] = await Promise.allSettled([
      db
        .prepare(paginatedQuery)
        .bind(...baseParams, limit, offset)
        .all(),
      db
        .prepare(countQuery)
        .bind(...baseParams)
        .first<{ total: number }>(),
    ]);

    if (mainSettled.status === "rejected") {
      throw mainSettled.reason;
    }

    const result = mainSettled.value;
    if (!result?.results) {
      return c.json({ error: "Database query failed" }, 500);
    }

    let totalCount = result.results.length;
    if (countSettled.status === "fulfilled" && countSettled.value?.total != null) {
      totalCount = countSettled.value.total;
    } else if (countSettled.status === "rejected") {
      console.warn(
        "[datasets] COUNT query failed, using result length:",
        countSettled.reason instanceof Error
          ? countSettled.reason.message
          : String(countSettled.reason),
      );
    }

    return c.json({
      datasets: result.results.map(withCanonicalLatestVersion),
      count: result.results.length,
      total_count: totalCount,
      limit,
      offset,
    });
  } catch (dbError) {
    const msg = dbError instanceof Error ? dbError.message : String(dbError);

    // Permanent defense-in-depth net (#646): the main query no longer touches
    // nemar_catalog (dropped in Phase 6), but if any code path ever hits a
    // missing-catalog error, a missing datasets_fts (the search filter injects
    // an FTS subquery), or a missing consolidation column (this Worker deployed
    // before migrations 0029-0033 applied -- a cutover-order slip), degrade to
    // the basic datasets-only query (which selects only pre-consolidation
    // columns) instead of 500ing, matching the /datasets/search endpoint's
    // graceful degradation rather than failing the whole list.
    if (
      msg.includes("no such table: nemar_catalog") ||
      msg.includes("no such table: datasets_fts") ||
      msg.includes("no such column")
    ) {
      console.warn(
        `[datasets] missing catalog/FTS table or consolidation column (${msg}); falling back to basic query`,
      );
      try {
        const fallback = await db
          .prepare(
            `SELECT d.dataset_id, d.name, d.description, d.status, d.visibility,
                    d.github_repo, d.concept_doi, d.created_at, d.updated_at,
                    u.username AS owner_username,
                    -- API contract: every list entry exposes latest_version
                    -- (null when no minted DOI version yet) so callers
                    -- (e.g. scripts/hallu-sync.sh) can rely on its presence
                    -- without falling back to per-dataset /manifest calls.
                    (
                      SELECT version FROM dataset_versions dv
                      WHERE dv.dataset_id = d.dataset_id
                      ORDER BY created_at DESC
                      LIMIT 1
                    ) AS latest_version
             FROM datasets d
             JOIN users u ON d.owner_user_id = u.id
             WHERE d.status = 'active' AND (d.is_sandbox = 0 OR d.is_sandbox IS NULL OR d.is_exemplar = 1)
               AND d.visibility = 'public'
             ORDER BY d.created_at DESC LIMIT ? OFFSET ?`,
          )
          .bind(limit, offset)
          .all();
        return c.json({
          datasets: (fallback.results || []).map(withCanonicalLatestVersion),
          count: fallback.results?.length || 0,
          total_count: fallback.results?.length || 0,
          limit,
          offset,
          fallback: true,
          warning: "Catalog not available; filters and catalog datasets not included",
        });
      } catch (fallbackErr) {
        const fallbackMsg =
          fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
        return c.json({ error: "Failed to retrieve datasets", details: fallbackMsg }, 500);
      }
    }

    console.error("Failed to query datasets:", msg);
    return c.json({ error: "Failed to retrieve datasets", details: msg }, 500);
  }
}

export function registerCatalogRoutes(datasetRoutes: DatasetsRouter): void {
  /**
   * GET /datasets - List datasets (unified catalog)
   *
   * Single-table read from the `datasets` source of truth (#646). Managed and
   * folded legacy-catalog rows coexist in one table, discriminated by the
   * sentinel owner; source_type distinguishes them in the response.
   *
   * Visibility rules:
   * - --mine flag: show only the authenticated user's managed datasets (private + public + sandbox)
   * - No --mine flag (public catalog): merge managed + catalog-only datasets
   *   - Sandbox datasets are ALWAYS excluded
   *   - Unauthenticated: public datasets only
   *   - Authenticated non-admin: public datasets only
   *   - Admin: all datasets (including private managed datasets)
   *
   * Filter params: modality, author, task, has_doi, recent, sort, search, owner
   * Pagination: limit (1-200, default 50), offset (>= 0, default 0)
   * Response includes total_count, limit, offset for client-side pagination
   */
  datasetRoutes.get("/", optionalAuthMiddleware, async (c) => {
    // Safe Cache-Control default: every early-return error path inherits
    // no-store. The single success branch that's actually shareable
    // (anonymous browsing of the union catalog) overrides this below with
    // a `public + Vary: Authorization` block. Hono replaces same-named
    // headers, so the later set wins. Issue #639.
    c.header("Cache-Control", "no-store");
    const mine = c.req.query("mine") === "true";
    const status = c.req.query("status") || "active";
    const rawLimit = Number.parseInt(c.req.query("limit") ?? "", 10);
    const limit = Math.min(Math.max(Number.isNaN(rawLimit) ? 50 : rawLimit, 1), 200);
    const rawOffset = Number.parseInt(c.req.query("offset") ?? "", 10);
    const offset = Math.max(Number.isNaN(rawOffset) ? 0 : rawOffset, 0);
    const owner = c.req.query("owner");
    const user = c.get("user");
    const db = c.env.DB;

    // Filter params
    const search = c.req.query("search");
    const modality = c.req.query("modality");
    const author = c.req.query("author");
    const task = c.req.query("task");
    const hasDoi = c.req.query("has_doi") === "true";
    // #869: accept the website FilterSidebar's `has_hed=1` and a `true` for parity.
    const hasHed = c.req.query("has_hed") === "1" || c.req.query("has_hed") === "true";
    // #970: same `1`/`true` convention.
    const dataComplete =
      c.req.query("data_complete") === "1" || c.req.query("data_complete") === "true";
    const recentParam = c.req.query("recent");
    const recent = recentParam ? Number.parseInt(recentParam, 10) : undefined;
    // #653: comma-separated license tiers, OR semantics. Invalid tokens are
    // dropped; an empty result means "no license filter". Filters on the derived
    // datasets.license_tier column so it covers the whole catalog, not just the
    // page the website already fetched.
    const licenseTiers = parseLicenseTierFilter(c.req.query("license"));
    const sort = c.req.query("sort") || "newest";

    if (mine) {
      // --mine: only managed datasets, no catalog
      if (!user) {
        // Distinguish "no auth header sent" from "auth header sent but token
        // invalid/expired/revoked". The latter is what trips CLI users who
        // `nemar auth login` succeeded weeks ago and then had their token
        // revoked or the backend rotated — `isAuthenticated()` is presence-only
        // so the CLI happily fires the request and the user sees a vague
        // "Authentication required" with no hint to re-login.
        // See nemarOrg/nemar-cli#447.
        const attempted = c.get("authAttempted");
        if (attempted) {
          return c.json(
            {
              error:
                "Your API key was rejected. Run 'nemar auth login' to re-authenticate, or 'nemar auth regenerate-key' if your key was revoked.",
            },
            401,
          );
        }
        return c.json({ error: "Authentication required to view your datasets" }, 401);
      }

      const params: (string | number)[] = [status, user.id];
      // Read managed facts from the `datasets` source of truth (#646). 27-column
      // ?mine wire shape (+ #869 HED has_hed/hed_version + #970 total_files/
      // data_complete/bytes_present). latest_version is the most recently minted
      // DOI version (null when none); scripts/hallu-sync.sh reads it to skip the
      // per-dataset /manifest call, so keep the ordering in sync with
      // /datasets/:id/manifest.
      let query = `
        SELECT d.dataset_id, d.name, d.description, d.status, d.visibility,
               d.github_repo, d.concept_doi, d.created_at, d.updated_at,
               u.username AS owner_username,
               d.source, d.source_id,
               COALESCE(d.modalities, '') AS modalities,
               COALESCE(d.subject_count, 0) AS participants,
               COALESCE(d.tasks, '') AS tasks,
               COALESCE(d.authors, '') AS authors,
               COALESCE(d.license, '') AS license,
               COALESCE(d.file_size, 0) AS file_size,
               COALESCE(d.file_size_formatted, '') AS file_size_formatted,
               -- #854: NULL until phase 2/3 populate them; the website's channel +
               -- montage filter reads NULL as "not classified yet".
               d.n_channels,
               d.electrode_system,
               -- #869: HED presence (0/1) + HEDVersion; NULL until phase 2/3
               -- populate. Website reads NULL as "not classified yet".
               d.has_hed,
               d.hed_version,
               -- #970: honest total_files + data completeness/bytes-present; NULL
               -- until reindex/the data-integrity-sweep populate them.
               d.total_files,
               d.data_complete,
               d.bytes_present,
               'managed' AS source_type,
               (
                 SELECT version FROM dataset_versions dv
                 WHERE dv.dataset_id = d.dataset_id
                 ORDER BY created_at DESC
                 LIMIT 1
               ) AS latest_version
        FROM datasets d
        JOIN users u ON d.owner_user_id = u.id
        WHERE d.status = ? AND d.owner_user_id = ?
      `;
      query += buildDatasetFilterClauses(params, {
        search,
        modality,
        author,
        task,
        hasDoi,
        hasHed,
        dataComplete,
        recent,
        licenseTiers,
      });
      query += buildSortClause(sort);

      // --mine path is always authed and per-user; the no-store default
      // set at the top of the handler is the right header here. See #639
      // + the union-path Vary block below for the anonymous-shareable case.
      return executeAndReturn(c, db, query, params, { limit, offset });
    }

    // Single-table read from the `datasets` source of truth (#646). Folded legacy
    // catalog rows are first-class here, discriminated by the sentinel owner
    // (source_type='catalog'); managed datasets are source_type='managed'.
    // 33-column wire shape: the pre-consolidation UNION path + #653 `license` +
    // the #804 citation counts (num_citations / num_dataset_citations /
    // num_datapaper_citations) + #854 channel/montage (n_channels,
    // electrode_system) + #869 HED (has_hed, hed_version) + #970 honest size
    // (total_files, data_complete, bytes_present).
    const params: (string | number)[] = [status];
    let query = `
      SELECT d.dataset_id, d.dataset_id AS id, d.name, d.description, d.status, d.visibility,
             d.github_repo, d.concept_doi, d.concept_doi AS doi, d.created_at, d.updated_at,
             COALESCE(d.uploader, u.username) AS owner_username,
             d.source, d.source_id,
             COALESCE(d.modalities, '') AS modalities,
             COALESCE(d.subject_count, 0) AS participants,
             COALESCE(d.tasks, '') AS tasks,
             COALESCE(d.authors, '') AS authors,
             COALESCE(d.license, '') AS license,
             COALESCE(d.file_size, 0) AS file_size,
             COALESCE(d.file_size_formatted, '') AS file_size_formatted,
             COALESCE(d.num_citations, 0) AS num_citations,
             COALESCE(d.num_dataset_citations, 0) AS num_dataset_citations,
             COALESCE(d.num_datapaper_citations, 0) AS num_datapaper_citations,
             -- #854: NULL until phase 2/3 populate them; the website's channel +
             -- montage filter reads NULL as "not classified yet".
             d.n_channels,
             d.electrode_system,
             -- #869: HED presence (0/1) + HEDVersion; NULL until phase 2/3
             -- populate. Website reads NULL as "not classified yet".
             d.has_hed,
             d.hed_version,
             -- #970: honest total_files + data completeness/bytes-present; NULL
             -- until reindex/the data-integrity-sweep populate them.
             d.total_files,
             d.data_complete,
             d.bytes_present,
             CASE WHEN d.owner_user_id = ${SYSTEM_USER_ID} THEN 'catalog' ELSE 'managed' END AS source_type,
             (
               SELECT version FROM dataset_versions dv
               WHERE dv.dataset_id = d.dataset_id
               ORDER BY created_at DESC
               LIMIT 1
             ) AS latest_version
      FROM datasets d
      LEFT JOIN users u ON d.owner_user_id = u.id
      WHERE d.status = ?
        AND (d.is_sandbox = 0 OR d.is_sandbox IS NULL OR d.is_exemplar = 1)
    `;
    if (!user || !hasRole(user.role, "admin")) {
      query += " AND d.visibility = 'public'";
    }
    if (owner) {
      query += " AND COALESCE(d.uploader, u.username) = ?";
      params.push(owner);
    }
    query += buildDatasetFilterClauses(params, {
      search,
      modality,
      author,
      task,
      hasDoi,
      hasHed,
      dataComplete,
      recent,
      licenseTiers,
    });
    query += buildSortClause(sort);

    // CF edge cache: anonymous list responses are identical for all callers
    // (no private rows leak — the SQL already filters visibility), so share
    // them at the edge. Authed callers may have additional visibility into
    // private rows their owner / collaborator / admin status grants, so
    // their responses stay no-store (the handler-top default). Without the
    // public branch every SSR call from the website's Worker pool hits
    // origin + decrements the per-IP rate-limit bucket; a handful of
    // concurrent visitors of ww2 then trips the cap (#639). Catalog
    // mutations are rare, so s-maxage of 5 min + SWR is plenty fresh.
    //
    // `Vary: Authorization` is required: anonymous and authed callers share
    // the same URL; without Vary an intermediate cache could serve a cached
    // anonymous response to an authed user (or vice versa). CF honors
    // `private` directives natively and won't store authed responses
    // regardless, but Vary is the RFC-correct way to tell every cache on
    // the path (corp proxies, browser cache) that the response key
    // includes the Authorization header.
    if (!user) {
      c.header("Cache-Control", "public, max-age=30, s-maxage=300, stale-while-revalidate=600");
      c.header("Vary", "Authorization");
    }
    return executeAndReturn(c, db, query, params, { limit, offset });
  });

  /**
   * GET /datasets/search - Semantic dataset search
   *
   * Combines three strategies:
   *  - Exact dataset-ID lookup (nm###### / on###### managed mirrors / ds######
   *    legacy or OpenNeuro source) via D1, since embeddings and the FTS index
   *    (name/description/authors/tasks/modalities/readme) do not cover the id, so
   *    a literal id query would otherwise miss -- notably every `on######` mirror,
   *    whose NEMAR-assigned id appears in none of its OpenNeuro-sourced text.
   *  - Vectorize semantic similarity (when bindings are configured).
   *  - D1 LIKE text search as a fallback, also used to backfill semantic
   *    results when Vectorize returns no hits.
   *
   * Semantic and text hits are merged on `id`; semantic ranking is preserved
   * and text-only hits are appended.
   */
  datasetRoutes.get("/search", optionalAuthMiddleware, async (c) => {
    const query = c.req.query("q");
    if (!query) {
      return c.json({ error: "Search query parameter 'q' is required" }, 400);
    }

    const limit = Math.min(Number.parseInt(c.req.query("limit") || "20", 10), 100);
    const modality = c.req.query("modality");
    // #869: same `has_hed=1`/`true` convention as the browse list filter.
    const hasHed = c.req.query("has_hed") === "1" || c.req.query("has_hed") === "true";
    const db = c.env.DB;
    const trimmed = query.trim();
    // Match every NEMAR id shape: nm (native), on (OpenNeuro mirror), and ds
    // (legacy catalog OR an OpenNeuro source id whose mirror is on######). `on`
    // was missing here, so `on######` ids fell through to FTS/semantic, which
    // don't index the id -> zero results (#808). lookupDatasetById resolves both
    // dataset_id and source_id, so `ds######` finds the on mirror too.
    const exactIdMatch = /^(nm|on|ds)\d{6}$/i.test(trimmed);

    // Relevance floor for semantic results. bge-small cosine scores under
    // ~0.65 against this catalog tend to be topic-adjacent noise rather
    // than real matches (e.g. any EEG dataset coming back for "sleep eeg").
    // Override per-request with ?min_score=0 to inspect the long tail.
    const DEFAULT_MIN_SCORE = 0.65;
    const minScoreParam = c.req.query("min_score");
    const parsedMinScore =
      minScoreParam === undefined ? Number.NaN : Number.parseFloat(minScoreParam);
    const minScore = Number.isFinite(parsedMinScore)
      ? Math.max(0, Math.min(parsedMinScore, 1))
      : DEFAULT_MIN_SCORE;

    const applyModality = (rows: SearchResult[]): SearchResult[] => {
      if (!modality) return rows;
      const mod = modality.toLowerCase();
      return rows.filter((r) => r.modalities.toLowerCase().includes(mod));
    };

    // #869: client-side HED filter (the search projection can't use the SQL clause);
    // mirrors applyModality. `has_hed === 1` only -> excludes 0 and NULL/undefined.
    const applyHasHed = (rows: SearchResult[]): SearchResult[] =>
      hasHed ? rows.filter((r) => r.has_hed === 1) : rows;

    // FTS5/exact hits carry score=1.0, so this cosine floor only filters the
    // semantic component. Applied BEFORE RRF fusion; finalize() does not re-floor
    // the fused scores.
    const applyMinScore = (rows: SearchResult[]): SearchResult[] =>
      minScore <= 0 ? rows : rows.filter((r) => r.score >= minScore);

    // #646 hybrid path: exact-id -> (semantic id-only ∪ FTS5) fused by RRF.
    const finalize = (rows: SearchResult[], method: string) => {
      const filtered = applyHasHed(applyModality(rows));
      return c.json({
        results: filtered.slice(0, limit),
        count: filtered.length,
        method,
        min_score: minScore,
      });
    };
    try {
      if (exactIdMatch) {
        const idHit = await lookupDatasetById(db, trimmed.toLowerCase());
        if (idHit) return finalize([idHit], "exact_id");
      }
      // Tier-specific log so a failure here is distinguishable from the
      // semantic/hydration tiers; re-throw so the outer catch still degrades.
      const lexical = await ftsSearch(db, trimmed, limit * 2).catch((ftsErr) => {
        console.error(
          `[search] FTS tier failed: ${ftsErr instanceof Error ? ftsErr.message : String(ftsErr)}`,
        );
        throw ftsErr;
      });
      if (!c.env.AI || !c.env.VECTORIZE) {
        return finalize(lexical, "text");
      }
      let semantic: SearchResult[] = [];
      try {
        semantic = await semanticSearchHydrated(c.env.AI, c.env.VECTORIZE, db, trimmed, limit * 2);
      } catch (embErr) {
        console.error("[search] semantic tier failed, using FTS only:", embErr);
        return finalize(lexical, "text_fallback");
      }
      const semanticFiltered = applyMinScore(semantic);
      if (semanticFiltered.length === 0) {
        return finalize(lexical, "text_fallback");
      }
      return finalize(rrfFuse(semanticFiltered, lexical), "semantic");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("Dataset search failed:", msg);
      // Only the expected missing-FTS-table case degrades to "unavailable";
      // any other structural error is a real 500 (don't mask it).
      if (msg.includes("no such table: datasets_fts")) {
        return c.json({ results: [], count: 0, method: "unavailable" });
      }
      return c.json({ error: "Search failed", details: msg }, 500);
    }
  });

  /**
   * GET /datasets/resolve/:sourceId - Resolve an OpenNeuro source ID to its NEMAR counterpart
   *
   * Returns the NEMAR dataset_id if a dataset was imported from the given source_id.
   * Used by the CLI to redirect ds###### downloads to the NEMAR backend when available.
   * Returns { found: true, ... } on match, or { found: false } when no match exists.
   * Always returns 200 (except on validation or server errors).
   */
  datasetRoutes.get("/resolve/:sourceId", optionalAuthMiddleware, async (c) => {
    // Safe default: validation 400s + the catch's 500 emit no-store. The
    // success branch below overrides for the resolved-match case only —
    // an unresolved `{ found: false }` doesn't get cached either, because
    // a dataset could publish moments later and we don't want CF to keep
    // serving the negative answer through the s-maxage + SWR window.
    c.header("Cache-Control", "no-store");
    const sourceId = c.req.param("sourceId");

    if (!/^ds\d{6}$/.test(sourceId)) {
      return c.json({ error: "Invalid source ID format. Expected ds followed by 6 digits." }, 400);
    }

    const db = c.env.DB;

    try {
      const match = await db
        .prepare(
          `SELECT d.dataset_id, d.name, d.github_repo, u.username as owner_username
           FROM datasets d
           JOIN users u ON d.owner_user_id = u.id
           WHERE d.source_id = ? AND d.status = 'active' AND d.visibility = 'public'
           LIMIT 1`,
        )
        .bind(sourceId)
        .first<{
          dataset_id: string;
          name: string;
          github_repo: string | null;
          owner_username: string;
        }>();

      if (!match) {
        // Negative result stays no-store (handler default). A dataset
        // could publish moments later; CF holding `found: false` for the
        // s-maxage window would mask that for everyone.
        return c.json({ found: false });
      }

      // CF edge cache: the query is restricted to `visibility = 'public'`
      // and `status = 'active'`, so the response is identical for any
      // caller regardless of auth — safe to share at the edge. The
      // canonical-resolve mapping changes only when a dataset is
      // re-published, which is rare; s-maxage of 5 min + SWR is plenty.
      // Issue #639.
      c.header("Cache-Control", "public, max-age=30, s-maxage=300, stale-while-revalidate=600");
      return c.json({
        found: true,
        dataset_id: match.dataset_id,
        name: match.name,
        github_repo: match.github_repo,
        owner_username: match.owner_username,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[resolve] Failed to resolve source_id ${sourceId}:`, msg);
      return c.json({ error: "Failed to resolve dataset", details: msg }, 500);
    }
  });

  /**
   * GET /datasets/:id - Get dataset details
   *
   * Visibility rules:
   * - Public datasets: accessible to everyone
   * - Private datasets: accessible to owner, admin, or collaborator
   */
  datasetRoutes.get("/:id", optionalAuthMiddleware, async (c) => {
    // Safe Cache-Control default: every early-return error path (400 /
    // 404 / 401) inherits no-store. The anonymous-success branch overrides
    // below with `public + Vary: Authorization`. Hono replaces same-named
    // headers, so the later set wins. Issue #639.
    c.header("Cache-Control", "no-store");
    const datasetId = c.req.param("id");
    const user = c.get("user");
    const db = c.env.DB;

    if (!isValidDatasetId(datasetId)) {
      return c.json({ error: "Invalid dataset ID format" }, 400);
    }

    const dataset = await db
      .prepare(
        `
      SELECT
        d.*,
        -- Contract parity with the list endpoints (#853): expose subject_count
        -- under its API name and compute latest_version, which aren't raw
        -- columns. Kept ALONGSIDE d.* so existing consumers of the raw
        -- subject_count column are unaffected (additive, no regression).
        COALESCE(d.subject_count, 0) AS participants,
        (
          SELECT version FROM dataset_versions dv
          WHERE dv.dataset_id = d.dataset_id
          ORDER BY created_at DESC
          LIMIT 1
        ) AS latest_version,
        u.username as owner_username,
        u.github_username as owner_github
      FROM datasets d
      JOIN users u ON d.owner_user_id = u.id
      WHERE d.dataset_id = ?
    `,
      )
      .bind(datasetId)
      .first();

    if (!dataset) {
      return c.json({ error: "Dataset not found" }, 404);
    }

    // Enforce visibility restrictions for private datasets
    if (dataset.visibility !== "public") {
      if (!user || (!hasRole(user.role, "admin") && user.id !== dataset.owner_user_id)) {
        // Check if user is a collaborator before returning 404
        const isCollaborator = user
          ? await db
              .prepare(
                "SELECT 1 FROM dataset_collaborators dc JOIN datasets d ON dc.dataset_id = d.id WHERE d.dataset_id = ? AND dc.user_id = ?",
              )
              .bind(datasetId, user.id)
              .first()
          : null;
        if (!isCollaborator) {
          // If the caller sent a Bearer token that was rejected, give a
          // re-login hint instead of "Dataset not found" — same bug class
          // as nemarOrg/nemar-cli#447 but for the single-dataset route.
          if (!user && c.get("authAttempted")) {
            return c.json(
              {
                error:
                  "Your API key was rejected. Run 'nemar auth login' to re-authenticate, or 'nemar auth regenerate-key' if your key was revoked.",
              },
              401,
            );
          }
          return c.json({ error: "Dataset not found" }, 404);
        }
      }
    }

    // CF edge cache only for anonymous traffic. Authed responses may
    // include private datasets that this user can see (owner, collaborator,
    // admin) — they stay no-store (the handler default). `Vary: Authorization`
    // tells intermediate caches the response key depends on the auth
    // header, so an anonymous cached response is never served to an authed
    // caller and vice versa. See the list handler (GET /) above for the
    // matching pattern + the Worker-egress-IP-pooling rationale (#639).
    if (!user) {
      c.header("Cache-Control", "public, max-age=30, s-maxage=300, stale-while-revalidate=600");
      c.header("Vary", "Authorization");
    }
    return c.json({ dataset: withCanonicalLatestVersion(dataset) });
  });
}
