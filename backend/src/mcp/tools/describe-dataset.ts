/**
 * `describe_dataset` (epic #1065 phase 2, issue #1294; design doc section
 * 5.2). Reads the one shared public-catalog row (`catalog-row.ts`, extracted
 * here in phase 3, issue #1295) -- NOT `ZARR_CATALOG_CANDIDATE_SQL`
 * (`services/zarr-catalog.ts`), whose WHERE hardcodes `zarr_status = 'ready'`:
 * this tool must describe a PENDING dataset too, so only that query's column
 * list is borrowed. Never `index.json` -- the largest index in the catalog is
 * 12.8 MB, and this tool answers a question `catalog.json` already answers
 * per dataset (see the compute-minimization rules in
 * `.context/mcp-server-design.md` section 1). `latest_version` is not a
 * stored column; the SAME correlated subquery `GET /datasets` uses
 * (`routes/datasets/catalog.ts`) computes it, normalized to the canonical
 * `vX.Y.Z` tag via `toVersionTag` (`shared/contract/version.ts`) before
 * `composeCitation` reads it -- the one thing `routes/datasets/catalog.ts`'s
 * own `withCanonicalLatestVersion` does, without pulling a route module into
 * a tool.
 */

import {
  type DescribeDatasetInput,
  type DescribeDatasetOutput,
  ZARR_STATUS_VALUES,
  composeCitation,
  describeDatasetOutputSchema,
  flagToBoolean,
} from "../../../../shared/contract/mcp.js";
import { toVersionTag } from "../../../../shared/contract/version.js";
import { splitCsv } from "../../services/data-router.js";
import type { Bindings } from "../../types/bindings.js";
import {
  type PublicDatasetRow,
  datasetNotFoundResult,
  loadPublicDatasetRow,
  narrowZarrVerifyStatus,
} from "../catalog-row.js";
import type { ToolOutcome } from "../tool-types.js";

type ZarrStatusValue = (typeof ZARR_STATUS_VALUES)[number];

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

/** `next_cheapest_tool` names `list_recordings` unconditionally, and that is a
 *  cost statement rather than a completeness one: every other recording-level
 *  tool needs a recording path, and `list_recordings` is the cheapest way to
 *  learn one. All six tools ship now, `read_window` included (phase 4). `reason`
 *  states the actual
 *  zarr status so a caller does not read "zero
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

export async function describeDatasetTool(
  env: Pick<Bindings, "DB">,
  args: DescribeDatasetInput,
): Promise<ToolOutcome> {
  const row: PublicDatasetRow | null = await loadPublicDatasetRow(env.DB, args.dataset_id);

  if (!row) {
    // The dataset id for the metrics point comes from `withToolMetrics`'s
    // own `getDatasetId(args)` now (server.ts), not from this return value
    // -- captured before this tool even ran, so it is attributed correctly
    // on this path too.
    return { result: datasetNotFoundResult(args.dataset_id) };
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
  const zarrVerifyStatus = narrowZarrVerifyStatus(
    row.zarr_verify_status,
    row.dataset_id,
    "describe_dataset",
  );

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
