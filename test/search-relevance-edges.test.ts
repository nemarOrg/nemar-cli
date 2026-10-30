/**
 * The edges of phrase search by relevance: that the recorded fixtures are still true, that
 * filters never change which datasets are relevant, what a failing model does to a request (and to
 * the next ones), that a SQL bug is not mistaken for a model failure, accents, repeated words, and
 * listing a named modality first.
 *
 * Same harness as search-relevance.test.ts: `executeDatasetSearch` over 160 real catalog datasets
 * in the production schema, the two network calls answered from recorded real-model output.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseFacetFilters } from "../backend/src/services/dataset-facets";
import {
  type SearchResult,
  executeDatasetSearch,
  prioritizeModalities,
  reembedDatasetVector,
} from "../backend/src/services/dataset-search";
import {
  DATASET_SUMMARY_SELECT_SQL,
  buildDatasetSummaryText,
} from "../backend/src/services/dataset-summary-text";
import { analyzeQuery } from "../backend/src/services/search-query";
import {
  RERANK_SUSPEND_MS,
  rerankSuspended,
  resetRerankSuspension,
} from "../backend/src/services/search-rerank";
import { resetVocabularyCache } from "../backend/src/services/search-spelling";
import { freshDb, realD1 } from "../backend/test/helpers/d1";
import {
  FIXTURE_DIR,
  catalogSample,
  seedCatalogRows,
  seedCatalogSample,
} from "../backend/test/helpers/search-catalog";
import { recordedModels } from "../backend/test/helpers/search-models";

beforeEach(() => {
  resetRerankSuspension();
  resetVocabularyCache();
});
afterEach(resetRerankSuspension);

function sampleDb() {
  const db = freshDb();
  seedCatalogSample(db);
  return { db, d1: realD1(db) };
}

type Run = {
  filters?: Parameters<typeof executeDatasetSearch>[3]["filters"];
  minScore?: number;
  limit?: number;
  d1?: D1Database;
};

async function search(d1: D1Database, query: string, models = recordedModels(), run: Run = {}) {
  const envelope = await executeDatasetSearch(run.d1 ?? d1, models.ai, models.vectorize, {
    query,
    filters: run.filters ?? {},
    limit: run.limit ?? 100,
    offset: 0,
    minScore: run.minScore ?? 0.6,
  });
  return { envelope, models };
}

const ids = (e: { results: Array<{ id: string }> }) => e.results.map((r) => r.id);
const MI = "motor imagery brain-computer interface";

describe("the recorded model output is still about these datasets", () => {
  test("every sample dataset's text hashes to what was recorded", () => {
    const { db } = sampleDb();
    const recorded = JSON.parse(readFileSync(join(FIXTURE_DIR, "model-outputs.json"), "utf8"))
      .text_sha256 as Record<string, string>;
    const rows = db
      .query(`SELECT d.dataset_id AS id, ${DATASET_SUMMARY_SELECT_SQL} FROM datasets d`)
      .all() as Array<Parameters<typeof buildDatasetSummaryText>[0] & { id: string }>;
    expect(rows).toHaveLength(catalogSample.length);
    const stale = rows
      .filter(
        (r) =>
          createHash("sha256").update(buildDatasetSummaryText(r)).digest("hex") !== recorded[r.id],
      )
      .map((r) => r.id);
    // Non-empty means the text builder changed: regenerate with scripts/search-eval/model_outputs.py.
    expect(stale).toEqual([]);
  });

  test("cases.json and the recorded queries are the same list", () => {
    const cases = JSON.parse(readFileSync(join(FIXTURE_DIR, "cases.json"), "utf8")) as Array<{
      semantic: string;
      rerank: string;
    }>;
    const recorded = JSON.parse(readFileSync(join(FIXTURE_DIR, "model-outputs.json"), "utf8"));
    expect(Object.keys(recorded.semantic).sort()).toEqual(cases.map((c) => c.semantic).sort());
    expect(Object.keys(recorded.rerank).sort()).toEqual(
      [...new Set(cases.map((c) => c.rerank))].sort(),
    );
  });
});

describe("a filter narrows the answer; it never changes which datasets are relevant", () => {
  test("a facet that matches every dataset returns exactly the unfiltered answer", async () => {
    const { d1 } = sampleDb();
    const open = (await search(d1, MI)).envelope;
    const facets = parseFacetFilters((k) => (k === "subjects" ? "0..100000" : undefined));
    const wide = (await search(d1, MI, recordedModels(), { filters: { facets } })).envelope;
    expect(ids(wide)).toEqual(ids(open).filter((id) => ids(wide).includes(id)));
    // Datasets with no subject count are hidden, and reported, not silently re-ranked.
    expect(ids(wide).length + (wide.excluded_unknown ?? 0)).toBe(ids(open).length);
  });

  test("a filter that leaves few datasets adds none that the unfiltered answer lacked", async () => {
    const { d1 } = sampleDb();
    const open = (await search(d1, MI)).envelope;
    // 'robbins' and 'kay' leave only the BCIT driving datasets: with the lexical leg narrowed to
    // them, one of them used to clear the bar for a motor imagery query it has nothing to do with.
    for (const filters of [
      { author: "delorme" },
      { author: "robbins" },
      { author: "kay" },
      { task: "rest" },
    ]) {
      const narrowed = (await search(d1, MI, recordedModels(), { filters })).envelope;
      for (const id of ids(narrowed)) expect(ids(open)).toContain(id);
    }
  });

  test("the request's min_score does not touch a phrase answered by relevance", async () => {
    const { d1 } = sampleDb();
    const base = (await search(d1, MI)).envelope;
    const strict = (await search(d1, MI, recordedModels(), { minScore: 0.99 })).envelope;
    expect(ids(strict)).toEqual(ids(base));
    expect(strict.min_score).toBe(0.99);
  });

  test("a result carries the highlighted README snippet the lexical leg found", async () => {
    const { d1 } = sampleDb();
    const { envelope } = await search(d1, "bilingual performance study");
    expect(envelope.results.find((r) => r.id === "nm000241")?.snippet).toContain("<mark>");
  });
});

describe("when a model fails", () => {
  test("a failed embedding is tried once, not twice", async () => {
    const { d1 } = sampleDb();
    const { envelope, models } = await search(
      d1,
      "bilingual performance study",
      recordedModels({ embeddingFails: true }),
    );
    expect(envelope.method).toBe("text_fallback");
    expect(models.calls.embed).toHaveLength(1);
  });

  test("a failed reranker pauses the reranker for the next requests, and only for a while", async () => {
    const { d1 } = sampleDb();
    await search(d1, "bilingual performance study", recordedModels({ rerankFails: true }));
    expect(rerankSuspended()).toBe(true);
    expect(rerankSuspended(Date.now() + RERANK_SUSPEND_MS + 1)).toBe(false);

    // While paused the next phrase never reaches the reranker, and still gets an answer.
    const during = await search(d1, "bilingual performance study");
    expect(during.models.calls.rerank).toHaveLength(0);
    expect(during.envelope.reranked).toBeUndefined();
    expect(ids(during.envelope).length).toBeGreaterThan(0);

    resetRerankSuspension();
    const after = await search(d1, "bilingual performance study");
    expect(after.envelope.reranked).toBe(true);
  });

  test("a reranker that gives every candidate the same score has not judged them", async () => {
    const { d1 } = sampleDb();
    const models = recordedModels();
    const flat = {
      run: async (model: string, input: Record<string, unknown>) => {
        if (model === "@cf/baai/bge-reranker-base") {
          const contexts = (input as { contexts: unknown[] }).contexts;
          return { response: contexts.map((_, id) => ({ id, score: -9 })) };
        }
        return (models.ai as unknown as { run: typeof Function.prototype }).run;
      },
    };
    const ai = {
      run: (model: string, input: Record<string, unknown>) =>
        model === "@cf/baai/bge-reranker-base"
          ? flat.run(model, input)
          : (models.ai.run as unknown as (m: string, i: unknown) => Promise<unknown>)(model, input),
    } as unknown as Ai;
    const envelope = await executeDatasetSearch(d1, ai, models.vectorize, {
      query: "bilingual performance study",
      filters: {},
      limit: 20,
      offset: 0,
      minScore: 0.6,
    });
    expect(envelope.reranked).toBeUndefined();
    expect(ids(envelope).length).toBeGreaterThan(0);
  });

  test("a phrase no dataset or neighbor matches answers empty by relevance, without calling the reranker", async () => {
    const { d1 } = sampleDb();
    const models = recordedModels();
    const nothingNear = {
      query: async () => ({ matches: [] }),
    } as unknown as VectorizeIndex;
    const ai = { run: async () => ({ data: [[0]] }) } as unknown as Ai;
    const envelope = await executeDatasetSearch(d1, ai, nothingNear, {
      query: "qzxqzx wvvwvv",
      filters: {},
      limit: 20,
      offset: 0,
      minScore: 0.6,
    });
    expect(envelope.count).toBe(0);
    expect(envelope.reranked).toBe(true);
    expect(models.calls.rerank).toHaveLength(0);
  });

  test("a SQL failure while reading the texts is a bug that surfaces, not 'the reranker is down'", async () => {
    const { d1 } = sampleDb();
    const failing = {
      prepare(sql: string) {
        if (sql.includes("json_valid(d.enrichment_json)"))
          throw new Error("no such column: enrichment_json");
        return d1.prepare(sql);
      },
      batch: d1.batch.bind(d1),
    } as unknown as D1Database;
    await expect(
      search(d1, "bilingual performance study", recordedModels(), { d1: failing }),
    ).rejects.toThrow("enrichment_json");
    expect(rerankSuspended()).toBe(false);
  });
});

describe("words", () => {
  test("a repeated word is one word: it lists what mentions it and is not judged", async () => {
    const { d1 } = sampleDb();
    const a = await analyzeQuery(d1, "sleep sleep");
    expect(a.content).toEqual(["sleep"]);
    expect(a.isPhrase).toBe(false);
  });

  test("an accented name is searched the way the index spells it", async () => {
    const { db, d1 } = sampleDb();
    db.run(
      "UPDATE datasets SET authors = 'Sebastien Lotte, Jane Roe' WHERE dataset_id = 'nm000111'",
    );
    const a = await analyzeQuery(d1, "Sébastien Lotte");
    expect(a.lexicalQuery).toBe("sebastien lotte");
    const envelope = await executeDatasetSearch(d1, undefined, undefined, {
      query: "Sébastien Lotte",
      filters: {},
      limit: 10,
      offset: 0,
      minScore: 0.6,
    });
    expect(ids(envelope)).toContain("nm000111");
  });

  test("a correction is reported in the user's own text, accents folded, not as a token join", async () => {
    const { d1 } = sampleDb();
    const a = await analyzeQuery(d1, "Sleeep stage, café");
    expect(a.correctedQuery).toBe("sleep stage, cafe");
  });

  test("a catalog too small to measure does not call a word a typo", async () => {
    // In a handful of datasets nearly every word is unseen; staging is such a catalog.
    const db = freshDb();
    const cerebro = catalogSample.filter((r) => r.id === "nm000241");
    // 'bilingual' is in the catalog's vocabulary here, one typo from the query's word.
    seedCatalogRows(
      db,
      [...cerebro, ...catalogSample.filter((r) => r.id !== "nm000241")].slice(0, 8),
    );
    const a = await analyzeQuery(realD1(db), "bilinugual performance");
    expect(a.correctedQuery).toBeUndefined();
    expect(a.content).toEqual(["bilinugual", "performance"]);
  });

  test("a word too long to be a word is dropped, so one request cannot build an unbounded query", async () => {
    const { d1 } = sampleDb();
    const a = await analyzeQuery(d1, `${"x".repeat(5000)} sleep`);
    expect(a.content).toEqual(["sleep"]);
  });

  test("a catalog of 100 datasets can say a word is generic; 99 cannot", async () => {
    // 'cerebrovoice' is in one dataset; 'study' is made to be in every one.
    const cerebro = catalogSample.filter((r) => r.id === "nm000241");
    const others = catalogSample.filter((r) => r.id !== "nm000241");
    const informative = async (n: number) => {
      const db = freshDb();
      seedCatalogRows(
        db,
        [...cerebro, ...others].slice(0, n).map((r) => ({ ...r, readme: "study", keywords: [] })),
      );
      return (await analyzeQuery(realD1(db), "cerebrovoice study")).informative;
    };
    expect(await informative(99)).toEqual(["cerebrovoice", "study"]);
    expect(await informative(100)).toEqual(["cerebrovoice"]);
  });
});

describe("a modality the query names is listed first", () => {
  test("'sleep eeg' lists EEG datasets before any that lack the eeg modality", async () => {
    const { d1 } = sampleDb();
    const { envelope, models } = await search(d1, "sleep eeg");
    expect(envelope.modality_boost).toEqual(["eeg"]);
    // The reranker is asked about the topic only.
    expect(models.calls.rerank[0]?.query).toBe("sleep");
    const hasEeg = envelope.results.map((r) =>
      r.modalities.toLowerCase().split(",").includes("eeg"),
    );
    expect(hasEeg).toContain(true);
    expect(hasEeg).toContain(false);
    // Once a dataset without the modality appears, none with it follows.
    expect(hasEeg.join()).not.toMatch(/false.*true/);
    // The intracranial sleep datasets are still answers, just not the first ones.
    expect(ids(envelope)).toContain("nm000360");
  });

  test("it is a whole-token match: asking for eeg never promotes an ieeg-only dataset", async () => {
    const { d1 } = sampleDb();
    const eeg = (await search(d1, "sleep eeg")).envelope;
    const first = eeg.results[0];
    expect(first?.modalities.toLowerCase().split(",")).toContain("eeg");
    const ieeg = (await search(d1, "sleep ieeg")).envelope;
    expect(ieeg.modality_boost).toEqual(["ieeg"]);
    expect(ieeg.results[0]?.modalities.toLowerCase().split(",")).toContain("ieeg");
  });

  test("a query that is only modalities is not rewritten", async () => {
    const { d1 } = sampleDb();
    expect((await analyzeQuery(d1, "eeg meg")).modalityBoost).toEqual([]);
    expect((await analyzeQuery(d1, "eeg")).modalityBoost).toEqual([]);
    // Nothing else is being asked, so the modality words are the query (eeg is too common to
    // discriminate, meg is not).
    const a = await analyzeQuery(d1, "eeg meg");
    expect(a.informative).toContain("meg");
    expect(a.isPhrase).toBe(true);
  });

  test("a query without a modality says nothing about one", async () => {
    const { d1 } = sampleDb();
    const { envelope } = await search(d1, MI);
    expect(envelope.modality_boost).toBeUndefined();
  });

  test("prioritizeModalities keeps each group's order and prefers more matches", () => {
    const row = (id: string, modalities: string) => ({ id, modalities }) as SearchResult;
    const rows = [
      row("a", "ieeg"),
      row("b", "eeg"),
      row("c", "eeg,meg"),
      row("d", "beh"),
      row("e", "eeg"),
    ];
    expect(prioritizeModalities(rows, ["eeg"]).map((r) => r.id)).toEqual(["b", "c", "e", "a", "d"]);
    expect(prioritizeModalities(rows, ["eeg", "meg"]).map((r) => r.id)).toEqual([
      "c",
      "b",
      "e",
      "a",
      "d",
    ]);
    expect(prioritizeModalities(rows, [])).toBe(rows);
  });
});

describe("the vector and the reranker read the same text", () => {
  test("what reembedDatasetVector embeds is what the reranker is sent for that dataset", async () => {
    const { d1 } = sampleDb();
    const embedded: string[] = [];
    const upserts: string[] = [];
    const ai = {
      run: async (_m: string, input: { text: string[] }) => {
        embedded.push(input.text[0] as string);
        return { data: [[0.1, 0.2]] };
      },
    } as unknown as Ai;
    const vectorize = {
      upsert: async (v: Array<{ id: string }>) => {
        upserts.push(...v.map((x) => x.id));
      },
    } as unknown as VectorizeIndex;
    expect(await reembedDatasetVector(d1, ai, vectorize, "nm000241")).toBe(true);
    expect(upserts).toEqual(["nm000241"]);

    const { models } = await search(d1, "bilingual performance study");
    expect(models.calls.rerank[0]?.texts).toContain(embedded[0] as string);
  });
});
