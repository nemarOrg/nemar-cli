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
 * Why query data.nemar.org instead of trusting D1: the manifest workflow
 * writes summary.json to S3 directly. D1 only records that the version
 * exists; it does not track summary schema version. The single source of
 * truth for "what schema is currently published" is the artifact itself.
 */
import type { Bindings } from "../types/bindings";

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

const TARGET_SCHEMA = "1.1";
const DATA_BASE = "https://data.nemar.org";
const FETCH_TIMEOUT_MS = 8_000;
const MAX_CONCURRENT = 8;

/**
 * Sentinel value the manifest generator currently emits. We compare with
 * semver-aware logic so the report doesn't go red the moment Phase 1 of
 * a future schema bump (1.2, 2.0) lands in production.
 */
function compareSchemas(have: string, want: string): "ok" | "stale" {
  const [hMajor = 0, hMinor = 0] = have.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const [wMajor = 0, wMinor = 0] = want.split(".").map((n) => Number.parseInt(n, 10) || 0);
  if (hMajor > wMajor) return "ok";
  if (hMajor < wMajor) return "stale";
  return hMinor >= wMinor ? "ok" : "stale";
}

export async function listAllPublishedVersions(env: Bindings): Promise<VersionRow[]> {
  const result = await env.DB.prepare(
    `SELECT v.dataset_id, v.version, v.doi, d.concept_doi
       FROM dataset_versions v
       JOIN datasets d ON d.dataset_id = v.dataset_id
       WHERE d.dataset_id NOT LIKE 'xx%'
         AND d.dataset_id != 'nm099999'
       ORDER BY v.dataset_id, v.version`,
  ).all<VersionRow>();
  return result.results ?? [];
}

/**
 * Fetch summary.json for one (dataset_id, version) and classify its schema.
 *
 * Errors are returned, not thrown — the caller wants a complete report
 * even when individual fetches fail (network glitch, S3 IAM drift). A
 * thrown exception here would abort the whole sweep and turn a single
 * flaky read into a blank dashboard.
 */
export async function probeSummary(
  datasetId: string,
  version: string,
  signal?: AbortSignal,
): Promise<SchemaState> {
  // Versions in D1 are stored without the "v" prefix (e.g. "1.0.0").
  // data.nemar.org path uses "v1.0.0".
  const v = version.startsWith("v") ? version : `v${version}`;
  const url = `${DATA_BASE}/${encodeURIComponent(datasetId)}/${encodeURIComponent(v)}/summary.json`;

  const ctrl = new AbortController();
  const timeoutId = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  signal?.addEventListener("abort", () => ctrl.abort(), { once: true });

  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (res.status === 404) return { kind: "missing" };
    if (!res.ok) {
      return { kind: "error", status: res.status, message: `HTTP ${res.status}` };
    }
    const body = (await res.json()) as { schema_version?: unknown };
    const schema = typeof body.schema_version === "string" ? body.schema_version : "";
    if (!schema) {
      return { kind: "error", status: 200, message: "missing schema_version" };
    }
    return compareSchemas(schema, TARGET_SCHEMA) === "ok"
      ? { kind: "ok", schema_version: schema }
      : { kind: "stale", schema_version: schema };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { kind: "error", status: 0, message };
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Map version rows to their schema state, with bounded parallelism. The
 * MAX_CONCURRENT cap protects data.nemar.org's rate limiter (123 dataset
 * fetches in tight sequence would otherwise hit 429 on the catalog
 * endpoint we share with public traffic).
 */
async function probeAll(rows: VersionRow[], signal?: AbortSignal): Promise<VersionCoverage[]> {
  const out: VersionCoverage[] = new Array(rows.length);
  let cursor = 0;

  async function worker(): Promise<void> {
    while (true) {
      const i = cursor++;
      if (i >= rows.length) return;
      const row = rows[i];
      out[i] = { ...row, state: await probeSummary(row.dataset_id, row.version, signal) };
    }
  }

  const workers = Array.from({ length: Math.min(MAX_CONCURRENT, rows.length) }, worker);
  await Promise.all(workers);
  return out;
}

export async function buildCoverageReport(
  env: Bindings,
  signal?: AbortSignal,
): Promise<CoverageReport> {
  const rows = await listAllPublishedVersions(env);
  const versions = await probeAll(rows, signal);

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
