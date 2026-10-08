/**
 * The administrator's pull-request review queue, end to end through the real admin routes
 * (ADR 0093, following ADR 0092).
 *
 * Real engine only: bun:sqlite behind realD1 with every migration applied, the real Hono admin
 * router with its real auth middleware and a real hashed token, and GitHub as a `Bun.serve()`
 * stand-in for api.github.com (NEMAR_GITHUB_API_URL) that speaks the GraphQL search and the REST
 * calls the queue makes and records each request it receives.
 */

import type { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { Hono } from "hono";
import type {
  ClearOverrideResponse,
  ContributorStanding,
  PrReviewDetail,
  QueueResponse,
  SetOverrideResponse,
} from "../../shared/contract/pr-review-admin";
import { renderCheck } from "../../shared/pr-review";
import { adminRoutes } from "../src/routes/admin";
import {
  __resetRateLimitStateForTests,
  __seedRateLimitStateForTests,
} from "../src/services/github/transport";
import { decideReview } from "../src/services/pr-review";
import {
  checkStateOf,
  classify,
  filterQueue,
  readCheckContext,
  sortQueue,
} from "../src/services/pr-review-queue";
import { hashApiKey } from "../src/services/token";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";
import {
  type PrSpec,
  SHA_A,
  SHA_B,
  SHA_C,
  bidsOk,
  goodReport,
  prNode,
  seedReview as seedReviewRow,
  versionOk,
} from "./helpers/pr-queue-fixtures";

const ADMIN_KEY = "queue-admin-key-0123456789abcdef0123456789abcdef";
const MEMBER_KEY = "queue-member-key-0123456789abcdef0123456789abcdef";
const PAT = "ghp_queue_test_token";

// ---------------------------------------------------------------------------------------------
// The GitHub stand-in
// ---------------------------------------------------------------------------------------------

interface Recorded {
  method: string;
  path: string;
  auth: string | null;
  body: Record<string, unknown> | null;
}

let server: Server;
let calls: Recorded[] = [];
/** Pages of search nodes, in order; the cursor is the index of the next page. */
let searchPages: unknown[][] = [];
let issueCount: number | null = null;
let graphqlResponder: ((attempt: number) => Response | null) | null = null;
let graphqlAttempts = 0;
let usersById: Record<string, { id: number; login: string; type: string } | number> = {};
let pulls: Record<string, Record<string, unknown> | number> = {};

/** A failing answer that tells the retry transport not to wait, so a test of a failure is not slow. */
function failing(status: number): Response {
  return new Response("{}", { status, headers: { "Retry-After": "0" } });
}

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const body = req.method === "GET" ? null : ((await req.json().catch(() => null)) as never);
      calls.push({
        method: req.method,
        path: url.pathname,
        auth: req.headers.get("authorization"),
        body,
      });
      if (req.method === "POST" && url.pathname === "/graphql") {
        graphqlAttempts++;
        const forced = graphqlResponder?.(graphqlAttempts);
        if (forced) return forced;
        const after = (body as { variables?: { after?: string | null } } | null)?.variables?.after;
        const index = after ? Number(after) : 0;
        const nodes = searchPages[index] ?? [];
        const seen = searchPages.flat().length;
        return Response.json({
          data: {
            search: {
              issueCount: issueCount ?? seen,
              pageInfo: {
                hasNextPage: index + 1 < searchPages.length,
                endCursor: String(index + 1),
              },
              nodes,
            },
          },
        });
      }
      const user = url.pathname.match(/^\/users\/([^/]+)$/);
      if (req.method === "GET" && user) {
        const hit = usersById[user[1].toLowerCase()];
        if (typeof hit === "number") return failing(hit);
        return hit ? Response.json(hit) : new Response("{}", { status: 404 });
      }
      const pull = url.pathname.match(/^\/repos\/nemarDatasets\/([^/]+)\/pulls\/(\d+)$/);
      if (req.method === "GET" && pull) {
        const hit = pulls[`${pull[1]}#${pull[2]}`];
        if (typeof hit === "number") return failing(hit);
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

// ---------------------------------------------------------------------------------------------
// Worker, database, seeds
// ---------------------------------------------------------------------------------------------

let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;
let envOverrides: Partial<Bindings> = {};
let adminId = 0;

function env(): Bindings {
  return {
    DB: realD1(db),
    ENVIRONMENT: "production",
    GITHUB_ADMIN_PAT: PAT,
    PR_REVIEW_ENABLED: "1",
    ...envOverrides,
  } as Bindings;
}

async function seedUser(username: string, role: string, status: string, key: string) {
  db.run(
    `INSERT INTO users (username, email, password_hash, github_username, status, role,
                        signup_source, email_verified, service_access)
     VALUES (?, ?, 'x', ?, ?, ?, 'cli', 1, 0)`,
    [username, `${username}@example.org`, `${username}-gh`, status, role],
  );
  const row = db.query("SELECT id FROM users WHERE username = ?").get(username) as { id: number };
  db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)").run(
    row.id,
    await hashApiKey(key),
    key.slice(0, 8),
  );
  return row.id;
}

beforeEach(async () => {
  db = freshDb();
  app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/admin", adminRoutes);
  adminId = await seedUser("queueadmin", "admin", "approved", ADMIN_KEY);
  await seedUser("queuemember", "member", "verified", MEMBER_KEY);
  __resetRateLimitStateForTests();
});

afterEach(() => {
  calls = [];
  searchPages = [];
  issueCount = null;
  graphqlResponder = null;
  graphqlAttempts = 0;
  usersById = {};
  pulls = {};
  envOverrides = {};
  __resetRateLimitStateForTests();
});

async function get(path: string, key = ADMIN_KEY) {
  const res = await app.request(path, { headers: { Authorization: `Bearer ${key}` } }, env());
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function send(method: "PUT" | "DELETE", path: string, payload?: unknown, key = ADMIN_KEY) {
  const res = await app.request(
    path,
    {
      method,
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    },
    env(),
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const queue = async (qs = "") => {
  const r = await get(`/admin/pr-reviews${qs}`);
  return { status: r.status, body: r.body as unknown as QueueResponse };
};

function seedDataset(id: string) {
  db.run(
    `INSERT OR IGNORE INTO users (id, username, email, password_hash, status, role, email_verified)
     VALUES (1, 'owner', 'owner@example.org', 'x', 'approved', 'member', 1)`,
  );
  db.run(
    `INSERT INTO datasets (dataset_id, name, owner_user_id, status, visibility, is_sandbox, github_repo)
     VALUES (?, ?, 1, 'active', 'public', 0, ?)`,
    [id, `A sufficiently descriptive title for ${id}`, `nemarDatasets/${id}`],
  );
}

const seedReview = (r: Parameters<typeof seedReviewRow>[1]) => seedReviewRow(db, r);

const nodes = (...specs: PrSpec[]) => {
  searchPages = [specs.map(prNode)];
};

// ---------------------------------------------------------------------------------------------
// Pure rules
// ---------------------------------------------------------------------------------------------

describe("the pure rules", () => {
  test("the newest run of a re-run check wins, and a missing check is only missing if the list was whole", () => {
    const failed = readCheckContext({
      __typename: "CheckRun",
      name: "version-check",
      status: "COMPLETED",
      conclusion: "FAILURE",
      startedAt: "2026-10-01T00:00:00Z",
    });
    const passed = readCheckContext({
      __typename: "CheckRun",
      name: "version-check",
      status: "COMPLETED",
      conclusion: "SUCCESS",
      startedAt: "2026-10-01T01:00:00Z",
    });
    expect(
      checkStateOf(
        [passed, failed].filter((x) => x !== null),
        ["version-check"],
        true,
      ),
    ).toBe("pass");
    expect(checkStateOf([], ["version-check"], true)).toBe("missing");
    expect(checkStateOf([], ["version-check"], false)).toBe("unknown");
  });

  test("only SUCCESS is a pass; neutral, skipped and an unknown shape are not", () => {
    const run = (conclusion: string | null, status = "COMPLETED") =>
      readCheckContext({ __typename: "CheckRun", name: "x", status, conclusion })?.state;
    expect(run("SUCCESS")).toBe("pass");
    expect(run("NEUTRAL")).toBe("unknown");
    expect(run("SKIPPED")).toBe("unknown");
    expect(run("TIMED_OUT")).toBe("fail");
    expect(run("CANCELLED")).toBe("fail");
    expect(run(null, "IN_PROGRESS")).toBe("pending");
    expect(
      readCheckContext({ __typename: "StatusContext", context: "x", state: "EXPECTED" })?.state,
    ).toBe("pending");
    expect(readCheckContext({ __typename: "Mystery" })).toBeNull();
  });

  test("a verdict is never carried over to a commit it did not read", () => {
    const row = {
      id: 1,
      dataset_id: "nm000201",
      pr_number: 1,
      head_sha: SHA_A,
      author_id: 1,
      author_login: "x",
      from_fork: 0,
      state: "reported",
      verdict: "pass",
      detail: null,
      created_at: "",
      decided_at: null,
    };
    expect(classify(row, SHA_A).verdict).toBe("pass");
    const stale = classify(row, SHA_B);
    expect(stale.verdict).toBe("not_reviewed");
    expect(stale.review_current).toBe(false);
    expect(stale.stale_verdict).toBe("pass");
    expect(classify(null, SHA_A)).toMatchObject({ verdict: "not_reviewed", review_current: null });
    // A column nobody can stand behind is "could not decide", not a pass.
    expect(classify({ ...row, verdict: "great" }, SHA_A).verdict).toBe("could_not_decide");
  });

  test("filters compose, and an author matches regardless of case", () => {
    const base = {
      dataset_id: "nm000201",
      pr_number: 1,
      author_login: "Alice",
      draft: false,
      needs_you: true,
      verdict: "pass",
    };
    const entries = [
      base,
      { ...base, pr_number: 2, verdict: "fail", needs_you: false },
      { ...base, pr_number: 3, author_login: "bob" },
    ] as never[];
    const none = { verdicts: [], dataset: null, author: null, needs_me: false };
    expect(filterQueue(entries, { ...none, author: "alice" })).toHaveLength(2);
    expect(filterQueue(entries, { ...none, needs_me: true })).toHaveLength(2);
    expect(filterQueue(entries, { ...none, verdicts: ["fail"] })).toHaveLength(1);
    expect(filterQueue(entries, { ...none, verdicts: ["pass"], author: "bob" })).toHaveLength(1);
  });

  test("sorting puts a draft last, whatever its verdict", () => {
    const e = (over: Record<string, unknown>) =>
      ({
        dataset_id: "nm000201",
        pr_number: 1,
        created_at: "2026-10-01T00:00:00Z",
        bids: "pass",
        version: "pass",
        draft: false,
        verdict: "pass",
        ...over,
      }) as never;
    const sorted = sortQueue([
      e({ pr_number: 1, draft: true, verdict: "pass" }),
      e({ pr_number: 2, verdict: "fail" }),
    ]) as Array<{ pr_number: number }>;
    expect(sorted.map((x) => x.pr_number)).toEqual([2, 1]);
  });
});

// ---------------------------------------------------------------------------------------------
// The queue
// ---------------------------------------------------------------------------------------------

describe("GET /admin/pr-reviews", () => {
  test("joins every open pull request with its latest review, ordered so what you can act on is first", async () => {
    nodes(
      { ds: "nm000201", n: 1, created: "2026-10-03T00:00:00Z" }, // pass
      { ds: "nm000202", n: 2, created: "2026-10-03T00:00:00Z" }, // fail
      { ds: "nm000203", n: 3, created: "2026-10-03T00:00:00Z" }, // uncertain
      { ds: "nm000204", n: 4, created: "2026-10-02T00:00:00Z" }, // no row
      { ds: "nm000205", n: 5, created: "2026-10-03T00:00:00Z" }, // in progress
      { ds: "nm000206", n: 6, created: "2026-10-03T00:00:00Z" }, // errored
      { ds: "nm000207", n: 7, created: "2026-10-01T00:00:00Z" }, // declined
      { ds: "nm000208", n: 8, created: "2026-10-03T00:00:00Z" }, // reviewed an older commit
      { ds: "nm000209", n: 9, created: "2026-09-01T00:00:00Z", draft: true }, // draft
    );
    seedReview({ ds: "nm000201", n: 1, state: "reported", verdict: "pass" });
    seedReview({ ds: "nm000202", n: 2, state: "reported", verdict: "fail" });
    seedReview({ ds: "nm000203", n: 3, state: "reported", verdict: "uncertain" });
    seedReview({ ds: "nm000205", n: 5, state: "dispatched" });
    seedReview({ ds: "nm000206", n: 6, state: "errored", detail: "model_unavailable" });
    seedReview({ ds: "nm000207", n: 7, state: "declined", detail: "contributor_paused" });
    seedReview({ ds: "nm000208", n: 8, sha: SHA_B, state: "reported", verdict: "pass" });

    const { status, body } = await queue();
    expect(status).toBe(200);
    expect(body.environment).toBe("production");
    expect(body.review_enabled).toBe(true);
    expect(body.total_open).toBe(9);
    const by = Object.fromEntries(body.entries.map((e) => [e.dataset_id, e]));

    expect(by.nm000201).toMatchObject({ verdict: "pass", needs_you: true, review_current: true });
    expect(by.nm000202).toMatchObject({ verdict: "fail", needs_you: false });
    expect(by.nm000203.verdict).toBe("uncertain");
    expect(by.nm000204).toMatchObject({
      verdict: "not_reviewed",
      detail: null,
      review_current: null,
    });
    expect(by.nm000205).toMatchObject({ verdict: "in_progress", needs_you: false });
    expect(by.nm000206).toMatchObject({ verdict: "could_not_decide", detail: "model_unavailable" });
    expect(by.nm000207).toMatchObject({ verdict: "not_reviewed", detail: "contributor_paused" });
    expect(by.nm000208).toMatchObject({
      verdict: "not_reviewed",
      review_current: false,
      reviewed_sha: SHA_B,
      stale_verdict: "pass",
    });
    expect(by.nm000209).toMatchObject({ draft: true, needs_you: false });

    // Pass, then a closer look, then could-not-decide, then not-reviewed (oldest first), then the
    // ones waiting on a machine or an author, and the draft after everything.
    expect(body.entries.map((e) => e.dataset_id)).toEqual([
      "nm000201",
      "nm000203",
      "nm000206",
      "nm000207",
      "nm000204",
      "nm000208",
      "nm000205",
      "nm000202",
      "nm000209",
    ]);
  });

  test("a pull request with no review row is not reviewed, and the review being off changes nothing about the list", async () => {
    nodes({ ds: "nm000201", n: 1 });
    envOverrides = { PR_REVIEW_ENABLED: undefined };
    const { status, body } = await queue();
    expect(status).toBe(200);
    expect(body.review_enabled).toBe(false);
    expect(body.entries[0]).toMatchObject({ verdict: "not_reviewed", needs_you: true });
  });

  test("reports fork or branch, the author's id, and a link built from the dataset and number", async () => {
    nodes(
      { ds: "nm000201", n: 12, branch: "fix-readme", author: "alice", authorId: 42 },
      {
        ds: "nm000202",
        n: 3,
        forkOwner: "bobfork",
        branch: "add-subjects",
        author: "bob",
        authorId: 43,
      },
      { ds: "nm000203", n: 4, forkOwner: null, author: null },
    );
    const { body } = await queue();
    const by = Object.fromEntries(body.entries.map((e) => [e.dataset_id, e]));
    expect(by.nm000201).toMatchObject({
      from_fork: false,
      head_label: "fix-readme",
      author_login: "alice",
      author_id: 42,
      url: "https://github.com/nemarDatasets/nm000201/pull/12",
    });
    expect(by.nm000202).toMatchObject({ from_fork: true, head_label: "bobfork:add-subjects" });
    // A deleted fork and a deleted account are named as such, not dropped or guessed.
    expect(by.nm000203).toMatchObject({
      from_fork: true,
      head_label: "(deleted fork):update-metadata",
      author_login: "(unknown)",
      author_id: null,
    });
  });

  test("reads BIDS validation and the version check from the required checks", async () => {
    nodes(
      { ds: "nm000201", n: 1 },
      {
        ds: "nm000202",
        n: 2,
        checks: [
          { ...bidsOk("nm000202"), conclusion: "FAILURE" },
          { ...versionOk, status: "IN_PROGRESS", conclusion: null },
        ],
      },
      { ds: "nm000203", n: 3, checks: null },
      { ds: "nm000204", n: 4, checks: [bidsOk("nm000204")], moreChecks: true },
      // A legacy inline repository names its BIDS check differently.
      { ds: "nm000103", n: 5, checks: [bidsOk("nm000103"), versionOk] },
      // A status (not a check run) posted under the same name counts the same way.
      {
        ds: "nm000205",
        n: 6,
        checks: [{ type: "status", name: "version-check", state: "FAILURE" }, bidsOk("nm000205")],
      },
    );
    const { body } = await queue();
    const by = Object.fromEntries(body.entries.map((e) => [e.dataset_id, e]));
    expect([by.nm000201.bids, by.nm000201.version]).toEqual(["pass", "pass"]);
    expect([by.nm000202.bids, by.nm000202.version]).toEqual(["fail", "pending"]);
    expect([by.nm000203.bids, by.nm000203.version]).toEqual(["missing", "missing"]);
    // The list of checks was cut short, so an absent check is not known to be absent.
    expect([by.nm000204.bids, by.nm000204.version]).toEqual(["pass", "unknown"]);
    expect([by.nm000103.bids, by.nm000103.version]).toEqual(["pass", "pass"]);
    expect([by.nm000205.bids, by.nm000205.version]).toEqual(["pass", "fail"]);
  });

  test("filters by verdict, dataset, author and needs-me", async () => {
    nodes(
      { ds: "nm000201", n: 1, author: "Alice", authorId: 1 },
      { ds: "nm000202", n: 2, author: "bob", authorId: 2 },
      { ds: "nm000203", n: 3, author: "alice", authorId: 1 },
    );
    seedReview({ ds: "nm000201", n: 1, state: "reported", verdict: "pass" });
    seedReview({ ds: "nm000202", n: 2, state: "reported", verdict: "fail" });
    seedReview({ ds: "nm000203", n: 3, state: "reported", verdict: "uncertain" });

    expect((await queue("?verdict=fail")).body.entries.map((e) => e.dataset_id)).toEqual([
      "nm000202",
    ]);
    expect((await queue("?verdict=pass,uncertain")).body.entries).toHaveLength(2);
    expect((await queue("?verdict=could-not-decide")).body.entries).toHaveLength(0);
    expect((await queue("?dataset=nm000203")).body.entries).toHaveLength(1);
    expect((await queue("?author=ALICE")).body.entries).toHaveLength(2);
    expect((await queue("?needs_me=1")).body.entries.map((e) => e.dataset_id)).toEqual([
      "nm000201",
      "nm000203",
    ]);
    const filtered = await queue("?verdict=pass&author=alice&needs_me=true");
    expect(filtered.body.entries.map((e) => e.dataset_id)).toEqual(["nm000201"]);
    expect(filtered.body.total_open).toBe(3);

    for (const bad of ["?verdict=great", "?dataset=nm1", "?author=-bad-"]) {
      const r = await queue(bad);
      expect(r.status).toBe(400);
    }
  });

  test("searches the organisation once per page with the datasets token and reads pages one after another", async () => {
    searchPages = [
      [prNode({ ds: "nm000201", n: 1 }), prNode({ ds: "nm000202", n: 2 })],
      [prNode({ ds: "nm000203", n: 3 }), prNode({ ds: "nm000202", n: 2 })], // a repeat as pages shift
    ];
    const { body } = await queue();
    expect(body.entries.map((e) => e.dataset_id).sort()).toEqual([
      "nm000201",
      "nm000202",
      "nm000203",
    ]);
    expect(body.truncated).toBe(false);

    const searches = calls.filter((c) => c.path === "/graphql");
    expect(searches).toHaveLength(2);
    expect(searches.every((c) => c.auth === `Bearer ${PAT}`)).toBe(true);
    const vars = (searches[0].body as { variables: { q: string; after: unknown } }).variables;
    expect(vars.q).toBe("org:nemarDatasets is:pr is:open base:main");
    expect(vars.after).toBeNull();
    expect((searches[1].body as { variables: { after: string } }).variables.after).toBe("1");
    // Nothing else was needed: no call per pull request.
    expect(calls.filter((c) => c.path !== "/graphql")).toHaveLength(0);
  });

  test("says so when GitHub holds more results than were read", async () => {
    searchPages = [[prNode({ ds: "nm000201", n: 1 })]];
    issueCount = 1500;
    const { body } = await queue();
    expect(body.truncated).toBe(true);
    expect(body.entries).toHaveLength(1);
  });

  test("a pull request in a repository that is not a dataset is counted, not listed", async () => {
    searchPages = [
      [
        prNode({ ds: "nm000201", n: 1 }),
        {
          ...prNode({ ds: "nm000202", n: 2 }),
          repository: { name: ".github", owner: { login: "nemarDatasets" } },
        },
        prNode({ ds: "nm000203", n: 3, repoOwner: "someoneElse" }),
      ],
    ];
    const { body } = await queue();
    expect(body.entries).toHaveLength(1);
    expect(body.skipped.not_a_dataset).toBe(2);
  });

  test("production leaves the dev Worker's datasets alone, and the dev Worker lists only its own", async () => {
    nodes(
      { ds: "nm000201", n: 1 },
      { ds: "xx090001", n: 2 }, // a dev ephemeral sandbox id
      { ds: "nm099998", n: 3 }, // the declared dev-owned fixture
    );
    const prod = await queue();
    expect(prod.body.entries.map((e) => e.dataset_id)).toEqual(["nm000201"]);
    expect(prod.body.skipped.not_owned_here).toBe(2);

    envOverrides = { ENVIRONMENT: "staging" };
    const dev = await queue();
    expect(dev.body.environment).toBe("non-production");
    expect(dev.body.entries.map((e) => e.dataset_id).sort()).toEqual(["nm099998", "xx090001"]);
    expect(dev.body.skipped.not_owned_here).toBe(1);
  });

  test("author-controlled text never reaches the response as markup, a mention, or a control character", async () => {
    const esc = String.fromCharCode(27);
    nodes({
      ds: "nm000201",
      n: 1,
      title: `${esc}[2J@everyone ![x](http://evil.test/a.png) <script>alert(1)</script> #12 hello`,
      branch: `feat/${esc}[31mred‮evil name;rm -rf`,
      forkOwner: "bob",
    });
    const res = await app.request(
      "/admin/pr-reviews",
      { headers: { Authorization: `Bearer ${ADMIN_KEY}` } },
      env(),
    );
    const raw = await res.text();
    expect(raw.includes(esc)).toBe(false);
    expect(raw.includes("‮")).toBe(false);
    const entry = (JSON.parse(raw) as QueueResponse).entries[0];
    // No mention, tag, issue reference, link or image survives; what is left is plain words.
    expect(entry.title).not.toMatch(/[@<>#[\]]|http/);
    expect(entry.title).toContain("hello");
    expect(entry.head_label).toMatch(/^[A-Za-z0-9._\-/:?…]+$/);
    expect(entry.url).toBe("https://github.com/nemarDatasets/nm000201/pull/1");
    // The pull request body is never read, so it cannot be returned.
    expect(JSON.stringify(entry)).not.toContain("body");
  });

  test("waits out a secondary rate limit and answers", async () => {
    nodes({ ds: "nm000201", n: 1 });
    graphqlResponder = (attempt) =>
      attempt === 1
        ? new Response('{"message":"You have exceeded a secondary rate limit."}', {
            status: 403,
            headers: { "Retry-After": "0" },
          })
        : null;
    const { status, body } = await queue();
    expect(status).toBe(200);
    expect(body.entries).toHaveLength(1);
    expect(graphqlAttempts).toBe(2);
  });

  test("a nearly spent REST budget does not stop the search: GraphQL spends a different one", async () => {
    nodes({ ds: "nm000201", n: 1 });
    // Publishing and the sweeps share this token and spend the `core` bucket; the search does not.
    __seedRateLimitStateForTests({
      resource: "core",
      remaining: 3,
      resetEpoch: Math.floor(Date.now() / 1000) + 600,
    });
    const r = await queue();
    expect(r.status).toBe(200);
    expect(r.body.entries).toHaveLength(1);
  });

  test("a spent GraphQL budget is a 503 that says so, not a vague failure", async () => {
    nodes({ ds: "nm000201", n: 1 });
    graphqlResponder = () =>
      Response.json({
        data: null,
        errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded for installation" }],
      });
    const r = await get("/admin/pr-reviews");
    expect(r.status).toBe(503);
    expect(r.body.code).toBe("github_rate_limited");
    expect(String(r.body.error)).toContain("Try again later");
  });

  test("a GraphQL error fails the whole read: a partial queue that looks whole is worse than none", async () => {
    nodes({ ds: "nm000201", n: 1 });
    graphqlResponder = () =>
      Response.json({
        data: {
          search: {
            issueCount: 1,
            pageInfo: { hasNextPage: false },
            nodes: [prNode({ ds: "nm000201", n: 1 })],
          },
        },
        errors: [{ type: "FORBIDDEN", message: "Resource not accessible by integration" }],
      });
    const r = await get("/admin/pr-reviews");
    expect(r.status).toBe(502);
    expect(r.body.code).toBe("github_graphql_error");
    expect(r.body.entries).toBeUndefined();
  });

  test("GitHub refusing the search is a 502, not an empty queue", async () => {
    graphqlResponder = () => new Response("{}", { status: 500, headers: { "Retry-After": "0" } });
    const r = await get("/admin/pr-reviews");
    expect(r.status).toBe(502);
    expect(r.body.code).toBe("github_refused");
  });

  test("is admin-only", async () => {
    nodes({ ds: "nm000201", n: 1 });
    expect((await get("/admin/pr-reviews", MEMBER_KEY)).status).toBe(403);
    const anonymous = await app.request("/admin/pr-reviews", {}, env());
    expect(anonymous.status).toBe(401);
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------
// One pull request
// ---------------------------------------------------------------------------------------------

function livePull(over: Record<string, unknown> = {}) {
  return {
    number: 7,
    state: "open",
    merged: false,
    draft: false,
    title: "Add subjects",
    html_url: "https://github.com/nemarDatasets/nm000201/pull/7",
    user: { login: "contributor", id: 501, type: "User" },
    base: { ref: "main" },
    head: {
      sha: SHA_A,
      ref: "add-subjects",
      repo: { full_name: "nemarDatasets/nm000201", owner: { login: "nemarDatasets" } },
    },
    ...over,
  };
}

const detail = async (ds: string, n: number) => {
  const r = await get(`/admin/pr-reviews/${ds}/${n}`);
  return {
    status: r.status,
    body: r.body as unknown as PrReviewDetail & { error?: string; code?: string },
  };
};

describe("GET /admin/pr-reviews/:dataset/:pr", () => {
  test("returns the stored report in the words the pull-request comment uses", async () => {
    seedReview({ ds: "nm000201", n: 7, state: "reported", verdict: "pass" });
    pulls["nm000201#7"] = livePull();
    const { status, body } = await detail("nm000201", 7);
    expect(status).toBe(200);
    expect(body).toMatchObject({ verdict: "pass", review_current: true });
    expect(body.review?.outcome?.kind).toBe("reported");
    // The renderer is the shared one, so the CLI and the comment cannot say different things.
    if (body.review?.outcome) {
      const rendered = renderCheck(body.review.outcome);
      expect(rendered.title).toBe("Passes: nothing lost, revision advances, materially better");
      expect(rendered.summary).toContain("| Dataset description | 0 | 1 | 0 |");
    }
    expect(body.live).toMatchObject({ state: "open", head_sha: SHA_A, from_fork: false });
    expect(body.author?.tally).toEqual({ decided: 1, rejected: 0 });
  });

  test("a review of an earlier commit is not this commit's verdict", async () => {
    seedReview({ ds: "nm000201", n: 7, sha: SHA_B, state: "reported", verdict: "pass" });
    pulls["nm000201#7"] = livePull({
      head: {
        sha: SHA_C,
        ref: "x",
        repo: { full_name: "nemarDatasets/nm000201", owner: { login: "nemarDatasets" } },
      },
    });
    const { body } = await detail("nm000201", 7);
    expect(body.verdict).toBe("not_reviewed");
    expect(body.review_current).toBe(false);
    expect(body.review?.verdict).toBe("pass");
    expect(body.review?.head_sha).toBe(SHA_B);
  });

  test("lists the history newest first", async () => {
    seedReview({ ds: "nm000201", n: 7, sha: SHA_A, state: "reported", verdict: "fail" });
    seedReview({ ds: "nm000201", n: 7, sha: SHA_B, state: "reported", verdict: "pass" });
    pulls["nm000201#7"] = livePull();
    const { body } = await detail("nm000201", 7);
    expect(body.history.map((h) => [h.head_sha[0], h.verdict])).toEqual([
      ["b", "pass"],
      ["a", "fail"],
    ]);
  });

  test("a stored report that no longer parses is could-not-decide, whatever its column says", async () => {
    seedReview({ ds: "nm000201", n: 7, state: "reported", verdict: "pass", report: "{not json" });
    pulls["nm000201#7"] = livePull();
    const { body } = await detail("nm000201", 7);
    expect(body.verdict).toBe("could_not_decide");
    expect(body.review?.outcome).toEqual({ kind: "error", error: "report_invalid" });
  });

  test("shows a decline, an error and an unreported review by their closed words", async () => {
    pulls["nm000201#7"] = livePull();
    seedReview({ ds: "nm000201", n: 7, state: "declined", detail: "rate_limited" });
    let { body } = await detail("nm000201", 7);
    expect(body.review?.outcome).toEqual({ kind: "declined", reason: "rate_limited" });
    expect(body.verdict).toBe("not_reviewed");

    seedReview({ ds: "nm000201", n: 7, sha: SHA_B, state: "unreported" });
    pulls["nm000201#7"] = livePull({
      head: {
        sha: SHA_B,
        ref: "x",
        repo: { full_name: "nemarDatasets/nm000201", owner: { login: "nemarDatasets" } },
      },
    });
    ({ body } = await detail("nm000201", 7));
    expect(body.review?.outcome).toEqual({ kind: "unreported" });
    expect(body.verdict).toBe("could_not_decide");
  });

  test("a pull request with no review is not reviewed, and an in-progress one has no outcome yet", async () => {
    pulls["nm000201#7"] = livePull();
    let r = await detail("nm000201", 7);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ verdict: "not_reviewed", review: null, review_current: null });
    expect(r.body.author?.login).toBe("contributor");

    seedReview({ ds: "nm000201", n: 7, state: "dispatched" });
    r = await detail("nm000201", 7);
    expect(r.body.verdict).toBe("in_progress");
    expect(r.body.review?.outcome).toBeNull();
  });

  test("with a stored review but no answer from GitHub, it still answers and does not guess currency", async () => {
    seedReview({ ds: "nm000201", n: 7, state: "reported", verdict: "pass" });
    pulls["nm000201#7"] = 500;
    const { status, body } = await detail("nm000201", 7);
    expect(status).toBe(200);
    expect(body.live).toBeNull();
    expect(body.review_current).toBeNull();
  });

  test("with the REST budget nearly spent it still answers from what it stored, and says GitHub was not read", async () => {
    seedReview({ ds: "nm000201", n: 7, state: "reported", verdict: "pass" });
    pulls["nm000201#7"] = livePull();
    __seedRateLimitStateForTests({
      resource: "core",
      remaining: 3,
      resetEpoch: Math.floor(Date.now() / 1000) + 600,
    });
    const { status, body } = await detail("nm000201", 7);
    expect(status).toBe(200);
    expect(body.live).toBeNull();
    expect(body.review_current).toBeNull();
    expect(body.review?.verdict).toBe("pass");
    expect(calls).toHaveLength(0);
  });

  test("distinguishes a pull request that does not exist from GitHub not answering", async () => {
    const missing = await detail("nm000201", 99);
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe("no_such_pull_request");

    pulls["nm000201#98"] = 500;
    const unknown = await detail("nm000201", 98);
    expect(unknown.status).toBe(502);
  });

  test("refuses ids that are not a dataset and a pull request number", async () => {
    expect((await detail("nm1", 7)).status).toBe(400);
    const r = await get("/admin/pr-reviews/nm000201/abc");
    expect(r.status).toBe(400);
  });

  test("another environment's dataset is not answered here", async () => {
    envOverrides = { ENVIRONMENT: "staging" };
    const r = await detail("nm000201", 7);
    expect(r.status).toBe(404);
    expect(r.body.code).toBe("not_owned_here");
  });
});

// ---------------------------------------------------------------------------------------------
// Contributors
// ---------------------------------------------------------------------------------------------

function seedHistory(authorId: number, login: string, rejected: number, passed: number) {
  let n = 100;
  for (let i = 0; i < rejected; i++) {
    seedReview({ ds: "nm000301", n: n++, authorId, login, state: "reported", verdict: "fail" });
  }
  for (let i = 0; i < passed; i++) {
    seedReview({ ds: "nm000301", n: n++, authorId, login, state: "reported", verdict: "pass" });
  }
}

const standing = async (login: string) => {
  const r = await get(`/admin/pr-review-authors/${login}`);
  return { status: r.status, body: r.body as unknown as ContributorStanding & { code?: string } };
};

describe("contributor standing", () => {
  test("shows the tally, the rule, and who is counted", async () => {
    usersById.alice = { id: 77, login: "Alice", type: "User" };
    seedHistory(77, "alice", 6, 4);
    const { status, body } = await standing("alice");
    expect(status).toBe(200);
    expect(body).toMatchObject({
      login: "Alice",
      author_id: 77,
      tally: { rejected: 6, decided: 10 },
      standing: { paused: true, because: "tally" },
      thresholds: { rejected_more_than: 5, percent_more_than: 10 },
      resolved_from: "github",
    });
    expect(body.override).toBeNull();
    expect(body.recent).toHaveLength(10);
  });

  test("a newcomer's first failure pauses nobody", async () => {
    usersById.carol = { id: 78, login: "carol", type: "User" };
    seedHistory(78, "carol", 1, 0);
    expect((await standing("carol")).body.standing).toEqual({ paused: false });
  });

  test("falls back to the review history when GitHub cannot say, and says so", async () => {
    usersById.alice = 500;
    seedHistory(77, "alice", 2, 2);
    const { status, body } = await standing("alice");
    expect(status).toBe(200);
    expect(body).toMatchObject({ author_id: 77, resolved_from: "history" });
  });

  test("a login GitHub has never heard of is a 404; one it could not be asked about is not", async () => {
    expect((await standing("ghost")).status).toBe(404);
    // GitHub failing and the Worker knowing nothing is "cannot tell", which is not "no such user".
    usersById.ghost2 = 500;
    const unknown = await standing("ghost2");
    expect(unknown.status).toBe(502);
    expect(unknown.body.code).toBe("github_unavailable");
    expect((await standing("-bad-")).status).toBe(400);
  });
});

describe("PUT and DELETE /admin/pr-review-authors/:login", () => {
  test("block pauses the contributor at the real review gate, and says who did it", async () => {
    usersById.alice = { id: 77, login: "Alice", type: "User" };
    const res = await send("PUT", "/admin/pr-review-authors/alice", {
      mode: "block",
      reason: "Spam @everyone <b>now</b> https://evil.test",
    });
    expect(res.status).toBe(200);
    const body = res.body as unknown as SetOverrideResponse;
    expect(body.previous).toBeNull();
    expect(body.standing).toMatchObject({
      author_id: 77,
      standing: { paused: true, because: "maintainer" },
      override: { mode: "block", set_by: "queueadmin" },
    });
    // Free text is reduced to plain words before it is stored.
    expect(body.standing.override?.reason).not.toMatch(/[@<>]|http/);

    const stored = db.query("SELECT * FROM pr_review_overrides").all() as Array<
      Record<string, unknown>
    >;
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      author_id: 77,
      author_login: "Alice",
      mode: "block",
      set_by: adminId,
    });

    // The decision is read by the same gate the webhook uses.
    const decision = await decideReview(env().DB, {
      datasetId: "nm000301",
      prNumber: 1,
      headSha: SHA_A,
      authorId: 77,
      authorLogin: "Alice",
      authorAssociation: "COLLABORATOR",
      fromFork: false,
    });
    expect(decision).toEqual({ review: false, reason: "contributor_paused" });

    const audit = db
      .query("SELECT * FROM audit_log WHERE action = 'pr_review_override_set'")
      .all() as Array<Record<string, unknown>>;
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      user_id: adminId,
      resource_type: "pr_review_author",
      resource_id: "77",
    });
  });

  test("allow lifts a pause the tally would impose, and a second call replaces the first", async () => {
    usersById.alice = { id: 77, login: "alice", type: "User" };
    seedHistory(77, "alice", 6, 4);
    expect((await standing("alice")).body.standing.paused).toBe(true);

    const allowed = await send("PUT", "/admin/pr-review-authors/alice", { mode: "allow" });
    expect((allowed.body as unknown as SetOverrideResponse).standing.standing).toEqual({
      paused: false,
    });

    const blocked = await send("PUT", "/admin/pr-review-authors/alice", { mode: "block" });
    expect((blocked.body as unknown as SetOverrideResponse).previous).toBe("allow");
    expect(db.query("SELECT COUNT(*) AS n FROM pr_review_overrides").get()).toEqual({ n: 1 });
  });

  test("clearing hands the decision back to the tally", async () => {
    usersById.alice = { id: 77, login: "alice", type: "User" };
    seedHistory(77, "alice", 6, 4);
    await send("PUT", "/admin/pr-review-authors/alice", { mode: "allow" });
    const cleared = await send("DELETE", "/admin/pr-review-authors/alice");
    expect(cleared.status).toBe(200);
    const body = cleared.body as unknown as ClearOverrideResponse;
    expect(body.removed).toBe("allow");
    expect(body.standing.standing).toEqual({ paused: true, because: "tally" });
    expect(db.query("SELECT COUNT(*) AS n FROM pr_review_overrides").get()).toEqual({ n: 0 });
    expect(
      db
        .query("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'pr_review_override_clear'")
        .get(),
    ).toEqual({ n: 1 });

    // Nothing left to remove is a quiet answer, and writes no audit row.
    const again = await send("DELETE", "/admin/pr-review-authors/alice");
    expect((again.body as unknown as ClearOverrideResponse).removed).toBeNull();
    expect(
      db
        .query("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'pr_review_override_clear'")
        .get(),
    ).toEqual({ n: 1 });
  });

  test("an override can still be removed for an account GitHub no longer has", async () => {
    usersById.alice = { id: 77, login: "alice", type: "User" };
    await send("PUT", "/admin/pr-review-authors/alice", { mode: "block" });
    usersById = {}; // the account is gone
    const cleared = await send("DELETE", "/admin/pr-review-authors/alice");
    expect(cleared.status).toBe(200);
    expect((cleared.body as unknown as ClearOverrideResponse).removed).toBe("block");
  });

  test("writes only against an id GitHub confirms", async () => {
    // GitHub is unreachable: the history is good enough to READ a standing, not to bind a decision.
    seedHistory(77, "alice", 1, 1);
    usersById.alice = 500;
    const unreachable = await send("PUT", "/admin/pr-review-authors/alice", { mode: "block" });
    expect(unreachable.status).toBe(502);

    const unknown = await send("PUT", "/admin/pr-review-authors/nobody", { mode: "block" });
    expect(unknown.status).toBe(404);
    expect(db.query("SELECT COUNT(*) AS n FROM pr_review_overrides").get()).toEqual({ n: 0 });
  });

  test("an organisation or a bot is not a contributor", async () => {
    usersById.acme = { id: 900, login: "acme", type: "Organization" };
    const r = await send("PUT", "/admin/pr-review-authors/acme", { mode: "block" });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe("not_a_user");
    expect(db.query("SELECT COUNT(*) AS n FROM pr_review_overrides").get()).toEqual({ n: 0 });
  });

  test("the body is strict: an unknown mode or an extra key is refused, not read as intent", async () => {
    usersById.alice = { id: 77, login: "alice", type: "User" };
    expect((await send("PUT", "/admin/pr-review-authors/alice", { mode: "ignore" })).status).toBe(
      400,
    );
    expect(
      (await send("PUT", "/admin/pr-review-authors/alice", { mode: "block", extra: 1 })).status,
    ).toBe(400);
    expect((await send("PUT", "/admin/pr-review-authors/alice", {})).status).toBe(400);
    expect(db.query("SELECT COUNT(*) AS n FROM pr_review_overrides").get()).toEqual({ n: 0 });
  });

  test("a member cannot change who is reviewed", async () => {
    usersById.alice = { id: 77, login: "alice", type: "User" };
    const r = await send("PUT", "/admin/pr-review-authors/alice", { mode: "allow" }, MEMBER_KEY);
    expect(r.status).toBe(403);
    expect(db.query("SELECT COUNT(*) AS n FROM pr_review_overrides").get()).toEqual({ n: 0 });
  });
});
