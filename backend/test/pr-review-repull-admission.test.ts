/**
 * The review of the NEMAR App's automatic re-pull pull request (epic #1046 phase 7, #1913;
 * ADR 0111 narrows ADR 0092's "not bots" for exactly this class).
 *
 * The review's intake skips every bot's pull request. The Worker's own start of an automatic
 * re-pull record (`startRepullPullRequestReview`) is the one way the App's pull request is
 * admitted, so machine clean can ever find an ADR 0107 review that passed. Everything else about
 * bots is unchanged, and these tests say so through the real entry points: the webhook route and
 * the administrator's start route still answer `bot_author` for the App's pull request, and the
 * Worker's start refuses another bot, a pull request from another branch or a fork, and a record
 * at another head.
 *
 * Real engine: bun:sqlite behind realD1 with every migration applied, the real admin and webhook
 * routers, a hashed admin key, and a `Bun.serve()` stand-in for api.github.com
 * (NEMAR_GITHUB_API_URL) that serves the pull request and records every dispatch, check run and
 * comment. Resend is redirected to a capture that must stay empty: nothing here mails anyone.
 */

import type { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { Hono } from "hono";
import { NEMAR_APP_BOT_LOGIN, NEMAR_APP_BOT_USER_ID } from "../../shared/nemar-app";
import type { RepullStatus } from "../../shared/repull-state";
import { adminRoutes } from "../src/routes/admin";
import webhooks from "../src/routes/webhooks";
import { __resetRateLimitStateForTests } from "../src/services/github/transport";
import { readPullRequestEvent } from "../src/services/pr-review";
import { startRepullPullRequestReview } from "../src/services/pr-review-start";
import { hashApiKey } from "../src/services/token";
import { getRepull } from "../src/services/upstream-repull";
import { readReviewFact } from "../src/services/upstream-repull-facts";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";
import { type Row, rowAt } from "./helpers/repull-rows";
import { type CapturedEmail, withFakeResend } from "./helpers/resend";

const DS = "on004362";
const HEAD = "0123456789abcdef0123456789abcdef01234567";
const OTHER = "fedcba9876543210fedcba9876543210fedcba98";
const BASE_SHA = "9".repeat(40);
const BRANCH = "release/v2.0.0";
const ADMIN_KEY = "rpa-admin-key-0123456789abcdef0123456789abcdef0123";
const WEBHOOK_SECRET = "repull-admission-webhook-secret";
const CALLBACK_SECRET = "repull-admission-callback-secret";

const APP = { login: NEMAR_APP_BOT_LOGIN, id: NEMAR_APP_BOT_USER_ID, type: "Bot" };

interface Recorded {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
}

let server: Server;
let calls: Recorded[] = [];
/** What GitHub answers for `GET /repos/nemarDatasets/<ds>/pulls/<n>`: a pull request, or a status. */
let pulls: Record<string, Record<string, unknown> | number> = {};
let nextId = 5000;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const body = req.method === "GET" ? null : ((await req.json().catch(() => null)) as never);
      calls.push({ method: req.method, path: url.pathname, body });
      if (req.method === "POST" && url.pathname === "/repos/nemarDatasets/.github/dispatches") {
        return new Response(null, { status: 204 });
      }
      if (/\/check-runs(\/\d+)?$/.test(url.pathname)) {
        return Response.json({ id: ++nextId }, { status: req.method === "POST" ? 201 : 200 });
      }
      if (/\/issues\/(comments\/\d+|\d+\/comments)$/.test(url.pathname)) {
        return Response.json({ id: ++nextId }, { status: req.method === "POST" ? 201 : 200 });
      }
      const pull = url.pathname.match(/^\/repos\/nemarDatasets\/([^/]+)\/pulls\/(\d+)$/);
      if (req.method === "GET" && pull) {
        const hit = pulls[`${pull[1]}#${pull[2]}`];
        if (typeof hit === "number") {
          return new Response("{}", { status: hit, headers: { "Retry-After": "0" } });
        }
        return hit ? Response.json(hit) : new Response("{}", { status: 404 });
      }
      return new Response("not found", { status: 404 });
    },
  });
  (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL =
    `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL = undefined;
  server.stop(true);
});

let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;
let adminId = 0;
let repullId = 0;
let mail: CapturedEmail[] = [];
let releaseMail: (() => void) | null = null;
let mailDone: Promise<void> | null = null;

function env(over: Partial<Bindings> = {}): Bindings {
  return {
    DB: realD1(db),
    ENVIRONMENT: "production",
    AUTO_REPULL_ENABLED: "1",
    GITHUB_ADMIN_PAT: "ghp_repull_admission_test",
    GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET,
    PRESCREEN_CALLBACK_SECRET: CALLBACK_SECRET,
    PR_REVIEW_ENABLED: "1",
    API_BASE_URL: "https://api.test.nemar.org",
    RESEND_API_KEY: "re_test",
    FROM_EMAIL: "NEMAR <noreply@nemar.org>",
    ...over,
  } as Bindings;
}

beforeEach(async () => {
  db = freshDb();
  app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/admin", adminRoutes);
  app.route("/webhooks", webhooks);
  db.run(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified)
     VALUES ('rpaadmin', 'rpaadmin@example.org', 'x', 'approved', 'admin', 1)`,
  );
  adminId = (db.query("SELECT id FROM users WHERE username = 'rpaadmin'").get() as { id: number })
    .id;
  db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)").run(
    adminId,
    await hashApiKey(ADMIN_KEY),
    ADMIN_KEY.slice(0, 8),
  );
  db.run(
    `INSERT INTO datasets (dataset_id, name, owner_user_id, source, source_id, anonymous, status,
                           visibility, is_sandbox, github_repo, first_published_at)
     VALUES (?, ?, ?, 'openneuro', 'ds004362', 0, 'active', 'public', 0, ?, '2026-01-01 00:00:00')`,
    [DS, `A sufficiently descriptive title for ${DS}`, adminId, `nemarDatasets/${DS}`],
  );
  repullId = seedRepull("pr_open");
  pulls[`${DS}#7`] = appPull();
  __resetRateLimitStateForTests();
  await new Promise<void>((armed) => {
    mailDone = withFakeResend(
      (captured) =>
        new Promise<void>((done) => {
          mail = captured;
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
  calls = [];
  pulls = {};
  __resetRateLimitStateForTests();
});

function seedRepull(status: RepullStatus, over: Row = {}): number {
  const row = rowAt(status, {
    dataset_id: DS,
    upstream_ds: "ds004362",
    origin: "automatic",
    planner: 2,
    actor_user_id: adminId,
    head_sha: HEAD,
    counts: JSON.stringify({ unexplained: 0, conflicts: 0, corrections: 0 }),
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

/** The App's pull request #7 of DS as GitHub's REST API returns it. */
function appPull(
  o: {
    user?: Record<string, unknown>;
    sha?: string;
    ref?: string;
    headRepo?: string | null;
    number?: number;
  } = {},
): Record<string, unknown> {
  return {
    number: o.number ?? 7,
    state: "open",
    draft: false,
    merged: false,
    title: "Release v2.0.0",
    author_association: "NONE",
    user: o.user ?? APP,
    base: {
      ref: "main",
      sha: BASE_SHA,
      repo: { name: DS, full_name: `nemarDatasets/${DS}`, owner: { login: "nemarDatasets" } },
    },
    head: {
      sha: o.sha ?? HEAD,
      ref: o.ref ?? BRANCH,
      repo: o.headRepo === null ? null : { full_name: o.headRepo ?? `nemarDatasets/${DS}` },
    },
  };
}

async function startForRecord(over: Partial<Bindings> = {}) {
  const row = await getRepull(realD1(db), repullId);
  if (!row) throw new Error("no record");
  return startRepullPullRequestReview(env(over), row);
}

const reviews = () =>
  db.query("SELECT * FROM pr_reviews ORDER BY id").all() as Array<Record<string, unknown>>;
const dispatches = () =>
  calls.filter((c) => c.method === "POST" && c.path === "/repos/nemarDatasets/.github/dispatches");
const githubCalls = () => calls.filter((c) => c.path.startsWith("/repos/"));

async function sign(body: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(WEBHOOK_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(body));
  return `sha256=${Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")}`;
}

describe("the Worker's start of an automatic re-pull's review", () => {
  test("stores and dispatches a review of the App's pull request at the recorded head", async () => {
    const r = await startForRecord();

    expect(r).toMatchObject({ dispatched: true, reason: "dispatched" });
    expect(reviews()).toHaveLength(1);
    expect(reviews()[0]).toMatchObject({
      dataset_id: DS,
      pr_number: 7,
      head_sha: HEAD,
      author_id: NEMAR_APP_BOT_USER_ID,
      author_login: NEMAR_APP_BOT_LOGIN,
      from_fork: 0,
      state: "dispatched",
    });
    expect(dispatches()).toHaveLength(1);
    expect(dispatches()[0]?.body).toMatchObject({
      event_type: "run-pr-review",
      client_payload: { dataset_id: DS, pr_number: 7, head_sha: HEAD },
    });
    // The machine-clean rule now finds a review of that head, still running.
    expect(await readReviewFact(realD1(db), DS, 7, HEAD)).toBe("running");
    // The start is recorded, by no user: the automatic path's own act.
    const audit = db
      .query("SELECT * FROM audit_log WHERE action = 'pr_review_started'")
      .all() as Array<Record<string, unknown>>;
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ user_id: null, resource_id: `${DS}#7` });
    expect(JSON.parse(String(audit[0]?.details))).toMatchObject({
      head_sha: HEAD,
      repull_id: repullId,
      automatic: true,
    });
  });

  test("a second start of the same head dispatches nothing more", async () => {
    await startForRecord();
    const again = await startForRecord();
    expect(again).toMatchObject({ dispatched: false, reason: "duplicate" });
    expect(dispatches()).toHaveLength(1);
    expect(reviews()).toHaveLength(1);
  });

  test("a review that ended without a verdict is not started again, as an administrator's start would", async () => {
    // The Worker's start is no administrator's choice to pay for a second run: a commit whose
    // review errored keeps its answer, and only a dispatch GitHub never ran is tried again.
    db.run(
      `INSERT INTO pr_reviews (dataset_id, pr_number, head_sha, author_id, author_login, state,
                               detail, decided_at)
       VALUES (?, 7, ?, ?, ?, 'errored', 'model_unavailable', datetime('now'))`,
      [DS, HEAD, NEMAR_APP_BOT_USER_ID, NEMAR_APP_BOT_LOGIN],
    );
    expect(await startForRecord()).toMatchObject({ dispatched: false, reason: "duplicate" });
    expect(dispatches()).toEqual([]);
    db.run("UPDATE pr_reviews SET detail = 'dispatch_failed'");
    expect(await startForRecord()).toMatchObject({ dispatched: true });
    expect(dispatches()).toHaveLength(1);
  });

  test("the App is never exempt, even if an administrator's account names its login", async () => {
    // The exemption reads a login of a person's shape only, so no account can exempt the App.
    db.run(
      `INSERT INTO users (username, email, status, role, email_verified, github_username, account_kind)
       VALUES ('botname', 'botname@example.org', 'approved', 'admin', 1, ?, 'service')`,
      [NEMAR_APP_BOT_LOGIN],
    );
    expect(await startForRecord()).toMatchObject({ dispatched: true, reason: "dispatched" });
    expect(reviews()).toHaveLength(1);
  });

  test("an administrator's block on the App holds it back, like anyone's", async () => {
    db.run(
      `INSERT INTO pr_review_overrides (author_id, author_login, mode, reason, set_by)
       VALUES (?, ?, 'block', 'Hold the automatic path', ?)`,
      [NEMAR_APP_BOT_USER_ID, NEMAR_APP_BOT_LOGIN, adminId],
    );
    expect(await startForRecord()).toMatchObject({
      dispatched: false,
      reason: "contributor_paused",
    });
    expect(dispatches()).toEqual([]);
  });
});

describe("the start refuses everything but the App's recorded pull request", () => {
  const refusals: Array<[string, () => void, string]> = [
    [
      "another bot's pull request at the recorded number",
      () => {
        pulls[`${DS}#7`] = appPull({
          user: { login: "dependabot[bot]", id: 49699333, type: "Bot" },
        });
      },
      "not_app_author",
    ],
    [
      "the App's login with another id",
      () => {
        pulls[`${DS}#7`] = appPull({ user: { ...APP, id: 1 } });
      },
      "not_app_author",
    ],
    [
      "the App's login and id, as a person",
      () => {
        pulls[`${DS}#7`] = appPull({ user: { ...APP, type: "User" } });
      },
      "not_app_author",
    ],
    [
      "another login with the App's id and type",
      () => {
        pulls[`${DS}#7`] = appPull({ user: { ...APP, login: "nemar-publish-bot2[bot]" } });
      },
      "not_app_author",
    ],
    [
      "a person's pull request at the recorded number",
      () => {
        pulls[`${DS}#7`] = appPull({ user: { login: "contributor", id: 501, type: "User" } });
      },
      "not_app_author",
    ],
    [
      "the App's pull request from a branch that is not the release branch",
      () => {
        pulls[`${DS}#7`] = appPull({ ref: "release/v3.0.0" });
      },
      "bot_author",
    ],
    [
      "the App's pull request from a fork",
      () => {
        pulls[`${DS}#7`] = appPull({ headRepo: `someone/${DS}` });
      },
      "bot_author",
    ],
    [
      "the App's pull request from a deleted fork",
      () => {
        pulls[`${DS}#7`] = appPull({ headRepo: null });
      },
      "bot_author",
    ],
    [
      "the App's pull request at another head than the record's",
      () => {
        pulls[`${DS}#7`] = appPull({ sha: OTHER });
      },
      "head_moved",
    ],
    [
      "a pull request GitHub will not show",
      () => {
        pulls[`${DS}#7`] = 500;
      },
      "github_unreadable",
    ],
  ];
  for (const [name, flip, reason] of refusals) {
    test(`${name}: ${reason}`, async () => {
      flip();
      expect(await startForRecord()).toMatchObject({ dispatched: false, reason });
      expect(reviews()).toEqual([]);
      expect(dispatches()).toEqual([]);
    });
  }

  const unread: Array<[string, () => void, Partial<Bindings>, string]> = [
    ["outside exact production", () => {}, { ENVIRONMENT: "staging" }, "not_production"],
    ["with the open switch off", () => {}, { AUTO_REPULL_ENABLED: undefined }, "auto_repull_off"],
    [
      "with the review switched off",
      () => {},
      { PR_REVIEW_ENABLED: undefined },
      "pr_review_disabled",
    ],
    [
      "for an administrator's record",
      () => db.run("UPDATE upstream_repulls SET origin = 'administrator'"),
      {},
      "not_automatic",
    ],
    [
      "for an automatic record of an `nm` dataset",
      () => db.run("UPDATE upstream_repulls SET dataset_id = 'nm000600'"),
      {},
      "not_automatic",
    ],
    [
      "for an automatic record of a production sandbox `xx` dataset",
      () => db.run("UPDATE upstream_repulls SET dataset_id = 'xx000123'"),
      {},
      "not_automatic",
    ],
    [
      "for a dataset the dev Worker owns",
      () => db.run("UPDATE upstream_repulls SET dataset_id = 'xx090123'"),
      {},
      "not_owned_here",
    ],
    [
      "for a record past `pr_open`",
      () => {
        db.run("DELETE FROM upstream_repulls");
        repullId = seedRepull("gates_clear", { gates_sha: HEAD });
      },
      {},
      "not_pr_open",
    ],
    [
      "for an unpublished dataset",
      () => db.run("UPDATE datasets SET first_published_at = NULL"),
      {},
      "dataset_not_reviewable",
    ],
  ];
  for (const [name, flip, over, reason] of unread) {
    test(`${name}: ${reason}, and GitHub is asked nothing`, async () => {
      flip();
      expect(await startForRecord(over)).toMatchObject({ dispatched: false, reason });
      expect(githubCalls()).toEqual([]);
      expect(reviews()).toEqual([]);
    });
  }
});

describe("nothing else about bot authors changes", () => {
  test("a webhook delivery of the App's pull request is still a bot's, record or not", async () => {
    const payload = {
      action: "opened",
      number: 7,
      repository: { name: DS, full_name: `nemarDatasets/${DS}`, owner: { login: "nemarDatasets" } },
      pull_request: appPull(),
      sender: { login: NEMAR_APP_BOT_LOGIN, type: "Bot" },
    };
    const body = JSON.stringify(payload);
    const res = await app.request(
      "/webhooks/github",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-GitHub-Event": "pull_request",
          "X-GitHub-Delivery": "d-repull-1",
          "X-Hub-Signature-256": await sign(body),
        },
        body,
      },
      env(),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ dispatched: false, reason: "bot_author" });
    expect(reviews()).toEqual([]);
    expect(dispatches()).toEqual([]);
  });

  test("an administrator's start of the App's pull request is still a bot's", async () => {
    const res = await app.request(
      `/admin/pr-reviews/${DS}/7/start`,
      { method: "POST", headers: { Authorization: `Bearer ${ADMIN_KEY}` } },
      env(),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ dispatched: false, reason: "bot_author" });
    expect(reviews()).toEqual([]);
  });

  test("the intake admits the App only with the Worker's option, and only exactly the App", () => {
    const delivery = (pr: Record<string, unknown>) => ({
      action: "synchronize",
      pull_request: pr,
      repository: (pr.base as { repo: unknown }).repo,
    });
    const admit = { admitRepullBot: { branch: BRANCH } };
    const reason = (pr: Record<string, unknown>, opts = admit) => {
      const r = readPullRequestEvent(delivery(pr), opts);
      return r.ok ? `ok:${r.pr.authorLogin}:${r.pr.fromFork}` : r.reason;
    };

    expect(reason(appPull())).toBe(`ok:${NEMAR_APP_BOT_LOGIN}:false`);
    expect(reason(appPull(), {})).toBe("bot_author");
    expect(reason(appPull(), { admitRepullBot: { branch: "" } })).toBe("bot_author");
    // An empty branch names no release branch, even for a head that names none either.
    expect(reason(appPull({ ref: "" }), { admitRepullBot: { branch: "" } })).toBe("bot_author");
    expect(reason(appPull({ ref: "release/v3.0.0" }))).toBe("bot_author");
    expect(reason(appPull({ headRepo: `someone/${DS}` }))).toBe("bot_author");
    expect(reason(appPull({ headRepo: null }))).toBe("bot_author");
    expect(reason(appPull({ user: { ...APP, id: 1 } }))).toBe("bot_author");
    expect(reason(appPull({ user: { ...APP, type: "User" } }))).toBe("bot_author");
    expect(reason(appPull({ user: { ...APP, login: "nemar-publish-bot2[bot]" } }))).toBe(
      "bot_author",
    );
    expect(reason(appPull({ user: { login: "dependabot[bot]", id: 49699333, type: "Bot" } }))).toBe(
      "bot_author",
    );
    // A bot is a bot by its type or by its login's suffix, either one, and a person's login must
    // have a login's shape.
    expect(reason(appPull({ user: { login: "sneaky", id: 700, type: "Bot" } }))).toBe("bot_author");
    expect(reason(appPull({ user: { login: "helper[bot]", id: 701, type: "User" } }))).toBe(
      "bot_author",
    );
    expect(reason(appPull({ user: { login: "not a login!", id: 702, type: "User" } }))).toBe(
      "malformed",
    );
    // A person's pull request is read as it always was, with or without the option.
    expect(reason(appPull({ user: { login: "ada", id: 612, type: "User" } }))).toBe("ok:ada:false");
  });
});
