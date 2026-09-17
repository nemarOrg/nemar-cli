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
 *    the page -- one query total, never one per hit. `executeDatasetSearch`
 *    DEGRADES rather than throwing when the FTS index itself is missing
 *    (`method: "unavailable"`); this tool answers that as a tool error
 *    rather than silently returning an empty page (ADR 0005 is about
 *    partial data still serving, not about masking an infra failure as "no
 *    matches").
 *  - Without `query`: the same public-catalog base (`buildPublicCatalogBase`)
 *    and filter clauses (`buildDatasetFilterClauses`) the list route uses, a
 *    compact SELECT of exactly the hit columns, `ORDER BY d.created_at DESC`
 *    (the list route's own default), and a `COUNT(*)` over the same
 *    predicate -- both in one `db.batch`. This branch selects license/zarr
 *    facts directly, so there is no follow-up query and no unresolved-hit
 *    case here.
 *
 * `has_zarr` means converted (`zarr_status === 'ready' && store_count > 0`),
 * never fidelity-verified -- the same predicate `buildZarrCatalog` defends.
 * A `count` of 0 is not an error; the tool description points a caller at
 * `describe_dataset` for facet vocabulary.
 */

import {
  type SearchDatasetsHit,
  type SearchDatasetsInput,
  flagToBoolean,
  searchDatasetsOutputSchema,
} from "../../../../shared/contract/mcp.js";
import { RangeParseError } from "../../../../shared/range.js";
import { parseLicenseTierFilter } from "../../lib/license.js";
import { CONCEPT_DOI_SQL } from "../../services/anonymity";
import { splitCsv } from "../../services/data-router.js";
import { FacetEnumParseError, parseFacetFilters } from "../../services/dataset-facets.js";
import {
  type DatasetFilterOptions,
  buildDatasetFilterClauses,
  buildPublicCatalogBase,
} from "../../services/dataset-filters.js";
import {
  DATASET_ID_IN_JSON_LIST,
  DEFAULT_MIN_SCORE,
  type SearchResult,
  datasetIdListParam,
  executeDatasetSearch,
} from "../../services/dataset-search.js";
import type { Bindings } from "../../types/bindings.js";
import type { ToolOutcome } from "../tool-types.js";

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

/** `SearchResult.has_hed` (dataset-search.ts) is typed `number | null` --
 *  wider than the catalog's actual `0 | 1 | null` convention (#869) -- so
 *  this reads it by explicit comparison rather than casting to the
 *  narrower type `flagToBoolean` expects. Any value other than exactly `1`
 *  or `0` (there should be none) is treated as "not yet classified", same
 *  as `flagToBoolean`'s own null/undefined case. */
function hasHedFromSearchResult(value: number | null | undefined): boolean | null {
  if (value === 1) return true;
  if (value === 0) return false;
  return null;
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

export interface MergeHitsResult {
  hits: SearchDatasetsHit[];
  /** Dataset ids present in `results` but absent from `extra` -- the
   *  follow-up query found no `datasets` row for them (a race with a
   *  deletion, or a stale Vectorize id). Their hit still gets
   *  `license: null, has_zarr: false` (the closed shape the schema
   *  requires), but the caller must not present that as a confirmed
   *  absence -- see the `note` this drives in {@link searchDatasetsTool}. */
  unresolvedIds: string[];
}

/**
 * Merge `executeDatasetSearch`'s `SearchResult` rows with the follow-up
 * license/zarr map into the wire hit shape. Pure (no I/O), so the miss path
 * -- an id in `results` that `extra` has no entry for -- is unit-testable
 * with a real, deliberately incomplete `Map`, no fake D1 needed.
 */
export function mergeHitsWithCatalog(
  results: SearchResult[],
  extra: Map<string, LicenseAndZarr>,
): MergeHitsResult {
  const unresolvedIds: string[] = [];
  const hits = results.map((r) => {
    const e = extra.get(r.id);
    if (!e) unresolvedIds.push(r.id);
    return {
      dataset_id: r.id,
      name: r.name,
      doi: r.doi || null,
      license: e ? e.license : null,
      modalities: splitCsv(r.modalities),
      tasks: splitCsv(r.tasks),
      subject_count: r.participants,
      has_hed: hasHedFromSearchResult(r.has_hed),
      has_zarr: e ? isConverted(e.zarr_status, e.zarr_store_count) : false,
    };
  });
  return { hits, unresolvedIds };
}

/** A rejected filter value, reported so the caller can correct it.
 *
 *  Errors teach here (epic #1065): naming the parameter and what it received
 *  lets an agent re-plan, where a bare validation failure just ends the turn.
 *  This is also the guard against the failure that made this change necessary:
 *  the input schema is `.passthrough()`, so an argument the server does not
 *  declare is accepted and silently dropped, and unfiltered results then look
 *  filtered. A facet value that parses wrong is at least visible; see the
 *  `unknown argument` note below for the ones that cannot be. */
function badFilterOutcome(message: string): ToolOutcome {
  return {
    result: {
      isError: true,
      content: [{ type: "text", text: message }],
    },
  };
}

function unavailableOutcome(): ToolOutcome {
  return {
    result: {
      isError: true,
      content: [
        {
          type: "text",
          text:
            "The search index is temporarily unavailable. Try search_datasets again without a " +
            "query to browse the public catalog, or retry shortly.",
        },
      ],
    },
  };
}

export async function searchDatasetsTool(
  env: Pick<Bindings, "DB" | "AI" | "VECTORIZE">,
  args: SearchDatasetsInput,
): Promise<ToolOutcome> {
  // Every filter `buildDatasetFilterClauses` understands, not a hand-picked
  // four. The bespoke fields below and the declared facet table are the two
  // halves ADR 0032 deliberately keeps separate; both ride in the same options
  // bag, and both the query and no-query paths consume it.
  let facets: DatasetFilterOptions["facets"];
  try {
    facets = parseFacetFilters((key) => {
      const raw = (args as Record<string, unknown>)[key];
      return typeof raw === "string" ? raw : undefined;
    });
  } catch (err) {
    // Narrowed to the two declared parse errors, matching the HTTP route
    // (routes/datasets/catalog.ts). A broad catch would launder an internal
    // fault into "that filter value was not accepted", and the model would
    // retry differently shaped values forever against a fault that has nothing
    // to do with its input. Anything else rethrows into withToolMetrics, which
    // records outcome "exception" and logs it. ADR 0051: a specific error is
    // never overwritten by a generic one.
    if (!(err instanceof RangeParseError || err instanceof FacetEnumParseError)) throw err;
    const detail = err.message;
    return badFilterOutcome(
      `That filter value was not accepted: ${detail}. Ranges take \`10..20\`, \`64..\`, or \`..128\`; enum and version facets take a declared token.`,
    );
  }

  const filters: DatasetFilterOptions = {
    modality: args.modality,
    task: args.task,
    hasHed: args.has_hed,
    hasZarr: args.has_zarr,
    author: args.author,
    hasDoi: args.has_doi,
    hasZarrVerified: args.has_zarr_verified,
    dataComplete: args.data_complete,
    recent: args.recent,
    licenseTiers: parseLicenseTierFilter(args.license),
    facets,
    includeUnknown: args.include_unknown,
  };

  let hits: SearchDatasetsHit[];
  let count: number;
  let note: string | undefined;
  let truncated: boolean | undefined;

  if (args.query) {
    const envelope = await executeDatasetSearch(env.DB, env.AI, env.VECTORIZE, {
      query: args.query,
      filters,
      limit: args.limit,
      offset: 0,
      minScore: DEFAULT_MIN_SCORE,
    });
    if (envelope.method === "unavailable") {
      console.error("[search_datasets] search index unavailable (datasets_fts missing)");
      return unavailableOutcome();
    }
    const extra = await fetchLicenseAndZarr(
      env.DB,
      envelope.results.map((r) => r.id),
    );
    const merged = mergeHitsWithCatalog(envelope.results, extra);
    hits = merged.hits;
    count = envelope.count;
    truncated = envelope.truncated;
    const notes: string[] = [];
    if (envelope.warning) notes.push(envelope.warning);
    if (merged.unresolvedIds.length > 0) {
      console.warn(`[search_datasets] no catalog row for: ${merged.unresolvedIds.join(", ")}`);
      notes.push(
        `License and Zarr status could not be resolved for: ${merged.unresolvedIds.join(", ")}.`,
      );
    }
    note = notes.length > 0 ? notes.join(" ") : undefined;
  } else {
    const { from, params } = buildPublicCatalogBase("active", undefined, undefined);
    const filterClauses = buildDatasetFilterClauses(params, filters);
    const selectSql = `SELECT d.dataset_id, d.name, ${CONCEPT_DOI_SQL} AS concept_doi, d.license, d.modalities, d.tasks, d.subject_count, d.has_hed, d.zarr_status, d.zarr_store_count ${from}${filterClauses} ORDER BY d.created_at DESC LIMIT ?`;
    const countSql = `SELECT COUNT(*) AS total ${from}${filterClauses}`;
    const [rowsResult, countResult] = await env.DB.batch<CatalogListRow | { total: number }>([
      env.DB.prepare(selectSql).bind(...params, args.limit),
      env.DB.prepare(countSql).bind(...params),
    ]);
    const rows = (rowsResult.results ?? []) as CatalogListRow[];
    count = ((countResult.results?.[0] as { total: number } | undefined)?.total as number) ?? 0;
    hits = rows.map((row) => ({
      dataset_id: row.dataset_id,
      // NOT NULL in the schema; `?? ""` is defensive symmetry with
      // describe-dataset.ts's identical row.name handling, not a real gap.
      name: row.name ?? "",
      doi: row.concept_doi || null,
      license: row.license,
      modalities: splitCsv(row.modalities),
      tasks: splitCsv(row.tasks),
      subject_count: row.subject_count,
      has_hed: flagToBoolean(row.has_hed),
      has_zarr: isConverted(row.zarr_status, row.zarr_store_count),
    }));
  }

  const output = searchDatasetsOutputSchema.parse({
    results: hits,
    count,
    limit: args.limit,
    note,
    truncated,
  });
  return {
    result: {
      content: [{ type: "text", text: JSON.stringify(output) }],
      structuredContent: output,
    },
  };
}
