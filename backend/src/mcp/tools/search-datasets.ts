/**
 * `search_datasets` (epic #1065 phase 2, issue #1294; design doc section 5.1).
 *
 * Never an HTTP hop to the api host -- calls the same services the
 * `GET /datasets` / `GET /datasets/search` routes call, directly. Cost
 * class: one catalog fetch, no signal bytes, no `index.json` read.
 *
 *  - With `query`: `executeDatasetSearch` (FTS plus Vectorize, the same
 *    tiering `GET /datasets/search` uses). `SearchResult` rows carry
 *    neither `license` nor the zarr columns, so one follow-up D1 query
 *    (`dataset_id IN (...)`, via the shared json_each idiom) fills them for
 *    the page -- one query total, never one per hit.
 *  - Without `query`: the same public-catalog base (`buildPublicCatalogBase`)
 *    and filter clauses (`buildDatasetFilterClauses`) the list route uses, a
 *    compact SELECT of exactly the hit columns, `ORDER BY d.created_at DESC`
 *    (the list route's own default), and a `COUNT(*)` over the same
 *    predicate -- both in one `db.batch`.
 *
 * `has_zarr` means converted (`zarr_status === 'ready' && store_count > 0`),
 * never fidelity-verified -- the same predicate `buildZarrCatalog` defends.
 * A `count` of 0 is not an error; the tool description points a caller at
 * `describe_dataset` for facet vocabulary.
 */

import type { CallToolResult } from "@modelcontextprotocol/server";
import {
  type SearchDatasetsInput,
  flagToBoolean,
  searchDatasetsOutputSchema,
} from "../../../../shared/contract/mcp.js";
import { splitCsv } from "../../services/data-router.js";
import {
  type DatasetFilterOptions,
  buildDatasetFilterClauses,
  buildPublicCatalogBase,
} from "../../services/dataset-filters.js";
import {
  DATASET_ID_IN_JSON_LIST,
  DEFAULT_MIN_SCORE,
  datasetIdListParam,
  executeDatasetSearch,
} from "../../services/dataset-search.js";
import type { Bindings } from "../../types/bindings.js";

/** The license + zarr facts `SearchResult` (dataset-search.ts) does not
 *  carry, fetched in one follow-up query keyed by the page's dataset ids. */
interface LicenseAndZarr {
  dataset_id: string;
  license: string | null;
  zarr_status: string | null;
  zarr_store_count: number | null;
}

async function fetchLicenseAndZarr(
  db: D1Database,
  datasetIds: string[],
): Promise<Map<string, LicenseAndZarr>> {
  if (datasetIds.length === 0) return new Map();
  const rows = await db
    .prepare(
      // DATASET_ID_IN_JSON_LIST hardcodes the `d.` alias (dataset-search.ts),
      // so this query aliases `datasets` the same way rather than repeating
      // an unaliased duplicate of the predicate.
      `SELECT d.dataset_id, d.license, d.zarr_status, d.zarr_store_count FROM datasets d WHERE ${DATASET_ID_IN_JSON_LIST}`,
    )
    .bind(datasetIdListParam(datasetIds))
    .all<LicenseAndZarr>();
  return new Map((rows.results ?? []).map((r) => [r.dataset_id, r]));
}

function isConverted(zarrStatus: string | null, zarrStoreCount: number | null): boolean {
  return zarrStatus === "ready" && (zarrStoreCount ?? 0) > 0;
}

/** The compact row shape the no-`query` branch selects -- exactly the hit
 *  columns, nothing more. */
interface CatalogListRow {
  dataset_id: string;
  name: string | null;
  concept_doi: string | null;
  license: string | null;
  modalities: string | null;
  tasks: string | null;
  subject_count: number | null;
  has_hed: 0 | 1 | null;
  zarr_status: string | null;
  zarr_store_count: number | null;
}

export interface SearchDatasetsOutcome {
  result: CallToolResult;
}

export async function searchDatasetsTool(
  env: Pick<Bindings, "DB" | "AI" | "VECTORIZE">,
  args: SearchDatasetsInput,
): Promise<SearchDatasetsOutcome> {
  const filters: DatasetFilterOptions = {
    modality: args.modality,
    task: args.task,
    hasHed: args.has_hed,
    hasZarr: args.has_zarr,
  };

  let hits: unknown[];
  let count: number;

  if (args.query) {
    const envelope = await executeDatasetSearch(env.DB, env.AI, env.VECTORIZE, {
      query: args.query,
      filters,
      limit: args.limit,
      offset: 0,
      minScore: DEFAULT_MIN_SCORE,
    });
    const extra = await fetchLicenseAndZarr(
      env.DB,
      envelope.results.map((r) => r.id),
    );
    hits = envelope.results.map((r) => {
      const e = extra.get(r.id);
      return {
        dataset_id: r.id,
        name: r.name,
        doi: r.doi || null,
        license: e?.license ?? null,
        modalities: splitCsv(r.modalities),
        tasks: splitCsv(r.tasks),
        subject_count: r.participants,
        // SearchResult.has_hed is number | null (dataset-search.ts); the
        // catalog only ever stores 0 | 1 | null (#869) -- flagToBoolean's
        // input type is the catalog's own convention.
        has_hed: flagToBoolean(r.has_hed as 0 | 1 | null | undefined),
        has_zarr: e ? isConverted(e.zarr_status, e.zarr_store_count) : false,
      };
    });
    count = envelope.count;
  } else {
    const { from, params } = buildPublicCatalogBase("active", undefined, undefined);
    const filterClauses = buildDatasetFilterClauses(params, filters);
    const selectSql = `SELECT d.dataset_id, d.name, d.concept_doi, d.license, d.modalities, d.tasks, d.subject_count, d.has_hed, d.zarr_status, d.zarr_store_count ${from}${filterClauses} ORDER BY d.created_at DESC LIMIT ?`;
    const countSql = `SELECT COUNT(*) AS total ${from}${filterClauses}`;
    const [rowsResult, countResult] = await env.DB.batch<CatalogListRow | { total: number }>([
      env.DB.prepare(selectSql).bind(...params, args.limit),
      env.DB.prepare(countSql).bind(...params),
    ]);
    const rows = (rowsResult.results ?? []) as CatalogListRow[];
    count = ((countResult.results?.[0] as { total: number } | undefined)?.total as number) ?? 0;
    hits = rows.map((row) => ({
      dataset_id: row.dataset_id,
      name: row.name,
      doi: row.concept_doi || null,
      license: row.license,
      modalities: splitCsv(row.modalities),
      tasks: splitCsv(row.tasks),
      subject_count: row.subject_count,
      has_hed: flagToBoolean(row.has_hed),
      has_zarr: isConverted(row.zarr_status, row.zarr_store_count),
    }));
  }

  const output = searchDatasetsOutputSchema.parse({ results: hits, count, limit: args.limit });
  return {
    result: {
      content: [{ type: "text", text: JSON.stringify(output) }],
      structuredContent: output,
    },
  };
}
