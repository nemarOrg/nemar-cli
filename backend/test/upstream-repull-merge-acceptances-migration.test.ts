/**
 * Migration 0113_upstream_repull_merge_acceptances.sql (epic #1046; ADR 0111, the amendment of
 * 2026-10-29; issue #1996), on two engines: bun:sqlite, which every other suite uses, and
 * Miniflare's D1, the implementation `wrangler --local` runs, where foreign keys are enforced.
 *
 * What is pinned: the pull requests are the re-pull's two; each invariant refuses its violating
 * row and accepts its valid one (a reason within the publication path's 10 to 500 characters, a
 * scanner exactly when an attestation is needed, a time seen only for a needed one, a commit only
 * with its time); one acceptance per pull request of a re-pull; on D1 the row belongs to an
 * existing re-pull and goes with it; and the dataset cascade removes the dataset's rows only.
 */

import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Miniflare } from "miniflare";
import {
  ACKNOWLEDGMENT_MAX_LENGTH,
  ACKNOWLEDGMENT_MIN_LENGTH,
} from "../../shared/publication-limits";
import { REPULL_PULL_REQUESTS } from "../../shared/repull-state";
import { deleteDatasetCascade } from "../src/services/deletion";
import type { Bindings } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";
import { MIGRATIONS_DIR, applyMigrations, migrationFiles } from "./helpers/miniflare-d1";
import { type Row, SHA, rowAt } from "./helpers/repull-rows";

const FILE = "0113_upstream_repull_merge_acceptances.sql";
const SQL = readFileSync(join(MIGRATIONS_DIR, FILE), "utf-8");
const TABLE = "upstream_repull_merge_acceptances";

interface Engine {
  name: string;
  run(sql: string, ...binds: unknown[]): Promise<string | null>;
  all<T>(sql: string, ...binds: unknown[]): Promise<T[]>;
  reset(): Promise<void>;
  foreignKeys: boolean;
}

/** An acceptance that satisfies every CHECK, needing an attestation not yet seen. */
function acceptance(repullId: number, over: Row = {}): Row {
  return {
    repull_id: repullId,
    pr: "n0",
    merge_sha: SHA,
    reason: "merged with GitHub's own button",
    accepted_by: 1,
    attestation_needed: 1,
    scanner: "identifier-scan@abcdef1",
    ...over,
  };
}

async function insertRow(e: Engine, table: string, row: Row): Promise<string | null> {
  const cols = Object.keys(row);
  return e.run(
    `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
    ...cols.map((c) => row[c]),
  );
}

async function repull(e: Engine, over: Row = {}): Promise<number> {
  const err = await insertRow(e, "upstream_repulls", rowAt("merged", over));
  if (err) throw new Error(err);
  const [r] = await e.all<{ id: number }>("SELECT MAX(id) AS id FROM upstream_repulls");
  return r?.id ?? 0;
}

function sqliteEngine(): Engine {
  const db: Database = freshDb();
  return {
    name: "bun:sqlite",
    foreignKeys: false,
    async run(sql, ...binds) {
      try {
        db.prepare(sql).run(...(binds as never[]));
        return null;
      } catch (err) {
        return String(err);
      }
    },
    async all<T>(sql: string, ...binds: unknown[]) {
      return db.prepare(sql).all(...(binds as never[])) as T[];
    },
    async reset() {
      db.exec(`DELETE FROM ${TABLE}; DELETE FROM upstream_repulls;`);
    },
  };
}

const ENGINES: Engine[] = [];
let mf: Miniflare;

beforeAll(async () => {
  ENGINES.push(sqliteEngine());
  mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response(null, { status: 204 }); } };",
    compatibilityDate: "2024-12-01",
    d1Databases: ["DB"],
  });
  const d1 = await mf.getD1Database("DB");
  await applyMigrations(d1, migrationFiles());
  ENGINES.push({
    name: "Miniflare D1",
    foreignKeys: true,
    async run(sql, ...binds) {
      try {
        await d1
          .prepare(sql)
          .bind(...binds)
          .run();
        return null;
      } catch (err) {
        return String(err);
      }
    },
    async all<T>(sql: string, ...binds: unknown[]) {
      return (
        await d1
          .prepare(sql)
          .bind(...binds)
          .all<T>()
      ).results;
    },
    async reset() {
      await d1.prepare(`DELETE FROM ${TABLE}`).run();
      await d1.prepare("DELETE FROM upstream_repulls").run();
    },
  });
});

afterAll(async () => {
  await mf?.dispose();
});

function onEveryEngine(name: string, body: (e: Engine) => Promise<void>) {
  test(name, async () => {
    expect(ENGINES).toHaveLength(2);
    for (const e of ENGINES) {
      await e.reset();
      try {
        await body(e);
      } catch (err) {
        throw new Error(`${e.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  });
}

const CHECK = /CHECK constraint failed/;
const words = (s: string) => [...s.matchAll(/'([a-z0-9-]+)'/g)].map((m) => m[1] as string);

describe("the file says the shared words and numbers", () => {
  test("the two pull requests are the re-pull's two", () => {
    const check = /pr TEXT NOT NULL CHECK \(pr IN \(([^)]*)\)\)/.exec(SQL);
    expect(words(check?.[1] ?? "").sort()).toEqual([...REPULL_PULL_REQUESTS].sort());
  });

  test("the reason's bounds are the publication path's", () => {
    expect(SQL).toContain(
      `CHECK (length(reason) BETWEEN ${ACKNOWLEDGMENT_MIN_LENGTH} AND ${ACKNOWLEDGMENT_MAX_LENGTH})`,
    );
  });
});

describe("every row holds what it should", () => {
  onEveryEngine(
    "an acceptance waiting for its line, seen, and needing none are accepted",
    async (e) => {
      const id = await repull(e);
      expect(await insertRow(e, TABLE, acceptance(id))).toBeNull();
      expect(
        await insertRow(
          e,
          TABLE,
          acceptance(id, { pr: "n1", attestation_sha: "c".repeat(40), attested_at: "2026-10-29" }),
        ),
      ).toBeNull();
      const other = await repull(e, { dataset_id: "xx090124" });
      expect(
        await insertRow(e, TABLE, acceptance(other, { attestation_needed: 0, scanner: null })),
      ).toBeNull();
      // A line found already on main records its time with no commit.
      const third = await repull(e, { dataset_id: "xx090125" });
      expect(
        await insertRow(e, TABLE, acceptance(third, { attested_at: "2026-10-29" })),
      ).toBeNull();
    },
  );

  const refused: Array<[string, Row]> = [
    ["a pull request outside the two", { pr: "n2" }],
    ["a merge commit of 39 characters", { merge_sha: "a".repeat(39) }],
    ["a merge commit in upper case", { merge_sha: "A".repeat(40) }],
    ["a reason under 10 characters", { reason: "too short" }],
    ["a reason over 500 characters", { reason: "x".repeat(501) }],
    ["a needed attestation without its scanner", { scanner: null }],
    ["a scanner without a needed attestation", { attestation_needed: 0 }],
    ["a scanner that is not one", { scanner: "anything" }],
    ["needed outside 0 and 1", { attestation_needed: 2 }],
    [
      "a time seen for an attestation not needed",
      { attestation_needed: 0, scanner: null, attested_at: "2026-10-29" },
    ],
    ["a commit without its time", { attestation_sha: "c".repeat(40) }],
    ["a commit that is not hex", { attestation_sha: "g".repeat(40), attested_at: "2026-10-29" }],
  ];
  for (const [name, over] of refused) {
    onEveryEngine(`${name} is refused`, async (e) => {
      const id = await repull(e);
      expect(await insertRow(e, TABLE, acceptance(id, over))).toMatch(CHECK);
    });
  }

  onEveryEngine("one acceptance per pull request of a re-pull", async (e) => {
    const id = await repull(e);
    expect(await insertRow(e, TABLE, acceptance(id))).toBeNull();
    expect(await insertRow(e, TABLE, acceptance(id, { reason: "a second reason given" }))).toMatch(
      /UNIQUE constraint failed/,
    );
  });
});

describe("on D1 an acceptance belongs to a re-pull", () => {
  test("an acceptance of no re-pull is refused, and deleting the re-pull deletes it", async () => {
    const e = ENGINES.find((x) => x.foreignKeys) as Engine;
    expect(e?.name).toBe("Miniflare D1");
    await e.reset();
    expect(await insertRow(e, TABLE, acceptance(999_999))).toMatch(/FOREIGN KEY constraint failed/);
    const id = await repull(e);
    expect(await insertRow(e, TABLE, acceptance(id))).toBeNull();
    expect(await e.run("DELETE FROM upstream_repulls WHERE id = ?", id)).toBeNull();
    expect(await e.all(`SELECT repull_id FROM ${TABLE}`)).toEqual([]);
  });
});

describe("the dataset cascade", () => {
  test("deleteDatasetCascade removes the dataset's acceptances and no other dataset's", async () => {
    const db = freshDb();
    db.run(
      "INSERT INTO users (username, email, password_hash, status, role, email_verified) VALUES ('rplaccept', 'rplaccept@example.org', 'x', 'approved', 'admin', 1)",
    );
    for (const id of ["xx090123", "xx090124"]) {
      db.run(
        "INSERT INTO datasets (dataset_id, name, owner_user_id, source, source_id) VALUES (?, ?, 1, 'openneuro', 'ds099999')",
        [id, id],
      );
    }
    const insert = (table: string, row: Row) => {
      const cols = Object.keys(row);
      return Number(
        db
          .query(
            `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
          )
          .run(...(cols.map((c) => row[c]) as never[])).lastInsertRowid,
      );
    };
    const mine = insert("upstream_repulls", rowAt("merged", { dataset_id: "xx090123" }));
    const theirs = insert("upstream_repulls", rowAt("merged", { dataset_id: "xx090124" }));
    insert(TABLE, acceptance(mine));
    insert(TABLE, acceptance(theirs));
    const result = await deleteDatasetCascade(
      realD1(db),
      { ENVIRONMENT: "test" } as unknown as Bindings,
      "xx090123",
      { skipS3: true },
    );
    expect(result.steps.d1.success).toBe(true);
    expect(db.query(`SELECT repull_id FROM ${TABLE}`).all()).toEqual([{ repull_id: theirs }]);
    expect(db.query("SELECT id FROM upstream_repulls").all()).toEqual([{ id: theirs }]);
  });
});
