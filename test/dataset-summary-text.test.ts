/**
 * The text a dataset is embedded and reranked as (dataset-summary-text.ts).
 *
 * The rows below are copied from the live public catalog (api.nemar.org), not
 * invented: the shapes that matter here (a README that opens with a DOI badge,
 * an abstract that is a one-line stub, enrichment keywords as `{ term }`
 * objects) are exactly what production feeds the builder. The SQL half is run
 * against the real schema, through `freshDb()` (every migration applied), so a
 * column rename or a `json_extract` mistake fails here.
 */

import { describe, expect, test } from "bun:test";
import {
  DATASET_SUMMARY_SELECT_SQL,
  SUMMARY_TEXT_MAX_CHARS,
  THIN_DESCRIPTION_CHARS,
  buildDatasetSummaryText,
  cleanReadmeForSummary,
  keywordTerms,
} from "../backend/src/services/dataset-summary-text";
import { freshDb } from "../backend/test/helpers/d1";

// nm000241, as served by GET /datasets/nm000241 on 2026-10-29.
const CEREBROVOICE = {
  name: "Zhang-2025-cerebrovoice: CerebroVoice: A Stereotactic EEG Dataset and Benchmark for Bilingual Brain-to-Speech Synthesis and Activity Detection",
  description:
    "CerebroVoice is a stereotactic EEG (sEEG) dataset recorded from two epilepsy patients during bilingual speech tasks, including Mandarin Chinese reading, English reading, and digit reading. It is distributed as preprocessed derivatives: low-frequency signal, high-gamma activity, and broadband signal. The dataset supports benchmarking of bilingual brain-to-speech synthesis and speech activity detection.",
  modalities: "ieeg",
  tasks:
    "chinesebbs,chinesehga,chineselfs,digitbbs,digithga,digitlfs,englishbbs,englishhga,englishlfs",
  readme: `[![DOI](https://img.shields.io/badge/DOI-10.82901%2Fnemar.nm000241-blue)](https://doi.org/10.82901/nemar.nm000241)

CerebroVoice: Bilingual sEEG Speech Dataset
=============================================

Overview
--------
Intracranial EEG (sEEG) recordings from 2 epilepsy patients during bilingual
speech tasks (Mandarin Chinese, English, and digit reading).`,
  enrichment_json: JSON.stringify({
    title: "x",
    keywords: [
      { term: "stereotactic EEG" },
      { term: "speech synthesis" },
      { term: "bilingual speech" },
      { term: "Epilepsy", subject_scheme: "MeSH", value_uri: "http://id.nlm.nih.gov/mesh/D004827" },
    ],
  }),
};

// nm000104: the abstract is a stub ("NEMAR Dataset nm000104: ..."), so the README has to carry the topic.
const EMG2QWERTY = {
  name: "emg2qwerty: A Large Dataset with Baselines for Touch Typing using Surface Electromyography",
  description: "NEMAR Dataset nm000104: emg2qwerty - EMG-based typing detection",
  modalities: "emg",
  tasks: "typing",
  readme: `[![DOI](https://img.shields.io/badge/DOI-10.82901%2Fnemar.nm000104-blue)](https://doi.org/10.82901/nemar.nm000104)

# emg2qwerty: Touch Typing from Surface Electromyography

## Overview

**Dataset**: emg2qwerty - Touch typing from wrist-based surface electromyography
**Task**: Touch typing on QWERTY keyboard`,
  enrichment_json: JSON.stringify({ keywords: [{ term: "Electromyography" }] }),
};

function insert(db: ReturnType<typeof freshDb>, id: string, row: typeof CEREBROVOICE) {
  db.run(
    `INSERT INTO datasets (dataset_id, name, description, modalities, tasks, readme, enrichment_json,
                           owner_user_id, status, visibility, is_sandbox)
     VALUES (?, ?, ?, ?, ?, ?, ?, -1, 'active', 'public', 0)`,
    [id, row.name, row.description, row.modalities, row.tasks, row.readme, row.enrichment_json],
  );
}

function summaryRowFor(db: ReturnType<typeof freshDb>, id: string) {
  return db
    .query(`SELECT ${DATASET_SUMMARY_SELECT_SQL} FROM datasets d WHERE d.dataset_id = ?`)
    .get(id) as Parameters<typeof buildDatasetSummaryText>[0];
}

describe("buildDatasetSummaryText, through the real SQL", () => {
  test("a dataset with a real abstract is its name, abstract, keywords, modalities and tasks", () => {
    const db = freshDb();
    insert(db, "nm000241", CEREBROVOICE);
    const text = buildDatasetSummaryText(summaryRowFor(db, "nm000241"));

    expect(text).toContain("bilingual speech tasks, including Mandarin Chinese reading");
    expect(text).toContain(
      "Keywords: stereotactic EEG, speech synthesis, bilingual speech, Epilepsy",
    );
    expect(text).toContain("Modalities: ieeg");
    expect(text).toContain("Tasks: chinesebbs,");
    // The abstract carries the topic, so no README is mixed in and no badge URL can leak.
    expect(text).not.toContain("shields.io");
    expect(text).not.toContain("=====");
    db.close();
  });

  test("a stub abstract is topped up with a cleaned README, never the badge or link markup", () => {
    const db = freshDb();
    insert(db, "nm000104", EMG2QWERTY);
    const row = summaryRowFor(db, "nm000104");
    // The SQL hands the README over only because the abstract is under the threshold.
    expect(EMG2QWERTY.description.length).toBeLessThan(THIN_DESCRIPTION_CHARS);
    expect(row.readme_head).toBeTruthy();

    const text = buildDatasetSummaryText(row);
    expect(text).toContain("Touch typing on QWERTY keyboard");
    expect(text).not.toContain("shields.io");
    expect(text).not.toContain("https://");
    expect(text).not.toContain("[![");
    db.close();
  });

  test("the SQL withholds the README when the abstract is long enough to stand on", () => {
    const db = freshDb();
    insert(db, "nm000241", CEREBROVOICE);
    expect(summaryRowFor(db, "nm000241").readme_head).toBeNull();
    db.close();
  });

  test("malformed enrichment JSON costs the keywords, not the statement", () => {
    const db = freshDb();
    insert(db, "nm000241", { ...CEREBROVOICE, enrichment_json: "{not json" });
    const row = summaryRowFor(db, "nm000241");
    expect(row.keywords_json).toBeNull();
    expect(buildDatasetSummaryText(row)).not.toContain("Keywords:");
    db.close();
  });
});

describe("keywordTerms", () => {
  test("reads { term } objects and bare strings, trims, drops duplicates (case-insensitive) and junk", () => {
    expect(
      keywordTerms(
        JSON.stringify([{ term: " EEG " }, "eeg", { term: "Sleep" }, 42, null, { nope: 1 }, ""]),
      ),
    ).toEqual(["EEG", "Sleep"]);
  });

  test("returns nothing for missing, malformed or non-array JSON", () => {
    expect(keywordTerms(null)).toEqual([]);
    expect(keywordTerms("{oops")).toEqual([]);
    expect(keywordTerms('{"term":"x"}')).toEqual([]);
  });

  test("keeps at most twelve", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ term: `k${i}` }));
    expect(keywordTerms(JSON.stringify(many))).toHaveLength(12);
  });
});

describe("cleanReadmeForSummary", () => {
  test("reduces badges, links, bare URLs, rules and heading markers to prose", () => {
    const out = cleanReadmeForSummary(CEREBROVOICE.readme);
    expect(out).toBe(
      "CerebroVoice: Bilingual sEEG Speech Dataset Overview Intracranial EEG (sEEG) recordings from 2 epilepsy patients during bilingual speech tasks (Mandarin Chinese, English, and digit reading).",
    );
  });

  test("keeps a link's label and drops its target", () => {
    expect(cleanReadmeForSummary("See [the paper](https://doi.org/10.1/x) now")).toBe(
      "See the paper now",
    );
  });
});

describe("buildDatasetSummaryText bounds", () => {
  test("is empty when every field is blank, so nothing is embedded", () => {
    expect(buildDatasetSummaryText({})).toBe("");
    expect(buildDatasetSummaryText({ name: "  ", description: "", tasks: null })).toBe("");
  });

  test("never exceeds the cap, however long the abstract", () => {
    const text = buildDatasetSummaryText({ name: "N", description: "word ".repeat(2000) });
    expect(text.length).toBe(SUMMARY_TEXT_MAX_CHARS);
    expect(text.startsWith("N\nword")).toBe(true);
  });
});
