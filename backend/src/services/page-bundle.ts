/**
 * Page-bundle assembler for the dataset detail view.
 *
 * Returns one JSON payload combining landing + metadata + summary + catalog
 * row so the website can render the dataset detail page with a single HTTP
 * round-trip. Today the website fans out 4 parallel SSR fetches and 2 deferred
 * client fetches; this bundle collapses everything the page needs (except
 * the BIDS tree, which is rendered progressively from `summary.paths`) to
 * one call.
 *
 * Each upstream is fetched with `Promise.allSettled` so a single component
 * failure doesn't blank the whole bundle. The caller (data.ts route) inspects
 * the returned `complete` flag to decide on cache headers — `complete=false`
 * gets `no-store` so a transient failure isn't pinned at the edge.
 *
 * Epic #618 / phase 3 (#621). Companion: nemarOrg/website#63/#64/#65.
 */
import type { Bindings } from "../types/bindings";
import { parseNemarMetadata } from "./datacite";
import {
  type DatasetVersionRow,
  type LandingPayload,
  type NeuroschemaDataset,
  buildDatasetMetadata,
  buildLandingPayload,
} from "./data-router";
import { ORG_NAME } from "./github";
import { type PresignedUrlOptions, loadSummary } from "./s3";

export interface CatalogRow {
  dataset_id: string;
  name: string;
  description: string | null;
  license: string | null;
  modalities: string | null;
  tasks: string | null;
  authors: string | null;
  concept_doi: string | null;
  github_repo: string | null;
}

export type PageBundleComponent<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

export interface PageBundle {
  dataset_id: string;
  version: string | null;
  served_at: string;
  complete: boolean;
  landing: PageBundleComponent<LandingPayload>;
  metadata: PageBundleComponent<NeuroschemaDataset>;
  summary: PageBundleComponent<unknown>;
  catalog_row: PageBundleComponent<CatalogRow | null>;
}

/**
 * Internal fetcher for the catalog row. Reads the same shape that the
 * neuroschema metadata builder uses, plus a few presentation-side fields
 * (license, modalities, tasks, authors) that the website's right-rail
 * surfaces. Returns null if the dataset row doesn't exist; the caller
 * gates the whole bundle on `loadPublishedDataset` so a null here would
 * indicate a row that disappeared mid-request (rare, infra-level).
 */
async function loadCatalogRow(
  env: Bindings,
  datasetId: string,
): Promise<CatalogRow | null> {
  return env.DB.prepare(
    `SELECT d.dataset_id, d.name, d.description, d.concept_doi, d.github_repo,
            d.modalities, d.tasks,
            c.license, c.authors
       FROM datasets d
       LEFT JOIN nemar_catalog c ON c.id = d.dataset_id
       WHERE d.dataset_id = ?
       LIMIT 1`,
  )
    .bind(datasetId)
    .first<CatalogRow>();
}

function s3OptionsFromEnv(env: Bindings): PresignedUrlOptions {
  return {
    bucket: env.S3_BUCKET,
    region: env.AWS_REGION,
    accessKeyId: env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
  };
}

/**
 * Mirror of the private `loadVersionRows` in `routes/data.ts`. Duplicated
 * rather than refactored-shared because data.ts uses it for landing while
 * this service consumes it pre-fanned. If they ever diverge the test for
 * complete-bundle ordering should catch it.
 */
async function loadVersionRowsForBundle(
  env: Bindings,
  datasetId: string,
): Promise<DatasetVersionRow[]> {
  try {
    const result = await env.DB.prepare(
      "SELECT version, doi, created_at FROM dataset_versions WHERE dataset_id = ? ORDER BY created_at DESC",
    )
      .bind(datasetId)
      .all<DatasetVersionRow>();
    return result.results ?? [];
  } catch (err) {
    console.error(
      `[page-bundle] dataset_versions query failed dataset=${datasetId}:`,
      err instanceof Error ? err.message : String(err),
    );
    return [];
  }
}

async function loadEnrichedMetadata(
  env: Bindings,
  datasetId: string,
  versionRows: DatasetVersionRow[],
): Promise<NeuroschemaDataset> {
  const row = await env.DB.prepare(
    `SELECT dataset_id, name, description, github_repo, concept_doi,
            modalities, subject_count, age_min, age_max,
            file_size, total_files, tasks, enrichment_json
       FROM datasets
       WHERE dataset_id = ?`,
  )
    .bind(datasetId)
    .first<{
      dataset_id: string;
      name: string | null;
      description: string | null;
      github_repo: string | null;
      concept_doi: string | null;
      modalities: string | null;
      subject_count: number | null;
      age_min: number | null;
      age_max: number | null;
      file_size: number | null;
      total_files: number | null;
      tasks: string | null;
      enrichment_json: string | null;
    }>();

  if (!row) {
    // loadPublishedDataset gates upstream, so a null here is a real anomaly.
    throw new Error(`dataset row vanished mid-request: ${datasetId}`);
  }

  let parsedEnrichment = null;
  if (row.enrichment_json) {
    try {
      parsedEnrichment = parseNemarMetadata(JSON.parse(row.enrichment_json));
    } catch (err) {
      // Corrupt enrichment is logged but doesn't block the bundle — the
      // page can still render with the catalog-row fallbacks the website
      // already does.
      console.error(
        `[page-bundle] corrupt enrichment_json dataset=${datasetId}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  // Skip the manifest fetch in the page-bundle: the website renders the
  // tree progressively from `summary.paths` (per nemarOrg/website#64), so
  // `metadata.bids_index` would be unused work. Cuts a multi-MB S3 read
  // off every page-bundle response. Consumers that need bids_index can
  // hit /<id>/metadata.json directly.
  return buildDatasetMetadata({
    row: {
      dataset_id: row.dataset_id,
      // Mirror routes/data.ts metadataJsonHandler: name is NOT NULL on the
      // datasets schema, but the row type returned from prepare().first() is
      // string|null. Fall back to dataset_id if the column is somehow null,
      // matching what buildDatasetMetadata does for the BIDS title fallback.
      name: row.name ?? row.dataset_id,
      description: row.description,
      github_repo: row.github_repo,
      concept_doi: row.concept_doi,
      modalities: row.modalities,
      subject_count: row.subject_count,
      age_min: row.age_min,
      age_max: row.age_max,
      file_size: row.file_size,
      total_files: row.total_files,
      tasks: row.tasks,
    },
    parsedEnrichment,
    versions: versionRows,
    latestManifest: null,
    githubOrg: ORG_NAME,
  });
}

export function pickVersion(
  requested: string | null,
  versionRows: DatasetVersionRow[],
): string | null {
  if (versionRows.length === 0) return null;
  if (requested) {
    const stripped = requested.startsWith("v") ? requested.slice(1) : requested;
    const match = versionRows.find((v) => v.version === stripped);
    if (match) return match.version;
    // Asked for an unknown version: fall through to latest rather than 404 the
    // whole bundle. The summary component will then carry the cache-busting
    // null and the consumer renders a "version not found" UI.
  }
  return versionRows[0].version;
}

export function settled<T>(
  result: PromiseSettledResult<T>,
  label: string,
): PageBundleComponent<T> {
  if (result.status === "fulfilled") {
    return { ok: true, data: result.value };
  }
  const reason = result.reason;
  const msg = reason instanceof Error ? reason.message : String(reason);
  console.error(`[page-bundle] ${label} failed:`, msg);
  return { ok: false, error: msg };
}

/**
 * Build the bundle. Caller MUST gate visibility (loadPublishedDataset) before
 * invoking — this function trusts the dataset exists and is publicly served.
 *
 * `versionParam` is the raw `?v=` value the consumer requested; it may be
 * with or without a leading `v`. If unknown or absent, we resolve to landing's
 * latest version.
 */
export async function buildPageBundle(
  env: Bindings,
  datasetId: string,
  versionParam: string | null,
): Promise<PageBundle> {
  // landing is cheap (one D1 query); compute it eagerly so we know which
  // version to ask the summary endpoint for. Everything else fans out in
  // parallel against the resolved version.
  const versionRows = await loadVersionRowsForBundle(env, datasetId);
  const landingPayload = buildLandingPayload({ datasetId, versionRows });
  const resolvedVersion = pickVersion(versionParam, versionRows);

  // Narrow `resolvedVersion` to a non-null local so the TS flow analyzer
  // doesn't lose track of it through the .then() callback boundary.
  const versionForSummary = resolvedVersion;
  const summaryPromise: Promise<unknown> =
    versionForSummary === null
      ? Promise.resolve(null) // no published version yet
      : loadSummary(s3OptionsFromEnv(env), datasetId, versionForSummary).then(
          (raw) => {
            if (raw === null) return null;
            try {
              return JSON.parse(raw);
            } catch (err) {
              throw new Error(
                `summary.json is not valid JSON (dataset=${datasetId} version=${versionForSummary}): ${err instanceof Error ? err.message : String(err)}`,
              );
            }
          },
        );

  const [metadataResult, summaryResult, catalogResult] = await Promise.allSettled([
    loadEnrichedMetadata(env, datasetId, versionRows),
    summaryPromise,
    loadCatalogRow(env, datasetId),
  ]);

  const metadata = settled(metadataResult, `metadata dataset=${datasetId}`);
  const summary = settled(
    summaryResult,
    `summary dataset=${datasetId} version=${resolvedVersion ?? "n/a"}`,
  );
  const catalogRow = settled(catalogResult, `catalog dataset=${datasetId}`);

  // Landing is built synchronously above; wrap as an `ok` component so the
  // bundle shape stays uniform for consumers.
  const landing: PageBundleComponent<LandingPayload> = { ok: true, data: landingPayload };

  // `complete` drives the caller's cache decision. Missing summary is OK when
  // the dataset has no published versions (resolvedVersion=null + summary
  // ok=true with data=null is the expected shape). Anything else with ok=false
  // taints the bundle.
  const complete =
    landing.ok &&
    metadata.ok &&
    summary.ok &&
    catalogRow.ok &&
    (resolvedVersion === null || summary.data !== null);

  return {
    dataset_id: datasetId,
    version: resolvedVersion,
    served_at: new Date().toISOString(),
    complete,
    landing,
    metadata,
    summary,
    catalog_row: catalogRow,
  };
}
