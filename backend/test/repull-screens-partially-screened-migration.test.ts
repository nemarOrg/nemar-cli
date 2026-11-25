/**
 * Migration 0150_repull_screens_partially_screened.sql (epic #2182 phase A1, #2185), on two
 * engines: bun:sqlite and Miniflare's D1, the implementation `wrangler d1 ... --local` runs, where
 * foreign keys are enforced.
 *
 * What is pinned: every row written before the rebuild comes through it unchanged, id included,
 * and the id sequence carries on past them; `partially-screened` is stored and acknowledged after
 * it and refused before it; the old word is still stored and acknowledged; the one-waiting index
 * and the foreign key to the re-pull survive the rebuild.
 */

import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Miniflare } from "miniflare";
import { MIGRATIONS_DIR, applyMigrations, migrationFiles } from "./helpers/miniflare-d1";
import { type Row, SHA, rowAt } from "./helpers/repull-rows";

const TARGET = "0150_repull_screens_partially_screened.sql";
const BEFORE = migrationFiles().filter((f) => f < TARGET);
const AFTER = migrationFiles().filter((f) => f > TARGET);

const REPORT = '{"version":2,"scanner":"identifier-scan@abcdef1","head":"x"}';
const ACK = { ack_by: 1, ack_reason: "read the report", ack_at: "2026-11-25 03:00:00" };

interface Engine {
  name: string;
  foreignKeys: boolean;
  run(sql: string, ...binds: unknown[]): Promise<string | null>;
  all<T>(sql: string, ...binds: unknown[]): Promise<T[]>;
  /** Apply the target migration (and every one after it). */
  migrate(): Promise<void>;
}

function screen(repullId: number, status: string, over: Row = {}): Row {
  const verdict = status !== "pending" && status !== "unreported";
  return {
    repull_id: repullId,
    pr: "n0",
    sha: SHA,
    status,
    nonce: verdict ? null : "nonce-1",
    report: verdict ? REPORT : null,
    reported_at: verdict ? "2026-11-25 02:00:00" : null,
    ...over,
  };
}

async function insert(e: Engine, table: string, row: Row): Promise<string | null> {
  const cols = Object.keys(row);
  return e.run(
    `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
    ...cols.map((c) => row[c]),
  );
}

async function repull(e: Engine): Promise<number> {
  const err = await insert(e, "upstream_repulls", rowAt("pr_open"));
  if (err) throw new Error(err);
  const [r] = await e.all<{ id: number }>("SELECT MAX(id) AS id FROM upstream_repulls");
  return r?.id ?? 0;
}

const sha = (n: number) => n.toString(16).padStart(40, "0");

function sqliteEngine(): Engine {
  const db = new Database(":memory:");
  const apply = (files: string[]) => {
    for (const f of files) db.exec(readFileSync(join(MIGRATIONS_DIR, f), "utf-8"));
  };
  apply(BEFORE);
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
    async migrate() {
      apply([TARGET, ...AFTER]);
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
  await applyMigrations(d1, BEFORE);
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
    async migrate() {
      await applyMigrations(d1, [TARGET, ...AFTER]);
    },
  });

  // Before the migration, on both engines: rows of every kind the old table holds, and the new
  // word refused.
  for (const e of ENGINES) {
    const id = await repull(e);
    const rows: Row[] = [
      screen(id, "clean", { sha: sha(1) }),
      screen(id, "clean-edf-only-others-unscreened", { sha: sha(2), ...ACK }),
      screen(id, "review", { sha: sha(3), pr: "n1" }),
      screen(id, "pending", { sha: sha(4) }),
    ];
    for (const row of rows) {
      const err = await insert(e, "upstream_repull_screens", row);
      if (err) throw new Error(`${e.name}: ${err}`);
    }
    BEFORE_STATE.set(e.name, {
      repullId: id,
      rows: await e.all<Row>("SELECT * FROM upstream_repull_screens ORDER BY id"),
      refusedBefore: await insert(
        e,
        "upstream_repull_screens",
        screen(id, "partially-screened", { sha: sha(9) }),
      ),
    });
    await e.migrate();
  }
});

const BEFORE_STATE = new Map<
  string,
  { repullId: number; rows: Row[]; refusedBefore: string | null }
>();

afterAll(async () => {
  await mf?.dispose();
});

function onEveryEngine(name: string, body: (e: Engine, repullId: number) => Promise<void>) {
  test(name, async () => {
    expect(ENGINES).toHaveLength(2);
    for (const e of ENGINES) {
      try {
        await body(e, BEFORE_STATE.get(e.name)?.repullId ?? 0);
      } catch (err) {
        throw new Error(`${e.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  });
}

describe("migration 0150", () => {
  onEveryEngine("the new word was refused before the rebuild", async (e) => {
    expect(BEFORE_STATE.get(e.name)?.refusedBefore).toMatch(/CHECK constraint failed/);
  });

  onEveryEngine("every row comes through unchanged, id included", async (e) => {
    const before = BEFORE_STATE.get(e.name)?.rows ?? [];
    expect(before).toHaveLength(4);
    const after = await e.all<Row>("SELECT * FROM upstream_repull_screens ORDER BY id");
    expect(after).toEqual(before);
  });

  onEveryEngine("partially-screened is stored, and acknowledged, after it", async (e, id) => {
    expect(
      await insert(e, "upstream_repull_screens", screen(id, "partially-screened", { sha: sha(5) })),
    ).toBeNull();
    expect(
      await insert(
        e,
        "upstream_repull_screens",
        screen(id, "partially-screened", { sha: sha(6), ...ACK }),
      ),
    ).toBeNull();
    // The old word stays storable and acknowledgeable: version-1 rows keep it.
    expect(
      await insert(
        e,
        "upstream_repull_screens",
        screen(id, "clean-edf-only-others-unscreened", { sha: sha(7), ...ACK }),
      ),
    ).toBeNull();
  });

  onEveryEngine("the other CHECKs are still there", async (e, id) => {
    for (const [status, over] of [
      ["clean", { sha: sha(10), ...ACK }],
      ["direct-identifiers", { sha: sha(11), ...ACK }],
      ["done", { sha: sha(12) }],
      ["clean", { sha: sha(13), report: null, reported_at: null }],
    ] as const) {
      expect(await insert(e, "upstream_repull_screens", screen(id, status, over))).toMatch(
        /constraint failed/,
      );
    }
  });

  onEveryEngine("ids carry on past the copied rows", async (e, id) => {
    const [{ max } = { max: 0 }] = await e.all<{ max: number }>(
      "SELECT MAX(id) AS max FROM upstream_repull_screens",
    );
    expect(
      await insert(e, "upstream_repull_screens", screen(id, "review", { sha: sha(20) })),
    ).toBeNull();
    const [{ id: next } = { id: 0 }] = await e.all<{ id: number }>(
      "SELECT id FROM upstream_repull_screens WHERE sha = ?",
      sha(20),
    );
    expect(next).toBeGreaterThan(max);
  });

  onEveryEngine("the one-waiting index survives", async (e, id) => {
    const index = await e.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'upstream_repull_screens_one_waiting'",
    );
    expect(index).toHaveLength(1);
    // The copied pending row holds the re-pull's one nonce, so a second waiting row is refused.
    expect(
      await insert(
        e,
        "upstream_repull_screens",
        screen(id, "pending", { sha: sha(30), nonce: "n2" }),
      ),
    ).toMatch(/UNIQUE constraint failed/);
  });

  test("on D1 the foreign key to the re-pull survives, with its cascade", async () => {
    const e = ENGINES.find((x) => x.foreignKeys) as Engine;
    expect(
      await insert(e, "upstream_repull_screens", screen(999_999, "clean", { sha: sha(40) })),
    ).toMatch(/FOREIGN KEY constraint failed/);
    const id = BEFORE_STATE.get(e.name)?.repullId ?? 0;
    expect(await e.run("DELETE FROM upstream_repulls WHERE id = ?", id)).toBeNull();
    expect(await e.all("SELECT id FROM upstream_repull_screens WHERE repull_id = ?", id)).toEqual(
      [],
    );
  });
});
