/**
 * Dataset Search Service
 *
 * Hybrid search over the `datasets` source of truth (#646): an id-only
 * Vectorize index (semanticSearchHydrated -> D1 hydration) fused with a
 * driftless FTS5 lexical index (ftsSearch) via reciprocal-rank fusion.
 * Vectors carry zero facts; every display field is hydrated from `datasets`.
 */

import { type DatasetFilterOptions, buildDatasetFilterClauses } from "./dataset-filters";

const EMBEDDING_MODEL = "@cf/baai/bge-small-en-v1.5";

/**
 * Fixed candidate-window ceilings for GET /datasets/search (#1145, epic #1144
 * phase 1). Both legs used to fetch `limit * 2` candidates, which made the
 * reported `count` a function of the caller's page size rather than a
 * property of the query -- the more selective the filter, the worse the
 * drift. Pinning both windows to constants (independent of `limit`) is what
 * makes `count` -- now computed once by `countSearchMatches` -- stable across
 * every page size.
 */
// Also the ceiling `buildInPlaceholders` hard-throws past -- do not raise this
// without raising that too.
export const SEMANTIC_TOPK = 100;
export const SEARCH_CANDIDATE_CEILING = 300;

export interface SearchResult {
  id: string;
  name: string;
  modalities: string;
  participants: number;
  doi: string;
  tasks: string;
  authors: string;
  /** HED presence (#869): 1 = has HED, 0 = checked/none, null = not classified. */
  has_hed?: number | null;
  score: number;
  /** FTS5 highlight (#646). Additive-optional; ignored by existing CLI/website
   *  clients. */
  snippet?: string;
}

export interface DatasetEmbedRow {
  name?: string | null;
  modalities?: string | null;
  tasks?: string | null;
  authors?: string | null;
  readme?: string | null;
}

/**
 * Build the embedding text for a `datasets` row -- the single embed-text
 * builder (#646); reembedDatasetVector is the only writer of dataset vectors.
 */
export function buildDatasetEmbedText(row: DatasetEmbedRow): string {
  return [
    row.name ?? "",
    row.modalities ? `Modalities: ${row.modalities}` : "",
    row.tasks ? `Tasks: ${row.tasks}` : "",
    row.authors ? `Authors: ${row.authors}` : "",
    row.readme ? row.readme.slice(0, 1000) : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Re-embed a single dataset's Vectorize vector from its current `datasets`
 * row (#646). The vector is **id-only**: it carries no metadata, so the upsert
 * overwrites any stale 6-field metadata from earlier phases with `{}`. Every
 * display field is hydrated from `datasets` by semanticSearchHydrated, so no
 * dataset fact is duplicated into the vector index.
 *
 * Fire-once + fully guarded: returns false without throwing when AI/Vectorize
 * are unconfigured, the row is missing, or any step fails -- so it can be
 * awaited inline at the enrich/reindex hooks without ever failing the request.
 * Returns true only when the vector was upserted and the dirty flag cleared.
 */
export async function reembedDatasetVector(
  db: D1Database,
  ai: Ai | undefined,
  vectorize: VectorizeIndex | undefined,
  datasetId: string,
): Promise<boolean> {
  if (!ai || !vectorize) {
    console.log(`[reembed] AI/Vectorize not configured, skipping ${datasetId}`);
    return false;
  }
  try {
    const row = await db
      .prepare("SELECT name, modalities, tasks, authors, readme FROM datasets WHERE dataset_id = ?")
      .bind(datasetId)
      .first<DatasetEmbedRow>();
    if (!row) {
      console.warn(`[reembed] No datasets row for ${datasetId}, skipping`);
      return false;
    }
    const text = buildDatasetEmbedText(row);
    if (!text.trim()) {
      console.warn(`[reembed] Empty embed text for ${datasetId} (all fields blank), skipping`);
      return false;
    }

    const embedding = await ai.run(EMBEDDING_MODEL, { text: [text] });
    const values = "data" in embedding ? embedding.data?.[0] : undefined;
    if (!values) {
      console.error(`[reembed] Empty embedding for ${datasetId}`);
      return false;
    }
    // id-only vector: empty metadata clears any stale 6-field metadata.
    await vectorize.upsert([{ id: datasetId, values, metadata: {} }]);
    // #646 Phase 4: the vector is now fresh, so clear the dirty flag. A failed
    // embed above leaves embedding_dirty=1 for the next drain. embedding_dirty
    // is in no trigger OF list, so this UPDATE doesn't re-fire the triggers.
    await db
      .prepare("UPDATE datasets SET embedding_dirty = 0 WHERE dataset_id = ?")
      .bind(datasetId)
      .run();
    return true;
  } catch (err) {
    console.error(
      `[reembed] Failed for ${datasetId}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

/**
 * #646 Phase 4 drain: re-embed the datasets whose vectors are stale
 * (embedding_dirty=1), oldest-updated first, up to `limit`. Each successful
 * reembedDatasetVector clears the flag; failures stay dirty for the next run.
 * Used by the scheduled() cron. Fully guarded (never throws).
 */
export async function drainEmbeddingDirty(
  db: D1Database,
  ai: Ai | undefined,
  vectorize: VectorizeIndex | undefined,
  limit = 50,
): Promise<{ scanned: number; embedded: number }> {
  if (!ai || !vectorize) {
    return { scanned: 0, embedded: 0 };
  }
  try {
    // Only embed searchable rows. A private/archived/sandbox dataset can be
    // marked dirty by the metadata trigger; embedding it would put it in the
    // (public) Vectorize index. They stay dirty until they become public.
    const rows = await db
      .prepare(
        `SELECT dataset_id FROM datasets
         WHERE embedding_dirty = 1
           AND status = 'active' AND visibility = 'public'
           AND (is_sandbox = 0 OR is_sandbox IS NULL OR is_exemplar = 1)
         ORDER BY updated_at LIMIT ?`,
      )
      .bind(limit)
      .all<{ dataset_id: string }>();
    const ids = (rows.results || []).map((r) => r.dataset_id);
    let embedded = 0;
    const failed: string[] = [];
    for (const id of ids) {
      if (await reembedDatasetVector(db, ai, vectorize, id)) embedded++;
      else failed.push(id);
    }
    console.log(`[embed-cron] drained ${embedded}/${ids.length} dirty vectors`);
    if (failed.length > 0) {
      console.warn(`[embed-cron] ${failed.length} ids failed to embed: ${failed.join(", ")}`);
    }
    // Record a summary so persistent drain failures / embedding drift are
    // admin-queryable via audit_log, not just visible in Worker console logs
    // (#646 review). Only when there was work, to avoid a daily no-op row.
    if (ids.length > 0 || failed.length > 0) {
      await writeEmbedDrainAudit(db, { scanned: ids.length, embedded, failed });
    }
    return { scanned: ids.length, embedded };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[embed-cron] drain failed: ${msg}`);
    await writeEmbedDrainAudit(db, { scanned: 0, embedded: 0, error: msg });
    return { scanned: 0, embedded: 0 };
  }
}

/**
 * Guarded audit-log write for the embed drain. drainEmbeddingDirty never
 * throws, so this swallows its own errors (logging them) rather than bubbling.
 */
async function writeEmbedDrainAudit(
  db: D1Database,
  details: { scanned: number; embedded: number; failed?: string[]; error?: string },
): Promise<void> {
  try {
    await db
      .prepare("INSERT INTO audit_log (action, details) VALUES (?, ?)")
      .bind(
        "embed_drain",
        JSON.stringify({
          scanned: details.scanned,
          embedded: details.embedded,
          failed: details.failed?.length ?? 0,
          failed_ids: details.failed?.slice(0, 20) ?? [],
          error: details.error,
        }),
      )
      .run();
  } catch (err) {
    console.error(
      `[embed-cron] failed to write drain audit log: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// #646: id-only Vectorize + D1 hydration, FTS5 lexical search, and
// reciprocal-rank-fusion hybrid -- all reading from the `datasets` source of
// truth (the single source after the nemar_catalog drop).
// ---------------------------------------------------------------------------

/** Build a comma-joined `?` placeholder list for a SQL `IN (...)`. Bounded to
 *  D1's safe range (and the topK ceiling); throws outside 1..100. */
export function buildInPlaceholders(n: number): string {
  if (!Number.isInteger(n) || n < 1 || n > 100) {
    throw new Error(`buildInPlaceholders: n must be an integer in 1..100, got ${n}`);
  }
  return new Array(n).fill("?").join(",");
}

/** Build an injection-safe FTS5 MATCH expression: tokenize to alphanumerics
 *  (dropping all FTS5 operator chars), quote each token and prefix-match it,
 *  OR them for recall. Returns null when there is nothing to match. */
export function buildFtsMatch(query: string): string | null {
  const tokens = query
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter((t) => t.length >= 2);
  if (tokens.length === 0) return null;
  return tokens.map((t) => `"${t}"*`).join(" OR ");
}

interface HydrateRow {
  id: string;
  name: string | null;
  modalities: string | null;
  participants: number | null;
  doi: string | null;
  tasks: string | null;
  authors: string | null;
  has_hed: number | null;
}

const toResult = (row: HydrateRow, score: number, snippet?: string): SearchResult => ({
  id: row.id,
  name: row.name || "",
  modalities: row.modalities || "",
  participants: row.participants || 0,
  doi: row.doi || "",
  tasks: row.tasks || "",
  authors: row.authors || "",
  has_hed: row.has_hed ?? null,
  score,
  ...(snippet ? { snippet } : {}),
});

/** Hydrate ordered dataset ids from the `datasets` source of truth, preserving
 *  the input ranking and dropping ids with no live row. The actual bug fix:
 *  display fields come from the row, not stale Vectorize metadata. Filters to
 *  public/active/non-sandbox so a stale or mistakenly-embedded vector for a
 *  private/archived row can never surface in the (anonymous) search. */
export async function hydrateDatasetsByIds(
  db: D1Database,
  ids: string[],
  filters: DatasetFilterOptions = {},
): Promise<SearchResult[]> {
  if (ids.length === 0) return [];
  const params: (string | number)[] = [...ids];
  const filterClauses = buildDatasetFilterClauses(params, filters);
  const results = await db
    .prepare(
      `SELECT d.dataset_id AS id, d.name, d.modalities, d.subject_count AS participants,
              d.concept_doi AS doi, d.tasks, d.authors, d.has_hed
       FROM datasets d
       WHERE d.dataset_id IN (${buildInPlaceholders(ids.length)})
         AND d.status = 'active' AND d.visibility = 'public'
         AND (d.is_sandbox = 0 OR d.is_sandbox IS NULL OR d.is_exemplar = 1)${filterClauses}`,
    )
    .bind(...params)
    .all<HydrateRow>();
  const byId = new Map((results.results || []).map((r) => [r.id, r]));
  return ids
    .map((id) => byId.get(id))
    .filter((r): r is HydrateRow => Boolean(r))
    .map((row) => toResult(row, 0));
}

/** Exact dataset-id lookup from `datasets` for the search exact-id tier.
 *  Public + active only (the search endpoint is anonymous), so it can't leak a
 *  private/archived row. */
export async function lookupDatasetById(
  db: D1Database,
  datasetId: string,
  filters: DatasetFilterOptions = {},
): Promise<SearchResult | null> {
  // Match the dataset_id OR the source_id: an OpenNeuro source id (e.g.
  // ds005342) resolves to its managed mirror (on005342) even though the legacy
  // ds shadow row was deleted at import. Prefer a managed row (owner != -1) over
  // a legacy catalog shadow if both somehow match.
  const params: (string | number)[] = [datasetId, datasetId];
  // #1145: the exact-id tier used to ignore filters entirely (`search
  // nm000111 --modality meg` returned the hit regardless of modality). Apply
  // the same clauses as the other tiers so an id hit that fails the filter is
  // not returned.
  const filterClauses = buildDatasetFilterClauses(params, filters);
  const row = await db
    .prepare(
      `SELECT d.dataset_id AS id, d.name, d.modalities, d.subject_count AS participants,
              d.concept_doi AS doi, d.tasks, d.authors, d.has_hed
       FROM datasets d
       WHERE (d.dataset_id = ? OR d.source_id = ?) AND d.status = 'active'
         AND (d.is_sandbox = 0 OR d.is_sandbox IS NULL OR d.is_exemplar = 1) AND d.visibility = 'public'${filterClauses}
       ORDER BY (d.owner_user_id != -1) DESC
       LIMIT 1`,
    )
    .bind(...params)
    .first<HydrateRow>();
  return row ? toResult(row, 1.0) : null;
}

/** Semantic search, id-only: query Vectorize with `returnMetadata:'none'`
 *  (lifts the topK ceiling to 100), then hydrate from `datasets` by id and
 *  re-attach the vector scores in rank order. */
export async function semanticSearchHydrated(
  ai: Ai,
  vectorize: VectorizeIndex,
  db: D1Database,
  query: string,
  topK = 20,
  filters: DatasetFilterOptions = {},
): Promise<SearchResult[]> {
  const k = Math.min(Math.max(topK, 1), 100);
  const embedding = await ai.run(EMBEDDING_MODEL, { text: [query] });
  const embeddingData = "data" in embedding ? embedding.data : undefined;
  if (!embeddingData?.[0]) {
    throw new Error("Failed to generate query embedding");
  }
  const results = await vectorize.query(embeddingData[0], { topK: k, returnMetadata: "none" });
  const ranked = results.matches.map((m) => ({ id: m.id, score: Math.round(m.score * 100) / 100 }));
  if (ranked.length === 0) return [];
  const scoreById = new Map(ranked.map((r) => [r.id, r.score]));
  // The index is id-only (ADR 0003), so a modality/hasHed filter can't be
  // applied inside Vectorize; it lands here, in the D1 hydration, which
  // already carries the public/active/non-sandbox predicate.
  const hydrated = await hydrateDatasetsByIds(
    db,
    ranked.map((r) => r.id),
    filters,
  );
  // Vector ids with no live `datasets` row are dropped (correct: a vector for a
  // deleted dataset must not surface). Log when it happens so index drift /
  // stale vectors are observable rather than silently shrinking results.
  if (hydrated.length < ranked.length) {
    console.warn(
      `[search] ${ranked.length - hydrated.length}/${ranked.length} vector ids had no datasets row (stale vectors or recent deletes)`,
    );
  }
  return hydrated.map((r) => ({ ...r, score: scoreById.get(r.id) ?? 0 }));
}

/** FTS5 lexical search over `datasets_fts` (bm25 ranking + readme snippet),
 *  hydrating display fields from the joined `datasets` row. */
export async function ftsSearch(
  db: D1Database,
  query: string,
  limit = 20,
  filters: DatasetFilterOptions = {},
): Promise<SearchResult[]> {
  const match = buildFtsMatch(query);
  if (!match) return [];
  const params: (string | number)[] = [match];
  const filterClauses = buildDatasetFilterClauses(params, filters);
  const results = await db
    .prepare(
      `SELECT d.dataset_id AS id, d.name, d.modalities, d.subject_count AS participants,
              d.concept_doi AS doi, d.tasks, d.authors, d.has_hed,
              snippet(datasets_fts, 5, '<mark>', '</mark>', '…', 12) AS snippet
       FROM datasets_fts
       JOIN datasets d ON d.id = datasets_fts.rowid
       WHERE datasets_fts MATCH ?
         AND d.status = 'active' AND (d.is_sandbox = 0 OR d.is_sandbox IS NULL OR d.is_exemplar = 1)
         AND d.visibility = 'public'${filterClauses}
       ORDER BY bm25(datasets_fts)
       LIMIT ?`,
    )
    .bind(...params, limit)
    .all<HydrateRow & { snippet: string | null }>();
  return (results.results || []).map((row) => toResult(row, 1.0, row.snippet || undefined));
}

/**
 * Exact total for GET /datasets/search (#1145, epic #1144 phase 1): one
 * `COUNT(*)` over the union predicate the two retrieval legs draw from, so
 * `count` describes the same population `results` is sliced from instead of
 * drifting with page size (the bug this phase fixes). Each disjunct is
 * omitted when its input is empty -- a punctuation-only query has no FTS
 * match expression, a failed/empty semantic tier has no ids -- and both empty
 * yields `count = 0` without a query. `semanticIds` is expected to already be
 * capped at `SEMANTIC_TOPK` (100), which is also `buildInPlaceholders`' hard
 * ceiling.
 */
export async function countSearchMatches(
  db: D1Database,
  ftsMatch: string | null,
  semanticIds: string[],
  filters: DatasetFilterOptions = {},
): Promise<number> {
  const disjuncts: string[] = [];
  const params: (string | number)[] = [];
  if (ftsMatch) {
    disjuncts.push("d.id IN (SELECT rowid FROM datasets_fts WHERE datasets_fts MATCH ?)");
    params.push(ftsMatch);
  }
  if (semanticIds.length > 0) {
    disjuncts.push(`d.dataset_id IN (${buildInPlaceholders(semanticIds.length)})`);
    params.push(...semanticIds);
  }
  if (disjuncts.length === 0) return 0;
  const filterClauses = buildDatasetFilterClauses(params, filters);
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS total FROM datasets d
       WHERE d.status = 'active' AND d.visibility = 'public'
         AND (d.is_sandbox = 0 OR d.is_sandbox IS NULL OR d.is_exemplar = 1)
         AND (${disjuncts.join(" OR ")})${filterClauses}`,
    )
    .bind(...params)
    .first<{ total: number }>();
  return row?.total ?? 0;
}

/** Reciprocal-rank fusion of semantic + lexical result lists (k=60). Dedups by
 *  id, keeps the FTS snippet, and sorts by fused score. */
export function rrfFuse(semantic: SearchResult[], lexical: SearchResult[], k = 60): SearchResult[] {
  const fused = new Map<string, number>();
  const byId = new Map<string, SearchResult>();
  for (const list of [semantic, lexical]) {
    list.forEach((r, i) => {
      fused.set(r.id, (fused.get(r.id) ?? 0) + 1 / (k + i + 1));
      const existing = byId.get(r.id);
      if (!existing) byId.set(r.id, { ...r });
      else if (!existing.snippet && r.snippet) existing.snippet = r.snippet;
    });
  }
  return Array.from(byId.values())
    .map((r) => ({ ...r, score: Math.round((fused.get(r.id) ?? 0) * 10000) / 10000 }))
    .sort((a, b) => b.score - a.score);
}

/** Options for {@link executeDatasetSearch}. HTTP-layer concerns (parsing
 *  query-string values, defaulting) are the caller's job; everything here is
 *  already a validated, typed value. */
export interface ExecuteDatasetSearchOptions {
  query: string;
  filters: DatasetFilterOptions;
  limit: number;
  offset: number;
  minScore: number;
}

/** Return shape of {@link executeDatasetSearch} -- the full GET
 *  /datasets/search envelope, built the same way regardless of which tier
 *  answered. */
export interface DatasetSearchEnvelope {
  results: SearchResult[];
  count: number;
  returned: number;
  offset: number;
  limit: number;
  candidate_ceiling: number;
  method: string;
  min_score: number;
}

/**
 * GET /datasets/search orchestration (#1145, epic #1144 phase 1), extracted
 * out of the route handler into a pure, directly-testable function -- the
 * handler now only parses query params and translates a thrown error into a
 * 500. This is what a regression test needs to actually exercise: calling
 * the individual retrieval functions in a loop over `limit` does NOT
 * reproduce the count-drifts-with-page-size bug, because that bug lived in
 * this orchestration (the old `ftsSearch(db, q, limit * 2)` /
 * `semanticSearchHydrated(..., limit * 2)` calls and `count: filtered.length`
 * taken from that limit-derived window), not in any individual query.
 *
 * Combines three strategies:
 *  - Exact dataset-ID lookup (nm###### / on###### managed mirrors / ds######
 *    legacy or OpenNeuro source) via D1, since embeddings and the FTS index
 *    (name/description/authors/tasks/modalities/readme) do not cover the id, so
 *    a literal id query would otherwise miss -- notably every `on######` mirror,
 *    whose NEMAR-assigned id appears in none of its OpenNeuro-sourced text.
 *  - Vectorize semantic similarity (when `ai`/`vectorize` are provided).
 *  - D1 LIKE/FTS text search as a fallback, also used to backfill semantic
 *    results when Vectorize returns no hits.
 *
 * `modality`/`has_hed` filter in SQL, pushed into every tier (including the
 * exact-id lookup) via `filters`, rather than being re-applied in JS on the
 * response. `count` is an exact `COUNT(*)` over the same union predicate
 * (`countSearchMatches`), independent of `limit`/`offset`; the candidate
 * windows the two legs fetch are fixed (`SEARCH_CANDIDATE_CEILING`,
 * `SEMANTIC_TOPK`) so `count` no longer drifts with page size. `results` is
 * the fused list sliced to `[offset, offset + limit)`.
 *
 * Preserved unchanged: exact-id tier ordering, RRF fusion, the
 * `text`/`text_fallback`/`semantic`/`exact_id`/`unavailable` method values and
 * the conditions that select them. Only the expected missing-FTS-table error
 * degrades (to `"unavailable"`, `count: 0`); any other error is re-thrown for
 * the caller to translate into a 500 -- it is not masked here.
 */
export async function executeDatasetSearch(
  db: D1Database,
  ai: Ai | undefined,
  vectorize: VectorizeIndex | undefined,
  opts: ExecuteDatasetSearchOptions,
): Promise<DatasetSearchEnvelope> {
  const { filters, limit, offset, minScore } = opts;
  const trimmed = opts.query.trim();
  // Match every NEMAR id shape: nm (native), on (OpenNeuro mirror), and ds
  // (legacy catalog OR an OpenNeuro source id whose mirror is on######). `on`
  // was missing here, so `on######` ids fell through to FTS/semantic, which
  // don't index the id -> zero results (#808). lookupDatasetById resolves both
  // dataset_id and source_id, so `ds######` finds the on mirror too.
  const exactIdMatch = /^(nm|on|ds)\d{6}$/i.test(trimmed);

  // FTS5/exact hits carry score=1.0, so this cosine floor only filters the
  // semantic component. Applied BEFORE RRF fusion; the envelope builder does
  // not re-floor the fused scores.
  const applyMinScore = (rows: SearchResult[]): SearchResult[] =>
    minScore <= 0 ? rows : rows.filter((r) => r.score >= minScore);

  // Every return path builds the envelope through this one helper so the
  // shape is uniform (the pre-#1145 `unavailable` branch omitted `min_score`
  // entirely).
  const buildEnvelope = (
    rows: SearchResult[],
    method: string,
    count: number,
  ): DatasetSearchEnvelope => {
    const page = rows.slice(offset, offset + limit);
    return {
      results: page,
      count,
      returned: page.length,
      offset,
      limit,
      candidate_ceiling: SEARCH_CANDIDATE_CEILING,
      method,
      min_score: minScore,
    };
  };

  try {
    if (exactIdMatch) {
      // The exact-id tier respects filters too (#1145): an id hit failing the
      // modality/hasHed filter falls through to the fused tiers below instead
      // of always being returned.
      const idHit = await lookupDatasetById(db, trimmed.toLowerCase(), filters);
      if (idHit) return buildEnvelope([idHit], "exact_id", 1);
    }
    const ftsMatch = buildFtsMatch(trimmed);
    // Tier-specific log so a failure here is distinguishable from the
    // semantic/hydration tiers; re-throw so the outer catch still degrades.
    // Fetches a fixed SEARCH_CANDIDATE_CEILING candidates regardless of
    // `limit`, so the population `count` describes doesn't shrink at small
    // page sizes.
    const lexical = await ftsSearch(db, trimmed, SEARCH_CANDIDATE_CEILING, filters).catch(
      (ftsErr) => {
        console.error(
          `[search] FTS tier failed: ${ftsErr instanceof Error ? ftsErr.message : String(ftsErr)}`,
        );
        throw ftsErr;
      },
    );
    if (!ai || !vectorize) {
      const count = await countSearchMatches(db, ftsMatch, [], filters);
      return buildEnvelope(lexical, "text", count);
    }
    let semantic: SearchResult[] = [];
    try {
      // Fixed SEMANTIC_TOPK (also Vectorize's returnMetadata:'none' topK
      // ceiling), not `limit * 2`.
      semantic = await semanticSearchHydrated(ai, vectorize, db, trimmed, SEMANTIC_TOPK, filters);
    } catch (embErr) {
      console.error("[search] semantic tier failed, using FTS only:", embErr);
      const count = await countSearchMatches(db, ftsMatch, [], filters);
      return buildEnvelope(lexical, "text_fallback", count);
    }
    const semanticFiltered = applyMinScore(semantic);
    if (semanticFiltered.length === 0) {
      const count = await countSearchMatches(db, ftsMatch, [], filters);
      return buildEnvelope(lexical, "text_fallback", count);
    }
    // The union `count` describes is exactly what the fused results are
    // drawn from: the FTS match plus the (min-score-filtered) semantic ids.
    const count = await countSearchMatches(
      db,
      ftsMatch,
      semanticFiltered.map((r) => r.id),
      filters,
    );
    return buildEnvelope(rrfFuse(semanticFiltered, lexical), "semantic", count);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Dataset search failed:", msg);
    // Only the expected missing-FTS-table case degrades to "unavailable";
    // any other structural error is re-thrown (the caller turns it into a
    // 500 -- it must not be masked here).
    if (msg.includes("no such table: datasets_fts")) {
      return buildEnvelope([], "unavailable", 0);
    }
    throw err;
  }
}
