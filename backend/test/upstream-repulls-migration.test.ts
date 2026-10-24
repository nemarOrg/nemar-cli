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
import {
  createRepull,
  createRepullSchema,
  isRefusal,
  listRepulls,
  transitionRepull,
} from "../src/services/upstream-repull";
import type { Bindings } from "../src/types/bindings";
import { freshDb } from "./helpers/d1";
import { MIGRATIONS_DIR, applyMigrations, migrationFiles } from "./helpers/miniflare-d1";
import { DIGEST, type Row, SHA, rowAt } from "./helpers/repull-rows";

const FILE = "0105_upstream_repulls.sql";
const SQL = readFileSync(join(MIGRATIONS_DIR, FILE), "utf-8");

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

  onEveryEngine("a claim to merge is accepted when its time and sha come together", async (e) => {
    const held = { merge_claimed_at: "2026-10-24 01:00:00", merge_claim_sha: SHA };
    expect(await insert(e, rowAt("gates_clear", held))).toBeNull();
    await e.reset();
    const patchHeld = {
      patch_merge_claimed_at: "2026-10-24 01:00:00",
      patch_merge_claim_sha: SHA,
    };
    expect(await insert(e, rowAt("patch_gates_clear", patchHeld))).toBeNull();
  });

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
    ["a patch_released row without patch_tag_sha", "patch_released", { patch_tag_sha: null }],
    ["a negative revision", "planned", { revision: -1 }],
    ["a claim time without its sha", "gates_clear", { merge_claimed_at: "2026-10-24 01:00:00" }],
    ["a claim sha without its time", "gates_clear", { merge_claim_sha: SHA }],
    [
      "a patch claim time without its sha",
      "patch_gates_clear",
      { patch_merge_claimed_at: "2026-10-24 01:00:00" },
    ],
    ["a patch claim sha without its time", "patch_gates_clear", { patch_merge_claim_sha: SHA }],
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
      // A different tag each time: a merge is recorded once per tag (the next test).
      expect(await insert(e, rowAt(status, { attempt, to_tag: `1.0.${attempt}` }))).toBeNull();
    }
    expect(await insert(e, rowAt("planned", { attempt: attempt + 1 }))).toBeNull();
    expect(await insert(e, rowAt("planned", { attempt: attempt + 2 }))).toMatch(
      /UNIQUE constraint failed/,
    );
  });

  onEveryEngine(
    "a tag is merged once: a second row with a merge sha for it is refused",
    async (e) => {
      expect(await insert(e, rowAt("complete"))).toBeNull();
      // Another attempt at the same tag may exist; it may not also hold a merge.
      expect(await insert(e, rowAt("complete", { attempt: 2 }))).toMatch(
        /UNIQUE constraint failed/,
      );
      expect(await insert(e, rowAt("failed", { attempt: 2, merge_sha: SHA }))).toMatch(
        /UNIQUE constraint failed/,
      );
      expect(await insert(e, rowAt("failed", { attempt: 2 }))).toBeNull();
      // Another tag merges freely, and a flow that moves on to the next attempt is not blocked.
      expect(await insert(e, rowAt("complete", { attempt: 3, to_tag: "1.0.2" }))).toBeNull();
      expect(await insert(e, rowAt("planned", { attempt: 4, to_tag: "1.0.3" }))).toBeNull();
      // Another dataset merges the same tag freely.
      expect(await insert(e, rowAt("complete", { dataset_id: "xx090124" }))).toBeNull();
    },
  );

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

describe("the service on D1", () => {
  const PLAN = {
    dataset_id: "xx090123",
    upstream_ds: "ds099999",
    from_tag: "1.0.0",
    to_tag: "1.0.1",
    from_version: "1.0.0",
    to_version: "2.0.0",
    plan_digest: DIGEST,
    planner: 2,
    base_sha: SHA,
    lineage_recordable: true,
    counts: { delta_paths: 4 },
  };

  test("create, lineage, audit, transition and the open-slot index behave as on SQLite", async () => {
    const d1 = await mf.getD1Database("DB");
    // D1 enforces foreign keys: the dataset's owner and the audit row's actor are a real user.
    await d1
      .prepare(
        "INSERT OR IGNORE INTO users (username, email, password_hash, status, role, email_verified) VALUES ('rplminiflare', 'rplminiflare@example.org', 'x', 'approved', 'admin', 1)",
      )
      .run();
    const user = await d1
      .prepare("SELECT id FROM users WHERE username = 'rplminiflare'")
      .first<{ id: number }>();
    const ADMIN = { id: user?.id ?? 0 };
    await d1.prepare("DELETE FROM upstream_repulls").run();
    await d1.prepare("DELETE FROM dataset_versions WHERE dataset_id = 'xx090123'").run();
    await d1.prepare("DELETE FROM datasets WHERE dataset_id = 'xx090123'").run();
    await d1.prepare("DELETE FROM audit_log WHERE action LIKE 'repull_%'").run();
    await d1
      .prepare(
        "INSERT INTO datasets (dataset_id, name, owner_user_id, source, source_id) VALUES ('xx090123', 'x', ?, 'openneuro', 'ds099999')",
      )
      .bind(ADMIN.id)
      .run();
    await d1
      .prepare(
        "INSERT INTO dataset_versions (dataset_id, version, doi, source_version, source_version_basis) VALUES ('xx090123', 'v1.0.0', '10.5072/x', '1.0.0', 'doi')",
      )
      .run();
    const env = { DB: d1, ENVIRONMENT: "test" } as unknown as Bindings;

    const made = await createRepull(env, ADMIN, createRepullSchema.parse(PLAN));
    if (isRefusal(made)) throw new Error(`refused: ${made.code}`);
    expect(made).toMatchObject({
      created: true,
      lineage_rows: 1,
      row: { status: "planned", attempt: 1, revision: 0, counts: { delta_paths: 4 } },
    });

    const lineage = await d1
      .prepare(
        "SELECT source_version, source_version_basis FROM dataset_versions WHERE dataset_id = 'xx090123'",
      )
      .first();
    expect(lineage).toEqual({ source_version: "1.0.0", source_version_basis: "lineage" });
    const audit = await d1
      .prepare("SELECT resource_id, details FROM audit_log WHERE action = 'repull_created'")
      .first<{ resource_id: string; details: string }>();
    expect(audit?.resource_id).toBe(String(made.row.id));
    expect(JSON.parse(audit?.details ?? "{}")).toMatchObject({ lineage_rows: 1 });

    const again = await createRepull(env, ADMIN, createRepullSchema.parse(PLAN));
    expect(again).toMatchObject({ created: false, row: { id: made.row.id } });

    const moved = await transitionRepull(env, ADMIN, made.row.id, {
      from: "planned",
      to: "prepared",
      fields: { synth_tree: SHA, synth_sha: SHA, manifest_digest: DIGEST, counts: { written: 2 } },
    });
    if (isRefusal(moved)) throw new Error(`refused: ${moved.code}`);
    expect(moved.row).toMatchObject({
      status: "prepared",
      revision: 1,
      counts: { delta_paths: 4, written: 2 },
    });
    const stale = await transitionRepull(env, ADMIN, made.row.id, {
      from: "planned",
      to: "prepared",
      fields: {},
    });
    expect(stale).toMatchObject({ code: "stale-status", status: 409 });
    const transitions = await d1
      .prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'repull_transition'")
      .first<{ n: number }>();
    expect(transitions?.n).toBe(1);

    const closed = await transitionRepull(env, ADMIN, made.row.id, {
      from: "prepared",
      to: "abandoned",
    });
    if (isRefusal(closed)) throw new Error(`refused: ${closed.code}`);
    expect(closed.row.terminal_at).not.toBeNull();
    const second = await createRepull(env, ADMIN, createRepullSchema.parse(PLAN));
    expect(second).toMatchObject({ created: true, row: { attempt: 2 } });
    const list = await listRepulls(d1, { dataset: "xx090123", open: true });
    expect(list.map((r) => r.attempt)).toEqual([2]);
  });
  test("a claim to merge, the revision check and the unreconciled-merge rule behave as on SQLite", async () => {
    const d1 = await mf.getD1Database("DB");
    await d1.prepare("DELETE FROM upstream_repulls").run();
    const user = await d1
      .prepare("SELECT id FROM users WHERE username = 'rplminiflare'")
      .first<{ id: number }>();
    const admin = { id: user?.id ?? 0 };
    const env = { DB: d1, ENVIRONMENT: "test" } as unknown as Bindings;
    // The claim re-reads the dataset fences: the row names the mirror the dataset row records.
    const row = rowAt("gates_clear", {
      dataset_id: "xx090123",
      upstream_ds: "ds099999",
      actor_user_id: admin.id,
    });
    const cols = Object.keys(row);
    const inserted = await d1
      .prepare(
        `INSERT INTO upstream_repulls (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")}) RETURNING id`,
      )
      .bind(...cols.map((c) => row[c]))
      .first<{ id: number }>();
    const id = inserted?.id ?? 0;

    const claim = await transitionRepull(env, admin, id, {
      from: "gates_clear",
      to: "gates_clear",
      fields: { merge_claim_sha: SHA },
    });
    if (isRefusal(claim)) throw new Error(`refused: ${claim.code}`);
    expect(claim.row.merge_claimed_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(claim.row).toMatchObject({ merge_claim_sha: SHA, revision: 1 });
    for (const to of ["abandoned", "pr_open"] as const) {
      const refused = await transitionRepull(env, admin, id, {
        from: "gates_clear",
        to,
        fields: to === "pr_open" ? { branch: "release/v2.0.0", pr_number: 7, head_sha: SHA } : {},
      });
      expect(refused).toMatchObject({ code: "merge-claim-held", status: 409 });
    }
    const failed = await transitionRepull(env, admin, id, {
      from: "gates_clear",
      to: "failed",
      error: "merge answer lost",
    });
    if (isRefusal(failed)) throw new Error(`refused: ${failed.code}`);
    expect(failed.row).toMatchObject({ status: "failed", revision: 2 });

    // The dataset holds a claim nothing reconciled, so no new record opens for any tag.
    const blocked = await createRepull(
      env,
      admin,
      createRepullSchema.parse({ ...PLAN, to_tag: "1.0.7" }),
    );
    expect(blocked).toMatchObject({ code: "merge-unreconciled", status: 409 });
  });
});
