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
 * The properties, each with a test of its own:
 *  - a machine-clean row is merged once, by squash, at the screened head, with the gate's message,
 *    and only after its claim and its audit row are written; the merge is recorded;
 *  - the merge switch, the cap, the bound and every fact that is not clean (an unknown one
 *    included) each hold before anything is claimed or sent;
 *  - an administrator's row is never merged, and nothing outside exact production is read;
 *  - GitHub's refusal and an answer that was lost each keep the claim, under their own words;
 *  - a claim the Worker holds is resolved from GitHub's word on a later tick, and a merge is sent
 *    again only under that claim, while it is young and the facts read then are clean;
 *  - a merged record's finish run is dispatched a bounded number of times, in production only;
 *  - the rows past their gates are read five a tick, in turn, so none waits for ever.
 * That the Worker merges in one place and approves nothing is `repull-merge-scan.test.ts`.
 */

import type { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { parseScreenReport } from "../../shared/identifier-screen-report";
import { NEMAR_APP_BOT_LOGIN, NEMAR_APP_BOT_USER_ID, NEMAR_APP_ID } from "../../shared/nemar-app";
import { repullSquashMessage, repullTrailerLines } from "../../shared/repull-squash";
import type { DispatchRow, RepullStatus } from "../../shared/repull-state";
import { SYSTEM_USER_ID } from "../src/lib/constants";
import { verifyRepullDispatchToken } from "../src/services/github/callback-tokens";
import { __resetRateLimitStateForTests } from "../src/services/github/transport";
import {
  CREATE_FACTS_SQL,
  MERGE_CLAIMS_TODAY_SQL,
  getRepull,
} from "../src/services/upstream-repull";
import {
  type AdvanceTickResult,
  repullAdvanceLogLine,
  runRepullAdvanceCron,
} from "../src/services/upstream-repull-advance";
import {
  CLAIM_OWNER_SQL,
  FINISH_DISPATCHES_MAX,
  FINISH_DISPATCHES_SQL,
  WORKER_MERGES_MAX,
  WORKER_MERGES_SQL,
  WORKER_MERGE_ACTION,
  WORKER_MERGE_ANSWER_ACTION,
  WORKER_MERGE_SENT_SQL,
  __setWorkerMergeTimeoutForTests,
  finishAfterMerge,
  reconcileWorkerClaim,
  workerMergeRepull,
} from "../src/services/upstream-repull-merge";
import type { Bindings } from "../src/types/bindings";
import { freshDb, interceptingD1, realD1 } from "./helpers/d1";
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

/** Every hold word the tick ever wrote on `id`, in order. */
const holdsOf = (id: number) => auditsOf("repull_hold", id).map((a) => a.details.to);

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
      mergeRefused: 0,
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

  test("a merge the second tick finds recorded is not sent again: the row waits for its finish", async () => {
    const id = ready();
    await tick();
    gh.requests = [];
    const again = await tick();
    // The merged row is the finish's now, which waits for the version's DOI and asks GitHub nothing.
    expect(again).toMatchObject({ examined: 1, mergesSent: 0, merged: 0, finishes: 0, notDue: 1 });
    expect(datasetRequests()).toEqual([]);
    expect(mergeTo()).toHaveLength(1);
    expect(rowOf(id)).toMatchObject({ status: "merged", hold_reason: null });
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

  test("the bounds are the ones ADR 0111 names: three merges a record, three finish dispatches", () => {
    // The tests above and below count to the constants, so only this pins their values.
    expect(WORKER_MERGES_MAX).toBe(3);
    expect(FINISH_DISPATCHES_MAX).toBe(3);
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
    // GitHub always names both repositories; an answer that does not, or not as a name, is
    // unreadable, never read as the dataset's own.
    [
      "the head's repository is not named",
      () => {
        gh.pulls[`${DS}#7`] = appPull(DS, {
          head: { sha: HEAD, ref: "release/v2.0.0", repo: undefined },
        });
      },
      "pr-unreadable",
    ],
    [
      "the head's repository has no name",
      () => {
        gh.pulls[`${DS}#7`] = appPull(DS, {
          head: { sha: HEAD, ref: "release/v2.0.0", repo: {} as never },
        });
      },
      "pr-unreadable",
    ],
    [
      "the base's repository is not named",
      () => {
        gh.pulls[`${DS}#7`] = appPull(DS, { base: { ref: "main", repo: undefined } });
      },
      "pr-unreadable",
    ],
    [
      "the base's repository is named by a number",
      () => {
        gh.pulls[`${DS}#7`] = appPull(DS, {
          base: { ref: "main", repo: { full_name: 5 as never } },
        });
      },
      "pr-unreadable",
    ],
    ["no screen of the head", () => db.run("DELETE FROM upstream_repull_screens"), "screen-rerun"],
    ["no review of the head", () => db.run("DELETE FROM pr_reviews"), "review-absent"],
  ];

  test("GitHub unreadable at the claim's own read of the live head: pr-unreadable, nothing claimed", async () => {
    const id = ready();
    // GitHub goes down after the facts were read and before the claim reads the live head: the
    // claim's read of the dataset fences, the second read of the dataset row, comes just before.
    let reads = 0;
    const failing = interceptingD1(realD1(db), (sql) => {
      if (sql === CREATE_FACTS_SQL && ++reads === 2) gh.down = true;
    });
    const r = await tick(env({}, failing));
    expect(reads).toBe(2);
    expect(r).toMatchObject({
      mergesSent: 0,
      held: { "pr-unreadable": 1 },
      refused: { "github-unreadable": 1 },
    });
    expect(rowOf(id)).toMatchObject({ hold_reason: "pr-unreadable", merge_claim_sha: null });
    expect(gh.merges).toEqual([]);
    expect(usedToday()).toBe(0);
    expect(auditsOf(WORKER_MERGE_ACTION, id)).toEqual([]);
  });

  test("a fork's head after the facts were read: the claim's own read refuses it, and nothing is sent", async () => {
    const id = ready();
    // The pull request turns into a fork's, at the same branch and head, between the facts and the
    // claim: the claim is the one statement every merge passes, so it reads the repository itself.
    let reads = 0;
    const forking = interceptingD1(realD1(db), (sql) => {
      if (sql === CREATE_FACTS_SQL && ++reads === 2) {
        gh.pulls[`${DS}#7`] = appPull(DS, {
          head: { sha: HEAD, ref: "release/v2.0.0", repo: { full_name: `someone/${DS}` } },
        });
      }
    });
    const r = await tick(env({}, forking));
    expect(reads).toBe(2);
    expect(r).toMatchObject({
      mergesSent: 0,
      held: { "claim-refused": 1 },
      refused: { "head-moved": 1 },
    });
    expect(rowOf(id)).toMatchObject({ hold_reason: "claim-refused", merge_claim_sha: null });
    expect(gh.merges).toEqual([]);
    expect(usedToday()).toBe(0);
    expect(auditsOf(WORKER_MERGE_ACTION, id)).toEqual([]);
  });

  test("a record that moves between the facts and the claim is skipped, not claim-refused, and the next tick merges it", async () => {
    const id = ready();
    // Another writer moves the record after the claim's read of the dataset and before it commits.
    let reads = 0;
    const racing = interceptingD1(realD1(db), (sql) => {
      if (sql === CREATE_FACTS_SQL && ++reads === 2) {
        db.run("UPDATE upstream_repulls SET revision = revision + 1 WHERE id = ?", [id]);
      }
    });
    const r = await tick(env({}, racing));
    expect(reads).toBe(2);
    expect(r.mergesSent).toBe(0);
    // Exact: `toMatchObject` with `{}` matches any object.
    expect(r.held).toEqual({});
    expect(r.refused).toEqual({});
    expect(r.errors).toEqual([]);
    // Nothing changed and nothing failed, so the tick writes no log line at all.
    expect(repullAdvanceLogLine(r)).toBeNull();
    expect(rowOf(id)).toMatchObject({ hold_reason: null, merge_claim_sha: null });
    expect(gh.merges).toEqual([]);
    // The next tick reads the record as it is, and merges it.
    expect(await tick()).toMatchObject({ mergesSent: 1, merged: 1 });
  });

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

  // A held claim is resolved whatever the switches say, so its fences are the only thing between
  // a development Worker, or an administrator's record, and GitHub. Here GitHub would say merged.
  for (const environment of ["development", "Production", undefined]) {
    test(`a held claim, ENVIRONMENT=${JSON.stringify(environment)}: skipped, and nothing is read`, async () => {
      const id = ready();
      claimBy(id, SYSTEM_USER_ID);
      gh.pulls[`${DS}#7`] = appPull(DS, { state: "closed", merged: true });
      const row = await getRepull(realD1(db), id);
      const o = await reconcileWorkerClaim(
        env({ ENVIRONMENT: environment }),
        row as NonNullable<typeof row>,
      );
      expect(o.kind).toBe("skipped");
      expect(gh.requests).toEqual([]);
      expect(rowOf(id)).toMatchObject({ status: "gates_clear", merge_claim_sha: HEAD });
    });
  }

  test("a held claim on an administrator's record: skipped, and nothing is read", async () => {
    const id = ready(DS, { origin: "administrator" });
    claimBy(id, SYSTEM_USER_ID);
    gh.pulls[`${DS}#7`] = appPull(DS, { state: "closed", merged: true });
    const row = await getRepull(realD1(db), id);
    const o = await reconcileWorkerClaim(env(), row as NonNullable<typeof row>);
    expect(o.kind).toBe("skipped");
    expect(gh.requests).toEqual([]);
    expect(rowOf(id)).toMatchObject({ status: "gates_clear", merge_claim_sha: HEAD });
  });
});

describe("what GitHub answers the merge", () => {
  for (const status of [405, 409, 422]) {
    test(`${status}: refused, it did not merge; the claim is kept and the row holds merge-refused`, async () => {
      const id = ready();
      gh.mergeAnswer = { status };
      const r = await tick();
      expect(r).toMatchObject({ mergesSent: 1, merged: 0, mergeUnknown: 0, mergeRefused: 1 });
      expect(rowOf(id)).toMatchObject({
        status: "gates_clear",
        merge_claim_sha: HEAD,
        merge_sha: null,
        hold_reason: "merge-refused",
      });
      // Counted and logged at error level: a refusal is for an administrator to read.
      expect(repullAdvanceLogLine(r)?.level).toBe("error");
      expect(repullAdvanceLogLine(r)?.line).toContain(" merge_refused=1 ");
      expect(auditsOf(WORKER_MERGE_ANSWER_ACTION, id).map((a) => a.details.outcome)).toEqual([
        "refused",
      ]);
    });
  }

  // Only 405, 409 and 422 refuse the merge itself; these speak of the credential or the rate.
  for (const status of [401, 403, 429]) {
    test(`${status}: unknown, not a refusal; the claim is kept and the row holds claim-held`, async () => {
      const id = ready();
      gh.mergeAnswer = { status };
      const r = await tick();
      expect(r).toMatchObject({ mergesSent: 1, merged: 0, mergeUnknown: 1, mergeRefused: 0 });
      expect(rowOf(id)).toMatchObject({
        status: "gates_clear",
        merge_claim_sha: HEAD,
        merge_sha: null,
        hold_reason: "claim-held",
      });
      expect(auditsOf(WORKER_MERGE_ANSWER_ACTION, id).map((a) => a.details)).toEqual([
        expect.objectContaining({ outcome: "unknown", status }),
      ]);
      // Five minutes on, the claim is not released as refused: GitHub never said it refused.
      ageClaim(id, 6);
      gh.mergeAnswer = null;
      gh.pulls[`${DS}#7`] = appPull(DS, { mergeable_state: "blocked" });
      await tick();
      expect(rowOf(id)).toMatchObject({ merge_claim_sha: HEAD, hold_reason: "claim-held" });
      expect(auditsOf("repull_merge_claim_released", id)).toEqual([]);
      expect(holdsOf(id)).not.toContain("merge-refused");
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

// ----------------------------------------------------------------------------
// A claim the Worker holds, on a later tick
// ----------------------------------------------------------------------------

/** The claims made on `id`: its gates-clear self-edges in the audit rows. */
const claimsOf = (id: number) =>
  auditsOf("repull_transition", id).filter(
    (a) => a.details.from === "gates_clear" && a.details.to === "gates_clear",
  );

/**
 * Move the claim of `id` `minutes` into the past, and the Worker's audit rows of its merges with
 * it, as time passing would: a claim and the merges sent under it name one time.
 */
function ageClaim(id: number, minutes: number): void {
  db.run(
    `UPDATE upstream_repulls SET merge_claimed_at = datetime(merge_claimed_at, '-${minutes} minutes') WHERE id = ?`,
    [id],
  );
  db.run(
    `UPDATE audit_log SET details = json_set(details, '$.claimed_at',
       (SELECT merge_claimed_at FROM upstream_repulls WHERE id = ?1))
     WHERE action IN ('${WORKER_MERGE_ACTION}', '${WORKER_MERGE_ANSWER_ACTION}') AND resource_id = CAST(?1 AS TEXT)`,
    [id],
  );
}

/** A claim on `id` made by `userId` now, with its claim edge's audit row, and nothing sent under it. */
function claimBy(id: number, userId: number): void {
  db.run(
    "UPDATE upstream_repulls SET merge_claim_sha = gates_sha, merge_claimed_at = datetime('now'), revision = revision + 1 WHERE id = ?",
    [id],
  );
  db.run(
    `INSERT INTO audit_log (user_id, action, resource_type, resource_id, details)
     VALUES (?, 'repull_transition', 'upstream_repull', ?, ?)`,
    [
      userId,
      String(id),
      JSON.stringify({
        dataset_id: DS,
        from: "gates_clear",
        to: "gates_clear",
        fields: ["merge_claim_sha"],
      }),
    ],
  );
}

describe("a merge whose answer was lost is resolved from GitHub on a later tick", () => {
  test("a 502 after GitHub merged: the next tick records the merge, with no second claim or merge", async () => {
    const id = ready();
    gh.mergeAnswer = { status: 502, applied: true };
    await tick();
    expect(rowOf(id)).toMatchObject({ status: "gates_clear", hold_reason: "claim-held" });
    gh.mergeAnswer = null;
    const r = await tick();
    expect(r).toMatchObject({ mergesSent: 0, merged: 1 });
    expect(rowOf(id)).toMatchObject({
      status: "merged",
      merge_sha: STANDIN_MERGE_SHA,
      merge_claim_sha: HEAD,
    });
    expect(JSON.parse(String(rowOf(id).counts))).not.toHaveProperty("merged_outside_tool");
    expect(claimsOf(id)).toHaveLength(1);
    expect(mergeTo()).toHaveLength(1);
  });

  test("a 502 that did not merge: the next tick sends it once more under the same claim", async () => {
    const id = ready();
    gh.mergeAnswer = { status: 502 };
    await tick();
    const claimedAt = rowOf(id).merge_claimed_at;
    gh.mergeAnswer = null;
    const r = await tick();
    expect(r).toMatchObject({ mergesSent: 1, merged: 1 });
    expect(rowOf(id)).toMatchObject({ status: "merged", merge_claimed_at: claimedAt });
    // One claim, one unit of the cap, two merges sent under it.
    expect(claimsOf(id)).toHaveLength(1);
    expect(usedToday()).toBe(1);
    expect(mergeTo()).toHaveLength(2);
    expect(auditsOf(WORKER_MERGE_ACTION, id).map((a) => a.details.attempt)).toEqual([1, 2]);
  });

  test(`no more than ${WORKER_MERGES_MAX} merges are sent for a record, every one under its one claim`, async () => {
    const id = ready();
    gh.mergeAnswer = { status: 502 };
    for (let n = 0; n < WORKER_MERGES_MAX; n++) await tick();
    expect(mergeTo()).toHaveLength(WORKER_MERGES_MAX);
    // Past the bound a tick reads the pull request once, for a merge GitHub made, and nothing else.
    gh.requests = [];
    await tick();
    await tick();
    expect(datasetRequests()).toEqual([
      `GET /repos/nemarDatasets/${DS}/pulls/7`,
      `GET /repos/nemarDatasets/${DS}/pulls/7`,
    ]);
    expect(mergeTo()).toHaveLength(WORKER_MERGES_MAX);
    expect(auditsOf(WORKER_MERGE_ACTION, id)).toHaveLength(WORKER_MERGES_MAX);
    expect(claimsOf(id)).toHaveLength(1);
    expect(rowOf(id)).toMatchObject({ merge_claim_sha: HEAD, hold_reason: "claim-held" });
  });

  test("under a claim 25 minutes old nothing is sent again, and the claim is kept for resume", async () => {
    const id = ready();
    gh.mergeAnswer = { status: 502 };
    await tick();
    ageClaim(id, 26);
    gh.mergeAnswer = null;
    const r = await tick();
    expect(r).toMatchObject({ mergesSent: 0, claimsReleased: 0 });
    expect(rowOf(id)).toMatchObject({ merge_claim_sha: HEAD, hold_reason: "claim-held" });
    // Older still, past the half hour resume expires a claim at: the Worker still keeps it.
    ageClaim(id, 30);
    await tick();
    expect(rowOf(id)).toMatchObject({ merge_claim_sha: HEAD, hold_reason: "claim-held" });
    expect(mergeTo()).toHaveLength(1);
  });

  test("with the switches off, a merge GitHub made is still recorded, and nothing is sent", async () => {
    const id = ready();
    gh.mergeAnswer = { status: 502 };
    await tick();
    gh.requests = [];
    const off = await tick(env({ AUTO_REPULL_ENABLED: undefined }));
    expect(off).toMatchObject({ mergesSent: 0 });
    expect(rowOf(id)).toMatchObject({ merge_claim_sha: HEAD, hold_reason: "claim-held" });
    gh.pulls[`${DS}#7`] = appPull(DS, { state: "closed", merged: true });
    const recorded = await tick(
      env({ AUTO_REPULL_ENABLED: undefined, AUTO_REPULL_MERGE_ENABLED: undefined }),
    );
    expect(recorded).toMatchObject({ merged: 1, mergesSent: 0 });
    expect(rowOf(id)).toMatchObject({ status: "merged" });
    expect(mergeTo()).toHaveLength(1);
  });

  // Each flip makes a fact the merge rests on not clean after a lost answer: the merge is not sent
  // again, whatever its claim allows, because the facts read now decide.
  const unclean: Array<[string, (id: number) => void]> = [
    [
      "main moved",
      () => {
        gh.mainRefs[DS] = OTHER;
      },
    ],
    ["the review now fails", () => review(DS, "fail")],
    [
      "BIDS validation now fails",
      () => {
        gh.checkRuns[`${DS}@${HEAD}`] = [
          { ...BIDS_RUN, conclusion: "failure" },
          { ...VERSION_RUN },
        ];
      },
    ],
    ["the screen now asks for a person", (id) => markScreen(id, DS, "review")],
  ];
  for (const [name, flip] of unclean) {
    test(`a lost answer is not sent again once ${name}: the claim is kept`, async () => {
      const id = ready();
      gh.mergeAnswer = { status: 502 };
      await tick();
      gh.mergeAnswer = null;
      flip(id);
      const r = await tick();
      expect(r).toMatchObject({ mergesSent: 0, merged: 0 });
      expect(mergeTo()).toHaveLength(1);
      expect(rowOf(id)).toMatchObject({ merge_claim_sha: HEAD, hold_reason: "claim-held" });
    });
  }

  test("merged at another head: the claim is kept for resume, which records it with its counts", async () => {
    const id = ready();
    gh.mergeAnswer = { status: 502 };
    await tick();
    gh.pulls[`${DS}#7`] = appPull(DS, {
      state: "closed",
      merged: true,
      head: { sha: OTHER, ref: "release/v2.0.0", repo: { full_name: `nemarDatasets/${DS}` } },
    });
    await tick();
    expect(rowOf(id)).toMatchObject({
      status: "gates_clear",
      merge_claim_sha: HEAD,
      hold_reason: "claim-held",
    });
  });
});

describe("a merge GitHub refused, and a claim nothing was sent under", () => {
  for (const status of [405, 409, 422]) {
    test(`${status}: five minutes on the claim is released as refused, merge-refused, and not claimed again`, async () => {
      const id = ready();
      gh.mergeAnswer = { status };
      await tick();
      gh.mergeAnswer = null;
      // Too soon: the record releases a claim only once it is five minutes old.
      await tick();
      expect(rowOf(id)).toMatchObject({ merge_claim_sha: HEAD, hold_reason: "merge-refused" });
      ageClaim(id, 6);
      const r = await tick();
      expect(r).toMatchObject({ claimsReleased: 1, mergesSent: 0 });
      expect(rowOf(id)).toMatchObject({
        status: "gates_clear",
        merge_claim_sha: null,
        merge_claimed_at: null,
        hold_reason: "merge-refused",
      });
      expect(auditsOf("repull_merge_claim_released", id).map((a) => a.details.outcome)).toEqual([
        "refused",
      ]);
      // The unit of the day's cap is free, and no later tick claims the record again.
      expect(usedToday()).toBe(0);
      await tick();
      expect(claimsOf(id)).toHaveLength(1);
      expect(mergeTo()).toHaveLength(1);
      expect(rowOf(id)).toMatchObject({ merge_claim_sha: null, hold_reason: "merge-refused" });
    });
  }

  test("a pull request GitHub cannot read keeps the claim, though the release's own read would succeed", async () => {
    const id = ready();
    gh.mergeAnswer = { status: 409 };
    await tick();
    gh.mergeAnswer = null;
    ageClaim(id, 6);
    // The tick's read of the pull request fails, both of its tries; a read after it, the release's
    // own, would succeed and release the claim. Unread is never read as "did not merge".
    gh.pullReadFailures[`${DS}#7`] = 2;
    const r = await tick();
    expect(gh.pullReadFailures[`${DS}#7`]).toBe(0);
    expect(r).toMatchObject({ claimsReleased: 0, mergesSent: 0, errors: [] });
    expect(rowOf(id)).toMatchObject({ merge_claim_sha: HEAD, hold_reason: "claim-held" });
    expect(auditsOf("repull_merge_claim_released", id)).toEqual([]);
    // Read again, GitHub says it did not merge: the claim is released as refused.
    const next = await tick();
    expect(next).toMatchObject({ claimsReleased: 1 });
    expect(rowOf(id)).toMatchObject({ merge_claim_sha: null, hold_reason: "merge-refused" });
  });

  test("a held claim whose pull request GitHub now reports from a fork is kept, never released or recorded", async () => {
    const id = ready();
    gh.mergeAnswer = { status: 409 };
    await tick();
    gh.mergeAnswer = null;
    ageClaim(id, 6);
    // Released if read as the record's own pull request: a fork's is not, so the record holds.
    gh.pulls[`${DS}#7`] = appPull(DS, {
      head: { sha: HEAD, ref: "release/v2.0.0", repo: { full_name: `someone/${DS}` } },
    });
    const r = await tick();
    expect(r).toMatchObject({ claimsReleased: 0, mergesSent: 0, merged: 0, errors: [] });
    expect(rowOf(id)).toMatchObject({
      status: "gates_clear",
      merge_claim_sha: HEAD,
      hold_reason: "claim-held",
    });
    expect(auditsOf("repull_merge_claim_released", id)).toEqual([]);
    expect(mergeTo()).toHaveLength(1);
  });

  test("a held claim whose pull request GitHub reports merged from a fork is never recorded as merged", async () => {
    const id = ready();
    gh.mergeAnswer = { status: 502 };
    await tick();
    gh.mergeAnswer = null;
    // Merged at the claimed head and branch, but from a fork: not the re-pull's merge, so the
    // record keeps its claim for an administrator rather than recording someone else's merge.
    gh.pulls[`${DS}#7`] = appPull(DS, {
      state: "closed",
      merged: true,
      head: { sha: HEAD, ref: "release/v2.0.0", repo: { full_name: `someone/${DS}` } },
    });
    const r = await tick();
    expect(r).toMatchObject({ merged: 0, claimsReleased: 0, mergesSent: 0, errors: [] });
    expect(rowOf(id)).toMatchObject({
      status: "gates_clear",
      merge_sha: null,
      merge_claim_sha: HEAD,
      hold_reason: "claim-held",
    });
  });

  test("closed without a merge after a refusal: released five minutes on, and the row holds pr-closed", async () => {
    const id = ready();
    gh.mergeAnswer = { status: 409 };
    await tick();
    gh.mergeAnswer = null;
    gh.pulls[`${DS}#7`] = appPull(DS, { state: "closed" });
    ageClaim(id, 6);
    await tick();
    expect(rowOf(id)).toMatchObject({ merge_claim_sha: null, hold_reason: "pr-closed" });
    expect(auditsOf("repull_merge_claim_released", id).map((a) => a.details.outcome)).toEqual([
      "refused",
    ]);
  });

  test("closed without a merge after a lost answer: released only past the half hour", async () => {
    const id = ready();
    gh.mergeAnswer = { status: 502 };
    await tick();
    gh.mergeAnswer = null;
    gh.pulls[`${DS}#7`] = appPull(DS, { state: "closed" });
    ageClaim(id, 6);
    await tick();
    expect(rowOf(id)).toMatchObject({ merge_claim_sha: HEAD, hold_reason: "claim-held" });
    ageClaim(id, 30);
    await tick();
    expect(rowOf(id)).toMatchObject({ merge_claim_sha: null, hold_reason: "pr-closed" });
    expect(auditsOf("repull_merge_claim_released", id).map((a) => a.details.outcome)).toEqual([
      "expired",
    ]);
  });

  test("a claim nothing was sent under is sent under while young, and released after five minutes otherwise", async () => {
    const young = ready("on098816");
    claimBy(young, SYSTEM_USER_ID);
    const r = await tick();
    expect(r).toMatchObject({ mergesSent: 1, merged: 1 });
    expect(rowOf(young)).toMatchObject({ status: "merged" });

    const old = ready("on098817");
    claimBy(old, SYSTEM_USER_ID);
    ageClaim(old, 26);
    const released = await tick();
    expect(released).toMatchObject({ claimsReleased: 1, mergesSent: 0 });
    expect(rowOf(old)).toMatchObject({ merge_claim_sha: null, hold_reason: null });
    expect(auditsOf("repull_merge_claim_released", old).map((a) => a.details.outcome)).toEqual([
      "not_sent",
    ]);
    // Taken on again from its facts: a claim of its own, and the merge.
    const next = await tick();
    expect(next).toMatchObject({ mergesSent: 1, merged: 1 });
    expect(rowOf(old)).toMatchObject({ status: "merged" });
  });

  test("an administrator's claim on an automatic record is theirs: nothing sent under it or released", async () => {
    const id = ready();
    claimBy(id, adminId);
    ageClaim(id, 26);
    const r = await tick();
    expect(r).toMatchObject({ mergesSent: 0, claimsReleased: 0 });
    expect(rowOf(id)).toMatchObject({ merge_claim_sha: HEAD, hold_reason: "claim-held" });
    expect(gh.merges).toEqual([]);
    // A merge GitHub made at the claimed head is recorded all the same: it happened.
    gh.pulls[`${DS}#7`] = appPull(DS, { state: "closed", merged: true });
    await tick();
    expect(rowOf(id)).toMatchObject({ status: "merged" });
  });
});

// ----------------------------------------------------------------------------
// After the merge: the finish run
// ----------------------------------------------------------------------------

const SECRET = "repull-worker-merge-callback-secret";

/** The version row the version DOI's callback writes, with its DOI (an empty one is none). */
function versionRow(ds: string, version: string, doi = `10.82901/nemar.${ds}.v2`) {
  db.run(
    `INSERT INTO dataset_versions (dataset_id, version, doi, provider, created_at)
     VALUES (?, ?, ?, 'ezid', datetime('now'))`,
    [ds, version, doi],
  );
}

/** A mirror with an automatic record of `ds` that merged, at `status`: the record's id. */
function mergedRow(status: "merged" | "released", over: Row = {}): number {
  mirror(DS);
  return seedRow(DS, status, {
    merge_claim_sha: HEAD,
    merge_claimed_at: "2026-10-25 03:00:00",
    ...over,
  });
}

const finishDispatches = (id: number) =>
  db
    .query(
      "SELECT * FROM upstream_repull_dispatches WHERE repull_id = ? AND kind = 'finish' ORDER BY id",
    )
    .all(id) as DispatchRow[];

const sentRuns = () =>
  (
    gh.dispatches as unknown as Array<{
      event_type: string;
      client_payload: Record<string, unknown>;
    }>
  )
    .filter((d) => d.event_type === "run-upstream-repull")
    .map((d) => d.client_payload);

/** End the live dispatch of the dataset as its run would, `failed`. */
function runFailed(): void {
  db.run(
    `UPDATE upstream_repull_dispatches SET status = 'failed', code = 'finish-incomplete', nonce = NULL,
       reported_at = datetime('now') WHERE nonce IS NOT NULL`,
  );
}

describe("after the merge, the finish run walks the record to complete", () => {
  test("merged and minted: one finish dispatch, sent with both switches off, not repeated while live", async () => {
    const id = mergedRow("merged");
    versionRow(DS, "2.0.0");
    const off = env({ AUTO_REPULL_ENABLED: undefined, AUTO_REPULL_MERGE_ENABLED: undefined });
    const r = await tick(off);
    expect(r).toMatchObject({ examined: 1, finishes: 1, errors: [] });
    const [claim] = finishDispatches(id);
    expect(claim).toMatchObject({
      kind: "finish",
      status: "dispatched",
      repull_id: id,
      dataset_id: DS,
    });
    expect(sentRuns()).toEqual([
      {
        mode: "finish",
        dataset_id: DS,
        upstream_ds: `ds${DS.slice(2)}`,
        from_tag: "1.0.0",
        to_tag: "1.0.1",
        dispatch_id: String(claim?.id),
        dispatch_token: expect.any(String),
        cli_version: CLI,
        repull_id: String(id),
      },
    ]);
    expect(
      await verifyRepullDispatchToken(
        String(sentRuns()[0]?.dispatch_token),
        { dispatchId: claim?.id as number, datasetId: DS, nonce: claim?.nonce as string },
        SECRET,
      ),
    ).toBe(true);
    // A finish takes no unit of the open cap: its merge already minted the DOI the cap bounds.
    const again = await tick(off);
    expect(again).toMatchObject({ finishes: 0, running: 1 });
    expect(sentRuns()).toHaveLength(1);
    expect(datasetRequests()).toEqual([]);
  });

  test("the version is N.0.0 in either spelling, and only with its DOI", async () => {
    const id = mergedRow("merged");
    expect((await tick()).finishes).toBe(0);
    versionRow(DS, "v2.0.0", "");
    expect(await tick()).toMatchObject({ finishes: 0, notDue: 1 });
    db.run("UPDATE dataset_versions SET doi = ? WHERE dataset_id = ?", [
      `10.82901/nemar.${DS}.v2`,
      DS,
    ]);
    expect((await tick()).finishes).toBe(1);
    expect(finishDispatches(id)).toHaveLength(1);
  });

  test(`released: dispatched again while fewer than ${FINISH_DISPATCHES_MAX} ran, then finish-exhausted`, async () => {
    const id = mergedRow("released");
    for (let n = 1; n <= FINISH_DISPATCHES_MAX; n++) {
      expect((await tick()).finishes).toBe(1);
      runFailed();
    }
    const r = await tick();
    expect(r).toMatchObject({ finishes: 0, held: { "finish-exhausted": 1 } });
    expect(rowOf(id)).toMatchObject({ status: "released", hold_reason: "finish-exhausted" });
    expect(finishDispatches(id)).toHaveLength(FINISH_DISPATCHES_MAX);
  });

  test(`merged: the same bound, ${FINISH_DISPATCHES_MAX} finish dispatches and then finish-exhausted`, async () => {
    const id = mergedRow("merged");
    versionRow(DS, "2.0.0");
    for (let n = 1; n <= FINISH_DISPATCHES_MAX; n++) {
      expect((await tick()).finishes).toBe(1);
      runFailed();
    }
    const r = await tick();
    expect(r).toMatchObject({ finishes: 0, held: { "finish-exhausted": 1 } });
    expect(rowOf(id)).toMatchObject({ status: "merged", hold_reason: "finish-exhausted" });
    expect(finishDispatches(id)).toHaveLength(FINISH_DISPATCHES_MAX);
  });

  test("a send GitHub refuses for the dispatch spends an attempt; one turned away for the Worker does not", async () => {
    const id = mergedRow("released");
    gh.dispatchStatus = 422;
    expect((await tick()).errors).toEqual(["dispatch-refused"]);
    gh.dispatchStatus = 403;
    expect((await tick()).errors).toEqual(["dispatch-deferred"]);
    expect(finishDispatches(id).map((d) => [d.status, d.code])).toEqual([
      ["dispatch_failed", "dispatch-refused"],
      ["dispatch_failed", "dispatch-deferred"],
    ]);
    expect((db.query(FINISH_DISPATCHES_SQL).get(DS, id) as { finishes: number }).finishes).toBe(1);
  });

  test("a development build dispatches nothing", async () => {
    const id = mergedRow("released");
    const r = (await runRepullAdvanceCron(env(), {
      cliVersion: "0.10.26-dev3",
    })) as AdvanceTickResult;
    expect(r.errors).toEqual(["cli-unreleased"]);
    expect(finishDispatches(id)).toEqual([]);
    expect(gh.dispatches).toEqual([]);
  });

  test("an administrator's merged record is never finished by the Worker", async () => {
    const id = mergedRow("released", { origin: "administrator" });
    const r = await tick();
    expect(r.examined).toBe(0);
    expect(finishDispatches(id)).toEqual([]);
    const row = await getRepull(realD1(db), id);
    expect(
      await finishAfterMerge(env(), row as NonNullable<typeof row>, { cliVersion: CLI }),
    ).toEqual({
      kind: "skipped",
    });
  });

  for (const environment of ["development", "Production", undefined]) {
    test(`ENVIRONMENT=${JSON.stringify(environment)}: no finish`, async () => {
      const id = mergedRow("released");
      const row = await getRepull(realD1(db), id);
      const o = await finishAfterMerge(
        env({ ENVIRONMENT: environment }),
        row as NonNullable<typeof row>,
        {
          cliVersion: CLI,
        },
      );
      expect(o).toEqual({ kind: "skipped" });
      expect(finishDispatches(id)).toEqual([]);
      expect(gh.requests).toEqual([]);
    });
  }

  // The dispatch record's own claim refuses these too, so only "not one statement" shows that the
  // finish's own fences, and not the claim's, turned them away.
  for (const [name, over, environment] of [
    ["an administrator's merged record", { origin: "administrator" }, "production"],
    ["a record outside exact production", {}, "development"],
  ] as const) {
    test(`${name}: skipped before a single statement is prepared`, async () => {
      const id = mergedRow("released", over as Row);
      const prepared: string[] = [];
      const base = realD1(db);
      const counting = {
        prepare(sql: string) {
          prepared.push(sql);
          return base.prepare(sql);
        },
        batch: (s: never[]) => base.batch(s),
      } as unknown as D1Database;
      const row = await getRepull(base, id);
      const o = await finishAfterMerge(
        env({ ENVIRONMENT: environment }, counting),
        row as NonNullable<typeof row>,
        { cliVersion: CLI },
      );
      expect(o).toEqual({ kind: "skipped" });
      expect(prepared).toEqual([]);
    });
  }
});

describe("the rows past their gates share one rotation, five a tick", () => {
  const t0 = new Date(Date.UTC(2026, 9, 26, 8, 0, 0));
  const at = (halfHours: number) => new Date(t0.getTime() + halfHours * 30 * 60_000);
  const off = () => env({ AUTO_REPULL_MERGE_ENABLED: undefined });

  test("seven rows at gates_clear are read five a tick, and every one within two ticks", async () => {
    const ids = [1, 2, 3, 4, 5, 6, 7].map((i) => ready(`on0988${30 + i}`));
    const a = await runRepullAdvanceCron(off(), { cliVersion: CLI, now: at(0) });
    expect(a?.examined).toBe(5);
    const b = await runRepullAdvanceCron(off(), { cliVersion: CLI, now: at(1) });
    expect(b?.examined).toBe(5);
    expect(ids.every((id) => rowOf(id).hold_reason === "merge-switch-off")).toBe(true);
  });

  test("six held rows at gates_clear do not keep a merged row with a higher id from its finish", async () => {
    const held = [1, 2, 3, 4, 5, 6].map((i) => ready(`on0988${30 + i}`));
    const ds = "on098840";
    mirror(ds);
    const merged = seedRow(ds, "merged", {
      merge_claim_sha: HEAD,
      merge_claimed_at: "2026-10-25 03:00:00",
    });
    versionRow(ds, "2.0.0");
    expect(merged).toBeGreaterThan(Math.max(...held));
    const a = await runRepullAdvanceCron(off(), { cliVersion: CLI, now: at(0) });
    const b = await runRepullAdvanceCron(off(), { cliVersion: CLI, now: at(1) });
    expect([a?.examined, b?.examined]).toEqual([5, 5]);
    // The finish is the merged row's, sent once whichever of the two ticks reached it.
    expect((a?.finishes ?? 0) + (b?.finishes ?? 0)).toBe(1);
    expect(finishDispatches(merged)).toHaveLength(1);
    expect(sentRuns().map((p) => p.dataset_id)).toEqual([ds]);
    expect(held.every((id) => rowOf(id).hold_reason === "merge-switch-off")).toBe(true);
  });
});

describe("every audit resource id is compared as text", () => {
  // D1 can deliver a bound number as REAL, whose text is `5.0` and matches no `resource_id`;
  // SQLite under Bun coerces the number to the column's text, so only the bind's type shows it.
  test("each statement that compares resource_id is bound a string at that parameter", async () => {
    const id = ready();
    const seen = new Set<string>();
    const wrong: string[] = [];
    // The hook records rather than throws: the code under test catches some failures (an
    // answer's audit row), and a throw there would be swallowed.
    const watching = interceptingD1(realD1(db), (sql, binds) => {
      for (const m of sql.matchAll(/resource_id\s*=\s*\?(\d+)/g)) {
        seen.add(sql);
        if (typeof binds[Number(m[1]) - 1] !== "string") wrong.push(`${sql} ?${m[1]}`);
      }
    });
    gh.mergeAnswer = { status: 502 };
    // The claim, the merge's audit row, the merge and an answer that was lost.
    await tick(env({}, watching));
    gh.mergeAnswer = null;
    // The held claim: its owner and its merges are read, and the merge is sent again.
    await tick(env({}, watching));
    expect(wrong).toEqual([]);
    expect(seen).toEqual(new Set([WORKER_MERGE_SENT_SQL, WORKER_MERGES_SQL, CLAIM_OWNER_SQL]));
    expect(rowOf(id).merge_claim_sha).toBe(HEAD);
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
    expect(ids.every((id) => rowOf(id).status === "merged")).toBe(true);
    // Each version is minted, and each finish run is dispatched.
    for (const ds of datasets) versionRow(ds, "2.0.0");
    const finishing = await measure();
    // Per row: seven statements and four requests to wait (the record, the merges, the dataset,
    // the screen, the review, the hold and its audit row; the pull request, `main`, two checks);
    // sixteen and seven to merge (the same five reads and four requests, the claim's five
    // statements and its read of the live head, the merge's audit row, the merge, its answer, and
    // the verified route's four statements and its read of the merge); eight and one to dispatch a
    // finish (the record, its dispatches, the version, the claim's two and its read-back, the hold
    // and its audit row; the dispatch). Two for the tick.
    expect({ waiting, merging, finishing }).toEqual({
      waiting: { d1: 37, github: 20 },
      merging: { d1: 82, github: 35 },
      finishing: { d1: 42, github: 5 },
    });
    expect(ids.every((id) => finishDispatches(id).length === 1)).toBe(true);
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
          String(id),
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

  test("a record that moves before the merge's audit row is written: no row, no merge, the claim kept", async () => {
    const id = ready();
    // Another writer moves the record between the claim and the merge's audit row.
    const racing = interceptingD1(realD1(db), (sql) => {
      if (sql === WORKER_MERGE_SENT_SQL) {
        db.run("UPDATE upstream_repulls SET revision = revision + 1 WHERE id = ?", [id]);
      }
    });
    const r = await tick(env({}, racing));
    expect(r).toMatchObject({ mergesSent: 0, merged: 0 });
    expect(gh.merges).toEqual([]);
    expect(auditsOf(WORKER_MERGE_ACTION, id)).toEqual([]);
    // The claim waits for GitHub's word. Its hold names the revision it read, which moved, so the
    // next tick writes it.
    expect(rowOf(id)).toMatchObject({ status: "gates_clear", merge_claim_sha: HEAD });
  });
});
