/**
 * `nemar admin repull auto` (ADR 0111, the Phase 7h slice; epic #1046 phase 7, #1913), driven
 * through the real entry point against the REAL routes: the Worker's `/admin/repulls` routes behind
 * their real auth and admin middleware, over real SQLite carrying every migration, served on a
 * loopback port and reached through TEST_API_URL. Nothing is canned: what the command prints is what
 * `GET /admin/repulls/switches`, `/admin/repulls/dispatches` and `/admin/repulls?open=1` answer.
 *
 * The properties, each with a test of its own:
 *  - it shows the switches and both caps as the Worker reads them, an unreadable cap as unreadable,
 *    the scheduler's stamps without its cursor, the open AUTOMATIC re-pulls with the word each is
 *    held for, and the recent dispatches, by dataset and id (an administrator's read);
 *  - it reads every page of open re-pulls (an administrator's re-pull among them is not listed),
 *    and says so when the list stopped before its end rather than counting what it read as all;
 *  - an unknown is unknown: no scheduler row is not "never recorded";
 *  - `--json` prints the same facts, and no nonce is in either output;
 *  - it only ever reads (every request is a GET), refuses a member, and prints nothing partial when
 *    a read fails.
 *
 * CI TIER: integration, like the other CLI suites that start the binary against a local server.
 */

import type { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "bun";
import { hashApiKey } from "../backend/src/services/token";
import type { Bindings } from "../backend/src/types/bindings";
import { freshDb, realD1 } from "../backend/test/helpers/d1";
import { makeRepullApp } from "../backend/test/helpers/repull-app";
import {
  type DispatchSeed,
  NONCE_MARK,
  type Row,
  rowAt,
  seedDispatch as seedDispatchRow,
} from "../backend/test/helpers/repull-rows";
import { AUTO_OPEN_PAGES_MAX } from "../src/lib/repull/auto-view";

/** What `--json` prints, as far as these tests read it. */
interface AutoJson {
  switches: unknown;
  scheduler: unknown;
  open_automatic: Array<{ id: number }>;
  open_automatic_truncated: boolean;
  dispatches: Array<{ id: number }>;
  dispatches_next_after: number | null;
}

const CLI_ENTRY = join(import.meta.dir, "..", "src", "index.ts");
const REPO_ROOT = join(import.meta.dir, "..");
const ADMIN_KEY = "rpa-admin-key-0123456789abcdef0123456789abcdef01";
const MEMBER_KEY = "rpa-member-key-0123456789abcdef0123456789abcdef0";
const SHA = "a".repeat(40);

let db: Database;
let configDir: string;
let extraEnv: Record<string, string | undefined> = {};
let requests: Array<{ method: string; path: string }> = [];
const handle = makeRepullApp();

const server = Bun.serve({
  port: 0,
  fetch: async (req) => {
    const url = new URL(req.url);
    if (url.pathname === "/notices") return Response.json({ notices: [] });
    requests.push({ method: req.method, path: url.pathname });
    const bindings: Record<string, unknown> = { DB: realD1(db), ENVIRONMENT: "production" };
    for (const [k, v] of Object.entries(extraEnv)) if (v !== undefined) bindings[k] = v;
    return handle(req, bindings as unknown as Bindings);
  },
});
const API = `http://127.0.0.1:${server.port}`;

afterAll(() => server.stop(true));

beforeEach(async () => {
  db = freshDb();
  extraEnv = {};
  requests = [];
  configDir = mkdtempSync(join(tmpdir(), "nemar-repull-auto-cli-"));
  for (const [name, role, key] of [
    ["autoadmin", "admin", ADMIN_KEY],
    ["automember", "member", MEMBER_KEY],
  ] as const) {
    db.run(
      `INSERT INTO users (username, email, password_hash, status, role, email_verified)
       VALUES ('${name}', '${name}@example.org', 'x', 'approved', '${role}', 1)`,
    );
    const u = db.query<{ id: number }, []>(`SELECT id FROM users WHERE username='${name}'`).get();
    db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)").run(
      u?.id ?? 0,
      await hashApiKey(key),
      key.slice(0, 8),
    );
  }
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

function signIn(key: string, account = "autocliuser"): void {
  writeFileSync(
    join(configDir, "config.json"),
    JSON.stringify({ activeAccount: account, accounts: { [account]: { apiKey: key } } }),
  );
}

async function runCli(
  args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    NEMAR_CONFIG_DIR: configDir,
    TEST_API_URL: API,
    NEMAR_NO_UPDATE_CHECK: "1",
    NO_COLOR: "1",
    FORCE_COLOR: undefined,
    CLICOLOR_FORCE: undefined,
  };
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined) clean[k] = v;
  const proc = spawn({
    cmd: ["bun", "run", CLI_ENTRY, "admin", "repull", "auto", ...args],
    cwd: REPO_ROOT,
    env: clean,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { stdout, stderr, exitCode: await proc.exited };
}

// ----------------------------------------------------------------------------
// Seeds
// ----------------------------------------------------------------------------

function seedRepull(status: Parameters<typeof rowAt>[0], over: Row = {}): number {
  const row = rowAt(status, { upstream_ds: "ds004362", ...over });
  const cols = Object.keys(row);
  return Number(
    db
      .query(
        `INSERT INTO upstream_repulls (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
      )
      .run(...(cols.map((c) => row[c]) as never[])).lastInsertRowid,
  );
}

/** A dispatch whose run, when it reported, has a log at one address. */
function seedDispatch(o: Omit<DispatchSeed, "runUrl">): number {
  return seedDispatchRow(db, {
    ...o,
    runUrl: "https://github.com/nemarDatasets/.github/actions/runs/424242",
  });
}

/** A busy state: both switches on, a cap unreadable, three open automatic re-pulls and four dispatches. */
function seedBusy(): { held: number; claimed: number; plain: number; admin: number } {
  extraEnv = {
    AUTO_REPULL_ENABLED: "1",
    AUTO_REPULL_MERGE_ENABLED: "1",
    REPULL_DAILY_OPEN_CAP: "1",
    REPULL_DAILY_MERGE_CAP: "x",
  };
  db.run(
    `UPDATE upstream_repull_scheduler SET scan_after = 'on098765', last_tick_at = '2026-10-26 03:00:01',
            last_outcome = 'ran', last_advance_at = '2026-10-26 12:30:02'`,
  );
  const held = seedRepull("pr_open", {
    dataset_id: "on090001",
    origin: "automatic",
    hold_reason: "screen-acknowledge",
    hold_since: "2026-10-25 04:10:00",
  });
  const claimed = seedRepull("gates_clear", {
    dataset_id: "on090002",
    origin: "automatic",
    hold_reason: "claim-held",
    hold_since: "2026-10-26 11:30:00",
    merge_claimed_at: "2026-10-26 11:00:00",
    merge_claim_sha: SHA,
  });
  const plain = seedRepull("copied", {
    dataset_id: "on090003",
    origin: "automatic",
    last_error: "[auto:head-foreign]",
  });
  // An administrator's open re-pull, and a finished automatic one: neither is listed.
  const admin = seedRepull("pr_open", { dataset_id: "on090004", origin: "administrator" });
  seedRepull("complete", { dataset_id: "on090005", origin: "automatic" });
  seedDispatch({
    dataset: "on090001",
    status: "opened",
    repullId: held,
    at: "2026-10-26 03:00:02",
  });
  seedDispatch({
    dataset: "on090006",
    status: "refused",
    code: "auto-not-clean-plan",
    at: "2026-10-25 03:00:03",
  });
  seedDispatch({ dataset: "on090007", status: "finished", repullId: 9, at: "2026-10-24 15:00:00" });
  seedDispatch({ dataset: "on090002", status: "dispatched", at: "2026-10-26 12:00:00" });
  return { held, claimed, plain, admin };
}

// ----------------------------------------------------------------------------
// The text
// ----------------------------------------------------------------------------

describe("nemar admin repull auto: the text", () => {
  test("a Worker with nothing recorded: switches off, nothing stamped, nothing open, no dispatch", async () => {
    signIn(ADMIN_KEY);
    const r = await runCli([]);
    expect(r.exitCode, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain("Switches, as this Worker reads them");
    expect(r.stdout).toContain("Production Worker:           yes");
    expect(r.stdout).toContain("AUTO_REPULL_ENABLED:         off");
    expect(r.stdout).toContain("AUTO_REPULL_MERGE_ENABLED:   off");
    expect(r.stdout).toContain("REPULL_DAILY_OPEN_CAP:       2 (the default)");
    expect(r.stdout).toContain("REPULL_DAILY_MERGE_CAP:      5 (the default)");
    expect(r.stdout).toContain("Daily tick last ran:    never recorded");
    expect(r.stdout).toContain("Advance tick last ran:  never recorded");
    expect(r.stdout).toContain("Open automatic re-pulls: none");
    expect(r.stdout).toContain("Recent dispatches: none");
    expect(r.stdout).toContain("nemar admin import-weekly");
    expect(r.stdout).not.toContain("unknown");
  });

  test("the switches, both caps, the stamps, the open automatic re-pulls and the dispatches, by dataset", async () => {
    signIn(ADMIN_KEY);
    const ids = seedBusy();
    const r = await runCli([]);
    expect(r.exitCode, r.stdout + r.stderr).toBe(0);
    for (const line of [
      "AUTO_REPULL_ENABLED:         on",
      "AUTO_REPULL_MERGE_ENABLED:   on",
      "REPULL_DAILY_OPEN_CAP:       1 (set)",
      "REPULL_DAILY_MERGE_CAP:      unreadable, so it reads 0 (the binding is set to something the reader cannot take)",
      "Daily tick last ran:    2026-10-26 03:00:01 UTC, concluded ran",
      "Advance tick last ran:  2026-10-26 12:30:02 UTC",
      "Open automatic re-pulls: 3",
      `#${ids.held} on090001 v2.0.0 pr_open, held for screen-acknowledge since 2026-10-25 04:10:00 UTC`,
      `#${ids.claimed} on090002 v2.0.0 gates_clear, held for claim-held since 2026-10-26 11:30:00 UTC, claim to merge held since 2026-10-26 11:00:00 UTC`,
      `#${ids.plain} on090003 v2.0.0 copied; last error: [auto:head-foreign]`,
      "Recent dispatches, newest first (4 shown)",
      "open on090002 dispatched 2026-10-26 12:00:00 UTC",
      `open on090001 opened (re-pull #${ids.held}) 2026-10-26 03:00:02 UTC https://github.com/nemarDatasets/.github/actions/runs/424242`,
      "open on090006 refused auto-not-clean-plan 2026-10-25 03:00:03 UTC",
      "finish on090007 finished (re-pull #9) 2026-10-24 15:00:00 UTC",
    ]) {
      expect(r.stdout).toContain(line);
    }
    // An administrator's open re-pull and a finished one are not the automatic path's open ones.
    expect(r.stdout).not.toContain("on090004");
    expect(r.stdout).not.toContain("on090005");
    // The scheduler's cursor is a dataset id and the nonce a secret: neither is shown.
    expect(r.stdout).not.toContain("on098765");
    expect(r.stdout).not.toContain(NONCE_MARK);
  });

  test("a scheduler row the Worker could not find is unknown, not never recorded", async () => {
    signIn(ADMIN_KEY);
    db.run("DELETE FROM upstream_repull_scheduler");
    const r = await runCli([]);
    expect(r.exitCode, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain("Unknown: the Worker found no scheduler row");
    expect(r.stdout).not.toContain("never recorded");
  });

  test("a Worker that is not production honors no switch, and says so", async () => {
    signIn(ADMIN_KEY);
    extraEnv = { ENVIRONMENT: "staging", AUTO_REPULL_ENABLED: "1" };
    const r = await runCli([]);
    expect(r.stdout).toContain(
      "Production Worker:           no (a Worker that is not exactly production honors no switch)",
    );
    expect(r.stdout).toContain("AUTO_REPULL_ENABLED:         off");
  });
});

// ----------------------------------------------------------------------------
// The pages of open re-pulls
// ----------------------------------------------------------------------------

describe("nemar admin repull auto: every page of open re-pulls", () => {
  function seedOpen(n: number, everyOther: boolean): void {
    db.run("BEGIN");
    const cols = Object.keys(rowAt("pr_open"));
    const insert = db.prepare(
      `INSERT INTO upstream_repulls (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
    );
    for (let i = 0; i < n; i++) {
      const row = rowAt("pr_open", {
        dataset_id: `on${String(100000 + i)}`,
        upstream_ds: "ds004362",
        origin: !everyOther || i % 2 === 0 ? "automatic" : "administrator",
      });
      insert.run(...(cols.map((c) => row[c]) as never[]));
    }
    db.run("COMMIT");
  }

  test("120 open re-pulls of every origin are three pages, and the automatic ones among them are all listed", async () => {
    signIn(ADMIN_KEY);
    seedOpen(120, true);
    const r = await runCli(["--json"]);
    expect(r.exitCode, r.stdout + r.stderr).toBe(0);
    const out = JSON.parse(r.stdout) as {
      open_automatic: Array<{ origin: string }>;
      open_automatic_truncated: boolean;
    };
    expect(out.open_automatic).toHaveLength(60);
    expect(out.open_automatic.every((x) => x.origin === "automatic")).toBe(true);
    expect(out.open_automatic_truncated).toBe(false);
    const pages = requests.filter((q) => q.path === "/admin/repulls");
    expect(pages).toHaveLength(3);
    const text = await runCli([]);
    expect(text.stdout).toContain("Open automatic re-pulls: 60");
    expect(text.stdout).not.toContain("read so far");
  });

  test("a list that stops before its end says so, and does not call what it read all of them", async () => {
    signIn(ADMIN_KEY);
    // One page more than the command reads: every open re-pull is automatic, so the count it
    // can show is the most it read, not the total.
    seedOpen(AUTO_OPEN_PAGES_MAX * 50 + 20, false);
    const r = await runCli([]);
    expect(r.exitCode, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain(
      `Open automatic re-pulls: ${AUTO_OPEN_PAGES_MAX * 50} (read so far)`,
    );
    expect(r.stdout).toContain(`The list stopped after ${AUTO_OPEN_PAGES_MAX} pages`);
    const json = JSON.parse((await runCli(["--json"])).stdout) as {
      open_automatic_truncated: boolean;
    };
    expect(json.open_automatic_truncated).toBe(true);
  });
});

// ----------------------------------------------------------------------------
// --json
// ----------------------------------------------------------------------------

describe("nemar admin repull auto --json", () => {
  test("prints the same facts under the names the routes use, with no nonce and no cursor", async () => {
    signIn(ADMIN_KEY);
    const ids = seedBusy();
    const r = await runCli(["--json"]);
    expect(r.exitCode, r.stdout + r.stderr).toBe(0);
    const out = JSON.parse(r.stdout) as AutoJson;
    expect(Object.keys(out).sort()).toEqual([
      "dispatches",
      "dispatches_next_after",
      "open_automatic",
      "open_automatic_truncated",
      "scheduler",
      "switches",
    ]);
    expect(out.switches).toEqual({
      environment_is_production: true,
      auto_repull_enabled: true,
      auto_repull_merge_enabled: true,
      open_cap: { value: 1, source: "set" },
      merge_cap: { value: 0, source: "unreadable" },
    });
    expect(out.scheduler).toEqual({
      last_tick_at: "2026-10-26 03:00:01",
      last_outcome: "ran",
      last_advance_at: "2026-10-26 12:30:02",
    });
    expect(out.open_automatic.map((x) => x.id).sort()).toEqual(
      [ids.held, ids.claimed, ids.plain].sort(),
    );
    expect(out.dispatches).toHaveLength(4);
    expect(out.dispatches_next_after).toBeNull();
    expect(r.stdout).not.toContain("nonce");
    expect(r.stdout).not.toContain("on098765");
    expect(r.stdout).not.toContain(NONCE_MARK);
  });

  test("an unknown scheduler is null, not three nulls", async () => {
    signIn(ADMIN_KEY);
    db.run("DELETE FROM upstream_repull_scheduler");
    const out = JSON.parse((await runCli(["--json"])).stdout) as { scheduler: unknown };
    expect(out.scheduler).toBeNull();
  });

  test("a full page of dispatches says older ones exist, with the cursor to read them", async () => {
    signIn(ADMIN_KEY);
    const ids: number[] = [];
    for (let i = 0; i < 21; i++) {
      ids.push(
        seedDispatch({
          dataset: `on0910${String(i).padStart(2, "0")}`,
          status: "refused",
          code: "gitlink",
          at: "2026-10-20 03:00:00",
        }),
      );
    }
    const out = JSON.parse((await runCli(["--json"])).stdout) as {
      dispatches: Array<{ id: number }>;
      dispatches_next_after: number | null;
    };
    expect(out.dispatches).toHaveLength(20);
    expect(out.dispatches_next_after).toBe(out.dispatches.at(-1)?.id as number);
    expect((await runCli([])).stdout).toContain(
      "Recent dispatches, newest first (20 shown; older ones exist)",
    );
  });
});

// ----------------------------------------------------------------------------
// Reads only, roles, failures
// ----------------------------------------------------------------------------

describe("nemar admin repull auto: it only reads, and prints nothing partial", () => {
  test("every request it makes is a GET, to three routes", async () => {
    signIn(ADMIN_KEY);
    seedBusy();
    await runCli([]);
    expect(requests.length).toBeGreaterThanOrEqual(3);
    expect(requests.every((q) => q.method === "GET")).toBe(true);
    expect([...new Set(requests.map((q) => q.path))].sort()).toEqual([
      "/admin/repulls",
      "/admin/repulls/dispatches",
      "/admin/repulls/switches",
    ]);
  });

  test("a member is refused by the Worker, exits 1, and sees no table", async () => {
    signIn(MEMBER_KEY);
    const r = await runCli([]);
    expect(r.exitCode).toBe(1);
    expect(r.stdout + r.stderr).toContain("Could not read the automatic re-pull");
    expect(r.stdout).not.toContain("Switches, as this Worker reads them");
  });

  test("without a stored key nothing is sent", async () => {
    const r = await runCli([]);
    expect(r.exitCode).toBe(1);
    expect(r.stdout + r.stderr).toContain("Not authenticated");
    expect(requests).toEqual([]);
  });

  test("a read that fails prints the failure and no table, exiting 1", async () => {
    signIn(ADMIN_KEY);
    db.run("DROP TABLE upstream_repull_dispatches");
    const r = await runCli([]);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("Could not read the automatic re-pull");
    expect(r.stdout).toContain("migration 0111");
    // The switches were read first and are not printed: a table with a hole would claim a read.
    expect(r.stdout).not.toContain("Switches, as this Worker reads them");
    expect(r.stdout).not.toContain("Open automatic re-pulls");
  });
});
