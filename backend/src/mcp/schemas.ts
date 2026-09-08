/**
 * zod 4 registration mirrors of the phase 2 tool schemas (epic #1065 phase
 * 2, issue #1294; `.context/mcp-server-design.md` section 12's "tool
 * registration under the two-copy zod split").
 *
 * `registerTool` in `@modelcontextprotocol/server@2.0.0` takes a Standard
 * Schema that also emits JSON Schema (`~standard.jsonSchema`), which zod 4
 * implements and the repo's zod 3.25.76 does not (checked in phase 1:
 * `node_modules/zod/v4/core/standard-schema.d.ts` has no `jsonSchema`
 * member). So the zod 3 schemas in `shared/contract/mcp.ts` stay the WIRE
 * CONTRACT and the test oracle -- everything outside this SDK boundary
 * (route logic, tool implementations, output validation) parses against
 * them, unchanged. These are mirrors ONLY: same field names, defaults,
 * caps and regexes, built against the `zod4` npm alias
 * (`"zod4": "npm:zod@^4.2.0"`, resolved via Bun without touching the
 * repo-wide `zod` pin) so `registerTool` gets a schema shape it can convert
 * to JSON Schema. `backend/test/mcp-schema-parity.test.ts` is the drift
 * test: it runs the same input table through both copies and asserts
 * identical accept/reject verdicts and identical parsed values, done by
 * behavior rather than by comparing two JSON Schema generators' output.
 *
 * Every field carries `.describe()` so the JSON Schema `tools/list` and
 * `server/discover` publish teaches the calling agent what the field means,
 * not just its type.
 */

import * as z4 from "zod4";
import {
  GET_EVENTS_DEFAULT_LIMIT,
  GET_EVENTS_MAX_LIMIT,
  LIST_RECORDINGS_DEFAULT_LIMIT,
  LIST_RECORDINGS_MAX_LIMIT,
  NEXT_CHEAPEST_TOOL_VALUES,
  RENDER_OVERVIEW_DEFAULT_WIDTH_PX,
  RENDER_OVERVIEW_MAX_WIDTH_PX,
  SEARCH_DATASETS_DEFAULT_LIMIT,
  SEARCH_DATASETS_MAX_LIMIT,
  ZARR_STATUS_VALUES,
  ZARR_VERIFY_STATUS_VALUES,
} from "../../../shared/contract/mcp.js";
import { DATASET_ID_RE, SOURCE_COMMIT_RE } from "../../../shared/contract/zarr-index.js";

const DATASET_ID_DESCRIPTION =
  "NEMAR dataset id: two lowercase letters (nm/on/xx) followed by six digits, e.g. nm000329.";

// ---------------------------------------------------------------------------
// search_datasets
// ---------------------------------------------------------------------------
// SEARCH_DATASETS_DEFAULT_LIMIT / SEARCH_DATASETS_MAX_LIMIT are imported from
// the zod 3 wire contract above, not redefined here -- a mirror must never
// own a number the contract already owns (the parity test would still catch
// a silent drift, but there is no reason to give it something to catch).

export const searchDatasetsInputSchema4 = z4
  .object({
    query: z4
      .string()
      .optional()
      .describe(
        "Free-text search over dataset name, description, authors, tasks and modalities. " +
          "Omit to browse the public catalog instead (a plain, filtered list).",
      ),
    modality: z4
      .string()
      .optional()
      .describe("Filter to datasets whose modalities include this substring (e.g. 'eeg', 'meg')."),
    task: z4.string().optional().describe("Filter to datasets whose tasks include this substring."),
    has_hed: z4
      .boolean()
      .optional()
      .describe("Filter to datasets with HED (Hierarchical Event Descriptors) annotations."),
    has_zarr: z4
      .boolean()
      .optional()
      .describe(
        "Filter to datasets with a converted Zarr serving copy (has_zarr means converted, " +
          "never fidelity-verified -- see describe_dataset's zarr_verify_status for that).",
      ),
    limit: z4
      .number()
      .int()
      .positive()
      .max(SEARCH_DATASETS_MAX_LIMIT)
      .default(SEARCH_DATASETS_DEFAULT_LIMIT)
      .describe(
        `Maximum number of results to return (default ${SEARCH_DATASETS_DEFAULT_LIMIT}, capped at ${SEARCH_DATASETS_MAX_LIMIT}).`,
      ),
  })
  .passthrough();

const searchDatasetsHitSchema4 = z4
  .object({
    dataset_id: z4.string().regex(DATASET_ID_RE).describe(DATASET_ID_DESCRIPTION),
    name: z4.string().describe("Dataset title."),
    doi: z4
      .string()
      .nullable()
      .optional()
      .describe("Concept DOI, or null when none has been minted."),
    license: z4
      .string()
      .nullable()
      .optional()
      .describe("SPDX-ish license identifier, or null when unset."),
    modalities: z4.array(z4.string()).optional().describe("Recorded modalities (e.g. ['eeg'])."),
    tasks: z4.array(z4.string()).optional().describe("Task names present in the dataset."),
    subject_count: z4
      .number()
      .int()
      .nullable()
      .optional()
      .describe("Number of subjects, when known."),
    has_hed: z4
      .boolean()
      .nullable()
      .optional()
      .describe("Whether the dataset carries HED annotations; null when not yet classified."),
    has_zarr: z4
      .boolean()
      .describe(
        "Whether this dataset has a converted Zarr serving copy (converted, not necessarily verified).",
      ),
  })
  .passthrough();

export const searchDatasetsOutputSchema4 = z4
  .object({
    results: z4.array(searchDatasetsHitSchema4).describe("The page of matching dataset rows."),
    count: z4
      .number()
      .int()
      .nonnegative()
      .describe("Total number of matching datasets (not just this page)."),
    limit: z4.number().int().describe("The limit this response was paged against."),
    note: z4
      .string()
      .nullable()
      .optional()
      .describe("A caveat to surface verbatim, e.g. a degraded search index or an unresolved hit."),
    truncated: z4
      .boolean()
      .optional()
      .describe("True when more rows matched than this response's candidate window could return."),
  })
  .passthrough();

// ---------------------------------------------------------------------------
// describe_dataset
// ---------------------------------------------------------------------------

export const describeDatasetInputSchema4 = z4
  .object({
    dataset_id: z4.string().regex(DATASET_ID_RE).describe(DATASET_ID_DESCRIPTION),
  })
  .passthrough();

const describeDatasetCostHintSchema4 = z4
  .object({
    next_cheapest_tool: z4
      .enum(NEXT_CHEAPEST_TOOL_VALUES)
      .describe("The cheapest tool to call next for more detail on this dataset."),
    reason: z4
      .string()
      .describe("Why that tool is the suggested next step (states the Zarr status)."),
  })
  .passthrough();

export const describeDatasetOutputSchema4 = z4
  .object({
    dataset_id: z4.string().regex(DATASET_ID_RE).describe(DATASET_ID_DESCRIPTION),
    name: z4.string().describe("Dataset title."),
    doi: z4.string().nullable().describe("Concept DOI, or null when none has been minted."),
    license: z4.string().nullable().describe("SPDX-ish license identifier, or null when unset."),
    citation: z4
      .string()
      .nullable()
      .describe("A ready-to-paste citation string, or null when the row lacks a name."),
    modalities: z4.array(z4.string()).optional().describe("Recorded modalities (e.g. ['eeg'])."),
    tasks: z4.array(z4.string()).optional().describe("Task names present in the dataset."),
    subject_count: z4
      .number()
      .int()
      .nullable()
      .optional()
      .describe("Number of subjects, when known."),
    has_hed: z4
      .boolean()
      .nullable()
      .optional()
      .describe("Whether the dataset carries HED annotations; null when not yet classified."),
    hed_version: z4.string().nullable().optional().describe("HED schema version, when known."),
    recording_count: z4
      .number()
      .int()
      .nullable()
      .optional()
      .describe("Number of recordings in the dataset."),
    total_recording_duration_s: z4
      .number()
      .nullable()
      .optional()
      .describe("Total recording duration across the dataset, in seconds."),
    zarr_status: z4
      .enum(ZARR_STATUS_VALUES)
      .nullable()
      .optional()
      .describe("Zarr conversion status: pending (not yet converted), ready, or failed."),
    zarr_verify_status: z4
      .enum(ZARR_VERIFY_STATUS_VALUES)
      .nullable()
      .optional()
      .describe(
        "The standing fidelity sweep's verdict for this dataset's Zarr copy. Null until the " +
          "daily sweep reaches a freshly-converted dataset; never a filter default.",
      ),
    zarr_source_commit: z4
      .string()
      .nullable()
      .optional()
      .describe("The commit the zarr_status/zarr_verify_status verdict was reached against."),
    zarr_store_count: z4
      .number()
      .int()
      .nullable()
      .optional()
      .describe("Number of converted Zarr stores backing zarr_status."),
    cost_hint: describeDatasetCostHintSchema4.describe("What to call next, and why."),
  })
  .passthrough();

// ---------------------------------------------------------------------------
// Provenance envelope (epic #1065 phase 3, issue #1295) -- nested inside the
// three recording-level tools' output schemas below, so it needs its own
// mirror even though it is never a top-level registerTool schema itself.
// ---------------------------------------------------------------------------

const zarrSssSchema4 = z4
  .object({
    applied: z4.boolean().optional(),
    method: z4.string().optional(),
    calibration: z4.string().optional(),
    cross_talk: z4.string().optional(),
    mne_version: z4.string().optional(),
  })
  .passthrough()
  .describe("ADR 0028 Signal-Space Separation record; present exactly when derived is true.");

const zarrUnitsReportSchema4 = z4
  .object({
    converted: z4.number().int().nonnegative().optional(),
    relabelled: z4.number().int().nonnegative().optional(),
    kept_importer_unit: z4.number().int().nonnegative().optional(),
    units_column_present: z4.boolean().optional(),
    sidecar: z4.string().optional(),
    sidecar_supplied: z4.boolean().optional(),
  })
  .passthrough();

/** Mirrors `assertSssIffDerived` (`shared/contract/zarr-index.ts`): `sss` is
 *  present if and only if `derived` is true (ADR 0028). */
function assertSssIffDerived4(
  value: { derived: boolean; sss?: unknown },
  ctx: z4.RefinementCtx,
): void {
  const hasSss = value.sss !== undefined;
  if (value.derived !== hasSss) {
    ctx.addIssue({
      code: z4.ZodIssueCode.custom,
      path: ["sss"],
      message: value.derived
        ? "derived is true but sss is absent (ADR 0028: the two travel together)"
        : "sss is present but derived is false (ADR 0028: the two travel together)",
    });
  }
}

export const provenanceEnvelopeSchema4 = z4
  .object({
    dataset_id: z4.string().regex(DATASET_ID_RE).describe(DATASET_ID_DESCRIPTION),
    doi: z4.string().nullable().describe("Concept DOI, or null when none has been minted."),
    license: z4.string().nullable().describe("SPDX-ish license identifier, or null when unset."),
    citation: z4.string().nullable().describe("A ready-to-paste citation string, or null."),
    source_commit: z4
      .string()
      .regex(SOURCE_COMMIT_RE)
      .describe("The 40-hex commit the served Zarr copy was converted from."),
    index_etag: z4
      .string()
      .nullable()
      .describe("The index.json HTTP response's ETag, when the caller kept it; null when unknown."),
    engine_version: z4.string().describe("The Zarr conversion engine's version stamp."),
    source_tree: z4.literal("raw").describe("Always raw -- ADR 0027 made discovery raw-only."),
    derived: z4.boolean().describe("True for a processed (e.g. ADR 0028 SSS-filtered) store."),
    sss: zarrSssSchema4.optional(),
    lossy: z4
      .boolean()
      .describe(
        "Always true today: every served level-0 array is int16-quantized and rate-capped.",
      ),
    dtype: z4
      .string()
      .nullable()
      .describe("From the array-metadata fetch; null until a view or level-0 array was read."),
    effective_rate_hz: z4
      .number()
      .nullable()
      .describe("The SERVING rate after the NEMAR modality cap."),
    source_rate_hz: z4.number().nullable().describe("The recording's own rate before the cap."),
    units_report: zarrUnitsReportSchema4.nullable().optional(),
    zarr_verify_status: z4
      .enum(ZARR_VERIFY_STATUS_VALUES)
      .nullable()
      .describe(
        "The standing fidelity sweep's verdict; null until the daily sweep reaches this dataset.",
      ),
    note: z4
      .string()
      .nullable()
      .optional()
      .describe("A short caveat the caller should surface verbatim; null when there is none."),
  })
  .passthrough()
  .superRefine(assertSssIffDerived4);

// ---------------------------------------------------------------------------
// list_recordings
// ---------------------------------------------------------------------------

export const listRecordingsInputSchema4 = z4
  .object({
    dataset_id: z4.string().regex(DATASET_ID_RE).describe(DATASET_ID_DESCRIPTION),
    modality: z4
      .string()
      .optional()
      .describe(
        "Case-insensitive equality filter against a group's modality or the store's modalities.",
      ),
    min_duration_s: z4
      .number()
      .nonnegative()
      .optional()
      .describe("Filter to recordings whose longest group duration is at least this many seconds."),
    include_derived: z4
      .boolean()
      .default(false)
      .describe("Include ADR 0028 SSS-filtered (derived) stores; default false."),
    limit: z4
      .number()
      .int()
      .positive()
      .max(LIST_RECORDINGS_MAX_LIMIT)
      .default(LIST_RECORDINGS_DEFAULT_LIMIT)
      .describe(
        `Maximum number of recordings to return (default ${LIST_RECORDINGS_DEFAULT_LIMIT}, capped at ${LIST_RECORDINGS_MAX_LIMIT}).`,
      ),
    offset: z4
      .number()
      .int()
      .nonnegative()
      .default(0)
      .describe("Pagination offset into the filtered set."),
  })
  .passthrough();

const recordingGroupSummarySchema4 = z4
  .object({
    name: z4.string(),
    modality: z4.string().nullable().optional(),
    rate: z4.number().nullable().optional().describe("The SERVING sample rate in Hz."),
    n_channels: z4.number().int().nullable().optional(),
    duration_s: z4.number().nullable().optional(),
    n_view_levels: z4
      .number()
      .int()
      .nonnegative()
      .nullable()
      .optional()
      .describe("How many view/* pyramid levels this group publishes; null/0 means no pyramid."),
    n_samples: z4.number().int().nonnegative().nullable().optional(),
    view_chunk_columns: z4.number().int().positive().nullable().optional(),
  })
  .passthrough();

const recordingSummarySchema4 = z4
  .object({
    path: z4.string().describe("The recording's source file path within the dataset."),
    zarr: z4
      .string()
      .describe("The recording's Zarr store path, relative to contract_base/data_base."),
    source_tree: z4.literal("raw"),
    derived: z4.boolean(),
    groups: z4.array(recordingGroupSummarySchema4).optional(),
    n_events: z4.number().int().nonnegative().optional(),
    sss: zarrSssSchema4.optional(),
    units_report: zarrUnitsReportSchema4.optional(),
  })
  .passthrough()
  .superRefine(assertSssIffDerived4);

export const listRecordingsOutputSchema4 = z4
  .object({
    dataset_id: z4.string().regex(DATASET_ID_RE).describe(DATASET_ID_DESCRIPTION),
    source_commit: z4
      .string()
      .regex(SOURCE_COMMIT_RE)
      .nullable()
      .describe(
        "The 40-hex commit this listing was read from; null when the index carries none usable.",
      ),
    recordings: z4.array(recordingSummarySchema4),
    total_count: z4.number().int().nonnegative(),
    excluded_derived_count: z4.number().int().nonnegative(),
    limit: z4.number().int(),
    offset: z4.number().int(),
    index_format_version: z4
      .number()
      .int()
      .describe("The source index document's own format_version."),
    discovered_count: z4.number().int().nonnegative().nullable(),
    failure_count: z4.number().int().nonnegative().nullable(),
    pending_count: z4.number().int().nonnegative().nullable(),
    excluded_legacy_non_raw_count: z4.number().int().nonnegative(),
    note: z4.string().nullable().optional(),
    envelope: provenanceEnvelopeSchema4.optional(),
  })
  .passthrough();

// ---------------------------------------------------------------------------
// get_events
// ---------------------------------------------------------------------------

export const getEventsInputSchema4 = z4
  .object({
    dataset_id: z4.string().regex(DATASET_ID_RE).describe(DATASET_ID_DESCRIPTION),
    recording: z4
      .string()
      .describe("A store's path or zarr field -- either identifies the recording."),
    group: z4.string().optional().describe("Filter to one channel group's events by name."),
    limit: z4
      .number()
      .int()
      .positive()
      .max(GET_EVENTS_MAX_LIMIT)
      .default(GET_EVENTS_DEFAULT_LIMIT)
      .describe(
        `Maximum number of event rows to return (default ${GET_EVENTS_DEFAULT_LIMIT}, capped at ${GET_EVENTS_MAX_LIMIT}).`,
      ),
    offset: z4.number().int().nonnegative().default(0),
  })
  .passthrough();

const eventRowSchema4 = z4
  .object({
    store_path: z4.string(),
    group_name: z4.string(),
    onset_s: z4.number(),
    duration_s: z4.number().nullable().optional(),
    sample_index: z4.number().int().nonnegative(),
    trial_type: z4.string().nullable().optional(),
    value: z4.union([z4.string(), z4.number()]).nullable().optional(),
    hed: z4.string().nullable().optional(),
  })
  .passthrough();

export const getEventsOutputSchema4 = z4
  .object({
    dataset_id: z4.string().regex(DATASET_ID_RE).describe(DATASET_ID_DESCRIPTION),
    recording: z4.string(),
    events: z4.array(eventRowSchema4),
    source: z4
      .enum(["events_parquet", "events_tsv_fallback"])
      .describe("events_parquet is exact; events_tsv_fallback's sample_index is estimated."),
    estimated: z4.boolean(),
    total_count: z4.number().int().nonnegative(),
    limit: z4.number().int(),
    offset: z4.number().int(),
    truncated: z4.boolean(),
    note: z4.string().nullable().optional(),
    envelope: provenanceEnvelopeSchema4.optional(),
  })
  .passthrough();

// ---------------------------------------------------------------------------
// render_overview
// ---------------------------------------------------------------------------

export const renderOverviewInputSchema4 = z4
  .object({
    dataset_id: z4.string().regex(DATASET_ID_RE).describe(DATASET_ID_DESCRIPTION),
    recording: z4
      .string()
      .describe("A store's path or zarr field -- either identifies the recording."),
    group: z4
      .string()
      .optional()
      .describe("Which channel group to render; defaults to the first group."),
    width_px: z4
      .number()
      .int()
      .positive()
      .max(RENDER_OVERVIEW_MAX_WIDTH_PX)
      .default(RENDER_OVERVIEW_DEFAULT_WIDTH_PX)
      .describe(
        `Rendered image width in pixels (default ${RENDER_OVERVIEW_DEFAULT_WIDTH_PX}, capped at ${RENDER_OVERVIEW_MAX_WIDTH_PX}).`,
      ),
  })
  .passthrough();

export const renderOverviewOutputSchema4 = z4
  .object({
    dataset_id: z4.string().regex(DATASET_ID_RE).describe(DATASET_ID_DESCRIPTION),
    recording: z4.string(),
    group: z4.string(),
    level: z4.number().int().positive().describe("The view pyramid level actually read."),
    width_px: z4.number().int().positive(),
    height_px: z4.number().int().positive(),
    mime_type: z4.literal("image/png"),
    columns_read: z4.number().int().nonnegative(),
    chunks_read: z4.number().int().nonnegative(),
    bytes_read: z4.number().int().nonnegative(),
    envelope: provenanceEnvelopeSchema4.optional(),
  })
  .passthrough();
