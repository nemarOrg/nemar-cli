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
 * A dataset the gate has not processed is ABSENT from the manifest, so its
 * column stays NULL ("not judged yet"); a processed dataset with no data paper
 * is present with `data_papers: []`, stored as '[]'. The manifest's absence of
 * a row never clears a stored value: a dashboard outage or a partial manifest
 * must not erase verdicts.
 *
 * What this never does: INSERT (the catalog owns dataset existence), touch
 * `updated_at` (that column feeds the catalog's freshness signals and this
 * sync is not an edit of the dataset), or write a value that is already stored.
 */

import { type DataPaperEntry, serializeDataPapers, validateDataPapers } from "./data-papers";

export const DATA_PAPERS_MANIFEST_URL =
  "https://dashboard.nemar.org/citations/api/data-papers.json";
export const DATA_PAPERS_SCHEMA_ID = "nemar-citations/data-papers@1";
const FETCH_TIMEOUT_MS = 30_000;
// D1 allows 100 bound parameters per statement; the existence lookup binds one
// per dataset, and a batch of UPDATEs binds two per statement.
const LOOKUP_BATCH_SIZE = 50;
const UPDATE_BATCH_SIZE = 10;

export interface DataPapersRow {
  dataset_id: string;
  papers: DataPaperEntry[];
  /** The exact text to store: `serializeDataPapers(papers)`, computed once. */
  json: string;
}

export interface DataPapersManifest {
  rows: DataPapersRow[];
  /** Rows refused for a bad shape or for exceeding a bound, each logged. */
  rejected: number;
}

const EMPTY_MANIFEST: DataPapersManifest = { rows: [], rejected: 0 };

/**
 * Fetch + validate the manifest. Returns no rows on any failure (non-2xx,
 * timeout, unparseable body, wrong schema id): the caller logs and proceeds,
 * and the column simply is not refreshed this run.
 */
export async function fetchDataPapersManifest(
  url: string = DATA_PAPERS_MANIFEST_URL,
): Promise<DataPapersManifest> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      console.warn(`[data-papers-sync] manifest fetch ${res.status} from ${url}`);
      return EMPTY_MANIFEST;
    }
    const body = (await res.json()) as { schema?: unknown; datasets?: unknown };
    if (body.schema !== DATA_PAPERS_SCHEMA_ID) {
      // A different id is a producer change this code has not been taught: skip
      // the lot rather than guess at a shape.
      console.warn(
        `[data-papers-sync] manifest schema is ${JSON.stringify(body.schema)}, expected ${DATA_PAPERS_SCHEMA_ID}; skipping`,
      );
      return EMPTY_MANIFEST;
    }
    if (!Array.isArray(body.datasets)) {
      console.warn("[data-papers-sync] manifest missing datasets array");
      return EMPTY_MANIFEST;
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

    const rows: DataPapersRow[] = [];
    let rejected = 0;
    for (const raw of listed) {
      const id = idOf(raw);
      if (id === "") {
        rejected++;
        console.warn("[data-papers-sync] skipped a row with no dataset_id");
        continue;
      }
      if ((listings.get(id) ?? 0) > 1) {
        // Two rows for one dataset: which is right is unknowable, so store neither.
        rejected++;
        console.warn(`[data-papers-sync] skipped ${id}: listed more than once`);
        continue;
      }
      const checked = validateDataPapers((raw as { data_papers?: unknown }).data_papers);
      if (!checked.ok) {
        rejected++;
        console.warn(`[data-papers-sync] skipped ${id}: ${checked.reason}`);
        continue;
      }
      rows.push({
        dataset_id: id,
        papers: checked.papers,
        json: serializeDataPapers(checked.papers),
      });
    }
    return { rows, rejected };
  } catch (err) {
    console.warn(
      `[data-papers-sync] manifest fetch failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return EMPTY_MANIFEST;
  } finally {
    clearTimeout(timeout);
  }
}

export interface DataPapersSyncSummary {
  /** Valid rows taken from the manifest. */
  fetched: number;
  /** Rows refused at validation (shape, bound, duplicate id). */
  rejected: number;
  /** Rows whose stored value changed. */
  updated: number;
  /** Rows already holding exactly this value. */
  unchanged: number;
  /** Rows naming a dataset the catalog does not have. */
  unknown: number;
}

/**
 * UPDATE the column onto EXISTING datasets, matched by `dataset_id` only (a
 * manifest `ds-*` row does not reach an `on-*` row: the catalog carries the
 * `on-*` id and the judge runs on it). Never INSERTs, never touches
 * `updated_at`, and only writes a row whose stored text differs.
 */
export async function syncDataPapers(
  db: D1Database,
  rows: DataPapersRow[],
): Promise<Omit<DataPapersSyncSummary, "rejected" | "fetched">> {
  let updated = 0;
  let unchanged = 0;
  let unknown = 0;
  for (let i = 0; i < rows.length; i += LOOKUP_BATCH_SIZE) {
    const batch = rows.slice(i, i + LOOKUP_BATCH_SIZE);
    const placeholders = batch.map(() => "?").join(", ");
    const existing = await db
      .prepare(`SELECT dataset_id, data_papers FROM datasets WHERE dataset_id IN (${placeholders})`)
      .bind(...batch.map((r) => r.dataset_id))
      .all<{ dataset_id: string; data_papers: string | null }>();
    const stored = new Map((existing.results ?? []).map((r) => [r.dataset_id, r.data_papers]));

    const changed: DataPapersRow[] = [];
    for (const row of batch) {
      if (!stored.has(row.dataset_id)) {
        unknown++;
      } else if (stored.get(row.dataset_id) === row.json) {
        unchanged++;
      } else {
        changed.push(row);
      }
    }
    for (let j = 0; j < changed.length; j += UPDATE_BATCH_SIZE) {
      const chunk = changed.slice(j, j + UPDATE_BATCH_SIZE);
      const results = await db.batch(
        chunk.map((r) =>
          db
            .prepare("UPDATE datasets SET data_papers = ? WHERE dataset_id = ?")
            .bind(r.json, r.dataset_id),
        ),
      );
      for (const res of results) updated += res.meta?.changes ?? 0;
    }
  }
  return { updated, unchanged, unknown };
}

/** Fetch the manifest and sync it. For the scheduled handler. */
export async function fetchAndSyncDataPapers(
  env: { DB: D1Database },
  url: string = DATA_PAPERS_MANIFEST_URL,
): Promise<DataPapersSyncSummary> {
  const manifest = await fetchDataPapersManifest(url);
  const { updated, unchanged, unknown } = await syncDataPapers(env.DB, manifest.rows);
  return {
    fetched: manifest.rows.length,
    rejected: manifest.rejected,
    updated,
    unchanged,
    unknown,
  };
}
