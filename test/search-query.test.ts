/**
 * What a search query is made of (search-query.ts) and what the lexical leg does with it.
 *
 * Runs against a real-catalog sample (160 public datasets copied from api.nemar.org, see
 * backend/test/helpers/search-catalog.ts) in the production schema, through the entry
 * points: `analyzeQuery` and `executeDatasetSearch`. The bindings for the semantic tier are
 * absent, so the lexical leg is what answers; the semantic and reranking tiers are covered
 * in search-relevance.test.ts.
 *
 * The user-visible bug these pin: "bilingual performance study" returned 565 of 906
 * datasets because every word was OR-ed as a prefix and "study" is in 59% of them.
 */

import { describe, expect, test } from "bun:test";
import { buildFtsMatch } from "../backend/src/services/dataset-filters";
import { executeDatasetSearch } from "../backend/src/services/dataset-search";
import {
  GENERIC_DF_MAX,
  MAX_QUERY_TERMS,
  MIN_CORPUS_FOR_DF,
  analyzeQuery,
  contentTokens,
  queryTokens,
  termFrequencies,
} from "../backend/src/services/search-query";
import { freshDb, realD1 } from "../backend/test/helpers/d1";
import { catalogSample, seedCatalogSample } from "../backend/test/helpers/search-catalog";

function sampleDb() {
  const db = freshDb();
  seedCatalogSample(db);
  return { db, d1: realD1(db) };
}

const search = (d1: D1Database, query: string, limit = 20) =>
  executeDatasetSearch(d1, undefined, undefined, {
    query,
    filters: {},
    limit,
    offset: 0,
    minScore: 0.6,
  });

describe("tokens", () => {
  test("queryTokens is the lexical leg's tokenizer: lowercase alphanumerics of two or more characters", () => {
    expect(queryTokens("Bilingual performance, study! A 1")).toEqual([
      "bilingual",
      "performance",
      "study",
    ]);
  });

  test("contentTokens drops function words but keeps a query that is nothing else", () => {
    expect(contentTokens(queryTokens("children with ADHD"))).toEqual(["children", "adhd"]);
    expect(contentTokens(queryTokens("the"))).toEqual(["the"]);
  });

  test("a very long query is cut to MAX_QUERY_TERMS words", () => {
    const long = Array.from({ length: 40 }, (_, i) => `word${i}`).join(" ");
    expect(contentTokens(queryTokens(long))).toHaveLength(MAX_QUERY_TERMS);
  });
});

describe("termFrequencies, against the real catalog sample", () => {
  test("a word in most datasets is generic, a topic word is not", async () => {
    const { d1 } = sampleDb();
    const { corpusSize, ratios } = await termFrequencies(d1, [
      "eeg",
      "study",
      "bilingual",
      "sleep",
    ]);
    expect(corpusSize).toBe(catalogSample.length);
    expect(ratios.get("eeg") ?? 0).toBeGreaterThan(GENERIC_DF_MAX);
    expect(ratios.get("study") ?? 0).toBeGreaterThan(GENERIC_DF_MAX);
    expect(ratios.get("bilingual") ?? 1).toBeLessThanOrEqual(GENERIC_DF_MAX);
    expect(ratios.get("sleep") ?? 1).toBeLessThanOrEqual(GENERIC_DF_MAX);
  });

  test("counts the same prefix match the lexical leg uses", async () => {
    const { db, d1 } = sampleDb();
    const { corpusSize, ratios } = await termFrequencies(d1, ["sleep"]);
    const direct = db
      .query(
        "SELECT COUNT(*) AS n FROM datasets d WHERE d.id IN (SELECT rowid FROM datasets_fts WHERE datasets_fts MATCH ?)",
      )
      .get(buildFtsMatch("sleep") as string) as { n: number };
    expect(ratios.get("sleep")).toBeCloseTo(direct.n / corpusSize, 10);
  });

  test("a private dataset is not part of the population", async () => {
    const { db, d1 } = sampleDb();
    const before = (await termFrequencies(d1, ["sleep"])).corpusSize;
    db.run("UPDATE datasets SET visibility = 'private' WHERE dataset_id = 'nm000111'");
    expect((await termFrequencies(d1, ["sleep"])).corpusSize).toBe(before - 1);
  });
});

describe("analyzeQuery", () => {
  test("drops the generic word from 'bilingual performance study'", async () => {
    const { d1 } = sampleDb();
    const a = await analyzeQuery(d1, "bilingual performance study");
    expect(a.content).toEqual(["bilingual", "performance", "study"]);
    expect(a.informative).toEqual(["bilingual", "performance"]);
    expect(a.lexicalQuery).toBe("bilingual performance");
    expect(a.rerankQuery).toBe("bilingual performance");
    // The embedding is given the caller's own words, generic ones included.
    expect(a.semanticQuery).toBe("bilingual performance study");
    expect(a.isPhrase).toBe(true);
  });

  test("a query of only generic words keeps all of them, so it still searches", async () => {
    const { d1 } = sampleDb();
    const a = await analyzeQuery(d1, "study task");
    expect(a.informative).toEqual(["study", "task"]);
  });

  test("one content word is not a phrase, whatever function words surround it", async () => {
    const { d1 } = sampleDb();
    expect((await analyzeQuery(d1, "sleep")).isPhrase).toBe(false);
    expect((await analyzeQuery(d1, "the sleep")).isPhrase).toBe(false);
    expect((await analyzeQuery(d1, "the sleep")).lexicalQuery).toBe("sleep");
  });

  test("a catalog too small to measure drops nothing", async () => {
    const db = freshDb();
    const d1 = realD1(db);
    for (const r of catalogSample.slice(0, MIN_CORPUS_FOR_DF - 1)) {
      db.run(
        `INSERT INTO datasets (dataset_id, name, description, readme, owner_user_id, status, visibility, is_sandbox)
         VALUES (?, ?, ?, ?, -1, 'active', 'public', 0)`,
        [r.id, r.name, r.description, "study study study"],
      );
    }
    const a = await analyzeQuery(d1, "bilingual performance study");
    expect(a.informative).toEqual(["bilingual", "performance", "study"]);
  });

  test("a failing frequency query degrades to every content word, and does not throw", async () => {
    const db = freshDb();
    db.exec("DROP TABLE datasets_fts");
    const a = await analyzeQuery(realD1(db), "bilingual performance study");
    expect(a.informative).toEqual(["bilingual", "performance", "study"]);
  });

  test("punctuation alone has no words and is handed through unchanged", async () => {
    const { d1 } = sampleDb();
    const a = await analyzeQuery(d1, "  ?! ");
    expect(a.content).toEqual([]);
    expect(a.lexicalQuery).toBe("?!");
    expect(a.isPhrase).toBe(false);
  });
});

describe("executeDatasetSearch, lexical leg only (no AI binding)", () => {
  test("'bilingual performance study' no longer matches every dataset that says 'study'", async () => {
    const { db, d1 } = sampleDb();
    const oldMatchCount = (
      db
        .query("SELECT COUNT(*) AS n FROM datasets_fts WHERE datasets_fts MATCH ?")
        .get(buildFtsMatch("bilingual performance study") as string) as { n: number }
    ).n;
    // The premise: on this sample the old OR-of-every-word match covers most of the catalog.
    expect(oldMatchCount).toBeGreaterThan(catalogSample.length / 2);

    const envelope = await search(d1, "bilingual performance study");
    expect(envelope.method).toBe("text");
    expect(envelope.count).toBeLessThan(oldMatchCount / 3);
    // The dataset that is about the topic leads.
    expect(envelope.results[0]?.id).toBe("nm000241");
    // A dataset that only says "study" in its README is not a result.
    expect(envelope.results.map((r) => r.id)).not.toContain("on004395");
  });

  test("a dataset named for the topic outranks datasets that only mention it in a long README", async () => {
    const { d1 } = sampleDb();
    // 'nm000275' is "Multi-channel EEG recordings during a sustained-attention driving task": the
    // word is in its name. Unweighted bm25 ranks it behind four BCIT datasets whose READMEs repeat
    // the word; the column weights put it in the top three.
    const driving = await search(d1, "driving");
    expect(driving.results.slice(0, 3).map((r) => r.id)).toContain("nm000275");

    // Two of the four best answers for "p300" carry it in their name (one unweighted).
    const p300 = await search(d1, "p300");
    const named = p300.results.slice(0, 4).filter((r) => r.name.toLowerCase().includes("p300"));
    expect(named.length).toBeGreaterThanOrEqual(2);
  });

  test("a query of only generic words still returns results", async () => {
    const { d1 } = sampleDb();
    const envelope = await search(d1, "eeg study");
    expect(envelope.count).toBeGreaterThan(50);
  });

  test("count and the match it describes stay consistent for a phrase", async () => {
    const { d1 } = sampleDb();
    const small = await search(d1, "bilingual performance study", 3);
    const large = await search(d1, "bilingual performance study", 100);
    expect(small.count).toBe(large.count);
    expect(large.returned).toBe(Math.min(large.count, 100));
  });
});
