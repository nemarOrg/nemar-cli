/**
 * The Worker's merge of an automatic re-pull (epic #1046 phase 7, #1913; ADR 0111, decisions 6 and
 * 7, and its Phase 7g amendment), through the production 30-minute tick's real entry point,
 * `runRepullAdvanceCron`, and through `workerMergeRepull` itself where a property is about one call.
 *
 * Real engine only: bun:sqlite behind realD1 with every migration applied, the real record, its
 * claim to merge (the record's own statement, which counts the day's cap), the machine-clean facts
 * and rule, the screen bound to the row, the review rows and the verified route that records the
 * merge. A `Bun.serve()` stand-in for api.github.com (`helpers/repull-github-standin.ts`, through
 * NEMAR_GITHUB_API_URL) answers the pull request, `main`, the check runs and the merge, and records
 * each request with the token it carried; no dataset id here is asked of the real GitHub, whose
 * organization is shared with production. The happy paths run against the stand-in too, so what
 * GitHub itself answers (the App token's reading of `mergeable_state`, a squash merge with `sha`)
 * is checked only by the first production merge, under a cap of 1. The Resend capture is armed
 * around every test and must stay empty.
 *
 * The properties, each with a test that fails when its line is changed:
 *  - a machine-clean row is merged once, by squash, at the screened head, with the gate's message,
 *    and only after its claim and its audit row are written; the merge is recorded;
 *  - the merge switch, the cap, the bound and every fact that is not clean (an unknown one
 *    included) each hold before anything is claimed or sent;
 *  - an administrator's row is never merged, and nothing outside exact production is read;
 *  - GitHub's refusal and an answer that was lost each keep the claim, under their own words.
 */

import type { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { parseScreenReport } from "../../shared/identifier-screen-report";
import { NEMAR_APP_BOT_LOGIN, NEMAR_APP_BOT_USER_ID, NEMAR_APP_ID } from "../../shared/nemar-app";
import { repullSquashMessage, repullTrailerLines } from "../../shared/repull-squash";
import type { RepullStatus } from "../../shared/repull-state";
import { SYSTEM_USER_ID } from "../src/lib/constants";
import { __resetRateLimitStateForTests } from "../src/services/github/transport";
import { MERGE_CLAIMS_TODAY_SQL, getRepull } from "../src/services/upstream-repull";
import {
  type AdvanceTickResult,
  runRepullAdvanceCron,
} from "../src/services/upstream-repull-advance";
import {
  WORKER_MERGES_MAX,
  WORKER_MERGE_ACTION,
  WORKER_MERGE_ANSWER_ACTION,
  WORKER_MERGE_SENT_SQL,
  __setWorkerMergeTimeoutForTests,
  workerMergeRepull,
} from "../src/services/upstream-repull-merge";
import type { Bindings } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";
import { seedReview } from "./helpers/pr-queue-fixtures";
import {
  type CheckRunAnswer,
  type PullAnswer,
  type RepullGitHub,
  STANDIN_MERGE_SHA,
  startRepullGitHub,
} from "./helpers/repull-github-standin";
import { type Row, rowAt } from "./helpers/repull-rows";
import { type CapturedEmail, withFakeResend } from "./helpers/resend";

const DS = "on098811";
const HEAD = "0123456789abcdef0123456789abcdef01234567";
const BASE = "89abcdef0123456789abcdef0123456789abcdef";
const OTHER = "fedcba9876543210fedcba9876543210fedcba98";
const PAT = "ghp_repull_worker_merge_test";

let gh: RepullGitHub;
let db: Database;
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
  db.run(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified)
     VALUES ('mergeadmin', 'mergeadmin@example.org', 'x', 'approved', 'admin', 1)`,
  );
  adminId = (db.query("SELECT id FROM users WHERE username = 'mergeadmin'").get() as { id: number })
    .id;
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
  gh.reset();
  __setWorkerMergeTimeoutForTests(null);
});

/** Production, both switches on, a callback secret and the datasets token, unless overridden. */
function env(over: Record<string, string | undefined> = {}, d1?: D1Database): Bindings {
  const bindings: Record<string, unknown> = {
    DB: d1 ?? realD1(db),
    ENVIRONMENT: "production",
    AUTO_REPULL_ENABLED: "1",
    AUTO_REPULL_MERGE_ENABLED: "1",
    PRESCREEN_CALLBACK_SECRET: "repull-worker-merge-callback-secret",
    API_BASE_URL: "https://api.test.nemar.org",
    GITHUB_ADMIN_PAT: PAT,
    RESEND_API_KEY: "re_test",
    FROM_EMAIL: "NEMAR <noreply@nemar.org>",
  };
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) delete bindings[k];
    else bindings[k] = v;
  }
  return bindings as unknown as Bindings;
}

const CLI = "1.2.3";
const tick = (e: Bindings = env()) =>
  runRepullAdvanceCron(e, { cliVersion: CLI }) as Promise<AdvanceTickResult>;

// ----------------------------------------------------------------------------
// Seeding
// ----------------------------------------------------------------------------

/** A named, published mirror of `ds<id digits>`. */
function mirror(ds: string): void {
  db.run(
    `INSERT INTO datasets (dataset_id, name, owner_user_id, source, source_id, anonymous, status,
                           visibility, github_repo, first_published_at)
     VALUES (?, ?, ?, 'openneuro', ?, 0, 'active', 'public', ?, '2026-01-01 00:00:00')`,
    [
      ds,
      `A sufficiently descriptive title for ${ds}`,
      adminId,
      `ds${ds.slice(2)}`,
      `nemarDatasets/${ds}`,
    ],
  );
}

/** An automatic record of `ds` at `status`, its head and screened head HEAD on BASE, pull request #7. */
function seedRow(ds: string, status: RepullStatus, over: Row = {}): number {
  const row = rowAt(status, {
    dataset_id: ds,
    upstream_ds: `ds${ds.slice(2)}`,
    origin: "automatic",
    planner: 2,
    actor_user_id: adminId,
    head_sha: HEAD,
    base_sha: BASE,
    ...(status === "gates_clear" ? { gates_sha: HEAD } : {}),
    counts: JSON.stringify({
      unexplained: 0,
      conflicts: 0,
      corrections: 0,
      copy_bytes: 1024,
      copied: 3,
      skipped: 0,
      local_uploads: 1,
    }),
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

/** The App's pull request #7 of `ds` at HEAD, open and clean, from the release branch into main. */
function appPull(ds: string, over: Partial<PullAnswer> = {}): PullAnswer {
  return {
    state: "open",
    draft: false,
    merged: false,
    title: "Release v2.0.0",
    user: { login: NEMAR_APP_BOT_LOGIN, id: NEMAR_APP_BOT_USER_ID, type: "Bot" },
    head: { sha: HEAD, ref: "release/v2.0.0", repo: { full_name: `nemarDatasets/${ds}` } },
    base: {
      ref: "main",
      repo: { full_name: `nemarDatasets/${ds}`, name: ds, owner: { login: "nemarDatasets" } },
    },
    mergeable_state: "clean",
    ...over,
  };
}

const BIDS_RUN: CheckRunAnswer = {
  id: 20,
  name: "Run BIDS Validation",
  status: "completed",
  conclusion: "success",
  app_id: NEMAR_APP_ID,
};
const VERSION_RUN: CheckRunAnswer = {
  id: 21,
  name: "version-check",
  status: "completed",
  conclusion: "success",
  app_id: NEMAR_APP_ID,
};

/** GitHub as it is for a clean automatic pull request of `ds`. */
function githubClean(ds: string): void {
  gh.pulls[`${ds}#7`] = appPull(ds);
  gh.mainRefs[ds] = BASE;
  gh.checkRuns[`${ds}@${HEAD}`] = [{ ...BIDS_RUN }, { ...VERSION_RUN }];
}

/** The screen of HEAD of re-pull `id`, stored clean (or with `status`) as its callback leaves it. */
function markScreen(id: number, ds: string, status = "clean"): void {
  db.run("DELETE FROM upstream_repull_screens WHERE repull_id = ?", [id]);
  const report = parseScreenReport({
    version: 1,
    scanner: "identifier-scan@abcdef1",
    head: HEAD,
    scan: {
      id: ds,
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
     VALUES (?, 'n0', ?, ?, ?, datetime('now'))`,
    [id, HEAD, status, JSON.stringify(report)],
  );
}

/** An ADR 0107 review of HEAD of `ds`'s pull request #7, reported with `verdict`. */
function review(ds: string, verdict: "pass" | "fail" = "pass"): void {
  db.run("DELETE FROM pr_reviews WHERE dataset_id = ?", [ds]);
  seedReview(db, {
    ds,
    n: 7,
    sha: HEAD,
    state: "reported",
    verdict,
    login: NEMAR_APP_BOT_LOGIN,
    authorId: NEMAR_APP_BOT_USER_ID,
  });
}

/** A mirror with a machine-clean automatic re-pull at gates_clear: the record's id. */
function ready(ds: string = DS, over: Row = {}): number {
  mirror(ds);
  githubClean(ds);
  const id = seedRow(ds, "gates_clear", over);
  markScreen(id, ds);
  review(ds);
  return id;
}

type DbRow = Record<string, string | number | null>;
const rowOf = (id: number) =>
  db.query("SELECT * FROM upstream_repulls WHERE id = ?").get(id) as DbRow;

const auditsOf = (action: string, id: number) =>
  (
    db
      .query("SELECT * FROM audit_log WHERE action = ? AND resource_id = ? ORDER BY id")
      .all(action, String(id)) as DbRow[]
  ).map((a) => ({ ...a, details: JSON.parse(String(a.details)) as Record<string, unknown> }));

const usedToday = () => (db.query(MERGE_CLAIMS_TODAY_SQL).get() as { used: number }).used;

const datasetRequests = (ds: string = DS) => gh.requests.filter((r) => r.includes(`/${ds}/`));

const mergeTo = (ds: string = DS) =>
  gh.merges.filter((m) => m.path === `/repos/nemarDatasets/${ds}/pulls/7/merge`);

// ----------------------------------------------------------------------------
// The merge
// ----------------------------------------------------------------------------

describe("a machine-clean automatic re-pull is merged by the Worker", () => {
  test("one squash merge at the screened head, after its claim and its audit row, and recorded", async () => {
    const id = ready();
    // What the database holds when GitHub receives the merge.
    let atMerge: { claim: unknown; claimedAt: unknown; audits: number } | null = null;
    gh.beforeMerge = () => {
      const r = rowOf(id);
      atMerge = {
        claim: r.merge_claim_sha,
        claimedAt: r.merge_claimed_at,
        audits: auditsOf(WORKER_MERGE_ACTION, id).length,
      };
    };

    const r = await tick();
    expect(r).toMatchObject({
      examined: 1,
      mergesSent: 1,
      merged: 1,
      mergeUnknown: 0,
      refused: {},
    });

    // The claim and the merge's own audit row were written before the merge arrived.
    expect(atMerge as unknown).toEqual({ claim: HEAD, claimedAt: expect.any(String), audits: 1 });
    const sent = mergeTo();
    expect(sent).toHaveLength(1);
    const squash = repullSquashMessage({ ...(rowOf(id) as never), counts: {} }, 7, "n0", "worker");
    expect(sent[0]?.body).toEqual({
      sha: HEAD,
      merge_method: "squash",
      commit_title: "Release v2.0.0 (#7)",
      commit_message: squash.message,
    });
    // The Worker's own credential; and no review is submitted, by any token.
    expect(sent[0]?.token).toBe(PAT);
    expect(gh.requests.filter((q) => q.includes("/reviews"))).toEqual([]);

    // Recorded through the verified route: GitHub's merge commit, the claim the Worker held.
    const after = rowOf(id);
    expect(after).toMatchObject({
      status: "merged",
      merge_sha: STANDIN_MERGE_SHA,
      merge_claim_sha: HEAD,
      hold_reason: null,
    });
    expect(JSON.parse(String(after.counts))).not.toHaveProperty("merged_outside_tool");
    expect(JSON.parse(String(after.counts))).not.toHaveProperty("merged_unscreened_head");

    // The audit trail: the claim and the merge by the system user, one merge sent, merged.
    const edges = auditsOf("repull_transition", id).map((a) => ({
      user: a.user_id,
      from: a.details.from,
      to: a.details.to,
      worker: a.details.worker_merge ?? null,
    }));
    expect(edges).toEqual([
      { user: SYSTEM_USER_ID, from: "gates_clear", to: "gates_clear", worker: true },
      { user: SYSTEM_USER_ID, from: "gates_clear", to: "merged", worker: null },
    ]);
    expect(auditsOf(WORKER_MERGE_ACTION, id).map((a) => a.details)).toEqual([
      { dataset_id: DS, pr: "n0", sha: HEAD, claimed_at: after.merge_claimed_at, attempt: 1 },
    ]);
    expect(auditsOf(WORKER_MERGE_ANSWER_ACTION, id).map((a) => a.details)).toEqual([
      {
        dataset_id: DS,
        pr: "n0",
        sha: HEAD,
        claimed_at: after.merge_claimed_at,
        attempt: 1,
        outcome: "merged",
        status: 200,
      },
    ]);
    // One unit of today's cap.
    expect(usedToday()).toBe(1);
  });

  test("the message's last paragraph is exactly the re-pull commit's two trailers", async () => {
    const id = ready();
    await tick();
    const message = String(mergeTo()[0]?.body.commit_message);
    const paragraphs = message.split("\n\n");
    expect(paragraphs[paragraphs.length - 1]?.split("\n")).toEqual(
      repullTrailerLines(rowOf(id) as never),
    );
    expect(paragraphs[0]).toContain(
      "squash-merged by the Worker as a machine-clean automatic re-pull",
    );
  });

  test("a merge the second tick finds recorded is not sent again", async () => {
    ready();
    await tick();
    gh.requests = [];
    const again = await tick();
    expect(again).toMatchObject({ examined: 0, mergesSent: 0 });
    expect(mergeTo()).toHaveLength(1);
  });
});

describe("the switches, the cap and the bound hold before anything is claimed or sent", () => {
  for (const value of [undefined, "true", "0", " 1", ""]) {
    test(`AUTO_REPULL_MERGE_ENABLED=${JSON.stringify(value)}: merge-switch-off, and nothing is read`, async () => {
      const id = ready();
      // Every statement the tick prepares, to show the merge reads nothing of its own.
      const prepared: string[] = [];
      const base = realD1(db);
      const counting = {
        prepare(sql: string) {
          prepared.push(sql);
          return base.prepare(sql);
        },
        batch: (s: never[]) => base.batch(s),
      } as unknown as D1Database;
      const r = await tick(env({ AUTO_REPULL_MERGE_ENABLED: value }, counting));
      expect(r).toMatchObject({ examined: 1, mergesSent: 0, held: { "merge-switch-off": 1 } });
      expect(rowOf(id)).toMatchObject({ hold_reason: "merge-switch-off", merge_claim_sha: null });
      expect(datasetRequests()).toEqual([]);
      expect(usedToday()).toBe(0);
      expect(prepared.filter((s) => s.includes(WORKER_MERGE_ACTION))).toEqual([]);
    });
  }

  test("the merge switch alone does nothing: the open switch off is switch-off", async () => {
    const id = ready();
    await tick(env({ AUTO_REPULL_ENABLED: undefined }));
    expect(rowOf(id)).toMatchObject({ hold_reason: "switch-off", merge_claim_sha: null });
    expect(datasetRequests()).toEqual([]);
  });

  test('REPULL_DAILY_MERGE_CAP="0": no claim, no merge, cap-exhausted', async () => {
    const id = ready();
    const r = await tick(env({ REPULL_DAILY_MERGE_CAP: "0" }));
    expect(r).toMatchObject({ mergesSent: 0, held: { "cap-exhausted": 1 }, errors: [] });
    expect(rowOf(id)).toMatchObject({ hold_reason: "cap-exhausted", merge_claim_sha: null });
    expect(gh.merges).toEqual([]);
  });

  test("a cap set to something unreadable holds cap-unreadable, and is an error", async () => {
    const id = ready();
    const r = await tick(env({ REPULL_DAILY_MERGE_CAP: "x" }));
    expect(r).toMatchObject({ mergesSent: 0, errors: ["cap-unreadable"] });
    expect(rowOf(id)).toMatchObject({ hold_reason: "cap-unreadable", merge_claim_sha: null });
    expect(gh.merges).toEqual([]);
  });

  test("a cap of 1 and two clean rows: one merge, the other cap-exhausted, the next UTC day the second", async () => {
    const first = ready("on098812");
    const second = ready("on098813");
    const r = await tick(env({ REPULL_DAILY_MERGE_CAP: "1" }));
    expect(r).toMatchObject({ mergesSent: 1, merged: 1, held: { "cap-exhausted": 1 } });
    expect(rowOf(first)).toMatchObject({ status: "merged" });
    expect(rowOf(second)).toMatchObject({
      status: "gates_clear",
      hold_reason: "cap-exhausted",
      merge_claim_sha: null,
    });
    expect(gh.merges).toHaveLength(1);
    // The same day: still full.
    await tick(env({ REPULL_DAILY_MERGE_CAP: "1" }));
    expect(gh.merges).toHaveLength(1);
    // The next UTC day, on D1's own clock: the first claim belongs to yesterday.
    db.run(
      "UPDATE upstream_repulls SET merge_claimed_at = datetime('now', '-1 day') WHERE id = ?",
      [first],
    );
    const next = await tick(env({ REPULL_DAILY_MERGE_CAP: "1" }));
    expect(next).toMatchObject({ mergesSent: 1, merged: 1 });
    expect(rowOf(second)).toMatchObject({ status: "merged", hold_reason: null });
    expect(mergeTo("on098813")).toHaveLength(1);
  });

  test(`a record the Worker sent ${WORKER_MERGES_MAX} merges for holds merge-exhausted, and is not claimed`, async () => {
    const id = ready();
    for (let n = 1; n <= WORKER_MERGES_MAX; n++) {
      db.run(
        `INSERT INTO audit_log (user_id, action, resource_type, resource_id, details)
         VALUES (?, '${WORKER_MERGE_ACTION}', 'upstream_repull', ?, ?)`,
        [
          SYSTEM_USER_ID,
          String(id),
          JSON.stringify({ attempt: n, claimed_at: "2026-10-01 00:00:00" }),
        ],
      );
    }
    const r = await tick();
    expect(r).toMatchObject({ mergesSent: 0, held: { "merge-exhausted": 1 } });
    expect(rowOf(id)).toMatchObject({ merge_claim_sha: null, hold_reason: "merge-exhausted" });
    expect(gh.merges).toEqual([]);
    expect(usedToday()).toBe(0);
  });

  test("a record whose last merge GitHub refused is not claimed again: merge-refused", async () => {
    const id = ready();
    db.run(
      `INSERT INTO audit_log (user_id, action, resource_type, resource_id, details)
       VALUES (?, '${WORKER_MERGE_ACTION}', 'upstream_repull', ?, ?)`,
      [
        SYSTEM_USER_ID,
        String(id),
        JSON.stringify({ attempt: 1, claimed_at: "2026-10-01 00:00:00" }),
      ],
    );
    db.run(
      `INSERT INTO audit_log (user_id, action, resource_type, resource_id, details)
       VALUES (?, '${WORKER_MERGE_ANSWER_ACTION}', 'upstream_repull', ?, ?)`,
      [
        SYSTEM_USER_ID,
        String(id),
        JSON.stringify({ attempt: 1, claimed_at: "2026-10-01 00:00:00", outcome: "refused" }),
      ],
    );
    const r = await tick();
    expect(r).toMatchObject({ mergesSent: 0, held: { "merge-refused": 1 } });
    expect(rowOf(id)).toMatchObject({ merge_claim_sha: null, hold_reason: "merge-refused" });
    expect(gh.merges).toEqual([]);
  });

  test("a record whose trailers the message cannot carry holds merge-message, before any claim", async () => {
    const id = ready(DS, { to_tag: "1.0.1 (final)" });
    const r = await tick();
    expect(r).toMatchObject({ mergesSent: 0, held: { "merge-message": 1 } });
    expect(rowOf(id)).toMatchObject({ merge_claim_sha: null, hold_reason: "merge-message" });
    expect(gh.merges).toEqual([]);
    expect(usedToday()).toBe(0);
  });
});

describe("a fact that is not clean holds before the claim, and nothing is sent", () => {
  const cases: Array<[string, () => void, string]> = [
    [
      "a fork",
      () => {
        gh.pulls[`${DS}#7`] = appPull(DS, {
          head: { sha: HEAD, ref: "release/v2.0.0", repo: { full_name: "someone/on098811" } },
        });
      },
      "pr-mismatch",
    ],
    [
      "a deleted fork",
      () => {
        gh.pulls[`${DS}#7`] = appPull(DS, {
          head: { sha: HEAD, ref: "release/v2.0.0", repo: null },
        });
      },
      "pr-mismatch",
    ],
    [
      "a foreign branch",
      () => {
        gh.pulls[`${DS}#7`] = appPull(DS, {
          head: { sha: HEAD, ref: "add-subjects", repo: { full_name: `nemarDatasets/${DS}` } },
        });
      },
      "pr-mismatch",
    ],
    [
      "a draft",
      () => {
        gh.pulls[`${DS}#7`] = appPull(DS, { draft: true });
      },
      "pr-draft",
    ],
    [
      "another author",
      () => {
        gh.pulls[`${DS}#7`] = appPull(DS, { user: { login: "someone", id: 4242, type: "User" } });
      },
      "pr-not-app",
    ],
    [
      "a moved head",
      () => {
        gh.pulls[`${DS}#7`] = appPull(DS, {
          head: { sha: OTHER, ref: "release/v2.0.0", repo: { full_name: `nemarDatasets/${DS}` } },
        });
      },
      "head-moved",
    ],
    [
      "a moved main",
      () => {
        gh.mainRefs[DS] = OTHER;
      },
      "main-moved",
    ],
    [
      "a pull request merged by another hand",
      () => {
        gh.pulls[`${DS}#7`] = appPull(DS, { state: "closed", merged: true });
      },
      "pr-closed",
    ],
    [
      "BIDS validation failed",
      () => {
        gh.checkRuns[`${DS}@${HEAD}`] = [
          { ...BIDS_RUN, conclusion: "failure" },
          { ...VERSION_RUN },
        ];
      },
      "bids-failed",
    ],
    [
      "version-check still running",
      () => {
        gh.checkRuns[`${DS}@${HEAD}`] = [
          { ...BIDS_RUN },
          { ...VERSION_RUN, status: "in_progress", conclusion: null },
        ];
      },
      "version-check-pending",
    ],
    ["a screen that asks for a person", () => markScreen(1, DS, "review"), "screen-acknowledge"],
    ["a review that failed", () => review(DS, "fail"), "review-not-pass"],
    [
      "GitHub reports it unstable",
      () => {
        gh.pulls[`${DS}#7`] = appPull(DS, { mergeable_state: "unstable" });
      },
      "not-clean",
    ],
    [
      "GitHub reports it blocked",
      () => {
        gh.pulls[`${DS}#7`] = appPull(DS, { mergeable_state: "blocked" });
      },
      "not-clean",
    ],
    // Unknown is never clean.
    [
      "GitHub has not computed a mergeable state",
      () => {
        gh.pulls[`${DS}#7`] = appPull(DS, { mergeable_state: null });
      },
      "not-clean",
    ],
    [
      "GitHub says the state is unknown",
      () => {
        gh.pulls[`${DS}#7`] = appPull(DS, { mergeable_state: "unknown" });
      },
      "not-clean",
    ],
    [
      "the pull request cannot be read",
      () => {
        gh.pulls[`${DS}#7`] = { status: 500 };
      },
      "pr-unreadable",
    ],
    [
      "the pull request reads in another shape",
      () => {
        gh.pulls[`${DS}#7`] = appPull(DS, { omit: ["user"] });
      },
      "pr-unreadable",
    ],
    [
      "main cannot be read",
      () => {
        gh.mainRefs[DS] = 502;
      },
      "main-unreadable",
    ],
    [
      "the checks cannot be read",
      () => {
        gh.checkRuns[`${DS}@${HEAD}`] = 500;
      },
      "checks-unreadable",
    ],
    ["no screen of the head", () => db.run("DELETE FROM upstream_repull_screens"), "screen-rerun"],
    ["no review of the head", () => db.run("DELETE FROM pr_reviews"), "review-absent"],
  ];

  test("the facts are the merge stage's: a screened head that is not the recorded one is head-moved", async () => {
    // Only a record written by hand can be at gates_clear with another head (the gates edge sets the
    // screened head from the recorded one): the merge stage compares both, the gates stage only one.
    const id = ready(DS, { head_sha: OTHER });
    gh.pulls[`${DS}#7`] = appPull(DS, {
      head: { sha: OTHER, ref: "release/v2.0.0", repo: { full_name: `nemarDatasets/${DS}` } },
    });
    gh.checkRuns[`${DS}@${OTHER}`] = [{ ...BIDS_RUN }, { ...VERSION_RUN }];
    await tick();
    expect(rowOf(id)).toMatchObject({ hold_reason: "head-moved", merge_claim_sha: null });
    expect(gh.merges).toEqual([]);
  });

  for (const [name, flip, word] of cases) {
    test(`${name}: ${word}`, async () => {
      const id = ready();
      expect(id).toBe(1);
      flip();
      const r = await tick();
      expect(r).toMatchObject({ examined: 1, mergesSent: 0, merged: 0, held: { [word]: 1 } });
      expect(rowOf(id)).toMatchObject({
        status: "gates_clear",
        hold_reason: word,
        merge_claim_sha: null,
      });
      expect(gh.merges).toEqual([]);
      expect(usedToday()).toBe(0);
      expect(auditsOf(WORKER_MERGE_ACTION, id)).toEqual([]);
    });
  }
});

describe("the Worker never merges an administrator's re-pull, and acts only in production", () => {
  test("an administrator's row at gates_clear draws no request from the tick", async () => {
    const id = ready(DS, { origin: "administrator" });
    const r = await tick();
    expect(r.examined).toBe(0);
    expect(datasetRequests()).toEqual([]);
    expect(rowOf(id)).toMatchObject({ status: "gates_clear", merge_claim_sha: null });
  });

  test("asked directly, an administrator's row is skipped before anything is read", async () => {
    const id = ready(DS, { origin: "administrator" });
    const row = await getRepull(realD1(db), id);
    const o = await workerMergeRepull(env(), row as NonNullable<typeof row>);
    expect(o).toMatchObject({ kind: "skipped", hold: null, sent: false });
    expect(gh.requests).toEqual([]);
    expect(rowOf(id)).toMatchObject({ merge_claim_sha: null, hold_reason: null });
  });

  for (const environment of ["development", "staging", "Production", " production", undefined]) {
    test(`ENVIRONMENT=${JSON.stringify(environment)}: nothing is read, claimed or sent`, async () => {
      const id = ready();
      const before = JSON.stringify(db.query("SELECT * FROM upstream_repulls").all());
      expect(await runRepullAdvanceCron(env({ ENVIRONMENT: environment }))).toBeNull();
      const row = await getRepull(realD1(db), id);
      const o = await workerMergeRepull(
        env({ ENVIRONMENT: environment }),
        row as NonNullable<typeof row>,
      );
      expect(o.kind).toBe("skipped");
      expect(gh.requests).toEqual([]);
      expect(JSON.stringify(db.query("SELECT * FROM upstream_repulls").all())).toBe(before);
    });
  }
});

describe("what GitHub answers the merge", () => {
  for (const status of [405, 409, 422]) {
    test(`${status}: refused, it did not merge; the claim is kept and the row holds merge-refused`, async () => {
      const id = ready();
      gh.mergeAnswer = { status };
      const r = await tick();
      expect(r).toMatchObject({ mergesSent: 1, merged: 0, mergeUnknown: 0 });
      expect(rowOf(id)).toMatchObject({
        status: "gates_clear",
        merge_claim_sha: HEAD,
        merge_sha: null,
        hold_reason: "merge-refused",
      });
      expect(auditsOf(WORKER_MERGE_ANSWER_ACTION, id).map((a) => a.details.outcome)).toEqual([
        "refused",
      ]);
    });
  }

  test("a head that moved between the facts and the merge: GitHub refuses the sha, and nothing merges", async () => {
    const id = ready();
    gh.beforeMerge = () => {
      gh.pulls[`${DS}#7`] = appPull(DS, {
        head: { sha: OTHER, ref: "release/v2.0.0", repo: { full_name: `nemarDatasets/${DS}` } },
      });
    };
    await tick();
    expect(mergeTo()[0]?.body.sha).toBe(HEAD);
    expect(rowOf(id)).toMatchObject({ status: "gates_clear", hold_reason: "merge-refused" });
    expect(gh.pulls[`${DS}#7`]?.merged).toBe(false);
  });

  for (const [name, answer] of [
    ["a 502", { status: 502 }],
    ["a 502 after GitHub merged", { status: 502, applied: true }],
    ["a 200 that does not say it merged", "not-merged"],
  ] as const) {
    test(`${name}: unknown; the claim is kept, the row holds claim-held, and nothing is sent again`, async () => {
      const id = ready();
      gh.mergeAnswer = answer as RepullGitHub["mergeAnswer"];
      const r = await tick();
      expect(r).toMatchObject({ mergesSent: 1, merged: 0, mergeUnknown: 1 });
      expect(rowOf(id)).toMatchObject({
        status: "gates_clear",
        merge_claim_sha: HEAD,
        hold_reason: "claim-held",
      });
      expect(auditsOf(WORKER_MERGE_ANSWER_ACTION, id).map((a) => a.details.outcome)).toEqual([
        "unknown",
      ]);
      expect(mergeTo()).toHaveLength(1);
    });
  }

  test("no answer in time: unknown, and the claim is kept", async () => {
    const id = ready();
    __setWorkerMergeTimeoutForTests(100);
    gh.slow = "/pulls/7/merge";
    gh.slowMs = 400;
    const r = await tick();
    expect(r).toMatchObject({ mergesSent: 1, mergeUnknown: 1 });
    expect(rowOf(id)).toMatchObject({ merge_claim_sha: HEAD, hold_reason: "claim-held" });
    expect(auditsOf(WORKER_MERGE_ANSWER_ACTION, id)[0]?.details).toMatchObject({
      outcome: "unknown",
      status: 0,
    });
    // Let the stand-in finish the request it was slow to answer.
    await Bun.sleep(500);
  });
});

describe("what the merge costs a tick", () => {
  // The 30-minute tick shares one invocation's subrequest allowance with every job on it: every D1
  // statement prepared (a batch's statements each count) and every request to GitHub, over five
  // rows, the most a tick reads past the gates.
  test("five rows that wait at the merge, and five that are merged", async () => {
    let statements = 0;
    const base = realD1(db);
    const counting = {
      prepare(sql: string) {
        statements++;
        return base.prepare(sql);
      },
      batch: (s: never[]) => base.batch(s),
    } as unknown as D1Database;
    const datasets = [1, 2, 3, 4, 5].map((i) => `on0988${String(20 + i)}`);
    const ids = datasets.map((ds) => ready(ds));
    const measure = async () => {
      statements = 0;
      gh.requests = [];
      await tick(env({}, counting));
      return { d1: statements, github: gh.requests.length };
    };
    // Each waits: its review was reset to running on the same head.
    db.run("UPDATE pr_reviews SET state = 'dispatched', verdict = NULL, report = NULL");
    const waiting = await measure();
    // Each is clean now, and is claimed, merged and recorded.
    db.run("DELETE FROM pr_reviews");
    for (const ds of datasets) review(ds);
    const merging = await measure();
    // Per row: seven statements and four requests to wait (the record, the merges, the dataset,
    // the screen, the review, the hold and its audit row; the pull request, `main`, two checks);
    // sixteen and seven to merge (the same five reads and four requests, the claim's five
    // statements and its read of the live head, the merge's audit row, the merge, its answer, and
    // the verified route's four statements and its read of the merge). Two for the tick.
    expect({ waiting, merging }).toEqual({
      waiting: { d1: 37, github: 20 },
      merging: { d1: 82, github: 35 },
    });
    expect(ids.every((id) => rowOf(id).status === "merged")).toBe(true);
  });
});

describe("the merge's audit row is the gate on the send", () => {
  test("it applies only to the claim and revision it names, and under the bound", () => {
    const id = ready();
    db.run(
      "UPDATE upstream_repulls SET merge_claim_sha = ?, merge_claimed_at = datetime('now') WHERE id = ?",
      [HEAD, id],
    );
    const { revision, merge_claimed_at: at } = rowOf(id) as {
      revision: number;
      merge_claimed_at: string;
    };
    const run = (
      o: { rev?: number; sha?: string; at?: string; young?: number; max?: number } = {},
    ) =>
      db
        .query(WORKER_MERGE_SENT_SQL)
        .run(
          SYSTEM_USER_ID,
          id,
          "{}",
          o.rev ?? revision,
          o.sha ?? HEAD,
          o.at ?? at,
          o.young ?? 0,
          o.max ?? WORKER_MERGES_MAX,
        ).changes;
    expect(run({ rev: revision + 1 })).toBe(0);
    expect(run({ sha: OTHER })).toBe(0);
    expect(run({ at: "2026-01-01 00:00:00" })).toBe(0);
    expect(run({ max: 0 })).toBe(0);
    expect(run()).toBe(1);
    expect(run({ max: 1 })).toBe(0);
    // A claim older than the bound for sending again under it.
    db.run(
      "UPDATE upstream_repulls SET merge_claimed_at = datetime('now', '-26 minutes') WHERE id = ?",
      [id],
    );
    const old = String(rowOf(id).merge_claimed_at);
    expect(run({ at: old, young: 1 })).toBe(0);
    expect(run({ at: old, young: 0 })).toBe(1);
    // An administrator's row is never one.
    db.run("UPDATE upstream_repulls SET origin = 'administrator' WHERE id = ?", [id]);
    expect(run({ at: old })).toBe(0);
  });
});
