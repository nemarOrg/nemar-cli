/**
 * Phrase search by relevance (search-rerank.ts, searchByRelevance in dataset-search.ts).
 *
 * The user-visible bug: `nemar dataset search "bilingual performance study"` returned 565 of 906
 * datasets, led by driving-simulator and P300 datasets, because "study" and "performance" are in
 * most READMEs and nothing ever judged whether a dataset answers the phrase.
 *
 * These run `executeDatasetSearch` -- the real orchestration -- over 160 real catalog datasets in
 * the production schema. The two network calls (embedding, Vectorize, and the cross-encoder) are
 * answered from what the real BAAI models said about these exact texts (see
 * backend/test/helpers/search-models.ts); the model runs are recorded, the code around them is real.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { parseFacetFilters } from "../backend/src/services/dataset-facets";
import { executeDatasetSearch } from "../backend/src/services/dataset-search";
import {
  AGREE_MIN,
  ENDORSE_MIN,
  LITERAL_SCORE,
  RERANK_MODEL,
  normalizeRerankScores,
  rerankScores,
  resetRerankScaleLog,
  resetRerankSuspension,
  selectRelevant,
} from "../backend/src/services/search-rerank";
import { freshDb, realD1 } from "../backend/test/helpers/d1";
import { seedCatalogSample } from "../backend/test/helpers/search-catalog";
import { type RecordedModelOptions, recordedModels } from "../backend/test/helpers/search-models";

// The suspension is per-process state: a test that fails the reranker must not leave it on for the next file.
beforeEach(resetRerankSuspension);
afterEach(resetRerankSuspension);

function sampleDb() {
  const db = freshDb();
  seedCatalogSample(db);
  return { db, d1: realD1(db) };
}

async function search(
  d1: D1Database,
  query: string,
  options: RecordedModelOptions & {
    /** The query is expected NOT to be answered by relevance (a single word). */
    fused?: boolean;
    minScore?: number;
    limit?: number;
    offset?: number;
    filters?: Parameters<typeof executeDatasetSearch>[3]["filters"];
  } = {},
) {
  const models = recordedModels(options);
  const envelope = await executeDatasetSearch(d1, models.ai, models.vectorize, {
    query,
    filters: options.filters ?? {},
    limit: options.limit ?? 50,
    offset: options.offset ?? 0,
    minScore: options.minScore ?? 0.6,
  });
  // The recorded models throw on anything they have no record of, and the search turns a model
  // failure into the fused list: so unless the test injects a failure or asks for a single word,
  // "the reranker really ran" has to be asserted here, or half the suite would pass without it.
  if (!options.rerankFails && !options.embeddingFails && !options.fused) {
    expect(envelope.reranked).toBe(true);
  }
  return { envelope, models };
}

const ids = (e: { results: Array<{ id: string }> }) => e.results.map((r) => r.id);

describe("'bilingual performance study', the query that returned 565 datasets", () => {
  test("returns the datasets about the topic and none of the 'study'/'performance' noise", async () => {
    const { d1 } = sampleDb();
    const { envelope, models } = await search(d1, "bilingual performance study");

    expect(envelope.reranked).toBe(true);
    expect(envelope.method).toBe("semantic");
    // The bilingual speech dataset is there; the driving, P300 and replication-study datasets the
    // old OR-of-every-word search led with are not.
    expect(ids(envelope)).toContain("nm000241");
    for (const noise of ["on004118", "on004120", "nm000200", "nm000338", "on004395", "on004602"]) {
      expect(ids(envelope)).not.toContain(noise);
    }
    expect(envelope.count).toBeLessThanOrEqual(5);
    // The cross-encoder is asked about the words that tell datasets apart, not about "study".
    expect(models.calls.rerank).toHaveLength(1);
    expect(models.calls.rerank[0]?.query).toBe("bilingual performance");
    // The embedding is given the caller's own phrase.
    expect(models.calls.embed).toEqual(["bilingual performance study"]);
  });

  test("when the reranker is down it serves the fused list, which is the broad answer", async () => {
    const { d1 } = sampleDb();
    const relevant = (await search(d1, "bilingual performance study")).envelope;
    const { envelope: fused, models } = await search(d1, "bilingual performance study", {
      rerankFails: true,
    });

    expect(models.calls.rerank).toHaveLength(1);
    expect(fused.reranked).toBeUndefined();
    expect(fused.method).toBe("semantic");
    expect(fused.results.length).toBeGreaterThan(0);
    // Positive control for the test above: without the cutoff the answer is an order of
    // magnitude longer, so "count <= 5" there is the cutoff doing work, not a thin fixture.
    expect(fused.count).toBeGreaterThan(relevant.count * 5);
  });
});

describe("a clear topical phrase", () => {
  test("'driving simulation and fatigue' returns the driving datasets and nothing else of weight", async () => {
    const { d1 } = sampleDb();
    const { envelope } = await search(d1, "driving simulation and fatigue");
    expect(new Set(ids(envelope).slice(0, 7))).toEqual(
      new Set(["on004118", "on004120", "on004122", "on004105", "on004123", "on004121", "nm000275"]),
    );
    expect(envelope.count).toBeLessThanOrEqual(10);
  });

  test("'sleep stage classification during overnight recording' leads with sleep datasets", async () => {
    const { d1 } = sampleDb();
    const { envelope } = await search(d1, "sleep stage classification during overnight recording");
    expect(envelope.results[0]?.id).toBe("nm000111");
    expect(ids(envelope)).toEqual(expect.arrayContaining(["nm000185", "nm000225", "on005555"]));
    expect(envelope.results.filter((r) => /sleep/i.test(r.name)).length).toBeGreaterThanOrEqual(8);
    // The 12 sample datasets about motor imagery, ERPs and the like are not here.
    expect(ids(envelope)).not.toContain("nm000245");
  });

  test("'motor imagery brain-computer interface' returns motor imagery datasets, many of them", async () => {
    const { d1 } = sampleDb();
    const { envelope } = await search(d1, "motor imagery brain-computer interface");
    expect(envelope.count).toBeGreaterThanOrEqual(15);
    for (const r of envelope.results.slice(0, 10)) expect(r.name).toMatch(/motor|\bMI\b/i);
  });

  test("scores are probabilities, best first, and the envelope describes what was kept", async () => {
    const { d1 } = sampleDb();
    const { envelope } = await search(d1, "driving simulation and fatigue");
    const scores = envelope.results.map((r) => r.score);
    // A fusion score tops out near 0.033; a judged probability for the best driving dataset is near 1.
    expect(scores[0]).toBeGreaterThan(0.9);
    for (const score of scores) {
      expect(score).toBeGreaterThan(0);
      expect(score).toBeLessThanOrEqual(1);
    }
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
    expect(envelope.count).toBe(envelope.results.length);
    expect(envelope.candidate_ceiling).toBe(envelope.count);
    expect(envelope.truncated).toBe(false);
  });
});

describe("evidence the cross-encoder was never shown", () => {
  test("a person's name finds their datasets: it is in the byline, not in the abstract", async () => {
    const { d1 } = sampleDb();
    const { envelope } = await search(d1, "arnaud delorme");
    expect(ids(envelope)).toEqual(
      expect.arrayContaining(["on001787", "on001971", "on002578", "on002680"]),
    );
    // Every result has both names in its authors, nothing is there on a semantic coincidence.
    for (const r of envelope.results) {
      expect(r.authors.toLowerCase()).toContain("arnaud");
      expect(r.authors.toLowerCase()).toContain("delorme");
      expect(r.score).toBeGreaterThanOrEqual(LITERAL_SCORE);
    }
  });

  test("a query the catalog barely answers still returns the few datasets that mention it", async () => {
    const { d1 } = sampleDb();
    const { envelope } = await search(d1, "children with ADHD");
    expect(ids(envelope)).toEqual(expect.arrayContaining(["on005863", "on006018"]));
    expect(envelope.count).toBeLessThanOrEqual(15);
  });
});

describe("what is not a phrase is not cut", () => {
  test("one content word is searched as before: no cross-encoder call, no relevance cutoff", async () => {
    const { d1 } = sampleDb();
    const { envelope, models } = await search(d1, "sleep", { fused: true });
    expect(models.calls.rerank).toHaveLength(0);
    expect(envelope.reranked).toBeUndefined();
    expect(envelope.count).toBeGreaterThanOrEqual(10);
  });
});

describe("filters and paging apply to the relevant set", () => {
  test("paging slices one ordered list; count does not move with the page", async () => {
    const { d1 } = sampleDb();
    const q = "motor imagery brain-computer interface";
    const all = (await search(d1, q, { limit: 100 })).envelope;
    const page = (await search(d1, q, { limit: 4, offset: 4 })).envelope;
    expect(ids(page)).toEqual(ids(all).slice(4, 8));
    expect(page.count).toBe(all.count);
    expect(page.returned).toBe(4);
    expect(page.offset).toBe(4);
  });

  test("a modality filter keeps only matching datasets and does not change which are relevant", async () => {
    const { d1 } = sampleDb();
    const q = "sleep stage classification during overnight recording";
    const all = (await search(d1, q)).envelope;
    const eeg = (await search(d1, q, { filters: { modality: "eeg" } })).envelope;
    // nm000360 and nm000481 are intracranial recordings.
    expect(ids(all)).toEqual(expect.arrayContaining(["nm000360", "nm000481"]));
    expect(ids(eeg)).not.toContain("nm000360");
    expect(ids(eeg)).not.toContain("nm000481");
    for (const r of eeg.results) expect(r.modalities.toLowerCase().split(",")).toContain("eeg");
    // What survives is the same datasets in the same order.
    expect(ids(eeg)).toEqual(ids(all).filter((id) => ids(eeg).includes(id)));
  });

  test("a facet hides unknown-valued datasets by default and reports how many it hid", async () => {
    const { db, d1 } = sampleDb();
    db.run("UPDATE datasets SET subject_count = NULL WHERE dataset_id = 'nm000111'");
    const q = "sleep stage classification during overnight recording";
    const facets = parseFacetFilters((k) => (k === "subjects" ? "1..100000" : undefined));

    const filtered = (await search(d1, q, { filters: { facets } })).envelope;
    expect(ids(filtered)).not.toContain("nm000111");
    expect(filtered.excluded_unknown).toBeGreaterThanOrEqual(1);
    expect(filtered.excluded_unknown_by_facet?.subjects).toBeGreaterThanOrEqual(1);

    // Positive control: with the facet off, the best answer is back, first.
    const unfiltered = (await search(d1, q)).envelope;
    expect(unfiltered.results[0]?.id).toBe("nm000111");
  });

  test("a dataset that is not public is never a candidate, never a result", async () => {
    const { db, d1 } = sampleDb();
    const q = "driving simulation and fatigue";
    const before = await search(d1, q);
    db.run("UPDATE datasets SET visibility = 'private' WHERE dataset_id = 'on004121'");
    const after = await search(d1, q);
    expect(ids(before.envelope)).toContain("on004121");
    expect(ids(after.envelope)).not.toContain("on004121");
    // Not merely filtered at the end: its text was never sent to the cross-encoder.
    const sent = (calls: typeof before.models.calls) => calls.rerank.flatMap((r) => r.texts);
    expect(sent(before.models.calls).some((t) => t.startsWith("BCIT Mind Wandering"))).toBe(true);
    expect(sent(after.models.calls).some((t) => t.startsWith("BCIT Mind Wandering"))).toBe(false);
  });
});

describe("degrading, never failing (ADR 0005)", () => {
  test("no AI binding: lexical only, still narrowed to the informative words", async () => {
    const { d1 } = sampleDb();
    const envelope = await executeDatasetSearch(d1, undefined, undefined, {
      query: "bilingual performance study",
      filters: {},
      limit: 50,
      offset: 0,
      minScore: 0.6,
    });
    expect(envelope.method).toBe("text");
    expect(envelope.reranked).toBeUndefined();
    expect(ids(envelope)[0]).toBe("nm000241");
  });

  test("embedding down: falls back to the lexical list, as before", async () => {
    const { d1 } = sampleDb();
    const { envelope, models } = await search(d1, "bilingual performance study", {
      embeddingFails: true,
    });
    expect(envelope.method).toBe("text_fallback");
    expect(envelope.reranked).toBeUndefined();
    expect(ids(envelope)[0]).toBe("nm000241");
    expect(models.calls.rerank).toHaveLength(0);
  });
});

describe("selectRelevant", () => {
  const c = (id: string, p: number, flags: { both?: boolean; literal?: boolean } = {}) => ({
    id,
    p,
    foundByBothLegs: flags.both ?? false,
    literalMatch: flags.literal ?? false,
  });

  test("keeps what the cross-encoder endorses and drops what it does not", () => {
    const kept = selectRelevant([c("a", 0.9), c("b", 0.5), c("c", 0.15), c("d", 0.05)]);
    // 0.15 is above the absolute floor but under 20% of the best (0.18); 0.05 is under both.
    expect(kept.map((k) => k.id)).toEqual(["a", "b"]);
  });

  test("the floor relative to the best score keeps a lower answer when the best is low", () => {
    const kept = selectRelevant([c("a", 0.3), c("b", 0.12), c("c", 0.04)]);
    expect(kept.map((k) => k.id)).toEqual(["a", "b"]);
  });

  test("a dataset both legs found is kept unless the cross-encoder strongly rejects it", () => {
    const kept = selectRelevant([
      c("best", 0.95),
      c("agreed", AGREE_MIN, { both: true }),
      c("vetoed", AGREE_MIN / 2, { both: true }),
      c("alone", 0.05),
    ]);
    expect(kept.map((k) => k.id)).toEqual(["best", "agreed"]);
  });

  test("when every score is low, only datasets both legs found survive", () => {
    // 'handwriting typing keyboard': the right datasets score under 0.03 for a list-style query.
    const kept = selectRelevant([
      c("lone", 0.029),
      c("both-1", 0.013, { both: true }),
      c("both-2", 0.011, { both: true }),
    ]);
    expect(kept.map((k) => k.id)).toEqual(["both-1", "both-2"]);
  });

  test("a literal name/author match is kept whatever the cross-encoder said, and sorts at its floor", () => {
    const kept = selectRelevant([c("semantic", 0.9), c("byline", 0.0001, { literal: true })]);
    expect(kept.map((k) => k.id)).toEqual(["semantic", "byline"]);
    expect(kept[1]?.score).toBe(LITERAL_SCORE);
  });

  test("a literal match the cross-encoder also likes keeps its own, higher, score", () => {
    const kept = selectRelevant([c("a", 0.6, { literal: true }), c("b", 0.55)]);
    expect(kept.map((k) => [k.id, k.score])).toEqual([
      ["a", 0.6],
      ["b", 0.55],
    ]);
  });

  test("equal scores keep the order the retrieval legs gave", () => {
    const kept = selectRelevant([c("first", 0.5), c("second", 0.5), c("third", 0.5)]);
    expect(kept.map((k) => k.id)).toEqual(["first", "second", "third"]);
  });

  test("nothing in, nothing out; and the absolute floor is the documented one", () => {
    expect(selectRelevant([])).toEqual([]);
    expect(selectRelevant([c("only", ENDORSE_MIN - 0.01)])).toEqual([]);
    expect(selectRelevant([c("only", ENDORSE_MIN)]).map((k) => k.id)).toEqual(["only"]);
  });
});

describe("normalizeRerankScores", () => {
  test("raw logits become probabilities", () => {
    const [low, zero, high] = normalizeRerankScores([-6, 0, 6]);
    expect(low).toBeCloseTo(0.00247, 4);
    expect(zero).toBe(0.5);
    expect(high).toBeCloseTo(0.99753, 4);
  });

  const tenInUnit = [0.02, 0.4, 0.97, 0.1, 0.2, 0.3, 0.5, 0.6, 0.7, 0.8];

  test("ten or more scores all in [0,1] are probabilities and are not squeezed a second time", () => {
    expect(normalizeRerankScores(tenInUnit)).toEqual(tenInUnit);
  });

  test("a few scores that happen to lie in [0,1] are still logits: nine is too few to tell", () => {
    const nine = tenInUnit.slice(0, 9);
    expect(normalizeRerankScores(nine)[2]).toBeCloseTo(1 / (1 + Math.exp(-0.97)), 6);
  });

  test("one score outside [0,1] makes the set logits", () => {
    const withNegative = [...tenInUnit.slice(0, 9), -3];
    expect(normalizeRerankScores(withNegative)[9]).toBeCloseTo(0.0474, 3);
  });

  test("logs the scale it read, once", () => {
    resetRerankScaleLog();
    const lines: string[] = [];
    const log = console.log;
    console.log = (...args: unknown[]) => lines.push(args.join(" "));
    try {
      const twenty = Array.from({ length: 20 }, (_, i) => i - 10);
      normalizeRerankScores(twenty);
      normalizeRerankScores(twenty);
    } finally {
      console.log = log;
    }
    expect(lines.filter((l) => l.includes("rerank raw scores"))).toHaveLength(1);
    expect(lines[0]).toContain("read as logits");
  });
});

describe("rerankScores", () => {
  const fakeAi = (answer: () => Promise<unknown>) => ({ run: answer }) as unknown as Ai;

  test("aligns scores to the candidates by id, however the model orders its answer", async () => {
    const ai = fakeAi(async () => ({
      response: [
        { id: 2, score: 5 },
        { id: 0, score: 1 },
        { id: 1, score: -4 },
      ],
    }));
    const out = await rerankScores(ai, "q", ["a", "b", "c"]);
    expect(out[0]).toBeCloseTo(1 / (1 + Math.exp(-1)), 6);
    expect(out[1]).toBeCloseTo(1 / (1 + Math.exp(4)), 6);
    expect(out[2]).toBeCloseTo(1 / (1 + Math.exp(-5)), 6);
  });

  test("asks for every candidate back, with the model Cloudflare documents", async () => {
    let seen: Record<string, unknown> = {};
    let model = "";
    const ai = {
      run: async (m: string, input: Record<string, unknown>) => {
        model = m;
        seen = input;
        return {
          response: [
            { id: 0, score: 1 },
            { id: 1, score: 0 },
          ],
        };
      },
    } as unknown as Ai;
    await rerankScores(ai, "a query", ["x", "y"]);
    expect(model).toBe(RERANK_MODEL);
    expect(seen).toEqual({ query: "a query", contexts: [{ text: "x" }, { text: "y" }], top_k: 2 });
  });

  test("a partial answer throws: dropping candidates unseen would be silent", async () => {
    const ai = fakeAi(async () => ({ response: [{ id: 0, score: 1 }] }));
    await expect(rerankScores(ai, "q", ["a", "b"])).rejects.toThrow("1 of 2");
  });

  test("an out-of-range id or a non-finite score does not count as an answer", async () => {
    const ai = fakeAi(async () => ({
      response: [
        { id: 7, score: 1 },
        { id: 0, score: Number.NaN },
      ],
    }));
    await expect(rerankScores(ai, "q", ["a"])).rejects.toThrow("0 of 1");
  });

  test("a model that never answers is abandoned at the timeout", async () => {
    const ai = fakeAi(() => new Promise(() => {}));
    const started = Date.now();
    await expect(rerankScores(ai, "q", ["a"], 30)).rejects.toThrow("timed out after 30 ms");
    expect(Date.now() - started).toBeLessThan(1000);
  });

  test("no candidates, no call", async () => {
    const ai = fakeAi(async () => {
      throw new Error("must not be called");
    });
    await expect(rerankScores(ai, "q", [])).resolves.toEqual([]);
  });
});
