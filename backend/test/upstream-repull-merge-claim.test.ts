/**
 * The daily merge cap, the claim to merge, and the facts only GitHub and the version row can state
 * (epic #1046 phase 6, #1912; ADR 0111, decisions 2, 3, 4 and 6), through their real entry points:
 * the transition route's claim edge, `POST /admin/repulls/:id/merge-claim/release`, `.../merged`
 * and `.../released`.
 *
 * Real engine only: bun:sqlite behind realD1 with every migration applied, the real auth and admin
 * middleware, the real routes and services, and a `Bun.serve()` stand-in for api.github.com
 * (NEMAR_GITHUB_API_URL) that answers the three reads the Worker makes (a pull request, a tag's
 * commit, a comparison) and records each request. The cap's UTC day is D1's own clock, so
 * "yesterday" is a claim seeded with yesterday's time, never a mocked clock.
 *
 * The properties, each with a test that fails when its line is changed:
 *  - every claim, N.0.0's and N.0.1's alike, takes one unit of the day's cap; a refusal writes
 *    nothing; two claims racing for the last unit cannot both win; an unreadable cap reads 0;
 *  - a claim is released only when GitHub says the pull request did not merge, and never for an
 *    unknown outcome;
 *  - `merged` is written from GitHub's answer, and a merge with no claim, or at another head, is
 *    recorded and counted, never hidden;
 *  - `released` needs the version row with a DOI and a tag on a commit that contains the merge;
 *    it writes N.0.0's lineage only when the caller verified the tree, and re-arms the four sweep
 *    stamps of that dataset only, in the same batch, and only when the transition applies.
 */

import type { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { Hono } from "hono";
import { parseScreenReport } from "../../shared/identifier-screen-report";
import type { RepullStatus } from "../../shared/repull-state";
import { adminMiddleware, authMiddleware } from "../src/middleware/auth";
import { registerUpstreamRepullRoutes } from "../src/routes/admin/upstream-repulls";
import { hashApiKey } from "../src/services/token";
import {
  REPULL_CAP_MAX,
  REPULL_MERGE_CAP_DEFAULT,
  readRepullCap,
  repullMergeCap,
} from "../src/services/upstream-repull";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";
import { type Row, rowAt } from "./helpers/repull-rows";
import { type CapturedEmail, withFakeResend } from "./helpers/resend";

const ADMIN_KEY = "rpm-admin-key-0123456789abcdef0123456789abcdef012";
const HEAD = "0123456789abcdef0123456789abcdef01234567";
const OTHER = "89abcdef0123456789abcdef0123456789abcdef";
const MERGE = "1111111111111111111111111111111111111111";
const TAG = "2222222222222222222222222222222222222222";

// biome-ignore lint/suspicious/noExplicitAny: a response body read field by field in assertions
type Json = Record<string, any>;

interface PullAnswer {
  status?: number;
  merged?: boolean;
  merge_commit_sha?: string | null;
  head?: { sha: string; ref: string };
  base?: { ref: string };
}

let server: Server;
let requests: string[] = [];
/** Answers keyed by `<dataset>#<number>`. */
let pulls: Record<string, PullAnswer> = {};
/** Tag commits keyed by `<dataset>@<tag>`; absent is a 404. */
let tags: Record<string, string> = {};
/** The comparison's status keyed by `<dataset>:<base>...<head>`; absent is `ahead`. */
let compares: Record<string, string> = {};
let githubDown = false;
let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;
let adminId = 0;
let mail: CapturedEmail[] = [];
let releaseMail: (() => void) | null = null;
let mailDone: Promise<void> | null = null;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      requests.push(`${req.method} ${url.pathname}`);
      if (githubDown) return new Response("unavailable", { status: 503 });
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "Content-Type": "application/json" },
        });
      let m = /^\/repos\/nemarDatasets\/([a-z]{2}\d{6})\/pulls\/(\d+)$/.exec(url.pathname);
      if (m) {
        const a = pulls[`${m[1]}#${m[2]}`];
        if (!a) return json({ message: "Not Found" }, 404);
        if (a.status && a.status !== 200) return json({ message: "no" }, a.status);
        return json({
          number: Number(m[2]),
          merged: a.merged ?? false,
          merge_commit_sha: a.merge_commit_sha === undefined ? MERGE : a.merge_commit_sha,
          head: a.head ?? { sha: HEAD, ref: "release/v2.0.0" },
          base: a.base ?? { ref: "main" },
        });
      }
      m = /^\/repos\/nemarDatasets\/([a-z]{2}\d{6})\/commits\/tags\/(.+)$/.exec(url.pathname);
      if (m) {
        const sha = tags[`${m[1]}@${decodeURIComponent(m[2] as string)}`];
        return sha ? json({ sha }) : json({ message: "No commit found" }, 422);
      }
      m =
        /^\/repos\/nemarDatasets\/([a-z]{2}\d{6})\/compare\/([0-9a-f]{40})\.\.\.([0-9a-f]{40})$/.exec(
          url.pathname,
        );
      if (m) return json({ status: compares[`${m[1]}:${m[2]}...${m[3]}`] ?? "ahead" });
      return json({ message: "Not Found" }, 404);
    },
  });
  (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL =
    `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL = undefined;
  server.stop(true);
});

beforeEach(async () => {
  db = freshDb();
  app = new Hono();
  app.use("*", authMiddleware);
  app.use("*", adminMiddleware);
  registerUpstreamRepullRoutes(app);
  db.run(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified)
     VALUES ('rpmadmin', 'rpmadmin@example.org', 'x', 'approved', 'admin', 1)`,
  );
  adminId = (db.query("SELECT id FROM users WHERE username = 'rpmadmin'").get() as Row)
    .id as number;
  db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)").run(
    adminId,
    await hashApiKey(ADMIN_KEY),
    ADMIN_KEY.slice(0, 8),
  );
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
  expect(mail).toEqual([]);
  requests = [];
  pulls = {};
  tags = {};
  compares = {};
  githubDown = false;
});

function env(over: Partial<Bindings> = {}): Bindings {
  return {
    DB: realD1(db),
    ENVIRONMENT: "production",
    GITHUB_ADMIN_PAT: "ghp_repull_merge_test",
    RESEND_API_KEY: "re_test",
    FROM_EMAIL: "NEMAR <noreply@nemar.org>",
    ...over,
  } as Bindings;
}

async function call(path: string, body: unknown, o: { env?: Partial<Bindings> } = {}) {
  const res = await app.request(
    path,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${ADMIN_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    env(o.env),
  );
  return { status: res.status, body: (await res.json()) as Json };
}

function seedMirror(id: string, o: { anonymous?: boolean; stamps?: Record<string, string> } = {}) {
  db.run(
    `INSERT INTO datasets (dataset_id, name, owner_user_id, source, source_id, anonymous, sweep_stamps)
     VALUES (?, ?, ?, 'openneuro', 'ds099999', ?, ?)`,
    [id, id, adminId, o.anonymous ? 1 : 0, o.stamps ? JSON.stringify(o.stamps) : null],
  );
}

function seedRepull(status: RepullStatus, over: Row = {}): number {
  const row = rowAt(status, {
    dataset_id: "on099999",
    upstream_ds: "ds099999",
    actor_user_id: adminId,
    head_sha: HEAD,
    ...(status === "gates_clear" ? { gates_sha: HEAD } : {}),
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

/** A stored screen verdict of `sha`, as the callback leaves it. */
function markScreen(repullId: number, status: string, o: { pr?: string; sha?: string } = {}) {
  const sha = o.sha ?? HEAD;
  const report = parseScreenReport({
    version: 1,
    scanner: "identifier-scan@abcdef1",
    head: sha,
    scan: {
      id: "on099999",
      version: null,
      scanned_at: "2026-10-24T12:00:00.000Z",
      manifest_source: "clone",
      status,
      incomplete: false,
      incomplete_reasons: [],
      files: { total: 10, edf_bdf: 4, header_read: 4, header_read_failed: 0 },
    },
  });
  db.run(
    `INSERT INTO upstream_repull_screens (repull_id, pr, sha, status, report, reported_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))`,
    [repullId, o.pr ?? "n0", sha, status, JSON.stringify(report)],
  );
}

/** A mirror with a gates_clear row and a clear screen of its head: ready to claim. */
function ready(datasetId = "on099999", status: RepullStatus = "gates_clear"): number {
  if (!db.query("SELECT 1 FROM datasets WHERE dataset_id = ?").get(datasetId)) {
    seedMirror(datasetId);
  }
  const patch = status === "patch_gates_clear";
  const id = seedRepull(status, {
    dataset_id: datasetId,
    ...(patch ? { patch_head_sha: HEAD, patch_gates_sha: HEAD } : {}),
  });
  markScreen(id, "clean", { pr: patch ? "n1" : "n0" });
  return id;
}

const claim = (id: number, o: { env?: Partial<Bindings> } = {}) =>
  call(
    `/repulls/${id}/transition`,
    {
      from: "gates_clear",
      to: "gates_clear",
      fields: { merge_claim_sha: HEAD },
    },
    o,
  );

const patchClaim = (id: number, o: { env?: Partial<Bindings> } = {}) =>
  call(
    `/repulls/${id}/transition`,
    {
      from: "patch_gates_clear",
      to: "patch_gates_clear",
      fields: { patch_merge_claim_sha: HEAD },
    },
    o,
  );

const rowOf = (id: number) =>
  db.query("SELECT * FROM upstream_repulls WHERE id = ?").get(id) as Row;

const auditCount = () =>
  (db.query("SELECT COUNT(*) AS n FROM audit_log WHERE action LIKE 'repull_%'").get() as Row).n;

// ----------------------------------------------------------------------------
// The cap's reading
// ----------------------------------------------------------------------------

describe("REPULL_DAILY_MERGE_CAP", () => {
  test("absent takes the default; one or two digits up to the maximum are read; anything else is 0", () => {
    expect(readRepullCap(undefined, REPULL_MERGE_CAP_DEFAULT)).toEqual({
      value: 5,
      source: "default",
    });
    expect(REPULL_MERGE_CAP_DEFAULT).toBe(5);
    for (const [raw, value] of [
      ["0", 0],
      ["1", 1],
      ["5", 5],
      [String(REPULL_CAP_MAX), REPULL_CAP_MAX],
    ] as const) {
      expect([raw, readRepullCap(raw, 5)]).toEqual([raw, { value, source: "set" }]);
    }
    for (const raw of [
      String(REPULL_CAP_MAX + 1),
      "100",
      "2.5",
      "-1",
      "",
      " 2",
      "2 ",
      "x",
      "1e1",
    ]) {
      expect([raw, readRepullCap(raw, 5)]).toEqual([raw, { value: 0, source: "unreadable" }]);
    }
    expect(repullMergeCap({ REPULL_DAILY_MERGE_CAP: "3" })).toEqual({ value: 3, source: "set" });
  });
});

// ----------------------------------------------------------------------------
// The claim
// ----------------------------------------------------------------------------

describe("the claim takes a unit of the day's cap", () => {
  test("with a cap of 1 the second claim of the UTC day is refused, and writes nothing", async () => {
    const a = ready("on099999");
    const b = ready("on099998");
    const capped = { env: { REPULL_DAILY_MERGE_CAP: "1" } };
    expect((await claim(a, capped)).status).toBe(200);
    const before = rowOf(b);
    const audits = auditCount();
    const refused = await claim(b, capped);
    expect([refused.status, refused.body.code]).toEqual([429, "merge-cap"]);
    expect(refused.body.merge_cap).toEqual({ value: 1, source: "set", used: 1 });
    expect(rowOf(b)).toEqual(before);
    expect(auditCount()).toBe(audits);
  });

  test("yesterday's claims do not count", async () => {
    const a = ready("on099999");
    const b = ready("on099998");
    expect((await claim(a, { env: { REPULL_DAILY_MERGE_CAP: "1" } })).status).toBe(200);
    db.run(
      "UPDATE upstream_repulls SET merge_claimed_at = datetime('now', '-1 day') WHERE id = ?",
      [a],
    );
    expect((await claim(b, { env: { REPULL_DAILY_MERGE_CAP: "1" } })).status).toBe(200);
  });

  test("an N.0.1 claim takes a unit too, and an N.0.0 claim takes N.0.1's", async () => {
    const patch = ready("on099998", "patch_gates_clear");
    const n0 = ready("on099999");
    const capped = { env: { REPULL_DAILY_MERGE_CAP: "1" } };
    expect((await patchClaim(patch, capped)).status).toBe(200);
    expect((await claim(n0, capped)).body.code).toBe("merge-cap");
    db.run(
      "UPDATE upstream_repulls SET patch_merge_claimed_at = NULL, patch_merge_claim_sha = NULL",
    );
    expect((await claim(n0, capped)).status).toBe(200);
    expect((await patchClaim(patch, capped)).body.code).toBe("merge-cap");
  });

  test("the cap is the number of claims: two of two pass, the third does not", async () => {
    const ids = [ready("on099997"), ready("on099998"), ready("on099999")];
    const capped = { env: { REPULL_DAILY_MERGE_CAP: "2" } };
    expect((await claim(ids[0] as number, capped)).status).toBe(200);
    expect((await claim(ids[1] as number, capped)).status).toBe(200);
    const third = await claim(ids[2] as number, capped);
    expect([third.status, third.body.code, third.body.merge_cap.used]).toEqual([
      429,
      "merge-cap",
      2,
    ]);
  });

  test("two claims racing for the last unit: exactly one wins", async () => {
    const used = ready("on099997");
    const a = ready("on099998");
    const b = ready("on099999");
    const capped = { env: { REPULL_DAILY_MERGE_CAP: "2" } };
    expect((await claim(used, capped)).status).toBe(200);
    const results = await Promise.all([claim(a, capped), claim(b, capped)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 429]);
    const held = db
      .query("SELECT COUNT(*) AS n FROM upstream_repulls WHERE merge_claimed_at IS NOT NULL")
      .get() as Row;
    expect(held.n).toBe(2);
  });

  test("absent, the cap is 5; set to 0, or set but unreadable, nothing is claimed", async () => {
    const ids = ["on099990", "on099991", "on099992", "on099993", "on099994", "on099995"].map((d) =>
      ready(d),
    );
    for (const id of ids.slice(0, 5)) expect((await claim(id)).status).toBe(200);
    expect((await claim(ids[5] as number)).body.code).toBe("merge-cap");

    const fresh = ready("on099999");
    const zero = await claim(fresh, { env: { REPULL_DAILY_MERGE_CAP: "0" } });
    expect([zero.status, zero.body.code]).toEqual([429, "merge-cap"]);
    for (const raw of ["x", "21", ""]) {
      const res = await claim(fresh, { env: { REPULL_DAILY_MERGE_CAP: raw } });
      expect([raw, res.status, res.body.code, res.body.merge_cap?.source]).toEqual([
        raw,
        429,
        "merge-cap-unreadable",
        "unreadable",
      ]);
    }
    expect(rowOf(fresh).merge_claimed_at).toBeNull();
  });

  test("a claim needs the screen to pass for the claimed head, and the dataset fences", async () => {
    seedMirror("on099999");
    const id = seedRepull("gates_clear");
    const none = await claim(id);
    expect([none.status, none.body.code]).toEqual([409, "screen-not-clear"]);
    markScreen(id, "review");
    expect((await claim(id)).body.code).toBe("screen-not-clear");
    db.run("DELETE FROM upstream_repull_screens");
    markScreen(id, "clean");
    db.run("UPDATE datasets SET anonymous = 1");
    expect((await claim(id)).body.code).toBe("anonymous-dataset");
    db.run("UPDATE datasets SET anonymous = 0");
    expect((await claim(id)).status).toBe(200);
  });

  test("a screen that changes between the read and the claim is not relied on", async () => {
    const id = ready("on099999");
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
      `/repulls/${id}/transition`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${ADMIN_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: "gates_clear",
          to: "gates_clear",
          fields: { merge_claim_sha: HEAD },
        }),
      },
      { ...env(), DB: racing },
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as Json).code).toBe("screen-changed");
    expect(rowOf(id).merge_claimed_at).toBeNull();
  });
});

// ----------------------------------------------------------------------------
// Releasing a claim
// ----------------------------------------------------------------------------

describe("releasing a claim", () => {
  const release = (id: number, outcome: string, sha = HEAD) =>
    call(`/repulls/${id}/merge-claim/release`, { pr: "n0", sha, outcome });

  test("a merge not sent, or refused, frees the unit once GitHub says it did not merge", async () => {
    const a = ready("on099998");
    const b = ready("on099999");
    const capped = { env: { REPULL_DAILY_MERGE_CAP: "1" } };
    expect((await claim(a, capped)).status).toBe(200);
    pulls["on099998#7"] = { merged: false };
    const res = await release(a, "refused");
    expect(res.status).toBe(200);
    expect(res.body.repull).toMatchObject({ merge_claimed_at: null, merge_claim_sha: null });
    expect(requests).toContain("GET /repos/nemarDatasets/on099998/pulls/7");
    const audit = db
      .query("SELECT details FROM audit_log WHERE action = 'repull_merge_claim_released'")
      .get() as Row;
    expect(JSON.parse(audit.details as string)).toMatchObject({ outcome: "refused" });
    expect((await claim(b, capped)).status).toBe(200);
  });

  test("an unknown outcome cannot release, and neither can a merged pull request or an unread GitHub", async () => {
    const id = ready("on099999");
    expect((await claim(id)).status).toBe(200);
    const unknown = await release(id, "unknown");
    expect(unknown.status).toBe(400);
    pulls["on099999#7"] = { merged: true };
    const merged = await release(id, "not_sent");
    expect([merged.status, merged.body.code]).toEqual([409, "pull-request-merged"]);
    githubDown = true;
    const down = await release(id, "not_sent");
    expect([down.status, down.body.code]).toEqual([502, "github-unreadable"]);
    expect(rowOf(id).merge_claim_sha).toBe(HEAD);
  });

  test("no claim, another sha, or another pull request is refused", async () => {
    const id = ready("on099999");
    expect((await release(id, "not_sent")).body.code).toBe("no-claim");
    await claim(id);
    expect((await release(id, "not_sent", OTHER)).body.code).toBe("claim-mismatch");
    pulls["on099999#7"] = { merged: false, head: { sha: HEAD, ref: "release/v3.0.0" } };
    expect((await release(id, "not_sent")).body.code).toBe("pull-request-mismatch");
    expect(rowOf(id).merge_claim_sha).toBe(HEAD);
  });
});

// ----------------------------------------------------------------------------
// Merged
// ----------------------------------------------------------------------------

describe("recording the merge", () => {
  const merged = (id: number, pr = "n0", o: { env?: Partial<Bindings> } = {}) =>
    call(`/repulls/${id}/merged`, { pr }, o);

  test("a merge at the claimed head is recorded with GitHub's merge commit", async () => {
    const id = ready("on099999");
    await claim(id);
    pulls["on099999#7"] = { merged: true, merge_commit_sha: MERGE };
    const res = await merged(id);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ merged_outside_tool: false, merged_unscreened_head: false });
    expect(res.body.repull).toMatchObject({ status: "merged", merge_sha: MERGE, counts: {} });
    expect(requests).toEqual(["GET /repos/nemarDatasets/on099999/pulls/7"]);
  });

  test("an open pull request is not recorded as merged", async () => {
    const id = ready("on099999");
    await claim(id);
    pulls["on099999#7"] = { merged: false };
    const before = rowOf(id);
    const res = await merged(id);
    expect([res.status, res.body.code]).toEqual([409, "not-merged"]);
    expect(rowOf(id)).toEqual(before);
  });

  test("a merge with no claim is recorded and counted as outside NEMAR's tools", async () => {
    const id = ready("on099999");
    pulls["on099999#7"] = { merged: true };
    const res = await merged(id);
    expect(res.status).toBe(200);
    expect(res.body.repull.counts).toEqual({ merged_outside_tool: 1 });
    expect(res.body.merged_outside_tool).toBe(true);
  });

  test("a merge at a head other than the screened one is recorded and counted as such", async () => {
    const id = ready("on099999");
    await claim(id);
    pulls["on099999#7"] = { merged: true, head: { sha: OTHER, ref: "release/v2.0.0" } };
    const res = await merged(id);
    expect(res.status).toBe(200);
    expect(res.body.repull.counts).toEqual({ merged_outside_tool: 1, merged_unscreened_head: 1 });
  });

  test("a merge GitHub cannot name, a missing pull request and a moved one are refused", async () => {
    const id = ready("on099999");
    pulls["on099999#7"] = { merged: true, merge_commit_sha: null };
    expect((await merged(id)).body.code).toBe("github-unreadable");
    pulls = {};
    expect((await merged(id)).body.code).toBe("pull-request-missing");
    pulls["on099999#7"] = { merged: true, base: { ref: "dev" } };
    expect((await merged(id)).body.code).toBe("pull-request-mismatch");
    expect(rowOf(id).status).toBe("gates_clear");
  });

  test("only from gates_clear, only in production for an on dataset, and the transition route cannot state it", async () => {
    seedMirror("on099999");
    const open = seedRepull("pr_open");
    expect((await merged(open)).body.code).toBe("bad-transition");
    db.run("DELETE FROM upstream_repulls");
    const id = ready("on099999");
    pulls["on099999#7"] = { merged: true };
    const fenced = await merged(id, "n0", { env: { ENVIRONMENT: "test" } });
    expect([fenced.status, fenced.body.code]).toEqual([403, "env-fence"]);
    expect(requests).toEqual([]);
    const stated = await call(`/repulls/${id}/transition`, {
      from: "gates_clear",
      to: "merged",
      fields: { merge_sha: MERGE },
    });
    expect(stated.body.code).toBe("use-verified-route");
  });

  test("the counts only the Worker writes cannot be stated by a request", async () => {
    seedMirror("on099999");
    const id = seedRepull("released");
    const res = await call(`/repulls/${id}/transition`, {
      from: "released",
      to: "released",
      fields: { counts: { merged_outside_tool: 0 } },
    });
    expect([res.status, res.body.code]).toEqual([400, "field-not-allowed"]);
    const create = await call("/repulls", {
      dataset_id: "on099999",
      upstream_ds: "ds099999",
      from_tag: "1.0.0",
      to_tag: "1.0.1",
      from_version: "1.0.0",
      to_version: "2.0.0",
      plan_digest: `sha256:${"0".repeat(64)}`,
      planner: 2,
      base_sha: HEAD,
      lineage_recordable: false,
      counts: { merged_unscreened_head: 0 },
    });
    expect([create.status, create.body.code]).toEqual([400, "invalid-body"]);
  });

  test("N.0.1's merge is recorded the same way", async () => {
    const id = ready("on099999", "patch_gates_clear");
    await patchClaim(id);
    pulls["on099999#8"] = { merged: true, head: { sha: HEAD, ref: "release/v2.0.1" } };
    const res = await merged(id, "n1");
    expect(res.status).toBe(200);
    expect(res.body.repull).toMatchObject({ status: "patch_merged", patch_merge_sha: MERGE });
  });
});

// ----------------------------------------------------------------------------
// Released
// ----------------------------------------------------------------------------

describe("recording the release", () => {
  const STAMPS = {
    hed_checked_at: "2026-10-01 00:00:00",
    channel_montage_checked_at: "2026-10-01 00:00:00",
    data_checked_at: "2026-10-01 00:00:00",
    availability_report_at: "2026-10-01 00:00:00",
    zarr_checked_at: "2026-10-01 00:00:00",
  };

  function releasedFixture(version = "2.0.0", basis: string | null = "doi") {
    seedMirror("on099999", { stamps: STAMPS });
    seedMirror("on099998", { stamps: STAMPS });
    db.run(
      `INSERT INTO dataset_versions (dataset_id, version, doi, source_version, source_version_basis)
       VALUES ('on099999', ?, '10.82901/on099999.v2.0.0', ?, ?)`,
      [version, basis === "unknown" ? null : "1.0.1", basis],
    );
    tags["on099999@v2.0.0"] = TAG;
    return seedRepull("merged", { merge_sha: MERGE });
  }

  const released = (id: number, body: Record<string, unknown> = {}) =>
    call(`/repulls/${id}/released`, { pr: "n0", tag_sha: TAG, tree_verified: true, ...body });

  const stampsOf = (id: string) =>
    JSON.parse(
      (db.query("SELECT sweep_stamps FROM datasets WHERE dataset_id = ?").get(id) as Row)
        .sweep_stamps as string,
    );

  const basisOf = () =>
    db
      .query(
        "SELECT source_version, source_version_basis FROM dataset_versions WHERE dataset_id = 'on099999'",
      )
      .get();

  test("writes the tag, N.0.0's lineage and re-arms that dataset's four stamps, in one batch", async () => {
    const id = releasedFixture();
    const res = await released(id);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ lineage_rows: 1, stamps_rearmed: 1 });
    expect(res.body.repull).toMatchObject({ status: "released", tag_sha: TAG });
    expect(basisOf()).toEqual({ source_version: "1.0.1", source_version_basis: "lineage" });
    expect(stampsOf("on099999")).toEqual({ zarr_checked_at: "2026-10-01 00:00:00" });
    // Every other dataset's stamps and values are as they were.
    expect(stampsOf("on099998")).toEqual(STAMPS);
    expect(requests).toEqual([
      "GET /repos/nemarDatasets/on099999/commits/tags/v2.0.0",
      `GET /repos/nemarDatasets/on099999/compare/${MERGE}...${TAG}`,
    ]);
    const audit = db
      .query("SELECT details FROM audit_log WHERE action = 'repull_transition'")
      .get() as Row;
    expect(JSON.parse(audit.details as string)).toMatchObject({
      to: "released",
      tree_verified: true,
    });
  });

  test("without a verified tree the lineage is not written, and the stamps are still re-armed", async () => {
    const id = releasedFixture();
    const res = await released(id, { tree_verified: false });
    expect(res.status).toBe(200);
    expect(res.body.lineage_rows).toBe(0);
    expect(basisOf()).toEqual({ source_version: "1.0.1", source_version_basis: "doi" });
    expect(stampsOf("on099999")).toEqual({ zarr_checked_at: "2026-10-01 00:00:00" });
  });

  test("a version row recorded unknown is never overwritten, and the v spelling is found", async () => {
    const id = releasedFixture("v2.0.0", "unknown");
    const res = await released(id);
    expect(res.status).toBe(200);
    expect(res.body.lineage_rows).toBe(0);
    expect(basisOf()).toEqual({ source_version: null, source_version_basis: "unknown" });
  });

  test("no version row with a DOI, no tag, a tag on another commit, or one without the merge: nothing is written", async () => {
    seedMirror("on099999", { stamps: STAMPS });
    const id = seedRepull("merged", { merge_sha: MERGE });
    expect((await released(id)).body.code).toBe("not-released");
    expect(requests).toEqual([]);
    db.run(
      "INSERT INTO dataset_versions (dataset_id, version, doi) VALUES ('on099999', '2.0.0', '10.82901/x')",
    );
    expect((await released(id)).body.code).toBe("tag-missing");
    tags["on099999@v2.0.0"] = OTHER;
    expect((await released(id)).body.code).toBe("tag-mismatch");
    tags["on099999@v2.0.0"] = TAG;
    compares[`on099999:${MERGE}...${TAG}`] = "diverged";
    expect((await released(id)).body.code).toBe("tag-mismatch");
    expect(rowOf(id).status).toBe("merged");
    expect(stampsOf("on099999")).toEqual(STAMPS);
  });

  test("a tag at a descendant of the merge (enrichment after it) is accepted", async () => {
    const id = releasedFixture();
    compares[`on099999:${MERGE}...${TAG}`] = "ahead";
    expect((await released(id)).status).toBe(200);
    db.run("DELETE FROM upstream_repulls");
    db.run("DELETE FROM datasets");
    db.run("DELETE FROM dataset_versions");
    const same = releasedFixture();
    tags["on099999@v2.0.0"] = MERGE;
    compares[`on099999:${MERGE}...${MERGE}`] = "identical";
    expect((await released(same, { tag_sha: MERGE })).status).toBe(200);
  });

  test("when the row moves before the batch runs, neither the lineage nor the stamps are written", async () => {
    const id = releasedFixture();
    const real = realD1(db);
    let done = false;
    const racing = {
      ...real,
      prepare(sql: string) {
        if (!done && sql.startsWith("UPDATE upstream_repulls SET")) {
          done = true;
          // Another writer moves the row (a count recorded) after this request read it.
          db.run("UPDATE upstream_repulls SET revision = revision + 1 WHERE id = ?", [id]);
        }
        return real.prepare(sql);
      },
      batch: real.batch.bind(real),
    } as unknown as D1Database;
    const res = await app.request(
      `/repulls/${id}/released`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${ADMIN_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ pr: "n0", tag_sha: TAG, tree_verified: true }),
      },
      { ...env(), DB: racing },
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as Json).code).toBe("stale-status");
    expect(basisOf()).toEqual({ source_version: "1.0.1", source_version_basis: "doi" });
    expect(stampsOf("on099999")).toEqual(STAMPS);
    expect(rowOf(id).status).toBe("merged");
  });

  test("N.0.1's release re-arms the stamps and never writes lineage", async () => {
    seedMirror("on099999", { stamps: STAMPS });
    db.run(
      `INSERT INTO dataset_versions (dataset_id, version, doi, source_version, source_version_basis)
       VALUES ('on099999', '2.0.0', '10.82901/a', '1.0.1', 'doi'), ('on099999', '2.0.1', '10.82901/b', NULL, NULL)`,
    );
    tags["on099999@v2.0.1"] = TAG;
    const id = seedRepull("patch_merged", { patch_merge_sha: MERGE });
    const res = await call(`/repulls/${id}/released`, {
      pr: "n1",
      tag_sha: TAG,
      tree_verified: true,
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ lineage_rows: 0, stamps_rearmed: 1 });
    expect(res.body.repull).toMatchObject({ status: "patch_released", patch_tag_sha: TAG });
    expect(
      db.query("SELECT version, source_version_basis FROM dataset_versions ORDER BY version").all(),
    ).toEqual([
      { version: "2.0.0", source_version_basis: "doi" },
      { version: "2.0.1", source_version_basis: null },
    ]);
  });
});
