/**
 * Catalog Sync Service
 *
 * Pulls the full dataset catalog from nemar.org's datapipeline API
 * and upserts it into the local D1 nemar_catalog table. Optionally
 * generates embeddings via Workers AI and indexes into Vectorize.
 *
 * The nemar.org read API requires no authentication.
 * API: GET https://nemar.org/api/dataexplorer/datapipeline/records
 * Body (as JSON in GET): {"table_name":"dataexplorer_dataset","start":0,"limit":N}
 */

import { SYSTEM_USER_ID } from "../lib/constants.js";

const NEMAR_API_BASE = "https://nemar.org/api/dataexplorer/datapipeline";
const FETCH_TIMEOUT_MS = 30_000;
const BATCH_SIZE = 10; // D1 batch limit for bound parameters
const EMBEDDING_MODEL = "@cf/baai/bge-small-en-v1.5";

/** Raw record from the nemar.org dataexplorer_dataset table */
export interface NemarCatalogRecord {
  id: string;
  name: string;
  created: string;
  uploader: string;
  latestSnapshot: string;
  publishDate: string;
  sessionsNum: number;
  file_size: number;
  byte_size_format: string;
  totalFiles: number;
  participants: number;
  age_min: number;
  age_max: number;
  BIDSVersion: string;
  License: string;
  Authors: string;
  DatasetDOI: string;
  tasks: string;
  modalities: string;
  readme: string;
  local_dataset: number;
  processed: number;
}

/** nemar.org API response format */
interface NemarRecordsResponse {
  total: number;
  entries: Record<string, NemarCatalogRecord>;
  start: number;
  limit: number;
  success: boolean;
}

export interface CatalogSyncResult {
  recordsSynced: number;
  recordsIndexed: number;
  errors: string[];
  durationMs: number;
}

/**
 * Fetch all dataset records from the nemar.org datapipeline API.
 *
 * The API requires GET with a JSON body (non-standard). Cloudflare Workers'
 * fetch() rejects bodies on GET requests per HTTP spec. This function is
 * intended to be called from GitHub Actions (Node.js) where GET+body works.
 *
 * When called from a Worker context, it will fail. Use the GitHub Action
 * workflow (.github/workflows/catalog-sync.yml) for scheduled syncs, or
 * call POST /admin/catalog/import with pre-fetched records.
 */
export async function fetchNemarCatalog(): Promise<NemarCatalogRecord[]> {
  const response = await fetch(`${NEMAR_API_BASE}/records`, {
    method: "GET",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      table_name: "dataexplorer_dataset",
      start: 0,
      limit: 1000,
    }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`nemar.org API returned HTTP ${response.status}`);
  }

  const data = (await response.json()) as NemarRecordsResponse;
  if (!data.success || !data.entries) {
    throw new Error("nemar.org API returned unsuccessful response");
  }

  // entries is an object keyed by index ("0", "1", ...), convert to array
  const records: NemarCatalogRecord[] = [];
  for (const key of Object.keys(data.entries).sort((a, b) => Number(a) - Number(b))) {
    const record = data.entries[key];
    if (record.id) {
      records.push(record);
    }
  }

  return records;
}

/**
 * Build a pre-computed lowercase search text from record fields.
 * Used as a LIKE fallback when Vectorize is unavailable.
 */
function buildSearchText(record: NemarCatalogRecord): string {
  const parts = [
    record.id,
    record.name,
    record.Authors,
    record.tasks,
    record.modalities,
    record.readme?.slice(0, 500),
  ].filter(Boolean);
  return parts.join(" ").toLowerCase();
}

/** Determine the source and source_id for deduplication */
function classifySource(record: NemarCatalogRecord): { source: string; sourceId: string | null } {
  if (record.id.startsWith("ds")) {
    return { source: "openneuro", sourceId: record.id };
  }
  if (record.id.startsWith("nm")) {
    return { source: "nemar.org", sourceId: null };
  }
  return { source: "nemar.org", sourceId: null };
}

/**
 * #646 Phase 4: fold catalog records into the `datasets` source of truth,
 * alongside the nemar_catalog write (which stays as the flag-off safety net
 * until Phase 5/6). New/changed rows get embedding_dirty=1 so the drain cron
 * re-embeds them.
 *
 * Dedup mirrors the 0028 fold: a record that is already an active managed
 * dataset, or a ds* shadow of a managed on* mirror, is skipped (the Phase-3
 * single-table list has no dedup, so a folded shadow would double-list).
 *
 * The `ON CONFLICT(dataset_id) DO UPDATE ... WHERE owner_user_id = SENTINEL`
 * guard means a catalog record colliding with a MANAGED dataset is a no-op:
 * managed facts and ownership are never clobbered by the legacy ingest.
 */
export async function upsertCatalogRecordsToDatasets(
  db: D1Database,
  records: NemarCatalogRecord[],
): Promise<number> {
  if (records.length === 0) return 0;

  const [managedRows, shadowRows] = await Promise.all([
    db
      .prepare("SELECT dataset_id FROM datasets WHERE owner_user_id != ? AND status = 'active'")
      .bind(SYSTEM_USER_ID)
      .all<{ dataset_id: string }>(),
    db
      .prepare(
        "SELECT source_id FROM datasets WHERE owner_user_id != ? AND status = 'active' AND source = 'openneuro' AND source_id IS NOT NULL",
      )
      .bind(SYSTEM_USER_ID)
      .all<{ source_id: string }>(),
  ]);
  const managedIds = new Set((managedRows.results || []).map((r) => r.dataset_id));
  const shadowIds = new Set((shadowRows.results || []).map((r) => r.source_id));
  const survivors = records.filter((r) => !managedIds.has(r.id) && !shadowIds.has(r.id));
  if (survivors.length === 0) return 0;

  let upserted = 0;
  for (let i = 0; i < survivors.length; i += BATCH_SIZE) {
    const batch = survivors.slice(i, i + BATCH_SIZE);
    const statements = batch.map((record) => {
      const { source, sourceId } = classifySource(record);
      return db
        .prepare(
          `INSERT INTO datasets (
             dataset_id, name, description, owner_user_id, status, visibility, is_sandbox,
             source, source_id, subject_count, modalities, age_min, age_max, file_size,
             total_files, tasks, authors, license, readme, bids_version, sessions_count,
             publish_date, uploader, file_size_formatted, concept_doi, created_at, updated_at, embedding_dirty)
           VALUES (?, ?, ?, ?, 'active', 'public', 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), 1)
           ON CONFLICT(dataset_id) DO UPDATE SET
             name = excluded.name,
             description = excluded.description,
             source = excluded.source,
             source_id = excluded.source_id,
             subject_count = excluded.subject_count,
             modalities = excluded.modalities,
             age_min = excluded.age_min,
             age_max = excluded.age_max,
             file_size = excluded.file_size,
             total_files = excluded.total_files,
             tasks = excluded.tasks,
             authors = excluded.authors,
             license = excluded.license,
             readme = excluded.readme,
             bids_version = excluded.bids_version,
             sessions_count = excluded.sessions_count,
             publish_date = excluded.publish_date,
             uploader = excluded.uploader,
             file_size_formatted = excluded.file_size_formatted,
             concept_doi = excluded.concept_doi,
             updated_at = datetime('now'),
             embedding_dirty = 1
           WHERE datasets.owner_user_id = ${SYSTEM_USER_ID}`,
        )
        .bind(
          record.id,
          record.name,
          record.readme?.slice(0, 500) || null, // description = readme[:500] (mirrors nemar_catalog)
          SYSTEM_USER_ID,
          source,
          sourceId,
          record.participants || 0,
          record.modalities || null,
          record.age_min || 0,
          record.age_max || 0,
          record.file_size || 0,
          record.totalFiles || 0,
          record.tasks || null,
          record.Authors || null,
          record.License || null,
          record.readme?.slice(0, 8192) || null, // datasets.readme capped at 8 KB
          record.BIDSVersion || null,
          record.sessionsNum || 0,
          record.publishDate || null,
          record.uploader || null,
          record.byte_size_format || null,
          record.DatasetDOI || null,
          record.created || null,
        );
    });
    await db.batch(statements);
    upserted += batch.length;
  }
  return upserted;
}

/**
 * Sync catalog records into D1 nemar_catalog table.
 * Uses INSERT OR REPLACE for upsert behavior.
 */
async function syncToD1(db: D1Database, records: NemarCatalogRecord[]): Promise<number> {
  let synced = 0;

  for (let i = 0; i < records.length; i += BATCH_SIZE) {
    const batch = records.slice(i, i + BATCH_SIZE);
    const statements = batch.map((record) => {
      const { source, sourceId } = classifySource(record);
      return db
        .prepare(
          `INSERT OR REPLACE INTO nemar_catalog
           (id, name, description, modalities, participants, age_min, age_max,
            tasks, authors, doi, license, bids_version, file_size,
            file_size_formatted, total_files, sessions_count, latest_version,
            publish_date, created_date, uploader, readme, source, source_id,
            is_processed, search_text, synced_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
        )
        .bind(
          record.id,
          record.name,
          record.readme?.slice(0, 500) || null,
          record.modalities || null,
          record.participants || 0,
          record.age_min || 0,
          record.age_max || 0,
          record.tasks || null,
          record.Authors || null,
          record.DatasetDOI || null,
          record.License || null,
          record.BIDSVersion || null,
          record.file_size || 0,
          record.byte_size_format || null,
          record.totalFiles || 0,
          record.sessionsNum || 0,
          record.latestSnapshot || null,
          record.publishDate || null,
          record.created || null,
          record.uploader || null,
          record.readme || null,
          source,
          sourceId,
          record.processed || 0,
          buildSearchText(record),
        );
    });

    await db.batch(statements);
    synced += batch.length;
  }

  return synced;
}

/**
 * Build embedding text for a catalog record.
 * Combines title, description, modalities, tasks, and authors
 * into a single string for semantic embedding.
 */
function buildEmbeddingText(record: NemarCatalogRecord): string {
  const parts = [
    record.name,
    record.modalities ? `Modalities: ${record.modalities}` : "",
    record.tasks ? `Tasks: ${record.tasks}` : "",
    record.Authors ? `Authors: ${record.Authors}` : "",
    record.readme?.slice(0, 1000) || "",
  ].filter(Boolean);
  return parts.join("\n");
}

/**
 * Generate embeddings and upsert into Vectorize index.
 * Processes records in batches to stay within Workers AI limits.
 */
async function syncToVectorize(
  ai: Ai,
  vectorize: VectorizeIndex,
  records: NemarCatalogRecord[],
): Promise<number> {
  let indexed = 0;
  const VECTOR_BATCH = 20;

  for (let i = 0; i < records.length; i += VECTOR_BATCH) {
    const batch = records.slice(i, i + VECTOR_BATCH);
    const texts = batch.map(buildEmbeddingText);

    // Workers AI supports batch embedding
    const embeddings = await ai.run(EMBEDDING_MODEL, { text: texts });
    const embeddingData = "data" in embeddings ? embeddings.data : undefined;
    if (!embeddingData || embeddingData.length !== batch.length) {
      console.error(
        `[catalog-sync] Embedding batch mismatch: expected ${batch.length}, got ${embeddingData?.length ?? 0}`,
      );
      continue;
    }

    const vectors: VectorizeVector[] = batch.map((record, j) => ({
      id: record.id,
      values: embeddingData[j],
      metadata: {
        name: record.name,
        modalities: record.modalities || "",
        participants: record.participants || 0,
        doi: record.DatasetDOI || "",
        tasks: record.tasks || "",
        authors: record.Authors || "",
      },
    }));

    await vectorize.upsert(vectors);
    indexed += vectors.length;
  }

  return indexed;
}

/**
 * Run a full catalog sync: fetch from nemar.org, upsert into D1 and Vectorize.
 */
export async function syncCatalog(
  db: D1Database,
  ai?: Ai,
  vectorize?: VectorizeIndex,
): Promise<CatalogSyncResult> {
  const startTime = Date.now();
  const errors: string[] = [];
  let recordsSynced = 0;
  let recordsIndexed = 0;

  // Start sync log
  const logResult = await db
    .prepare("INSERT INTO catalog_sync_log (status) VALUES ('running')")
    .run();
  const logId = logResult.meta.last_row_id;

  try {
    // Fetch from nemar.org
    console.log("[catalog-sync] Fetching catalog from nemar.org...");
    const records = await fetchNemarCatalog();
    console.log(`[catalog-sync] Fetched ${records.length} records`);

    // Upsert into D1
    recordsSynced = await syncToD1(db, records);
    console.log(`[catalog-sync] Synced ${recordsSynced} records to D1`);

    // #646 Phase 4 dual-write: also fold into the datasets source of truth
    // (non-fatal; nemar_catalog above is the flag-off safety net).
    try {
      const folded = await upsertCatalogRecordsToDatasets(db, records);
      console.log(`[catalog-sync] Folded ${folded} records into datasets`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[catalog-sync] datasets fold failed:", msg);
      errors.push(`datasets fold: ${msg}`);
    }

    // Index into Vectorize (if bindings available)
    if (ai && vectorize) {
      try {
        recordsIndexed = await syncToVectorize(ai, vectorize, records);
        console.log(`[catalog-sync] Indexed ${recordsIndexed} records in Vectorize`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[catalog-sync] Vectorize indexing failed:", msg);
        errors.push(`Vectorize: ${msg}`);
        // Non-fatal: D1 sync succeeded, search will fall back to LIKE
      }
    } else {
      console.log("[catalog-sync] Vectorize not configured, skipping embedding");
    }

    // Update sync log
    await db
      .prepare(
        `UPDATE catalog_sync_log
         SET status = 'completed', completed_at = datetime('now'),
             records_synced = ?, records_indexed = ?,
             errors = ?
         WHERE id = ?`,
      )
      .bind(recordsSynced, recordsIndexed, errors.length > 0 ? errors.join("; ") : null, logId)
      .run();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[catalog-sync] Sync failed:", msg);
    errors.push(msg);

    try {
      await db
        .prepare(
          `UPDATE catalog_sync_log
           SET status = 'failed', completed_at = datetime('now'), errors = ?
           WHERE id = ?`,
        )
        .bind(msg, logId)
        .run();
    } catch (logErr) {
      console.error(
        "[catalog-sync] Failed to update sync log:",
        logErr instanceof Error ? logErr.message : logErr,
      );
    }
  }

  return {
    recordsSynced,
    recordsIndexed,
    errors,
    durationMs: Date.now() - startTime,
  };
}

/**
 * Import pre-fetched catalog records into D1 and optionally Vectorize.
 * Called by the admin endpoint when the GitHub Action POSTs records.
 */
export async function importCatalogRecords(
  db: D1Database,
  records: NemarCatalogRecord[],
  ai?: Ai,
  vectorize?: VectorizeIndex,
): Promise<CatalogSyncResult> {
  const startTime = Date.now();
  const errors: string[] = [];
  let recordsSynced = 0;
  let recordsIndexed = 0;

  const logResult = await db
    .prepare("INSERT INTO catalog_sync_log (status) VALUES ('running')")
    .run();
  const logId = logResult.meta.last_row_id;

  try {
    console.log(`[catalog-sync] Importing ${records.length} pre-fetched records`);

    recordsSynced = await syncToD1(db, records);
    console.log(`[catalog-sync] Synced ${recordsSynced} records to D1`);

    // #646 Phase 4 dual-write: also fold into the datasets source of truth
    // (non-fatal; nemar_catalog above is the flag-off safety net).
    try {
      const folded = await upsertCatalogRecordsToDatasets(db, records);
      console.log(`[catalog-sync] Folded ${folded} records into datasets`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[catalog-sync] datasets fold failed:", msg);
      errors.push(`datasets fold: ${msg}`);
    }

    if (ai && vectorize) {
      try {
        recordsIndexed = await syncToVectorize(ai, vectorize, records);
        console.log(`[catalog-sync] Indexed ${recordsIndexed} records in Vectorize`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[catalog-sync] Vectorize indexing failed:", msg);
        errors.push(`Vectorize: ${msg}`);
      }
    }

    await db
      .prepare(
        `UPDATE catalog_sync_log
         SET status = 'completed', completed_at = datetime('now'),
             records_synced = ?, records_indexed = ?, errors = ?
         WHERE id = ?`,
      )
      .bind(recordsSynced, recordsIndexed, errors.length > 0 ? errors.join("; ") : null, logId)
      .run();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[catalog-sync] Import failed:", msg);
    errors.push(msg);

    try {
      await db
        .prepare(
          `UPDATE catalog_sync_log
           SET status = 'failed', completed_at = datetime('now'), errors = ?
           WHERE id = ?`,
        )
        .bind(msg, logId)
        .run();
    } catch (logErr) {
      console.error(
        "[catalog-sync] Failed to update sync log:",
        logErr instanceof Error ? logErr.message : logErr,
      );
    }
  }

  return {
    recordsSynced,
    recordsIndexed,
    errors,
    durationMs: Date.now() - startTime,
  };
}
