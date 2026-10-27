/**
 * Migration 0104_dataset_versions_source_version.sql (epic #1046 phase 2, #1908; ADR 0111,
 * decision 4), on a real SQLite database.
 *
 * What is pinned: the two columns exist and are nullable, a row that predates the migration
 * reads NULL/NULL ("never examined", which the CHECK accepts), and the CHECK keeps the three
 * states apart. In particular "never examined" and "examined, unknown" are different rows, and
 * a known tag can never carry the `unknown` word or no word at all.
 *
 * bun:sqlite's `exec()` swallows a constraint error behind leading whitespace, so every INSERT
 * here goes through `prepare().run()`.
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { freshDb } from "./helpers/d1";

const MIGRATIONS_DIR = join(import.meta.dir, "../src/db/migrations");
const TARGET = "0104_dataset_versions_source_version.sql";

/** Every migration before the target, so a row can be seeded at the pre-0104 schema. */
function dbBeforeTarget(): Database {
  const db = new Database(":memory:");
  for (const file of readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql") && f < TARGET)
    .sort()) {
    db.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf-8"));
  }
  return db;
}

function seedDataset(db: Database, id: string): void {
  db.prepare("INSERT INTO datasets (dataset_id, name, owner_user_id) VALUES (?, ?, -1)").run(
    id,
    id,
  );
}

function insertVersion(
  db: Database,
  id: string,
  version: string,
  tag: string | null,
  basis: string | null,
): void {
  db.prepare(
    `INSERT INTO dataset_versions (dataset_id, version, doi, source_version, source_version_basis)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, version, `10.82901/nemar.${id}.v${version}`, tag, basis);
}

function rowOf(db: Database, id: string, version: string) {
  return db
    .query<
      { source_version: string | null; source_version_basis: string | null },
      [string, string]
    >(
      "SELECT source_version, source_version_basis FROM dataset_versions WHERE dataset_id = ? AND version = ?",
    )
    .get(id, version);
}

describe("migration 0104: the columns", () => {
  test("both columns exist on dataset_versions, and datasets is untouched", () => {
    const db = freshDb();
    const cols = (t: string) =>
      (db.query(`SELECT name FROM pragma_table_info('${t}')`).all() as { name: string }[]).map(
        (c) => c.name,
      );
    expect(cols("dataset_versions")).toEqual(
      expect.arrayContaining(["source_version", "source_version_basis"]),
    );
    expect(cols("datasets")).not.toContain("source_version");
    expect(cols("datasets")).not.toContain("source_version_basis");
  });

  test("a row that predates the migration reads NULL/NULL, and the migration rejects none", () => {
    const db = dbBeforeTarget();
    seedDataset(db, "on000001");
    db.prepare(
      "INSERT INTO dataset_versions (dataset_id, version, doi) VALUES ('on000001', '1.0.0', '10.82901/x')",
    ).run();
    db.exec(readFileSync(join(MIGRATIONS_DIR, TARGET), "utf-8"));
    expect(rowOf(db, "on000001", "1.0.0")).toEqual({
      source_version: null,
      source_version_basis: null,
    });
  });

  test("an insert that names neither column is never examined (NULL/NULL)", () => {
    const db = freshDb();
    seedDataset(db, "on000002");
    db.prepare(
      "INSERT INTO dataset_versions (dataset_id, version, doi) VALUES ('on000002', '1.0.0', '10.82901/y')",
    ).run();
    expect(rowOf(db, "on000002", "1.0.0")).toEqual({
      source_version: null,
      source_version_basis: null,
    });
  });
});

describe("migration 0104: the CHECK keeps three states apart", () => {
  test("a known tag with basis doi or lineage is accepted, a legacy tag keeps its zeros", () => {
    const db = freshDb();
    seedDataset(db, "on000003");
    insertVersion(db, "on000003", "1.0.0", "2.0.2", "doi");
    insertVersion(db, "on000003", "2.0.0", "00001", "doi");
    insertVersion(db, "on000003", "3.0.0", "3.0.0", "lineage");
    expect(rowOf(db, "on000003", "2.0.0")?.source_version).toBe("00001");
    expect(rowOf(db, "on000003", "3.0.0")?.source_version_basis).toBe("lineage");
  });

  test("examined and unknown is a row of its own: basis unknown with no tag", () => {
    const db = freshDb();
    seedDataset(db, "on000004");
    insertVersion(db, "on000004", "1.0.0", null, "unknown");
    insertVersion(db, "on000004", "2.0.0", null, null);
    expect(rowOf(db, "on000004", "1.0.0")).toEqual({
      source_version: null,
      source_version_basis: "unknown",
    });
    expect(rowOf(db, "on000004", "2.0.0")).toEqual({
      source_version: null,
      source_version_basis: null,
    });
  });

  test("a tag with no basis is refused", () => {
    const db = freshDb();
    seedDataset(db, "on000005");
    expect(() => insertVersion(db, "on000005", "1.0.0", "2.0.2", null)).toThrow(
      /CHECK constraint failed/,
    );
  });

  test("the word unknown beside a tag is refused", () => {
    const db = freshDb();
    seedDataset(db, "on000006");
    expect(() => insertVersion(db, "on000006", "1.0.0", "2.0.2", "unknown")).toThrow(
      /CHECK constraint failed/,
    );
  });

  test("doi or lineage with no tag is refused", () => {
    const db = freshDb();
    seedDataset(db, "on000007");
    expect(() => insertVersion(db, "on000007", "1.0.0", null, "doi")).toThrow(
      /CHECK constraint failed/,
    );
    expect(() => insertVersion(db, "on000007", "1.0.0", null, "lineage")).toThrow(
      /CHECK constraint failed/,
    );
  });

  test("a basis word outside the closed set is refused", () => {
    const db = freshDb();
    seedDataset(db, "on000008");
    expect(() => insertVersion(db, "on000008", "1.0.0", "2.0.2", "guess")).toThrow(
      /CHECK constraint failed/,
    );
    expect(() => insertVersion(db, "on000008", "1.0.0", null, "guess")).toThrow(
      /CHECK constraint failed/,
    );
  });

  test("an UPDATE cannot walk a row into an impossible state either", () => {
    const db = freshDb();
    seedDataset(db, "on000009");
    insertVersion(db, "on000009", "1.0.0", null, null);
    expect(() =>
      db
        .prepare(
          "UPDATE dataset_versions SET source_version = '2.0.2' WHERE dataset_id = 'on000009'",
        )
        .run(),
    ).toThrow(/CHECK constraint failed/);
  });
});
