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
 * Re-embed a single dataset's Vectorize vector from its current `datasets`
 * row (#646 Phase 2). Id-only model: the vector carries empty metadata, so a
 * full upsert atomically clears any stale 6-field metadata and search results
 * hydrate their facts from D1 at query time.
 *
 * Fire-once + fully guarded: returns without throwing when AI/Vectorize are
 * unconfigured, the row is missing, or any step fails -- so it can be awaited
 * inline at the enrich/reindex hooks without ever failing the request.
 */
export async function reembedDatasetVector(
  db: D1Database,
  ai: Ai | undefined,
  vectorize: VectorizeIndex | undefined,
  datasetId: string,
): Promise<void> {
  if (!ai || !vectorize) {
    console.log(`[reembed] AI/Vectorize not configured, skipping ${datasetId}`);
    return;
  }
  try {
    const row = await db
      .prepare("SELECT name, modalities, tasks, authors, readme FROM datasets WHERE dataset_id = ?")
      .bind(datasetId)
      .first<DatasetEmbedRow>();
    if (!row) {
      console.warn(`[reembed] No datasets row for ${datasetId}, skipping`);
      return;
    }
    const text = buildDatasetEmbedText(row);
    if (!text.trim()) return;

    const embedding = await ai.run(EMBEDDING_MODEL, { text: [text] });
    const values = "data" in embedding ? embedding.data?.[0] : undefined;
    if (!values) {
      console.error(`[reembed] Empty embedding for ${datasetId}`);
      return;
    }
    await vectorize.upsert([{ id: datasetId, values, metadata: {} }]);
  } catch (err) {
    console.error(
      `[reembed] Failed for ${datasetId}: ${err instanceof Error ? err.message : String(err)}`,
    );
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
