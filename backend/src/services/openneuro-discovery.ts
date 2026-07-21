/**
 * OpenNeuro discovery + NEMAR dedup (epic #775, Phase 1).
 *
 * The data layer for automatic OpenNeuro import: find NEW OpenNeuro datasets in
 * NEMAR's modality scope with ZERO GitHub calls (the per-repo GitHub dedup in
 * onboard-openneuro.yml's parse-ids is exactly what trips the secondary rate
 * limit on a real scan).
 *
 *   - DISCOVER via the OpenNeuro GraphQL API (openneuro.org/crn/graphql) — not GitHub.
 *   - DEDUP via the backend's own D1: `datasets.source_id` (already imported) and
 *     `import_jobs` (in-flight / terminally-failed) — not GitHub.
 *
 * Phase 1 only exposes these primitives + the pure set-diff. The paced cron that
 * calls them, the 90-min gate, the pick-one ordering, and the dispatch are Phase 2.
 */

import { SYSTEM_USER_ID } from "../lib/constants";

const OPENNEURO_GRAPHQL_URL = "https://openneuro.org/crn/graphql";

/**
 * NEMAR's in-scope BIDS modalities (matched against OpenNeuro's `summary.modalities`,
 * which reliably tags these). EEG, MEG, iEEG, EMG are the core electromagnetic
 * signals; NEMAR is also the home for MoBI (Mobile Brain/Body Imaging), so `motion`
 * is in scope, and fNIRS (`nirs`) is included as a neighbouring biosignal. A dataset
 * is in scope if it has ANY of these (mixed datasets qualify). EMG isn't tagged on
 * OpenNeuro yet (kept here so it's caught the moment it is).
 */
export const NEMAR_MODALITIES = new Set(["eeg", "meg", "ieeg", "emg", "nirs", "motion"]);

/** Safety cap so a runaway pagination can't hammer the API; ~200 pages * 100 =
 *  20k, ample headroom over OpenNeuro's ~6k datasets. discoverOpenNeuroDatasets
 *  THROWS if the cap is actually hit, so it can never silently truncate. */
const DEFAULT_MAX_PAGES = 200;
const PAGE_SIZE = 100;

export interface DiscoveredDataset {
  /** OpenNeuro id, e.g. "ds007964". */
  id: string;
  /** Latest snapshot tag, e.g. "1.0.0", or null if none. */
  latestTag: string | null;
  /** Lowercased modality list from the latest snapshot summary. */
  modalities: string[];
}

/**
 * True iff the dataset has at least one in-scope modality. Mixed datasets (e.g.
 * eeg + mri) qualify because eeg is present. Case-insensitive; empty/garbage
 * lists are out of scope.
 */
export function keepByModality(modalities: string[]): boolean {
  if (!Array.isArray(modalities)) return false;
  for (const m of modalities) {
    if (typeof m === "string" && NEMAR_MODALITIES.has(m.toLowerCase())) return true;
  }
  return false;
}

interface DatasetsPage {
  datasets: DiscoveredDataset[];
  hasNextPage: boolean;
  endCursor: string | null;
  /** OpenNeuro's reported TOTAL dataset count (pageInfo.count), or null if absent. */
  count: number | null;
  /** Raw number of edges returned on THIS page (for the coverage cross-check). */
  edgeCount: number;
}

/**
 * Defensively parse one GraphQL `datasets` page. Tolerates any missing/garbage
 * field (missing latestSnapshot/summary/modalities -> [] / null) and never
 * throws, so a single malformed node can't abort a scan. A non-object payload
 * (e.g. a GraphQL error response) yields an empty, terminal page.
 */
export function parseDatasetsPage(json: unknown): DatasetsPage {
  const root = isRecord(json) ? json : {};
  const datasetsNode = isRecord(root.data) ? root.data.datasets : undefined;
  const conn = isRecord(datasetsNode) ? datasetsNode : {};
  const edges = Array.isArray(conn.edges) ? conn.edges : [];
  const pageInfo = isRecord(conn.pageInfo) ? conn.pageInfo : {};

  const datasets: DiscoveredDataset[] = [];
  for (const edge of edges) {
    const node = isRecord(edge) ? edge.node : undefined;
    if (!isRecord(node) || typeof node.id !== "string") continue;
    const snapshot = isRecord(node.latestSnapshot) ? node.latestSnapshot : undefined;
    const summary = snapshot && isRecord(snapshot.summary) ? snapshot.summary : undefined;
    const rawModalities = summary && Array.isArray(summary.modalities) ? summary.modalities : [];
    datasets.push({
      id: node.id,
      latestTag: snapshot && typeof snapshot.tag === "string" ? snapshot.tag : null,
      modalities: rawModalities
        .filter((m): m is string => typeof m === "string")
        .map((m) => m.toLowerCase()),
    });
  }

  return {
    datasets,
    hasNextPage: pageInfo.hasNextPage === true,
    endCursor: typeof pageInfo.endCursor === "string" ? pageInfo.endCursor : null,
    count: typeof pageInfo.count === "number" ? pageInfo.count : null,
    edgeCount: edges.length,
  };
}

/**
 * Pure set difference: datasets present on OpenNeuro but NOT already imported,
 * in-flight, or terminally-failed. Compared by OpenNeuro id; discovered order is
 * preserved so callers can pick deterministically.
 */
export function diffNewDatasets(
  discovered: DiscoveredDataset[],
  imported: Set<string>,
  inFlight: Set<string>,
  terminal: Set<string>,
): DiscoveredDataset[] {
  return discovered.filter(
    (d) => !imported.has(d.id) && !inFlight.has(d.id) && !terminal.has(d.id),
  );
}

const DATASETS_QUERY = `query Datasets($after: String) {
  datasets(first: ${PAGE_SIZE}, after: $after) {
    pageInfo { count hasNextPage endCursor }
    edges { node { id latestSnapshot { tag summary { modalities } } } }
  }
}`;

/**
 * Minimum fraction of OpenNeuro's reported total (`pageInfo.count`) the scan must
 * actually cover. If pagination silently ends early (a page wrongly reports
 * `hasNextPage:false`, or any truncation), the scan would import only the slice it
 * saw -- so we fail loud below this. 0.9 tolerates datasets added/removed mid-scan
 * while still catching any real truncation (which always drops coverage far lower).
 */
const MIN_COVERAGE = 0.9;

/**
 * Discover every in-scope OpenNeuro dataset via the GraphQL API (no GitHub).
 * Paginates by `endCursor` until exhausted or `maxPages`, keeping only datasets
 * whose modalities intersect NEMAR's scope. `fetchImpl` defaults to the Workers
 * global `fetch`; it is injectable to vary the endpoint, not to mock.
 */
export async function discoverOpenNeuroDatasets(opts?: {
  fetchImpl?: typeof fetch;
  maxPages?: number;
  signal?: AbortSignal;
}): Promise<DiscoveredDataset[]> {
  const doFetch = opts?.fetchImpl ?? fetch;
  const maxPages = opts?.maxPages ?? DEFAULT_MAX_PAGES;
  const out: DiscoveredDataset[] = [];
  let after: string | null = null;
  let hasMore = false;
  // Coverage tracking: OpenNeuro reports the total dataset count in pageInfo.count;
  // we sum the edges we actually see and cross-check at the end (see MIN_COVERAGE).
  let expectedTotal: number | null = null;
  let scannedTotal = 0;

  let page = 0;
  for (; page < maxPages; page++) {
    const res = await doFetch(OPENNEURO_GRAPHQL_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: DATASETS_QUERY, variables: { after } }),
      signal: opts?.signal,
    });
    if (!res.ok) {
      throw new Error(`OpenNeuro GraphQL returned HTTP ${res.status} on page ${page}`);
    }
    const json: unknown = await res.json();
    // GraphQL can return HTTP 200 with an `errors` array. Two very different cases:
    //   (a) FATAL: `data.datasets` is null/missing -> no usable page, surface it so
    //       the scan fails loud instead of silently truncating (#779/#784).
    //   (b) PARTIAL: `data.datasets` is present but some per-dataset field errored
    //       (OpenNeuro returns `{message:"Not Found", path:[...,"latestSnapshot"]}`
    //       for a dataset whose snapshot is gone). That dataset's node still comes
    //       back with the field nulled; parseDatasetsPage already skips nodes with
    //       no usable snapshot, so the OTHER datasets on the page are fine. Throwing
    //       here would abort the whole scan on one broken dataset and import nothing
    //       (the bug that left auto-import dead despite real candidates). Log + go on.
    const errors = isRecord(json) && Array.isArray(json.errors) ? json.errors : null;
    const data = isRecord(json) ? json.data : undefined;
    const hasUsableConnection = isRecord(data) && isRecord(data.datasets);
    if (!hasUsableConnection) {
      const detail = errors
        ? errors
            .map((e) => (isRecord(e) && typeof e.message === "string" ? e.message : "unknown"))
            .join("; ")
        : JSON.stringify(json).slice(0, 200);
      throw new Error(
        `OpenNeuro GraphQL returned no usable data.datasets on page ${page}: ${detail}`,
      );
    }
    if (errors) {
      const msg = errors
        .map((e) => (isRecord(e) && typeof e.message === "string" ? e.message : "unknown"))
        .join("; ");
      console.warn(
        `[openneuro-discovery] page ${page} has ${errors.length} partial field error(s) (proceeding with valid data): ${msg.slice(0, 300)}`,
      );
    }
    const { datasets, hasNextPage, endCursor, count, edgeCount } = parseDatasetsPage(json);
    if (expectedTotal === null && count !== null) expectedTotal = count;
    scannedTotal += edgeCount;
    for (const d of datasets) {
      if (keepByModality(d.modalities)) out.push(d);
    }
    hasMore = hasNextPage && endCursor !== null;
    if (!hasMore) break;
    after = endCursor;
  }
  // `hasMore` is still true only if the cap stopped us (a clean end breaks with
  // hasMore=false). A truncated scan silently misses datasets -- fail loud so the
  // cap (or the query) gets fixed rather than under-importing (#779 review).
  if (hasMore) {
    throw new Error(
      `discoverOpenNeuroDatasets hit the maxPages cap (${maxPages}) with more pages available; raise DEFAULT_MAX_PAGES`,
    );
  }
  // Completeness guard: cross-check the datasets we actually scanned against
  // OpenNeuro's reported total (pageInfo.count). If a page wrongly reported
  // hasNextPage:false (or any silent truncation), we'd return only the slice we
  // saw and dedup would think "few new datasets" -- so fail loud instead of
  // importing a partial view. (Skipped when count is absent, e.g. older API.)
  if (expectedTotal !== null && scannedTotal < Math.floor(expectedTotal * MIN_COVERAGE)) {
    throw new Error(
      `discoverOpenNeuroDatasets truncated: scanned ${scannedTotal} of ~${expectedTotal} OpenNeuro datasets across ${page + 1} page(s); refusing to import a partial slice (pagination ended early)`,
    );
  }
  console.log(
    `[openneuro-discovery] scan complete: ${page + 1} page(s), scanned ${scannedTotal}/${expectedTotal ?? "?"} datasets, ${out.length} in-scope`,
  );
  return out;
}

/**
 * Imported-source-id dedup query (exported so the test runs the real SQL).
 *
 * MUST exclude the folded legacy OpenNeuro CATALOG SHADOW rows (migration 0028,
 * #646): those are `owner_user_id = SYSTEM_USER_ID (-1)`, `source = 'openneuro'`,
 * `dataset_id = source_id = ds######` browse-only pointers to OpenNeuro datasets
 * NEMAR has NOT imported. Counting them as "imported" makes discovery dedup the
 * entire un-imported backlog away (candidates -> 0, engine idle) -- the 2026-06-20
 * stall. Only a REAL managed `on######` mirror (owner != SYSTEM_USER_ID) means a
 * dataset is actually imported; the import bootstrap (POST /admin/datasets/import
 * in routes/admin/imports.ts) deletes the ds shadow when it creates the managed on###### row, so
 * this never excludes a genuinely-imported dataset. Here every managed mirror
 * blocks re-import regardless of status, which is what we want.
 */
export const IMPORTED_SOURCE_IDS_QUERY = `SELECT source_id FROM datasets WHERE source = 'openneuro' AND source_id IS NOT NULL AND owner_user_id != ${SYSTEM_USER_ID}`;

/** Active-import scan query (status bucketed by bucketActiveImports). import_jobs.source_id is NOT NULL. */
export const ACTIVE_IMPORTS_QUERY = "SELECT source_id, status FROM import_jobs";

/**
 * OpenNeuro source ids already imported into NEMAR as a REAL managed `on######`
 * mirror (the ds###### behind it). The primary dedup set. Excludes the folded
 * legacy catalog shadow rows (owner = SYSTEM_USER_ID) -- see
 * IMPORTED_SOURCE_IDS_QUERY: they are un-imported browse pointers, not imports.
 * A D1 error re-throws (an empty set would silently defeat the dedup and
 * re-import everything) with the source named so it isn't lost in the Hono
 * dispatch stack (#779 review).
 */
export async function getImportedSourceIds(db: D1Database): Promise<Set<string>> {
  try {
    const rows = await db.prepare(IMPORTED_SOURCE_IDS_QUERY).all<{ source_id: string }>();
    // D1 can return success with a null `results` (not an exception); treating it
    // as [] would empty the dedup set and re-import every existing mirror, so
    // throw instead -- same guard as loadFailedJobInfo (#784 review).
    if (!rows.results) {
      throw new Error("getImportedSourceIds: D1 returned null results");
    }
    return new Set(rows.results.map((r) => r.source_id));
  } catch (err) {
    console.error("[openneuro-discovery] getImportedSourceIds D1 query failed:", err);
    throw err;
  }
}

/**
 * Pure bucketing of `import_jobs` rows into the dedup sets, so the auto-import
 * loop never re-dispatches a dataset that is mid-import or terminally parked:
 *   - inFlight  = preparing | copying | finalizing (running now)
 *   - terminal  = quarantined | rolled_back (a tracked failure to leave alone)
 * `complete` is already covered by `datasets.source_id`; plain `failed` is left
 * out because Phase 2 owns the transient-failure retry decision.
 */
export function bucketActiveImports(rows: Array<{ source_id: string; status: string }>): {
  inFlight: Set<string>;
  terminal: Set<string>;
} {
  const inFlight = new Set<string>();
  const terminal = new Set<string>();
  for (const r of rows) {
    if (r.status === "preparing" || r.status === "copying" || r.status === "finalizing") {
      inFlight.add(r.source_id);
    } else if (r.status === "quarantined" || r.status === "rolled_back") {
      terminal.add(r.source_id);
    }
  }
  return { inFlight, terminal };
}

/** Source ids that are mid-import or terminally parked (see bucketActiveImports). */
export async function getActiveImportSourceIds(
  db: D1Database,
): Promise<{ inFlight: Set<string>; terminal: Set<string> }> {
  try {
    const rows = await db
      .prepare(ACTIVE_IMPORTS_QUERY)
      .all<{ source_id: string; status: string }>();
    // Null results would empty the in-flight/terminal sets and let a mid-import
    // dataset be re-dispatched -- throw rather than treat it as [] (#784 review).
    if (!rows.results) {
      throw new Error("getActiveImportSourceIds: D1 returned null results");
    }
    return bucketActiveImports(rows.results);
  } catch (err) {
    console.error("[openneuro-discovery] getActiveImportSourceIds D1 query failed:", err);
    throw err;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}
