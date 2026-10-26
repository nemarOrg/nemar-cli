/**
 * The claim to merge over a failed BIDS validation (ADR 0111, the Phase 7g amendment; epic #1046
 * phase 7, #1913), through its real entry point: `POST /admin/repulls/:id/transition`, the claim's
 * self-edge with `override: { kind: "bids-failure", reason }`, with the real auth and admin
 * middleware, the real routes and services over bun:sqlite with every migration applied, and the
 * shared `Bun.serve()` stand-in for api.github.com (`helpers/repull-github-standin.ts`) answering
 * the pull request and its check runs. The CLI's side, the gate and the merge, is
 * `test/repull-merge-bids-override-cli.test.ts`.
 *
 * The properties, each with a test that fails when its line is changed:
 *  - the claim is recorded, with its reason in an audit row of its own, only for an administrator's
 *    record whose head GitHub reports `unstable`, BIDS validation completed with `failure` and
 *    `version-check` with `success`, the App's own runs at the claimed head;
 *  - `blocked`, any other state, a validation not failed, a `version-check` not passed, unreadable
 *    checks and an automatic record are each refused, and nothing is written;
 *  - the claim's own checks are unchanged (the screen, the cap), the override is named only on a
 *    claim, its reason follows the publication path's rule, and a caller that gives no reader of
 *    the facts is refused.
 */

import type { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { parseScreenReport } from "../../shared/identifier-screen-report";
import { NEMAR_APP_BOT_LOGIN, NEMAR_APP_BOT_USER_ID, NEMAR_APP_ID } from "../../shared/nemar-app";
import { adminMiddleware, authMiddleware } from "../src/middleware/auth";
import { registerUpstreamRepullRoutes } from "../src/routes/admin/upstream-repulls";
import { __resetRateLimitStateForTests } from "../src/services/github/transport";
import { hashApiKey } from "../src/services/token";
import { isRefusal, transitionRepull } from "../src/services/upstream-repull";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";
import {
  type CheckRunAnswer,
  type RepullGitHub,
  startRepullGitHub,
} from "./helpers/repull-github-standin";
import { type Row, rowAt } from "./helpers/repull-rows";
import { type CapturedEmail, withFakeResend } from "./helpers/resend";

const ADMIN_KEY = "bids-override-admin-key-0123456789abcdef0123456789a";
const DS = "on098831";
const HEAD = "0123456789abcdef0123456789abcdef01234567";
const REASON = "The validator flags a sidecar upstream ships this way; read and accepted.";

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
  gh = startRepullGitHub();
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
     VALUES ('bidsadmin', 'bidsadmin@example.org', 'x', 'approved', 'admin', 1)`,
  );
  adminId = (db.query("SELECT id FROM users WHERE username = 'bidsadmin'").get() as { id: number })
    .id;
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
    GITHUB_ADMIN_PAT: "ghp_bids_override_test",
    RESEND_API_KEY: "re_test",
    FROM_EMAIL: "NEMAR <noreply@nemar.org>",
    ...over,
  } as Bindings;
}

async function call(path: string, body: unknown, over: Partial<Bindings> = {}) {
  const res = await app.request(
    path,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${ADMIN_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    env(over),
  );
  return { status: res.status, body: (await res.json()) as Json };
}

/** An administrator's record of a mirror at gates_clear, its head HEAD screened clean. */
function ready(over: Row = {}): number {
  db.run(
    `INSERT INTO datasets (dataset_id, name, owner_user_id, source, source_id, anonymous)
     VALUES (?, ?, ?, 'openneuro', ?, 0)`,
    [DS, DS, adminId, `ds${DS.slice(2)}`],
  );
  const row = rowAt("gates_clear", {
    dataset_id: DS,
    upstream_ds: `ds${DS.slice(2)}`,
    actor_user_id: adminId,
    head_sha: HEAD,
    gates_sha: HEAD,
    ...over,
  });
  const cols = Object.keys(row);
  const id = Number(
    db
      .query(
        `INSERT INTO upstream_repulls (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
      )
      .run(...(cols.map((c) => row[c]) as never[])).lastInsertRowid,
  );
  const report = parseScreenReport({
    version: 1,
    scanner: "identifier-scan@abcdef1",
    head: HEAD,
    scan: {
      id: DS,
      version: null,
      scanned_at: "2026-10-24T12:00:00.000Z",
      manifest_source: "clone",
      status: "clean",
      incomplete: false,
      incomplete_reasons: [],
      files: { total: 10, edf_bdf: 4, header_read: 4, header_read_failed: 0 },
    },
  });
  db.run(
    `INSERT INTO upstream_repull_screens (repull_id, pr, sha, status, report, reported_at)
     VALUES (?, 'n0', ?, 'clean', ?, datetime('now'))`,
    [id, HEAD, JSON.stringify(report)],
  );
  return id;
}

const run = (name: string, status: string, conclusion: string | null, app = NEMAR_APP_ID) =>
  ({ id: name.length, name, status, conclusion, app_id: app }) as CheckRunAnswer;

/** GitHub as it is for a pull request whose BIDS validation failed and is not required. */
function github(
  o: {
    state?: string | null;
    bids?: CheckRunAnswer;
    versionCheck?: CheckRunAnswer;
    /** The head repository's name, or null for a deleted fork; the dataset's own by default. */
    headRepo?: string | null;
    baseRepo?: string;
  } = {},
) {
  const headRepo = o.headRepo === undefined ? `nemarDatasets/${DS}` : o.headRepo;
  gh.pulls[`${DS}#7`] = {
    state: "open",
    draft: false,
    merged: false,
    user: { login: NEMAR_APP_BOT_LOGIN, id: NEMAR_APP_BOT_USER_ID, type: "Bot" },
    head: {
      sha: HEAD,
      ref: "release/v2.0.0",
      repo: headRepo === null ? null : { full_name: headRepo },
    },
    base: { ref: "main", repo: { full_name: o.baseRepo ?? `nemarDatasets/${DS}` } },
    mergeable_state: o.state === undefined ? "unstable" : o.state,
  };
  gh.checkRuns[`${DS}@${HEAD}`] = [
    o.bids ?? run("Run BIDS Validation", "completed", "failure"),
    o.versionCheck ?? run("version-check", "completed", "success"),
  ];
}

const CLAIM = {
  from: "gates_clear",
  to: "gates_clear",
  fields: { merge_claim_sha: HEAD },
  override: { kind: "bids-failure", reason: REASON },
};
const claim = (id: number, body: Json = CLAIM, over: Partial<Bindings> = {}) =>
  call(`/repulls/${id}/transition`, body, over);

const rowOf = (id: number) =>
  db.query("SELECT * FROM upstream_repulls WHERE id = ?").get(id) as Row;
const overrides = () =>
  db.query("SELECT * FROM audit_log WHERE action = 'repull_bids_override'").all() as Row[];

describe("the claim over a failed BIDS validation", () => {
  test("recorded, with the reason in an audit row of its own, by the administrator", async () => {
    const id = ready();
    github();
    const res = await claim(id);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(rowOf(id)).toMatchObject({ merge_claim_sha: HEAD });
    const [audit] = overrides();
    expect(overrides()).toHaveLength(1);
    expect(audit).toMatchObject({ user_id: adminId, resource_id: String(id) });
    expect(JSON.parse(String(audit?.details))).toEqual({
      dataset_id: DS,
      pr: "n0",
      sha: HEAD,
      reason: REASON,
      bids_validation: "failure",
      version_check: "success",
      mergeable_state: "unstable",
    });
  });

  const refusals: Array<[string, () => void, number, string, Row?]> = [
    [
      "the head is a fork's",
      () => github({ headRepo: `someone/${DS}` }),
      409,
      "pull-request-mismatch",
    ],
    [
      "the head is a deleted fork's",
      () => github({ headRepo: null }),
      409,
      "pull-request-mismatch",
    ],
    [
      "the base is another repository",
      () => github({ baseRepo: `someone/${DS}` }),
      409,
      "pull-request-mismatch",
    ],
    ["GitHub reports it blocked", () => github({ state: "blocked" }), 409, "bids-override-blocked"],
    [
      "GitHub reports it clean",
      () => github({ state: "clean" }),
      409,
      "bids-override-not-unstable",
    ],
    ["GitHub has no state yet", () => github({ state: null }), 409, "bids-override-not-unstable"],
    [
      "BIDS validation is still running",
      () => github({ bids: run("Run BIDS Validation", "in_progress", null) }),
      409,
      "bids-override-bids",
    ],
    [
      "BIDS validation passed",
      () => github({ bids: run("Run BIDS Validation", "completed", "success") }),
      409,
      "bids-override-bids",
    ],
    [
      "the failed BIDS validation is another App's",
      () => github({ bids: run("Run BIDS Validation", "completed", "failure", 42) }),
      409,
      "bids-override-bids",
    ],
    [
      "version-check failed",
      () => github({ versionCheck: run("version-check", "completed", "failure") }),
      409,
      "bids-override-version-check",
    ],
    [
      "the checks cannot be read",
      () => {
        github();
        gh.checkRuns[`${DS}@${HEAD}`] = 500;
      },
      502,
      "github-unreadable",
    ],
    [
      "the record is the automatic path's",
      () => github(),
      409,
      "bids-override-automatic",
      { origin: "automatic" },
    ],
  ];

  for (const [name, flip, status, code, over] of refusals) {
    test(`${name}: ${code}, and nothing is written`, async () => {
      const id = ready(over ?? {});
      flip();
      const res = await claim(id);
      expect([res.status, res.body.code]).toEqual([status, code]);
      expect(rowOf(id)).toMatchObject({ merge_claim_sha: null, merge_claimed_at: null });
      expect(overrides()).toEqual([]);
      expect(gh.merges).toEqual([]);
    });
  }

  test("the dataset's own repository named in another case is its own: GitHub's names have no case", async () => {
    const id = ready();
    github({ headRepo: `NemarDatasets/${DS.toUpperCase()}`, baseRepo: `NEMARDATASETS/${DS}` });
    const res = await claim(id);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(rowOf(id)).toMatchObject({ merge_claim_sha: HEAD });
  });
});

describe("the claim's own checks stand, and the override is named only where it is read", () => {
  test("a screen that does not pass for this administrator is refused as any claim is", async () => {
    const id = ready();
    github();
    db.run("UPDATE upstream_repull_screens SET status = 'review'");
    const res = await claim(id);
    expect([res.status, res.body.code]).toEqual([409, "screen-not-clear"]);
    expect(overrides()).toEqual([]);
  });

  test("a day's cap that is used writes neither the claim nor its reason", async () => {
    const id = ready();
    github();
    const res = await claim(id, CLAIM, { REPULL_DAILY_MERGE_CAP: "0" });
    expect([res.status, res.body.code]).toEqual([429, "merge-cap"]);
    expect(rowOf(id)).toMatchObject({ merge_claim_sha: null });
    expect(overrides()).toEqual([]);
  });

  test("a claim its own statement refuses (the day's last unit taken) writes no reason either", async () => {
    const id = ready();
    github();
    // Another record's claim of today takes the one unit, which the claim counts in its statement.
    db.run(
      `INSERT INTO upstream_repulls (dataset_id, upstream_ds, from_tag, to_tag, attempt, from_version,
         to_version, plan_digest, planner, origin, actor_user_id, status, base_sha, synth_tree,
         synth_sha, manifest_digest, branch, pr_number, head_sha, gates_sha, merge_claim_sha,
         merge_claimed_at)
       SELECT 'on098832', upstream_ds, from_tag, to_tag, 1, from_version, to_version, plan_digest,
         planner, origin, actor_user_id, 'gates_clear', base_sha, synth_tree, synth_sha,
         manifest_digest, branch, pr_number, head_sha, gates_sha, gates_sha, datetime('now')
       FROM upstream_repulls WHERE id = ?`,
      [id],
    );
    const res = await claim(id, CLAIM, { REPULL_DAILY_MERGE_CAP: "1" });
    expect([res.status, res.body.code]).toEqual([429, "merge-cap"]);
    expect(rowOf(id)).toMatchObject({ merge_claim_sha: null });
    expect(overrides()).toEqual([]);
  });

  test("on an edge that is not a claim it is refused", async () => {
    const id = ready({ status: "pr_open", gates_sha: null });
    github();
    const res = await claim(id, {
      ...CLAIM,
      from: "pr_open",
      to: "gates_clear",
      fields: { gates_sha: HEAD },
    });
    expect([res.status, res.body.code]).toEqual([400, "field-not-allowed"]);
  });

  for (const reason of ["too short", "x".repeat(501)]) {
    test(`a reason of ${reason.length} characters is refused`, async () => {
      const id = ready();
      github();
      const res = await claim(id, { ...CLAIM, override: { kind: "bids-failure", reason } });
      expect([res.status, res.body.code]).toEqual([400, "invalid-body"]);
      expect(overrides()).toEqual([]);
    });
  }

  test("a caller that gives no reader of the facts is refused, so nothing takes it unchecked", async () => {
    const id = ready();
    github();
    const res = await transitionRepull(env(), { id: adminId }, id, {
      from: "gates_clear",
      to: "gates_clear",
      fields: { merge_claim_sha: HEAD },
      override: { kind: "bids-failure", reason: REASON },
    });
    expect(isRefusal(res) ? res.code : "applied").toBe("bids-override-unverified");
    expect(rowOf(id)).toMatchObject({ merge_claim_sha: null });
    expect(overrides()).toEqual([]);
  });
});
