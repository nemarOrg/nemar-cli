/**
 * Top-level Zarr discovery catalog (issue #1062, epic #1181 phase 2).
 *
 * `api.nemar.org/datasets` requires a caller to already know a dataset id
 * (or search text) to find anything. A client with neither -- human or
 * agent, and without s3:ListBucket on the data bucket -- has no front door.
 * This publishes one JSON document, `zarr-catalog.json`, at the bucket root:
 * every public dataset with a ready Zarr copy, its identity/metadata facts,
 * and the absolute `index_url` a viewer needs to stream it.
 *
 * Two halves, deliberately split:
 *  - `buildZarrCatalog` is PURE (no I/O) -- shape, ordering, and the
 *    modalities/tasks CSV-to-array conversion are unit-testable against
 *    hand-built rows.
 *  - `publishZarrCatalog` is the one production wiring: the real D1 query,
 *    then a signed S3 PUT. Called by the daily cron (index.ts, allowed on
 *    both prod and dev -- see that call site's comment) and by
 *    `POST /admin/zarr-catalog/publish` (routes/admin/zarr-catalog.ts) for
 *    an on-demand refresh. NOT called from the zarr-ready callback -- one
 *    publish per day plus on-demand is enough; a per-conversion publish
 *    would mean up to hundreds of S3 PUTs a day for a document only a
 *    catalog-level consumer reads.
 *
 * `fetchZarrCatalogObject` is the read side, used by the zarr.nemar.org
 * `GET /catalog.json` proxy (routes/zarr-data.ts) so that route doesn't need
 * its own copy of the aws4fetch signing idiom.
 */

import { AwsClient } from "aws4fetch";
import type { Bindings } from "../types/bindings.js";
import { zarrCacheBaseUrl } from "./cloudflare.js";
import { splitCsv } from "./data-router.js";
import type { PresignedUrlOptions } from "./s3.js";

const ZARR_CATALOG_FORMAT = "nemar-zarr-catalog" as const;
const ZARR_CATALOG_FORMAT_VERSION = 1 as const;
const ZARR_CATALOG_KEY = "zarr-catalog.json";

/**
 * One `datasets` row shaped exactly as {@link ZARR_CATALOG_CANDIDATE_SQL}
 * projects it, so a test can hand-build fixtures without a full row.
 */
export interface ZarrCatalogSourceRow {
  dataset_id: string;
  name: string | null;
  concept_doi: string | null;
  license: string | null;
  modalities: string | null;
  tasks: string | null;
  subject_count: number | null;
  has_hed: number | null;
  hed_version: string | null;
  zarr_store_count: number | null;
  recording_count: number | null;
  recordings_unavailable: number | null;
  total_recording_duration: number | null;
  zarr_converted_at: string | null;
  zarr_source_commit: string | null;
  zarr_errors: number | null;
}

export interface ZarrCatalogDataset {
  dataset_id: string;
  name: string | null;
  doi: string | null;
  license: string | null;
  modalities: string[];
  tasks: string[];
  subject_count: number | null;
  has_hed: number | null;
  hed_version: string | null;
  store_count: number | null;
  recording_count: number | null;
  recordings_unavailable: number | null;
  total_recording_duration: number | null;
  zarr_converted_at: string | null;
  zarr_source_commit: string | null;
  zarr_errors: number | null;
  index_url: string;
}

export interface ZarrCatalog {
  format: typeof ZARR_CATALOG_FORMAT;
  format_version: typeof ZARR_CATALOG_FORMAT_VERSION;
  generated_utc: string;
  contract_base: string;
  count: number;
  datasets: ZarrCatalogDataset[];
}

/**
 * Candidates: public, active, converted-with-at-least-one-store datasets --
 * exactly the `has_zarr` predicate (dataset-filters.ts's `hasZarr` clause),
 * ANDed with the public-catalog visibility rule. Deliberately NO
 * `is_sandbox`/`is_exemplar` exclusion: the published xx0999NN exemplar
 * copies are legitimate catalog entries when public, same reasoning as
 * recording-stats-sweep.ts's candidate SQL (see that file's module comment).
 * Ordered by dataset_id for a stable, diffable document across publishes.
 */
export const ZARR_CATALOG_CANDIDATE_SQL = `SELECT
    d.dataset_id, d.name, d.concept_doi, d.license, d.modalities, d.tasks,
    d.subject_count, d.has_hed, d.hed_version, d.zarr_store_count,
    d.recording_count, d.recordings_unavailable, d.total_recording_duration,
    d.zarr_converted_at, d.zarr_source_commit, d.zarr_errors
  FROM datasets d
  WHERE d.status = 'active' AND d.visibility = 'public'
    AND d.zarr_status = 'ready' AND COALESCE(d.zarr_store_count, 0) > 0
  ORDER BY d.dataset_id`;

/**
 * Pure builder: candidate rows -> the published document shape. No I/O, so
 * every shape/ordering/exclusion decision is testable without D1 or S3.
 *
 * `opts.contractBase` is the Zarr cache host origin (e.g.
 * "https://zarr.nemar.org"); a trailing slash is added if missing, and every
 * `index_url` is built from the same normalized base so `contract_base` and
 * `index_url` always agree on the join point. `opts.generatedUtc` defaults
 * to `new Date().toISOString()`; a test passes it explicitly for a
 * byte-stable fixture.
 */
export function buildZarrCatalog(
  rows: readonly ZarrCatalogSourceRow[],
  opts: { contractBase: string; generatedUtc?: string },
): ZarrCatalog {
  const base = opts.contractBase.endsWith("/") ? opts.contractBase : `${opts.contractBase}/`;
  const datasets: ZarrCatalogDataset[] = rows.map((row) => ({
    dataset_id: row.dataset_id,
    name: row.name,
    doi: row.concept_doi,
    license: row.license,
    // Reuse data-router.ts's splitCsv rather than re-implementing the
    // comma-join parsing a second time (#1062 brief) -- these columns are
    // plain comma-joined TEXT (migration 0020), not JSON.
    modalities: splitCsv(row.modalities),
    tasks: splitCsv(row.tasks),
    subject_count: row.subject_count,
    has_hed: row.has_hed,
    hed_version: row.hed_version,
    store_count: row.zarr_store_count,
    recording_count: row.recording_count,
    recordings_unavailable: row.recordings_unavailable,
    total_recording_duration: row.total_recording_duration,
    zarr_converted_at: row.zarr_converted_at,
    zarr_source_commit: row.zarr_source_commit,
    zarr_errors: row.zarr_errors,
    index_url: `${base}${row.dataset_id}/zarr/index.json`,
  }));
  return {
    format: ZARR_CATALOG_FORMAT,
    format_version: ZARR_CATALOG_FORMAT_VERSION,
    generated_utc: opts.generatedUtc ?? new Date().toISOString(),
    contract_base: base,
    count: datasets.length,
    datasets,
  };
}

function catalogObjectUrl(options: PresignedUrlOptions): string {
  const origin = (
    options.endpointUrl ?? `https://${options.bucket}.s3.${options.region}.amazonaws.com`
  ).replace(/\/+$/, "");
  return `${origin}/${ZARR_CATALOG_KEY}`;
}

function catalogS3Client(options: PresignedUrlOptions): AwsClient {
  return new AwsClient({
    accessKeyId: options.accessKeyId,
    secretAccessKey: options.secretAccessKey,
    region: options.region,
    service: "s3",
  });
}

/**
 * Signed GET of `zarr-catalog.json` (Worker creds -- works whether or not
 * the bucket-root key is anonymously readable, unlike the per-dataset
 * manifest helpers in s3.ts which try unsigned first). Null on 404/403
 * (not yet published, or a creds/policy gap treated as absence -- mirrors
 * `getZarrIndex`'s treatment of the analogous per-dataset object); any
 * other non-2xx throws.
 */
export async function fetchZarrCatalogObject(
  options: PresignedUrlOptions,
): Promise<{ body: string; etag: string | null } | null> {
  const aws = catalogS3Client(options);
  const signed = await aws.sign(catalogObjectUrl(options), { method: "GET" });
  const response = await fetch(signed);
  if (response.status === 404) return null;
  if (response.status === 403) {
    console.warn("[zarr-catalog] 403 fetching zarr-catalog.json (absent or credentials issue)");
    return null;
  }
  if (!response.ok) {
    throw new Error(`fetchZarrCatalogObject: HTTP ${response.status} for zarr-catalog.json`);
  }
  return { body: await response.text(), etag: response.headers.get("etag") };
}

/**
 * Signed PUT of `zarr-catalog.json`. FAILS LOUD on any non-2xx (brief #4,
 * IAM note): never swallows a 403 -- the Worker's IAM role needs an explicit
 * `s3:PutObject` grant on this key before this can succeed in production,
 * and a caller that ate the error would leave a stale/empty catalog
 * published with no signal anything was wrong.
 */
export async function uploadZarrCatalogJson(
  options: PresignedUrlOptions,
  json: string,
): Promise<void> {
  const aws = catalogS3Client(options);
  const signed = await aws.sign(catalogObjectUrl(options), {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=3600",
    },
    body: json,
  });
  const response = await fetch(signed);
  if (!response.ok) {
    throw new Error(`uploadZarrCatalogJson: HTTP ${response.status} PUTting zarr-catalog.json`);
  }
}

/**
 * Query this env's D1 for the candidate rows, build the document, and PUT it
 * to this env's own S3 bucket. One invocation per env -- prod publishes
 * prod's bucket, dev publishes dev's -- which is exactly what makes this
 * safe to run on the non-prod cron (see that call site's allowlist comment
 * in index.ts): it can never touch the production catalog object.
 *
 * Throws if `ZARR_CACHE_BASE_URL` is unconfigured (every `index_url` would
 * otherwise be a relative, non-functional path) or if the S3 PUT fails --
 * both callers (the cron wrapper and the admin route) are expected to catch
 * and log/500 rather than let this silently no-op.
 */
export async function publishZarrCatalog(env: Bindings): Promise<{ count: number; bytes: number }> {
  const base = zarrCacheBaseUrl(env);
  if (!base) {
    throw new Error("publishZarrCatalog: ZARR_CACHE_BASE_URL is not configured");
  }
  const rows = await env.DB.prepare(ZARR_CATALOG_CANDIDATE_SQL).all<ZarrCatalogSourceRow>();
  const catalog = buildZarrCatalog(rows.results ?? [], { contractBase: base });
  const json = JSON.stringify(catalog);
  await uploadZarrCatalogJson(
    {
      bucket: env.S3_BUCKET,
      region: env.AWS_REGION,
      accessKeyId: env.AWS_ACCESS_KEY_ID,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    },
    json,
  );
  return { count: catalog.count, bytes: new TextEncoder().encode(json).length };
}
