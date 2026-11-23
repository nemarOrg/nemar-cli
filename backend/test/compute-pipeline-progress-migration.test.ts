/**
 * Migration 0150_compute_pipeline_progress.sql (ADR 0134, epic #2324 phase 2), on two engines: bun:sqlite
 * and Miniflare's D1. bun:sqlite is more permissive than the SQLite D1 ships, so a CHECK proven only on
 * the first is not proven.
 *
 * What is pinned: every CHECK refuses its violating row by name and accepts its valid one; a run row has
 * an outcome exactly when it is reconciled; one run per job; a progress row never counts past its total
 * and a reconciled one sums to it; live counts are whole or absent; a document's namespace is one of the
 * two; the primary keys hold; no column is named for a person; no foreign key; every GLOB is within D1's
 * 50 characters.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Engine, startEngines } from "./helpers/compute-engines";
import { MIGRATIONS_DIR } from "./helpers/miniflare-d1";

const FILE = "0150_compute_pipeline_progress.sql";
const SQL = readFileSync(join(MIGRATIONS_DIR, FILE), "utf-8");

type Row = Record<string, unknown>;

let seq = 1000;
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
const UNIQUE = /UNIQUE constraint failed/;
const NOW = "2026-11-23 12:00:00";

const run = (over: Row = {}): Row => ({ stamp_id: next(), job_id: jobId(), ...over });
const progress = (over: Row = {}): Row => ({
  stamp_id: next(),
  checkpoint: "import",
  passed: 1,
  failed: 0,
  skipped: 0,
  total: 3,
  reported_at: NOW,
  ...over,
});
const doc = (over: Row = {}): Row => ({
  dataset_id: `nm${String(next()).padStart(6, "0")}`,
  namespace: "processing",
  recipe: "nemar-floor",
  stamp_id: next(),
  entry: '{"recipe_version":"1.0.0"}',
  ...over,
});

describe("the file", () => {
  test("no GLOB pattern is longer than D1 takes (50 characters)", () => {
    const patterns = [...SQL.matchAll(/GLOB\s+'([^']*)'/g)].map((m) => m[1] as string);
    expect(patterns.length).toBeGreaterThan(5);
    for (const p of patterns) expect([p, p.length <= 50]).toEqual([p, true]);
  });

  test("no foreign key, nothing cascades, no person column", () => {
    expect(SQL).not.toMatch(/REFERENCES/i);
    expect(SQL).not.toMatch(/ON DELETE/i);
    expect(SQL).not.toMatch(/\b(user_id|username|email|owner)\b\s+(TEXT|INTEGER)/i);
  });
});

describe("compute_pipeline_progress_runs", () => {
  onEveryEngine("a stamp and a job alone make a valid row, with the defaults", async (e) => {
    const row = run();
    expect(await insert(e, "compute_pipeline_progress_runs", row)).toBeNull();
    const [got] = await e.all<Row>(
      "SELECT * FROM compute_pipeline_progress_runs WHERE stamp_id = ?",
      row.stamp_id,
    );
    expect(got).toMatchObject({ reports: 0, disagreement: 0, reconciled_at: null, outcome: null });
  });

  onEveryEngine("each CHECK refuses its bad value by name", async (e) => {
    const cases: [string, Row][] = [
      ["compute_pipeline_progress_runs_stamp", { stamp_id: 0 }],
      ["compute_pipeline_progress_runs_job", { job_id: "job_xyz" }],
      ["compute_pipeline_progress_runs_checkpoint", { checkpoint: "Import" }],
      ["compute_pipeline_progress_runs_checkpoint", { checkpoint: "9a" }],
      ["compute_pipeline_progress_runs_write", { write_id: "A".repeat(32) }],
      ["compute_pipeline_progress_runs_reported", { reported_at: "2026-11-23" }],
      ["compute_pipeline_progress_runs_reports", { reports: -1 }],
      ["compute_pipeline_progress_runs_reports", { reports: 1.5 }],
      ["compute_pipeline_progress_runs_outcome", { outcome: "done", reconciled_at: NOW }],
      ["compute_pipeline_progress_runs_disagreement", { disagreement: 2 }],
      ["compute_pipeline_progress_runs_outcome_iff", { outcome: "reconciled" }],
      ["compute_pipeline_progress_runs_outcome_iff", { reconciled_at: NOW }],
    ];
    for (const [name, over] of cases) {
      expect(await insert(e, "compute_pipeline_progress_runs", run(over)), name).toMatch(
        NAMED(name),
      );
    }
  });

  onEveryEngine("valid values pass, and one run per job", async (e) => {
    expect(
      await insert(
        e,
        "compute_pipeline_progress_runs",
        run({
          checkpoint: "preprocess",
          write_id: "a".repeat(32),
          reported_at: NOW,
          reports: 3,
          reconciled_at: NOW,
          outcome: "table_missing",
          disagreement: 1,
        }),
      ),
    ).toBeNull();
    const job = jobId();
    expect(await insert(e, "compute_pipeline_progress_runs", run({ job_id: job }))).toBeNull();
    expect(await insert(e, "compute_pipeline_progress_runs", run({ job_id: job }))).toMatch(UNIQUE);
  });
});

describe("compute_pipeline_progress", () => {
  onEveryEngine("a live row is valid with the default failure list", async (e) => {
    const row = progress();
    expect(await insert(e, "compute_pipeline_progress", row)).toBeNull();
    const [got] = await e.all<Row>(
      "SELECT failures, reconciled, disagreement FROM compute_pipeline_progress WHERE stamp_id = ?",
      row.stamp_id,
    );
    expect(got).toEqual({ failures: "[]", reconciled: 0, disagreement: 0 });
  });

  onEveryEngine("each CHECK refuses its bad value by name", async (e) => {
    const cases: [string, Row][] = [
      ["compute_pipeline_progress_stamp", { stamp_id: -1 }],
      ["compute_pipeline_progress_checkpoint", { checkpoint: "bad-name" }],
      ["compute_pipeline_progress_passed", { passed: 1_000_001, total: 1_000_000 }],
      ["compute_pipeline_progress_failed", { failed: -1 }],
      ["compute_pipeline_progress_skipped", { skipped: 0.5 }],
      ["compute_pipeline_progress_total", { total: 1_000_001 }],
      ["compute_pipeline_progress_failures", { failures: "{}" }],
      ["compute_pipeline_progress_failures", { failures: `[${"x".repeat(8192)}]` }],
      ["compute_pipeline_progress_reported", { reported_at: "now" }],
      [
        "compute_pipeline_progress_live_total",
        { live_passed: 0, live_failed: 0, live_skipped: 0, live_total: -1 },
      ],
      ["compute_pipeline_progress_reconciled", { reconciled: 2 }],
      ["compute_pipeline_progress_disagreement", { disagreement: -1 }],
      ["compute_pipeline_progress_within_total", { passed: 3, failed: 1, total: 3 }],
      ["compute_pipeline_progress_reconciled_sums", { reconciled: 1 }],
      ["compute_pipeline_progress_live_whole", { live_passed: 1 }],
    ];
    for (const [name, over] of cases) {
      expect(await insert(e, "compute_pipeline_progress", progress(over)), name).toMatch(
        NAMED(name),
      );
    }
  });

  onEveryEngine(
    "a reconciled row that sums passes, and the key is the stamp and the checkpoint",
    async (e) => {
      const stamp = next();
      expect(
        await insert(
          e,
          "compute_pipeline_progress",
          progress({
            stamp_id: stamp,
            passed: 2,
            failed: 1,
            skipped: 0,
            total: 3,
            reconciled: 1,
            live_passed: 1,
            live_failed: 0,
            live_skipped: 0,
            live_total: 3,
          }),
        ),
      ).toBeNull();
      expect(await insert(e, "compute_pipeline_progress", progress({ stamp_id: stamp }))).toMatch(
        UNIQUE,
      );
      expect(
        await insert(
          e,
          "compute_pipeline_progress",
          progress({ stamp_id: stamp, checkpoint: "stored" }),
        ),
      ).toBeNull();
    },
  );
});

describe("compute_pipeline_documents", () => {
  onEveryEngine("a valid row has final 0 by default", async (e) => {
    const row = doc();
    expect(await insert(e, "compute_pipeline_documents", row)).toBeNull();
    const [got] = await e.all<Row>(
      "SELECT final FROM compute_pipeline_documents WHERE dataset_id = ?",
      row.dataset_id,
    );
    expect(got).toEqual({ final: 0 });
  });

  onEveryEngine("each CHECK refuses its bad value by name", async (e) => {
    const cases: [string, Row][] = [
      ["compute_pipeline_documents_dataset", { dataset_id: "NM000001" }],
      ["compute_pipeline_documents_namespace", { namespace: "dataQuality" }],
      ["compute_pipeline_documents_recipe", { recipe: "Nemar_Floor" }],
      ["compute_pipeline_documents_stamp", { stamp_id: 0 }],
      ["compute_pipeline_documents_entry", { entry: "[]" }],
      ["compute_pipeline_documents_entry", { entry: `{${"x".repeat(65536)}}` }],
      ["compute_pipeline_documents_final", { final: 2 }],
    ];
    for (const [name, over] of cases) {
      expect(await insert(e, "compute_pipeline_documents", doc(over)), name).toMatch(NAMED(name));
    }
  });

  onEveryEngine("one entry per dataset, namespace and recipe", async (e) => {
    const row = doc();
    expect(await insert(e, "compute_pipeline_documents", row)).toBeNull();
    expect(await insert(e, "compute_pipeline_documents", { ...row, stamp_id: next() })).toMatch(
      UNIQUE,
    );
    expect(
      await insert(e, "compute_pipeline_documents", { ...row, namespace: "signalJourney" }),
    ).toBeNull();
    expect(
      await insert(e, "compute_pipeline_documents", { ...row, recipe: "nemar-ica" }),
    ).toBeNull();
  });
});
