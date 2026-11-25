/**
 * Migration 0151_compute_quality_documents.sql (ADR 0137 decision 8, epic #2324 phase B1), on two engines:
 * bun:sqlite and Miniflare's D1. bun:sqlite is more permissive than the SQLite D1 ships, so a CHECK proven
 * only on the first is not proven.
 *
 * What is pinned: every CHECK refuses its violating row by name and accepts its valid one; a stamp has
 * one summary; an entry is an object of at most 65,536 characters; the dataset index is there; no column
 * is named for a person; no foreign key; every GLOB is within D1's 50 characters.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Engine, startEngines } from "./helpers/compute-engines";
import { MIGRATIONS_DIR } from "./helpers/miniflare-d1";

const FILE = "0151_compute_quality_documents.sql";
const SQL = readFileSync(join(MIGRATIONS_DIR, FILE), "utf-8");

type Row = Record<string, unknown>;

let seq = 2000;
const next = () => ++seq;

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

async function insert(e: Engine, row: Row): Promise<string | null> {
  const cols = Object.keys(row);
  return e.run(
    `INSERT INTO compute_quality_documents (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
    ...cols.map((c) => row[c]),
  );
}

const NAMED = (name: string) => new RegExp(`CHECK constraint failed: ${name}\\b`);
const UNIQUE = /UNIQUE constraint failed/;

const doc = (over: Row = {}): Row => ({
  stamp_id: next(),
  dataset_id: `nm${String(next()).padStart(6, "0")}`,
  recipe: "nemar-ica",
  entry: '{"recipe_version":"1.0.0-b2"}',
  record_sha256: "a".repeat(64),
  ...over,
});

describe("the file", () => {
  test("no GLOB pattern is longer than D1 takes (50 characters)", () => {
    const patterns = [...SQL.matchAll(/GLOB\s+'([^']*)'/g)].map((m) => m[1] as string);
    expect(patterns.length).toBeGreaterThan(3);
    for (const p of patterns) expect([p, p.length <= 50]).toEqual([p, true]);
  });

  test("no foreign key, nothing cascades, no person column", () => {
    expect(SQL).not.toMatch(/REFERENCES/i);
    expect(SQL).not.toMatch(/ON DELETE/i);
    expect(SQL).not.toMatch(/\b(user_id|username|email|owner)\b\s+(TEXT|INTEGER)/i);
  });
});

describe("compute_quality_documents", () => {
  onEveryEngine("a valid row has a write time", async (e) => {
    const row = doc();
    expect(await insert(e, row)).toBeNull();
    const [got] = await e.all<Row>(
      "SELECT * FROM compute_quality_documents WHERE stamp_id = ?",
      row.stamp_id,
    );
    expect(typeof got?.written_at).toBe("string");
    expect(got).toMatchObject({ dataset_id: row.dataset_id, recipe: "nemar-ica" });
  });

  onEveryEngine("each CHECK refuses its bad value by name", async (e) => {
    const cases: [string, Row][] = [
      ["compute_quality_documents_stamp", { stamp_id: 0 }],
      ["compute_quality_documents_stamp", { stamp_id: -3 }],
      ["compute_quality_documents_dataset", { dataset_id: "NM000001" }],
      ["compute_quality_documents_dataset", { dataset_id: "nm00001" }],
      ["compute_quality_documents_dataset", { dataset_id: "nm00000a" }],
      ["compute_quality_documents_recipe", { recipe: "Nemar_Ica" }],
      ["compute_quality_documents_recipe", { recipe: "" }],
      ["compute_quality_documents_entry", { entry: "[]" }],
      ["compute_quality_documents_entry", { entry: "{" }],
      ["compute_quality_documents_entry", { entry: `{${"x".repeat(65535)}}` }],
      ["compute_quality_documents_record", { record_sha256: "A".repeat(64) }],
      ["compute_quality_documents_record", { record_sha256: "a".repeat(63) }],
    ];
    for (const [name, over] of cases) {
      expect(await insert(e, doc(over)), name).toMatch(NAMED(name));
    }
    // The longest entry the column takes.
    expect(await insert(e, doc({ entry: `{${"x".repeat(65534)}}` }))).toBeNull();
  });

  onEveryEngine("one summary per stamp", async (e) => {
    const row = doc();
    expect(await insert(e, row)).toBeNull();
    expect(await insert(e, { ...row, dataset_id: "nm009999" })).toMatch(UNIQUE);
  });

  onEveryEngine("the dataset index is there", async (e) => {
    const rows = await e.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'compute_quality_documents'",
    );
    expect(rows.map((r) => r.name)).toContain("compute_quality_documents_dataset");
  });
});
