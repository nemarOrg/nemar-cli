/**
 * Correcting a query word the catalog has never seen.
 *
 * An embedding cannot rescue a misspelling: on the live catalog the right
 * dataset for "bilingual" ranks 3rd, and for "bilinugual" it ranks 117th. The
 * lexical leg finds nothing for a word it has never indexed. So a word that
 * matches no public dataset at all is compared with the catalog's own
 * vocabulary and, when one word is a single typo away, replaced by it, and the
 * response says so (`corrected_query`) rather than silently searching for
 * something the user did not type.
 *
 * What it will not do: touch a word that matches anything (a partly typed word
 * matches by prefix), change a word's first letter (Lucene's spell checker
 * makes the same choice: a typo there is rare and a wrong guess is common), touch a word shorter than five letters or with a digit
 * (acronyms and ERP components: "emg", "n400"), or reach further than one
 * edit (two for words of twelve letters or more). A wrong correction costs
 * more than none, because it answers a question nobody asked. It cannot be
 * made to never happen: a real word the catalog lacks, one edit from one it has
 * ("simulation" beside "stimulation"), is corrected too. That is why the
 * correction is reported in the response and not applied silently.
 *
 * The vocabulary is read from the catalog itself, from the fields a person
 * would type a topic from: names, abstracts and tasks. It is rebuilt at most
 * every ten minutes per isolate; a stale vocabulary only misses a new word.
 */

import { PUBLIC_SEARCHABLE_SQL } from "./dataset-filters";

/** A word shorter than this is never corrected. */
export const MIN_CORRECTABLE_LENGTH = 5;
/** Words this long may be two edits from their correction; shorter words, one. */
export const TWO_EDIT_LENGTH = 12;
/** How long a built vocabulary is reused. */
export const VOCABULARY_TTL_MS = 10 * 60 * 1000;

/** Each word of the catalog's vocabulary, with the number of datasets that use it. */
export type Vocabulary = Map<string, number>;

/**
 * Edit distance between `a` and `b` counting an insertion, a deletion, a
 * substitution or a swap of two neighboring letters as one edit (optimal
 * string alignment). Returns `max + 1` as soon as it is certain the distance
 * exceeds `max`.
 */
export function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let twoBack: number[] = [];
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min(
        (previous[j] as number) + 1,
        (row[j - 1] as number) + 1,
        (previous[j - 1] as number) + cost,
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        best = Math.min(best, (twoBack[j - 2] as number) + 1);
      }
      row.push(best);
      if (best < rowMin) rowMin = best;
    }
    if (rowMin > max) return max + 1;
    twoBack = previous;
    previous = row;
  }
  return previous[b.length] as number;
}

/** Words of at least four letters in `text`, lowercased; digits and punctuation split words. */
function vocabularyWords(text: string): string[] {
  return text.toLowerCase().match(/[a-z]{4,}/g) ?? [];
}

/** The vocabulary of `rows`: every word in their names, abstracts and tasks, once per dataset. */
export function buildVocabulary(
  rows: Array<{ name?: string | null; description?: string | null; tasks?: string | null }>,
): Vocabulary {
  const vocabulary: Vocabulary = new Map();
  for (const row of rows) {
    const words = new Set(
      vocabularyWords(`${row.name ?? ""} ${row.description ?? ""} ${row.tasks ?? ""}`),
    );
    for (const word of words) vocabulary.set(word, (vocabulary.get(word) ?? 0) + 1);
  }
  return vocabulary;
}

/**
 * The vocabulary word `term` is most likely a typo of, or null. The nearest
 * word wins; among equally near words, the one more datasets use, then the
 * alphabetically first (so the answer never depends on iteration order).
 */
export function suggestCorrection(term: string, vocabulary: Vocabulary): string | null {
  if (term.length < MIN_CORRECTABLE_LENGTH || !/^[a-z]+$/.test(term)) return null;
  const max = term.length >= TWO_EDIT_LENGTH ? 2 : 1;
  let best: { word: string; distance: number; datasets: number } | null = null;
  for (const [word, datasets] of vocabulary) {
    if (word === term) return null;
    if (word[0] !== term[0]) continue;
    const distance = editDistance(term, word, max);
    if (distance > max) continue;
    if (
      !best ||
      distance < best.distance ||
      (distance === best.distance &&
        (datasets > best.datasets || (datasets === best.datasets && word < best.word)))
    ) {
      best = { word, distance, datasets };
    }
  }
  return best?.word ?? null;
}

let cached: { builtAt: number; vocabulary: Promise<Vocabulary> } | undefined;

/** Test seam: forget the cached vocabularies. */
export function resetVocabularyCache(): void {
  cached = undefined;
  cachedModalities = undefined;
}

/**
 * The catalog's vocabulary, reused for {@link VOCABULARY_TTL_MS}. A failed build is not cached.
 * Built only when a query holds a word no dataset contains: it reads every public dataset's
 * text, which a request that needs no correction must not pay for.
 */
export function loadVocabulary(db: D1Database, now = Date.now()): Promise<Vocabulary> {
  if (cached && now - cached.builtAt < VOCABULARY_TTL_MS) return cached.vocabulary;
  // An async function, so a failure thrown while preparing the statement is a rejection too.
  const vocabulary = (async () => {
    const { results } = await db
      .prepare(
        `SELECT d.name, d.description, d.tasks FROM datasets d WHERE ${PUBLIC_SEARCHABLE_SQL}`,
      )
      .all<{ name: string | null; description: string | null; tasks: string | null }>();
    return buildVocabulary(results ?? []);
  })();
  cached = { builtAt: now, vocabulary };
  vocabulary.catch(() => {
    if (cached?.vocabulary === vocabulary) cached = undefined;
  });
  return vocabulary;
}

/** Every modality token a list of `modalities` values holds, lowercase. */
export function buildModalityTokens(rows: Array<{ modalities?: string | null }>): Set<string> {
  const tokens = new Set<string>();
  for (const row of rows) {
    for (const token of (row.modalities ?? "").split(",")) {
      const t = token.trim().toLowerCase();
      if (t) tokens.add(t);
    }
  }
  return tokens;
}

let cachedModalities: { builtAt: number; tokens: Promise<Set<string>> } | undefined;

/**
 * The modality tokens some public dataset lists (`eeg`, `ieeg`, `meg`, ...), cached like the
 * vocabulary but from its own query: the DISTINCT lists are a handful of short strings, so a
 * query that names no unseen word never reads descriptions to learn them.
 * Empty when the catalog cannot be read (and not cached then). Never throws.
 */
export async function loadModalityTokens(db: D1Database, now = Date.now()): Promise<Set<string>> {
  if (cachedModalities && now - cachedModalities.builtAt < VOCABULARY_TTL_MS) {
    return cachedModalities.tokens.catch(() => new Set<string>());
  }
  const tokens = (async () => {
    const { results } = await db
      .prepare(
        `SELECT DISTINCT d.modalities FROM datasets d WHERE d.modalities IS NOT NULL AND ${PUBLIC_SEARCHABLE_SQL}`,
      )
      .all<{ modalities: string | null }>();
    return buildModalityTokens(results ?? []);
  })();
  cachedModalities = { builtAt: now, tokens };
  try {
    return await tokens;
  } catch (err) {
    if (cachedModalities?.tokens === tokens) cachedModalities = undefined;
    console.warn(
      `[search] modality vocabulary unavailable: ${err instanceof Error ? err.message : String(err)}`,
    );
    return new Set();
  }
}

/** `terms` that are one typo from a catalog word, mapped to that word. Never throws. */
export async function correctMisspellings(
  db: D1Database,
  terms: string[],
): Promise<Map<string, string>> {
  const corrections = new Map<string, string>();
  const candidates = terms.filter((t) => t.length >= MIN_CORRECTABLE_LENGTH && /^[a-z]+$/.test(t));
  if (candidates.length === 0) return corrections;
  try {
    const vocabulary = await loadVocabulary(db);
    for (const term of candidates) {
      const suggestion = suggestCorrection(term, vocabulary);
      if (suggestion) corrections.set(term, suggestion);
    }
  } catch (err) {
    console.warn(
      `[search] spelling vocabulary unavailable, not correcting: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  return corrections;
}
