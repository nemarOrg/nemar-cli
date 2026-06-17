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

const OPENNEURO_GRAPHQL_URL = "https://openneuro.org/crn/graphql";

/** NEMAR is a neuroelectromagnetic archive: EEG, MEG, iEEG, EMG (incl. mixed). */
export const NEMAR_MODALITIES = new Set(["eeg", "meg", "ieeg", "emg"]);

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
    pageInfo { hasNextPage endCursor }
    edges { node { id latestSnapshot { tag summary { modalities } } } }
  }
}`;

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
    // A GraphQL error is HTTP 200 with an `errors` array (data null). Surface it
    // instead of letting parseDatasetsPage read it as an empty TERMINAL page --
    // that would silently end the scan and return a partial list (#779 review).
    const errors = isRecord(json) && Array.isArray(json.errors) ? json.errors : null;
    if (errors) {
      const msg = errors
        .map((e) => (isRecord(e) && typeof e.message === "string" ? e.message : "unknown"))
        .join("; ");
      throw new Error(`OpenNeuro GraphQL returned errors on page ${page}: ${msg}`);
    }
    const { datasets, hasNextPage, endCursor } = parseDatasetsPage(json);
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
  return out;
}

/** Imported-source-id dedup query (exported so the test runs the real SQL). */
export const IMPORTED_SOURCE_IDS_QUERY =
  "SELECT source_id FROM datasets WHERE source = 'openneuro' AND source_id IS NOT NULL";

/** Active-import scan query (status bucketed by bucketActiveImports). import_jobs.source_id is NOT NULL. */
export const ACTIVE_IMPORTS_QUERY = "SELECT source_id, status FROM import_jobs";

/**
 * OpenNeuro source ids already imported into NEMAR (the ds###### behind every
 * `on######` mirror). The primary dedup set. A D1 error re-throws (an empty set
 * would silently defeat the dedup and re-import everything) with the source
 * named so it isn't lost in the Hono dispatch stack (#779 review).
 */
export async function getImportedSourceIds(db: D1Database): Promise<Set<string>> {
  try {
    const rows = await db.prepare(IMPORTED_SOURCE_IDS_QUERY).all<{ source_id: string }>();
    return new Set((rows.results ?? []).map((r) => r.source_id));
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
    return bucketActiveImports(rows.results ?? []);
  } catch (err) {
    console.error("[openneuro-discovery] getActiveImportSourceIds D1 query failed:", err);
    throw err;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}
