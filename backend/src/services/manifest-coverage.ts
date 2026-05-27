/**
 * Coverage tracking for the central manifest workflow's output.
 *
 * Two questions this service answers:
 *   1. Which (dataset_id, version) pairs do NOT yet have summary.json at
 *      schema 1.1 (the schema added in nemarDatasets/.github#15)?
 *   2. Which ones are missing summary.json entirely?
 *
 * The reports feed `GET /admin/summary/coverage` (used by
 * `nemar admin summary check` and the weekly cron) and inform which
 * versions need a backfill dispatch.
 *
 * Why read S3 directly (via loadSummary) instead of fetching through
 * data.nemar.org: the data.nemar.org/<id>/<v>/summary.json route is
 * served by the SAME Worker that hosts /admin/summary/coverage. Fanning
 * out 8 concurrent fetches across 130 versions against our own Worker
 * triggers Cloudflare Worker-to-Worker subrequest behavior that times
 * out (HTTP 522) under load — observed end-to-end on first post-deploy
 * smoke. Reading the S3 object directly via SigV4 bypasses CF and the
 * self-call entirely; this is the same code path Phase 3's page-bundle
 * already uses for its summary fan-in.
 */
import type { Bindings } from "../types/bindings";
import { type PresignedUrlOptions, loadSummary } from "./s3";

export type SchemaState =
  | { kind: "ok"; schema_version: string }
  | { kind: "stale"; schema_version: string }
  | { kind: "missing" }
  | { kind: "error"; status: number; message: string };

export interface VersionRow {
  dataset_id: string;
  version: string;
  doi: string;
  concept_doi: string | null;
}

export interface VersionCoverage extends VersionRow {
  state: SchemaState;
}

export interface CoverageReport {
  generated_at: string;
  target_schema: string;
  totals: {
    versions: number;
    ok: number;
    stale: number;
    missing: number;
    error: number;
  };
  versions: VersionCoverage[];
}

/**
 * The schema version the manifest generator currently emits (per
 * nemarDatasets/.github#15, epic #618 phase 1). Bump this when a new
 * schema lands in production; consumers go red only against the new
 * target, not against the previous one.
 */
const TARGET_SCHEMA = "1.1";
const MAX_CONCURRENT = 8;

/**
 * Pluggable "fetch one summary.json's raw text" function. The production
 * wiring builds this from `Bindings` to call `loadSummary()` (direct S3
 * SigV4). Tests inject a stub so probeSummary can be unit-tested without
 * any real S3 or Bindings setup. Mirrors the dependency-injection seam
 * the page-bundle service uses for the same reason.
 *
 * Returns null when the summary does not exist (S3 404); throws on any
 * other I/O / permission failure so probeSummary can classify it as
 * `kind: "error"`.
 */
export type SummaryFetcher = (datasetId: string, version: string) => Promise<string | null>;

function s3OptionsFromEnv(env: Bindings): PresignedUrlOptions {
  return {
    bucket: env.S3_BUCKET,
    region: env.AWS_REGION,
    accessKeyId: env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
  };
}

function defaultSummaryFetcher(env: Bindings): SummaryFetcher {
  const opts = s3OptionsFromEnv(env);
  return (datasetId, version) => loadSummary(opts, datasetId, version);
}

/**
 * Semver-aware schema comparison so the report doesn't go red the moment
 * a future schema bump (1.2, 2.0) lands in production but before we've
 * updated `TARGET_SCHEMA` here. Anything ≥ target is treated as ok.
 */
function compareSchemas(have: string, want: string): "ok" | "stale" {
  const [hMajor = 0, hMinor = 0] = have.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const [wMajor = 0, wMinor = 0] = want.split(".").map((n) => Number.parseInt(n, 10) || 0);
  if (hMajor > wMajor) return "ok";
  if (hMajor < wMajor) return "stale";
  return hMinor >= wMinor ? "ok" : "stale";
}

export async function listAllPublishedVersions(env: Bindings): Promise<VersionRow[]> {
  // Filter intentionally only excludes sandbox (`xx*`) and the disposable
  // E2E test id (`nm099999`). Both `nm*` and `on*` prefixes are included —
  // on* are OpenNeuro-mirrored datasets that ARE served via data.nemar.org
  // and SHOULD have summary.json (see memory note feedback_catalog_includes_on_prefix).
  // Do NOT tighten this to `nm` only, even if a sibling sync (e.g.
  // `nemar admin sync run`, which skips on*) suggests otherwise.
  //
  // `visibility='public'` is load-bearing: the probe path below fetches
  // `data.nemar.org/<id>/<v>/summary.json`, and that route gates on
  // `loadPublishedDataset` (which 404s every non-public dataset). Without
  // this filter, every PRIVATE-but-published dataset (e.g. nm000103-nm000107
  // are intentionally private in prod) would classify as `missing` and
  // trigger `--fix` to regenerate an S3 artifact that nobody can read.
  // Mirror the public-only predicate that every public data route enforces.
  const result = await env.DB.prepare(
    `SELECT v.dataset_id, v.version, v.doi, d.concept_doi
       FROM dataset_versions v
       JOIN datasets d ON d.dataset_id = v.dataset_id
       WHERE d.visibility = 'public'
         AND d.dataset_id NOT LIKE 'xx%'
         AND d.dataset_id != 'nm099999'
       ORDER BY v.dataset_id, v.version`,
  ).all<VersionRow>();
  return result.results ?? [];
}

/**
 * Read summary.json for one (dataset_id, version) and classify its schema.
 *
 * `fetchSummary` is dependency-injected so this function can be unit-tested
 * without any S3 / Bindings setup. Production wires it via
 * `defaultSummaryFetcher(env)` which calls `loadSummary()` (direct S3
 * SigV4 read, NOT through the data.nemar.org CDN-fronted Worker route).
 *
 * Errors are returned, not thrown — the caller wants a complete report
 * even when individual reads fail (S3 IAM drift, transient 5xx, network).
 * A thrown exception here would abort the whole sweep and turn a single
 * flaky read into a blank dashboard.
 *
 * Cache-busting note: previous implementation fetched the data.nemar.org
 * route and had to append `?_cb=<ts>` to defeat its 24h s-maxage. This
 * implementation reads S3 directly so there is no CDN cache to bust —
 * every read is a fresh SigV4 (unauthenticated for public objects, signed
 * fallback for private). loadSummary's existing 403 / 404 / 5xx handling
 * is the contract.
 */
export async function probeSummary(
  fetchSummary: SummaryFetcher,
  datasetId: string,
  version: string,
): Promise<SchemaState> {
  try {
    const raw = await fetchSummary(datasetId, version);
    if (raw === null) return { kind: "missing" };
    let body: { schema_version?: unknown };
    try {
      body = JSON.parse(raw) as { schema_version?: unknown };
    } catch (parseErr) {
      return {
        kind: "error",
        status: 200,
        message: `invalid JSON: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`,
      };
    }
    const schema = typeof body.schema_version === "string" ? body.schema_version : "";
    if (!schema) {
      return { kind: "error", status: 200, message: "missing schema_version" };
    }
    return compareSchemas(schema, TARGET_SCHEMA) === "ok"
      ? { kind: "ok", schema_version: schema }
      : { kind: "stale", schema_version: schema };
  } catch (err) {
    // loadSummary throws on 403-after-fallback and 5xx. Surface as
    // {kind: "error"} with the underlying message so the report can still
    // render and the operator can grep for it. status=0 here is the
    // "not an HTTP status" sentinel for thrown-from-fetch failures, matching
    // the network-error tests below.
    const message = err instanceof Error ? err.message : String(err);
    return { kind: "error", status: 0, message };
  }
}

/**
 * Map version rows to their schema state, with bounded parallelism. The
 * MAX_CONCURRENT cap is a courtesy to S3 — fanning all N published
 * *versions* (currently ~150 across nm + on) in tight sequence is fine
 * for S3 itself but produces a long tail when one of them is slow. The
 * `out[i] = ...` (index assignment, not push) is load-bearing: the CLI
 * table and the cron's markdown report assume the output preserves the
 * input row order.
 */
async function probeAll(
  rows: VersionRow[],
  fetchSummary: SummaryFetcher,
): Promise<VersionCoverage[]> {
  const out: VersionCoverage[] = new Array(rows.length);
  let cursor = 0;

  async function worker(): Promise<void> {
    while (true) {
      const i = cursor++;
      if (i >= rows.length) return;
      const row = rows[i];
      out[i] = { ...row, state: await probeSummary(fetchSummary, row.dataset_id, row.version) };
    }
  }

  const workers = Array.from({ length: Math.min(MAX_CONCURRENT, rows.length) }, worker);
  await Promise.all(workers);
  return out;
}

/**
 * `fetchSummary` is exposed as an optional parameter so callers (mainly
 * tests) can stub the S3 read. Production callers should omit it; the
 * `defaultSummaryFetcher(env)` wiring is the one production cares about.
 */
export async function buildCoverageReport(
  env: Bindings,
  fetchSummary: SummaryFetcher = defaultSummaryFetcher(env),
): Promise<CoverageReport> {
  const rows = await listAllPublishedVersions(env);
  const versions = await probeAll(rows, fetchSummary);

  const totals = {
    versions: versions.length,
    ok: versions.filter((v) => v.state.kind === "ok").length,
    stale: versions.filter((v) => v.state.kind === "stale").length,
    missing: versions.filter((v) => v.state.kind === "missing").length,
    error: versions.filter((v) => v.state.kind === "error").length,
  };

  return {
    generated_at: new Date().toISOString(),
    target_schema: TARGET_SCHEMA,
    totals,
    versions,
  };
}
