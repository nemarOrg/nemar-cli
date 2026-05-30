/**
 * Phase 2 dual-write tests (#646 / #648).
 *
 * Exercises the real functions against a real in-memory SQLite engine via a
 * thin D1 adapter that FORWARDS every call to bun:sqlite (no canned responses,
 * no faked behavior — the SQL and data are real). This tests the actual
 * COALESCE-preserve UPDATE, the readme 8 KB truncation, and the embed-text
 * builder, rather than pinning source strings.
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeDatasetCatalogFields } from "../backend/src/services/dataset-metadata-columns";
import {
  buildDatasetEmbedText,
  buildDatasetVectorMetadata,
  reembedDatasetVector,
} from "../backend/src/services/dataset-search";

// Real-engine D1 shim: each method runs against the underlying bun:sqlite DB.
// Not a mock — there are no canned return values; every result comes from
// SQLite executing the real statement.
function realD1(db: Database): D1Database {
  return {
    prepare(sql: string) {
      const stmt = db.query(sql);
      let bound: unknown[] = [];
      const api = {
        bind(...p: unknown[]) {
          bound = p;
          return api;
        },
        run() {
          const r = stmt.run(...(bound as never[]));
          return Promise.resolve({ success: true, meta: { changes: r.changes } });
        },
        first<T>() {
          return Promise.resolve((stmt.get(...(bound as never[])) as T) ?? null);
        },
        all<T>() {
          return Promise.resolve({ results: stmt.all(...(bound as never[])) as T[] });
        },
      };
      return api;
    },
  } as unknown as D1Database;
}

const SCHEMA = `
CREATE TABLE datasets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dataset_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  authors TEXT,
  license TEXT,
  readme TEXT,
  bids_version TEXT,
  sessions_count INTEGER,
  updated_at TEXT
);`;

function seededDb(): Database {
  const db = new Database(":memory:");
  db.exec(SCHEMA);
  db.exec(
    `INSERT INTO datasets (dataset_id, name, description, authors, license, readme, bids_version, sessions_count, updated_at)
     VALUES ('nm000200', 'Old Name', 'old desc', 'Existing Author', 'CC0', 'old readme', '1.0.0', 2, '2020-01-01')`,
  );
  return db;
}

describe("writeDatasetCatalogFields", () => {
  test("COALESCE-preserves existing values when a field is null", async () => {
    const db = seededDb();
    const res = await writeDatasetCatalogFields(realD1(db), "nm000200", {
      authors: "New Author", // updated
      license: null, // preserve
      name: null, // preserve (NOT NULL column must not be clobbered)
      description: null, // preserve
      readme: null, // preserve
      bids_version: "1.8.0", // updated
    });
    expect(res.changes).toBe(1);
    const row = db
      .query(
        "SELECT name, description, authors, license, readme, bids_version FROM datasets WHERE dataset_id='nm000200'",
      )
      .get() as Record<string, unknown>;
    expect(row.authors).toBe("New Author");
    expect(row.bids_version).toBe("1.8.0");
    expect(row.license).toBe("CC0"); // preserved
    expect(row.name).toBe("Old Name"); // preserved
    expect(row.description).toBe("old desc"); // preserved
    expect(row.readme).toBe("old readme"); // preserved
  });

  test("truncates a long readme to 8 KB", async () => {
    const db = seededDb();
    await writeDatasetCatalogFields(realD1(db), "nm000200", { readme: "x".repeat(10_000) });
    const row = db
      .query("SELECT LENGTH(readme) AS len FROM datasets WHERE dataset_id='nm000200'")
      .get() as { len: number };
    expect(row.len).toBe(8192);
  });

  test("writes every field through (guards against bind-order transposition)", async () => {
    const db = seededDb();
    await writeDatasetCatalogFields(realD1(db), "nm000200", {
      name: "Fresh Title",
      description: "fresh desc",
      authors: "Fresh Author",
      license: "MIT",
      readme: "fresh readme",
      bids_version: "1.9.0",
      sessions_count: 7,
    });
    const row = db
      .query(
        "SELECT name, description, authors, license, readme, bids_version, sessions_count FROM datasets WHERE dataset_id='nm000200'",
      )
      .get() as Record<string, unknown>;
    expect(row).toEqual({
      name: "Fresh Title",
      description: "fresh desc",
      authors: "Fresh Author",
      license: "MIT",
      readme: "fresh readme",
      bids_version: "1.9.0",
      sessions_count: 7,
    });
  });

  test("reports changes=0 for an unknown dataset (no silent write)", async () => {
    const db = seededDb();
    const res = await writeDatasetCatalogFields(realD1(db), "does-not-exist", { authors: "X" });
    expect(res.changes).toBe(0);
  });
});

describe("buildDatasetVectorMetadata", () => {
  test("emits the six fields semanticSearch reads, mapping subject_count/concept_doi", () => {
    expect(
      buildDatasetVectorMetadata({
        name: "EEG Study",
        modalities: "eeg,emg",
        tasks: "rest",
        authors: "Ada",
        subject_count: 12,
        concept_doi: "doi:10.x/y",
      }),
    ).toEqual({
      name: "EEG Study",
      modalities: "eeg,emg",
      participants: 12,
      doi: "doi:10.x/y",
      tasks: "rest",
      authors: "Ada",
    });
  });

  test("defaults missing fields ('' for strings, 0 for participants) so search cards never get undefined", () => {
    expect(buildDatasetVectorMetadata({ name: "Only Name" })).toEqual({
      name: "Only Name",
      modalities: "",
      participants: 0,
      doi: "",
      tasks: "",
      authors: "",
    });
  });
});

describe("buildDatasetEmbedText", () => {
  test("joins all present fields with labels", () => {
    expect(
      buildDatasetEmbedText({
        name: "Motor Imagery EEG",
        modalities: "eeg",
        tasks: "rest",
        authors: "Ada, Alan",
        readme: "Body text",
      }),
    ).toBe("Motor Imagery EEG\nModalities: eeg\nTasks: rest\nAuthors: Ada, Alan\nBody text");
  });

  test("omits empty/null parts", () => {
    expect(
      buildDatasetEmbedText({ name: "Only Name", modalities: null, tasks: "", authors: undefined }),
    ).toBe("Only Name");
  });

  test("slices readme to 1000 chars", () => {
    const t = buildDatasetEmbedText({ name: "N", readme: "y".repeat(5000) });
    // "N\n" + 1000 y's
    expect(t.length).toBe(2 + 1000);
    expect(t.startsWith("N\n")).toBe(true);
  });
});

describe("reembedDatasetVector guard", () => {
  test("returns false without throwing (and without touching the DB) when AI/Vectorize are unset", async () => {
    // The guard returns before any DB/AI/Vectorize use, so passing undefined
    // bindings + a never-touched db is a real early-return, not a mock.
    await expect(
      reembedDatasetVector({} as unknown as D1Database, undefined, undefined, "nm000200"),
    ).resolves.toBe(false);
  });
});

describe("hook wiring (dual-write anti-regression pins)", () => {
  const enrichSrc = readFileSync(
    join(import.meta.dir, "..", "backend/src/services/enrich-dataset.ts"),
    "utf8",
  );
  const reindexSrc = readFileSync(
    join(import.meta.dir, "..", "backend/src/services/dataset-reindex.ts"),
    "utf8",
  );

  for (const [name, src] of [
    ["enrich-dataset", enrichSrc],
    ["dataset-reindex", reindexSrc],
  ] as const) {
    test(`${name} dual-writes datasets + keeps the nemar_catalog safety net + re-embeds`, () => {
      // Phase 2 must write the datasets source of truth AND keep the
      // nemar_catalog mirror AND re-embed. If a future change drops the
      // datasets write or removes the safety net before Phase 3, fail loudly.
      expect(src).toContain("writeDatasetCatalogFields(");
      expect(src).toContain("syncNemarCatalogFromEnrichment(");
      expect(src).toContain("reembedDatasetVector(");
    });
  }

  test("both hooks guard an empty README with `|| null` (can't clobber stored readme)", () => {
    expect(enrichSrc).toContain("readmeContent || null");
    expect(reindexSrc).toContain("readme || null");
  });
});
