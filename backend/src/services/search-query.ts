/**
 * What a search query is made of, before any index is asked.
 *
 * `GET /datasets/search` used to OR every word of the query as a prefix, so
 * "bilingual performance study" matched every dataset whose README said
 * "study" (59% of the catalog) and "performance" (14%). The words that tell
 * datasets apart are the ones that are NOT in most of them; this module
 * separates a query into the words that carry its meaning and the words that
 * are only grammar or only the genre ("study", "dataset", "eeg").
 *
 * Two inputs decide it: a short list of English function words, and each
 * word's document frequency in THIS catalog, measured per request with the
 * same prefix match the lexical leg uses. Measuring beats a hand-kept list of
 * domain words because it follows the catalog: "eeg" is generic here (87% of
 * datasets) and would be informative in a catalog of fMRI studies.
 *
 * Nothing here throws. A failed frequency query degrades to "every content
 * word is informative", which is the behavior before this module existed.
 */

import { PUBLIC_SEARCHABLE_SQL } from "./dataset-filters";
import { correctMisspellings } from "./search-spelling";

/** A word in more than this share of public datasets does not discriminate. */
export const GENERIC_DF_MAX = 0.25;
/**
 * Below this many public datasets a document frequency is not evidence: in a
 * catalog of eight fixtures a word in four of them is "common" by accident.
 * (Staging holds only the curated exemplar fleet.) No word is dropped then.
 */
export const MIN_CORPUS_FOR_DF = 100;
/** Content words past this many are ignored, so the frequency query stays small. */
export const MAX_QUERY_TERMS = 16;

/**
 * English function words, plus verbs that only frame a request ("using",
 * "find"). Kept short on purpose: anything domain-specific is left to the
 * measured frequency above.
 */
export const STOPWORDS: ReadonlySet<string> = new Set(
  (
    "a an and are as at be but by for from has have how in into is it its of on or that the their " +
    "this to was were what when where which while who with during using use via about between " +
    "after before under over within across than then these those can find show get"
  ).split(" "),
);

/** Lowercased alphanumeric words of at least two characters: the lexical leg's own tokenizer. */
export function queryTokens(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter((t) => t.length >= 2);
}

/** The words that are not function words; every word when nothing else is left ("the"). */
export function contentTokens(tokens: string[]): string[] {
  const content = tokens.filter((t) => !STOPWORDS.has(t));
  return (content.length > 0 ? content : tokens).slice(0, MAX_QUERY_TERMS);
}

export interface TermFrequencies {
  /** Public datasets the match could have hit. */
  corpusSize: number;
  /** Share of them each word (prefix-matched) occurs in, 0..1. */
  ratios: Map<string, number>;
}

/**
 * Document frequency of each word among public datasets, in ONE statement
 * (two bound parameters per word). Counts through `datasets_fts` with the
 * lexical leg's own prefix match, so "what the filter calls common" and "what
 * the lexical leg would match" are the same population.
 */
export async function termFrequencies(db: D1Database, terms: string[]): Promise<TermFrequencies> {
  const unique = [...new Set(terms)];
  const selects = [
    `SELECT NULL AS tok, COUNT(*) AS n FROM datasets d WHERE ${PUBLIC_SEARCHABLE_SQL}`,
  ];
  const params: string[] = [];
  for (const term of unique) {
    selects.push(
      `SELECT ? AS tok, COUNT(*) AS n FROM datasets d
       WHERE ${PUBLIC_SEARCHABLE_SQL}
         AND d.id IN (SELECT rowid FROM datasets_fts WHERE datasets_fts MATCH ?)`,
    );
    params.push(term, `"${term}"*`);
  }
  const { results } = await db
    .prepare(selects.join(" UNION ALL "))
    .bind(...params)
    .all<{ tok: string | null; n: number }>();
  let corpusSize = 0;
  const counts = new Map<string, number>();
  for (const row of results ?? []) {
    if (row.tok === null) corpusSize = row.n;
    else counts.set(row.tok, row.n);
  }
  const ratios = new Map<string, number>();
  for (const term of unique) {
    ratios.set(term, corpusSize > 0 ? (counts.get(term) ?? 0) / corpusSize : 0);
  }
  return { corpusSize, ratios };
}

/**
 * The content words that discriminate: those in at most {@link GENERIC_DF_MAX}
 * of the catalog. When none do ("eeg study"), every content word is kept, so a
 * query of only generic words still searches. A catalog too small to measure
 * keeps every word.
 */
export function informativeTokens(content: string[], frequencies: TermFrequencies): string[] {
  if (frequencies.corpusSize < MIN_CORPUS_FOR_DF) return content;
  const kept = content.filter((t) => (frequencies.ratios.get(t) ?? 0) <= GENERIC_DF_MAX);
  return kept.length > 0 ? kept : content;
}

export interface QueryAnalysis {
  /** The words the query is made of, function words removed, misspellings corrected. */
  content: string[];
  /** The content words that discriminate; what the lexical leg and the reranker are asked. */
  informative: string[];
  /** The text the lexical leg is given (it tokenizes and ORs it itself). */
  lexicalQuery: string;
  /** The text that is embedded: the caller's own words, with misspellings corrected. */
  semanticQuery: string;
  /** The text the cross-encoder is asked about. */
  rerankQuery: string;
  /** More than one content word: a phrase, which gets a relevance cutoff; one word does not. */
  isPhrase: boolean;
  /**
   * The query as searched, present only when a word that matches no dataset
   * was replaced by a catalog word one typo away (see search-spelling.ts).
   */
  correctedQuery?: string;
}

async function tryTermFrequencies(
  db: D1Database,
  terms: string[],
): Promise<TermFrequencies | undefined> {
  try {
    return await termFrequencies(db, terms);
  } catch (err) {
    console.warn(
      `[search] term frequencies unavailable, keeping every word: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return undefined;
  }
}

/** Analyze `query`. Never throws. */
export async function analyzeQuery(db: D1Database, query: string): Promise<QueryAnalysis> {
  const trimmed = query.trim();
  const allTokens = queryTokens(trimmed);
  let content = contentTokens(allTokens);
  let semanticQuery = trimmed;
  let correctedQuery: string | undefined;

  let frequencies = await tryTermFrequencies(db, content);
  if (frequencies && frequencies.corpusSize > 0) {
    // A word that matches no public dataset at all is a typo or a word the catalog lacks.
    const unseen = content.filter((t) => frequencies?.ratios.get(t) === 0);
    const fixes =
      unseen.length > 0 ? await correctMisspellings(db, unseen) : new Map<string, string>();
    if (fixes.size > 0) {
      content = content.map((t) => fixes.get(t) ?? t);
      semanticQuery = allTokens.map((t) => fixes.get(t) ?? t).join(" ");
      correctedQuery = semanticQuery;
      frequencies = (await tryTermFrequencies(db, content)) ?? frequencies;
    }
  }
  const informative = frequencies ? informativeTokens(content, frequencies) : content;
  // Punctuation-only input has no words; hand it through untouched so the
  // lexical leg reports its usual "nothing to match".
  const lexicalQuery = informative.length > 0 ? informative.join(" ") : trimmed;
  return {
    content,
    informative,
    lexicalQuery,
    semanticQuery,
    rerankQuery: lexicalQuery,
    isPhrase: content.length > 1,
    ...(correctedQuery !== undefined ? { correctedQuery } : {}),
  };
}
