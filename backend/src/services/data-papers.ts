/**
 * The shape of `datasets.data_papers` and the two directions across it (ADR 0077).
 *
 * The column holds the papers nemar-citations' judge confirmed as a dataset's
 * data paper, as JSON text: a list of `{ doi, title, year, venue, judge_model }`.
 * NULL means "not judged, or not yet processed"; `[]` means "gated, and no data
 * paper". `data-papers-sync.ts` WRITES it (validating what the dashboard
 * publishes), and the `metadata.json` / page-bundle builder READS it back;
 * both go through this module so the writer and the reader cannot disagree
 * about what a valid entry is.
 *
 * The writer is strict and the reader is defensive. The writer refuses a
 * record it cannot store whole (wrong type, invalid DOI, over the bound)
 * rather than storing a repaired copy, because a half-truncated list is a
 * wrong answer to "what is this dataset's data paper". Only individual strings
 * are capped. The reader treats anything that is not the expected shape as
 * absent and logs it, never throws: a bad cell must not turn a public
 * `metadata.json` into a 500.
 */

/** One confirmed data paper. `doi` is required; the rest are null when unknown. */
export interface DataPaperEntry {
  doi: string;
  title: string | null;
  year: number | null;
  venue: string | null;
  judge_model: string | null;
}

/** At most this many papers per dataset (ADR 0036: a per-item list needs a bound). */
export const MAX_DATA_PAPERS = 10;

/**
 * The serialized list may not exceed this many UTF-8 bytes. D1 statements over
 * about 100 KB break backup restore (ADR 0036); this stays two orders of
 * magnitude under it and well above any realistic list (a few hundred bytes
 * each).
 */
export const MAX_DATA_PAPERS_BYTES = 4096;

/** Per-string caps, in code points. A longer string is truncated, not refused. */
export const DATA_PAPER_STRING_CAPS = {
  doi: 255,
  title: 500,
  venue: 200,
  judge_model: 100,
} as const;

// A DOI is `10.<registrant>/<suffix>`; the suffix has no whitespace. Anything
// else (a URL, a `doi:` prefix, a trailing period) is refused, not repaired:
// the dashboard publishes normalized DOIs, so a malformed one is a producer bug
// to surface, and guessing the intended DOI is how a wrong paper gets served.
const DOI_PATTERN = /^10\.\d{4,9}\/\S+$/;

const MIN_YEAR = 1000;
const MAX_YEAR = 2999;

function truncate(value: string, max: number): string {
  const points = [...value];
  return points.length <= max ? value : points.slice(0, max).join("");
}

/**
 * `undefined` = the value is the wrong type (refuse the record); `null` = absent
 * or blank (store null); a string = the trimmed, capped value.
 */
function optionalString(value: unknown, max: number): string | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? null : truncate(trimmed, max);
}

/** One entry, or null when it is not storable as-is. */
export function normalizeDataPaper(value: unknown): DataPaperEntry | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const r = value as Record<string, unknown>;
  if (typeof r.doi !== "string") return null;
  const doi = r.doi.trim();
  if (!DOI_PATTERN.test(doi) || [...doi].length > DATA_PAPER_STRING_CAPS.doi) return null;
  const title = optionalString(r.title, DATA_PAPER_STRING_CAPS.title);
  const venue = optionalString(r.venue, DATA_PAPER_STRING_CAPS.venue);
  const judgeModel = optionalString(r.judge_model, DATA_PAPER_STRING_CAPS.judge_model);
  if (title === undefined || venue === undefined || judgeModel === undefined) return null;
  let year: number | null = null;
  if (r.year !== undefined && r.year !== null) {
    if (typeof r.year !== "number" || !Number.isInteger(r.year)) return null;
    if (r.year < MIN_YEAR || r.year > MAX_YEAR) return null;
    year = r.year;
  }
  return { doi, title, year, venue, judge_model: judgeModel };
}

/** Stable serialization: fixed key order, so equal lists are equal strings. */
export function serializeDataPapers(papers: readonly DataPaperEntry[]): string {
  return JSON.stringify(
    papers.map((p) => ({
      doi: p.doi,
      title: p.title,
      year: p.year,
      venue: p.venue,
      judge_model: p.judge_model,
    })),
  );
}

export type DataPapersValidation =
  | { ok: true; papers: DataPaperEntry[]; json: string }
  | { ok: false; reason: string };

/**
 * Validate a list the dashboard published, for storage. Refuses the whole list
 * on any bad entry or on exceeding either bound; it never stores a repaired or
 * shortened copy. A repeated DOI (compared case-insensitively) keeps its first
 * occurrence.
 */
export function validateDataPapers(value: unknown): DataPapersValidation {
  if (!Array.isArray(value)) return { ok: false, reason: "data_papers is not an array" };
  if (value.length > MAX_DATA_PAPERS) {
    return { ok: false, reason: `more than ${MAX_DATA_PAPERS} papers (${value.length})` };
  }
  const papers: DataPaperEntry[] = [];
  const seen = new Set<string>();
  for (const [i, item] of value.entries()) {
    const entry = normalizeDataPaper(item);
    if (!entry) return { ok: false, reason: `entry ${i} is not a valid data paper` };
    const key = entry.doi.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    papers.push(entry);
  }
  const json = serializeDataPapers(papers);
  const bytes = new TextEncoder().encode(json).length;
  if (bytes > MAX_DATA_PAPERS_BYTES) {
    return {
      ok: false,
      reason: `serialized list is ${bytes} bytes (limit ${MAX_DATA_PAPERS_BYTES})`,
    };
  }
  return { ok: true, papers, json };
}

/**
 * Read the stored column for serving. NULL/undefined -> null (key omitted).
 * Malformed text, a non-array, or any entry that is not a valid data paper ->
 * null and a logged error (key omitted), so the endpoint never 500s on a bad
 * cell. Entries are NOT re-capped: what the writer stored was already valid.
 */
export function parseStoredDataPapers(
  raw: string | null | undefined,
  datasetId: string,
): DataPaperEntry[] | null {
  if (raw === null || raw === undefined) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.error(
      `[data] data_papers: stored value is not valid JSON dataset=${datasetId}:`,
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
  if (!Array.isArray(parsed)) {
    console.error(`[data] data_papers: stored value is not an array dataset=${datasetId}`);
    return null;
  }
  const papers: DataPaperEntry[] = [];
  for (const item of parsed) {
    const entry = normalizeDataPaper(item);
    if (!entry) {
      console.error(`[data] data_papers: stored entry has the wrong shape dataset=${datasetId}`);
      return null;
    }
    papers.push(entry);
  }
  return papers;
}
