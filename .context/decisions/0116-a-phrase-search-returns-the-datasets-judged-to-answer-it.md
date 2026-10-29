# ADR 0116: A phrase search returns the datasets judged to answer it, not every dataset that shares a word

**Status:** proposed
**Date:** 2026-10-29
**Owner:** Seyed Yahya Shirazi

## Context

On 2026-10-29 `nemar dataset search "bilingual performance study"` returned 565 of the 906 public datasets, led by driving-simulator and P300 datasets.
The website calls the same endpoint (`GET /datasets/search`) and showed the same list.
Three mechanisms made it so, each measured on the live catalog.

The lexical leg joined every word of the query with OR, as a prefix, so "study" (in 59% of datasets) and "performance" (in 14%) decided a match as much as "bilingual" did.
The semantic leg's cosine floor of 0.60 admits 100 of 906 datasets for most queries, because `bge-small` scores bunch together on this catalog (for "bilingual performance study": median 0.57, 90th percentile 0.61, best 0.66); it is a rank cut, not a relevance floor.
Reciprocal-rank fusion orders candidates and never says "stop", so the list ran to 221 rows on average over 22 benchmark queries and 201 over 15 more, and the reported `count`, the size of the union of both legs, was larger still (565 for the query above).

The vector the semantic leg searched was built from the name, modalities, tasks, authors and the first 1000 characters of the README.
897 of 906 READMEs open with a DOI badge and a link, so most of that text was markup, and the curated `description` and enrichment `keywords`, which say what a dataset is about, were never embedded.
A misspelled word cannot be rescued by an embedding: for "bilinugual" the right dataset ranks 117th, for "bilingual" 3rd.

## Decision

1. **A phrase is judged for relevance; a single word is not.**
   A phrase is a query of two or more distinct content words (function words removed, repeats counted once).
   One content word is searched as before and lists the datasets that mention it, up to 300, with semantic neighbors.
2. **Generic words do not drive a match.**
   A content word found in more than 25% of public datasets, measured per request with the lexical leg's own prefix match, is dropped from the lexical query and from the cross-encoder's query; the embedding still gets the caller's own words.
   A query made only of generic words keeps them all, and a catalog under 100 datasets (staging) drops none.
   The lexical leg weights `name` and `description` above the README in bm25.
3. **A cross-encoder judges a bounded pool.**
   Up to 30 candidates come from each of the lexical, semantic and literal (every informative word in the name, authors or tasks) legs, gathered under the visibility rules alone, and `@cf/baai/bge-reranker-base` scores each against the query.
   A dataset is returned when any of three holds: the cross-encoder endorses it (probability at least 0.10 and at least 20% of the best score); or both the lexical and the semantic leg found it and the cross-encoder does not strongly reject it (at least 0.005); or its name, authors or tasks contain every informative word.
   Results are ordered by that judgment, and a literal match sorts at least at 0.5, so a `score` is the judged probability except that name and author matches are floored there.
   A cross-encoder that gives every candidate the same score has not judged them and counts as a failure.
4. **The embedding and the cross-encoder read one text.**
   `buildDatasetSummaryText` is the name, abstract, keywords, modalities and tasks, with a cleaned README excerpt only when the abstract is under 200 characters.
   Existing vectors are replaced by the admin reindex.
5. **A word the catalog has never seen is corrected, and the correction is reported.**
   In a catalog of at least 100 datasets, a query word that matches no public dataset is replaced by a word from the catalog's own vocabulary that is one typo away (two for words of 12 letters or more; never a different first letter, never under five letters or with a digit).
   Accents are folded before words are cut, as the full-text index folds them.
   The response carries `corrected_query`, the CLI prints "Showing results for ...", and the MCP tool adds a note.
6. **Every model failure serves the fused list.**
   An embedding failure, a reranker failure, a partial or flat reranker answer or a reranker slower than 4 seconds returns the fused list (ADR 0005: partial data still serves), still built from the new query analysis, column weights and vectors, and the response omits `reranked`.
   After a reranker failure the reranker is skipped for 30 seconds in that isolate, because a hung call cannot be cancelled and is billed anyway; a failed embedding is not tried a second time in the same request.
   A SQL failure is never treated as a model failure: it surfaces.
7. **Filters narrow the answer and never change the verdict.**
   The legs are gathered with no request filter, and every filter (facets included) is applied to the datasets kept, so a dataset is judged relevant or not whatever else was asked.
   `excluded_unknown` (ADR 0005, ADR 0032) still counts the relevant datasets the default unknown-excluded policy hides.
   The price: a filtered phrase search draws from the best candidates overall, not the best within the filter, so a very selective filter can return fewer datasets than exist.
8. **A modality the query names is an attribute to prefer.**
   A query word that equals a whole modality token some public dataset lists (`eeg`, `ieeg`, `meg`, ...) is set aside from the words that drive matching, when the query says something else too, and the datasets listing it come first, the more modalities named the better, each group in relevance order (`modality_boost`).
   It is a preference and not a filter, and a whole-token match: asking for `eeg` never promotes an `ieeg`-only dataset.
   The explicit `modality` filter is unchanged and a hard filter.

## Consequences

- **`count` for a phrase is the number judged to answer it.**
  It no longer measures reach, it is bounded by the pool (60 candidates, plus up to 30 literal matches), and `truncated` is false for a reranked response.
  The envelope marks such a response with `reranked: true`; `min_score` (a cosine floor) is not applied to it, and each `score` is the judged probability from 0 to 1 (name and author matches are floored at 0.5) instead of a fusion artifact.
  Listing what mentions a word is what a single-word query (up to 300 datasets, plus semantic neighbors) and `nemar dataset list` are for.
- **A short answer is an answer.**
  "Bilingual performance study" returns the two datasets in the 160-dataset test sample that are about it, and "children with ADHD" the few that mention it, instead of 565.
  A catalog that does not hold the topic yields few or no results, which the CLI already words ("No datasets match your search.").
- **One Workers AI reranker call per phrase query.**
  At most 90 documents of at most 1800 characters: typically about 20,000 tokens and at worst about 40,000, at $0.00311 per million input tokens, so roughly $0.00006 to $0.00012 a query.
  The route sits behind the generic rate limit (1000 requests a minute per address and data center), which bounds one address to about twelve cents a minute of reranking at worst, and is deliberately `no-store`; a stricter bucket would share the website proxy's identity, so none is added here.
  Latency was not measured on Workers AI, which was not reachable from the environment this was built in; the Worker logs `[search] relevance: pool=N kept=K rerank_ms=M` and the 4-second bound caps the worst case.
- **Three things to confirm on the first deploy.**
  The Worker logs `[search] rerank raw scores: ... read as logits` once per isolate (from a call of 20 or more scores); Cloudflare documents the score as a raw value to be mapped through a sigmoid, and the code treats ten or more scores entirely inside [0, 1] as already probabilities, so the log line says which reading was true.
  `rerank_ms` on real traffic decides whether the 4-second bound or the pool size needs to change.
  And a phrase search must come back with `reranked: true`: the request and response shapes of the reranker were never exercised against Workers AI, and a wrong shape degrades silently to the fused list.
- **The vector follows the keywords.**
  The enrichment keywords are part of the embedded text, and the admin save of an enrichment (`routes/admin/doi.ts`) now marks the vector stale (`embedding_dirty`) the way a change to the abstract does.
- **The vectors must be rebuilt.**
  After deploy, run `POST /admin/vectorize/reindex-all` until `has_more` is false (906 datasets, 500 per call).
  Until it finishes the semantic leg searches README-based vectors: it works, with lower recall.
- **The constants are calibrated, not derived.**
  They were chosen on 22 queries and checked on 15 that were frozen before they were run; held-out precision went from 0.20 to 0.89 and coverage was 0.63 with 12 results instead of 201 (the table is in `search-rerank.ts`, and `scripts/search-eval/calibrate.py` reproduces it).
  The truth sets are regexes over the fields the cross-encoder reads, so the benchmark favors it, and the open weights used are believed, not verified, to be the ones Cloudflare serves.
  Rerun the script when the catalog grows by a few hundred datasets or the model changes.
- **The cross-encoder does not read authors or README bodies.**
  Authors and title words are protected by the literal rule; anything else in a README reaches a result only through the lexical and semantic legs agreeing.
- **A real word the catalog lacks can be mistaken for a typo of a nearby one** ("simulation" for "stimulation").
  That is why the correction is reported and never silent, and why the corrector is restricted as far as the decision says.
- **`docs.nemar.org` and the website are separate repositories.**
  The documentation of `count`, `min_score` and the new `reranked` and `corrected_query` fields lives there, and the website's "N results" line now shows a smaller, truthful number.

## Alternatives considered

- **Tighten the lexical leg only (AND, or drop common words).**
  Removing generic words is adopted.
  Requiring every word is not: recall then depends on the user's words appearing verbatim, and it does not order by meaning.
- **An absolute cosine floor.**
  Measured and rejected: the cosine scores of a query bunch within a few hundredths (see Context), so no floor separates the right datasets from the rest, and 0.60 already admits about 100.
- **The cross-encoder alone, with a floor and a share of the best score.**
  This was the first design and is the "best score only" row of the calibration table: held-out precision 0.80, but coverage 0.30 and 6 results, because a list-style query ("handwriting typing keyboard") scores even its right datasets under 0.03.
  The agreement and literal clauses are what recovered the coverage.
- **Cloudflare AI Search (managed hybrid retrieval and reranking).**
  It would put a second copy of dataset facts in an index Cloudflare owns, and ADR 0003 (vectors carry no facts; every hit is hydrated from the live row) and ADR 0065 (anonymity decided at one writer) would each have to be re-established there.
- **A larger embedding model** (`bge-base`, `bge-m3`, `qwen3-embedding`).
  Different vector dimensions need a new Vectorize index and a full re-embed.
  Not measured here; revisit if the semantic leg's recall is shown to be what limits quality.
- **An LLM judge per query.**
  Higher cost and latency and a dependency on an external key, for a job a cross-encoder does as well as it needs to be done.
- **Stemming in the full-text index.**
  It needs `datasets_fts` rebuilt (the backup tax in ADR 0003), and the cross-encoder covers most of what stemming would add.

## Receipts

- `backend/src/services/search-rerank.ts`: the rule, its constants and the calibration table.
- `backend/src/services/search-query.ts`, `search-spelling.ts`, `dataset-summary-text.ts`: the query analysis, the corrector and the shared text.
- `scripts/search-eval/calibrate.py`: reproduces the tables above on the public catalog.
- `test/search-relevance.test.ts`, `test/search-query.test.ts`, `test/search-spelling.test.ts`: the behavior, on 160 real datasets with the real models' recorded output.
- Cloudflare `bge-reranker-base`: <https://developers.cloudflare.com/workers-ai/models/bge-reranker-base/>.
- ADR 0003, ADR 0005, ADR 0032, ADR 0065.
