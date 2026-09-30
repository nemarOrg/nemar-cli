/**
 * Data Papers Sync Service (ADR 0077, nemarOrg/nemar-citations#250)
 *
 * Pulls each dataset's judge-confirmed data papers from the citations
 * dashboard's second manifest and UPDATEs them onto `datasets.data_papers`, so
 * `metadata.json` can serve a `data_papers` key. Modeled on
 * `citation-counts-sync.ts` (#804): a daily pull from the dashboard, best-effort
 * and idempotent, so a transient dashboard outage must not break the scheduled
 * run. The value comes from the same anchor gate that produces the citation
 * counts, so the two cannot disagree.
 *
 * Manifest: GET https://dashboard.nemar.org/citations/api/data-papers.json
 *   { schema: "nemar-citations/data-papers@1", last_updated,
 *     datasets: [{ dataset_id, data_papers: [{ doi, title, year, venue,
 *                                              judge_model }, ...] }, ...] }
 *
 * What a dataset's row means:
 *  - ABSENT from the manifest: no statement this run. The stored value is left
 *    exactly as it is, so a dashboard outage or a partial manifest cannot erase
 *    verdicts. (A dataset the gate has not processed is absent, so its column
 *    stays NULL: "not judged yet".)
 *  - PRESENT with a storable list: stored. `[]` is stored as '[]' and means
 *    "gated, and no data paper".
 *  - PRESENT but unstorable (bad DOI shape, too many papers, over the byte
 *    bound, not an array, bad field types, or nothing left after the ADR 0075
 *    guard): FAIL CLOSED. The dataset's column is set to NULL, because the
 *    stored claim can no longer be trusted to match the producer and a NULL
 *    makes no statement, while a stale list would keep asserting one. Logged
 *    with console.error, the dataset id and the reason.
 *  - Listed TWICE: ambiguous, so neither row is used and nothing is written.
 *
 * Schema id is checked once for the whole manifest: a different id skips the
 * whole manifest. So do a body over MAX_MANIFEST_BYTES and a list over
 * MAX_MANIFEST_ROWS. Each leaves D1 untouched.
 *
 * What this never does: INSERT (the catalog owns dataset existence), touch
 * `updated_at` (that column feeds the catalog's freshness signals and this
 * sync is not an edit of the dataset), write a value that is already stored, or
 * write any id that is not `nm######` or `on######` (NEMAR serves only those).
 *
 * There is no freshness guard: `last_updated` is ignored, so a rolled-back
 * dashboard deploy overwrites newer verdicts with older ones. Accepted; revisit
 * if it happens.
 */

import { type DataPaperEntry, serializeDataPapers, validateDataPapers } from "./data-papers";

export const DATA_PAPERS_MANIFEST_URL =
  "https://dashboard.nemar.org/citations/api/data-papers.json";
export const DATA_PAPERS_SCHEMA_ID = "nemar-citations/data-papers@1";
export const DEFAULT_FETCH_TIMEOUT_MS = 30_000;
/** A manifest body over this many bytes is refused whole, read or not. */
export const MAX_MANIFEST_BYTES = 1024 * 1024;
/** A manifest listing more datasets than this is refused whole, before any row is validated. */
export const MAX_MANIFEST_ROWS = 5000;
// D1 allows 100 bound parameters per statement; the existence lookup binds one
// per dataset, and a batch of UPDATEs binds two per statement.
export const LOOKUP_BATCH_SIZE = 50;
export const UPDATE_BATCH_SIZE = 10;

/** The only ids NEMAR serves; a `ds*` or `xx*` row is never written. */
const DATASET_ID_PATTERN = /^(?:nm|on)\d{6}$/;

export interface DataPapersRow {
  dataset_id: string;
  papers: DataPaperEntry[];
  /** The exact text to store: `serializeDataPapers(papers)`, computed once. */
  json: string;
}

export interface DataPapersManifest {
  /** Storable rows. */
  rows: DataPapersRow[];
  /** Present rows for a valid id that could not be stored; each clears its column. */
  unstorable: { dataset_id: string; reason: string }[];
  /** Every row not stored: the unstorable ones, duplicates, and rows with no usable id. */
  rejected: number;
}

// A fresh object per call: the manifest is handed to callers, and a shared
// singleton would let one caller's mutation leak into the next run.
function emptyManifest(): DataPapersManifest {
  return { rows: [], unstorable: [], rejected: 0 };
}

/**
 * Read a response body as text, or say why it is over `maxBytes`. A declared
 * Content-Length over the bound is refused without reading a byte; a body
 * without one is read as a stream and abandoned the moment it passes the bound.
 * The two reasons differ so the log says which guard fired.
 */
async function readBodyCapped(
  res: Response,
  maxBytes: number,
): Promise<{ text: string } | { tooBig: string }> {
  const declaredHeader = res.headers.get("content-length");
  const declared = declaredHeader === null ? Number.NaN : Number(declaredHeader);
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel();
    return { tooBig: `declares ${declared} bytes` };
  }
  if (!res.body) return { text: "" };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return { tooBig: `streams more than ${maxBytes} bytes` };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { text: new TextDecoder().decode(bytes) };
}

export interface FetchOptions {
  /** Overridable so the timeout can be tested without waiting 30 seconds. */
  timeoutMs?: number;
}

/**
 * Fetch + validate the manifest. Returns nothing on any failure (non-2xx,
 * timeout, oversized body or row list, unparseable body, wrong schema id): the
 * caller logs and proceeds, and no column is touched this run.
 */
export async function fetchDataPapersManifest(
  url: string = DATA_PAPERS_MANIFEST_URL,
  options: FetchOptions = {},
): Promise<DataPapersManifest> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS,
  );
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      console.warn(`[data-papers-sync] manifest fetch ${res.status} from ${url}`);
      return emptyManifest();
    }
    const read = await readBodyCapped(res, MAX_MANIFEST_BYTES);
    if ("tooBig" in read) {
      console.error(
        `[data-papers-sync] manifest ${read.tooBig} (limit ${MAX_MANIFEST_BYTES} bytes); skipping it whole`,
      );
      return emptyManifest();
    }
    const body = JSON.parse(read.text) as { schema?: unknown; datasets?: unknown };
    if (body.schema !== DATA_PAPERS_SCHEMA_ID) {
      // A different id is a producer change this code has not been taught: skip
      // the whole manifest rather than guess at a shape.
      console.warn(
        `[data-papers-sync] manifest schema is ${JSON.stringify(body.schema)}, expected ${DATA_PAPERS_SCHEMA_ID}; skipping the whole manifest`,
      );
      return emptyManifest();
    }
    if (!Array.isArray(body.datasets)) {
      console.warn("[data-papers-sync] manifest missing datasets array");
      return emptyManifest();
    }
    if (body.datasets.length > MAX_MANIFEST_ROWS) {
      console.error(
        `[data-papers-sync] manifest lists ${body.datasets.length} datasets (limit ${MAX_MANIFEST_ROWS}); skipping it whole`,
      );
      return emptyManifest();
    }
    const listed = body.datasets as unknown[];
    const idOf = (raw: unknown): string => {
      const id = (raw as { dataset_id?: unknown } | null)?.dataset_id;
      return typeof id === "string" ? id : "";
    };
    const listings = new Map<string, number>();
    for (const raw of listed) {
      const id = idOf(raw);
      if (id !== "") listings.set(id, (listings.get(id) ?? 0) + 1);
    }

    const manifest = emptyManifest();
    for (const raw of listed) {
      const id = idOf(raw);
      if (!DATASET_ID_PATTERN.test(id)) {
        manifest.rejected++;
        console.warn(
          `[data-papers-sync] skipped a row with ${id === "" ? "no dataset_id" : `dataset_id ${JSON.stringify(id)}`} (NEMAR serves only nm and on ids)`,
        );
        continue;
      }
      if ((listings.get(id) ?? 0) > 1) {
        // Two rows for one dataset: which is right is unknowable, so use neither
        // and write nothing, not even a clear.
        manifest.rejected++;
        console.warn(`[data-papers-sync] skipped ${id}: listed more than once`);
        continue;
      }
      const checked = validateDataPapers((raw as { data_papers?: unknown }).data_papers, id);
      if (!checked.ok) {
        manifest.rejected++;
        manifest.unstorable.push({ dataset_id: id, reason: checked.reason });
        console.error(
          `[data-papers-sync] ${id}: row is not storable (${checked.reason}); its data_papers will be cleared`,
        );
        continue;
      }
      manifest.rows.push({
        dataset_id: id,
        papers: checked.papers,
        json: serializeDataPapers(checked.papers),
      });
    }
    return manifest;
  } catch (err) {
    console.warn(
      `[data-papers-sync] manifest fetch failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return emptyManifest();
  } finally {
    clearTimeout(timeout);
  }
}

export interface DataPapersSyncSummary {
  /** Storable rows taken from the manifest. */
  fetched: number;
  /** Rows not stored: unstorable, duplicated, or without a usable id. */
  rejected: number;
  /** Unstorable rows whose previously stored list was cleared to NULL. */
  cleared: number;
  /** Rows whose stored value changed. */
  updated: number;
  /** Rows already holding exactly this value. */
  unchanged: number;
  /** Rows naming a dataset the catalog does not have. */
  unknown: number;
  /** Lookup or write chunks D1 refused; their rows were left as they were. */
  failedChunks: number;
}

/**
 * Write the manifest onto EXISTING datasets, matched by `dataset_id` only (a
 * manifest `ds-*` row does not reach an `on-*` row: the catalog carries the
 * `on-*` id and the judge runs on it). Never INSERTs, never touches
 * `updated_at`, and only writes a row whose stored text differs. A chunk that D1
 * refuses is logged and counted, and the remaining chunks still run.
 */
export async function syncDataPapers(
  db: D1Database,
  manifest: Pick<DataPapersManifest, "rows" | "unstorable">,
): Promise<Omit<DataPapersSyncSummary, "rejected" | "fetched">> {
  let updated = 0;
  let cleared = 0;
  let unchanged = 0;
  let unknown = 0;
  let failedChunks = 0;

  const ids = [
    ...manifest.rows.map((r) => r.dataset_id),
    ...manifest.unstorable.map((u) => u.dataset_id),
  ];
  const stored = new Map<string, string | null>();
  const looked = new Set<string>();
  for (let i = 0; i < ids.length; i += LOOKUP_BATCH_SIZE) {
    const batch = ids.slice(i, i + LOOKUP_BATCH_SIZE);
    try {
      const placeholders = batch.map(() => "?").join(", ");
      const existing = await db
        .prepare(
          `SELECT dataset_id, data_papers FROM datasets WHERE dataset_id IN (${placeholders})`,
        )
        .bind(...batch)
        .all<{ dataset_id: string; data_papers: string | null }>();
      for (const id of batch) looked.add(id);
      for (const r of existing.results ?? []) stored.set(r.dataset_id, r.data_papers);
    } catch (err) {
      failedChunks++;
      console.error(
        `[data-papers-sync] lookup of ${batch.length} datasets failed; leaving them as they were:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  const changed: DataPapersRow[] = [];
  for (const row of manifest.rows) {
    if (!looked.has(row.dataset_id)) continue; // its lookup failed: already counted
    if (!stored.has(row.dataset_id)) unknown++;
    else if (stored.get(row.dataset_id) === row.json) unchanged++;
    else changed.push(row);
  }
  const toClear: string[] = [];
  for (const u of manifest.unstorable) {
    if (!looked.has(u.dataset_id)) continue;
    if (!stored.has(u.dataset_id)) unknown++;
    else if (stored.get(u.dataset_id) !== null) toClear.push(u.dataset_id);
    // Already NULL: it already makes no statement, so there is nothing to write.
  }

  for (let j = 0; j < changed.length; j += UPDATE_BATCH_SIZE) {
    const chunk = changed.slice(j, j + UPDATE_BATCH_SIZE);
    try {
      const results = await db.batch(
        chunk.map((r) =>
          db
            .prepare("UPDATE datasets SET data_papers = ? WHERE dataset_id = ?")
            .bind(r.json, r.dataset_id),
        ),
      );
      for (const res of results) updated += res.meta?.changes ?? 0;
    } catch (err) {
      failedChunks++;
      console.error(
        `[data-papers-sync] write of ${chunk.length} datasets failed (${chunk[0].dataset_id} first); leaving them as they were:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  for (let j = 0; j < toClear.length; j += UPDATE_BATCH_SIZE) {
    const chunk = toClear.slice(j, j + UPDATE_BATCH_SIZE);
    try {
      const results = await db.batch(
        chunk.map((id) =>
          db
            .prepare(
              "UPDATE datasets SET data_papers = NULL WHERE dataset_id = ? AND data_papers IS NOT NULL",
            )
            .bind(id),
        ),
      );
      for (const res of results) cleared += res.meta?.changes ?? 0;
    } catch (err) {
      failedChunks++;
      console.error(
        `[data-papers-sync] clear of ${chunk.length} datasets failed (${chunk[0]} first); leaving them as they were:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  return { updated, cleared, unchanged, unknown, failedChunks };
}

/** Fetch the manifest and sync it. For the scheduled handler. */
export async function fetchAndSyncDataPapers(
  env: { DB: D1Database },
  url: string = DATA_PAPERS_MANIFEST_URL,
  options: FetchOptions = {},
): Promise<DataPapersSyncSummary> {
  const manifest = await fetchDataPapersManifest(url, options);
  const result = await syncDataPapers(env.DB, manifest);
  return { fetched: manifest.rows.length, rejected: manifest.rejected, ...result };
}
