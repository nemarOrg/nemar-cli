/**
 * `nemar admin repo publish screen-batch` (epic #2182, card D4; ADR 0086, amendment of 2026-11-25),
 * driven through the real entry point against the REAL routes: the Worker's admin and webhook
 * routers behind their real authentication, over real SQLite carrying every migration, served on a
 * loopback port and reached through TEST_API_URL. GitHub is a loopback stand-in that records each
 * dispatch, and the mail is the shared real-boundary capture (`withFakeResend`), so nothing is sent.
 *
 * The properties, each with a test of its own:
 *  - the dry run prints the selection and its count, and sends no request that writes;
 *  - `--apply` dispatches the screens itself, no faster than `--per-minute` (measured between the
 *    dispatches the server saw), and one digest is the only mail the batch sends;
 *  - Ctrl-C stops dispatching, closes the batch on the screens already started, and the digest
 *    follows their report;
 *  - a selection that is wrong (no selector, an id that is not one, a rate above 10, a status that
 *    is not requested or blocked) sends nothing.
 *
 * CI TIER: integration, like the other CLI suites that start the binary against a local server.
 */

import type { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Server, spawn } from "bun";
import { hashApiKey } from "../backend/src/services/token";
import type { Bindings } from "../backend/src/types/bindings";
import {
  type AdminWebhookApp,
  makeAdminWebhookApp,
} from "../backend/test/helpers/admin-webhook-app";
import { freshDb, realD1 } from "../backend/test/helpers/d1";
import { SCREENED_HEAD, cleanScreenReportBody } from "../backend/test/helpers/identifier-screen";
import { type CapturedEmail, asSend, withFakeResend } from "../backend/test/helpers/resend";

const CLI_ENTRY = join(import.meta.dir, "..", "src", "index.ts");
const REPO_ROOT = join(import.meta.dir, "..");
const ADMIN_KEY = "scbatch-admin-key-0123456789abcdef0123456789abcdef";
const SECRET = "scbatch-secret";
const ADMIN_EMAIL = "scbatchadmin@example.org";
const OWNER_EMAIL = "scbatchowner@example.org";

interface Seen {
  method: string;
  path: string;
  at: number;
}
interface Dispatch {
  client_payload: { dataset_id: string; request_id: number; callback_token: string };
}

let db: Database;
let ownerId: number;
let app: AdminWebhookApp;
let seen: Seen[] = [];
let dispatches: Dispatch[] = [];
let workerServer: Server;
let githubServer: Server;
let configDir: string;

function env(): Bindings {
  return {
    DB: realD1(db),
    ENVIRONMENT: "production",
    GITHUB_ADMIN_PAT: "ghp_scbatch",
    PRESCREEN_CALLBACK_SECRET: SECRET,
    API_BASE_URL: "https://api.test.nemar.org",
    RESEND_API_KEY: "re_test",
    FROM_EMAIL: "NEMAR <noreply@nemar.org>",
  } as Bindings;
}

beforeAll(() => {
  githubServer = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "POST" && url.pathname === "/repos/nemarDatasets/.github/dispatches") {
        dispatches.push((await req.json()) as Dispatch);
        return new Response(null, { status: 204 });
      }
      return new Response("not found", { status: 404 });
    },
  });
  (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL =
    `http://127.0.0.1:${githubServer.port}`;
  workerServer = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/notices") return Response.json({ notices: [] });
      seen.push({ method: req.method, path: url.pathname + url.search, at: Date.now() });
      return app.fetch(req, env());
    },
  });
});

afterAll(() => {
  (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL = undefined;
  workerServer.stop(true);
  githubServer.stop(true);
});

beforeEach(async () => {
  db = freshDb();
  app = makeAdminWebhookApp();
  for (const [name, role, email, key] of [
    ["scbatchowner", "member", OWNER_EMAIL, "scbatch-owner-key-0123456789abcdef0123456789abcdef"],
    ["scbatchadmin", "admin", ADMIN_EMAIL, ADMIN_KEY],
  ] as const) {
    db.run(
      `INSERT INTO users (username, email, password_hash, status, role, email_verified,
                          service_access, sandbox_completed, given_name, family_name)
       VALUES (?, ?, 'x', 'approved', ?, 1, 1, 1, 'Ada', 'Lovelace')`,
      [name, email, role],
    );
    const id = db
      .query<{ id: number }, [string]>("SELECT id FROM users WHERE username = ?")
      .get(name)?.id as number;
    if (role === "member") ownerId = id;
    db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)").run(
      id,
      await hashApiKey(key),
      key.slice(0, 8),
    );
  }
  configDir = mkdtempSync(join(tmpdir(), "nemar-scbatch-cli-"));
  writeFileSync(
    join(configDir, "config.json"),
    JSON.stringify({ activeAccount: "scbatch", accounts: { scbatch: { apiKey: ADMIN_KEY } } }),
  );
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
  seen = [];
  dispatches = [];
});

function seedRequest(datasetId: string, status = "requested"): void {
  db.run(
    `INSERT INTO datasets (dataset_id, name, owner_user_id, status, visibility, is_sandbox, github_repo)
     VALUES (?, ?, ?, 'active', 'private', 0, ?)`,
    [
      datasetId,
      `A sufficiently descriptive title for ${datasetId}`,
      ownerId,
      `nemarDatasets/${datasetId}`,
    ],
  );
  db.run("INSERT INTO publication_requests (dataset_id, requested_by, status) VALUES (?, ?, ?)", [
    datasetId,
    ownerId,
    status,
  ]);
}

function spawnCli(args: string[]) {
  const childEnv: Record<string, string | undefined> = {
    PATH: process.env.PATH,
    HOME: configDir,
    NEMAR_CONFIG_DIR: configDir,
    TEST_API_URL: `http://localhost:${workerServer.port}`,
    NEMAR_NO_UPDATE_CHECK: "1",
    NO_COLOR: "1",
  };
  return spawn({
    cmd: ["bun", "run", CLI_ENTRY, "admin", "repo", "publish", "screen-batch", ...args],
    cwd: REPO_ROOT,
    env: childEnv,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
}

async function runCli(args: string[]) {
  const proc = spawnCli(args);
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { stdout, stderr, exitCode: await proc.exited };
}

async function until(what: string, ok: () => boolean, timeoutMs = 20_000): Promise<void> {
  const start = Date.now();
  while (!ok()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

function postReport(datasetId: string, status = "clean") {
  const d = dispatches.filter((x) => x.client_payload.dataset_id === datasetId).at(-1);
  if (!d) throw new Error(`no dispatch for ${datasetId}`);
  return app.request(
    "/webhooks/identifier-screen-result",
    {
      method: "POST",
      headers: {
        "X-Webhook-Token": d.client_payload.callback_token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        dataset_id: datasetId,
        request_id: d.client_payload.request_id,
        report: cleanScreenReportBody(datasetId, SCREENED_HEAD, status),
      }),
    },
    env(),
  );
}

const sends = (calls: CapturedEmail[]) => calls.filter((c) => c.path === "/emails").map(asSend);
const writes = () => seen.filter((s) => s.method !== "GET");
const batchCount = () =>
  (db.query("SELECT COUNT(*) AS n FROM screen_batches").get() as { n: number }).n;

describe("the dry run", () => {
  test("prints the selection and its count, and writes nothing", async () => {
    seedRequest("nm000501");
    seedRequest("nm000502", "blocked");
    seedRequest("nm000503");
    await withFakeResend(async (calls) => {
      const r = await runCli(["--status", "requested"]);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("Would re-screen 2 publication requests");
      expect(r.stdout).toContain("nm000501");
      expect(r.stdout).toContain("nm000503");
      expect(r.stdout).not.toContain("nm000502");
      expect(r.stdout).toContain("Dry run: nothing was sent");
      expect(writes()).toEqual([]);
      expect(batchCount()).toBe(0);
      expect(dispatches).toHaveLength(0);
      expect(sends(calls)).toHaveLength(0);
    });
  });

  test("--all-active leaves a request that is being approved alone, however it is named", async () => {
    seedRequest("nm000501");
    seedRequest("nm000504", "approving");
    const idsFile = join(configDir, "named.txt");
    writeFileSync(idsFile, "nm000501\nnm000504\n");
    for (const args of [["--all-active"], ["--ids", idsFile]]) {
      const r = await runCli(args);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("Would re-screen 1 publication request:");
      expect(r.stdout).toContain("nm000501  requested");
      expect(r.stdout).not.toContain("nm000504  ");
      expect(r.stdout).toContain("1 request is being approved and left alone: nm000504");
    }
    expect(writes()).toEqual([]);
  });

  test("--all-active takes the blocked ones too, and an --ids file names its own", async () => {
    seedRequest("nm000501");
    seedRequest("nm000502", "blocked");
    const idsFile = join(configDir, "ids.txt");
    writeFileSync(idsFile, "nm000502\nnm000999 # no request\n");
    const all = await runCli(["--all-active"]);
    expect(all.stdout).toContain("Would re-screen 2 publication requests");
    const named = await runCli(["--ids", idsFile]);
    expect(named.exitCode).toBe(0);
    expect(named.stdout).toContain("Would re-screen 1 publication request:");
    expect(named.stdout).toContain("has no open request and is left out: nm000999");
    expect(writes()).toEqual([]);
  });
});

describe("a selection that is wrong sends nothing", () => {
  const idsFile = () => join(configDir, "bad.txt");
  test("no selector, two selectors, a bad status, a bad id and a bad rate", async () => {
    seedRequest("nm000501");
    writeFileSync(idsFile(), "nm000501\nnot-an-id\n");
    const cases: string[][] = [
      [],
      ["--status", "requested", "--all-active"],
      ["--status", "approving"],
      ["--ids", idsFile()],
      ["--ids", join(configDir, "missing.txt")],
      ["--all-active", "--per-minute", "11", "--apply"],
      ["--all-active", "--per-minute", "0", "--apply"],
    ];
    for (const args of cases) {
      const r = await runCli(args);
      expect(r.exitCode).toBe(1);
    }
    expect(writes()).toEqual([]);
    expect(batchCount()).toBe(0);
  });
});

describe("--apply", () => {
  test("dispatches no faster than --per-minute and mails one digest, nothing per request", async () => {
    seedRequest("nm000501");
    seedRequest("nm000502");
    await withFakeResend(async (calls) => {
      const proc = spawnCli(["--status", "requested", "--per-minute", "10", "--apply"]);
      await until("both screens dispatched", () => dispatches.length === 2);
      const times = seen
        .filter((s) => s.method === "POST" && s.path.endsWith("/identifier-screen"))
        .map((s) => s.at);
      expect(times).toHaveLength(2);
      // 10 a minute is a gap of 6 seconds; a little under, for the clock's granularity.
      expect(times[1] - times[0]).toBeGreaterThanOrEqual(5_800);
      const out = await new Response(proc.stdout).text();
      const err = await new Response(proc.stderr).text();
      expect(await proc.exited).toBe(0);
      // The spinner writes to standard error.
      expect(`${out}${err}`).toContain("Batch 1 created for 2 requests");
      expect(out).toContain("[2/2] nm000502 screen dispatched");
      expect(out).toContain("No per-request mail is sent");

      expect(sends(calls)).toHaveLength(0);
      await postReport("nm000501");
      expect(sends(calls)).toHaveLength(0);
      await postReport("nm000502", "review");
      const mails = sends(calls);
      expect(mails).toHaveLength(1);
      expect(mails[0].subject).toBe("[NEMAR] Re-screen batch 1 finished: all 2 reported");
      expect(mails[0].to).toEqual([ADMIN_EMAIL]);
    });
  }, 40_000);

  test("Ctrl-C stops dispatching, closes the batch, and the started screen's report brings the digest", async () => {
    seedRequest("nm000501");
    seedRequest("nm000502");
    seedRequest("nm000503");
    await withFakeResend(async (calls) => {
      const proc = spawnCli(["--status", "requested", "--per-minute", "10", "--apply"]);
      await until("first screen dispatched", () => dispatches.length === 1);
      proc.kill("SIGINT");
      const out = await new Response(proc.stdout).text();
      // An interrupted batch is not a complete one: exit 1, and not a crash.
      expect(await proc.exited).toBe(1);
      expect(out).toContain("Stopping: no more screens will be dispatched");
      expect(out).toMatch(/2 not reached/);
      expect(dispatches).toHaveLength(1);
      expect(
        seen.some((s) => s.method === "POST" && s.path === "/admin/publish/screen-batches/1/close"),
      ).toBe(true);

      expect(sends(calls)).toHaveLength(0);
      const first = dispatches[0].client_payload.dataset_id;
      await postReport(first);
      const mails = sends(calls);
      expect(mails).toHaveLength(1);
      expect(mails[0].subject).toBe(
        "[NEMAR] Re-screen batch 1 finished: 1 of 3 reported, 2 not started",
      );
      const html = mails[0].html;
      for (const id of ["nm000501", "nm000502", "nm000503"].filter((x) => x !== first)) {
        expect(html).toContain(`<code>${id}</code>`);
      }
    });
  }, 40_000);
});
