/**
 * `describe_dataset` (epic #1065 phase 2, issue #1294; design doc section
 * 5.2). One D1 query, written fresh here on the public predicate -- NOT
 * `ZARR_CATALOG_CANDIDATE_SQL` (`services/zarr-catalog.ts`), whose WHERE
 * hardcodes `zarr_status = 'ready'`: this tool must describe a PENDING
 * dataset too, so only that query's column list is borrowed. Never
 * `index.json` -- the largest index in the catalog is 12.8 MB, and this
 * tool answers a question `catalog.json` already answers per dataset (see
 * the compute-minimization rules in `.context/mcp-server-design.md` section
 * 1). `latest_version` is not a stored column; the SAME correlated
 * subquery `GET /datasets` uses (`routes/datasets/catalog.ts`) computes it,
 * normalized to the canonical `vX.Y.Z` tag via `toVersionTag`
 * (`shared/contract/version.ts`) before `composeCitation` reads it -- the
 * one thing `routes/datasets/catalog.ts`'s own `withCanonicalLatestVersion`
 * does, without pulling a route module into a tool.
 */

import type { CallToolResult } from "@modelcontextprotocol/server";
import {
  type DescribeDatasetInput,
  type DescribeDatasetOutput,
  ZARR_STATUS_VALUES,
  ZARR_VERIFY_STATUS_VALUES,
  composeCitation,
  describeDatasetOutputSchema,
  flagToBoolean,
} from "../../../../shared/contract/mcp.js";
import { toVersionTag } from "../../../../shared/contract/version.js";
import { splitCsv } from "../../services/data-router.js";
import { ZARR_VERIFIED_AT_PATH, ZARR_VERIFY_STATUS_PATH } from "../../services/sweep-stamps.js";
import type { Bindings } from "../../types/bindings.js";
import type { ToolOutcome } from "../tool-types.js";

const DESCRIBE_DATASET_SQL = `SELECT
    d.dataset_id, d.name, d.concept_doi, d.license, d.modalities, d.tasks,
    d.subject_count, d.has_hed, d.hed_version, d.zarr_status, d.zarr_store_count,
    d.zarr_source_commit, d.recording_count, d.total_recording_duration,
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

interface DescribeDatasetRow {
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
  recording_count: number | null;
  total_recording_duration: number | null;
  authors: string | null;
  created_at: string | null;
  zarr_verify_status: string | null;
  zarr_verified_at: string | null;
  latest_version: string | null;
}

type ZarrStatusValue = (typeof ZARR_STATUS_VALUES)[number];
type ZarrVerifyStatusValue = (typeof ZARR_VERIFY_STATUS_VALUES)[number];

/** `d.zarr_status` is a plain TEXT column with no DB-enforced enum; narrow
 *  it to the closed set the contract declares, warning (not throwing) on a
 *  value outside it -- a `console.warn` for an operator to notice, not a
 *  reason to fail the whole describe_dataset call. */
function narrowZarrStatus(raw: string | null, datasetId: string): ZarrStatusValue | null {
  if (raw === null) return null;
  if ((ZARR_STATUS_VALUES as readonly string[]).includes(raw)) return raw as ZarrStatusValue;
  console.warn(`[describe_dataset] ${datasetId}: unrecognized zarr_status "${raw}"`);
  return null;
}

/** `zarr_verify_status` comes from free-form `sweep_stamps` JSON (no DB
 *  enum at all, unlike `zarr_status`'s plain column) -- narrowed the same
 *  way, with the same warn-not-throw posture. */
function narrowZarrVerifyStatus(
  raw: string | null,
  datasetId: string,
): ZarrVerifyStatusValue | null {
  if (raw === null) return null;
  if ((ZARR_VERIFY_STATUS_VALUES as readonly string[]).includes(raw)) {
    return raw as ZarrVerifyStatusValue;
  }
  console.warn(
    `[describe_dataset] ${datasetId}: unrecognized zarr_verify_status "${raw}" (from sweep_stamps JSON)`,
  );
  return null;
}

/** `next_cheapest_tool` names `list_recordings` unconditionally at this
 *  phase (`get_events`/`render_overview`/`read_window` all land phases 3-4);
 *  `reason` states the actual zarr status so a caller does not read "zero
 *  recordings" as "this dataset has no data" (design doc section 5.2).
 *  Takes the ALREADY-NARROWED status, never the raw column, so this text
 *  and the output's own `zarr_status` field can never disagree about what
 *  the dataset's status is. */
function buildCostHint(zarrStatus: ZarrStatusValue | null): DescribeDatasetOutput["cost_hint"] {
  const reason =
    zarrStatus === "ready"
      ? "ready: one cached index parse lists recordings and groups."
      : `conversion is ${zarrStatus ?? "not started"}, list_recordings will say so.`;
  return { next_cheapest_tool: "list_recordings", reason };
}

function notFoundResult(datasetId: string): CallToolResult {
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

export async function describeDatasetTool(
  env: Pick<Bindings, "DB">,
  args: DescribeDatasetInput,
): Promise<ToolOutcome> {
  const row = await env.DB.prepare(DESCRIBE_DATASET_SQL)
    .bind(args.dataset_id)
    .first<DescribeDatasetRow>();

  if (!row) {
    // The dataset id for the metrics point comes from `withToolMetrics`'s
    // own `getDatasetId(args)` now (server.ts), not from this return value
    // -- captured before this tool even ran, so it is attributed correctly
    // on this path too.
    return { result: notFoundResult(args.dataset_id) };
  }

  // The same canonicalization routes/datasets/catalog.ts's
  // withCanonicalLatestVersion applies, inlined so this tool needs no
  // import from a route module: a non-empty string gets the `v` prefix
  // (idempotent); null/empty passes through untouched.
  const canonicalLatestVersion =
    typeof row.latest_version === "string" && row.latest_version
      ? toVersionTag(row.latest_version)
      : row.latest_version;
  const citation = composeCitation({
    name: row.name,
    authors: row.authors,
    concept_doi: row.concept_doi,
    latest_version: canonicalLatestVersion,
    created_at: row.created_at,
  });

  const zarrStatus = narrowZarrStatus(row.zarr_status, row.dataset_id);
  const zarrVerifyStatus = narrowZarrVerifyStatus(row.zarr_verify_status, row.dataset_id);

  const output = describeDatasetOutputSchema.parse({
    dataset_id: row.dataset_id,
    name: row.name ?? "",
    doi: row.concept_doi ?? null,
    license: row.license ?? null,
    citation,
    modalities: splitCsv(row.modalities),
    tasks: splitCsv(row.tasks),
    subject_count: row.subject_count ?? null,
    has_hed: flagToBoolean(row.has_hed),
    hed_version: row.hed_version ?? null,
    recording_count: row.recording_count ?? null,
    total_recording_duration_s: row.total_recording_duration ?? null,
    zarr_status: zarrStatus,
    zarr_verify_status: zarrVerifyStatus,
    zarr_source_commit: row.zarr_source_commit ?? null,
    zarr_store_count: row.zarr_store_count ?? null,
    cost_hint: buildCostHint(zarrStatus),
  } satisfies DescribeDatasetOutput);

  return {
    result: {
      content: [{ type: "text", text: JSON.stringify(output) }],
      structuredContent: output,
    },
  };
}
