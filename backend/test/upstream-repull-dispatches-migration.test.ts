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
 * row only, set together; the dataset cascade removes the dispatches; and the dispatch service's
 * own statements (the claim with its cap, the audit row, the report, the watchdog and the link)
 * run on D1 as they do on SQLite.
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
import {
  DISPATCH_LINK_BY_KEY_SQL,
  DISPATCH_LINK_GUARD_SQL,
  claimFinishDispatch,
  claimOpenDispatch,
  storeDispatchReport,
  sweepUnreportedDispatches,
} from "../src/services/upstream-repull-dispatch";
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
let d1: D1Database;

beforeAll(async () => {
  ENGINES.push(sqliteEngine());
  mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response(null, { status: 204 }); } };",
    compatibilityDate: "2024-12-01",
    d1Databases: ["DB"],
  });
  d1 = await mf.getD1Database("DB");
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

describe("the dispatch service's own statements on D1", () => {
  const SECRET = "dispatch-migration-test-secret";

  test("the claim, its audit row, the link, the report, the finish and the watchdog run on D1", async () => {
    for (const t of ["upstream_repull_dispatches", "upstream_repulls", "audit_log"]) {
      await d1.prepare(`DELETE FROM ${t}`).run();
    }
    const env = {
      DB: d1,
      ENVIRONMENT: "production",
      AUTO_REPULL_ENABLED: "1",
      REPULL_DAILY_OPEN_CAP: "1",
      PRESCREEN_CALLBACK_SECRET: SECRET,
    } as unknown as Bindings;
    const candidate = {
      datasetId: "on099991",
      upstreamDs: "ds099991",
      fromTag: "v1.0.0",
      toTag: "1.0.1",
    };

    // The claim: INSERT ... SELECT with the day's count and the CASE on the re-pull rows.
    const claim = await claimOpenDispatch(env, candidate);
    if (!("id" in claim)) throw new Error(`refused: ${claim.refused}`);
    // The cap of 1 is used, and a refused claim wrote nothing (another dataset, so not `live`).
    expect(await claimOpenDispatch(env, { ...candidate, datasetId: "on099992" })).toEqual({
      refused: "cap",
    });
    const rows = (await d1.prepare("SELECT * FROM upstream_repull_dispatches").all()).results;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "open", from_tag: "1.0.0", status: "dispatched" });
    const audit = (
      await d1
        .prepare(
          "SELECT action, resource_id, details FROM audit_log WHERE action = 'repull_dispatch'",
        )
        .all<{ action: string; resource_id: string; details: string }>()
    ).results;
    expect(audit).toEqual([
      expect.objectContaining({ action: "repull_dispatch", resource_id: String(claim.id) }),
    ]);

    // The link by key, as the automatic create's batch runs it.
    const repull = await d1
      .prepare(
        "INSERT INTO upstream_repulls (dataset_id, upstream_ds, from_tag, to_tag, attempt, from_version, to_version, plan_digest, planner, origin, actor_user_id, status, base_sha, synth_tree, synth_sha, branch, pr_number, head_sha) VALUES ('on099991', 'ds099991', '1.0.0', '1.0.1', 1, '1.0.0', '2.0.0', ?, 2, 'automatic', 1, 'pr_open', ?, ?, ?, 'release/v2.0.0', 3, ?) RETURNING id",
      )
      .bind(
        `sha256:${"0".repeat(64)}`,
        "a".repeat(40),
        "b".repeat(40),
        "a".repeat(40),
        "a".repeat(40),
      )
      .first<{ id: number }>();
    const claimNonce = (
      await d1
        .prepare("SELECT nonce FROM upstream_repull_dispatches WHERE id = ?")
        .bind(claim.id)
        .first<{ nonce: string }>()
    )?.nonce;
    const link = await d1
      .prepare(DISPATCH_LINK_BY_KEY_SQL)
      .bind("on099991", "1.0.1", 1, claim.id, claimNonce)
      .run();
    expect(link.meta.changes).toBe(1);

    // The report: the correlated EXISTS on the re-pull row.
    const report = (phase: string, extra: Record<string, unknown> = {}) =>
      storeDispatchReport(env, claim.token, {
        dispatch_id: claim.id,
        dataset_id: "on099991",
        phase,
        ...extra,
      });
    expect(await report("started", { workflow_run_url: RUN_URL })).toEqual({
      status: 200,
      code: "stored",
    });
    expect(await report("opened", { repull_id: repull?.id })).toEqual({
      status: 200,
      code: "stored",
    });
    expect(await report("failed", { code: "runner-failed" })).toEqual({
      status: 401,
      code: "invalid-token",
    });
    expect(
      await d1
        .prepare("SELECT status, nonce, workflow_run_url FROM upstream_repull_dispatches")
        .first(),
    ).toEqual({ status: "opened", nonce: null, workflow_run_url: RUN_URL });

    // The finish: INSERT ... SELECT from the re-pull row.
    await d1
      .prepare("UPDATE upstream_repulls SET status = 'merged', merge_sha = ? WHERE id = ?")
      .bind("c".repeat(40), repull?.id)
      .run();
    const finish = await claimFinishDispatch(env, {
      id: repull?.id as number,
      dataset_id: "on099991",
      origin: "automatic",
      status: "merged",
      from_tag: "1.0.0",
      to_tag: "1.0.1",
    });
    expect("id" in finish).toBe(true);

    // The watchdog: datetime('now', '-8 hours'), and its audit row with changes().
    await d1
      .prepare(
        "UPDATE upstream_repull_dispatches SET dispatched_at = datetime('now', '-9 hours') WHERE kind = 'finish'",
      )
      .run();
    expect(await sweepUnreportedDispatches(env)).toEqual({ marked: 1 });
    expect(await sweepUnreportedDispatches(env)).toEqual({ marked: 0 });
    const marked = (
      await d1
        .prepare("SELECT details FROM audit_log WHERE action = 'repull_dispatch_unreported'")
        .all<{ details: string }>()
    ).results;
    expect(marked.map((r) => JSON.parse(r.details))).toEqual([{ marked: 1, deadline_hours: 8 }]);
  });
});

describe("the claim's refusals under concurrency, on D1", () => {
  const SECRET = "dispatch-migration-race-secret";
  const base = {
    DB: undefined as unknown as D1Database,
    ENVIRONMENT: "production",
    AUTO_REPULL_ENABLED: "1",
    PRESCREEN_CALLBACK_SECRET: SECRET,
  };
  const cand = (id: string) => ({
    datasetId: id,
    upstreamDs: "ds099991",
    fromTag: "1.0.0",
    toTag: "1.0.1",
  });
  const word = (r: Awaited<ReturnType<typeof claimOpenDispatch>>) =>
    "id" in r ? "won" : r.refused;

  async function clean() {
    for (const t of ["upstream_repull_dispatches", "upstream_repulls", "audit_log"]) {
      await d1.prepare(`DELETE FROM ${t}`).run();
    }
  }

  test("three claims racing for one unit of the cap: one wins, two are cap, and only the winner wrote", async () => {
    await clean();
    const env = { ...base, DB: d1, REPULL_DAILY_OPEN_CAP: "1" } as unknown as Bindings;
    const race = await Promise.all(
      ["on099991", "on099992", "on099993"].map((id) => claimOpenDispatch(env, cand(id))),
    );
    expect(race.map(word).sort()).toEqual(["cap", "cap", "won"]);
    expect(
      (await d1.prepare("SELECT status FROM upstream_repull_dispatches").all()).results,
    ).toHaveLength(1);
    expect(
      (await d1.prepare("SELECT id FROM audit_log WHERE action = 'repull_dispatch'").all()).results,
    ).toHaveLength(1);
  });

  test("two claims of one dataset with the cap to spare: the unique index answers, and D1's error reads live", async () => {
    await clean();
    const env = { ...base, DB: d1, REPULL_DAILY_OPEN_CAP: "5" } as unknown as Bindings;
    const race = await Promise.all([
      claimOpenDispatch(env, cand("on099991")),
      claimOpenDispatch(env, cand("on099991")),
    ]);
    expect(race.map(word).sort()).toEqual(["live", "won"]);
    expect(
      (await d1.prepare("SELECT status FROM upstream_repull_dispatches").all()).results,
    ).toHaveLength(1);
    // The refused claim left no audit row of its own.
    expect(
      (await d1.prepare("SELECT id FROM audit_log WHERE action = 'repull_dispatch'").all()).results,
    ).toHaveLength(1);
  });

  test("the link's guard raises integer overflow on D1 only when the link changed nothing, and rolls the batch back", async () => {
    await clean();
    await d1
      .prepare(
        "INSERT INTO upstream_repull_dispatches (kind, dataset_id, upstream_ds, from_tag, to_tag, nonce, status) VALUES ('open', 'on099991', 'ds099991', '1.0.0', '1.0.1', ?, 'dispatched')",
      )
      .bind(NONCE)
      .run();
    const linkAnd = (nonce: string) => [
      d1.prepare(
        "INSERT INTO audit_log (user_id, action, resource_type) VALUES (NULL, 'guard-probe', 'probe')",
      ),
      d1
        .prepare(
          "UPDATE upstream_repull_dispatches SET repull_id = 9 WHERE nonce = ? AND repull_id IS NULL",
        )
        .bind(nonce),
      d1.prepare(DISPATCH_LINK_GUARD_SQL),
    ];
    // A link that changed a row passes the guard.
    await d1.batch(linkAnd(NONCE));
    expect(
      (await d1.prepare("SELECT id FROM audit_log WHERE action = 'guard-probe'").all()).results,
    ).toHaveLength(1);
    // A link that changed none (already linked) fails it, and the audit row before it is undone.
    await d1.prepare("DELETE FROM audit_log").run();
    await expect(d1.batch(linkAnd(NONCE))).rejects.toThrow(/integer overflow/i);
    expect(
      (await d1.prepare("SELECT id FROM audit_log WHERE action = 'guard-probe'").all()).results,
    ).toHaveLength(0);
  });
});
