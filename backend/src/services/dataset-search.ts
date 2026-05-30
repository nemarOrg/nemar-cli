/**
 * Dataset Search Service
 *
 * Provides semantic search over the NEMAR dataset catalog using
 * Cloudflare Workers AI (embeddings) and Vectorize (vector similarity).
 * Falls back to D1 LIKE queries when Vectorize is unavailable.
 */

const EMBEDDING_MODEL = "@cf/baai/bge-small-en-v1.5";

export interface SearchResult {
  id: string;
  name: string;
  modalities: string;
  participants: number;
  doi: string;
  tasks: string;
  authors: string;
  score: number;
  /** FTS5 highlight (#646 Phase 3 hybrid). Additive-optional; ignored by
   *  existing CLI/website clients. */
  snippet?: string;
}

/**
 * Semantic search: embed the query and find similar datasets via Vectorize.
 */
export async function semanticSearch(
  ai: Ai,
  vectorize: VectorizeIndex,
  query: string,
  topK = 20,
): Promise<SearchResult[]> {
  // Embed the search query
  const embedding = await ai.run(EMBEDDING_MODEL, { text: [query] });
  const embeddingData = "data" in embedding ? embedding.data : undefined;
  if (!embeddingData?.[0]) {
    throw new Error("Failed to generate query embedding");
  }

  // Query Vectorize for similar vectors
  const results = await vectorize.query(embeddingData[0], {
    topK,
    returnMetadata: "all",
  });

  return results.matches.map((match) => ({
    id: match.id,
    name: (match.metadata?.name as string) || "",
    modalities: (match.metadata?.modalities as string) || "",
    participants: (match.metadata?.participants as number) || 0,
    doi: (match.metadata?.doi as string) || "",
    tasks: (match.metadata?.tasks as string) || "",
    authors: (match.metadata?.authors as string) || "",
    score: Math.round(match.score * 100) / 100,
  }));
}

export interface DatasetEmbedRow {
  name?: string | null;
  modalities?: string | null;
  tasks?: string | null;
  authors?: string | null;
  readme?: string | null;
  subject_count?: number | null;
  concept_doi?: string | null;
}

/**
 * Build the embedding text for a `datasets` row. Mirrors catalog-sync's
 * buildEmbeddingText so vectors stay consistent across both writers.
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
 * Build the Vectorize metadata for a `datasets` row. These are the six display
 * fields semanticSearch() reads off `match.metadata.*` today, so re-embedding
 * with the CURRENT row values is what actually fixes the stale-vector bug
 * (e.g. nm000156 returning an old title). Phase 3 switches reads to id-only +
 * D1 hydration and drops this metadata; until then it must stay populated or
 * semantic results render blank.
 */
export function buildDatasetVectorMetadata(row: DatasetEmbedRow): Record<string, string | number> {
  return {
    name: row.name ?? "",
    modalities: row.modalities ?? "",
    participants: row.subject_count ?? 0,
    doi: row.concept_doi ?? "",
    tasks: row.tasks ?? "",
    authors: row.authors ?? "",
  };
}

/**
 * Re-embed a single dataset's Vectorize vector from its current `datasets`
 * row (#646 Phase 2). Writes FRESH 6-field metadata (the fields semanticSearch
 * reads) so a re-embed both refreshes the vector and corrects stale display
 * metadata. The metadata removal + id-only hydration lands atomically in
 * Phase 3 (it can't be cleared here while semanticSearch still reads metadata).
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
      .prepare(
        "SELECT name, modalities, tasks, authors, readme, subject_count, concept_doi FROM datasets WHERE dataset_id = ?",
      )
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
    await vectorize.upsert([{ id: datasetId, values, metadata: buildDatasetVectorMetadata(row) }]);
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
    const rows = await db
      .prepare(
        "SELECT dataset_id FROM datasets WHERE embedding_dirty = 1 ORDER BY updated_at LIMIT ?",
      )
      .bind(limit)
      .all<{ dataset_id: string }>();
    const ids = (rows.results || []).map((r) => r.dataset_id);
    let embedded = 0;
    for (const id of ids) {
      if (await reembedDatasetVector(db, ai, vectorize, id)) embedded++;
    }
    if (ids.length > 0) {
      console.log(`[embed-cron] drained ${embedded}/${ids.length} dirty vectors`);
    }
    return { scanned: ids.length, embedded };
  } catch (err) {
    console.error(`[embed-cron] drain failed: ${err instanceof Error ? err.message : String(err)}`);
    return { scanned: 0, embedded: 0 };
  }
}

/**
 * Fallback text search using D1 LIKE queries on the nemar_catalog table.
 * Used when Vectorize is not available or for exact substring matching.
 */
export async function textSearch(
  db: D1Database,
  query: string,
  limit = 20,
): Promise<SearchResult[]> {
  const pattern = `%${query.toLowerCase()}%`;
  const results = await db
    .prepare(
      `SELECT id, name, modalities, participants, doi, tasks, authors
       FROM nemar_catalog
       WHERE search_text LIKE ?
       ORDER BY participants DESC
       LIMIT ?`,
    )
    .bind(pattern, limit)
    .all<{
      id: string;
      name: string;
      modalities: string | null;
      participants: number;
      doi: string | null;
      tasks: string | null;
      authors: string | null;
    }>();

  return (results.results || []).map((row) => ({
    id: row.id,
    name: row.name || "",
    modalities: row.modalities || "",
    participants: row.participants || 0,
    doi: row.doi || "",
    tasks: row.tasks || "",
    authors: row.authors || "",
    score: 1.0, // No relevance ranking for LIKE search
  }));
}

// ---------------------------------------------------------------------------
// #646 Phase 3 (READ_FROM_DATASETS): id-only Vectorize + D1 hydration, FTS5
// lexical search, and reciprocal-rank-fusion hybrid. These run alongside the
// flag-off paths above and read from the `datasets` source of truth.
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
}

const toResult = (row: HydrateRow, score: number, snippet?: string): SearchResult => ({
  id: row.id,
  name: row.name || "",
  modalities: row.modalities || "",
  participants: row.participants || 0,
  doi: row.doi || "",
  tasks: row.tasks || "",
  authors: row.authors || "",
  score,
  ...(snippet ? { snippet } : {}),
});

/** Hydrate ordered dataset ids from the `datasets` source of truth, preserving
 *  the input ranking and dropping ids with no live row. The actual bug fix:
 *  display fields come from the row, not stale Vectorize metadata. */
export async function hydrateDatasetsByIds(db: D1Database, ids: string[]): Promise<SearchResult[]> {
  if (ids.length === 0) return [];
  const results = await db
    .prepare(
      `SELECT d.dataset_id AS id, d.name, d.modalities, d.subject_count AS participants,
              d.concept_doi AS doi, d.tasks, d.authors
       FROM datasets d
       WHERE d.dataset_id IN (${buildInPlaceholders(ids.length)})`,
    )
    .bind(...ids)
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
): Promise<SearchResult | null> {
  const row = await db
    .prepare(
      `SELECT d.dataset_id AS id, d.name, d.modalities, d.subject_count AS participants,
              d.concept_doi AS doi, d.tasks, d.authors
       FROM datasets d
       WHERE d.dataset_id = ? AND d.status = 'active'
         AND (d.is_sandbox = 0 OR d.is_sandbox IS NULL) AND d.visibility = 'public'
       LIMIT 1`,
    )
    .bind(datasetId)
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
  const hydrated = await hydrateDatasetsByIds(
    db,
    ranked.map((r) => r.id),
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
): Promise<SearchResult[]> {
  const match = buildFtsMatch(query);
  if (!match) return [];
  const results = await db
    .prepare(
      `SELECT d.dataset_id AS id, d.name, d.modalities, d.subject_count AS participants,
              d.concept_doi AS doi, d.tasks, d.authors,
              snippet(datasets_fts, 5, '<mark>', '</mark>', '…', 12) AS snippet
       FROM datasets_fts
       JOIN datasets d ON d.id = datasets_fts.rowid
       WHERE datasets_fts MATCH ?
         AND d.status = 'active' AND (d.is_sandbox = 0 OR d.is_sandbox IS NULL)
         AND d.visibility = 'public'
       ORDER BY bm25(datasets_fts)
       LIMIT ?`,
    )
    .bind(match, limit)
    .all<HydrateRow & { snippet: string | null }>();
  return (results.results || []).map((row) => toResult(row, 1.0, row.snippet || undefined));
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
