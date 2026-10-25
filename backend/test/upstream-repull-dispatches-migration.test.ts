/**
 * Migration 0109_upstream_repull_automatic.sql (epic #1046 phase 7, #1913; ADR 0111, decisions 6
 * and 7), on two engines: bun:sqlite, which every other suite uses, and Miniflare's D1, the
 * implementation `wrangler --local` runs. bun:sqlite is more permissive than the SQLite D1 ships
 * (a GLOB that D1 calls too complex, a construct it compiles differently), so a CHECK, a partial
 * index or a statement proven only on the first is not proven.
 *
 * What is pinned: the words in the file are the words of `shared/repull-state.ts`; every CHECK of
 * the dispatch table refuses its violating row and accepts its valid one; one live dispatch per
 * dataset; the scheduler has exactly one row; the hold columns take a fixed word on an automatic
 * row only, set together; and the dataset cascade removes the dispatches.
 */

import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Miniflare } from "miniflare";
import {
  DISPATCH_KINDS,
  DISPATCH_LIVE,
  DISPATCH_STATUSES,
  FIXED_WORD_RE,
} from "../../shared/repull-state";
import { deleteDatasetCascade } from "../src/services/deletion";
import type { Bindings } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";
import { MIGRATIONS_DIR, applyMigrations, migrationFiles } from "./helpers/miniflare-d1";
import { startRepullGitHub } from "./helpers/repull-github-standin";
import { type Row, rowAt } from "./helpers/repull-rows";

const FILE = "0109_upstream_repull_automatic.sql";
const SQL = readFileSync(join(MIGRATIONS_DIR, FILE), "utf-8");
const NONCE = "0f4b8e3c-7a1d-4c2e-9b6f-1d2e3f4a5b6c";
const RUN_URL = "https://github.com/nemarDatasets/.github/actions/runs/123456789";

interface Engine {
  name: string;
  run(sql: string, ...binds: unknown[]): Promise<string | null>;
  all<T>(sql: string, ...binds: unknown[]): Promise<T[]>;
  reset(): Promise<void>;
}

const LIVE = new Set<string>(DISPATCH_LIVE);

/** A dispatch row that satisfies every CHECK for `status`, laid over with `over`. */
function dispatch(status: string, over: Row = {}): Row {
  const reported = !["dispatched", "dispatch_failed", "unreported"].includes(status);
  return {
    kind: status === "finished" ? "finish" : "open",
    dataset_id: "on099991",
    upstream_ds: "ds099991",
    from_tag: "1.0.0",
    to_tag: "1.0.1",
    repull_id: status === "opened" || status === "finished" ? 7 : null,
    nonce: LIVE.has(status) ? NONCE : null,
    status,
    code: ["refused", "failed", "dispatch_failed"].includes(status) ? "runner-failed" : null,
    reported_at: reported ? "2026-10-25 03:10:00" : null,
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
      db.exec("DELETE FROM upstream_repull_dispatches; DELETE FROM upstream_repulls;");
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
      await d1.prepare("DELETE FROM upstream_repull_dispatches").run();
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
const UNIQUE = /UNIQUE constraint failed/;
const words = (s: string) => [...s.matchAll(/'([a-z0-9_-]+)'/g)].map((m) => m[1] as string);

describe("the file says the shared words", () => {
  test("the kinds and the states are the shared ones", () => {
    const kinds = /kind TEXT NOT NULL CHECK \(kind IN \(([^)]*)\)\)/.exec(SQL);
    expect(words(kinds?.[1] ?? "").sort()).toEqual([...DISPATCH_KINDS].sort());
    const states = /status TEXT NOT NULL CHECK \(status IN \(([^)]*)\)\)/.exec(SQL);
    expect(words(states?.[1] ?? "").sort()).toEqual([...DISPATCH_STATUSES].sort());
  });

  test("the nonce is held exactly in the live states", () => {
    const live = /CHECK \(\(nonce IS NOT NULL\) = \(status IN \(([^)]*)\)\)\)/.exec(SQL);
    expect(words(live?.[1] ?? "").sort()).toEqual([...DISPATCH_LIVE].sort());
  });

  test("the word columns take what FIXED_WORD_RE takes", () => {
    // The pattern and the GLOB are one rule: a lowercase word of letters, digits and hyphens,
    // from 1 to 64 characters. The CHECKs below are proven on the engines; this pins the regex.
    expect(FIXED_WORD_RE.source).toBe("^[a-z0-9-]{1,64}$");
  });
});

describe("every dispatch state holds what it should", () => {
  onEveryEngine("a valid row of every state is accepted", async (e) => {
    for (const [i, status] of DISPATCH_STATUSES.entries()) {
      // One live dispatch per dataset, so each row is its own dataset.
      const row = dispatch(status, { dataset_id: `on09998${i}` });
      expect([status, await insertRow(e, "upstream_repull_dispatches", row)]).toEqual([
        status,
        null,
      ]);
    }
  });

  onEveryEngine("a finish dispatch, a resume and a run URL are accepted", async (e) => {
    const rows = [
      dispatch("dispatched", { kind: "finish", repull_id: 7, dataset_id: "on099981" }),
      dispatch("dispatched", { repull_id: 9, dataset_id: "on099982" }),
      dispatch("started", { workflow_run_url: RUN_URL, dataset_id: "on099983" }),
      dispatch("refused", { code: "a", dataset_id: "on099984" }),
      dispatch("refused", { code: "z".repeat(64), dataset_id: "on099985" }),
      dispatch("failed", { from_tag: "00001", to_tag: "2.1.0-rc1", dataset_id: "on099986" }),
    ];
    for (const row of rows)
      expect(await insertRow(e, "upstream_repull_dispatches", row)).toBeNull();
  });

  const refused: Array<[string, string, Row]> = [
    ["a kind outside the two", "dispatched", { kind: "close" }],
    ["an xx dataset", "dispatched", { dataset_id: "xx090123" }],
    ["an nm dataset", "dispatched", { dataset_id: "nm000103" }],
    ["a dataset id of five digits", "dispatched", { dataset_id: "on12345" }],
    ["a dataset id in capitals", "dispatched", { dataset_id: "ON004362" }],
    ["a ds of five digits", "dispatched", { upstream_ds: "ds12345" }],
    ["a tag with a slash", "dispatched", { to_tag: "refs/heads" }],
    ["a tag with a space", "dispatched", { from_tag: "1.0 0" }],
    ["an empty tag", "dispatched", { to_tag: "" }],
    ["a tag of 65 characters", "dispatched", { to_tag: "1".repeat(65) }],
    ["the same tag twice", "dispatched", { to_tag: "1.0.0" }],
    ["a re-pull id of 0", "dispatched", { repull_id: 0 }],
    ["a live dispatch without its nonce", "dispatched", { nonce: null }],
    ["a started dispatch without its nonce", "started", { nonce: null }],
    ["a short nonce", "dispatched", { nonce: "abc" }],
    ["a nonce on an ended dispatch", "opened", { nonce: NONCE }],
    ["a nonce on an unreported dispatch", "unreported", { nonce: NONCE }],
    ["a state outside the words", "running", { nonce: null }],
    ["a code in capitals", "refused", { code: "Bad-Code" }],
    ["a code with a slash", "refused", { code: "a/b" }],
    ["a code with a space", "refused", { code: "a b" }],
    ["a code with a dot", "refused", { code: "sub-01.edf" }],
    ["an empty code", "refused", { code: "" }],
    ["a code of 65 characters", "refused", { code: "a".repeat(65) }],
    ["a refusal without a code", "refused", { code: null }],
    ["a failure without a code", "failed", { code: null }],
    ["a send failure without a code", "dispatch_failed", { code: null }],
    ["a finish without its re-pull", "dispatched", { kind: "finish", repull_id: null }],
    ["an opened finish", "opened", { kind: "finish" }],
    ["an opened dispatch without its re-pull", "opened", { repull_id: null }],
    ["a finished open dispatch", "finished", { kind: "open" }],
    ["a report without its time", "started", { reported_at: null }],
    ["an ended run without its report time", "opened", { reported_at: null }],
    ["a time on a dispatch that never reported", "dispatched", { reported_at: "2026-10-25" }],
    ["a time on a dispatch that never ran", "dispatch_failed", { reported_at: "2026-10-25" }],
    ["a run URL on another host", "started", { workflow_run_url: "https://example.org/x" }],
    [
      "a run URL of another repository",
      "started",
      { workflow_run_url: "https://github.com/nemarDatasets/on099991/actions/runs/1" },
    ],
    ["a run URL over http", "started", { workflow_run_url: RUN_URL.replace("https", "http") }],
    ["a run URL with no run", "started", { workflow_run_url: RUN_URL.replace(/\d+$/, "") }],
    ["a run URL with a path after it", "started", { workflow_run_url: `${RUN_URL}/x` }],
    ["a run URL of 75 characters", "started", { workflow_run_url: `${RUN_URL}${"1".repeat(12)}` }],
  ];
  for (const [name, status, over] of refused) {
    onEveryEngine(`${name} is refused`, async (e) => {
      expect(await insertRow(e, "upstream_repull_dispatches", dispatch(status, over))).toMatch(
        CHECK,
      );
    });
  }
});

describe("one live dispatch per dataset", () => {
  onEveryEngine(
    "a second live dispatch of a dataset is refused until the first ends",
    async (e) => {
      expect(await insertRow(e, "upstream_repull_dispatches", dispatch("dispatched"))).toBeNull();
      const second = dispatch("started", { kind: "finish", repull_id: 7, nonce: `${NONCE}x` });
      expect(await insertRow(e, "upstream_repull_dispatches", second)).toMatch(UNIQUE);
      // Another dataset is live on its own, and ended dispatches of this one do not count.
      expect(
        await insertRow(
          e,
          "upstream_repull_dispatches",
          dispatch("dispatched", { dataset_id: "on099981" }),
        ),
      ).toBeNull();
      expect(await insertRow(e, "upstream_repull_dispatches", dispatch("refused"))).toBeNull();
      expect(
        await e.run(
          "UPDATE upstream_repull_dispatches SET status = 'unreported', nonce = NULL WHERE dataset_id = 'on099991' AND status = 'dispatched'",
        ),
      ).toBeNull();
      expect(await insertRow(e, "upstream_repull_dispatches", second)).toBeNull();
    },
  );

  onEveryEngine("the indexes exist", async (e) => {
    const names = (
      await e.all<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'upstream_repull_dispatches'",
      )
    ).map((r) => r.name);
    for (const n of [
      "upstream_repull_dispatches_one_live",
      "upstream_repull_dispatches_day",
      "upstream_repull_dispatches_dataset",
      "upstream_repull_dispatches_repull",
    ]) {
      expect(names).toContain(n);
    }
  });
});

describe("the scheduler's one row", () => {
  onEveryEngine("it exists, and a second row is refused", async (e) => {
    expect(await e.all("SELECT * FROM upstream_repull_scheduler")).toEqual([
      { id: 1, scan_after: "", last_tick_at: null, last_outcome: null, last_advance_at: null },
    ]);
    expect(await e.run("INSERT INTO upstream_repull_scheduler (id) VALUES (2)")).toMatch(CHECK);
    expect(await e.run("INSERT INTO upstream_repull_scheduler (id) VALUES (1)")).toMatch(
      /UNIQUE constraint failed|PRIMARY KEY/,
    );
  });

  onEveryEngine("its outcome is a fixed word", async (e) => {
    const set = (v: string | null) =>
      e.run("UPDATE upstream_repull_scheduler SET last_outcome = ? WHERE id = 1", v);
    expect(await set("cap-reached")).toBeNull();
    expect(await set(null)).toBeNull();
    for (const bad of ["Cap Reached", "a/b", "", "a".repeat(65)]) {
      expect([bad, await set(bad)]).toEqual([bad, expect.stringMatching(CHECK)]);
    }
  });
});

describe("the hold columns of upstream_repulls", () => {
  onEveryEngine("an automatic row takes a word and its time together", async (e) => {
    const automatic = rowAt("pr_open", { origin: "automatic", dataset_id: "on099991" });
    expect(
      await insertRow(e, "upstream_repulls", {
        ...automatic,
        hold_reason: "bids-failed",
        hold_since: "2026-10-25 03:00:00",
      }),
    ).toBeNull();
    expect(
      await e.run("UPDATE upstream_repulls SET hold_reason = NULL, hold_since = NULL"),
    ).toBeNull();
    // A row with neither (every administrator row, and every existing row) is unchanged.
    expect(
      await insertRow(e, "upstream_repulls", rowAt("pr_open", { dataset_id: "xx090124" })),
    ).toBeNull();
  });

  const refused: Array<[string, Row]> = [
    ["a hold in words", { hold_reason: "Bids Failed", hold_since: "2026-10-25" }],
    ["an empty hold", { hold_reason: "", hold_since: "2026-10-25" }],
    ["a hold of 65 characters", { hold_reason: "a".repeat(65), hold_since: "2026-10-25" }],
    ["a hold without its time", { hold_reason: "bids-failed", hold_since: null }],
    ["a time without a hold", { hold_reason: null, hold_since: "2026-10-25" }],
  ];
  for (const [name, over] of refused) {
    onEveryEngine(`${name} is refused`, async (e) => {
      const row = rowAt("pr_open", { origin: "automatic", dataset_id: "on099991", ...over });
      expect(await insertRow(e, "upstream_repulls", row)).toMatch(CHECK);
    });
  }

  onEveryEngine("an administrator's row is never held", async (e) => {
    const row = rowAt("pr_open", { hold_reason: "bids-failed", hold_since: "2026-10-25" });
    expect(await insertRow(e, "upstream_repulls", row)).toMatch(CHECK);
  });
});

describe("the dataset cascade", () => {
  test("deleteDatasetCascade removes the dataset's dispatches, rowless ones included, and no other dataset's", async () => {
    const db = freshDb();
    db.run(
      "INSERT INTO users (username, email, password_hash, status, role, email_verified) VALUES ('rpldisp', 'rpldisp@example.org', 'x', 'approved', 'admin', 1)",
    );
    for (const id of ["on099991", "on099992"]) {
      db.run(
        "INSERT INTO datasets (dataset_id, name, owner_user_id, source, source_id) VALUES (?, ?, 1, 'openneuro', 'ds099991')",
        [id, id],
      );
    }
    const insert = (table: string, row: Row) => {
      const cols = Object.keys(row);
      db.query(
        `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
      ).run(...(cols.map((c) => row[c]) as never[]));
    };
    // One with no re-pull row at all (a run refused before its create), one live, one of the other.
    insert("upstream_repull_dispatches", dispatch("refused"));
    insert("upstream_repull_dispatches", dispatch("dispatched"));
    insert("upstream_repull_dispatches", dispatch("dispatched", { dataset_id: "on099992" }));
    // Only an `on` dataset has dispatches, and a non-production Worker refuses to cascade one (the
    // repository is shared with production), so this runs as production. The cascade deletes the
    // GitHub repository first: a loopback stand-in answers it, and the id is one no mirror holds.
    const gh = startRepullGitHub();
    let result: Awaited<ReturnType<typeof deleteDatasetCascade>>;
    try {
      result = await deleteDatasetCascade(
        realD1(db),
        {
          ENVIRONMENT: "production",
          GITHUB_ADMIN_PAT: "ghp_dispatch_cascade",
        } as unknown as Bindings,
        "on099991",
        { skipS3: true },
      );
      expect(gh.requests).toEqual(["DELETE /repos/nemarDatasets/on099991"]);
    } finally {
      gh.stop();
    }
    expect(result.steps.d1.success).toBe(true);
    expect(db.query("SELECT dataset_id FROM upstream_repull_dispatches").all()).toEqual([
      { dataset_id: "on099992" },
    ]);
  });
});
