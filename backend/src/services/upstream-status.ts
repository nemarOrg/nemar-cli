/**
 * The upstream staleness report (epic #1046 phase 4a, #1910; ADR 0111, decision 6 and the
 * Phase 4 amendment): which OpenNeuro mirrors are behind upstream.
 *
 * READ-ONLY. It reads D1 (the mirrors, their import state, their version rows), asks OpenNeuro
 * for the snapshot lists, and asks the GitHub mirror whether a newer tag has arrived. It writes
 * nothing to D1, GitHub or S3, sends no mail and files no issue (ADR 0052, ADR 0053, ADR 0055).
 * The verdicts are `shared/upstream-staleness.ts`; this file gathers the facts and pages them.
 *
 * POPULATION. Managed `on######` mirrors (`source = 'openneuro'`, not owned by the system user),
 * withdrawn ones excluded and counted on their own. `xx` fixtures are not covered: how an `xx`
 * names its upstream `ds` is an open item for the re-pull phases.
 *
 * PAGING is a keyset on `dataset_id`, never an `IN (...)` list (D1 binds at most 100 parameters)
 * and never an OFFSET. A page asks OpenNeuro for the rows that need it in batches of 50, then
 * probes the GitHub mirror for the stale ones, at most {@link PROBE_CONCURRENCY} at a time and at
 * most `probeBudget` per call. A probe the budget left out reads `stale_unverified`, which is
 * still stale.
 *
 * COST per call, for a page of 100: at most 2 GraphQL requests, at most `probeBudget` tag reads
 * plus as many control reads, one token mint, and 4 D1 statements.
 */

import {
  type ClassifiedMirror,
  type MirrorFacts,
  type MirrorProbe,
  type UpstreamRead,
  type UpstreamStatusPage,
  countUpstreamStates,
  diffStaleMirrors,
  needsUpstream,
  toWireRow,
} from "../../../shared/upstream-staleness.js";
import { SYSTEM_USER_ID } from "../lib/constants.js";
import type { Bindings } from "../types/bindings.js";
import { getDatasetsToken } from "./github-auth.js";
import { OPENNEURO_GITHUB_ORG } from "./github/shared.js";
import { readUpstreamSnapshots } from "./openneuro-snapshots.js";
import { errorMessage } from "./repo-metadata.js";
import { fetchDescriptionAtRef } from "./source-snapshot.js";
import { mapBounded } from "./upstream-backfill.js";

export const UPSTREAM_STATUS_DEFAULT = 100;
export const UPSTREAM_STATUS_MAX = 100;
export const CURSOR_RE = /^on\d{6}$/;
export const PROBE_CONCURRENCY = 5;
/** The most batch-level problems a page carries. */
const MAX_ERRORS = 10;

/** Every managed mirror, withdrawn or not. */
export const MIRROR_BASE = `d.dataset_id GLOB 'on[0-9][0-9][0-9][0-9][0-9][0-9]'
  AND d.source = 'openneuro'
  AND d.owner_user_id != ${SYSTEM_USER_ID}`;
/** The mirrors the report compares. */
export const MIRROR_POPULATION = `${MIRROR_BASE} AND d.withdrawn_at IS NULL`;

const PAGE_COLUMNS = `p.dataset_id, p.source_id, p.visibility,
       ij.status AS import_status, ij.blocklisted AS import_blocklisted,
       ij.blocklist_reason AS import_blocklist_reason,
       dv.version, dv.source_version, dv.source_version_basis, dv.created_at AS version_created_at`;
const PAGE_JOINS = `  LEFT JOIN import_jobs ij ON ij.dataset_id = p.dataset_id
  LEFT JOIN dataset_versions dv ON dv.dataset_id = p.dataset_id
 ORDER BY p.dataset_id`;

/** One page: `?` is the keyset (the last dataset id of the previous page, or ''), then the limit. */
export const UPSTREAM_STATUS_PAGE_SQL = `WITH page AS (
  SELECT d.dataset_id, d.source_id, d.visibility FROM datasets d
   WHERE ${MIRROR_POPULATION} AND d.dataset_id > ?
   ORDER BY d.dataset_id LIMIT ?)
SELECT ${PAGE_COLUMNS}
  FROM page p
${PAGE_JOINS}`;

/** One mirror: `?` is its dataset id. */
export const UPSTREAM_STATUS_ONE_SQL = `WITH page AS (
  SELECT d.dataset_id, d.source_id, d.visibility FROM datasets d
   WHERE ${MIRROR_POPULATION} AND d.dataset_id = ?)
SELECT ${PAGE_COLUMNS}
  FROM page p
${PAGE_JOINS}`;

/** How many mirrors are left after a key. */
export const UPSTREAM_STATUS_REMAINING_SQL = `SELECT COUNT(*) AS n FROM datasets d
 WHERE ${MIRROR_POPULATION} AND d.dataset_id > ?`;

/** The whole fleet, and the withdrawn mirrors the report leaves out. `COUNT(CASE ...)` is 0, never NULL. */
export const UPSTREAM_STATUS_TOTALS_SQL = `SELECT
  COUNT(CASE WHEN d.withdrawn_at IS NULL THEN 1 END) AS population,
  COUNT(CASE WHEN d.withdrawn_at IS NOT NULL THEN 1 END) AS withdrawn
 FROM datasets d WHERE ${MIRROR_BASE}`;

interface PageRow {
  dataset_id: string;
  source_id: string | null;
  visibility: string | null;
  import_status: string | null;
  import_blocklisted: number | null;
  import_blocklist_reason: string | null;
  version: string | null;
  source_version: string | null;
  source_version_basis: string | null;
  version_created_at: string | null;
}

/** Group the joined rows by dataset, in order; a dataset with no version row has no version. */
function groupFacts(rows: readonly PageRow[]): MirrorFacts[] {
  const out: MirrorFacts[] = [];
  const byId = new Map<string, MirrorFacts>();
  for (const row of rows) {
    let facts = byId.get(row.dataset_id);
    if (!facts) {
      facts = {
        datasetId: row.dataset_id,
        sourceId: row.source_id,
        visibility: row.visibility,
        importStatus: row.import_status,
        blocklisted: row.import_blocklisted === 1,
        blocklistReason: row.import_blocklist_reason,
        versions: [],
      };
      byId.set(row.dataset_id, facts);
      out.push(facts);
    }
    if (row.version !== null) {
      facts.versions.push({
        version: row.version,
        source_version: row.source_version,
        source_version_basis: row.source_version_basis,
        created_at: row.version_created_at,
      });
    }
  }
  return out;
}

/**
 * Has `tag` reached OpenNeuro's GitHub mirror of `ds`? The proof is the one the backfill uses for
 * a 404 (ADR 0111, Phase 2 amendment): a 404 at the tag means "not there yet" only if a CONTROL
 * read of the same repository at `HEAD`, with the same credential, succeeds. Any error, or a
 * control that is absent too (the credential may not see the repository), is `unverified`.
 */
export async function probeGitHubMirror(
  env: Pick<Bindings, "GITHUB_RAW_BASE">,
  ds: string,
  tag: string,
  pat: string,
): Promise<MirrorProbe> {
  const read = await fetchDescriptionAtRef(env, ds, tag, pat, OPENNEURO_GITHUB_ORG);
  if (read.kind === "content") return { kind: "ready" };
  if (read.kind === "error") return { kind: "unverified", reason: read.reason };
  const control = await fetchDescriptionAtRef(env, ds, "HEAD", pat, OPENNEURO_GITHUB_ORG);
  if (control.kind === "content") return { kind: "lag" };
  if (control.kind === "absent") {
    return { kind: "unverified", reason: "the GitHub mirror is not readable at HEAD" };
  }
  return { kind: "unverified", reason: control.reason };
}

export interface UpstreamStatusOptions {
  /** Examine mirrors after this dataset id. */
  after?: string;
  /** Mirrors per page; clamped to 1..{@link UPSTREAM_STATUS_MAX}. */
  limit?: number;
  /** Examine exactly this mirror instead of a page. */
  dataset?: string;
  /** The most GitHub tag probes this call makes; defaults to the page size. */
  probeBudget?: number;
}

export function clampStatusLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit) || limit < 1) return UPSTREAM_STATUS_DEFAULT;
  return Math.min(Math.floor(limit), UPSTREAM_STATUS_MAX);
}

/** Probe the stale rows that have not been probed, at most `budget` of them, in dataset order. */
async function probeStale(
  env: Bindings,
  first: readonly ClassifiedMirror[],
  budget: number,
): Promise<{ probes: Map<string, MirrorProbe>; attempted: number }> {
  const probes = new Map<string, MirrorProbe>();
  const targets = first
    .filter((r) => r.needs_probe && r.ds !== null && r.upstream?.latest_tag)
    .slice(0, Math.max(0, budget));
  if (targets.length === 0) return { probes, attempted: 0 };
  let pat: string;
  try {
    pat = await getDatasetsToken(env);
  } catch (err) {
    const reason = `no GitHub credential could be obtained: ${errorMessage(err)}`;
    for (const t of targets) probes.set(t.ds as string, { kind: "unverified", reason });
    return { probes, attempted: targets.length };
  }
  const results = await mapBounded(targets, PROBE_CONCURRENCY, (t) =>
    probeGitHubMirror(env, t.ds as string, t.upstream?.latest_tag as string, pat),
  );
  targets.forEach((t, i) => {
    probes.set(t.ds as string, results[i] as MirrorProbe);
  });
  return { probes, attempted: targets.length };
}

/**
 * One page of the report. Throws only when D1 cannot be read (the route answers 500); everything
 * about OpenNeuro and GitHub is reported in the result.
 */
export async function runUpstreamStatusPage(
  env: Bindings,
  opts: UpstreamStatusOptions = {},
): Promise<UpstreamStatusPage> {
  const limit = clampStatusLimit(opts.limit);
  const pageRows = opts.dataset
    ? await env.DB.prepare(UPSTREAM_STATUS_ONE_SQL).bind(opts.dataset).all<PageRow>()
    : await env.DB.prepare(UPSTREAM_STATUS_PAGE_SQL)
        .bind(opts.after ?? "", limit)
        .all<PageRow>();
  const mirrors = groupFacts(pageRows.results);

  const asked = mirrors.filter(needsUpstream).map((m) => m.datasetId);
  const sourceIds = asked.map((id) => `ds${id.slice(2)}`);
  const upstream = await readUpstreamSnapshots(env, sourceIds);
  const first = diffStaleMirrors(mirrors, upstream.reads);

  const budget = opts.probeBudget ?? limit;
  const { probes, attempted } = await probeStale(env, first, budget);
  const final = diffStaleMirrors(mirrors, upstream.reads, probes);
  const rows = final.map(toWireRow);

  const last = mirrors[mirrors.length - 1];
  let remaining = 0;
  let nextCursor: string | null = null;
  if (last && !opts.dataset) {
    const left = await env.DB.prepare(UPSTREAM_STATUS_REMAINING_SQL)
      .bind(last.datasetId)
      .first<{ n: number }>();
    remaining = left?.n ?? 0;
    nextCursor = remaining > 0 ? last.datasetId : null;
  }
  const totals = await env.DB.prepare(UPSTREAM_STATUS_TOTALS_SQL).first<{
    population: number;
    withdrawn: number;
  }>();

  // The call "could not see" when OpenNeuro was needed and every answer it gave was a failure.
  const reads: UpstreamRead[] = sourceIds.map(
    (ds) => upstream.reads.get(ds) ?? { kind: "error", reason: "not read" },
  );
  const blind = reads.length > 0 && reads.every((r) => r.kind === "error");

  return {
    ok: !blind,
    rows,
    counts: countUpstreamStates(rows),
    next_cursor: nextCursor,
    remaining,
    population_total: totals?.population ?? 0,
    withdrawn: totals?.withdrawn ?? 0,
    upstream_requests: upstream.requests,
    probes: { attempted, budget },
    errors: upstream.errors.slice(0, MAX_ERRORS),
    ...(blind ? { error: "OpenNeuro could not be read for any mirror on this page" } : {}),
  };
}
