/**
 * Catalog Sync Service
 *
 * Pulls the full dataset catalog from nemar.org's datapipeline API and folds
 * it into the `datasets` source of truth (#646). New/changed rows are marked
 * embedding_dirty=1 so the scheduled drain re-embeds them into the id-only
 * Vectorize index.
 *
 * The nemar.org read API requires no authentication.
 * API: GET https://nemar.org/api/dataexplorer/datapipeline/records
 * Body (as JSON in GET): {"table_name":"dataexplorer_dataset","start":0,"limit":N}
 */

import { SYSTEM_USER_ID } from "../lib/constants.js";

const NEMAR_API_BASE = "https://nemar.org/api/dataexplorer/datapipeline";
const FETCH_TIMEOUT_MS = 30_000;
const BATCH_SIZE = 10; // D1 batch limit for bound parameters

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
  /** Number of records folded into the `datasets` source of truth. */
  recordsSynced: number;
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
 * #646: fold catalog records into the `datasets` source of truth -- the only
 * catalog write (the nemar_catalog cache was dropped in Phase 6). New/changed
 * rows get embedding_dirty=1 so the drain cron re-embeds them.
 *
 * Dedup mirrors the 0028 fold: a record that is already an active managed
 * dataset, or a ds* shadow of a managed on* mirror, is skipped (without dedup
 * a folded shadow would double-list alongside the managed row in the catalog).
 *
 * The `ON CONFLICT(dataset_id) DO UPDATE ... WHERE owner_user_id = SENTINEL`
 * guard means a catalog record colliding with a MANAGED dataset is a no-op:
 * managed facts and ownership are never clobbered by the legacy ingest.
 */
export async function upsertCatalogRecordsToDatasets(
  db: D1Database,
  records: NemarCatalogRecord[],
): Promise<{ upserted: number; failed: string[] }> {
  if (records.length === 0) return { upserted: 0, failed: [] };

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
  if (survivors.length === 0) return { upserted: 0, failed: [] };

  let upserted = 0;
  let failedCount = 0;
  const failed: string[] = [];
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
          record.readme?.slice(0, 500) || null, // description = readme[:500]
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
    try {
      const batchResults = await db.batch(statements);
      // Count one per statement that wrote a row: an INSERT or sentinel UPDATE
      // reports changes>0; a managed-row collision (the WHERE owner=-1 guard)
      // reports changes=0. Do NOT sum raw `changes` -- the datasets_fts5
      // triggers inflate it by the per-row shadow-table writes (#646).
      for (const r of batchResults) {
        if (((r as { meta?: { changes?: number } }).meta?.changes ?? 0) > 0) upserted++;
      }
    } catch (err) {
      // A single bad record (or a transient D1 error) must NOT abort the rest of
      // the import (#646 review): skip this batch, record it, keep folding the
      // remaining ones. The caller surfaces `failed` into catalog_sync_log.
      const msg = err instanceof Error ? err.message : String(err);
      const ids = batch.map((r) => r.id).join(", ");
      console.error(`[catalog-sync] batch at offset ${i} failed (${batch.length} records): ${msg}`);
      failed.push(`${ids}: ${msg}`);
      failedCount += batch.length;
    }
  }
  const collisions = survivors.length - upserted - failedCount;
  if (collisions > 0) {
    // Some survivors collided with a NON-active managed row and were no-oped by
    // the guard (managed facts/ownership must not be clobbered by legacy ingest).
    // Surfaced so the gap isn't silent.
    console.warn(
      `[catalog-sync] ${collisions}/${survivors.length} catalog records did not fold into datasets (managed-row collisions)`,
    );
  }
  return { upserted, failed };
}

/**
 * Run a full catalog sync: fetch from nemar.org and fold into the `datasets`
 * source of truth. Sets embedding_dirty=1 on new/changed rows so the scheduled
 * drain re-embeds them (#646).
 */
export async function syncCatalog(db: D1Database): Promise<CatalogSyncResult> {
  const startTime = Date.now();
  const errors: string[] = [];
  let recordsSynced = 0;

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

    // Fold into the datasets source of truth (the only catalog write). Sets
    // embedding_dirty=1 on new/changed rows for the scheduled re-embed.
    const folded = await upsertCatalogRecordsToDatasets(db, records);
    recordsSynced = folded.upserted;
    if (folded.failed.length > 0) errors.push(...folded.failed);
    console.log(`[catalog-sync] Folded ${recordsSynced} records into datasets`);

    // Update sync log
    await db
      .prepare(
        `UPDATE catalog_sync_log
         SET status = 'completed', completed_at = datetime('now'),
             records_synced = ?, errors = ?
         WHERE id = ?`,
      )
      .bind(recordsSynced, errors.length > 0 ? errors.join("; ") : null, logId)
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
    errors,
    durationMs: Date.now() - startTime,
  };
}

/**
 * Import pre-fetched catalog records into the `datasets` source of truth.
 * Called by the admin endpoint when the GitHub Action POSTs records.
 */
export async function importCatalogRecords(
  db: D1Database,
  records: NemarCatalogRecord[],
): Promise<CatalogSyncResult> {
  const startTime = Date.now();
  const errors: string[] = [];
  let recordsSynced = 0;

  const logResult = await db
    .prepare("INSERT INTO catalog_sync_log (status) VALUES ('running')")
    .run();
  const logId = logResult.meta.last_row_id;

  try {
    console.log(`[catalog-sync] Importing ${records.length} pre-fetched records`);

    // Fold into the datasets source of truth (the only catalog write). Sets
    // embedding_dirty=1 on new/changed rows for the scheduled re-embed.
    const folded = await upsertCatalogRecordsToDatasets(db, records);
    recordsSynced = folded.upserted;
    if (folded.failed.length > 0) errors.push(...folded.failed);
    console.log(`[catalog-sync] Folded ${recordsSynced} records into datasets`);

    await db
      .prepare(
        `UPDATE catalog_sync_log
         SET status = 'completed', completed_at = datetime('now'),
             records_synced = ?, errors = ?
         WHERE id = ?`,
      )
      .bind(recordsSynced, errors.length > 0 ? errors.join("; ") : null, logId)
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
    errors,
    durationMs: Date.now() - startTime,
  };
}
