/**
 * The upstream staleness report (epic #1046 phase 4a, #1910; ADR 0111, decision 6 and the
 * Phase 4 amendment): which OpenNeuro mirrors are behind upstream.
 *
 * READ-ONLY. It reads D1 (the mirrors, their import state, their open re-pull, their version
 * rows), asks OpenNeuro for the snapshot lists, and asks the GitHub mirror whether a newer tag has
 * arrived. The report itself writes nothing to D1, GitHub or S3, sends no mail and files no issue
 * (ADR 0052, ADR 0053, ADR 0055); authentication, which wraps the route, still stamps
 * `tokens.last_used_at`.
 * The verdicts are `shared/upstream-staleness.ts`; this file gathers the facts and pages them.
 *
 * POPULATION. Managed `on######` mirrors (`source = 'openneuro'`, not owned by the system user),
 * withdrawn ones excluded and counted on their own. Any other `on######` row (another `source`, or
 * owned by the system user) is left out and counted as `excluded_unmanaged`. `xx` fixtures are not
 * covered: how an `xx` names its upstream `ds` is an open item for the re-pull phases.
 *
 * PAGING is a keyset on `dataset_id`, never an `IN (...)` list (D1 binds at most 100 parameters)
 * and never an OFFSET. A page asks OpenNeuro for the rows that need it in batches of 50, then
 * probes the GitHub mirror for the stale ones, at most {@link PROBE_CONCURRENCY} at a time and at
 * most `probeBudget` per call. A probe the budget left out reads `stale_unverified`, which is
 * still stale.
 *
 * COST per call, for a page of 100: at most 2 GraphQL requests, at most `probeBudget` tag reads
 * plus as many control reads, one token mint, and 3 D1 statements (the page, the remaining count
 * and the totals; 2 when the page is empty, and 2 for `?dataset=`: the one row and the totals).
 * The statements authentication runs are not counted.
 */

import { TERMINAL_STATUSES } from "../../../shared/repull-state.js";
import {
  type ClassifiedMirror,
  type MirrorFacts,
  type MirrorProbe,
  type UpstreamFleetSummary,
  type UpstreamStatusPage,
  type UpstreamStatusRow,
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
const ON_ID = `d.dataset_id GLOB 'on[0-9][0-9][0-9][0-9][0-9][0-9]'`;
const MANAGED = `d.source = 'openneuro' AND d.owner_user_id != ${SYSTEM_USER_ID}`;
export const MIRROR_BASE = `${ON_ID}
  AND ${MANAGED}`;
/** The mirrors the report compares. */
export const MIRROR_POPULATION = `${MIRROR_BASE} AND d.withdrawn_at IS NULL`;

const PAGE_COLUMNS = `p.dataset_id, p.source_id, p.visibility,
       ij.status AS import_status, ij.blocklisted AS import_blocklisted,
       ij.blocklist_reason AS import_blocklist_reason,
       ur.status AS repull_status, ur.to_tag AS repull_to_tag,
       dv.version, dv.source_version, dv.source_version_basis, dv.created_at AS version_created_at`;
/**
 * The one open re-pull of a mirror, if any (`upstream_repulls`, migration 0105). The partial
 * unique index allows at most one non-terminal row per dataset, so this join adds no rows.
 */
const OPEN_REPULL = `ur.dataset_id = p.dataset_id
   AND ur.status NOT IN (${TERMINAL_STATUSES.map((s) => `'${s}'`).join(", ")})`;
const PAGE_JOINS = `  LEFT JOIN import_jobs ij ON ij.dataset_id = p.dataset_id
  LEFT JOIN upstream_repulls ur ON ${OPEN_REPULL}
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

/**
 * The whole fleet, the withdrawn mirrors and the unmanaged `on######` rows the report leaves out.
 * `COUNT(CASE ...)` is 0, never NULL; a NULL `source` is unmanaged (the CASE falls to ELSE).
 */
export const UPSTREAM_STATUS_TOTALS_SQL = `SELECT
  COUNT(CASE WHEN ${MANAGED} AND d.withdrawn_at IS NULL THEN 1 END) AS population,
  COUNT(CASE WHEN ${MANAGED} AND d.withdrawn_at IS NOT NULL THEN 1 END) AS withdrawn,
  COUNT(CASE WHEN ${MANAGED} THEN NULL ELSE 1 END) AS excluded_unmanaged
 FROM datasets d WHERE ${ON_ID}`;

interface PageRow {
  dataset_id: string;
  source_id: string | null;
  visibility: string | null;
  import_status: string | null;
  import_blocklisted: number | null;
  import_blocklist_reason: string | null;
  repull_status: string | null;
  repull_to_tag: string | null;
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
        repullStatus: row.repull_status,
        repullToTag: row.repull_to_tag,
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

/** A 200 only proves the tag exists if the body is the JSON object a description is. */
function isDescriptionBody(body: string): boolean {
  try {
    const parsed: unknown = JSON.parse(body);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

/**
 * Has `tag` reached OpenNeuro's GitHub mirror of `ds`? The same kind of proof as the backfill's
 * for a 404 (ADR 0111, Phase 2 amendment), with the control read at `HEAD` because OpenNeuro's
 * default branch name varies (the backfill reads `main`): a 404 at the tag means "not there yet"
 * only if a CONTROL read of the same repository at `HEAD`, with the same credential, succeeds.
 * `ready` and `lag` both require a 200 whose body is a JSON object, so an HTML error page served
 * with a 200 proves nothing. Any error, or a control that is absent too (the credential may not
 * see the repository), is `unverified`. The raw CDN caches a 404 for about five minutes, so a tag
 * that arrived minutes ago can read `mirror_lag`, and a re-check inside that window will not
 * change it.
 */
export async function probeGitHubMirror(
  env: Pick<Bindings, "GITHUB_RAW_BASE">,
  ds: string,
  tag: string,
  pat: string,
): Promise<MirrorProbe> {
  const read = await fetchDescriptionAtRef(env, ds, tag, pat, OPENNEURO_GITHUB_ORG);
  if (read.kind === "content") {
    return isDescriptionBody(read.body)
      ? { kind: "ready" }
      : {
          kind: "unverified",
          reason: `the GitHub mirror answered 200 at ${tag} with a body that is not a JSON object`,
        };
  }
  if (read.kind === "error") return { kind: "unverified", reason: read.reason };
  const control = await fetchDescriptionAtRef(env, ds, "HEAD", pat, OPENNEURO_GITHUB_ORG);
  if (control.kind === "content") {
    return isDescriptionBody(control.body)
      ? { kind: "lag" }
      : {
          kind: "unverified",
          reason: "the GitHub mirror answered 200 at HEAD with a body that is not a JSON object",
        };
  }
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
  /**
   * The GitHub credential for the probes, shared by the pages of one pass so the token is asked
   * for once, and a failed mint is remembered instead of being retried on every page.
   */
  probeAuth?: ProbeAuth;
}

/** The credential of one pass: the token once minted, or why it could not be. */
export interface ProbeAuth {
  pat?: string;
  failure?: string;
}

/**
 * The page size. The route rejects a junk or non-positive `limit` with a 400 before this runs;
 * here an absent or unusable one falls back to the default (the service is also called directly),
 * and anything above {@link UPSTREAM_STATUS_MAX} is clamped to it.
 */
export function clampStatusLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit) || limit < 1) return UPSTREAM_STATUS_DEFAULT;
  return Math.min(Math.floor(limit), UPSTREAM_STATUS_MAX);
}

/** Probe the stale rows that have not been probed, at most `budget` of them, in dataset order. */
async function probeStale(
  env: Bindings,
  first: readonly ClassifiedMirror[],
  budget: number,
  auth: ProbeAuth,
): Promise<{ probes: Map<string, MirrorProbe>; attempted: number }> {
  const probes = new Map<string, MirrorProbe>();
  const targets = first
    .filter((r) => r.needs_probe && r.ds !== null && r.upstream?.latest_tag)
    .slice(0, Math.max(0, budget));
  if (targets.length === 0) return { probes, attempted: 0 };
  if (auth.pat === undefined && auth.failure === undefined) {
    try {
      auth.pat = await getDatasetsToken(env);
    } catch (err) {
      auth.failure = `no GitHub credential could be obtained: ${errorMessage(err)}`;
    }
  }
  if (auth.pat === undefined) {
    const reason = auth.failure ?? "no GitHub credential could be obtained";
    for (const t of targets) probes.set(t.ds as string, { kind: "unverified", reason });
    // No request was made, so none is claimed.
    return { probes, attempted: 0 };
  }
  const pat = auth.pat;
  const results = await mapBounded(targets, PROBE_CONCURRENCY, (t) =>
    probeGitHubMirror(env, t.ds as string, t.upstream?.latest_tag as string, pat),
  );
  targets.forEach((t, i) => {
    probes.set(t.ds as string, results[i] as MirrorProbe);
  });
  return { probes, attempted: targets.length };
}

/** A D1 statement failed. The route answers 500 naming the tables; any other error is not this. */
export class UpstreamStatusDatabaseError extends Error {
  constructor(cause: unknown) {
    super(errorMessage(cause));
    this.name = "UpstreamStatusDatabaseError";
  }
}

/** Run one D1 call, tagging its failure so it can never be mistaken for a bug elsewhere. */
async function readD1<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (err) {
    throw new UpstreamStatusDatabaseError(err);
  }
}

/**
 * One page of the report. Throws {@link UpstreamStatusDatabaseError} when D1 cannot be read (the
 * route answers 500 naming the tables); everything about OpenNeuro and GitHub is reported in the
 * result, and any other throw is a defect in this code, not a database failure.
 */
export async function runUpstreamStatusPage(
  env: Bindings,
  opts: UpstreamStatusOptions = {},
): Promise<UpstreamStatusPage> {
  const limit = clampStatusLimit(opts.limit);
  const pageRows = await readD1(() =>
    opts.dataset
      ? env.DB.prepare(UPSTREAM_STATUS_ONE_SQL).bind(opts.dataset).all<PageRow>()
      : env.DB.prepare(UPSTREAM_STATUS_PAGE_SQL)
          .bind(opts.after ?? "", limit)
          .all<PageRow>(),
  );
  const mirrors = groupFacts(pageRows.results);

  const asked = mirrors.filter(needsUpstream).map((m) => m.datasetId);
  const sourceIds = asked.map((id) => `ds${id.slice(2)}`);
  const upstream = await readUpstreamSnapshots(env, sourceIds);
  const first = diffStaleMirrors(mirrors, upstream.reads);

  const budget = opts.probeBudget ?? limit;
  const { probes, attempted } = await probeStale(env, first, budget, opts.probeAuth ?? {});
  const final = diffStaleMirrors(mirrors, upstream.reads, probes);
  const rows = final.map(toWireRow);

  const last = mirrors[mirrors.length - 1];
  let remaining = 0;
  let nextCursor: string | null = null;
  if (last && !opts.dataset) {
    const left = await readD1(() =>
      env.DB.prepare(UPSTREAM_STATUS_REMAINING_SQL).bind(last.datasetId).first<{ n: number }>(),
    );
    remaining = left?.n ?? 0;
    nextCursor = remaining > 0 ? last.datasetId : null;
  }
  const totals = await readD1(() =>
    env.DB.prepare(UPSTREAM_STATUS_TOTALS_SQL).first<{
      population: number;
      withdrawn: number;
      excluded_unmanaged: number;
    }>(),
  );

  // The call "could not see" when rows needed an OpenNeuro VERDICT (a known tag) and every one of
  // them ended `unchecked`. An unknown-tag row needs no verdict: with OpenNeuro down it stays
  // `unknown`, and its reason names the failure.
  const askedIds = new Set(asked);
  const needingVerdict = rows.filter((r) => askedIds.has(r.dataset_id) && r.state !== "unknown");
  const blind = needingVerdict.length > 0 && needingVerdict.every((r) => r.state === "unchecked");

  return {
    ok: !blind,
    rows,
    counts: countUpstreamStates(rows),
    next_cursor: nextCursor,
    remaining,
    population_total: totals?.population ?? 0,
    withdrawn: totals?.withdrawn ?? 0,
    excluded_unmanaged: totals?.excluded_unmanaged ?? 0,
    upstream_requests: upstream.requests,
    probes: { attempted, budget },
    errors: upstream.errors.slice(0, MAX_ERRORS),
    ...(blind ? { error: "OpenNeuro could not be read for any mirror that needed a verdict" } : {}),
  };
}

/**
 * The most pages the weekly pass reads. A page is 100 mirrors, so this is a CEILING of 2,000
 * managed mirrors: past it `truncated` is always true, and every Monday would add a "did not reach
 * every mirror" entry to the report, a permanent alarm that gets muted (ADR 0053). When the fleet
 * nears 2,000 (the report's own "Examined N of M" line says how near), raise this. Each added page
 * costs up to 5 subrequests on the Monday tick: 2 GraphQL batches of 50 and 3 D1 statements.
 */
export const UPSTREAM_FLEET_MAX_PAGES = 20;
/** GitHub probes for the whole pass (tag reads; each may be followed by one control read). */
export const UPSTREAM_FLEET_PROBE_BUDGET = 25;

/** A batch error names the datasets of its batch; the weekly report names none. */
function withoutDatasetIds(message: string): string {
  return message.replace(/\bds\d{6}\b(\.\.ds\d{6}\b)?:?\s*/g, "").trim();
}

/**
 * The whole fleet, in counts, for the weekly report: {@link runUpstreamStatusPage} page after
 * page, at most `maxPages` pages and `probeBudget` GitHub probes for the whole pass (a stale row
 * the budget left out reads `stale_unverified`, which is still stale). It stops at the first
 * refused page, because a page of an OpenNeuro that is down costs its timeout. Throws only when
 * D1 cannot be read.
 *
 * Budget on the Monday tick, which shares ONE subrequest allowance with its other jobs. A page of
 * 100 mirrors is at most 2 GraphQL requests (batches of 50) and 3 D1 statements, so the worst case
 * is 20 pages x 5 = 100, plus at most 25 tag reads and 25 control reads, plus one token mint: about
 * 151. A fleet of about 1,000 mirrors is 10 pages, so about 50 + 51 = 101. The token is minted
 * once for the pass, and a failed mint is remembered rather than retried on every page.
 */
export async function runUpstreamFleetSummary(
  env: Bindings,
  opts: { maxPages?: number; probeBudget?: number } = {},
): Promise<UpstreamFleetSummary> {
  const maxPages = opts.maxPages ?? UPSTREAM_FLEET_MAX_PAGES;
  let probesLeft = opts.probeBudget ?? UPSTREAM_FLEET_PROBE_BUDGET;
  // Cursor pages cannot overlap, so the rows are simply collected.
  const all: UpstreamStatusRow[] = [];
  const probeAuth: ProbeAuth = {};
  const errors: string[] = [];
  let first: UpstreamStatusPage | null = null;
  let last: UpstreamStatusPage | null = null;
  let after: string | undefined;
  let stoppedEarly = false;
  for (let n = 0; n < maxPages; n++) {
    const page = await runUpstreamStatusPage(env, { after, probeBudget: probesLeft, probeAuth });
    first ??= page;
    last = page;
    all.push(...page.rows);
    for (const e of page.errors) errors.push(withoutDatasetIds(e));
    probesLeft = Math.max(0, probesLeft - page.probes.attempted);
    if (!page.ok) {
      errors.push(withoutDatasetIds(page.error ?? "OpenNeuro could not be read"));
      stoppedEarly = true;
      break;
    }
    if (page.next_cursor === null) break;
    after = page.next_cursor;
    if (n === maxPages - 1) stoppedEarly = true;
  }
  const population = last?.population_total ?? 0;
  return {
    population,
    examined: all.length,
    withdrawn: last?.withdrawn ?? 0,
    excluded_unmanaged: last?.excluded_unmanaged ?? 0,
    counts: countUpstreamStates(all),
    truncated:
      stoppedEarly ||
      all.length !== population ||
      first?.population_total !== last?.population_total,
    errors: errors.slice(0, MAX_ERRORS),
  };
}
