/**
 * Deciding which candidates actually answer a phrase.
 *
 * Fusing a lexical and a semantic ranking (reciprocal-rank fusion) orders
 * candidates but never says "stop": rank 300 is as good a result as rank 3 as
 * far as the fusion knows, so a phrase returned 250 to 880 of the catalog's
 * 906 datasets, most of them there because they contain one common word. The
 * standard remedy in retrieval systems is a second stage: hand a bounded pool
 * of candidates to a cross-encoder, which reads the query and one candidate
 * TOGETHER and scores how well the candidate answers it, then cut on that
 * score. `@cf/baai/bge-reranker-base` is the cross-encoder Workers AI offers
 * (the same BAAI weights as the open model, $0.003 per million input tokens).
 *
 * A cross-encoder alone is not enough, and the rule below is built from what
 * its failures looked like on the real catalog:
 *
 *  - Its scores are query-dependent. A clear topical phrase puts every right
 *    answer above 0.9 ("driving simulation and fatigue": seven datasets at
 *    0.91 or more, everything else under 0.16), but a list-style phrase
 *    ("handwriting typing keyboard") scores even the right datasets under
 *    0.03. So an absolute floor alone drops right answers, and a floor
 *    relative to the best score alone keeps junk when the best is low.
 *  - Two independent retrievers agreeing is evidence the cross-encoder does
 *    not have. A dataset that both the lexical and the semantic leg ranked
 *    in their top 30 is kept unless the cross-encoder strongly rejects it.
 *  - The cross-encoder reads a dataset's abstract, keywords, modalities and
 *    tasks, not its authors. A query that is a person's name, or words in a
 *    dataset's title, would be rejected for evidence it was never shown. A
 *    dataset whose name, authors or tasks contain every informative word of
 *    the query is kept: the user's words are literally there.
 *
 * Calibrated on 37 queries: 22 used to choose the rule and 15 never used to
 * choose it (frozen before they were run), against truth sets read off each
 * dataset's own name, description, keywords and tasks, with the open model's
 * weights. Precision is the share of returned datasets in the truth set;
 * coverage is the share of the truth set (capped at 30) returned.
 *
 * | Rule                                    | Tuning: prec / cover / rows | Held-out: prec / cover / rows |
 * |-----------------------------------------|-----------------------------|-------------------------------|
 * | shipped before: fused list, up to 325   | 0.27 / 0.98 / 221           | 0.20 / 0.91 / 201             |
 * | fused pool of 60, no cutoff             | 0.54 / 0.93 / 43            | 0.41 / 0.97 / 44              |
 * | cut on best score only (>=0.05, >=20%)  | 0.93 / 0.55 / 13            | 0.80 / 0.30 / 6               |
 * | this rule                               | 0.89 / 0.73 / 17            | 0.89 / 0.63 / 12              |
 *
 * "This rule" is the whole shipped pipeline (informative words, modality words
 * set aside, the literal leg and its clause), as calibrate.py runs it; it also
 * checks that its constants are the ones in this file.
 *
 * Best-score-only is the rule this one replaced: it wins on tuning precision
 * and loses on held-out coverage by half. In a parameter scan done while
 * choosing the constants, neighboring values scored within about 0.01 of each
 * other in F1, so they are a plateau and not a point; that scan is not part of
 * the script. The truth sets are regexes over the same fields the cross-encoder
 * reads, so the benchmark flatters the cross-encoder; the held-out gap between
 * "this rule" and "best score only" is the part that does not depend on that.
 * `scripts/search-eval/calibrate.py` reproduces the table: rerun it when the
 * catalog grows by a few hundred datasets or the model changes.
 */

/** Workers AI cross-encoder; reads a query and a candidate together. */
export const RERANK_MODEL = "@cf/baai/bge-reranker-base";

/** A reranker slower than this is abandoned and the search degrades to the fused list. */
export const RERANK_TIMEOUT_MS = 4000;

/** Candidates taken from each retrieval leg. Both legs' top this many count as "found". */
export const LEG_SIZE = 30;
/**
 * Most candidates the fused lexical and semantic legs give one rerank call.
 * Literal name/author/task matches (at most {@link LEG_SIZE}) are added to
 * them, so a call carries at most 3 * LEG_SIZE documents.
 */
export const RERANK_POOL_MAX = 2 * LEG_SIZE;
/** After a rerank failure or timeout, phrase searches skip the cross-encoder for this long. */
export const RERANK_SUSPEND_MS = 30_000;

/** A candidate the cross-encoder endorses on its own needs at least this probability... */
export const ENDORSE_MIN = 0.1;
/** ...and at least this share of the best candidate's probability. */
export const ENDORSE_RELATIVE = 0.2;
/** A candidate both legs found is kept unless the cross-encoder scores it below this. */
export const AGREE_MIN = 0.005;
/** A literal name, author or task match sorts as if scored at least this. */
export const LITERAL_SCORE = 0.5;

export interface RelevanceCandidate {
  id: string;
  /** Cross-encoder probability that the dataset answers the query, 0..1. */
  p: number;
  /** Found by both the lexical and the semantic leg. */
  foundByBothLegs: boolean;
  /** Every informative query word is in the dataset's name, authors or tasks. */
  literalMatch: boolean;
}

export interface RelevantDataset {
  id: string;
  /** What the dataset is ranked and reported by: probability, floored for a literal match. */
  score: number;
}

/**
 * The candidates worth showing, best first. Input order breaks ties, so the
 * fused retrieval order decides between equals.
 */
export function selectRelevant(candidates: RelevanceCandidate[]): RelevantDataset[] {
  if (candidates.length === 0) return [];
  const best = candidates.reduce((max, c) => Math.max(max, c.p), 0);
  const endorsed = Math.max(ENDORSE_MIN, ENDORSE_RELATIVE * best);
  return candidates
    .map((c, order) => ({ c, order }))
    .filter(({ c }) => c.literalMatch || c.p >= endorsed || (c.foundByBothLegs && c.p >= AGREE_MIN))
    .map(({ c, order }) => ({
      id: c.id,
      order,
      score: c.literalMatch ? Math.max(c.p, LITERAL_SCORE) : c.p,
    }))
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .map(({ id, score }) => ({ id, score }));
}

const logistic = (x: number) => 1 / (1 + Math.exp(-x));

let suspendedUntil = 0;

/**
 * Whether the cross-encoder is being skipped because it just failed. A hung
 * `ai.run` cannot be cancelled and is billed anyway, so without this every
 * phrase request during an outage would wait out the full timeout.
 */
export function rerankSuspended(now = Date.now()): boolean {
  return now < suspendedUntil;
}

/** Skip the cross-encoder for {@link RERANK_SUSPEND_MS}. */
export function suspendRerank(now = Date.now()): void {
  suspendedUntil = now + RERANK_SUSPEND_MS;
}

/** Test seam: forget a suspension. */
export function resetRerankSuspension(): void {
  suspendedUntil = 0;
}

let loggedScoreScale = false;
/** Fewer scores than this are read as logits however they fall: a few logits can all be in [0, 1]. */
const MIN_SCORES_TO_READ_PROBABILITIES = 10;
/** The scale is logged once per isolate, from a call big enough to be representative. */
const MIN_SCORES_TO_LOG_SCALE = 20;

/**
 * Cloudflare documents the model's `score` as a raw value that "can be mapped
 * to a float value in [0,1] by sigmoid function", i.e. a logit. If at least
 * {@link MIN_SCORES_TO_READ_PROBABILITIES} scores all lie in [0,1] they are
 * taken as probabilities: a logit set that large would include the strongly
 * negative scores irrelevant candidates get, and a second sigmoid on
 * probabilities would squeeze everything into 0.5..0.73, which the rule above
 * would read as "everything is relevant". The scale actually seen is logged
 * once per isolate so a deploy can confirm which reading is true.
 */
export function normalizeRerankScores(raw: number[]): number[] {
  const alreadyProbabilities =
    raw.length >= MIN_SCORES_TO_READ_PROBABILITIES && raw.every((s) => s >= 0 && s <= 1);
  if (!loggedScoreScale && raw.length >= MIN_SCORES_TO_LOG_SCALE) {
    loggedScoreScale = true;
    console.log(
      `[search] rerank raw scores: min=${Math.min(...raw)} max=${Math.max(...raw)} n=${raw.length}, read as ${
        alreadyProbabilities ? "probabilities" : "logits"
      }`,
    );
  }
  return alreadyProbabilities ? raw : raw.map(logistic);
}

/** Test seam: forget that the score scale was logged. */
export function resetRerankScaleLog(): void {
  loggedScoreScale = false;
}

interface RerankResponse {
  response?: Array<{ id?: number; score?: number }>;
}

/**
 * Probability that each of `texts` answers `query`, aligned to `texts`.
 * Throws when the call fails, takes longer than {@link RERANK_TIMEOUT_MS}, or
 * answers for fewer candidates than were sent (a silent partial answer would
 * drop candidates unseen); the caller degrades to the fused list.
 */
export async function rerankScores(
  ai: Ai,
  query: string,
  texts: string[],
  timeoutMs = RERANK_TIMEOUT_MS,
): Promise<number[]> {
  if (texts.length === 0) return [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`rerank timed out after ${timeoutMs} ms`)),
      timeoutMs,
    );
  });
  let result: RerankResponse;
  try {
    result = (await Promise.race([
      ai.run(RERANK_MODEL, {
        query,
        contexts: texts.map((text) => ({ text })),
        top_k: texts.length,
      }),
      timeout,
    ])) as RerankResponse;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  const raw: Array<number | undefined> = new Array(texts.length).fill(undefined);
  for (const item of result.response ?? []) {
    if (
      typeof item.id === "number" &&
      Number.isInteger(item.id) &&
      item.id >= 0 &&
      item.id < texts.length &&
      typeof item.score === "number" &&
      Number.isFinite(item.score)
    ) {
      raw[item.id] = item.score;
    }
  }
  if (raw.some((s) => s === undefined)) {
    throw new Error(
      `rerank answered for ${raw.filter((s) => s !== undefined).length} of ${texts.length} candidates`,
    );
  }
  const scores = raw as number[];
  // A model that scores every candidate identically has not judged them: all zeros
  // would otherwise become an empty "reranked" answer.
  if (scores.length > 1 && scores.every((x) => x === scores[0])) {
    throw new Error("rerank gave every candidate the same score");
  }
  return normalizeRerankScores(scores);
}
