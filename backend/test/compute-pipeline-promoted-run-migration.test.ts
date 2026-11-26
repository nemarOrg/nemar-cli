/**
 * Migration 0154_compute_pipeline_promoted_run.sql (ADR 0134 decision 9 as amended 2026-11-26, epic #2324
 * phase B4), on two engines: bun:sqlite and Miniflare's D1, each carrying every migration; and its
 * backfill on a bun:sqlite database migrated to 0153 and holding the rows 0150 kept.
 *
 * What is pinned: a run row's `link` is a JSON object of a bounded length or nothing, and a derivative's
 * `checkpoint_map` a JSON array of a bounded length or nothing, each CHECK refusing by name;
 * `compute_pipeline_documents` is gone; the backfill copies a run's completed link from the last document
 * that holds it, and never a failed link, one longer than the column takes, nor one of a stamp with no run
 * row.
 */

import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { type Engine, startEngines } from "./helpers/compute-engines";
import { MIGRATIONS_DIR } from "./helpers/miniflare-d1";

const FILE = "0154_compute_pipeline_promoted_run.sql";
const SQL = readFileSync(join(MIGRATIONS_DIR, FILE), "utf-8");

type Row = Record<string, unknown>;

let seq = 5000;
const next = () => ++seq;
const jobId = () => `job_${next().toString(16).padStart(24, "0")}`;

const ENGINES: Engine[] = [];
let dispose: () => Promise<void>;

beforeAll(async () => {
  const started = await startEngines();
  ENGINES.push(...started.engines);
  dispose = started.dispose;
}, 60_000);

afterAll(async () => {
  await dispose?.();
}, 30_000);

function onEveryEngine(name: string, body: (e: Engine) => Promise<void>) {
  test(name, async () => {
    expect(ENGINES).toHaveLength(2);
    for (const e of ENGINES) {
      try {
        await body(e);
      } catch (err) {
        throw new Error(`${e.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  });
}

async function insert(e: Engine, table: string, row: Row): Promise<string | null> {
  const cols = Object.keys(row);
  return e.run(
    `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
    ...cols.map((c) => row[c]),
  );
}

const NAMED = (name: string) => new RegExp(`CHECK constraint failed: ${name}\\b`);

const LINK = JSON.stringify({
  recipe_version: "1.0.0",
  processing_status: "completed",
  location: "desc-nemarfloor_signalJourney.json",
  sha256: "a".repeat(64),
  sj_version: "0.1.0",
});

const runRow = (over: Row = {}): Row => ({ stamp_id: next(), job_id: jobId(), ...over });

/** A derivative row the table accepts, with the checkpoint map given. */
const derivativeRow = (over: Row = {}): Row => ({
  key: next().toString(16).padStart(64, "0"),
  dataset_id: "nm000104",
  version: "v1.0.0",
  recipe: "nemar-floor",
  recipe_version: "1.0.0",
  engine: "eegprep@0.5.0",
  input: "bids",
  profile: "archive",
  input_digest: `git:${"a".repeat(40)}`,
  image_digest: `sha256:${"b".repeat(64)}`,
  job_id: jobId(),
  stamp_id: next(),
  object_count: 2,
  bytes: 100,
  ...over,
});

describe("the file", () => {
  test("no foreign key, nothing cascades, no person column", () => {
    expect(SQL).not.toMatch(/REFERENCES/i);
    expect(SQL).not.toMatch(/ON DELETE/i);
    expect(SQL).not.toMatch(/\b(user_id|username|email|owner)\b\s+(TEXT|INTEGER)/i);
  });
});

describe("compute_pipeline_progress_runs.link", () => {
  onEveryEngine("a link is a JSON object or nothing, refused otherwise by name", async (e) => {
    expect(await insert(e, "compute_pipeline_progress_runs", runRow())).toBeNull();
    expect(await insert(e, "compute_pipeline_progress_runs", runRow({ link: LINK }))).toBeNull();
    for (const link of ["[1]", "{not json", "1", `{"x":"${"y".repeat(2048)}"}`]) {
      expect(
        await insert(e, "compute_pipeline_progress_runs", runRow({ link })),
        link.slice(0, 20),
      ).toMatch(NAMED("compute_pipeline_progress_runs_link"));
    }
  });
});

describe("compute_derivatives.checkpoint_map", () => {
  onEveryEngine("a map is a JSON array or nothing, refused otherwise by name", async (e) => {
    const map = JSON.stringify([{ checkpoint: "import", steps: ["load"] }]);
    expect(await insert(e, "compute_derivatives", derivativeRow())).toBeNull();
    expect(
      await insert(e, "compute_derivatives", derivativeRow({ checkpoint_map: map })),
    ).toBeNull();
    for (const bad of ["{}", "[", "", `[${'"x",'.repeat(2048)}"x"]`]) {
      expect(
        await insert(e, "compute_derivatives", derivativeRow({ checkpoint_map: bad })),
        bad.slice(0, 20),
      ).toMatch(NAMED("compute_derivatives_checkpoint_map"));
    }
  });
});

describe("compute_pipeline_documents", () => {
  onEveryEngine("is gone", async (e) => {
    const tables = await e.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'compute_pipeline_documents'",
    );
    expect(tables).toEqual([]);
  });
});

describe("the backfill", () => {
  test("copies a run's completed link from the last document, never a failed one, a long one, nor one with no run row (MUTATION: drop the status term; drop the length term)", () => {
    const db = new Database(":memory:");
    for (const file of readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql") && f < FILE)
      .sort()) {
      db.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf-8"));
    }
    const failed = JSON.stringify({
      recipe_version: "1.0.0",
      processing_status: "failed",
      location: null,
      sha256: null,
      sj_version: null,
    });
    const doc = db.prepare(
      "INSERT INTO compute_pipeline_documents (dataset_id, namespace, recipe, stamp_id, entry) VALUES (?, ?, ?, ?, ?)",
    );
    const run = db.prepare(
      "INSERT INTO compute_pipeline_progress_runs (stamp_id, job_id) VALUES (?, ?)",
    );
    // Stamp 11: the last completed link of nemar-floor, with a run row. Stamp 12: a failed link. Stamp 13: a
    // completed link whose run row is gone. Stamp 14: a run row with no document. Stamp 15: a completed link
    // longer than the column takes (0150 took 65,536 characters), which is left out rather than failing the
    // migration on the column's CHECK.
    const long = JSON.stringify({ ...JSON.parse(LINK), note: "x".repeat(2100) });
    doc.run("nm000104", "signalJourney", "nemar-floor", 11, LINK);
    doc.run("nm000104", "processing", "nemar-floor", 11, '{"recipe_version":"1.0.0"}');
    doc.run("nm000104", "signalJourney", "nemar-ica", 12, failed);
    doc.run("nm000105", "signalJourney", "nemar-floor", 13, LINK);
    doc.run("nm000106", "signalJourney", "nemar-floor", 15, long);
    for (const stamp of [11, 12, 14, 15]) run.run(stamp, jobId());
    db.exec(SQL);
    const links = db
      .query("SELECT stamp_id, link FROM compute_pipeline_progress_runs ORDER BY stamp_id")
      .all() as { stamp_id: number; link: string | null }[];
    expect(links).toEqual([
      { stamp_id: 11, link: LINK },
      { stamp_id: 12, link: null },
      { stamp_id: 14, link: null },
      { stamp_id: 15, link: null },
    ]);
    expect(
      db
        .query(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'compute_pipeline_documents'",
        )
        .all(),
    ).toEqual([]);
    db.close();
  });
});
