/**
 * Correcting a query word the catalog has never seen (search-spelling.ts).
 *
 * The user's own example, "bilinugual performance study", had the typo that no embedding can
 * recover from (on the live catalog the right dataset ranks 3rd for "bilingual" and 117th for
 * "bilinugual"). These run the real analysis and the real search over 160 real catalog
 * datasets; the cases that matter as much as the corrections are the ones it must leave alone.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { searchDatasetsTool } from "../backend/src/mcp/tools/search-datasets";
import { executeDatasetSearch } from "../backend/src/services/dataset-search";
import { analyzeQuery } from "../backend/src/services/search-query";
import {
  MIN_CORRECTABLE_LENGTH,
  VOCABULARY_TTL_MS,
  buildVocabulary,
  editDistance,
  loadVocabulary,
  resetVocabularyCache,
  suggestCorrection,
} from "../backend/src/services/search-spelling";
import { freshDb, realD1 } from "../backend/test/helpers/d1";
import { catalogSample, seedCatalogSample } from "../backend/test/helpers/search-catalog";
import { recordedModels } from "../backend/test/helpers/search-models";

function sampleDb() {
  const db = freshDb();
  seedCatalogSample(db);
  return { db, d1: realD1(db) };
}

beforeEach(resetVocabularyCache);

describe("editDistance", () => {
  test("counts an insertion, a deletion, a substitution and a swap of neighbors as one edit each", () => {
    expect(editDistance("bilinugual", "bilingual", 2)).toBe(1); // extra letter
    expect(editDistance("meditaton", "meditation", 2)).toBe(1); // missing letter
    expect(editDistance("sleap", "sleep", 2)).toBe(1); // substituted letter
    expect(editDistance("sleep", "selep", 2)).toBe(1); // swapped neighbors
    expect(editDistance("sleep", "sleep", 2)).toBe(0);
  });

  test("stops early and reports 'more than max' when the words are further apart", () => {
    expect(editDistance("sleep", "epilepsy", 1)).toBe(2);
    expect(editDistance("abcdefgh", "zzzzzzzz", 2)).toBe(3);
    expect(editDistance("a", "abcdef", 2)).toBe(3);
  });
});

describe("suggestCorrection", () => {
  const vocabulary = buildVocabulary(catalogSample);

  test("a word one typo from a catalog word is mapped to it", () => {
    expect(suggestCorrection("bilinugual", vocabulary)).toBe("bilingual");
    expect(suggestCorrection("epilepsyy", vocabulary)).toBe("epilepsy");
    expect(suggestCorrection("sleeep", vocabulary)).toBe("sleep");
    expect(suggestCorrection("imagry", vocabulary)).toBe("imagery");
  });

  test("a word the catalog already uses is left alone", () => {
    expect(suggestCorrection("bilingual", vocabulary)).toBeNull();
  });

  test("a word with nothing near it is left alone, not forced onto the nearest word", () => {
    expect(suggestCorrection("zzqqxx", vocabulary)).toBeNull();
    expect(suggestCorrection("psilocybin", vocabulary)).toBeNull();
  });

  test("short words and anything with a digit are never corrected: acronyms and ERP components", () => {
    // 'slep' is one edit from 'sleep', and 'sleep2' is too; neither is touched.
    expect("slep".length).toBeLessThan(MIN_CORRECTABLE_LENGTH);
    expect(suggestCorrection("slep", vocabulary)).toBeNull();
    expect(suggestCorrection("sleep2", vocabulary)).toBeNull();
    expect(suggestCorrection("n4000", vocabulary)).toBeNull();
  });

  test("the first letter is never changed", () => {
    // One edit from 'bilingual', but a different first letter.
    expect(suggestCorrection("xilingual", vocabulary)).toBeNull();
    expect(suggestCorrection("bilinugual", vocabulary)).toBe("bilingual");
  });

  test("of two equally near words the more widely used one wins, whatever the order", () => {
    // 'abcde' sorts first alphabetically, 'abcdf' is used by more datasets: they must disagree.
    const vocab = new Map([
      ["abcde", 1],
      ["abcdf", 9],
    ]);
    const reversed = new Map([...vocab].reverse());
    expect(suggestCorrection("abcdg", vocab)).toBe("abcdf");
    expect(suggestCorrection("abcdg", reversed)).toBe("abcdf");
  });

  test("of two equally near, equally used words the alphabetically first wins, whatever the order", () => {
    const vocab = new Map([
      ["abcdf", 3],
      ["abcde", 3],
    ]);
    expect(suggestCorrection("abcdg", vocab)).toBe("abcde");
    expect(suggestCorrection("abcdg", new Map([...vocab].reverse()))).toBe("abcde");
  });

  test("a long word may be two typos away; a shorter one may not", () => {
    const vocab = new Map([["electroencephalography", 3]]);
    expect(suggestCorrection("electroencephalograpy", vocab)).toBe("electroencephalography");
    expect(suggestCorrection("electroencepalograpy", vocab)).toBe("electroencephalography");
    expect(suggestCorrection("meditaiton", new Map([["meditation", 3]]))).toBe("meditation");
    expect(suggestCorrection("medetaton", new Map([["meditation", 3]]))).toBeNull();
  });
});

describe("analyzeQuery corrects what the catalog has never seen", () => {
  test("'bilinugual performance study' is searched as 'bilingual performance study'", async () => {
    const { d1 } = sampleDb();
    const a = await analyzeQuery(d1, "bilinugual performance study");
    expect(a.correctedQuery).toBe("bilingual performance study");
    expect(a.semanticQuery).toBe("bilingual performance study");
    expect(a.informative).toEqual(["bilingual", "performance"]);
    expect(a.rerankQuery).toBe("bilingual performance");
  });

  test("the corrected word's frequency, not the typo's, decides whether it is generic", async () => {
    const { d1 } = sampleDb();
    // "studdy" is nothing; "study" is in about half the catalog and so is dropped as generic.
    const a = await analyzeQuery(d1, "bilingual performance studdy");
    expect(a.content).toEqual(["bilingual", "performance", "study"]);
    expect(a.informative).toEqual(["bilingual", "performance"]);
  });

  test("a real word the catalog uses is not mistaken for a typo of a nearby one", async () => {
    const { d1 } = sampleDb();
    // 'simulation' is one edit from the far more common 'stimulation'.
    const a = await analyzeQuery(d1, "driving simulation and fatigue");
    expect(a.correctedQuery).toBeUndefined();
    expect(a.content).toEqual(["driving", "simulation", "fatigue"]);
  });

  test("a query that needed no correction says nothing about one", async () => {
    const { d1 } = sampleDb();
    const a = await analyzeQuery(d1, "bilingual performance study");
    expect(a.correctedQuery).toBeUndefined();
    expect(a.semanticQuery).toBe("bilingual performance study");
  });

  test("a partly typed word that still matches by prefix is not 'corrected'", async () => {
    const { d1 } = sampleDb();
    const a = await analyzeQuery(d1, "motor imager");
    expect(a.correctedQuery).toBeUndefined();
    expect(a.content).toEqual(["motor", "imager"]);
  });

  test("a word the catalog lacks and has nothing near is searched as typed", async () => {
    const { d1 } = sampleDb();
    const a = await analyzeQuery(d1, "sleep zzqqxx");
    expect(a.correctedQuery).toBeUndefined();
    expect(a.content).toEqual(["sleep", "zzqqxx"]);
  });

  test("a one-word typo is corrected too", async () => {
    const { d1 } = sampleDb();
    const a = await analyzeQuery(d1, "sleeep");
    expect(a.correctedQuery).toBe("sleep");
    expect(a.isPhrase).toBe(false);
  });
});

describe("executeDatasetSearch reports the correction and returns the corrected answer", () => {
  test("the typo query finds what the correct spelling finds, and says what it searched for", async () => {
    const { d1 } = sampleDb();
    const run = async (query: string) => {
      const models = recordedModels();
      return executeDatasetSearch(d1, models.ai, models.vectorize, {
        query,
        filters: {},
        limit: 20,
        offset: 0,
        minScore: 0.6,
      });
    };
    const typo = await run("bilinugual performance study");
    const clean = await run("bilingual performance study");
    expect(typo.corrected_query).toBe("bilingual performance study");
    expect(clean.corrected_query).toBeUndefined();
    expect(typo.results.map((r) => r.id)).toEqual(clean.results.map((r) => r.id));
    expect(typo.results.map((r) => r.id)).toContain("nm000241");
  });

  test("the lexical-only path reports it too", async () => {
    const { d1 } = sampleDb();
    const envelope = await executeDatasetSearch(d1, undefined, undefined, {
      query: "sleeep",
      filters: {},
      limit: 20,
      offset: 0,
      minScore: 0.6,
    });
    expect(envelope.method).toBe("text");
    expect(envelope.corrected_query).toBe("sleep");
    expect(envelope.count).toBeGreaterThan(5);
  });
});

describe("the vocabulary", () => {
  test("is built from names, abstracts and tasks, counting each dataset once per word", () => {
    const vocabulary = buildVocabulary([
      { name: "Sleep sleep sleep", description: "about Sleep", tasks: "rest" },
      { name: "Other", description: "sleep again", tasks: null },
    ]);
    expect(vocabulary.get("sleep")).toBe(2);
    expect(vocabulary.get("rest")).toBe(1);
    // Under four letters is not vocabulary.
    expect(vocabulary.has("about")).toBe(true);
    expect(vocabulary.has("eeg")).toBe(false);
  });

  test("is reused within its lifetime and rebuilt after it", async () => {
    const { d1 } = sampleDb();
    const t0 = 1_000_000;
    const first = loadVocabulary(d1, t0);
    expect(loadVocabulary(d1, t0 + VOCABULARY_TTL_MS - 1)).toBe(first);
    expect(loadVocabulary(d1, t0 + VOCABULARY_TTL_MS)).not.toBe(first);
  });

  test("a failed build is not remembered", async () => {
    const broken = freshDb();
    broken.exec("DROP TABLE datasets");
    await expect(loadVocabulary(realD1(broken), 5)).rejects.toThrow();
    const { d1 } = sampleDb();
    const vocabulary = await loadVocabulary(d1, 6);
    expect(vocabulary.get("bilingual")).toBeGreaterThan(0);
  });

  test("a failing vocabulary build leaves the search working, uncorrected", async () => {
    const { db } = sampleDb();
    // Same catalog, but the vocabulary query cannot run: no `datasets` columns it reads.
    const real = realD1(db);
    const failing = {
      prepare(sql: string) {
        if (sql.includes("SELECT d.name, d.description, d.tasks"))
          throw new Error("D1 unavailable");
        return real.prepare(sql);
      },
    } as unknown as D1Database;
    const a = await analyzeQuery(failing, "bilinugual performance study");
    expect(a.correctedQuery).toBeUndefined();
    expect(a.content).toEqual(["bilinugual", "performance", "study"]);
  });
});

describe("the MCP search_datasets tool says what it searched for", () => {
  test("a caller that cannot see the typo is told which words were used instead", async () => {
    const { d1 } = sampleDb();
    const models = recordedModels();
    const outcome = await searchDatasetsTool(
      { DB: d1, AI: models.ai, VECTORIZE: models.vectorize },
      { query: "bilinugual performance study", limit: 10 } as Parameters<
        typeof searchDatasetsTool
      >[1],
    );
    const output = (
      outcome as {
        result: {
          structuredContent: {
            results: Array<{ dataset_id: string }>;
            count: number;
            note?: string;
          };
        };
      }
    ).result.structuredContent;
    expect(output.results.map((r) => r.dataset_id)).toContain("nm000241");
    expect(output.count).toBeLessThanOrEqual(5);
    expect(output.note).toContain('searched for "bilingual performance study" instead');
  });
});
