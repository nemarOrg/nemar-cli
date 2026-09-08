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
  SEARCH_DATASETS_DEFAULT_LIMIT,
  SEARCH_DATASETS_MAX_LIMIT,
} from "../../../shared/contract/mcp.js";
import { DATASET_ID_RE } from "../../../shared/contract/zarr-index.js";

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
      .enum(["list_recordings", "get_events", "render_overview", "read_window"])
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
      .enum(["pending", "ready", "failed"])
      .nullable()
      .optional()
      .describe("Zarr conversion status: pending (not yet converted), ready, or failed."),
    zarr_verify_status: z4
      .enum(["verified", "failed", "unverifiable"])
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
