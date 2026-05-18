/**
 * Dataset metadata column helpers (epic #417 phase 2).
 *
 * Computes and persists the first-class metadata columns added to the
 * `datasets` table by migration 0020: subject_count, modalities, age_min,
 * age_max, file_size, total_files, tasks, metadata_updated_at.
 *
 * Source data is reused from existing helpers — see references on each
 * field — so the two callers (the LLM enrichment webhook and the
 * post-version-DOI nemar.org sync) compute identical values.
 *
 * NULL semantics: when an input is missing, the corresponding output field
 * is null rather than 0/"" so downstream queries can distinguish
 * "not populated yet" from "really zero".
 */

import { detectModalitiesFromTree } from "./datacite.js";
import { extractTasks, parseParticipantsTsv } from "./nemar-sync.js";

export interface DatasetMetadataColumns {
  subject_count: number | null;
  modalities: string | null;
  age_min: number | null;
  age_max: number | null;
  file_size: number | null;
  total_files: number | null;
  tasks: string | null;
}

export interface MetadataColumnInputs {
  /** Paths of all files in the dataset tree (used for modality and task detection). */
  treePaths: string[];
  /** Raw contents of participants.tsv at the same ref, or null if absent. */
  participantsTsv: string | null;
  /** S3 size and object count, or null if the lookup failed/was skipped. */
  s3Stats: { totalSize: number; objectCount: number | undefined } | null;
}

/**
 * Pure transformation from collected inputs to the column shape.
 *
 * - subject_count / age_min / age_max derive from participants.tsv via
 *   `parseParticipantsTsv` (`backend/src/services/nemar-sync.ts:257`).
 * - modalities sorts the output of `detectModalitiesFromTree`
 *   (`backend/src/services/datacite.ts:1066`) into a deterministic CSV.
 * - tasks delegates to `extractTasks` (`backend/src/services/nemar-sync.ts:343`)
 *   which already sorts and deduplicates.
 * - file_size / total_files mirror `getDatasetS3Stats` output
 *   (`backend/src/services/s3.ts:218`).
 */
export function computeDatasetMetadataColumns(input: MetadataColumnInputs): DatasetMetadataColumns {
  const modalitiesArr = input.treePaths.length
    ? [...detectModalitiesFromTree(input.treePaths)].sort()
    : [];
  const tasksArr = input.treePaths.length ? extractTasks(input.treePaths) : [];

  let subjectCount: number | null = null;
  let ageMin: number | null = null;
  let ageMax: number | null = null;
  if (input.participantsTsv) {
    const stats = parseParticipantsTsv(input.participantsTsv);
    // parseParticipantsTsv returns count=0 for files with no rows; treat
    // an empty participants.tsv as "no data" rather than "zero subjects".
    subjectCount = stats.count > 0 ? stats.count : null;
    ageMin = stats.ageMin;
    ageMax = stats.ageMax;
  }

  return {
    subject_count: subjectCount,
    modalities: modalitiesArr.length ? modalitiesArr.join(",") : null,
    age_min: ageMin,
    age_max: ageMax,
    file_size: input.s3Stats ? input.s3Stats.totalSize : null,
    total_files: input.s3Stats ? (input.s3Stats.objectCount ?? null) : null,
    tasks: tasksArr.length ? tasksArr.join(",") : null,
  };
}

/**
 * Persist the computed columns to D1. Updates metadata_updated_at to now().
 *
 * COALESCE semantics: a NULL input means "no fresh measurement for this
 * field", so the existing column value is preserved. This lets callers
 * partially refresh — e.g., if the S3 lookup failed, file_size/total_files
 * are NULL on the input and the previously-stored values stay intact rather
 * than being silently overwritten with NULL.
 *
 * The metadata_updated_at timestamp always advances, so operators can still
 * see when the most recent refresh attempt ran.
 */
export async function writeDatasetMetadataColumns(
  db: D1Database,
  datasetId: string,
  cols: DatasetMetadataColumns,
): Promise<{ changes: number }> {
  const result = await db
    .prepare(
      `UPDATE datasets
       SET subject_count = COALESCE(?, subject_count),
           modalities = COALESCE(?, modalities),
           age_min = COALESCE(?, age_min),
           age_max = COALESCE(?, age_max),
           file_size = COALESCE(?, file_size),
           total_files = COALESCE(?, total_files),
           tasks = COALESCE(?, tasks),
           metadata_updated_at = datetime('now'),
           updated_at = datetime('now')
       WHERE dataset_id = ?`,
    )
    .bind(
      cols.subject_count,
      cols.modalities,
      cols.age_min,
      cols.age_max,
      cols.file_size,
      cols.total_files,
      cols.tasks,
      datasetId,
    )
    .run();

  // D1 returns meta.changes = 0 when the WHERE clause matched no rows.
  // Surface that explicitly: a 0-row update is almost always a race with
  // dataset deletion or a dataset_id mismatch, and the project rule against
  // silent failures requires we log it.
  const changes = result.meta?.changes ?? 0;
  if (changes === 0) {
    console.warn(
      `[metadata-columns] No rows updated for ${datasetId} - dataset may have been deleted or renamed`,
    );
  }
  return { changes };
}

/**
 * Fields that the discover-page list endpoint projects from `nemar_catalog`.
 * Kept in sync with the catalog table by the enrichment pipeline so the
 * cached read path doesn't fall behind the source-of-truth `datasets` row.
 */
export interface CatalogSyncFields {
  /** Optional title override (from enrichment.title); null preserves existing. */
  name?: string | null;
  description?: string | null;
  modalities?: string | null;
  participants?: number | null;
  age_min?: number | null;
  age_max?: number | null;
  tasks?: string | null;
  authors?: string | null;
  license?: string | null;
  file_size?: number | null;
  file_size_formatted?: string | null;
  total_files?: number | null;
}

/**
 * Format a byte count as a short human-readable string (`"23.2 GB"`,
 * `"4.31 GB"`). Mirrors the format the legacy nemar.org catalog uses for
 * `file_size_formatted` so the column stays consistent.
 */
export function formatFileSize(bytes: number | null | undefined): string | null {
  if (bytes == null || !Number.isFinite(bytes) || bytes <= 0) return null;
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  const fixed = i === 0 ? `${n}` : n >= 100 ? n.toFixed(0) : n.toFixed(2);
  return `${fixed} ${units[i]}`;
}

/**
 * Extract a comma-joined author string from an enrichment_json blob.
 * The enrichment pipeline stores authors as `{ "First Last": { ... }, ... }`
 * (object form, ORCID/affiliation as the value) for most datasets and an
 * array of `{name, ...}` objects for some legacy rows. Returns null when
 * the shape is unrecognized or empty so the COALESCE in
 * syncNemarCatalogFromEnrichment preserves the existing value.
 */
export function authorsFromEnrichment(
  enrichment: { authors?: unknown } | null | undefined,
): string | null {
  if (!enrichment) return null;
  const raw = enrichment.authors;
  if (raw == null) return null;
  let names: string[] = [];
  if (Array.isArray(raw)) {
    names = raw
      .map((a) => {
        if (typeof a === "string") return a;
        if (a && typeof a === "object" && "name" in a && typeof a.name === "string") return a.name;
        return null;
      })
      .filter((n): n is string => Boolean(n?.trim()));
  } else if (typeof raw === "object") {
    names = Object.keys(raw as Record<string, unknown>).filter((n) => n.trim());
  }
  return names.length > 0 ? names.join(", ") : null;
}

/**
 * Mirror the enrichment-derived metadata into `nemar_catalog` so the
 * list-endpoint cache reads consistent values. The `datasets` row is the
 * source of truth; this keeps the cached projection coherent.
 *
 * UPSERT: a new dataset's first enrichment INSERTs the catalog row; every
 * subsequent enrichment/reindex UPDATEs it. `name` is required because
 * nemar_catalog.name is NOT NULL; other fields use COALESCE-preserve so
 * null inputs leave existing values untouched on the UPDATE path.
 *
 * `name` is also COALESCE-preserved on UPDATE so a caller that didn't get
 * a fresh title from the LLM doesn't clobber a previously-better one.
 *
 * Replaces the prior UPDATE-only behavior which silently warned and
 * returned changes=0 when the catalog row didn't exist (broken cache).
 * The new pipeline created some datasets that never had a catalog row;
 * see nemarOrg/nemar-cli#544.
 */
export async function syncNemarCatalogFromEnrichment(
  db: D1Database,
  datasetId: string,
  fields: CatalogSyncFields & { name: string },
): Promise<{ changes: number }> {
  const result = await db
    .prepare(
      `INSERT INTO nemar_catalog (
         id, name, description, modalities, participants, age_min, age_max,
         tasks, authors, license, file_size, file_size_formatted, total_files,
         synced_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(id) DO UPDATE SET
         name = COALESCE(excluded.name, nemar_catalog.name),
         description = COALESCE(excluded.description, nemar_catalog.description),
         modalities = COALESCE(excluded.modalities, nemar_catalog.modalities),
         participants = COALESCE(excluded.participants, nemar_catalog.participants),
         age_min = COALESCE(excluded.age_min, nemar_catalog.age_min),
         age_max = COALESCE(excluded.age_max, nemar_catalog.age_max),
         tasks = COALESCE(excluded.tasks, nemar_catalog.tasks),
         authors = COALESCE(excluded.authors, nemar_catalog.authors),
         license = COALESCE(excluded.license, nemar_catalog.license),
         file_size = COALESCE(excluded.file_size, nemar_catalog.file_size),
         file_size_formatted = COALESCE(excluded.file_size_formatted, nemar_catalog.file_size_formatted),
         total_files = COALESCE(excluded.total_files, nemar_catalog.total_files),
         synced_at = datetime('now')`,
    )
    .bind(
      datasetId,
      fields.name,
      fields.description ?? null,
      fields.modalities ?? null,
      fields.participants ?? null,
      fields.age_min ?? null,
      fields.age_max ?? null,
      fields.tasks ?? null,
      fields.authors ?? null,
      fields.license ?? null,
      fields.file_size ?? null,
      fields.file_size_formatted ?? null,
      fields.total_files ?? null,
    )
    .run();

  const changes = result.meta?.changes ?? 0;
  return { changes };
}
