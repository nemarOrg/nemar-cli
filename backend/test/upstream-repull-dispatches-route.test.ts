/**
 * `GET /admin/repulls/dispatches` (epic #1046 phase 7, #1913; ADR 0111, the Phase 7h slice): the
 * automatic path's dispatches, newest first, for an administrator. Modeled on
 * `upstream-repulls-route.test.ts`: real SQLite behind `realD1` carrying every migration, the real
 * auth and admin middleware with seeded tokens, the real route and service.
 *
 * The properties, each with a test of its own:
 *  - the route answers before `/repulls/:id` would take its path for an id;
 *  - it is a keyset page, newest first: a cursor continues strictly below the id it names, so a
 *    walk of the pages meets every dispatch once, and the page is at most 50 rows whatever is asked,
 *    at the route and in the service;
 *  - the filters (the dataset, the state) narrow it, and a malformed query is refused by name;
 *  - a live dispatch's nonce, the secret its run's token is checked against, is never in the answer;
 *  - an administrator reads it, a member and a stranger do not, and nothing is mailed.
 */

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { DISPATCH_STATUSES, type DispatchStatus } from "../../shared/repull-state";
import { adminMiddleware, authMiddleware } from "../src/middleware/auth";
import { registerUpstreamRepullRoutes } from "../src/routes/admin/upstream-repulls";
import { hashApiKey } from "../src/services/token";
import {
  DISPATCH_LIST_SQL,
  DISPATCH_PAGE_DEFAULT,
  DISPATCH_PAGE_MAX,
  listDispatches,
} from "../src/services/upstream-repull-dispatch";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";
import { NONCE_MARK, seedDispatch } from "./helpers/repull-rows";
import { type CapturedEmail, withFakeResend } from "./helpers/resend";

const ADMIN_KEY = "rpd-admin-key-0123456789abcdef0123456789abcdef01";
const MEMBER_KEY = "rpd-member-key-0123456789abcdef0123456789abcdef0";

// biome-ignore lint/suspicious/noExplicitAny: a response body read field by field in assertions
type Json = Record<string, any>;
type App = Hono<{ Bindings: Bindings; Variables: Variables }>;

let db: Database;
let app: App;
let mail: CapturedEmail[] = [];
let releaseMail: (() => void) | null = null;
let mailDone: Promise<void> | null = null;

function newApp(): App {
  const a: App = new Hono();
  a.use("*", authMiddleware);
  a.use("*", adminMiddleware);
  registerUpstreamRepullRoutes(a);
  return a;
}

beforeEach(async () => {
  db = freshDb();
  app = newApp();
  for (const [name, role, key] of [
    ["rpdadmin", "admin", ADMIN_KEY],
    ["rpdmember", "member", MEMBER_KEY],
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
});

function env(): Bindings {
  return { DB: realD1(db), ENVIRONMENT: "production" } as unknown as Bindings;
}

async function get(path: string, key: string | null = ADMIN_KEY) {
  const res = await app.request(
    path,
    key ? { headers: { Authorization: `Bearer ${key}` } } : {},
    env(),
  );
  const text = await res.text();
  let body: Json = {};
  try {
    body = JSON.parse(text) as Json;
  } catch {
    // not JSON: left empty, the status says
  }
  return { status: res.status, body, text };
}

let seq = 0;

/** A dispatch, in a state the table accepts; live ones hold a nonce, as the claim leaves them. */
function seed(
  o: {
    dataset?: string;
    status?: DispatchStatus;
    kind?: "open" | "finish";
    code?: string | null;
    at?: string;
  } = {},
): number {
  const n = ++seq;
  const status = o.status ?? "refused";
  return seedDispatch(db, {
    dataset: o.dataset ?? `on09${String(n).padStart(4, "0")}`,
    status,
    kind: o.kind,
    code:
      o.code !== undefined
        ? o.code
        : ["refused", "failed", "dispatch_failed"].includes(status)
          ? "gitlink"
          : null,
    at: o.at ?? "2026-10-20 03:00:00",
    runUrl: `https://github.com/nemarDatasets/.github/actions/runs/${1000 + n}`,
  });
}

const COLUMNS = [
  "code",
  "dataset_id",
  "dispatched_at",
  "from_tag",
  "id",
  "kind",
  "reported_at",
  "repull_id",
  "status",
  "to_tag",
  "upstream_ds",
  "workflow_run_url",
];

// ----------------------------------------------------------------------------
// The route, and what it answers
// ----------------------------------------------------------------------------

describe("GET /repulls/dispatches", () => {
  test("answers before the :id route does, newest first, with every column but the nonce", async () => {
    const first = seed({ status: "opened" });
    const second = seed({ status: "started" });
    const third = seed({ status: "dispatched" });
    const res = await get("/repulls/dispatches");
    // `/repulls/:id` would answer 400 `invalid-id` for "dispatches", were it registered first.
    expect(res.status, res.text).toBe(200);
    expect(res.body.dispatches.map((d: Json) => d.id)).toEqual([third, second, first]);
    expect(res.body.next_after).toBeNull();
    for (const d of res.body.dispatches as Json[]) {
      expect(Object.keys(d).sort()).toEqual(COLUMNS);
    }
    const row = (res.body.dispatches as Json[]).find((d) => d.id === first);
    expect(row).toMatchObject({
      kind: "open",
      status: "opened",
      from_tag: "1.0.0",
      to_tag: "1.0.1",
      repull_id: 1,
    });
    expect(row?.workflow_run_url).toMatch(/^https:\/\/github\.com\/nemarDatasets\/\.github\//);
  });

  test("a live dispatch's nonce is in no answer, under any filter", async () => {
    seed({ status: "dispatched", dataset: "on098801" });
    seed({ status: "started", dataset: "on098802" });
    for (const path of [
      "/repulls/dispatches",
      "/repulls/dispatches?status=dispatched",
      "/repulls/dispatches?dataset=on098802",
      "/repulls/dispatches?limit=1",
    ]) {
      const res = await get(path);
      expect(res.status).toBe(200);
      expect(res.text).not.toContain("nonce");
      expect(res.text).not.toContain(NONCE_MARK);
    }
    // The statement itself names its columns: a `SELECT *` would ship the nonce beside them.
    expect(DISPATCH_LIST_SQL).not.toMatch(/SELECT\s+\*/);
    expect(DISPATCH_LIST_SQL).not.toContain("nonce");
  });

  test("a walk of the pages meets every dispatch once, strictly downward, and ends with no cursor", async () => {
    const ids = Array.from({ length: 60 }, () => seed());
    const seen: number[] = [];
    let after: number | null = null;
    let pages = 0;
    do {
      const res: Awaited<ReturnType<typeof get>> = await get(
        `/repulls/dispatches?limit=25${after === null ? "" : `&after=${after}`}`,
      );
      expect(res.status).toBe(200);
      const page = (res.body.dispatches as Json[]).map((d) => d.id as number);
      seen.push(...page);
      // The cursor is the last id of a full page, and a page that is not full ends the walk.
      expect(res.body.next_after).toBe(page.length === 25 ? (page.at(-1) ?? null) : null);
      after = res.body.next_after as number | null;
      pages++;
    } while (after !== null && pages < 10);
    expect(pages).toBe(3);
    expect(seen).toEqual([...ids].reverse());
    expect(new Set(seen).size).toBe(60);
  });

  test("the cursor is strict: the page that continues below an id never holds it", async () => {
    const ids = [seed(), seed(), seed(), seed()];
    const res = await get(`/repulls/dispatches?after=${ids[2]}`);
    expect((res.body.dispatches as Json[]).map((d) => d.id)).toEqual([ids[1], ids[0]]);
    expect((await get(`/repulls/dispatches?after=${ids[0]}`)).body.dispatches).toEqual([]);
  });

  test("a page is 25 rows by default and 50 at most, at the route and in the service", async () => {
    for (let i = 0; i < 60; i++) seed();
    expect(DISPATCH_PAGE_DEFAULT).toBe(25);
    expect(DISPATCH_PAGE_MAX).toBe(50);
    expect((await get("/repulls/dispatches")).body.dispatches).toHaveLength(25);
    expect((await get("/repulls/dispatches?limit=50")).body.dispatches).toHaveLength(50);
    expect((await get("/repulls/dispatches?limit=1")).body.dispatches).toHaveLength(1);
    for (const limit of ["51", "500", "0", "-1", "1.5", "abc", ""]) {
      const res = await get(`/repulls/dispatches?limit=${limit}`);
      expect([limit, res.status, res.body.code]).toEqual([limit, 400, "invalid-query"]);
    }
    // The service clamps as well, so no other caller gets more than a page.
    expect(await listDispatches(realD1(db), { limit: 1000 })).toHaveLength(50);
    expect(await listDispatches(realD1(db), { limit: 0 })).toHaveLength(1);
    expect(await listDispatches(realD1(db), {})).toHaveLength(25);
  });

  test("the dataset and the state narrow the page, together and with a cursor", async () => {
    const a1 = seed({ dataset: "on098811", status: "refused" });
    const a2 = seed({ dataset: "on098811", status: "unreported" });
    seed({ dataset: "on098812", status: "unreported" });
    const a3 = seed({ dataset: "on098811", status: "unreported" });
    const ids = async (q: string) =>
      ((await get(`/repulls/dispatches${q}`)).body.dispatches as Json[]).map((d) => d.id);
    expect(await ids("?dataset=on098811")).toEqual([a3, a2, a1]);
    expect(await ids("?status=unreported")).toHaveLength(3);
    expect(await ids("?dataset=on098811&status=unreported")).toEqual([a3, a2]);
    expect(await ids(`?dataset=on098811&status=unreported&after=${a3}`)).toEqual([a2]);
    // A dataset with none, and a valid id that is not an `on` one, are empty and not an error.
    expect(await ids("?dataset=on098899")).toEqual([]);
    expect(await ids("?dataset=nm000108")).toEqual([]);
    for (const status of DISPATCH_STATUSES) {
      expect((await get(`/repulls/dispatches?status=${status}`)).status).toBe(200);
    }
  });

  test("a malformed query is refused by name, and nothing is read", async () => {
    seed();
    for (const q of [
      "dataset=xyz",
      "dataset=on12",
      "status=bogus",
      "status=",
      "after=abc",
      "after=0",
      "after=-3",
      "after=1.5",
    ]) {
      const res = await get(`/repulls/dispatches?${q}`);
      expect([q, res.status, res.body.code]).toEqual([q, 400, "invalid-query"]);
    }
  });

  test("an administrator reads it, a member and a stranger do not", async () => {
    seed();
    expect((await get("/repulls/dispatches", MEMBER_KEY)).status).toBe(403);
    expect((await get("/repulls/dispatches", null)).status).toBe(401);
    expect((await get("/repulls/dispatches", ADMIN_KEY)).status).toBe(200);
  });

  test("a table that is not there is a 500 that names the migration, not an empty list", async () => {
    db.run("DROP TABLE upstream_repull_dispatches");
    const res = await get("/repulls/dispatches");
    expect(res.status).toBe(500);
    expect(res.body.error).toContain("Failed to read the dispatches");
    expect(res.body.error).toContain("is migration 0112 applied?");
  });

  test("it writes nothing", async () => {
    seed();
    const before = db.query("SELECT COUNT(*) AS n FROM audit_log").get();
    await get("/repulls/dispatches");
    expect(db.query("SELECT COUNT(*) AS n FROM audit_log").get()).toEqual(before as object);
    expect(db.query("SELECT COUNT(*) AS n FROM upstream_repull_dispatches").get()).toEqual({
      n: 1,
    });
  });
});
