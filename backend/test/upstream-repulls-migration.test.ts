/**
 * Migration 0105_upstream_repulls.sql (epic #1046 phase 6, #1912; ADR 0111, decision 3), on two
 * engines: bun:sqlite, which every other suite uses, and Miniflare's D1, the implementation
 * `wrangler --local` runs. bun:sqlite is more permissive than the SQLite D1 ships, so a CHECK, a
 * partial index or a JSON function proven only on the first is not proven.
 *
 * What is pinned: every stage invariant refuses its violating row and accepts its valid one, the
 * partial unique index allows one open row per dataset and a new one after a terminal row,
 * `(dataset_id, to_tag, attempt)` is unique, and the words in the file are the words in
 * shared/repull-state.ts.
 */

import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Miniflare } from "miniflare";
import {
  REPULL_STATUSES,
  type RepullStatus,
  TERMINAL_STATUSES,
  TRANSITION_FIELDS,
} from "../../shared/repull-state";
import { freshDb } from "./helpers/d1";
import { MIGRATIONS_DIR, applyMigrations, migrationFiles } from "./helpers/miniflare-d1";

const FILE = "0105_upstream_repulls.sql";
const SQL = readFileSync(join(MIGRATIONS_DIR, FILE), "utf-8");

type Row = Record<string, string | number | null>;

const SHA = "a".repeat(40);
const TREE = "b".repeat(40);
const DIGEST = `sha256:${"0".repeat(64)}`;

const TERMINAL = new Set<string>(TERMINAL_STATUSES);

/** A row that satisfies every CHECK for `status`, with `over` laid on top. */
function rowAt(status: RepullStatus, over: Row = {}): Row {
  const row: Row = {
    dataset_id: "xx090123",
    upstream_ds: "ds004362",
    from_tag: "1.0.0",
    to_tag: "1.0.1",
    attempt: 1,
    from_version: "1.0.0",
    to_version: "2.0.0",
    plan_digest: DIGEST,
    planner: 1,
    origin: "administrator",
    actor_user_id: 1,
    status,
    base_sha: SHA,
    terminal_at: TERMINAL.has(status) ? "2026-10-24 00:00:00" : null,
  };
  const after = (s: RepullStatus) => REPULL_STATUSES.indexOf(status) >= REPULL_STATUSES.indexOf(s);
  const early = ["planned", "abandoned", "failed", "superseded"];
  if (!early.includes(status)) {
    row.synth_tree = TREE;
    row.synth_sha = SHA;
    row.manifest_digest = DIGEST;
  }
  const hasPr = after("pr_open") && !early.includes(status);
  if (hasPr) Object.assign(row, { branch: "release/v2.0.0", pr_number: 7, head_sha: SHA });
  if (status === "gates_clear") row.gates_sha = SHA;
  if (hasPr && after("merged")) row.merge_sha = SHA;
  if (hasPr && after("released")) row.tag_sha = SHA;
  const patch = ["patch_synthesized", "patch_gates_clear", "patch_merged", "patch_released"];
  if (patch.includes(status)) {
    Object.assign(row, {
      patch_version: "2.0.1",
      patch_branch: "release/v2.0.1",
      patch_pr_number: 8,
      patch_head_sha: SHA,
      patch_base_sha: SHA,
    });
  }
  if (status === "patch_gates_clear") row.patch_gates_sha = SHA;
  if (status === "patch_merged" || status === "patch_released") row.patch_merge_sha = SHA;
  if (status === "patch_released") row.patch_tag_sha = SHA;
  return { ...row, ...over };
}

/** An engine reduced to what the tests ask of it: write a row, read rows, report the refusal. */
interface Engine {
  name: string;
  /** The error text of a refused statement, or null when it applied. */
  run(sql: string, ...binds: unknown[]): Promise<string | null>;
  all<T>(sql: string, ...binds: unknown[]): Promise<T[]>;
  reset(): Promise<void>;
}

async function insert(e: Engine, row: Row): Promise<string | null> {
  const cols = Object.keys(row);
  return e.run(
    `INSERT INTO upstream_repulls (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
    ...cols.map((c) => row[c]),
  );
}

function sqliteEngine(): Engine {
  const db: Database = freshDb();
  return {
    name: "bun:sqlite",
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
      db.exec("DELETE FROM upstream_repulls");
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
      await d1.prepare("DELETE FROM upstream_repulls").run();
    },
  });
});

afterAll(async () => {
  await mf?.dispose();
});

/** Run `body` once per engine, with an empty table. */
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

describe("the file and shared/repull-state.ts say the same words", () => {
  test("the status CHECK lists exactly the states, and the partial index exactly the terminal ones", () => {
    const words = (s: string) => [...s.matchAll(/'([a-z_]+)'/g)].map((m) => m[1] as string);
    const statusCheck = /status TEXT NOT NULL CHECK \(status IN \(([^)]*)\)\)/.exec(SQL);
    expect(words(statusCheck?.[1] ?? "").sort()).toEqual([...REPULL_STATUSES].sort());
    const index =
      /CREATE UNIQUE INDEX upstream_repulls_one_open[^;]*status NOT IN \(([^)]*)\)/.exec(SQL);
    expect(words(index?.[1] ?? "").sort()).toEqual([...TERMINAL_STATUSES].sort());
    const terminalCheck = /\(terminal_at IS NULL\) = \(status NOT IN \(([^)]*)\)\)/.exec(SQL);
    expect(words(terminalCheck?.[1] ?? "").sort()).toEqual([...TERMINAL_STATUSES].sort());
  });

  onEveryEngine("every column an edge writes is a column of the table", async (e) => {
    const columns = new Set(
      (await e.all<{ name: string }>("SELECT name FROM pragma_table_info('upstream_repulls')")).map(
        (c) => c.name,
      ),
    );
    for (const spec of Object.values(TRANSITION_FIELDS)) {
      for (const c of [...spec.may, ...spec.must, ...spec.reset]) {
        if (c !== "counts") expect(columns.has(c)).toBe(true);
      }
    }
    expect(columns.has("counts")).toBe(true);
  });
});

describe("every state accepts the row it should hold", () => {
  for (const status of REPULL_STATUSES) {
    onEveryEngine(`a valid ${status} row is accepted`, async (e) => {
      expect(await insert(e, rowAt(status))).toBeNull();
    });
  }

  onEveryEngine(
    "a re-pull with no N.0.1 completes without a patch tag; one with N.0.1 needs it",
    async (e) => {
      expect(await insert(e, rowAt("complete"))).toBeNull();
      await e.reset();
      const withPatch = {
        patch_version: "2.0.1",
        patch_branch: "release/v2.0.1",
        patch_pr_number: 8,
        patch_head_sha: SHA,
        patch_base_sha: SHA,
        patch_merge_sha: SHA,
      };
      expect(await insert(e, rowAt("complete", withPatch))).toMatch(/CHECK constraint failed/);
      expect(await insert(e, rowAt("complete", { ...withPatch, patch_tag_sha: SHA }))).toBeNull();
    },
  );
});

describe("every stage invariant refuses its violation", () => {
  const CHECK = /CHECK constraint failed/;
  const cases: Array<[string, RepullStatus, Row]> = [
    ["a prepared row without synth_sha", "prepared", { synth_sha: null }],
    ["a prepared row without synth_tree", "prepared", { synth_tree: null }],
    ["a copied row without synth_sha", "copied", { synth_sha: null }],
    ["a patch_declined row without synth_tree", "patch_declined", { synth_tree: null }],
    ["a pr_open row without pr_number", "pr_open", { pr_number: null }],
    ["a pr_open row without branch", "pr_open", { branch: null }],
    ["a pr_open row without head_sha", "pr_open", { head_sha: null }],
    ["a released row without pr_number", "released", { pr_number: null }],
    ["a gates_clear row without gates_sha", "gates_clear", { gates_sha: null }],
    [
      "a patch_gates_clear row without patch_gates_sha",
      "patch_gates_clear",
      { patch_gates_sha: null },
    ],
    ["a merged row without merge_sha", "merged", { merge_sha: null }],
    ["a released row without merge_sha", "released", { merge_sha: null }],
    ["a released row without tag_sha", "released", { tag_sha: null }],
    ["a complete row without tag_sha", "complete", { tag_sha: null }],
    ["a patch_synthesized row without patch_version", "patch_synthesized", { patch_version: null }],
    ["a patch_synthesized row without patch_branch", "patch_synthesized", { patch_branch: null }],
    [
      "a patch_synthesized row without patch_pr_number",
      "patch_synthesized",
      { patch_pr_number: null },
    ],
    [
      "a patch_synthesized row without patch_head_sha",
      "patch_synthesized",
      { patch_head_sha: null },
    ],
    [
      "a patch_synthesized row without patch_base_sha",
      "patch_synthesized",
      { patch_base_sha: null },
    ],
    ["a patch_merged row without patch_merge_sha", "patch_merged", { patch_merge_sha: null }],
    ["a patch_released row without patch_merge_sha", "patch_released", { patch_merge_sha: null }],
    ["an open row with terminal_at set", "pr_open", { terminal_at: "2026-10-24 00:00:00" }],
    ["a planned row with terminal_at set", "planned", { terminal_at: "2026-10-24 00:00:00" }],
    ["a complete row without terminal_at", "complete", { terminal_at: null }],
    ["an abandoned row without terminal_at", "abandoned", { terminal_at: null }],
    ["a patch_declined row without terminal_at", "patch_declined", { terminal_at: null }],
  ];
  for (const [name, status, over] of cases) {
    onEveryEngine(`${name} is refused`, async (e) => {
      expect(await insert(e, rowAt(status, over))).toMatch(CHECK);
    });
  }

  const shape: Array<[string, Row]> = [
    ["an upstream_ds that is not ds and six digits", { upstream_ds: "ds12345" }],
    ["an upstream_ds with a letter", { upstream_ds: "ds00436X" }],
    ["an upstream_ds of seven digits", { upstream_ds: "ds0043621" }],
    ["an upstream_ds of the wrong prefix", { upstream_ds: "on004362" }],
    ["attempt 0", { attempt: 0 }],
    ["a plan_digest of the wrong length", { plan_digest: `sha256:${"0".repeat(63)}` }],
    ["a plan_digest of the wrong prefix", { plan_digest: `sha512:${"0".repeat(64)}` }],
    ["an origin outside the two words", { origin: "worker" }],
    ["a status outside the 17 words", { status: "done", terminal_at: null }],
    ["counts that are not JSON", { counts: "{not json" }],
  ];
  for (const [name, over] of shape) {
    onEveryEngine(`${name} is refused`, async (e) => {
      expect(await insert(e, rowAt("planned", over))).toMatch(CHECK);
    });
  }

  onEveryEngine("a NULL where a NOT NULL column is declared is refused", async (e) => {
    expect(await insert(e, rowAt("planned", { base_sha: null }))).toMatch(
      /NOT NULL constraint failed/,
    );
    expect(await insert(e, rowAt("planned", { plan_digest: null }))).toMatch(
      /NOT NULL constraint failed/,
    );
  });
});

describe("one open row per dataset, and one row per attempt", () => {
  onEveryEngine(
    "a second open row for a dataset is refused, another dataset's is not",
    async (e) => {
      expect(await insert(e, rowAt("planned"))).toBeNull();
      expect(await insert(e, rowAt("planned", { to_tag: "1.0.2" }))).toMatch(
        /UNIQUE constraint failed/,
      );
      expect(await insert(e, rowAt("pr_open", { to_tag: "1.0.2" }))).toMatch(
        /UNIQUE constraint failed/,
      );
      expect(await insert(e, rowAt("planned", { dataset_id: "xx090124" }))).toBeNull();
    },
  );

  onEveryEngine("a terminal row does not hold the slot, whichever of the five it is", async (e) => {
    let attempt = 0;
    for (const status of TERMINAL_STATUSES) {
      attempt++;
      expect(await insert(e, rowAt(status, { attempt }))).toBeNull();
    }
    expect(await insert(e, rowAt("planned", { attempt: attempt + 1 }))).toBeNull();
    expect(await insert(e, rowAt("planned", { attempt: attempt + 2 }))).toMatch(
      /UNIQUE constraint failed/,
    );
  });

  onEveryEngine("(dataset_id, to_tag, attempt) is unique even among terminal rows", async (e) => {
    expect(await insert(e, rowAt("abandoned"))).toBeNull();
    expect(await insert(e, rowAt("failed"))).toMatch(/UNIQUE constraint failed/);
    expect(await insert(e, rowAt("failed", { attempt: 2 }))).toBeNull();
  });

  onEveryEngine("an update that would open a second row is refused too", async (e) => {
    expect(await insert(e, rowAt("planned"))).toBeNull();
    expect(await insert(e, rowAt("abandoned", { attempt: 2 }))).toBeNull();
    expect(
      await e.run(
        "UPDATE upstream_repulls SET status = 'planned', terminal_at = NULL WHERE attempt = 2",
      ),
    ).toMatch(/UNIQUE constraint failed/);
  });
});

describe("what D1 must support for the service", () => {
  onEveryEngine("json_patch merges counts key by key", async (e) => {
    expect(await insert(e, rowAt("planned", { counts: '{"written":1,"deleted":2}' }))).toBeNull();
    expect(
      await e.run(
        "UPDATE upstream_repulls SET counts = json_patch(counts, ?)",
        '{"deleted":5,"copied":0}',
      ),
    ).toBeNull();
    const [row] = await e.all<{ counts: string }>("SELECT counts FROM upstream_repulls");
    expect(JSON.parse(row?.counts ?? "{}")).toEqual({ written: 1, deleted: 5, copied: 0 });
  });

  onEveryEngine("the indexes exist", async (e) => {
    const names = (
      await e.all<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'upstream_repulls'",
      )
    ).map((r) => r.name);
    for (const n of [
      "upstream_repulls_one_open",
      "upstream_repulls_merge_claims",
      "upstream_repulls_patch_claims",
    ]) {
      expect(names).toContain(n);
    }
  });
});
