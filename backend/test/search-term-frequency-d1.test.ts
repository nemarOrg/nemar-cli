/**
 * `termFrequencies` on Miniflare D1, the implementation `wrangler --local` runs.
 *
 * Every other search test runs on bun:sqlite, which accepts any number of SELECTs joined by
 * UNION ALL. D1 refuses more than five ("too many terms in compound SELECT"), so a phrase of
 * five or more distinct words made the frequency query fail, `tryTermFrequencies` fell back to
 * "every word is informative", and the phrases the feature exists for lost generic-word
 * dropping and typo correction without any error reaching a caller. This file runs the real
 * function against the real schema with the largest word list the analyzer can pass.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Miniflare } from "miniflare";
import { MAX_QUERY_TERMS, termFrequencies } from "../src/services/search-query";
import { applyMigrations, migrationFiles } from "./helpers/miniflare-d1";

let mf: Miniflare;
let counter = 0;

const ROWS = [
  {
    id: "nm000501",
    name: "Sleep staging with EEG",
    description: "overnight sleep recordings",
    vis: "public",
  },
  {
    id: "nm000502",
    name: "Motor imagery",
    description: "brain computer interface study",
    vis: "public",
  },
  {
    id: "nm000503",
    name: "Bilingual naming",
    description: "a study of bilingual speakers",
    vis: "public",
  },
  {
    id: "nm000504",
    name: "Sleep and memory",
    description: "sleep study in a private cohort",
    vis: "private",
  },
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
  test("a phrase of more than five distinct words is counted in one statement", async () => {
    const d1 = await seededD1();
    const words = ["sleep", "staging", "motor", "imagery", "bilingual", "study", "overnight"];
    expect(words.length).toBeGreaterThan(5);
    const { corpusSize, ratios } = await termFrequencies(d1, words);
    expect(corpusSize).toBe(3);
    expect(ratios.get("sleep")).toBeCloseTo(1 / 3, 10);
    expect(ratios.get("staging")).toBeCloseTo(1 / 3, 10);
    expect(ratios.get("motor")).toBeCloseTo(1 / 3, 10);
    expect(ratios.get("bilingual")).toBeCloseTo(1 / 3, 10);
    expect(ratios.get("study")).toBeCloseTo(2 / 3, 10);
    expect(ratios.get("overnight")).toBeCloseTo(1 / 3, 10);
  });

  test("the largest word list the analyzer passes is counted too", async () => {
    const d1 = await seededD1();
    const words = Array.from({ length: MAX_QUERY_TERMS }, (_, i) =>
      i === 0 ? "sleep" : `absent${i}`,
    );
    const { corpusSize, ratios } = await termFrequencies(d1, words);
    expect(corpusSize).toBe(3);
    expect(ratios.size).toBe(MAX_QUERY_TERMS);
    expect(ratios.get("sleep")).toBeCloseTo(1 / 3, 10);
    expect(ratios.get("absent7")).toBe(0);
  });

  test("a private dataset is not part of the population", async () => {
    const d1 = await seededD1();
    const { ratios } = await termFrequencies(d1, ["sleep"]);
    expect(ratios.get("sleep")).toBeCloseTo(1 / 3, 10);
  });

  test("a repeated word is one word", async () => {
    const d1 = await seededD1();
    const { ratios } = await termFrequencies(d1, ["sleep", "sleep"]);
    expect(ratios.size).toBe(1);
  });
});
