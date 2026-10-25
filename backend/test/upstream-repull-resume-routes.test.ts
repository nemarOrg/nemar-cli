/**
 * What the Worker's re-pull routes gained for resume, the merge gate and the release (epic #1046
 * phase 6, #1912; ADR 0111, decisions 3, 6 and 8), through their real entry points: the transition
 * route, `POST /admin/repulls/:id/merged` and `POST /admin/repulls/:id/merge-claim/release`.
 *
 * Real engine only: bun:sqlite behind realD1 with every migration applied, the real auth and admin
 * middleware, the real routes and services, and the shared `Bun.serve()` stand-in for
 * api.github.com (`helpers/repull-github-standin.ts`). Nothing here mails anyone.
 *
 * The properties, each with a test that fails when its line is changed:
 *  - a pull request found merged while the row is `pr_open` is recorded by the verified route, as
 *    a merge outside the tools at an unscreened head, from GitHub's own answer;
 *  - `merged` repeats to record why the release could not be recorded yet, and only that;
 *  - every step that moves a record past `prepared` and keeps it open re-reads the dataset fences
 *    (anonymous, withdrawn, an import in flight, a mirror of that `ds`), while giving up, an
 *    error-only self-edge and a verified fact do not;
 *  - a released N.0.0 records its locked objects before it goes on (`lock-unrecorded`), the
 *    `released` self-edge carries the count or why the lock did not complete, and the count
 *    clears that error;
 *  - a stuck claim whose outcome nobody knows expires (`expired`) only once it is thirty minutes
 *    old and only when GitHub says the pull request did not merge.
 */

import type { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { REPULL_STATUSES, type RepullStatus } from "../../shared/repull-state";
import { adminMiddleware, authMiddleware } from "../src/middleware/auth";
import { registerUpstreamRepullRoutes } from "../src/routes/admin/upstream-repulls";
import { __resetRateLimitStateForTests } from "../src/services/github/transport";
import { hashApiKey } from "../src/services/token";
import {
  CLAIM_EXPIRE_MIN_AGE_MINUTES,
  CLAIM_RELEASE_MIN_AGE_MINUTES,
} from "../src/services/upstream-repull-verified";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";
import {
  type RepullGitHub,
  STANDIN_MERGE_SHA,
  startRepullGitHub,
} from "./helpers/repull-github-standin";
import { type Row, rowAt } from "./helpers/repull-rows";
import { type CapturedEmail, withFakeResend } from "./helpers/resend";

const ADMIN_KEY = "rpr-admin-key-0123456789abcdef0123456789abcdef0123";
const HEAD = "0123456789abcdef0123456789abcdef01234567";
const OTHER = "89abcdef0123456789abcdef0123456789abcdef";
const DATASET = "on099999";

// biome-ignore lint/suspicious/noExplicitAny: a response body read field by field in assertions
type Json = Record<string, any>;

let gh: RepullGitHub;
let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;
let adminId = 0;
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
  app.use("*", authMiddleware);
  app.use("*", adminMiddleware);
  registerUpstreamRepullRoutes(app);
  db.run(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified)
     VALUES ('rpradmin', 'rpradmin@example.org', 'x', 'approved', 'admin', 1)`,
  );
  adminId = (db.query("SELECT id FROM users WHERE username = 'rpradmin'").get() as Row)
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
  gh.reset();
  __resetRateLimitStateForTests();
});

function env(over: Partial<Bindings> = {}): Bindings {
  return {
    DB: realD1(db),
    ENVIRONMENT: "production",
    GITHUB_ADMIN_PAT: "ghp_repull_resume_test",
    RESEND_API_KEY: "re_test",
    FROM_EMAIL: "NEMAR <noreply@nemar.org>",
    ...over,
  } as Bindings;
}

async function call(path: string, body?: unknown) {
  const res = await app.request(
    path,
    body === undefined
      ? { headers: { Authorization: `Bearer ${ADMIN_KEY}` } }
      : {
          method: "POST",
          headers: { Authorization: `Bearer ${ADMIN_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
    env(),
  );
  return { status: res.status, body: (await res.json()) as Json };
}

interface MirrorSeed {
  anonymous?: boolean;
  withdrawn?: boolean;
  importStatus?: string;
  source?: string;
}

function seedMirror(o: MirrorSeed = {}): void {
  db.run(
    `INSERT INTO datasets (dataset_id, name, owner_user_id, source, source_id, anonymous, withdrawn_at)
     VALUES (?, ?, ?, ?, 'ds099999', ?, ?)`,
    [
      DATASET,
      DATASET,
      adminId,
      o.source ?? "openneuro",
      o.anonymous ? 1 : 0,
      o.withdrawn ? "2026-01-01 00:00:00" : null,
    ],
  );
  if (o.importStatus) {
    db.run(
      "INSERT INTO import_jobs (dataset_id, source, source_id, status) VALUES (?, 'openneuro', 'ds099999', ?)",
      [DATASET, o.importStatus],
    );
  }
}

function seedRepull(status: RepullStatus, over: Row = {}): number {
  const row = rowAt(status, {
    dataset_id: DATASET,
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

const rowOf = (id: number) =>
  db.query("SELECT * FROM upstream_repulls WHERE id = ?").get(id) as Row;

const move = (id: number, body: Record<string, unknown>) => call(`/repulls/${id}/transition`, body);

const PR = { branch: "release/v2.0.0", pr_number: 7, head_sha: HEAD };

/** What a record's copy and uploads wrote, as `copied`, `skipped` and `local_uploads` record it. */
const WROTE = (copied: number, skipped = 0, local = 0) =>
  JSON.stringify({ copied, skipped, local_uploads: local });

/** A record seeded at `status`; a released one records that its copy wrote three objects. */
const seedAt = (status: RepullStatus) =>
  seedRepull(status, status === "released" ? { counts: WROTE(3) } : {});

// ----------------------------------------------------------------------------
// A merge found while the row is pr_open
// ----------------------------------------------------------------------------

describe("a pull request merged before its gates were recorded", () => {
  const merged = (id: number) => call(`/repulls/${id}/merged`, { pr: "n0" });

  test("is recorded from pr_open, from GitHub's answer, as outside the tools at an unscreened head", async () => {
    seedMirror();
    const id = seedRepull("pr_open");
    expect(rowOf(id).gates_sha).toBeNull();
    gh.pulls[`${DATASET}#7`] = { merged: true };
    const res = await merged(id);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      merged_outside_tool: true,
      merged_unscreened_head: true,
      replayed: false,
      repull: { status: "merged", merge_sha: STANDIN_MERGE_SHA },
    });
    expect(JSON.parse(rowOf(id).counts as string)).toEqual({
      merged_outside_tool: 1,
      merged_unscreened_head: 1,
    });
    // GitHub was read, and the audit row says from where the merge was recorded.
    expect(gh.requests).toContain(`GET /repos/nemarDatasets/${DATASET}/pulls/7`);
    const audit = db
      .query("SELECT details FROM audit_log WHERE action = 'repull_transition'")
      .get() as Row;
    expect(JSON.parse(audit.details as string)).toMatchObject({ from: "pr_open", to: "merged" });
  });

  test("an open pull request that GitHub says is not merged is refused, and nothing is written", async () => {
    seedMirror();
    const id = seedRepull("pr_open");
    const before = rowOf(id);
    gh.pulls[`${DATASET}#7`] = { merged: false };
    const res = await merged(id);
    expect([res.status, res.body.code]).toEqual([409, "not-merged"]);
    expect(rowOf(id)).toEqual(before);
  });

  test("the transition route still cannot state it from pr_open", async () => {
    seedMirror();
    const id = seedRepull("pr_open");
    const res = await move(id, { from: "pr_open", to: "merged", fields: { merge_sha: HEAD } });
    expect([res.status, res.body.code]).toEqual([409, "use-verified-route"]);
    expect(rowOf(id).status).toBe("pr_open");
  });
});

// ----------------------------------------------------------------------------
// merged repeats to record an error
// ----------------------------------------------------------------------------

describe("merged records why the release is not recorded yet", () => {
  test("an error alone, as planned does, and nothing else", async () => {
    seedMirror();
    const id = seedRepull("merged");
    expect((await move(id, { from: "merged", to: "merged" })).body.code).toBe("field-missing");
    const withField = await move(id, {
      from: "merged",
      to: "merged",
      fields: { tag_sha: HEAD },
      error: "[release:tag-mismatch] the tag names another commit",
    });
    expect(withField.body.code).toBe("field-not-allowed");
    const ok = await move(id, {
      from: "merged",
      to: "merged",
      error: "[release:tag-mismatch] the tag names another commit",
    });
    expect(ok.status).toBe(200);
    expect(ok.body.repull).toMatchObject({
      status: "merged",
      last_error: "[release:tag-mismatch] the tag names another commit",
    });
  });
});

// ----------------------------------------------------------------------------
// The dataset fences on every step past prepared
// ----------------------------------------------------------------------------

describe("every step past prepared re-reads the dataset fences", () => {
  /** The steps that move a record past prepared and keep it open, with what each sends. */
  const steps: Array<[RepullStatus, RepullStatus, Record<string, unknown>]> = [
    ["prepared", "copied", { counts: { copied: 1 } }],
    ["copied", "registered", {}],
    ["registered", "pr_open", PR],
    ["pr_open", "pr_open", { ...PR, head_sha: OTHER }],
    ["gates_clear", "pr_open", { ...PR, head_sha: OTHER }],
    ["released", "released", { counts: { locked: 3 } }],
  ];

  const fences: Array<[string, MirrorSeed, string]> = [
    ["anonymous", { anonymous: true }, "anonymous-dataset"],
    ["withdrawn", { withdrawn: true }, "withdrawn"],
    ["an import in flight", { importStatus: "copying" }, "import-in-flight"],
    ["no longer a mirror", { source: "nemar" }, "not-a-mirror"],
  ];

  for (const [what, seed, code] of fences) {
    test(`a dataset that is ${what} stops each of them, and nothing is written`, async () => {
      seedMirror(seed);
      for (const [from, to, fields] of steps) {
        db.run("DELETE FROM upstream_repulls");
        const id = seedAt(from);
        const before = rowOf(id);
        const res = await move(id, { from, to, fields });
        expect([`${from}>${to}`, res.status, res.body.code]).toEqual([`${from}>${to}`, 409, code]);
        expect(rowOf(id)).toEqual(before);
      }
      // An error does not carry a moved head past the fence.
      db.run("DELETE FROM upstream_repulls");
      const id = seedRepull("pr_open");
      const moved = await move(id, {
        from: "pr_open",
        to: "pr_open",
        fields: { ...PR, head_sha: OTHER },
        error: "[gates:screen-pending] the screen has not reported",
      });
      expect([moved.status, moved.body.code]).toEqual([409, code]);
      // Nor a count.
      db.run("DELETE FROM upstream_repulls");
      const released = seedRepull("released", { counts: WROTE(1) });
      const counted = await move(released, {
        from: "released",
        to: "released",
        fields: { counts: { locked: 1 } },
        error: "[lock:lock-incomplete] 1 object(s) were not locked",
      });
      expect([counted.status, counted.body.code]).toEqual([409, code]);
    });
  }

  test("a mirror that holds every fence lets each step through", async () => {
    seedMirror();
    for (const [from, to, fields] of steps) {
      db.run("DELETE FROM upstream_repulls");
      const id = seedAt(from);
      const res = await move(id, { from, to, fields });
      expect([`${from}>${to}`, res.status]).toEqual([`${from}>${to}`, 200]);
    }
  });

  test("giving up, recording why a step failed and preparing are not held to them", async () => {
    seedMirror({ anonymous: true, withdrawn: true });
    const cases: Array<[RepullStatus, RepullStatus, Record<string, unknown>]> = [
      ["pr_open", "abandoned", {}],
      ["copied", "failed", { error: "[copy:pin-absent] a pinned object is gone" }],
      ["released", "patch_declined", {}],
      ["copied", "copied", { error: "[register:held-key-absent] 1 key has no object" }],
      ["registered", "registered", { error: "[pr:push-failed] the push failed" }],
      ["merged", "merged", { error: "[release:tag-missing] no tag yet" }],
      ["released", "released", { error: "[lock:lock-incomplete] 2 object(s) were not locked" }],
      // The stage's own facts, as stored, with why the step after it failed.
      ["pr_open", "pr_open", { fields: PR, error: "[gates:head-foreign] the head is not ours" }],
    ];
    for (const [from, to, extra] of cases) {
      db.run("DELETE FROM upstream_repulls");
      const id = seedRepull(from);
      const res = await move(id, { from, to, ...extra });
      expect([`${from}>${to}`, res.status]).toEqual([`${from}>${to}`, 200]);
    }
    // A preparation is the create's, and the create already applied the fences.
    db.run("DELETE FROM upstream_repulls");
    const planned = seedRepull("planned");
    const prepared = await move(planned, {
      from: "planned",
      to: "prepared",
      fields: { synth_tree: HEAD, synth_sha: HEAD, manifest_digest: `sha256:${"0".repeat(64)}` },
    });
    expect(prepared.status).toBe(200);
  });

  test("a merge that happened is recorded whatever the dataset has become", async () => {
    seedMirror({ withdrawn: true });
    const id = seedRepull("gates_clear");
    gh.pulls[`${DATASET}#7`] = { merged: true };
    const res = await call(`/repulls/${id}/merged`, { pr: "n0" });
    expect(res.status).toBe(200);
    expect(res.body.repull.status).toBe("merged");
  });

  test("the fenced steps are exactly the open statuses after prepared", () => {
    const open = REPULL_STATUSES.filter(
      (s) => !["complete", "abandoned", "failed", "superseded", "patch_declined"].includes(s),
    );
    expect(open.slice(open.indexOf("prepared") + 1)).toEqual([
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
    ]);
  });
});

// ----------------------------------------------------------------------------
// The lock at released
// ----------------------------------------------------------------------------

describe("a released N.0.0 locks its objects before it goes on", () => {
  test("complete and N.0.1 are refused until the locked count is recorded; giving up is not", async () => {
    seedMirror();
    const id = seedRepull("released", { counts: WROTE(2, 1, 1) });
    const before = rowOf(id);
    const done = await move(id, { from: "released", to: "complete" });
    expect([done.status, done.body.code]).toEqual([409, "lock-unrecorded"]);
    const patch = await move(id, {
      from: "released",
      to: "patch_synthesized",
      fields: {
        patch_version: "2.0.1",
        patch_branch: "release/v2.0.1",
        patch_pr_number: 9,
        patch_head_sha: HEAD,
        patch_base_sha: HEAD,
      },
    });
    expect([patch.status, patch.body.code]).toEqual([409, "lock-unrecorded"]);
    expect(rowOf(id)).toEqual(before);

    expect(
      (await move(id, { from: "released", to: "released", fields: { counts: { locked: 4 } } }))
        .status,
    ).toBe(200);
    const complete = await move(id, { from: "released", to: "complete" });
    expect(complete.status).toBe(200);
    expect(complete.body.repull).toMatchObject({ status: "complete", counts: { locked: 4 } });

    db.run("DELETE FROM upstream_repulls");
    const other = seedRepull("released");
    const failed = await move(other, {
      from: "released",
      to: "failed",
      error: "[lock:lock-failed] the lock could not be applied",
    });
    expect(failed.status).toBe(200);
  });

  test("a count below what the copy and uploads wrote is refused, a zero one included", async () => {
    seedMirror();
    const id = seedRepull("released", { counts: WROTE(2, 1, 1) });
    const before = rowOf(id);
    for (const locked of [0, 3]) {
      const res = await move(id, {
        from: "released",
        to: "released",
        fields: { counts: { locked } },
      });
      expect([locked, res.status, res.body.code]).toEqual([locked, 409, "lock-incomplete"]);
    }
    expect(rowOf(id)).toEqual(before);
    // A record that does not say what its copy wrote accepts no count: unknown is never zero.
    db.run("DELETE FROM upstream_repulls");
    const unknown = seedRepull("released");
    const res = await move(unknown, {
      from: "released",
      to: "released",
      fields: { counts: { locked: 9 } },
    });
    expect([res.status, res.body.code]).toEqual([409, "lock-incomplete"]);
    // A re-pull that copied nothing (metadata only) records zero locked objects.
    db.run("DELETE FROM upstream_repulls");
    const none = seedRepull("released", { counts: WROTE(0, 0, 0) });
    expect(
      (await move(none, { from: "released", to: "released", fields: { counts: { locked: 0 } } }))
        .status,
    ).toBe(200);
  });

  test("the released self-edge carries the count or why the lock did not complete, and the count clears that", async () => {
    seedMirror();
    const id = seedRepull("released", { counts: WROTE(5) });
    const neither = await move(id, { from: "released", to: "released" });
    expect([neither.status, neither.body.code]).toEqual([400, "field-missing"]);
    const failedLock = await move(id, {
      from: "released",
      to: "released",
      error: "[lock:lock-incomplete] 2 object(s) were not locked",
    });
    expect(failedLock.body.repull).toMatchObject({
      status: "released",
      last_error: "[lock:lock-incomplete] 2 object(s) were not locked",
    });
    expect(JSON.parse(rowOf(id).counts as string).locked).toBeUndefined();
    const locked = await move(id, {
      from: "released",
      to: "released",
      fields: { counts: { locked: 5 } },
    });
    expect(locked.body.repull).toMatchObject({ last_error: null, counts: { locked: 5 } });
  });
});

// ----------------------------------------------------------------------------
// A stuck claim expires
// ----------------------------------------------------------------------------

describe("a stuck claim expires", () => {
  const release = (id: number, outcome: string) =>
    call(`/repulls/${id}/merge-claim/release`, { pr: "n0", sha: HEAD, outcome });

  function heldClaim(minutesAgo: number): number {
    seedMirror();
    const id = seedRepull("gates_clear");
    db.run(
      `UPDATE upstream_repulls SET merge_claimed_at = datetime('now', '-${minutesAgo} minutes'),
         merge_claim_sha = ? WHERE id = ?`,
      [HEAD, id],
    );
    return id;
  }

  test("only once it is thirty minutes old, and GitHub is not read before then", async () => {
    expect(CLAIM_EXPIRE_MIN_AGE_MINUTES).toBeGreaterThan(CLAIM_RELEASE_MIN_AGE_MINUTES);
    const id = heldClaim(CLAIM_EXPIRE_MIN_AGE_MINUTES - 1);
    gh.requests = [];
    const young = await release(id, "expired");
    expect([young.status, young.body.code]).toEqual([409, "claim-too-recent"]);
    expect(gh.requests).toEqual([]);
    // Old enough for a caller that knows its merge was not sent, not for one that does not know.
    expect(rowOf(id).merge_claim_sha).toBe(HEAD);
    db.run(
      "UPDATE upstream_repulls SET merge_claimed_at = datetime(merge_claimed_at, '-2 minutes')",
    );
    gh.pulls[`${DATASET}#7`] = { merged: false };
    const ok = await release(id, "expired");
    expect(ok.status).toBe(200);
    expect(ok.body.repull).toMatchObject({ merge_claimed_at: null, merge_claim_sha: null });
    const audit = db
      .query("SELECT details FROM audit_log WHERE action = 'repull_merge_claim_released'")
      .get() as Row;
    expect(JSON.parse(audit.details as string)).toMatchObject({ outcome: "expired" });
  });

  test("a claim whose pull request merged does not expire, and the merge is then recorded", async () => {
    const id = heldClaim(CLAIM_EXPIRE_MIN_AGE_MINUTES + 5);
    gh.pulls[`${DATASET}#7`] = { merged: true };
    const res = await release(id, "expired");
    expect([res.status, res.body.code]).toEqual([409, "pull-request-merged"]);
    expect(rowOf(id).merge_claim_sha).toBe(HEAD);
    const merged = await call(`/repulls/${id}/merged`, { pr: "n0" });
    expect(merged.body).toMatchObject({ merged_outside_tool: false, repull: { status: "merged" } });
  });
});
