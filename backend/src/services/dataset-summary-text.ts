/**
 * The one text that stands for a dataset in semantic search.
 *
 * Both the stored vector (`reembedDatasetVector`) and the cross-encoder that
 * judges a candidate against a query (`search-rerank.ts`) read THIS string, so
 * "what the index knows" and "what the judge reads" cannot drift apart. It is
 * built from the curated abstract (`description`) and the curated `keywords`
 * the enrichment pipeline writes, not from the README.
 *
 * Why not the README: measured on the live catalog (906 public datasets), 897
 * README files open with a DOI badge and a link (`[![DOI](https://img.shields.io/...`),
 * so the first 1000 characters the old builder embedded were mostly markup,
 * while the abstract and keywords, which say what the dataset is about, were
 * never embedded at all. On a topical benchmark (37 queries, each with a truth
 * set read off the dataset's own name, description, keywords and tasks) the
 * R-precision of the semantic leg went from 0.621 to 0.708 with this text. That
 * benchmark reads the same fields this text is made of, so it favors the new
 * text by construction; the argument that does not depend on it is the badge
 * noise. `scripts/search-eval/calibrate.py` reproduces the numbers. A README
 * excerpt is used only when the abstract is too thin to stand on.
 */

/** A description shorter than this is topped up with a cleaned README excerpt. */
export const THIN_DESCRIPTION_CHARS = 200;
/** How much of the README the SQL hands over for a thin-description dataset. */
export const README_HEAD_CHARS = 2500;
/** Cleaned README characters appended to a thin description. */
const README_EXCERPT_CHARS = 600;
/** At most this many curated keywords are written into the text. */
const MAX_KEYWORDS = 12;
/**
 * Hard cap on the whole text. Both consumers truncate at 512 tokens (about
 * 2000 characters of English); capping here keeps the cut at the end of the
 * text instead of wherever a model happens to stop.
 */
export const SUMMARY_TEXT_MAX_CHARS = 1800;

export interface DatasetSummaryRow {
  name?: string | null;
  description?: string | null;
  modalities?: string | null;
  tasks?: string | null;
  /** `$.keywords` of `enrichment_json`, as JSON text (see {@link DATASET_SUMMARY_SELECT_SQL}). */
  keywords_json?: string | null;
  /** Head of the README, selected only when the description is thin. */
  readme_head?: string | null;
}

/**
 * The columns {@link DatasetSummaryRow} is read from, for a query over
 * `datasets d`. `json_valid` guards `json_extract`, which raises on malformed
 * JSON and would fail the whole statement for one bad row.
 */
export const DATASET_SUMMARY_SELECT_SQL = `d.name AS name, d.description AS description,
       d.modalities AS modalities, d.tasks AS tasks,
       CASE WHEN json_valid(d.enrichment_json)
            THEN json_extract(d.enrichment_json, '$.keywords') END AS keywords_json,
       CASE WHEN LENGTH(COALESCE(d.description, '')) < ${THIN_DESCRIPTION_CHARS}
            THEN SUBSTR(d.readme, 1, ${README_HEAD_CHARS}) END AS readme_head`;

/**
 * Keyword terms from `enrichment_json.keywords`, in order, de-duplicated.
 * An entry is `{ term: "..." }` (the enrichment pipeline's shape) or a bare
 * string; anything else, and any unparseable value, contributes nothing.
 */
export function keywordTerms(keywordsJson: string | null | undefined): string[] {
  if (!keywordsJson) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(keywordsJson);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const entry of parsed) {
    const raw =
      typeof entry === "string"
        ? entry
        : entry &&
            typeof entry === "object" &&
            typeof (entry as { term?: unknown }).term === "string"
          ? (entry as { term: string }).term
          : "";
    const term = raw.trim();
    const key = term.toLowerCase();
    if (term && !seen.has(key)) {
      seen.add(key);
      terms.push(term);
    }
  }
  return terms.slice(0, MAX_KEYWORDS);
}

/**
 * README markdown reduced to prose: badges and images removed, links reduced
 * to their label, bare URLs and rules and heading markers dropped, whitespace
 * collapsed.
 */
export function cleanReadmeForSummary(markdown: string): string {
  return markdown
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[#=\-*_`|>]{2,}/g, " ")
    .replace(/[#*`|>]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The text a dataset is embedded and reranked as. Empty when every field is blank. */
export function buildDatasetSummaryText(row: DatasetSummaryRow): string {
  const description = row.description?.trim() ?? "";
  const keywords = keywordTerms(row.keywords_json);
  const parts = [
    row.name?.trim() ?? "",
    description,
    keywords.length > 0 ? `Keywords: ${keywords.join(", ")}` : "",
    row.modalities ? `Modalities: ${row.modalities}` : "",
    row.tasks ? `Tasks: ${row.tasks}` : "",
  ];
  if (description.length < THIN_DESCRIPTION_CHARS && row.readme_head) {
    parts.push(cleanReadmeForSummary(row.readme_head).slice(0, README_EXCERPT_CHARS));
  }
  return parts.filter(Boolean).join("\n").slice(0, SUMMARY_TEXT_MAX_CHARS);
}
