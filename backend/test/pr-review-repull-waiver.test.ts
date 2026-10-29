/**
 * The waiver of the review for an upstream re-pull's own pull request (ADR 0116), through the real
 * entry points: the webhook route, the administrator's start and detail routes, the re-pull
 * record's transition route, the review's callback store and its watchdog.
 *
 * The rule is pinned alone in `test/repull-review-waiver.unit.test.ts`; this suite shows the Worker
 * asks it where it says it does, publishes what it says, and reviews everything else as before.
 * Its negative cases are the ones a forged pull request would try: a branch that merely names a
 * release, a fork, a record of another dataset or at another status, and a head the record does
 * not hold.
 *
 * Real engine: bun:sqlite behind realD1 with every migration applied, the real admin and webhook
 * routers, a hashed admin key, and a `Bun.serve()` stand-in for api.github.com
 * (NEMAR_GITHUB_API_URL) that serves the pull request, the permission and naming reads, and records
 * every dispatch, check run and comment write. Resend is redirected to a capture that must stay
 * empty.
 */

import type { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { NEMAR_APP_BOT_LOGIN, NEMAR_APP_BOT_USER_ID } from "../../shared/nemar-app";
import { parseStoredPrReviewReport } from "../../shared/pr-review";
import type { RepullRow, RepullStatus } from "../../shared/repull-state";
import { adminRoutes } from "../src/routes/admin";
import webhooks from "../src/routes/webhooks";
import { __resetRateLimitStateForTests } from "../src/services/github/transport";
import { storePrReviewResult, sweepStalePrReviews } from "../src/services/pr-review";
import { plainRef } from "../src/services/pr-review-queue";
import {
  REPULL_WAIVER_RECORDS_SQL,
  readWaiverRecords,
} from "../src/services/pr-review-repull-waiver";
import { hashApiKey } from "../src/services/token";
import { recordedHeadOf } from "../src/services/upstream-repull";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";
import { isNamingPath, namingResponse } from "./helpers/github-naming";
import { isPermissionPath, permissionResponse } from "./helpers/github-permission";
import { goodReport } from "./helpers/pr-queue-fixtures";
import { type Row, rowAt } from "./helpers/repull-rows";
import { type CapturedEmail, withFakeResend } from "./helpers/resend";

const DS = "on004362";
const SYNTH = "1111111111111111111111111111111111111111";
const HEAD = "0123456789abcdef0123456789abcdef01234567";
const OTHER = "fedcba9876543210fedcba9876543210fedcba98";
const BASE_SHA = "9".repeat(40);
const BRANCH = "release/v2.0.0";
const ADMIN_KEY = "rpw-admin-key-0123456789abcdef0123456789abcdef0123";
const WEBHOOK_SECRET = "repull-waiver-webhook-secret";
const CALLBACK_SECRET = "repull-waiver-callback-secret";
const ADMIN_GH = "admin-gh";
const ADMIN_GH_ID = 602;

interface Recorded {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
}

let server: ReturnType<typeof Bun.serve>;
let calls: Recorded[] = [];
/** What GitHub answers for `GET /repos/nemarDatasets/<ds>/pulls/<n>`. */
let pulls: Record<string, Record<string, unknown>> = {};
let nextId = 5000;
/** An HTTP status every check-run write is answered with instead of success, or null. */
let checkRunFailure: number | null = null;
/** A status the update of an existing check run is answered with, refusing it; null takes it. */
let checkPatchFailure: number | null = null;

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
      const permission = await permissionResponse(url, {});
      if (permission) return permission;
      if (isNamingPath(url.pathname)) {
        return (await namingResponse(url, {})) ?? new Response("{}", { status: 404 });
      }
      if (checkPatchFailure !== null && /\/check-runs\/\d+$/.test(url.pathname)) {
        return new Response("{}", { status: checkPatchFailure, headers: { "Retry-After": "0" } });
      }
      if (checkRunFailure !== null && /\/check-runs(\/\d+)?$/.test(url.pathname)) {
        return new Response("{}", { status: checkRunFailure, headers: { "Retry-After": "0" } });
      }
      const run = url.pathname.match(/\/check-runs\/(\d+)$/);
      if (run) return Response.json({ id: Number(run[1]) });
      if (/\/check-runs$/.test(url.pathname))
        return Response.json({ id: ++nextId }, { status: 201 });
      const comment = url.pathname.match(/\/issues\/comments\/(\d+)$/);
      if (comment) return Response.json({ id: Number(comment[1]) });
      if (/\/issues\/\d+\/comments$/.test(url.pathname)) {
        return Response.json({ id: ++nextId }, { status: 201 });
      }
      const pull = url.pathname.match(/^\/repos\/nemarDatasets\/([^/]+)\/pulls\/(\d+)$/);
      if (req.method === "GET" && pull) {
        const hit = pulls[`${pull[1]}#${pull[2]}`];
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
    GITHUB_ADMIN_PAT: "ghp_repull_waiver_test",
    GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET,
    PRESCREEN_CALLBACK_SECRET: CALLBACK_SECRET,
    PR_REVIEW_ENABLED: "1",
    API_BASE_URL: "https://api.test.nemar.org",
    RESEND_API_KEY: "re_test",
    FROM_EMAIL: "NEMAR <noreply@nemar.org>",
    ...over,
  } as Bindings;
}

function mirror(ds: string): void {
  db.run(
    `INSERT INTO datasets (dataset_id, name, owner_user_id, source, source_id, anonymous, status,
                           visibility, is_sandbox, github_repo, first_published_at)
     VALUES (?, ?, ?, 'openneuro', ?, 0, 'active', 'public', 0, ?, '2026-01-01 00:00:00')`,
    [
      ds,
      `A sufficiently descriptive title for ${ds}`,
      adminId,
      `ds${ds.slice(2)}`,
      `nemarDatasets/${ds}`,
    ],
  );
}

beforeEach(async () => {
  db = freshDb();
  app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/admin", adminRoutes);
  app.route("/webhooks", webhooks);
  db.run(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified, github_username)
     VALUES ('rpwadmin', 'rpwadmin@example.org', 'x', 'approved', 'admin', 1, ?)`,
    [ADMIN_GH],
  );
  adminId = (db.query("SELECT id FROM users WHERE username = 'rpwadmin'").get() as { id: number })
    .id;
  db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)").run(
    adminId,
    await hashApiKey(ADMIN_KEY),
    ADMIN_KEY.slice(0, 8),
  );
  mirror(DS);
  repullId = seedRepull("pr_open", { head_sha: HEAD });
  pulls[`${DS}#7`] = pull();
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
  checkRunFailure = null;
  checkPatchFailure = null;
  __resetRateLimitStateForTests();
});

function seedRepull(status: RepullStatus, over: Row = {}): number {
  const row = rowAt(status, {
    dataset_id: DS,
    upstream_ds: "ds004362",
    origin: "administrator",
    actor_user_id: adminId,
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

/** Pull request #`number` of `ds` as GitHub's REST API returns it: by default the re-pull's own. */
function pull(
  o: {
    ds?: string;
    user?: Record<string, unknown>;
    sha?: string;
    ref?: string;
    headRepo?: string | null;
    number?: number;
  } = {},
): Record<string, unknown> {
  const ds = o.ds ?? DS;
  return {
    number: o.number ?? 7,
    state: "open",
    draft: false,
    merged: false,
    title: "Release v2.0.0",
    author_association: "CONTRIBUTOR",
    user: o.user ?? { login: ADMIN_GH, id: ADMIN_GH_ID, type: "User" },
    base: {
      ref: "main",
      sha: BASE_SHA,
      repo: { name: ds, full_name: `nemarDatasets/${ds}`, owner: { login: "nemarDatasets" } },
    },
    head: {
      sha: o.sha ?? HEAD,
      ref: o.ref ?? BRANCH,
      repo: o.headRepo === null ? null : { full_name: o.headRepo ?? `nemarDatasets/${ds}` },
    },
  };
}

const ENRICHMENT = { login: NEMAR_APP_BOT_LOGIN, type: "Bot" };

/** A `pull_request` delivery, signed as GitHub signs it. */
async function deliver(
  action: string,
  pr: Record<string, unknown>,
  sender: Record<string, unknown> = ENRICHMENT,
  extra: Record<string, unknown> = {},
) {
  const base = pr.base as { repo: unknown };
  const body = JSON.stringify({
    action,
    number: pr.number,
    repository: base.repo,
    pull_request: pr,
    sender,
    ...extra,
  });
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(WEBHOOK_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(body));
  const res = await app.request(
    "/webhooks/github",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-GitHub-Event": "pull_request",
        "X-GitHub-Delivery": `d-${crypto.randomUUID()}`,
        "X-Hub-Signature-256": `sha256=${Array.from(new Uint8Array(sig))
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("")}`,
      },
      body,
    },
    env(),
  );
  expect(res.status).toBe(200);
  return (await res.json()) as { dispatched: boolean; reason: string; review_id?: number };
}

const reviews = () =>
  db.query("SELECT * FROM pr_reviews ORDER BY id").all() as Array<Record<string, unknown>>;
const dispatches = () =>
  calls.filter((c) => c.method === "POST" && c.path === "/repos/nemarDatasets/.github/dispatches");
const checkWrites = () => calls.filter((c) => /\/check-runs(\/\d+)?$/.test(c.path));
const commentWrites = () => calls.filter((c) => /\/issues\/.*comments/.test(c.path));
const waiverAudits = () =>
  (
    db
      .query("SELECT * FROM audit_log WHERE action = 'pr_review_waived' ORDER BY id")
      .all() as Array<Record<string, unknown>>
  ).map((a) => ({ ...a, details: JSON.parse(String(a.details)) as Record<string, unknown> }));

/** What a contributor-protection review says of an upstream delta: it fails, with findings. */
function failingReport() {
  return {
    ...goodReport({ no_degradation: "fail" }),
    findings: [
      {
        criterion: "no_degradation",
        severity: "blocker",
        code: "original_field_altered",
        path: "participants.tsv",
        note: "A participant value changed.",
      },
      {
        criterion: "no_degradation",
        severity: "blocker",
        code: "metadata_removed",
        path: "task-rest_eeg.json",
        note: "Two keys removed.",
      },
    ],
  };
}

/** A failed review of `sha`, published to check run 77 and comment 88, as the one in production. */
function seedFailedReview(sha: string = HEAD): number {
  return Number(
    db
      .query(
        `INSERT INTO pr_reviews (dataset_id, pr_number, head_sha, author_id, author_login, state,
                                 verdict, report, check_run_id, comment_id, decided_at, published_at)
         VALUES (?, 7, ?, ?, ?, 'reported', 'fail', ?, 77, 88, datetime('now'), datetime('now'))`,
      )
      .run(DS, sha, ADMIN_GH_ID, ADMIN_GH, JSON.stringify(failingReport())).lastInsertRowid,
  );
}

/** Every check run write's conclusion and title, in order. */
const checkOutcomes = () =>
  checkWrites().map((c) => ({
    method: c.method,
    path: c.path.replace(/^\/repos\/nemarDatasets\/[^/]+/, ""),
    conclusion: c.body?.conclusion ?? null,
    title: (c.body?.output as { title?: string } | undefined)?.title ?? null,
  }));

const WAIVED_TITLE = "Waived: upstream re-pull";

// ----------------------------------------------------------------------------

describe("why the owner and administrator exemption did not catch it", () => {
  test("the administrator's own push is exempt, and enrichment's push of the same pull request is reviewed", async () => {
    // No record names the pull request: the exemption alone decides, as before this change.
    db.run("DELETE FROM upstream_repulls");
    const opened = await deliver("opened", pull({ sha: SYNTH }), { login: ADMIN_GH, type: "User" });
    expect(opened).toMatchObject({ dispatched: false, reason: "exempt_author" });
    // Enrichment commits back as the NEMAR App, whose login is not a person's: no usable sender,
    // so the delivery is not exempt, and the review runs on the upstream delta.
    const enriched = await deliver("synchronize", pull({ sha: HEAD }));
    expect(enriched).toMatchObject({ dispatched: true });
    expect(reviews()).toEqual([
      expect.objectContaining({ head_sha: HEAD, author_login: ADMIN_GH, state: "dispatched" }),
    ]);
  });
});

describe("the record's own pull request at the recorded head is waived", () => {
  test("enrichment's delivery is answered with one skipped check, and no row, dispatch or model call", async () => {
    const r = await deliver("synchronize", pull());
    expect(r).toMatchObject({ dispatched: false, reason: "repull_waived" });
    expect(reviews()).toEqual([]);
    expect(dispatches()).toEqual([]);
    expect(checkOutcomes()).toEqual([
      { method: "POST", path: "/check-runs", conclusion: "skipped", title: WAIVED_TITLE },
    ]);
    const [post] = checkWrites();
    expect(post?.body).toMatchObject({ name: "NEMAR PR Review", head_sha: HEAD });
    const text = String((post?.body?.output as { text?: string }).text);
    expect(text).toContain("Skipped is not a pass");
    expect(text).toContain("None: no review of this commit reported findings");
    // No comment: nothing was reviewed, as for an exempt pull request.
    expect(commentWrites()).toEqual([]);
    expect(waiverAudits()).toEqual([
      expect.objectContaining({
        user_id: null,
        resource_id: `${DS}#7`,
        details: {
          head_sha: HEAD,
          repull_id: repullId,
          pull_request: "n0",
          origin: "administrator",
          trigger: "delivery",
          review_id: null,
        },
      }),
    ]);
  });

  test("an edit, a reopening and a marking as ready of a head a review failed are waived too, and none restarts it", async () => {
    const id = seedFailedReview();
    const edited = { changes: { title: { from: "Something else" } } };
    for (const [action, extra] of [
      ["edited", edited],
      ["reopened", {}],
      ["ready_for_review", {}],
      ["synchronize", {}],
    ] as const) {
      const r = await deliver(action, pull(), { login: "member-gh", type: "User" }, extra);
      expect([action, r.reason, r.dispatched]).toEqual([action, "repull_waived", false]);
    }
    expect(dispatches()).toEqual([]);
    // The row keeps what its review said, as the history of that run, and no restart counted.
    expect(reviews()).toEqual([
      expect.objectContaining({ id, state: "reported", verdict: "fail", edit_restarts: 0 }),
    ]);
    // Its own check run is updated in place each time, never a new one: four deliveries, four
    // updates of run 77 to the waiver.
    expect(checkOutcomes()).toEqual(
      Array.from({ length: 4 }, () => ({
        method: "PATCH",
        path: "/check-runs/77",
        conclusion: "skipped",
        title: WAIVED_TITLE,
      })),
    );
  });

  test("N.0.1's pull request at its recorded head is waived", async () => {
    db.run("DELETE FROM upstream_repulls");
    seedRepull("patch_synthesized", { patch_pr_number: 8, patch_head_sha: OTHER });
    pulls[`${DS}#8`] = pull({ number: 8, sha: OTHER, ref: "release/v2.0.1" });
    const r = await deliver("synchronize", pull({ number: 8, sha: OTHER, ref: "release/v2.0.1" }));
    expect(r).toMatchObject({ dispatched: false, reason: "repull_waived" });
    expect(waiverAudits()[0]?.details).toMatchObject({ pull_request: "n1" });
  });
});

describe("the NEMAR App's automatic re-pull pull request at its recorded head", () => {
  const APP = { login: NEMAR_APP_BOT_LOGIN, id: NEMAR_APP_BOT_USER_ID, type: "Bot" };
  beforeEach(() => {
    db.run("UPDATE upstream_repulls SET origin = 'automatic'");
    pulls[`${DS}#7`] = pull({ user: APP });
  });

  test("a delivery is answered with the waiver, and never reviewed", async () => {
    const r = await deliver("synchronize", pull({ user: APP }));
    expect(r).toMatchObject({ dispatched: false, reason: "repull_waived" });
    expect(reviews()).toEqual([]);
    expect(dispatches()).toEqual([]);
    expect(checkOutcomes()).toEqual([
      { method: "POST", path: "/check-runs", conclusion: "skipped", title: WAIVED_TITLE },
    ]);
    expect(waiverAudits()[0]?.details).toMatchObject({ origin: "automatic", trigger: "delivery" });
  });

  test("an administrator's start publishes the waiver again", async () => {
    const res = await app.request(
      `/admin/pr-reviews/${DS}/7/start`,
      { method: "POST", headers: { Authorization: `Bearer ${ADMIN_KEY}` } },
      env(),
    );
    expect(await res.json()).toMatchObject({ dispatched: false, reason: "repull_waived" });
    expect(checkOutcomes()).toEqual([
      { method: "POST", path: "/check-runs", conclusion: "skipped", title: WAIVED_TITLE },
    ]);
    expect(dispatches()).toEqual([]);
  });
});

describe("a waived check GitHub will not take is a failure someone sees", () => {
  test("the webhook answers 500, so the delivery can be redelivered", async () => {
    checkRunFailure = 422;
    const body = JSON.stringify({
      action: "synchronize",
      number: 7,
      repository: (pull().base as { repo: unknown }).repo,
      pull_request: pull(),
      sender: ENRICHMENT,
    });
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      enc.encode(WEBHOOK_SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sig = Array.from(new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(body))))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const res = await app.request(
      "/webhooks/github",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-GitHub-Event": "pull_request",
          "X-GitHub-Delivery": "d-waiver-500",
          "X-Hub-Signature-256": `sha256=${sig}`,
        },
        body,
      },
      env(),
    );
    expect(res.status).toBe(500);
    expect(waiverAudits()).toEqual([]);
    expect(reviews()).toEqual([]);
    expect(dispatches()).toEqual([]);
  });

  test("an administrator's start answers 502 with a sentence, and nothing is dispatched", async () => {
    checkRunFailure = 422;
    const res = await app.request(
      `/admin/pr-reviews/${DS}/7/start`,
      { method: "POST", headers: { Authorization: `Bearer ${ADMIN_KEY}` } },
      env(),
    );
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ code: "github_unavailable" });
    expect(dispatches()).toEqual([]);
  });
});

describe("an administrator corrects a check a review failed before the head was recorded", () => {
  for (const redo of [false, true]) {
    test(`start${redo ? " --redo" : ""} updates that check run to the waiver, with the findings as recommendations`, async () => {
      const id = seedFailedReview();
      const res = await app.request(
        `/admin/pr-reviews/${DS}/7/start${redo ? "?redo=1" : ""}`,
        { method: "POST", headers: { Authorization: `Bearer ${ADMIN_KEY}` } },
        env(),
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        dispatched: false,
        reason: "repull_waived",
        review_id: id,
      });
      expect(dispatches()).toEqual([]);
      const [patch] = checkWrites();
      expect(checkOutcomes()).toEqual([
        { method: "PATCH", path: "/check-runs/77", conclusion: "skipped", title: WAIVED_TITLE },
      ]);
      const text = String((patch?.body?.output as { text?: string }).text);
      expect(text).toContain("Recommended issues, none filed automatically");
      expect(text).toContain(
        "Original field changed (`participants.tsv`): A participant value changed.",
      );
      expect(text).toContain("Metadata removed (`task-rest_eeg.json`): Two keys removed.");
      expect(text).not.toContain("blocker");
      // The pull request's one comment says the same.
      const comment = commentWrites().find((c) => c.path.endsWith("/issues/comments/88"));
      expect(String(comment?.body?.body)).toContain("NOT REQUIRED");
      expect(String(comment?.body?.body)).toContain("Metadata removed");
      // The row keeps the review's verdict; the audit row names the administrator.
      expect(reviews()[0]).toMatchObject({ state: "reported", verdict: "fail" });
      expect(waiverAudits()).toEqual([
        expect.objectContaining({
          user_id: adminId,
          details: expect.objectContaining({ trigger: "admin_start", review_id: id }),
        }),
      ]);
    });
  }

  test("the detail view says waived, whatever the stored review said, and keeps that review", async () => {
    seedFailedReview();
    const res = await app.request(
      `/admin/pr-reviews/${DS}/7?head=${HEAD}`,
      { headers: { Authorization: `Bearer ${ADMIN_KEY}` } },
      env(),
    );
    expect(res.status).toBe(200);
    const d = (await res.json()) as Record<string, unknown>;
    expect(d).toMatchObject({
      verdict: "waived",
      detail: null,
      head_sha: HEAD,
      review_current: true,
    });
    expect((d.review as { verdict: string }).verdict).toBe("fail");
    // Another head of the same pull request is not waived: the record does not hold it.
    const other = await app.request(
      `/admin/pr-reviews/${DS}/7?head=${OTHER}`,
      { headers: { Authorization: `Bearer ${ADMIN_KEY}` } },
      env(),
    );
    expect(((await other.json()) as { verdict: string }).verdict).not.toBe("waived");
    // Nor is the recorded head of a pull request GitHub shows from another branch, or from a fork.
    for (const shown of [
      pull({ ref: "release/v3.0.0" }),
      pull({ headRepo: `contributor/${DS}` }),
    ]) {
      pulls[`${DS}#7`] = shown;
      const moved = await app.request(
        `/admin/pr-reviews/${DS}/7?head=${HEAD}`,
        { headers: { Authorization: `Bearer ${ADMIN_KEY}` } },
        env(),
      );
      expect(((await moved.json()) as { verdict: string }).verdict).toBe("fail");
    }
  });
});

describe("everything else is reviewed as before", () => {
  const CONTRIBUTOR = { login: "contributor", id: 501, type: "User" };
  const cases: Array<[string, () => Record<string, unknown>]> = [
    [
      "a contributor's pull request that merely names its branch like a release",
      () => pull({ number: 12, ref: "release/v9.0.0", user: CONTRIBUTOR }),
    ],
    [
      "a fork's pull request at the record's number, branch and head",
      () => pull({ user: CONTRIBUTOR, headRepo: `contributor/${DS}` }),
    ],
    [
      "a deleted fork's pull request at the record's number and head",
      () => pull({ user: CONTRIBUTOR, headRepo: null }),
    ],
    [
      "the record's pull request at a head the record does not hold",
      () => pull({ sha: OTHER, user: CONTRIBUTOR }),
    ],
    [
      "the record's number from another branch",
      () => pull({ ref: "release/v3.0.0", user: CONTRIBUTOR }),
    ],
    [
      "an ordinary contributor's pull request",
      () => pull({ number: 13, ref: "fix-readme", user: CONTRIBUTOR }),
    ],
  ];
  for (const [name, make] of cases) {
    test(`${name}: reviewed`, async () => {
      // GitHub's own record of the pull request says what the delivery says.
      const pr = make();
      pulls[`${DS}#${pr.number}`] = pr;
      const r = await deliver("synchronize", pr, { login: "contributor", type: "User" });
      expect(r).toMatchObject({ dispatched: true });
      expect(checkOutcomes().some((c) => c.title === WAIVED_TITLE)).toBe(false);
      expect(waiverAudits()).toEqual([]);
    });
  }

  for (const status of [
    "abandoned",
    "superseded",
    "failed",
    "merged",
    "released",
    "complete",
    "patch_declined",
  ] as const) {
    test(`a record at ${status}, naming this pull request at this head: reviewed`, async () => {
      db.run("DELETE FROM upstream_repulls");
      // The pull request's own columns are named, so only the status can be why it is reviewed.
      seedRepull(status, { branch: BRANCH, pr_number: 7, head_sha: HEAD });
      const r = await deliver(
        "synchronize",
        pull({ user: { login: "contributor", id: 501, type: "User" } }),
      );
      expect(r).toMatchObject({ dispatched: true });
      expect(waiverAudits()).toEqual([]);
    });
  }

  test("a record of another dataset waives nothing here", async () => {
    db.run("DELETE FROM upstream_repulls");
    mirror("on004363");
    seedRepull("pr_open", { dataset_id: "on004363", upstream_ds: "ds004363", head_sha: HEAD });
    const r = await deliver(
      "synchronize",
      pull({ user: { login: "contributor", id: 501, type: "User" } }),
    );
    expect(r).toMatchObject({ dispatched: true });
  });

  test("a bot's pull request is never reviewed: the App's at a head the record does not hold stays a bot's", async () => {
    const app_ = { login: NEMAR_APP_BOT_LOGIN, id: NEMAR_APP_BOT_USER_ID, type: "Bot" };
    db.run("UPDATE upstream_repulls SET origin = 'automatic'");
    pulls[`${DS}#7`] = pull({ user: app_, sha: OTHER });
    expect(await deliver("synchronize", pull({ user: app_, sha: OTHER }))).toMatchObject({
      dispatched: false,
      reason: "bot_author",
    });
    const res = await app.request(
      `/admin/pr-reviews/${DS}/7/start`,
      { method: "POST", headers: { Authorization: `Bearer ${ADMIN_KEY}` } },
      env(),
    );
    expect(await res.json()).toMatchObject({ dispatched: false, reason: "bot_author" });
    // And another bot's pull request, with no record, is a bot's too.
    const other = { login: "dependabot[bot]", id: 49699333, type: "Bot" };
    expect(await deliver("opened", pull({ number: 14, ref: "deps", user: other }))).toMatchObject({
      reason: "bot_author",
    });
    expect(reviews()).toEqual([]);
    expect(dispatches()).toEqual([]);
    expect(checkWrites()).toEqual([]);
  });

  test("a delivery that names no head branch is not waived: unknown is never a waiver", async () => {
    const pr = pull({ user: { login: "contributor", id: 501, type: "User" } });
    Reflect.deleteProperty(pr.head as Record<string, unknown>, "ref");
    pulls[`${DS}#7`] = pr;
    const r = await deliver("synchronize", pr, { login: "contributor", type: "User" });
    expect(r).toMatchObject({ dispatched: true });
    expect(checkOutcomes().some((c) => c.title === WAIVED_TITLE)).toBe(false);
  });
});

describe("the record's own transition publishes the waiver of the head it records", () => {
  const transition = async (fields: Record<string, unknown>, error?: string) =>
    app.request(
      `/admin/repulls/${repullId}/transition`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${ADMIN_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: "pr_open",
          to: "pr_open",
          fields: { branch: BRANCH, pr_number: 7, ...fields },
          ...(error ? { error } : {}),
        }),
      },
      env(),
    );

  test("recording enrichment's move puts the waiver over the review that failed on the new head", async () => {
    db.run("UPDATE upstream_repulls SET head_sha = ?", [SYNTH]);
    const id = seedFailedReview(HEAD);
    const res = await transition({ head_sha: HEAD });
    expect(res.status).toBe(200);
    expect(checkOutcomes()).toEqual([
      { method: "PATCH", path: "/check-runs/77", conclusion: "skipped", title: WAIVED_TITLE },
    ]);
    expect(waiverAudits()).toEqual([
      expect.objectContaining({
        user_id: null,
        details: expect.objectContaining({ trigger: "recorded", review_id: id, head_sha: HEAD }),
      }),
    ]);
    expect(dispatches()).toEqual([]);
  });

  test("a head GitHub no longer shows gets nothing, and the edge stands", async () => {
    db.run("UPDATE upstream_repulls SET head_sha = ?", [SYNTH]);
    pulls[`${DS}#7`] = pull({ sha: OTHER });
    const res = await transition({ head_sha: HEAD });
    expect(res.status).toBe(200);
    expect(checkWrites()).toEqual([]);
    expect(
      (db.query("SELECT head_sha FROM upstream_repulls").get() as { head_sha: string }).head_sha,
    ).toBe(HEAD);
  });

  test("a self-edge that records only why a step failed reads nothing and posts nothing", async () => {
    const res = await transition({ head_sha: HEAD }, "[gates:screen-blocks] a direct identifier");
    expect(res.status).toBe(200);
    expect(calls).toEqual([]);
  });
});

describe("a review of the head that reports after the head was recorded publishes the waiver", () => {
  function seedRunning(): number {
    return Number(
      db
        .query(
          `INSERT INTO pr_reviews (dataset_id, pr_number, head_sha, author_id, author_login, state,
                                   nonce, check_run_id, created_at)
           VALUES (?, 7, ?, ?, ?, 'dispatched', 'n-1', 77, ?)`,
        )
        .run(DS, HEAD, ADMIN_GH_ID, ADMIN_GH, "2026-10-01 00:00:00").lastInsertRowid,
    );
  }

  test("the callback stores the review's verdict and the check shows the waiver, with its findings", async () => {
    const id = seedRunning();
    const stored = await storePrReviewResult(env(), id, DS, "n-1", {
      kind: "reported",
      report: parseStoredPrReviewReport(failingReport()),
    });
    expect(stored).toEqual({ stored: true, state: "reported" });
    expect(reviews()[0]).toMatchObject({ state: "reported", verdict: "fail" });
    expect(checkOutcomes()).toEqual([
      { method: "PATCH", path: "/check-runs/77", conclusion: "skipped", title: WAIVED_TITLE },
    ]);
    const text = String((checkWrites()[0]?.body?.output as { text?: string }).text);
    expect(text).toContain("Metadata removed");
  });

  test("the watchdog's verdict on a review that never reported shows the waiver", async () => {
    seedRunning();
    const r = await sweepStalePrReviews(env());
    expect(r.timedOut).toBe(1);
    expect(reviews()[0]).toMatchObject({ state: "unreported" });
    expect(checkOutcomes()).toEqual([
      { method: "PATCH", path: "/check-runs/77", conclusion: "skipped", title: WAIVED_TITLE },
    ]);
  });

  for (const [name, flip] of [
    ["a pull request GitHub cannot show", () => Reflect.deleteProperty(pulls, `${DS}#7`)],
    [
      "a pull request GitHub shows from another branch than the record's",
      () => {
        pulls[`${DS}#7`] = pull({ ref: "release/v3.0.0" });
      },
    ],
    [
      "a pull request GitHub shows from a fork",
      () => {
        pulls[`${DS}#7`] = pull({ headRepo: `contributor/${DS}` });
      },
    ],
  ] as const) {
    test(`${name} is not waived: the review's own verdict is published (unknown is never a waiver)`, async () => {
      const id = seedRunning();
      flip();
      await storePrReviewResult(env(), id, DS, "n-1", {
        kind: "reported",
        report: parseStoredPrReviewReport(failingReport()),
      });
      expect(checkOutcomes()).toEqual([
        { method: "PATCH", path: "/check-runs/77", conclusion: "failure", title: "Needs changes" },
      ]);
    });
  }

  test("a waiver that could not be decided leaves the row unpublished, and the sweep then publishes the waiver", async () => {
    const id = seedRunning();
    Reflect.deleteProperty(pulls, `${DS}#7`);
    await storePrReviewResult(env(), id, DS, "n-1", {
      kind: "reported",
      report: parseStoredPrReviewReport(failingReport()),
    });
    expect(checkOutcomes().map((c) => c.conclusion)).toEqual(["failure"]);
    expect(reviews()[0]?.published_at).toBeNull();
    // GitHub answers again; the watchdog's republish decides with it and stamps the row.
    pulls[`${DS}#7`] = pull();
    db.run("UPDATE pr_reviews SET decided_at = datetime('now', '-10 minutes')");
    calls = [];
    const r = await sweepStalePrReviews(env());
    expect(r.republished).toBe(1);
    expect(checkOutcomes()).toEqual([
      { method: "PATCH", path: "/check-runs/77", conclusion: "skipped", title: WAIVED_TITLE },
    ]);
    expect(reviews()[0]?.published_at).not.toBeNull();
  });

  test("a record that cannot be read is not a waiver, and the row is left unpublished", async () => {
    const id = seedRunning();
    const real = realD1(db);
    const refusing = {
      ...real,
      prepare(sql: string) {
        if (sql.includes("FROM upstream_repulls")) throw new Error("D1_ERROR: injected fault");
        return real.prepare(sql);
      },
      batch: real.batch.bind(real),
    } as unknown as D1Database;
    await storePrReviewResult({ ...env(), DB: refusing }, id, DS, "n-1", {
      kind: "reported",
      report: parseStoredPrReviewReport(failingReport()),
    });
    expect(checkOutcomes().map((c) => c.conclusion)).toEqual(["failure"]);
    expect(reviews()[0]?.published_at).toBeNull();
  });

  test("a head the record does not hold gets the review's own verdict, as before", async () => {
    db.run("UPDATE upstream_repulls SET head_sha = ?", [SYNTH]);
    const id = seedRunning();
    await storePrReviewResult(env(), id, DS, "n-1", {
      kind: "reported",
      report: parseStoredPrReviewReport(failingReport()),
    });
    expect(checkOutcomes()).toEqual([
      { method: "PATCH", path: "/check-runs/77", conclusion: "failure", title: "Needs changes" },
    ]);
  });
});

describe("a refused update of the existing check is replaced by a new check (ADR 0116)", () => {
  const start = async (qs: string) =>
    (
      await app.request(
        `/admin/pr-reviews/${DS}/7/start${qs}`,
        { method: "POST", headers: { Authorization: `Bearer ${ADMIN_KEY}` } },
        env(),
      )
    ).json();
  const paths: Array<[string, () => Promise<unknown>]> = [
    ["a delivery", () => deliver("synchronize", pull())],
    ["an administrator's start", () => start("")],
    ["an administrator's start --redo", () => start("?redo=1")],
  ];
  for (const [name, go] of paths) {
    test(`${name}: GitHub refuses the update (422), so a new skipped run is posted and recorded`, async () => {
      const id = seedFailedReview();
      checkPatchFailure = 422;
      expect(await go()).toMatchObject({ dispatched: false, reason: "repull_waived" });
      expect(checkOutcomes()).toEqual([
        { method: "PATCH", path: "/check-runs/77", conclusion: "skipped", title: WAIVED_TITLE },
        { method: "POST", path: "/check-runs", conclusion: "skipped", title: WAIVED_TITLE },
      ]);
      const row = reviews()[0] as { check_run_id: number; verdict: string };
      expect(row.check_run_id).not.toBe(77);
      expect(row.verdict).toBe("fail");
      expect(waiverAudits()).toHaveLength(1);
      expect(waiverAudits()[0]?.details).toMatchObject({ review_id: id });
      expect(dispatches()).toEqual([]);
    });
  }

  test("a refused credential is not replaced: the start answers 502 and records nothing", async () => {
    seedFailedReview();
    checkPatchFailure = 403;
    const res = await app.request(
      `/admin/pr-reviews/${DS}/7/start`,
      { method: "POST", headers: { Authorization: `Bearer ${ADMIN_KEY}` } },
      env(),
    );
    expect(res.status).toBe(502);
    expect(checkOutcomes().map((c) => c.method)).toEqual(["PATCH"]);
    expect(waiverAudits()).toEqual([]);
  });

  test("an ordinary review's refused update is not replaced by a new run", async () => {
    // Only the waiver posts a new run over a refused update; a review's result keeps its run.
    db.run("UPDATE upstream_repulls SET head_sha = ?", [SYNTH]);
    const id = Number(
      db
        .query(
          `INSERT INTO pr_reviews (dataset_id, pr_number, head_sha, author_id, author_login, state,
                                   nonce, check_run_id, created_at)
           VALUES (?, 7, ?, ?, ?, 'dispatched', 'n-1', 77, '2026-10-01 00:00:00')`,
        )
        .run(DS, HEAD, ADMIN_GH_ID, ADMIN_GH).lastInsertRowid,
    );
    checkPatchFailure = 422;
    await storePrReviewResult(env(), id, DS, "n-1", {
      kind: "reported",
      report: parseStoredPrReviewReport(failingReport()),
    });
    expect(checkOutcomes().map((c) => c.method)).toEqual(["PATCH"]);
  });
});

describe("the waiver is decided before a block on the author", () => {
  test("a blocked author's re-pull pull request at its recorded head is waived, not declined", async () => {
    db.run(
      `INSERT INTO pr_review_overrides (author_id, author_login, mode, reason, set_by)
       VALUES (?, ?, 'block', 'Hold this author', ?)`,
      [ADMIN_GH_ID, ADMIN_GH, adminId],
    );
    expect(await deliver("synchronize", pull())).toMatchObject({ reason: "repull_waived" });
    // The control: the same author at a head the record does not hold is declined.
    pulls[`${DS}#7`] = pull({ sha: OTHER });
    expect(await deliver("synchronize", pull({ sha: OTHER }))).toMatchObject({
      reason: "contributor_paused",
    });
  });
});

describe("the records that can waive are read by their status", () => {
  const STATUSES = [
    "planned",
    "prepared",
    "copied",
    "registered",
    "pr_open",
    "gates_clear",
    "merged",
    "released",
    "patch_synthesized",
    "patch_gates_clear",
    "patch_merged",
    "patch_released",
    "complete",
    "abandoned",
    "failed",
    "superseded",
    "patch_declined",
  ] as const;
  const dsOf = (k: number) => `on${String(100000 + k)}`;

  test("the record queries return the open pull requests' statuses and no other", async () => {
    db.run("DELETE FROM upstream_repulls");
    STATUSES.forEach((status, k) => {
      const before = ["planned", "prepared", "copied", "registered"].includes(status);
      seedRepull(status, {
        dataset_id: dsOf(k),
        ...(before ? {} : { branch: BRANCH, pr_number: 7, head_sha: HEAD }),
      });
    });
    const one = STATUSES.filter(
      (_, k) => db.query(REPULL_WAIVER_RECORDS_SQL).all(dsOf(k), 7, 7).length > 0,
    );
    // Every status in which either of a record's pull requests is open; the rule then asks which.
    expect(one).toEqual(["pr_open", "gates_clear", "patch_synthesized", "patch_gates_clear"]);
    const many = await readWaiverRecords(
      realD1(db),
      STATUSES.map((_, k) => dsOf(k)),
    );
    expect(
      [...many.values()]
        .flat()
        .map((r) => r.status)
        .sort(),
    ).toEqual(["gates_clear", "patch_gates_clear", "patch_synthesized", "pr_open"]);
  });
});

describe("the publish the record's transition makes is fenced", () => {
  const transition = (over: Partial<Bindings> = {}) =>
    app.request(
      `/admin/repulls/${repullId}/transition`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${ADMIN_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: "pr_open",
          to: "pr_open",
          fields: { branch: BRANCH, pr_number: 7, head_sha: HEAD },
        }),
      },
      env(over),
    );
  beforeEach(() => {
    db.run("UPDATE upstream_repulls SET head_sha = ?", [SYNTH]);
  });

  test("the control: the recorded head is waived", async () => {
    expect((await transition()).status).toBe(200);
    expect(checkOutcomes().map((c) => c.title)).toEqual([WAIVED_TITLE]);
  });

  const fences: Array<[string, () => void, Partial<Bindings>]> = [
    ["while the review is switched off", () => {}, { PR_REVIEW_ENABLED: undefined }],
    [
      "for a dataset the review may not read",
      () => db.run("UPDATE datasets SET first_published_at = NULL"),
      {},
    ],
    [
      "for a pull request GitHub shows closed",
      () => {
        pulls[`${DS}#7`] = { ...pull(), state: "closed" };
      },
      {},
    ],
    [
      "for a pull request GitHub shows merged",
      () => {
        pulls[`${DS}#7`] = { ...pull(), state: "closed", merged: true };
      },
      {},
    ],
    [
      "for a draft",
      () => {
        pulls[`${DS}#7`] = { ...pull(), draft: true };
      },
      {},
    ],
    [
      "for a fork's pull request at the record's number",
      () => {
        pulls[`${DS}#7`] = pull({ headRepo: `contributor/${DS}` });
      },
      {},
    ],
  ];
  for (const [name, flip, over] of fences) {
    test(`nothing is posted ${name}, and the edge stands`, async () => {
      flip();
      expect((await transition(over)).status).toBe(200);
      expect(checkWrites()).toEqual([]);
      expect(waiverAudits()).toEqual([]);
      expect(
        (db.query("SELECT head_sha FROM upstream_repulls").get() as { head_sha: string }).head_sha,
      ).toBe(HEAD);
    });
  }

  test("a dev Worker posts nothing on a repository the production Worker owns", async () => {
    // A production sandbox `xx` dataset: the dev Worker may record its re-pull (the record's own
    // fence allows `xx` outside production) but does not own it, and the organization is shared.
    db.run("DELETE FROM upstream_repulls");
    mirror("xx000123");
    repullId = seedRepull("pr_open", {
      dataset_id: "xx000123",
      upstream_ds: "ds000123",
      branch: BRANCH,
      pr_number: 7,
      head_sha: SYNTH,
    });
    pulls["xx000123#7"] = pull({ ds: "xx000123" });
    const res = await transition({ ENVIRONMENT: "staging" });
    expect(res.status).toBe(200);
    expect(checkWrites()).toEqual([]);
    expect(waiverAudits()).toEqual([]);
  });
});

describe("a bot's pull request is waived only on a dataset the review may read", () => {
  test("the App's recorded pull request on a dataset that is not reviewable stays a bot's", async () => {
    const APP = { login: NEMAR_APP_BOT_LOGIN, id: NEMAR_APP_BOT_USER_ID, type: "Bot" };
    db.run("UPDATE upstream_repulls SET origin = 'automatic'");
    db.run("UPDATE datasets SET first_published_at = NULL");
    pulls[`${DS}#7`] = pull({ user: APP });
    expect(await deliver("synchronize", pull({ user: APP }))).toMatchObject({
      reason: "bot_author",
    });
    expect(checkWrites()).toEqual([]);
  });
});

describe("a waiver the sweep cannot decide is an attempt that failed", () => {
  test("five undecided publishes end abandoned, never counted as republished", async () => {
    const id = Number(
      db
        .query(
          `INSERT INTO pr_reviews (dataset_id, pr_number, head_sha, author_id, author_login, state,
                                   nonce, check_run_id, created_at)
           VALUES (?, 7, ?, ?, ?, 'dispatched', 'n-1', 77, '2026-10-01 00:00:00')`,
        )
        .run(DS, HEAD, ADMIN_GH_ID, ADMIN_GH).lastInsertRowid,
    );
    Reflect.deleteProperty(pulls, `${DS}#7`);
    await storePrReviewResult(env(), id, DS, "n-1", {
      kind: "reported",
      report: parseStoredPrReviewReport(failingReport()),
    });
    const results: Array<{ republished: number; abandoned: number }> = [];
    for (let n = 0; n < 5; n++) {
      db.run("UPDATE pr_reviews SET decided_at = datetime('now', '-10 minutes')");
      results.push(await sweepStalePrReviews(env()));
    }
    expect(results.map((r) => r.republished)).toEqual([0, 0, 0, 0, 0]);
    expect(results.map((r) => r.abandoned)).toEqual([0, 0, 0, 0, 1]);
    expect(reviews()[0]).toMatchObject({ published_at: null, publish_attempts: 5 });
  });
});

describe("the queue names the App's pull request by the App's name, and only the App's", () => {
  const APP = { login: NEMAR_APP_BOT_LOGIN, id: NEMAR_APP_BOT_USER_ID, type: "Bot" };
  const detail = async () => {
    const res = await app.request(
      `/admin/pr-reviews/${DS}/7`,
      { headers: { Authorization: `Bearer ${ADMIN_KEY}` } },
      env(),
    );
    expect(res.status).toBe(200);
    return (await res.json()) as {
      review: { author_login: string; author_id: number } | null;
      live: { author_login: string; author_id: number | null } | null;
      author: { login: string; author_id: number } | null;
    };
  };
  const storeReview = (authorId: number, authorLogin: string) =>
    db.run(
      `INSERT INTO pr_reviews (dataset_id, pr_number, head_sha, author_id, author_login, state,
                               detail, decided_at)
       VALUES (?, 7, ?, ?, ?, 'errored', 'model_unavailable', datetime('now'))`,
      [DS, HEAD, authorId, authorLogin],
    );

  test("a stored review, GitHub's record and the author's standing all name the App", async () => {
    storeReview(NEMAR_APP_BOT_USER_ID, NEMAR_APP_BOT_LOGIN);
    pulls[`${DS}#7`] = pull({ user: APP });
    const d = await detail();
    expect(d.review).toMatchObject({
      author_login: NEMAR_APP_BOT_LOGIN,
      author_id: NEMAR_APP_BOT_USER_ID,
    });
    expect(d.live).toMatchObject({
      author_login: NEMAR_APP_BOT_LOGIN,
      author_id: NEMAR_APP_BOT_USER_ID,
    });
    expect(d.author).toMatchObject({
      login: NEMAR_APP_BOT_LOGIN,
      author_id: NEMAR_APP_BOT_USER_ID,
    });
  });

  test("a bot that only borrows the App's login is not shown as the App", async () => {
    pulls[`${DS}#7`] = pull({ user: { ...APP, id: 1 } });
    expect((await detail()).live?.author_login).toBe("(unknown)");
  });

  test("a bot that only carries the App's id is not shown as the App", async () => {
    pulls[`${DS}#7`] = pull({ user: { ...APP, login: "nemar-bot2[bot]" } });
    expect((await detail()).live?.author_login).toBe("(unknown)");
  });

  test("a stored review under the App's login with another id is not shown as the App", async () => {
    storeReview(1, NEMAR_APP_BOT_LOGIN);
    const d = await detail();
    expect(d.review).toMatchObject({
      author_login: plainRef(NEMAR_APP_BOT_LOGIN, 39),
      author_id: 1,
    });
    expect(d.review?.author_login).not.toBe(NEMAR_APP_BOT_LOGIN);
    expect(d.author).toMatchObject({ login: plainRef(NEMAR_APP_BOT_LOGIN, 39), author_id: 1 });
  });

  test("a stored review under the App's id with another login is not shown as the App", async () => {
    storeReview(NEMAR_APP_BOT_USER_ID, "someone");
    const d = await detail();
    expect(d.review).toMatchObject({ author_login: "someone", author_id: NEMAR_APP_BOT_USER_ID });
    expect(d.author).toMatchObject({ login: "someone", author_id: NEMAR_APP_BOT_USER_ID });
  });
});

describe("which edges record a head (the transition's trigger)", () => {
  const at = (status: RepullStatus, over: Row = {}) =>
    rowAt(status, { dataset_id: DS, head_sha: HEAD, ...over }) as unknown as RepullRow;
  const cases: Array<[string, RepullRow, RepullRow, "n0" | "n1" | null]> = [
    ["the pull request opened", at("registered"), at("pr_open"), "n0"],
    ["enrichment's move recorded", at("pr_open"), at("pr_open", { head_sha: OTHER }), "n0"],
    ["a self-edge that records only an error", at("pr_open"), at("pr_open"), null],
    ["back from the gates to the open pull request", at("gates_clear"), at("pr_open"), "n0"],
    ["into the gates", at("pr_open"), at("gates_clear"), null],
    ["N.0.1 opened", at("released"), at("patch_synthesized"), "n1"],
    [
      "N.0.1's head moved",
      at("patch_synthesized"),
      at("patch_synthesized", { patch_head_sha: OTHER }),
      "n1",
    ],
    ["N.0.1 into its gates", at("patch_synthesized"), at("patch_gates_clear"), null],
  ];
  for (const [name, before, after, pr] of cases) {
    test(`${name}: ${pr ?? "none"}`, () => {
      expect(recordedHeadOf(before, after)).toBe(pr);
    });
  }
});
