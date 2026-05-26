/**
 * Page-bundle assembler for the dataset detail view.
 *
 * Returns one JSON payload combining landing + metadata + summary + catalog
 * row so the website can render the dataset detail page with a single HTTP
 * round-trip. The website's current 4-parallel-SSR + 2-deferred-client
 * waterfall stays in place until the consumer cutover ships (companion
 * nemarOrg/website#63); this endpoint is additive in the meantime.
 *
 * The BIDS tree is rendered progressively from `summary.paths` (companion
 * nemarOrg/website#64) and isn't materialized here.
 *
 * `readme.content` (embedded markdown, schema 1.1) is present in the bundle's
 * `summary` payload ONLY for versions whose summary.json has been regenerated
 * since the schema bump. Existing pre-bump versions still ship schema 1.0
 * with `readme: {path}` only — `nemar admin summary check --fix` does the
 * one-shot backfill that populates `readme.content` everywhere.
 *
 * The three S3/D1 fanouts (metadata, summary, catalog) are wrapped in
 * `Promise.allSettled` so a single component failure doesn't blank the
 * whole bundle. Landing is fetched eagerly above the fanout because we
 * need the version list to know what summary to fetch; a D1 failure there
 * propagates and the outer route returns 500 + no-store. The `complete`
 * flag drives the cache-header decision — `complete=false` gets `no-store`
 * so a partial-failure response can't be pinned at the CF edge.
 *
 * Epic #618 / phase 3 (#621). Companion: nemarOrg/website#63/#64/#65.
 */
import type { Bindings } from "../types/bindings";
import {
  type DatasetVersionRow,
  type LandingPayload,
  type NeuroschemaDataset,
  buildDatasetMetadata,
  buildLandingPayload,
} from "./data-router";
import { parseNemarMetadata } from "./datacite";
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

export type PageBundleComponent<T> = { ok: true; data: T } | { ok: false; error: string };

export interface PageBundle {
  dataset_id: string;
  version: string | null;
  served_at: string;
  complete: boolean;
  landing: PageBundleComponent<LandingPayload>;
  metadata: PageBundleComponent<NeuroschemaDataset>;
  /**
   * True when enrichment_json existed but couldn't be parsed. Metadata is
   * still present (deterministic columns + version list), but enriched
   * fields like description, authors, related_identifiers may be incomplete.
   * Independent of `metadata.ok`: metadata.ok=false means the entire load
   * failed; enrichment_degraded=true means it loaded with reduced fidelity.
   */
  enrichment_degraded: boolean;
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
async function loadCatalogRow(env: Bindings, datasetId: string): Promise<CatalogRow | null> {
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
 * Same SELECT as the private `loadVersionRows` in `routes/data.ts`, but with
 * NO try/catch swallow — a D1 failure here MUST propagate so the outer
 * `pageBundleHandler` returns 500 + `no-store`. The data.ts version returns
 * `[]` on D1 failure because its caller (landing) renders an empty-versions
 * page; here, an empty array silently flips the bundle to a `complete=true`
 * "no versions exist" response that gets cached with the success policy.
 * That would pin a D1-outage lie at the CF edge for `s-maxage=300,
 * stale-while-revalidate=86400`. Hard-fail instead.
 */
async function loadVersionRowsForBundle(
  env: Bindings,
  datasetId: string,
): Promise<DatasetVersionRow[]> {
  const result = await env.DB.prepare(
    "SELECT version, doi, created_at FROM dataset_versions WHERE dataset_id = ? ORDER BY created_at DESC",
  )
    .bind(datasetId)
    .all<DatasetVersionRow>();
  return result.results ?? [];
}

interface EnrichedMetadataResult {
  metadata: NeuroschemaDataset;
  /**
   * True when the dataset's `enrichment_json` column was non-null but
   * couldn't be parsed. The bundle still ships a (partially-populated)
   * metadata payload using the row's deterministic columns, but the
   * website should treat enriched fields (description, authors, related
   * identifiers) as unreliable. Operators should grep server logs for
   * `[page-bundle] corrupt enrichment_json` to find the affected
   * dataset and re-run the enrichment workflow.
   */
  enrichment_degraded: boolean;
}

async function loadEnrichedMetadata(
  env: Bindings,
  datasetId: string,
  versionRows: DatasetVersionRow[],
): Promise<EnrichedMetadataResult> {
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
  let enrichmentDegraded = false;
  if (row.enrichment_json) {
    try {
      parsedEnrichment = parseNemarMetadata(JSON.parse(row.enrichment_json));
    } catch (err) {
      // Corrupt enrichment_json is a real data-integrity bug (the LLM
      // pipeline wrote invalid JSON or the schema parser rejected a known
      // shape). The bundle still ships using the row's deterministic columns
      // — failing the publish over a malformed enrichment payload would be
      // worse UX — but we surface the degraded state to the website via
      // `enrichment_degraded` so it can render a "metadata may be incomplete"
      // indicator if it wants to. Also visible to ops via the structured
      // log line; grep for `[page-bundle] corrupt enrichment_json`.
      enrichmentDegraded = true;
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
  const metadata = buildDatasetMetadata({
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
  return { metadata, enrichment_degraded: enrichmentDegraded };
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

export function settled<T>(result: PromiseSettledResult<T>, label: string): PageBundleComponent<T> {
  if (result.status === "fulfilled") {
    return { ok: true, data: result.value };
  }
  const reason = result.reason;
  const msg = reason instanceof Error ? reason.message : String(reason);
  console.error(`[page-bundle] ${label} failed:`, msg);
  return { ok: false, error: msg };
}

/**
 * Pure predicate driving the cache-header decision in `pageBundleHandler`.
 * Exported so the truth table can be pinned by unit tests without
 * stubbing D1 or S3.
 *
 * Truth table:
 *   - landing not built (would have thrown above this point; included for
 *     completeness): false
 *   - any of metadata/summary/catalog fan-in failed: false
 *   - all ok AND no published version: true (summary.data is null by design)
 *   - all ok AND published version AND summary.data present: true
 *   - all ok AND published version AND summary.data null: false
 *     (S3 had no summary.json for a published version — backfill needed)
 *
 * Cache poisoning class: returning `true` for any partial-failure case would
 * let the caller cache an empty/broken bundle for the full SWR window. The
 * prior class of incident on ww2.nemar.org's SSR partials (transient upstream
 * failures returning 200 with the success Cache-Control, pinning empty
 * "no description" / "manifest unavailable" HTML at the CF edge for up to
 * 24h via stale-while-revalidate) is exactly what this predicate's
 * correctness prevents at the bundle layer.
 */
export function isBundleComplete(input: {
  landing: PageBundleComponent<unknown>;
  metadata: PageBundleComponent<unknown>;
  summary: PageBundleComponent<unknown>;
  catalogRow: PageBundleComponent<unknown>;
  resolvedVersion: string | null;
}): boolean {
  const { landing, metadata, summary, catalogRow, resolvedVersion } = input;
  if (!landing.ok || !metadata.ok || !summary.ok || !catalogRow.ok) return false;
  if (resolvedVersion === null) return true; // no version, no summary expected
  return summary.data !== null;
}

/**
 * Build the bundle. Caller MUST gate visibility (loadPublishedDataset) before
 * invoking — this function trusts the dataset exists and is publicly served.
 *
 * `versionParam` is the raw `?v=` value the consumer requested; it may be
 * with or without a leading `v`. If unknown or absent, we resolve to landing's
 * latest version.
 *
 * Failure model: only the three S3/D1 fan-in components (metadata, summary,
 * catalog) are wrapped in `Promise.allSettled`. The eager `versionRows`
 * fetch above the fanout is intentionally NOT wrapped — a D1 failure there
 * means we cannot construct a valid bundle at all, so it propagates and the
 * outer `pageBundleHandler` returns 500 + no-store. Landing is built
 * synchronously from versionRows; if that ever starts throwing, the same
 * propagation applies.
 */
export async function buildPageBundle(
  env: Bindings,
  datasetId: string,
  versionParam: string | null,
): Promise<PageBundle> {
  // landing is cheap (one D1 query); compute it eagerly so we know which
  // version to ask the summary endpoint for. D1 failure here MUST propagate
  // — see loadVersionRowsForBundle docstring.
  const versionRows = await loadVersionRowsForBundle(env, datasetId);
  const landingPayload = buildLandingPayload({ datasetId, versionRows });
  const resolvedVersion = pickVersion(versionParam, versionRows);

  // Narrow `resolvedVersion` to a non-null local so the TS flow analyzer
  // doesn't lose track of it through the .then() callback boundary.
  const versionForSummary = resolvedVersion;
  const summaryPromise: Promise<unknown> =
    versionForSummary === null
      ? Promise.resolve(null) // no published version yet
      : loadSummary(s3OptionsFromEnv(env), datasetId, versionForSummary).then((raw) => {
          if (raw === null) return null;
          try {
            return JSON.parse(raw);
          } catch (err) {
            throw new Error(
              `summary.json is not valid JSON (dataset=${datasetId} version=${versionForSummary} s3_key=${datasetId}/version/v${versionForSummary.replace(/^v/, "")}-summary.json): ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        });

  const [metadataResult, summaryResult, catalogResult] = await Promise.allSettled([
    loadEnrichedMetadata(env, datasetId, versionRows),
    summaryPromise,
    loadCatalogRow(env, datasetId),
  ]);

  const metadataComponent = settled(metadataResult, `metadata dataset=${datasetId}`);
  const summary = settled(
    summaryResult,
    `summary dataset=${datasetId} version=${resolvedVersion ?? "n/a"}`,
  );
  const catalogRow = settled(catalogResult, `catalog dataset=${datasetId}`);

  // Unwrap the {metadata, enrichment_degraded} envelope. When metadataResult
  // rejected, metadataComponent.ok is false and we don't have the inner
  // envelope; ship enrichment_degraded=false since we have no data to be
  // degraded.
  const metadata: PageBundleComponent<NeuroschemaDataset> = metadataComponent.ok
    ? { ok: true, data: metadataComponent.data.metadata }
    : metadataComponent;
  const enrichmentDegraded = metadataComponent.ok && metadataComponent.data.enrichment_degraded;

  const landing: PageBundleComponent<LandingPayload> = { ok: true, data: landingPayload };

  return {
    dataset_id: datasetId,
    version: resolvedVersion,
    served_at: new Date().toISOString(),
    complete: isBundleComplete({ landing, metadata, summary, catalogRow, resolvedVersion }),
    landing,
    metadata,
    enrichment_degraded: enrichmentDegraded,
    summary,
    catalog_row: catalogRow,
  };
}
