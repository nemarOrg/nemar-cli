/**
 * `termFrequencies` on Miniflare D1, the implementation `wrangler --local` runs.
 *
 * Every other search test runs on bun:sqlite, which accepts any number of SELECTs joined by
 * UNION ALL. D1 refuses more than five ("too many terms in compound SELECT"), so a phrase of
 * five or more distinct words made the frequency query fail, `tryTermFrequencies` fell back to
 * "every word is informative", and the phrases the feature exists for lost generic-word
 * dropping and typo correction without any error reaching a caller. This file runs the real
 * function against the real schema with the largest word list the analyzer can pass.
 *
 * The words are invented so no prefix of one is another, and their counts differ from word to
 * word (0, 1, 2, 3 and 4 of four public datasets), so a column read at the wrong index shows.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Miniflare } from "miniflare";
import { MAX_QUERY_TERMS, termFrequencies } from "../src/services/search-query";
import { applyMigrations, migrationFiles } from "./helpers/miniflare-d1";

let mf: Miniflare;
let counter = 0;

// zorbal is in three public datasets, quillon in two, tavrix in one, nupwick in none; notes is in
// all four, other in two, plain in one. The private dataset holds zorbal, quillon and tavrix too
// and is not part of the population.
const ROWS = [
  { id: "nm000501", name: "Zorbal quillon tavrix", description: "notes", vis: "public" },
  { id: "nm000502", name: "Zorbal quillon", description: "notes other", vis: "public" },
  { id: "nm000503", name: "Zorbal", description: "notes", vis: "public" },
  { id: "nm000504", name: "Plain", description: "notes other", vis: "public" },
  { id: "nm000505", name: "Zorbal quillon tavrix", description: "notes", vis: "private" },
];

async function seededD1(): Promise<D1Database> {
  counter += 1;
  const d1 = (await mf.getD1Database(`DB${counter}`)) as unknown as D1Database;
  await applyMigrations(d1, migrationFiles());
  for (const r of ROWS) {
    await d1
      .prepare(
        `INSERT INTO datasets (dataset_id, name, description, owner_user_id, status, visibility, is_sandbox)
         VALUES (?, ?, ?, -1, 'active', ?, 0)`,
      )
      .bind(r.id, r.name, r.description, r.vis)
      .run();
  }
  return d1;
}

beforeAll(() => {
  mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    d1Databases: Object.fromEntries(
      Array.from({ length: 8 }, (_, i) => [`DB${i + 1}`, `search-tf-${i + 1}`]),
    ),
  });
});

afterAll(async () => {
  await mf.dispose();
});

describe("termFrequencies on D1", () => {
  test("a phrase of more than five distinct words is counted in one statement, each at its own count", async () => {
    const d1 = await seededD1();
    const words = ["nupwick", "tavrix", "quillon", "zorbal", "notes", "plain", "other"];
    expect(words.length).toBeGreaterThan(5);
    const { corpusSize, ratios } = await termFrequencies(d1, words);
    expect(corpusSize).toBe(4);
    expect(Object.fromEntries(ratios)).toEqual({
      nupwick: 0,
      tavrix: 1 / 4,
      quillon: 2 / 4,
      zorbal: 3 / 4,
      notes: 4 / 4,
      plain: 1 / 4,
      other: 2 / 4,
    });
  });

  test("the order of the words does not move a count", async () => {
    const d1 = await seededD1();
    const { ratios } = await termFrequencies(d1, ["other", "zorbal", "plain", "nupwick", "notes"]);
    expect(Object.fromEntries(ratios)).toEqual({
      other: 2 / 4,
      zorbal: 3 / 4,
      plain: 1 / 4,
      nupwick: 0,
      notes: 4 / 4,
    });
  });

  test("the largest word list the analyzer passes is counted too", async () => {
    const d1 = await seededD1();
    const words = Array.from({ length: MAX_QUERY_TERMS }, (_, i) =>
      i === 0 ? "zorbal" : `absent${i}`,
    );
    const { corpusSize, ratios } = await termFrequencies(d1, words);
    expect(corpusSize).toBe(4);
    expect(ratios.size).toBe(MAX_QUERY_TERMS);
    expect(ratios.get("zorbal")).toBeCloseTo(3 / 4, 10);
    expect(ratios.get("absent7")).toBe(0);
  });

  test("a private dataset is not part of the population", async () => {
    const d1 = await seededD1();
    const { corpusSize, ratios } = await termFrequencies(d1, ["zorbal", "tavrix"]);
    expect(corpusSize).toBe(4);
    expect(ratios.get("zorbal")).toBeCloseTo(3 / 4, 10);
    expect(ratios.get("tavrix")).toBeCloseTo(1 / 4, 10);
  });

  test("no words is the corpus alone", async () => {
    const d1 = await seededD1();
    const { corpusSize, ratios } = await termFrequencies(d1, []);
    expect(corpusSize).toBe(4);
    expect(ratios.size).toBe(0);
  });

  test("a repeated word is one word", async () => {
    const d1 = await seededD1();
    const { ratios } = await termFrequencies(d1, ["zorbal", "zorbal"]);
    expect(ratios.size).toBe(1);
  });
});
