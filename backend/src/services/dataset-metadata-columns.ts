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

import { licenseTier } from "../lib/license.js";
import { detectModalitiesFromTree } from "./datacite.js";
import { countSubjectDirs, extractTasks, parseParticipantsTsv } from "./nemar-sync.js";

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
 * - subject_count is the count of root-level `sub-*` directories in the tree
 *   via `countSubjectDirs` (the BIDS-canonical subject set, #759), falling back
 *   to the participants.tsv row count only when the tree has no resolvable
 *   subjects. age_min / age_max derive from participants.tsv via
 *   `parseParticipantsTsv` (`backend/src/services/nemar-sync.ts`).
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

  // subject_count: prefer the BIDS-canonical count of root-level sub-* dirs in
  // the tree (#759). participants.tsv is an enrolled roster that can be far
  // larger than the released subjects (on005752: 1859 rows vs 251 sub-* dirs),
  // so it is only the fallback when the tree has no resolvable subjects (e.g.
  // the placeholder-participants path). age_min/age_max still come from
  // participants.tsv, which carries the per-subject demographics.
  const subjectDirCount = input.treePaths.length ? countSubjectDirs(input.treePaths) : 0;

  let ageMin: number | null = null;
  let ageMax: number | null = null;
  let participantsRowCount = 0;
  if (input.participantsTsv) {
    const stats = parseParticipantsTsv(input.participantsTsv);
    participantsRowCount = stats.count;
    ageMin = stats.ageMin;
    ageMax = stats.ageMax;
  }
  // count=0 maps to null so the column reflects "not populated yet" rather than
  // "really zero subjects".
  const subjectCount: number | null =
    subjectDirCount > 0 ? subjectDirCount : participantsRowCount > 0 ? participantsRowCount : null;

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

/** Max readme length stored on `datasets.readme` (matches the 0028 fold's substr). */
const README_MAX = 8192;

/**
 * Fact columns written directly to the `datasets` source of truth by the
 * enrichment/reindex hooks (#646 Phase 2 dual-write). Complements
 * writeDatasetMetadataColumns (which owns subject_count/modalities/age/
 * file_size/total_files/tasks) -- no column overlap. Every field is optional
 * and COALESCE-preserved, so a hook that lacks a value (e.g. reindex has no
 * LLM authors) leaves the existing column untouched. `name`/`description` are
 * preserved too: a reindex without a fresh LLM title must not clobber a better
 * one. `datasets` is the single source of truth (#646).
 */
export interface DatasetCatalogFields {
  name?: string | null;
  description?: string | null;
  authors?: string | null;
  license?: string | null;
  readme?: string | null;
  bids_version?: string | null;
  /**
   * Distinct `ses-*` directory count from the BIDS tree, computed by the
   * enrich/reindex hooks via `countSessionDirs` (#657). Null when the dataset
   * has no `ses-*` layer, so COALESCE preserves any value backfilled from the
   * legacy catalog rather than overwriting it with 0.
   */
  sessions_count?: number | null;
}

export async function writeDatasetCatalogFields(
  db: D1Database,
  datasetId: string,
  fields: DatasetCatalogFields,
): Promise<{ changes: number }> {
  const readme = fields.readme != null ? fields.readme.slice(0, README_MAX) : null;
  // Derive the license tier from the same value being written so license and
  // license_tier never drift (#653). Bound as NULL when no license is supplied,
  // so the COALESCE preserves the existing tier rather than clobbering it to
  // 'unknown' on a license-less update.
  const licenseTierValue = fields.license != null ? licenseTier(fields.license) : null;
  const result = await db
    .prepare(
      `UPDATE datasets
       SET name = COALESCE(?, name),
           description = COALESCE(?, description),
           authors = COALESCE(?, authors),
           license = COALESCE(?, license),
           license_tier = COALESCE(?, license_tier),
           readme = COALESCE(?, readme),
           bids_version = COALESCE(?, bids_version),
           sessions_count = COALESCE(?, sessions_count),
           updated_at = datetime('now')
       WHERE dataset_id = ?`,
    )
    .bind(
      fields.name ?? null,
      fields.description ?? null,
      fields.authors ?? null,
      fields.license ?? null,
      licenseTierValue,
      readme,
      fields.bids_version ?? null,
      fields.sessions_count ?? null,
      datasetId,
    )
    .run();

  const changes = result.meta?.changes ?? 0;
  if (changes === 0) {
    console.warn(
      `[catalog-fields] No rows updated for ${datasetId} - dataset may have been deleted or renamed`,
    );
  }
  return { changes };
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
 * writeDatasetCatalogFields preserves the existing value.
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
