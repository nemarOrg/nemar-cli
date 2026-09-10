/**
 * The public catalog row every MCP tool starts from (epic #1065 phase 3,
 * issue #1295).
 *
 * `describe_dataset` (phase 2) wrote this query first; it is extracted here,
 * UNCHANGED (same public predicate, same column list), so `describe_dataset`
 * and the three recording-level tools (`list_recordings`, `get_events`,
 * `render_overview`) share exactly one D1 read and exactly one not-found
 * wording -- a caller who gets "not found" from one tool and tries another
 * never sees a second, differently-worded guess at the same fact.
 *
 * Every recording tool starts here: an unknown/private/sandboxed id answers
 * {@link datasetNotFoundResult}; a known id whose `zarr_status` is not
 * `"ready"` (or whose `zarr_store_count` is 0) answers
 * {@link zarrNotReadyResult} naming the actual status -- never an empty
 * list, which would read as "this dataset genuinely has no recordings"
 * rather than "conversion has not reached this dataset yet". `zarr_source_commit`
 * on the row is the projection-cache key every recording tool reads next
 * (`projection-cache.ts`): a cache hit costs this one D1 read plus one cache
 * match, and never touches `index.json`.
 */

import type { CallToolResult } from "@modelcontextprotocol/server";
import { ZARR_VERIFY_STATUS_VALUES } from "../../../shared/contract/mcp.js";
import { ZARR_VERIFIED_AT_PATH, ZARR_VERIFY_STATUS_PATH } from "../services/sweep-stamps.js";

export type ZarrVerifyStatusValue = (typeof ZARR_VERIFY_STATUS_VALUES)[number];

export const PUBLIC_DATASET_ROW_SQL = `SELECT
    d.dataset_id, d.name, d.concept_doi, d.license, d.modalities, d.tasks,
    d.subject_count, d.has_hed, d.hed_version, d.zarr_status, d.zarr_store_count,
    d.zarr_source_commit, d.zarr_converted_at, d.recording_count, d.total_recording_duration,
    d.authors, d.created_at,
    json_extract(d.sweep_stamps, '${ZARR_VERIFY_STATUS_PATH}') AS zarr_verify_status,
    json_extract(d.sweep_stamps, '${ZARR_VERIFIED_AT_PATH}') AS zarr_verified_at,
    (
      SELECT version FROM dataset_versions dv
      WHERE dv.dataset_id = d.dataset_id
      ORDER BY created_at DESC
      LIMIT 1
    ) AS latest_version
  FROM datasets d
  WHERE d.status = 'active' AND d.visibility = 'public'
    AND (d.is_sandbox = 0 OR d.is_sandbox IS NULL OR d.is_exemplar = 1)
    AND d.dataset_id = ?`;

export interface PublicDatasetRow {
  dataset_id: string;
  name: string | null;
  concept_doi: string | null;
  license: string | null;
  modalities: string | null;
  tasks: string | null;
  subject_count: number | null;
  has_hed: 0 | 1 | null;
  hed_version: string | null;
  zarr_status: string | null;
  zarr_store_count: number | null;
  zarr_source_commit: string | null;
  /** Set to `datetime('now')` by every conversion, so it is the one CONVERSION
   *  identity available without fetching anything. The projection cache keys on
   *  it: `zarr_source_commit` is the dataset repo's HEAD and an engine bump
   *  re-converts without changing it (ADR 0033), so a commit-only key served
   *  stale byte offsets and quantization constants. See
   *  `projection-cache.ts`'s module doc. */
  zarr_converted_at: string | null;
  recording_count: number | null;
  total_recording_duration: number | null;
  authors: string | null;
  created_at: string | null;
  zarr_verify_status: string | null;
  zarr_verified_at: string | null;
  latest_version: string | null;
}

/** The one public-catalog row read every MCP tool starts from. `null` for an
 *  unknown, private, or sandboxed (non-exemplar) dataset id -- the same
 *  predicate `describe_dataset` always used, now shared rather than
 *  re-written per tool. */
export async function loadPublicDatasetRow(
  db: D1Database,
  datasetId: string,
): Promise<PublicDatasetRow | null> {
  return db.prepare(PUBLIC_DATASET_ROW_SQL).bind(datasetId).first<PublicDatasetRow>();
}

/** The identical not-found tool error every MCP tool answers for an unknown,
 *  private, or sandboxed dataset id -- one wording, shared, so a caller
 *  never has to learn a second spelling of the same fact from a different
 *  tool. */
export function datasetNotFoundResult(datasetId: string): CallToolResult {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: `Dataset "${datasetId}" was not found in the public catalog (unknown id, private, or sandbox). Try search_datasets with a query to find the dataset you mean.`,
      },
    ],
  };
}

/** `zarr_verify_status` comes from free-form `sweep_stamps` JSON (no DB
 *  enum), narrowed to the closed set the contract declares -- warning (not
 *  throwing) on an out-of-enum value, so a corrupt or forward-versioned
 *  sweep stamp degrades to `null` rather than crashing the caller. Shared
 *  by `describe_dataset` (which already used this narrowing before it was
 *  extracted here) and `envelope.ts` (which used to cast the raw column
 *  unsafely instead of narrowing it at all). `context` names the caller in
 *  the warning, e.g. `"describe_dataset"` or `"envelope"`. */
export function narrowZarrVerifyStatus(
  raw: string | null,
  datasetId: string,
  context: string,
): ZarrVerifyStatusValue | null {
  if (raw === null) return null;
  if ((ZARR_VERIFY_STATUS_VALUES as readonly string[]).includes(raw)) {
    return raw as ZarrVerifyStatusValue;
  }
  console.warn(
    `[${context}] ${datasetId}: unrecognized zarr_verify_status "${raw}" (from sweep_stamps JSON)`,
  );
  return null;
}

/** True when a dataset's catalog row reports a Zarr conversion with at least
 *  one store -- the gate every recording-level tool (list_recordings,
 *  get_events, render_overview) checks before reading `index.json`. */
export function isZarrReady(row: PublicDatasetRow): boolean {
  return row.zarr_status === "ready" && (row.zarr_store_count ?? 0) > 0;
}

/** A tool error naming the dataset's actual Zarr conversion status -- never
 *  an empty recordings/events list, which would read as "no data" rather
 *  than "not converted (yet)". Shared verbatim across the three
 *  recording-level tools so the wording cannot drift between them. */
export function zarrNotReadyResult(datasetId: string, row: PublicDatasetRow): CallToolResult {
  const status = row.zarr_status ?? "pending";
  const storeNote =
    row.zarr_store_count !== null && row.zarr_store_count !== undefined
      ? `, zarr_store_count: ${row.zarr_store_count}`
      : "";
  return {
    isError: true,
    content: [
      {
        type: "text",
        text:
          `Dataset "${datasetId}" has no converted recordings to read yet ` +
          `(zarr_status: ${status}${storeNote}). Try describe_dataset for the dataset's current status.`,
      },
    ],
  };
}
