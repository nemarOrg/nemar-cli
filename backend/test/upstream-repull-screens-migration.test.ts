/**
 * Migration 0106_upstream_repull_screens.sql (epic #1046 phase 6, #1912; ADR 0111, decision 7), on
 * two engines: bun:sqlite, which every other suite uses, and Miniflare's D1, the implementation
 * `wrangler --local` runs, where foreign keys are enforced. A CHECK, a partial index or a cascade
 * proven only on the first is not proven.
 *
 * What is pinned: the words in the file are the words of `shared/identifier-screen-report.ts`
 * (the states, and which of them may carry an acknowledgment) and of `shared/repull-state.ts`
 * (the two pull requests); each invariant refuses its violating row and accepts its valid one;
 * one screen per commit of a pull request; one waiting screen per re-pull; on D1 the screen
 * belongs to an existing re-pull and goes with it; and the dataset cascade removes the screens.
 */

import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Miniflare } from "miniflare";
import { DATASET_STATUSES, screenGate } from "../../shared/identifier-screen-report";
import { deleteDatasetCascade } from "../src/services/deletion";
import type { Bindings } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";
import { MIGRATIONS_DIR, applyMigrations, migrationFiles } from "./helpers/miniflare-d1";
import { type Row, SHA, rowAt } from "./helpers/repull-rows";

const FILE = "0106_upstream_repull_screens.sql";
const SQL = readFileSync(join(MIGRATIONS_DIR, FILE), "utf-8");

const REPORT = '{"version":1,"scanner":"identifier-scan@abcdef1","head":"x"}';

interface Engine {
  name: string;
  run(sql: string, ...binds: unknown[]): Promise<string | null>;
  all<T>(sql: string, ...binds: unknown[]): Promise<T[]>;
  reset(): Promise<void>;
  foreignKeys: boolean;
}

/** A screen row that satisfies every CHECK for `status`, laid over with `over`. */
function screen(repullId: number, status: string, over: Row = {}): Row {
  const verdict = status !== "pending" && status !== "unreported";
  return {
    repull_id: repullId,
    pr: "n0",
    sha: SHA,
    status,
    nonce: verdict ? null : "nonce-1",
    report: verdict ? REPORT : null,
    reported_at: verdict ? "2026-10-24 02:00:00" : null,
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

/** A re-pull row to hang screens on; its id. */
async function repull(e: Engine, over: Row = {}): Promise<number> {
  const err = await insertRow(e, "upstream_repulls", rowAt("pr_open", over));
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
      db.exec("DELETE FROM upstream_repull_screens; DELETE FROM upstream_repulls;");
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
      await d1.prepare("DELETE FROM upstream_repull_screens").run();
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

describe("the file says the shared words", () => {
  test("the states are the screen's states, and pending and unreported are the waiting ones", () => {
    const check = /status TEXT NOT NULL CHECK \(status IN \(([^)]*)\)\)/.exec(SQL);
    expect(words(check?.[1] ?? "").sort()).toEqual(
      ["pending", ...DATASET_STATUSES, "error", "unreported"].sort(),
    );
  });

  test("an acknowledgment is allowed on exactly the states whose gate asks for one", () => {
    const check = /CHECK \(ack_at IS NULL OR status IN \(([^)]*)\)\)/.exec(SQL);
    const asking = DATASET_STATUSES.filter((s) => screenGate(s) === "acknowledge");
    expect(asking.length).toBeGreaterThan(0);
    expect(words(check?.[1] ?? "").sort()).toEqual([...asking].sort());
  });

  test("the two pull requests are the re-pull's two", () => {
    const check = /pr TEXT NOT NULL CHECK \(pr IN \(([^)]*)\)\)/.exec(SQL);
    expect(words(check?.[1] ?? "").sort()).toEqual(["n0", "n1"]);
  });
});

describe("every state holds what it should", () => {
  onEveryEngine("a valid row of every state is accepted", async (e) => {
    const id = await repull(e);
    let n = 0;
    for (const status of ["pending", ...DATASET_STATUSES, "error", "unreported"]) {
      n++;
      // A waiting row holds the re-pull's one nonce, so only the first of them keeps one.
      const over = status === "unreported" ? { nonce: null } : {};
      const err = await insertRow(
        e,
        "upstream_repull_screens",
        screen(id, status, { sha: n.toString(16).padStart(40, "0"), ...over }),
      );
      expect([status, err]).toEqual([status, null]);
    }
  });

  onEveryEngine("an acknowledgment is accepted on a state that asks for one", async (e) => {
    const id = await repull(e);
    const ack = { ack_by: 1, ack_reason: "read the report", ack_at: "2026-10-24 03:00:00" };
    expect(await insertRow(e, "upstream_repull_screens", screen(id, "review", ack))).toBeNull();
  });

  const refused: Array<[string, string, Row]> = [
    ["a pending screen with a report", "pending", { report: REPORT }],
    ["a verdict without its report", "clean", { report: null, reported_at: null }],
    ["a report without the time it came", "clean", { reported_at: null }],
    ["a time without a report", "pending", { reported_at: "2026-10-24 02:00:00" }],
    ["a nonce on a verdict", "clean", { nonce: "n" }],
    ["an empty nonce", "pending", { nonce: "" }],
    ["an acknowledgment without its time", "review", { ack_by: 1, ack_reason: "because" }],
    ["an acknowledgment without its actor", "review", { ack_reason: "r", ack_at: "2026-10-24" }],
    ["an acknowledgment without its reason", "review", { ack_by: 1, ack_at: "2026-10-24" }],
    [
      "an acknowledgment of a clear screen",
      "clean",
      { ack_by: 1, ack_reason: "r", ack_at: "2026-10-24" },
    ],
    [
      "an acknowledgment of a direct identifier",
      "direct-identifiers",
      { ack_by: 1, ack_reason: "r", ack_at: "2026-10-24" },
    ],
    [
      "an acknowledgment of an error",
      "error",
      { ack_by: 1, ack_reason: "r", ack_at: "2026-10-24" },
    ],
    ["a pull request outside the two", "clean", { pr: "n2" }],
    ["a sha of 39 characters", "clean", { sha: "a".repeat(39) }],
    ["a sha in upper case", "clean", { sha: "A".repeat(40) }],
    ["a sha that is not hex", "clean", { sha: "g".repeat(40) }],
    ["a state outside the words", "done", { report: REPORT }],
    ["a report that is not JSON", "clean", { report: "{not json" }],
  ];
  for (const [name, status, over] of refused) {
    onEveryEngine(`${name} is refused`, async (e) => {
      const id = await repull(e);
      expect(await insertRow(e, "upstream_repull_screens", screen(id, status, over))).toMatch(
        CHECK,
      );
    });
  }
});

describe("one screen per commit, one run out per re-pull", () => {
  onEveryEngine("a commit of a pull request is screened in one row", async (e) => {
    const id = await repull(e);
    expect(await insertRow(e, "upstream_repull_screens", screen(id, "clean"))).toBeNull();
    expect(await insertRow(e, "upstream_repull_screens", screen(id, "error"))).toMatch(
      /UNIQUE constraint failed/,
    );
    // The other pull request's screen of the same commit, and another commit, are their own rows.
    expect(
      await insertRow(e, "upstream_repull_screens", screen(id, "clean", { pr: "n1" })),
    ).toBeNull();
    expect(
      await insertRow(e, "upstream_repull_screens", screen(id, "clean", { sha: "c".repeat(40) })),
    ).toBeNull();
  });

  onEveryEngine(
    "a second waiting screen of a re-pull is refused until the first stops",
    async (e) => {
      const id = await repull(e);
      const other = await repull(e, { dataset_id: "xx090124" });
      expect(await insertRow(e, "upstream_repull_screens", screen(id, "pending"))).toBeNull();
      const second = screen(id, "pending", { sha: "c".repeat(40), nonce: "nonce-2" });
      expect(await insertRow(e, "upstream_repull_screens", second)).toMatch(
        /UNIQUE constraint failed/,
      );
      // Another re-pull waits on its own.
      expect(
        await insertRow(e, "upstream_repull_screens", screen(other, "pending", { nonce: "n3" })),
      ).toBeNull();
      // Once the first no longer waits, the second may.
      expect(
        await e.run("UPDATE upstream_repull_screens SET nonce = NULL WHERE repull_id = ?", id),
      ).toBeNull();
      expect(await insertRow(e, "upstream_repull_screens", second)).toBeNull();
    },
  );

  onEveryEngine("the waiting index exists", async (e) => {
    const names = (
      await e.all<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'upstream_repull_screens'",
      )
    ).map((r) => r.name);
    expect(names).toContain("upstream_repull_screens_one_waiting");
  });
});

describe("on D1 a screen belongs to a re-pull", () => {
  test("a screen of no re-pull is refused, and deleting the re-pull deletes its screens", async () => {
    const e = ENGINES.find((x) => x.foreignKeys) as Engine;
    expect(e?.name).toBe("Miniflare D1");
    await e.reset();
    expect(await insertRow(e, "upstream_repull_screens", screen(999_999, "clean"))).toMatch(
      /FOREIGN KEY constraint failed/,
    );
    const id = await repull(e);
    expect(await insertRow(e, "upstream_repull_screens", screen(id, "clean"))).toBeNull();
    expect(await e.run("DELETE FROM upstream_repulls WHERE id = ?", id)).toBeNull();
    expect(await e.all("SELECT id FROM upstream_repull_screens")).toEqual([]);
  });
});

describe("the dataset cascade", () => {
  test("deleteDatasetCascade removes the dataset's screens and no other dataset's", async () => {
    const db = freshDb();
    db.run(
      "INSERT INTO users (username, email, password_hash, status, role, email_verified) VALUES ('rplscreens', 'rplscreens@example.org', 'x', 'approved', 'admin', 1)",
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
    const mine = insert("upstream_repulls", rowAt("pr_open", { dataset_id: "xx090123" }));
    const theirs = insert("upstream_repulls", rowAt("pr_open", { dataset_id: "xx090124" }));
    insert("upstream_repull_screens", screen(mine, "clean"));
    insert("upstream_repull_screens", screen(theirs, "clean"));
    const result = await deleteDatasetCascade(
      realD1(db),
      { ENVIRONMENT: "test" } as unknown as Bindings,
      "xx090123",
      { skipS3: true },
    );
    expect(result.steps.d1.success).toBe(true);
    expect(db.query("SELECT repull_id FROM upstream_repull_screens").all()).toEqual([
      { repull_id: theirs },
    ]);
    expect(db.query("SELECT id FROM upstream_repulls").all()).toEqual([{ id: theirs }]);
  });
});
