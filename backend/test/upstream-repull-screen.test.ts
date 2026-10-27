/**
 * The identifier screen bound to a re-pull row (epic #1046 phase 6, #1912; ADR 0111, decisions 7
 * and 9), through its real entry points: the admin routes that dispatch, read and acknowledge it,
 * the callback the workflow posts to, and the transition into the gates-clear states, which reads
 * it.
 *
 * Real engine only: bun:sqlite behind realD1 with every migration applied, the real auth and admin
 * middleware with seeded keys, the real routers through Hono's `app.request()`, and a `Bun.serve()`
 * stand-in for api.github.com (NEMAR_GITHUB_API_URL) that records the dispatches it is sent, the
 * pattern of `identifier-sweep.test.ts`. The Resend capture is armed around every test and must
 * stay empty: nothing about a re-pull mails anyone.
 *
 * The properties, each with a test that fails when its line is changed:
 *  - the dispatch screens the recorded head (`ref` = that commit), `request_id` 0, at the
 *    re-pull callback, and only while the pull request is open; outside production only `xx`
 *    reaches it and `xx` is exempt, so a non-production Worker dispatches nothing;
 *  - the token is a kind of its own: another kind's token is refused at this callback and this
 *    kind's at theirs; a replay is refused;
 *  - a report about another commit or another dataset is an error, never a verdict;
 *  - a screen that never reported reads `unreported` after the deadline, and only a screen with
 *    no verdict is dispatched again;
 *  - an acknowledgment attaches only to a screen that asks for one, never to a direct identifier,
 *    and counts only for the administrator who recorded it;
 *  - the gates-clear edges are taken only while the screen passes for the recorded head.
 */

import type { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { parseScreenReport } from "../../shared/identifier-screen-report";
import type { RepullStatus } from "../../shared/repull-state";
import { adminMiddleware, authMiddleware } from "../src/middleware/auth";
import { registerUpstreamRepullRoutes } from "../src/routes/admin/upstream-repulls";
import webhooks from "../src/routes/webhooks";
import {
  signIdentifierRepullCallbackToken,
  signIdentifierScreenCallbackToken,
  signIdentifierSweepCallbackToken,
  verifyIdentifierRepullCallbackToken,
  verifyIdentifierScreenCallbackToken,
  verifyIdentifierSweepCallbackToken,
} from "../src/services/github";
import { SCREEN_REPORT_DEADLINE_MINUTES } from "../src/services/identifier-screen-stored";
import { hashApiKey } from "../src/services/token";
import { REPULL_SCREEN_CALLBACK_PATH } from "../src/services/upstream-repull-screen";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";
import {
  type Dispatch,
  type RepullGitHub,
  startRepullGitHub,
} from "./helpers/repull-github-standin";
import { type Row, rowAt } from "./helpers/repull-rows";
import { type CapturedEmail, withFakeResend } from "./helpers/resend";

const SECRET = "repull-screen-test-secret";
const API_BASE = "https://api.test.nemar.org";
const ADMIN_KEY = "rps-admin-key-0123456789abcdef0123456789abcdef012";
const OTHER_KEY = "rps-other-key-0123456789abcdef0123456789abcdef012";
const HEAD = "0123456789abcdef0123456789abcdef01234567";
const NEXT = "89abcdef0123456789abcdef0123456789abcdef";
const DS = "on099999";

// biome-ignore lint/suspicious/noExplicitAny: a response body read field by field in assertions
type Json = Record<string, any>;

// GitHub: the dispatch, and the live pull request the gates read, open at HEAD unless a test
// says otherwise.
let gh: RepullGitHub;
let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;
let adminId = 0;
let otherId = 0;
let mail: CapturedEmail[] = [];
let releaseMail: (() => void) | null = null;
let mailDone: Promise<void> | null = null;

beforeAll(() => {
  gh = startRepullGitHub({ defaultHead: HEAD });
});

afterAll(() => gh.stop());

beforeEach(async () => {
  db = freshDb();
  app = new Hono();
  app.route("/webhooks", webhooks);
  const admin = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  admin.use("*", authMiddleware);
  admin.use("*", adminMiddleware);
  registerUpstreamRepullRoutes(admin);
  app.route("/admin", admin);
  adminId = await seedAdmin("rpsadmin", ADMIN_KEY);
  otherId = await seedAdmin("rpsother", OTHER_KEY);
  // Every test runs with Resend redirected to a capture that must stay empty.
  await new Promise<void>((armed) => {
    mailDone = withFakeResend(
      (calls) =>
        new Promise<void>((done) => {
          mail = calls;
          releaseMail = done;
          armed();
        }),
    );
  });
});

afterEach(async () => {
  releaseMail?.();
  await mailDone;
  releaseMail = null;
  mailDone = null;
  expect(mail).toEqual([]);
  gh.reset();
});

async function seedAdmin(username: string, key: string): Promise<number> {
  db.run(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified)
     VALUES (?, ?, 'x', 'approved', 'admin', 1)`,
    [username, `${username}@example.org`],
  );
  const id = db
    .query<{ id: number }, [string]>("SELECT id FROM users WHERE username = ?")
    .get(username)?.id as number;
  db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)").run(
    id,
    await hashApiKey(key),
    key.slice(0, 8),
  );
  return id;
}

function env(over: Partial<Bindings> = {}): Bindings {
  return {
    DB: realD1(db),
    ENVIRONMENT: "production",
    GITHUB_ADMIN_PAT: "ghp_repull_screen_test",
    PRESCREEN_CALLBACK_SECRET: SECRET,
    API_BASE_URL: API_BASE,
    RESEND_API_KEY: "re_test",
    FROM_EMAIL: "NEMAR <noreply@nemar.org>",
    ...over,
  } as Bindings;
}

function seedMirror(id: string, o: { anonymous?: boolean } = {}): void {
  db.run(
    `INSERT INTO datasets (dataset_id, name, owner_user_id, source, source_id, anonymous)
     VALUES (?, ?, ?, 'openneuro', 'ds099999', ?)`,
    [id, id, adminId, o.anonymous ? 1 : 0],
  );
}

/** A re-pull row of `datasetId` at `status`, its head HEAD; its id. */
function seedRepull(status: RepullStatus, over: Row = {}): number {
  const row = rowAt(status, {
    dataset_id: DS,
    upstream_ds: "ds099999",
    actor_user_id: adminId,
    head_sha: HEAD,
    ...over,
  });
  const cols = Object.keys(row);
  return Number(
    db
      .query(
        `INSERT INTO upstream_repulls (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
      )
      .run(...(cols.map((c) => row[c]) as never[])).lastInsertRowid,
  );
}

async function call(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  o: { key?: string; env?: Partial<Bindings> } = {},
) {
  const headers: Record<string, string> = { Authorization: `Bearer ${o.key ?? ADMIN_KEY}` };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await app.request(
    `/admin${path}`,
    { method, headers, body: body === undefined ? undefined : JSON.stringify(body) },
    env(o.env),
  );
  return { status: res.status, body: (await res.json()) as Json };
}

async function callback(
  path: string,
  token: string,
  body: Record<string, unknown>,
  over: Partial<Bindings> = {},
): Promise<{ status: number; body: Json }> {
  // `path` is the full path, as the dispatch's callback_url names it.
  const res = await app.request(
    path,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Webhook-Token": token },
      body: JSON.stringify(body),
    },
    env(over),
  );
  return { status: res.status, body: (await res.json()) as Json };
}

/** A D1 that runs `action` once, just before the Worker prepares the first statement `match` names. */
function racingDb(match: (sql: string) => boolean, action: () => void): D1Database {
  const real = realD1(db);
  let done = false;
  return {
    ...real,
    prepare(sql: string) {
      if (!done && match(sql)) {
        done = true;
        action();
      }
      return real.prepare(sql);
    },
    batch: real.batch.bind(real),
  } as unknown as D1Database;
}

/** The dispatch route, on a given D1. */
async function dispatchOn(d1: D1Database, id: number, sha = HEAD) {
  const res = await app.request(
    `/admin/repulls/${id}/screen`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${ADMIN_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ pr: "n0", sha }),
    },
    { ...env(), DB: d1 },
  );
  return { status: res.status, body: (await res.json()) as Json };
}

/** A scan report as the workflow posts it: `status` of `datasetId` at `head`. */
function scanReport(head: string, status = "clean", datasetId = DS): Record<string, unknown> {
  return {
    version: 1,
    scanner: "identifier-scan@abcdef1",
    head,
    scan: {
      id: datasetId,
      version: null,
      scanned_at: "2026-10-24T12:00:00.000Z",
      manifest_source: "clone",
      status,
      // An unchecked scan is one that fell short; the parser holds a report to its counts.
      incomplete: status === "unchecked",
      incomplete_reasons: status === "unchecked" ? ["edf-headers-unread"] : [],
      files: { total: 10, edf_bdf: 4, header_read: 4, header_read_failed: 0 },
    },
  };
}

const screens = (id: number) =>
  db
    .query("SELECT * FROM upstream_repull_screens WHERE repull_id = ? ORDER BY id")
    .all(id) as Row[];

const dispatch = (id: number, pr = "n0", sha = HEAD, o: Parameters<typeof call>[3] = {}) =>
  call("POST", `/repulls/${id}/screen`, { pr, sha }, o);

/** Dispatch, then answer the dispatch's callback with `report`; the callback's response. */
async function screenWith(id: number, report: Record<string, unknown>, pr = "n0", sha = HEAD) {
  const sent = await dispatch(id, pr, sha);
  expect(sent.status).toBe(202);
  const d = gh.dispatches.at(-1) as Dispatch;
  return callback(REPULL_SCREEN_CALLBACK_PATH, d.client_payload.callback_token, {
    dataset_id: DS,
    request_id: 0,
    workflow_run_id: "123",
    report,
  });
}

/** Store a verdict directly, as the callback leaves it (the parser's output). */
function markScreen(id: number, status: string, o: { pr?: string; sha?: string } = {}): void {
  const sha = o.sha ?? HEAD;
  const report = JSON.stringify(parseScreenReport(scanReport(sha, status)));
  db.run(
    `INSERT INTO upstream_repull_screens (repull_id, pr, sha, status, report, reported_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))`,
    [id, o.pr ?? "n0", sha, status, report],
  );
}

const move = (id: number, body: Record<string, unknown>, key = ADMIN_KEY) =>
  call("POST", `/repulls/${id}/transition`, body, { key });

const statusOf = (id: number) =>
  (db.query("SELECT status FROM upstream_repulls WHERE id = ?").get(id) as Row).status;

// ----------------------------------------------------------------------------
// Dispatch
// ----------------------------------------------------------------------------

describe("the dispatch", () => {
  test("screens the recorded head with request_id 0 at the re-pull callback, and records a run", async () => {
    seedMirror(DS);
    const id = seedRepull("pr_open");
    const res = await dispatch(id);
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({
      dispatched: true,
      screen: { pr: "n0", sha: HEAD, state: "pending", gate: "wait", waiting: true },
    });
    expect(gh.dispatches).toHaveLength(1);
    const d = gh.dispatches[0] as Dispatch;
    expect(d.event_type).toBe("run-identifier-screen");
    expect(d.client_payload).toMatchObject({
      dataset_id: DS,
      ref: HEAD,
      request_id: 0,
      callback_url: `${API_BASE}${REPULL_SCREEN_CALLBACK_PATH}`,
    });
    const [row] = screens(id);
    expect(row).toMatchObject({ pr: "n0", sha: HEAD, status: "pending" });
    expect(typeof row?.nonce).toBe("string");
    const audit = db
      .query("SELECT user_id, details FROM audit_log WHERE action = 'repull_screen_dispatched'")
      .all() as Row[];
    expect(audit).toHaveLength(1);
    expect(audit[0]?.user_id).toBe(adminId);
  });

  test("its token is the re-pull kind over the row, the pull request, the commit and the nonce", async () => {
    seedMirror(DS);
    const id = seedRepull("pr_open");
    await dispatch(id);
    const token = (gh.dispatches[0] as Dispatch).client_payload.callback_token;
    const nonce = screens(id)[0]?.nonce as string;
    const payload = { datasetId: DS, repullId: id, pr: "n0", sha: HEAD, nonce };
    expect(await verifyIdentifierRepullCallbackToken(token, payload, SECRET)).toBe(true);
    // Each bound field matters, and so does the domain.
    for (const over of [{ repullId: id + 1 }, { pr: "n1" }, { sha: NEXT }, { nonce: "other" }]) {
      expect(
        await verifyIdentifierRepullCallbackToken(token, { ...payload, ...over }, SECRET),
      ).toBe(false);
    }
    expect(await verifyIdentifierSweepCallbackToken(token, { datasetId: DS, nonce }, SECRET)).toBe(
      false,
    );
    expect(
      await verifyIdentifierScreenCallbackToken(
        token,
        { datasetId: DS, requestId: 0, nonce },
        SECRET,
      ),
    ).toBe(false);
    // The signed message is pinned, domain line first, so the kind cannot drift into another's.
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const expected = Buffer.from(
      await crypto.subtle.sign(
        "HMAC",
        key,
        new TextEncoder().encode(`identifier-repull\n${DS}\n${id}\nn0\n${HEAD}\n${nonce}`),
      ),
    ).toString("hex");
    expect(token).toBe(expected);
  });

  test("is refused outside the open pull request's status and for a commit that is not its head", async () => {
    seedMirror(DS);
    const gated = seedRepull("gates_clear");
    const res = await dispatch(gated);
    expect([res.status, res.body.code]).toEqual([409, "not-screenable"]);
    db.run("DELETE FROM upstream_repulls");
    const open = seedRepull("pr_open");
    const other = await dispatch(open, "n0", NEXT);
    expect([other.status, other.body.code]).toEqual([409, "not-the-head"]);
    // N.0.1's screen waits for N.0.1's pull request.
    const patch = await dispatch(open, "n1", HEAD);
    expect([patch.status, patch.body.code]).toEqual([409, "not-screenable"]);
    expect(gh.dispatches).toEqual([]);
    expect(screens(open)).toEqual([]);
  });

  test("outside production an on dataset is fenced, and an xx dataset is exempt: nothing is dispatched", async () => {
    seedMirror(DS);
    const id = seedRepull("pr_open");
    for (const environment of ["test", "staging", undefined]) {
      const res = await dispatch(id, "n0", HEAD, {
        env: { ENVIRONMENT: environment as Bindings["ENVIRONMENT"] },
      });
      expect([environment, res.status, res.body.code]).toEqual([environment, 403, "env-fence"]);
    }
    seedMirror("xx090123");
    const xx = seedRepull("pr_open", { dataset_id: "xx090123" });
    const exempt = await dispatch(xx, "n0", HEAD, { env: { ENVIRONMENT: "test" } });
    expect(exempt.status).toBe(200);
    expect(exempt.body).toMatchObject({ exempt: true, dispatched: false });
    expect(gh.requests).toEqual([]);
    expect(db.query("SELECT COUNT(*) AS n FROM upstream_repull_screens").get()).toEqual({ n: 0 });
  });

  test("an anonymous, withdrawn or mid-import dataset is refused before anything is sent", async () => {
    seedMirror(DS, { anonymous: true });
    const id = seedRepull("pr_open");
    const anon = await dispatch(id);
    expect([anon.status, anon.body.code]).toEqual([409, "anonymous-dataset"]);
    db.run("UPDATE datasets SET anonymous = 0, withdrawn_at = '2026-01-01 00:00:00'");
    expect((await dispatch(id)).body.code).toBe("withdrawn");
    db.run("UPDATE datasets SET withdrawn_at = NULL");
    db.run(
      "INSERT INTO import_jobs (dataset_id, source, source_id, status) VALUES (?, 'openneuro', 'ds099999', 'finalizing')",
      [DS],
    );
    expect((await dispatch(id)).body.code).toBe("import-in-flight");
    expect(gh.dispatches).toEqual([]);
  });

  test("GitHub refusing the dispatch records an error, and the screen can then be sent again", async () => {
    seedMirror(DS);
    const id = seedRepull("pr_open");
    gh.dispatchStatus = 422;
    const failed = await dispatch(id);
    expect([failed.status, failed.body.code]).toEqual([502, "dispatch-failed"]);
    expect(screens(id)[0]).toMatchObject({ status: "error", nonce: null });
    expect(failed.body.screen).toMatchObject({ state: "error", gate: "rerun" });
    gh.dispatchStatus = 204;
    const again = await dispatch(id);
    expect(again.status).toBe(202);
    expect(screens(id)).toHaveLength(1);
    expect(screens(id)[0]).toMatchObject({ status: "pending", report: null });
  });

  test("a Worker without the callback secret records the screen as unconfigured and sends nothing", async () => {
    seedMirror(DS);
    const id = seedRepull("pr_open");
    const res = await dispatch(id, "n0", HEAD, { env: { PRESCREEN_CALLBACK_SECRET: undefined } });
    expect([res.status, res.body.code]).toEqual([503, "dispatch-unconfigured"]);
    expect(gh.requests).toEqual([]);
    expect(screens(id)[0]).toMatchObject({ status: "error", nonce: null });
  });

  test("a run in flight or a verdict is not dispatched again; a run past the deadline is", async () => {
    seedMirror(DS);
    const id = seedRepull("pr_open");
    expect((await dispatch(id)).status).toBe(202);
    const fresh = await dispatch(id);
    expect([fresh.status, fresh.body.code, fresh.body.screen.gate]).toEqual([
      409,
      "screen-exists",
      "wait",
    ]);
    // Past the deadline it reads unreported, at read time, with no writer.
    db.run(
      `UPDATE upstream_repull_screens SET dispatched_at = datetime('now', '-${SCREEN_REPORT_DEADLINE_MINUTES + 1} minutes')`,
    );
    const read = await call("GET", `/repulls/${id}/screens`);
    expect(read.body.screens[0]).toMatchObject({ state: "unreported", gate: "rerun" });
    expect(screens(id)[0]?.status).toBe("pending");
    const oldToken = (gh.dispatches[0] as Dispatch).client_payload.callback_token;
    expect((await dispatch(id)).status).toBe(202);
    expect(gh.dispatches).toHaveLength(2);
    // The new dispatch replaced the nonce, so the earlier run can no longer answer.
    const late = await callback(REPULL_SCREEN_CALLBACK_PATH, oldToken, {
      dataset_id: DS,
      request_id: 0,
      report: scanReport(HEAD),
    });
    expect(late.status).toBe(401);
    // A verdict stands: no second dispatch.
    const d = gh.dispatches.at(-1) as Dispatch;
    await callback(REPULL_SCREEN_CALLBACK_PATH, d.client_payload.callback_token, {
      dataset_id: DS,
      request_id: 0,
      report: scanReport(HEAD),
    });
    const verdict = await dispatch(id);
    expect([verdict.status, verdict.body.screen.gate]).toEqual([409, "clear"]);
    expect(gh.dispatches).toHaveLength(2);
  });

  test("a screen whose verdict lands between the read and the claim is not dispatched again", async () => {
    seedMirror(DS);
    const id = seedRepull("pr_open");
    gh.dispatchStatus = 422;
    await dispatch(id);
    gh.dispatchStatus = 204;
    expect(screens(id)[0]?.status).toBe("error");
    // The read sees an error (run it again); a verdict is stored before the claim's statement.
    const report = JSON.stringify(parseScreenReport(scanReport(HEAD)));
    const real = realD1(db);
    let done = false;
    const racing = {
      ...real,
      prepare(sql: string) {
        if (!done && sql.includes("SET status = 'pending', nonce = ?")) {
          done = true;
          db.run("UPDATE upstream_repull_screens SET status = 'clean', report = ?", [report]);
        }
        return real.prepare(sql);
      },
      batch: real.batch.bind(real),
    } as unknown as D1Database;
    const res = await app.request(
      `/admin/repulls/${id}/screen`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${ADMIN_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ pr: "n0", sha: HEAD }),
      },
      { ...env(), DB: racing },
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as Json).code).toBe("screen-exists");
    expect(gh.dispatches).toEqual([]);
    expect(screens(id)[0]?.status).toBe("clean");
  });

  test("a verdict that asks for a person is dispatched again until it is acknowledged; clear and blocking ones are not", async () => {
    seedMirror(DS);
    const id = seedRepull("pr_open");
    for (const state of [
      "review",
      "unchecked",
      "not-screened",
      "clean-edf-only-others-unscreened",
    ]) {
      db.run("DELETE FROM upstream_repull_screens");
      markScreen(id, state);
      const res = await dispatch(id);
      expect([state, res.status]).toEqual([state, 202]);
      expect(screens(id)[0]).toMatchObject({ status: "pending", report: null });
    }
    for (const state of ["clean", "direct-identifiers"]) {
      db.run("DELETE FROM upstream_repull_screens");
      markScreen(id, state);
      const res = await dispatch(id);
      expect([state, res.status, res.body.code]).toEqual([state, 409, "screen-exists"]);
    }
    db.run("DELETE FROM upstream_repull_screens");
    markScreen(id, "review");
    db.run(
      "UPDATE upstream_repull_screens SET ack_by = ?, ack_reason = 'read it', ack_at = datetime('now')",
      [adminId],
    );
    const acked = await dispatch(id);
    expect([acked.status, acked.body.code]).toEqual([409, "screen-exists"]);
    expect(gh.dispatches).toHaveLength(4);
  });

  test("an acknowledgment recorded between the read and the claim keeps the verdict", async () => {
    seedMirror(DS);
    const id = seedRepull("pr_open");
    markScreen(id, "review");
    const res = await dispatchOn(
      racingDb(
        (sql) => sql.includes("SET status = 'pending', nonce = ?"),
        () =>
          db.run(
            "UPDATE upstream_repull_screens SET ack_by = ?, ack_reason = 'read it', ack_at = datetime('now')",
            [adminId],
          ),
      ),
      id,
    );
    expect([res.status, res.body.code]).toEqual([409, "screen-exists"]);
    expect(screens(id)[0]).toMatchObject({ status: "review", ack_by: adminId });
    expect(gh.dispatches).toEqual([]);
  });

  test("a run claimed by another dispatch between the read and the claim is not dispatched twice", async () => {
    seedMirror(DS);
    const id = seedRepull("pr_open");
    gh.dispatchStatus = 422;
    await dispatch(id);
    gh.dispatchStatus = 204;
    const res = await dispatchOn(
      racingDb(
        (sql) => sql.includes("SET status = 'pending', nonce = ?"),
        () =>
          db.run(
            "UPDATE upstream_repull_screens SET status = 'pending', report = NULL, reported_at = NULL, nonce = 'theirs', dispatched_at = datetime('now')",
          ),
      ),
      id,
    );
    expect([res.status, res.body.code]).toEqual([409, "screen-exists"]);
    expect(screens(id)[0]?.nonce).toBe("theirs");
    expect(gh.dispatches).toEqual([]);
  });

  test("a head that moves between the read and the claim is not screened: a new screen, a rerun and the freed run", async () => {
    seedMirror(DS);
    const moveHead = (sha: string) => () =>
      db.run("UPDATE upstream_repulls SET head_sha = ?, revision = revision + 1", [sha]);
    // A new screen.
    const fresh = seedRepull("pr_open");
    const inserted = await dispatchOn(
      racingDb((sql) => sql.startsWith("INSERT INTO upstream_repull_screens"), moveHead(NEXT)),
      fresh,
    );
    expect([inserted.status, inserted.body.code]).toEqual([409, "stale-status"]);
    expect(screens(fresh)).toEqual([]);
    // A rerun of an error.
    db.run("DELETE FROM upstream_repulls");
    const rerun = seedRepull("pr_open");
    gh.dispatchStatus = 422;
    await dispatch(rerun);
    gh.dispatchStatus = 204;
    const again = await dispatchOn(
      racingDb((sql) => sql.includes("SET status = 'pending', nonce = ?"), moveHead(NEXT)),
      rerun,
    );
    expect([again.status, again.body.code]).toEqual([409, "stale-status"]);
    expect(screens(rerun)[0]?.status).toBe("error");
    // The earlier head's run keeps its nonce when the new head's claim does not apply.
    db.run("DELETE FROM upstream_repull_screens");
    db.run("DELETE FROM upstream_repulls");
    const freed = seedRepull("pr_open");
    expect((await dispatch(freed)).status).toBe(202);
    db.run("UPDATE upstream_repulls SET head_sha = ?", [NEXT]);
    const third = "fedcba9876543210fedcba9876543210fedcba98";
    const moved = await dispatchOn(
      racingDb((sql) => sql.startsWith("INSERT INTO upstream_repull_screens"), moveHead(third)),
      freed,
      NEXT,
    );
    expect([moved.status, moved.body.code]).toEqual([409, "stale-status"]);
    expect(screens(freed).map((r) => [r.sha, typeof r.nonce])).toEqual([[HEAD, "string"]]);
    expect(gh.dispatches).toHaveLength(1);
  });

  test("a report that arrives after the deadline, before another dispatch, still lands", async () => {
    seedMirror(DS);
    const id = seedRepull("pr_open");
    await dispatch(id);
    db.run(
      `UPDATE upstream_repull_screens SET dispatched_at = datetime('now', '-${SCREEN_REPORT_DEADLINE_MINUTES + 30} minutes')`,
    );
    const d = gh.dispatches[0] as Dispatch;
    const res = await callback(REPULL_SCREEN_CALLBACK_PATH, d.client_payload.callback_token, {
      dataset_id: DS,
      request_id: 0,
      report: scanReport(HEAD),
    });
    expect(res.status).toBe(200);
    expect(screens(id)[0]?.status).toBe("clean");
  });

  test("a new head's screen frees the old head's run, so only one run is out per re-pull", async () => {
    seedMirror(DS);
    const id = seedRepull("pr_open");
    await dispatch(id);
    const oldToken = (gh.dispatches[0] as Dispatch).client_payload.callback_token;
    // The head moved (enrichment), recorded by the pr_open self-edge.
    const moved = await move(id, {
      from: "pr_open",
      to: "pr_open",
      fields: { branch: "release/v2.0.0", pr_number: 7, head_sha: NEXT },
    });
    expect(moved.status).toBe(200);
    expect((await dispatch(id, "n0", NEXT)).status).toBe(202);
    const rows = screens(id);
    expect(rows.map((r) => [r.sha, r.nonce === null])).toEqual([
      [HEAD, true],
      [NEXT, false],
    ]);
    const old = await callback(REPULL_SCREEN_CALLBACK_PATH, oldToken, {
      dataset_id: DS,
      request_id: 0,
      report: scanReport(HEAD),
    });
    expect(old.status).toBe(401);
  });
});

// ----------------------------------------------------------------------------
// The callback
// ----------------------------------------------------------------------------

describe("the callback", () => {
  test("a Worker without the callback secret refuses every report", async () => {
    seedMirror(DS);
    const id = seedRepull("pr_open");
    await dispatch(id);
    const token = (gh.dispatches[0] as Dispatch).client_payload.callback_token;
    const res = await callback(
      REPULL_SCREEN_CALLBACK_PATH,
      token,
      { dataset_id: DS, request_id: 0, report: scanReport(HEAD) },
      { PRESCREEN_CALLBACK_SECRET: undefined },
    );
    expect(res.status).toBe(500);
    expect(screens(id)[0]?.status).toBe("pending");
  });

  test("stores the verdict once: a replay is refused", async () => {
    seedMirror(DS);
    const id = seedRepull("pr_open");
    const stored = await screenWith(id, scanReport(HEAD));
    expect(stored.status).toBe(200);
    // The answer carries no verdict: the workflow's logs are public.
    expect(stored.body).toEqual({ ok: true, dataset_id: DS });
    expect(screens(id)[0]).toMatchObject({ status: "clean", nonce: null });
    expect(typeof screens(id)[0]?.reported_at).toBe("string");
    const token = (gh.dispatches[0] as Dispatch).client_payload.callback_token;
    const replay = await callback(REPULL_SCREEN_CALLBACK_PATH, token, {
      dataset_id: DS,
      request_id: 0,
      report: scanReport(HEAD, "direct-identifiers"),
    });
    expect(replay.status).toBe(401);
    expect(screens(id)[0]?.status).toBe("clean");
  });

  test("a report about another commit, or another dataset, is stored as an error", async () => {
    seedMirror(DS);
    const id = seedRepull("pr_open");
    expect((await screenWith(id, scanReport(NEXT))).status).toBe(200);
    expect(screens(id)[0]?.status).toBe("error");
    const view = (await call("GET", `/repulls/${id}/screens`)).body.screens[0];
    expect(view).toMatchObject({ state: "error", gate: "rerun" });
    // Run again (an error may be re-dispatched), and answer for another dataset.
    expect((await screenWith(id, scanReport(HEAD, "clean", "on099998"))).status).toBe(200);
    expect(screens(id)[0]?.status).toBe("error");
    // And a body outside the contract.
    expect((await screenWith(id, { version: 1, nonsense: true })).status).toBe(200);
    expect(screens(id)[0]?.status).toBe("error");
  });

  test("another kind's token is refused here, and this kind's at the sweep and publication callbacks", async () => {
    seedMirror(DS);
    const id = seedRepull("pr_open");
    await dispatch(id);
    const nonce = screens(id)[0]?.nonce as string;
    const body = { dataset_id: DS, request_id: 0, report: scanReport(HEAD) };
    const sweep = await signIdentifierSweepCallbackToken({ datasetId: DS, nonce }, SECRET);
    const pub = await signIdentifierScreenCallbackToken(
      { datasetId: DS, requestId: 0, nonce },
      SECRET,
    );
    for (const token of [sweep, pub]) {
      expect((await callback(REPULL_SCREEN_CALLBACK_PATH, token, body)).status).toBe(401);
    }
    expect(screens(id)[0]?.status).toBe("pending");

    // A sweep and a publication screen waiting on the same nonce do not take the re-pull's token.
    const repullToken = await signIdentifierRepullCallbackToken(
      { datasetId: DS, repullId: id, pr: "n0", sha: HEAD, nonce },
      SECRET,
    );
    db.run(
      "UPDATE datasets SET sweep_stamps = json_object('identifier_sweep_attempt', 'pending', 'identifier_sweep_nonce', ?) WHERE dataset_id = ?",
      [nonce, DS],
    );
    expect((await callback("/webhooks/identifier-sweep-result", repullToken, body)).status).toBe(
      401,
    );
    const request = Number(
      db
        .query(
          `INSERT INTO publication_requests (dataset_id, requested_by, status, identifier_screen_status, identifier_screen_nonce)
           VALUES (?, ?, 'requested', 'pending', ?)`,
        )
        .run(DS, adminId, nonce).lastInsertRowid,
    );
    expect(
      (
        await callback("/webhooks/identifier-screen-result", repullToken, {
          ...body,
          request_id: request,
        })
      ).status,
    ).toBe(401);
    // The re-pull's own token still lands here.
    expect((await callback(REPULL_SCREEN_CALLBACK_PATH, repullToken, body)).status).toBe(200);
  });

  test("a request_id other than 0, or a re-pull that has ended, is refused", async () => {
    seedMirror(DS);
    const id = seedRepull("pr_open");
    await dispatch(id);
    const token = (gh.dispatches[0] as Dispatch).client_payload.callback_token;
    const bad = await callback(REPULL_SCREEN_CALLBACK_PATH, token, {
      dataset_id: DS,
      request_id: 7,
      report: scanReport(HEAD),
    });
    expect(bad.status).toBe(400);
    db.run("UPDATE upstream_repulls SET status = 'abandoned', terminal_at = datetime('now')");
    const ended = await callback(REPULL_SCREEN_CALLBACK_PATH, token, {
      dataset_id: DS,
      request_id: 0,
      report: scanReport(HEAD),
    });
    expect(ended.status).toBe(401);
    expect(screens(id)[0]?.status).toBe("pending");
  });
});

// ----------------------------------------------------------------------------
// Acknowledgment
// ----------------------------------------------------------------------------

describe("the acknowledgment", () => {
  const ack = (id: number, reason = "Read the report: the flagged column is a site code.") =>
    call("POST", `/repulls/${id}/screen/acknowledge`, { pr: "n0", sha: HEAD, reason });

  test("is recorded on a screen that asks for one, with the administrator and an audit row", async () => {
    seedMirror(DS);
    const id = seedRepull("pr_open");
    markScreen(id, "review");
    const res = await ack(id);
    expect(res.status).toBe(200);
    expect(res.body.screen).toMatchObject({ gate: "acknowledge", acknowledged_by: adminId });
    expect(screens(id)[0]).toMatchObject({ ack_by: adminId });
    const audit = db
      .query("SELECT details FROM audit_log WHERE action = 'repull_screen_acknowledged'")
      .get() as Row;
    expect(JSON.parse(audit.details as string)).toMatchObject({
      pr: "n0",
      sha: HEAD,
      screen_state: "review",
    });
  });

  test("is refused for a direct identifier, a clear screen, a screen with no verdict and none at all", async () => {
    seedMirror(DS);
    const id = seedRepull("pr_open");
    expect((await ack(id)).body.code).toBe("screen-not-found");
    markScreen(id, "direct-identifiers");
    expect((await ack(id)).body.code).toBe("screen-blocks");
    db.run("UPDATE upstream_repull_screens SET status = 'clean'");
    expect((await ack(id)).body.code).toBe("screen-not-acknowledgeable");
    db.run("DELETE FROM upstream_repull_screens");
    await dispatch(id);
    expect((await ack(id)).body.code).toBe("screen-not-acknowledgeable");
    expect(screens(id)[0]?.ack_at).toBeNull();
  });

  test("is recorded once: a second administrator is refused, and the first reason stands", async () => {
    seedMirror(DS);
    const id = seedRepull("pr_open");
    markScreen(id, "review");
    expect((await ack(id)).status).toBe(200);
    const second = await call(
      "POST",
      `/repulls/${id}/screen/acknowledge`,
      { pr: "n0", sha: HEAD, reason: "Another reason, from another administrator." },
      { key: OTHER_KEY },
    );
    expect([second.status, second.body.code]).toEqual([409, "already-acknowledged"]);
    expect(screens(id)[0]).toMatchObject({ ack_by: adminId });
    expect(screens(id)[0]?.ack_reason).toContain("site code");
  });

  test("an acknowledgment recorded between the read and the write is not replaced", async () => {
    seedMirror(DS);
    const id = seedRepull("pr_open");
    markScreen(id, "review");
    const res = await app.request(
      `/admin/repulls/${id}/screen/acknowledge`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${ADMIN_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ pr: "n0", sha: HEAD, reason: "My reason, long enough." }),
      },
      {
        ...env(),
        DB: racingDb(
          (sql) => sql.startsWith("UPDATE upstream_repull_screens\n  SET ack_by"),
          () =>
            db.run(
              "UPDATE upstream_repull_screens SET ack_by = ?, ack_reason = 'theirs', ack_at = datetime('now')",
              [otherId],
            ),
        ),
      },
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as Json).code).toBe("already-acknowledged");
    expect(screens(id)[0]).toMatchObject({ ack_by: otherId, ack_reason: "theirs" });
  });

  test("outside production an on dataset's screen is not acknowledged", async () => {
    seedMirror(DS);
    const id = seedRepull("pr_open");
    markScreen(id, "review");
    const res = await call(
      "POST",
      `/repulls/${id}/screen/acknowledge`,
      { pr: "n0", sha: HEAD, reason: "A reason long enough." },
      { env: { ENVIRONMENT: "test" } },
    );
    expect([res.status, res.body.code]).toEqual([403, "env-fence"]);
    expect(screens(id)[0]?.ack_at).toBeNull();
  });

  test("needs a reason of the publication path's length, and is not taken on an xx dataset", async () => {
    seedMirror(DS);
    const id = seedRepull("pr_open");
    markScreen(id, "review");
    expect((await ack(id, "short")).status).toBe(400);
    seedMirror("xx090123");
    const xx = seedRepull("pr_open", { dataset_id: "xx090123" });
    const res = await call("POST", `/repulls/${xx}/screen/acknowledge`, {
      pr: "n0",
      sha: HEAD,
      reason: "A reason long enough.",
    });
    expect(res.body.code).toBe("screen-exempt");
  });
});

// ----------------------------------------------------------------------------
// The gates
// ----------------------------------------------------------------------------

describe("the gates-clear edges read the screen", () => {
  const clear = (id: number, key = ADMIN_KEY) =>
    move(id, { from: "pr_open", to: "gates_clear", fields: { gates_sha: HEAD } }, key);

  test("a clear screen of the recorded head opens gates_clear, through the whole flow", async () => {
    seedMirror(DS);
    const id = seedRepull("pr_open");
    expect((await screenWith(id, scanReport(HEAD))).status).toBe(200);
    const res = await clear(id);
    expect(res.status).toBe(200);
    expect(res.body.repull).toMatchObject({ status: "gates_clear", gates_sha: HEAD });
  });

  test("every screen that does not pass keeps the row at pr_open", async () => {
    seedMirror(DS);
    const id = seedRepull("pr_open");
    const none = await clear(id);
    expect([none.status, none.body.code]).toEqual([409, "screen-not-clear"]);
    for (const [state, gate] of [
      ["direct-identifiers", "blocks"],
      ["review", "acknowledge"],
      ["unchecked", "acknowledge"],
      ["not-screened", "acknowledge"],
      ["error", "rerun"],
    ] as const) {
      db.run("DELETE FROM upstream_repull_screens");
      if (state === "error") {
        gh.dispatchStatus = 422;
        await dispatch(id);
        gh.dispatchStatus = 204;
      } else {
        markScreen(id, state);
      }
      const res = await clear(id);
      expect([state, res.status, res.body.code]).toEqual([state, 409, "screen-not-clear"]);
      expect(res.body.error).toContain(`gate: ${gate}`);
    }
    db.run("DELETE FROM upstream_repull_screens");
    await dispatch(id);
    expect((await clear(id)).body.error).toContain("gate: wait");
    expect(statusOf(id)).toBe("pr_open");
  });

  test("an acknowledged screen opens it for the administrator who acknowledged, not for another", async () => {
    seedMirror(DS);
    const id = seedRepull("pr_open");
    markScreen(id, "review");
    expect(
      (
        await call("POST", `/repulls/${id}/screen/acknowledge`, {
          pr: "n0",
          sha: HEAD,
          reason: "Read the report: nothing identifying.",
        })
      ).status,
    ).toBe(200);
    const other = await clear(id, OTHER_KEY);
    expect([other.status, other.body.code]).toEqual([409, "screen-not-clear"]);
    expect((await clear(id)).status).toBe(200);
  });

  test("the gates sha must be the recorded head, whose screen it is", async () => {
    seedMirror(DS);
    const id = seedRepull("pr_open");
    markScreen(id, "clean", { sha: NEXT });
    const res = await move(id, { from: "pr_open", to: "gates_clear", fields: { gates_sha: NEXT } });
    expect([res.status, res.body.code]).toEqual([400, "field-invalid"]);
    expect(statusOf(id)).toBe("pr_open");
  });

  test("a clear screen of another commit or of the other pull request does not count", async () => {
    seedMirror(DS);
    const id = seedRepull("pr_open");
    markScreen(id, "clean", { sha: NEXT });
    markScreen(id, "clean", { pr: "n1" });
    expect((await clear(id)).body.code).toBe("screen-not-clear");
  });

  test("a report whose head is not the commit is not clear, whatever the stored state says", async () => {
    seedMirror(DS);
    const id = seedRepull("pr_open");
    // A row edited by hand: the state says clean, the report names another commit.
    const report = JSON.stringify(parseScreenReport(scanReport(NEXT)));
    db.run(
      `INSERT INTO upstream_repull_screens (repull_id, pr, sha, status, report, reported_at)
       VALUES (?, 'n0', ?, 'clean', ?, datetime('now'))`,
      [id, HEAD, report],
    );
    const res = await clear(id);
    expect(res.body.code).toBe("screen-not-clear");
    expect(res.body.error).toContain("gate: unverified");
  });

  test("the dataset fences hold at the gates too", async () => {
    seedMirror(DS);
    const id = seedRepull("pr_open");
    markScreen(id, "clean");
    db.run("UPDATE datasets SET anonymous = 1");
    expect((await clear(id)).body.code).toBe("anonymous-dataset");
    expect(statusOf(id)).toBe("pr_open");
  });

  test("a verdict that changes between the read and the write is not relied on", async () => {
    seedMirror(DS);
    const id = seedRepull("pr_open");
    markScreen(id, "clean");
    // Change the stored verdict just before the transition's UPDATE runs.
    const real = realD1(db);
    let done = false;
    const racing = {
      ...real,
      prepare(sql: string) {
        if (!done && sql.startsWith("UPDATE upstream_repulls SET")) {
          done = true;
          db.run("UPDATE upstream_repull_screens SET status = 'direct-identifiers'");
        }
        return real.prepare(sql);
      },
      batch: real.batch.bind(real),
    } as unknown as D1Database;
    const res = await app.request(
      `/admin/repulls/${id}/transition`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${ADMIN_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: "pr_open", to: "gates_clear", fields: { gates_sha: HEAD } }),
      },
      { ...env(), DB: racing },
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as Json).code).toBe("screen-changed");
    expect(statusOf(id)).toBe("pr_open");
    expect(
      db.query("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'repull_transition'").get(),
    ).toEqual({ n: 0 });
  });

  test("N.0.1 is screened and gated the same way", async () => {
    seedMirror(DS);
    const id = seedRepull("patch_synthesized", { patch_head_sha: NEXT });
    gh.pulls[`${DS}#8`] = { head: { sha: NEXT, ref: "release/v2.0.1" } };
    expect((await screenWith(id, scanReport(NEXT), "n1", NEXT)).status).toBe(200);
    expect(screens(id)[0]).toMatchObject({ pr: "n1", sha: NEXT, status: "clean" });
    const res = await move(id, {
      from: "patch_synthesized",
      to: "patch_gates_clear",
      fields: { patch_gates_sha: NEXT },
    });
    expect(res.status).toBe(200);
    expect(res.body.repull.patch_gates_sha).toBe(NEXT);
  });

  test("an xx dataset is exempt: its gates open with no screen", async () => {
    seedMirror("xx090123");
    const id = seedRepull("pr_open", { dataset_id: "xx090123" });
    const res = await call(
      "POST",
      `/repulls/${id}/transition`,
      { from: "pr_open", to: "gates_clear", fields: { gates_sha: HEAD } },
      { env: { ENVIRONMENT: "test" } },
    );
    expect(res.status).toBe(200);
  });
});

describe("reading the screens", () => {
  test("lists a re-pull's screens newest first, with the gate of each, and nothing for xx", async () => {
    seedMirror(DS);
    const id = seedRepull("pr_open");
    markScreen(id, "clean", { sha: NEXT });
    markScreen(id, "review");
    const res = await call("GET", `/repulls/${id}/screens`);
    expect(res.status).toBe(200);
    expect(res.body.exempt).toBe(false);
    expect(res.body.screens.map((s: Json) => [s.sha, s.gate])).toEqual([
      [HEAD, "acknowledge"],
      [NEXT, "clear"],
    ]);
    // No nonce leaves the Worker.
    expect(JSON.stringify(res.body)).not.toContain("nonce");
    seedMirror("xx090123");
    const xx = seedRepull("pr_open", { dataset_id: "xx090123" });
    expect((await call("GET", `/repulls/${xx}/screens`)).body).toEqual({
      exempt: true,
      screens: [],
    });
  });
});
