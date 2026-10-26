/**
 * The facts the machine-clean rule reads, through `gatherMachineCleanFacts`, the entry point the
 * automatic path's ticks call (epic #1046 phase 7, #1913; ADR 0111, decision 7).
 *
 * Real engine: bun:sqlite behind realD1 with every migration applied, the real record, screen and
 * review rows, and a `Bun.serve()` stand-in for api.github.com (NEMAR_GITHUB_API_URL) that
 * answers the pull request, `main` and the check runs and records every request. The happy path
 * runs against the stand-in too (the Phase 6 stand-in ruling), so these beliefs about GitHub are
 * checked only by the first production runs: that `check-runs` honors `check_name`, `app_id` and
 * `filter=latest` as the stand-in does (measured on 2026-10-25 against `nm000527#1`, read only),
 * that the App's token reads `mergeable_state` as an administrator does, and that GitHub names the
 * App's pull request author `nemar-publish-bot[bot]` with id 283755542.
 *
 * Each fact is flipped alone, at its source (a GitHub answer or a row), and must give its own hold
 * word; every way of not knowing a fact (404, 500, a timeout, a shape, no row) must hold.
 */

import type { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { parseScreenReport } from "../../shared/identifier-screen-report";
import { NEMAR_APP_BOT_LOGIN, NEMAR_APP_BOT_USER_ID, NEMAR_APP_ID } from "../../shared/nemar-app";
import { type MachineCleanStage, machineClean } from "../../shared/repull-machine-clean";
import type { RepullStatus } from "../../shared/repull-state";
import { __resetRateLimitStateForTests } from "../src/services/github/transport";
import { IMPORT_STATUSES, TERMINAL_IMPORT_STATUSES } from "../src/services/import-recovery";
import { getRepull } from "../src/services/upstream-repull";
import {
  SETTLED_IMPORT_STATUSES,
  gatherMachineCleanFacts,
  readReviewFact,
  readScreenFact,
} from "../src/services/upstream-repull-facts";
import { __setRepullGitHubReadTimeoutForTests } from "../src/services/upstream-repull-github";
import type { Bindings } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";
import { goodReport, seedReview } from "./helpers/pr-queue-fixtures";
import {
  type CheckRunAnswer,
  type PullAnswer,
  type RepullGitHub,
  startRepullGitHub,
} from "./helpers/repull-github-standin";
import { type Row, rowAt } from "./helpers/repull-rows";

const DS = "on004362";
const UPSTREAM = "ds004362";
const HEAD = "0123456789abcdef0123456789abcdef01234567";
const BASE = "89abcdef0123456789abcdef0123456789abcdef";
const OTHER = "fedcba9876543210fedcba9876543210fedcba98";
const GITHUB_ACTIONS = 15368;

let gh: RepullGitHub;
let db: Database;
let adminId = 0;
let repullId = 0;

beforeAll(() => {
  gh = startRepullGitHub();
});

afterAll(() => gh.stop());

beforeEach(() => {
  db = freshDb();
  db.run(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified)
     VALUES ('rpfadmin', 'rpfadmin@example.org', 'x', 'approved', 'admin', 1)`,
  );
  adminId = (db.query("SELECT id FROM users WHERE username = 'rpfadmin'").get() as { id: number })
    .id;
  db.run(
    `INSERT INTO datasets (dataset_id, name, owner_user_id, source, source_id, anonymous, status,
                           visibility, first_published_at)
     VALUES (?, ?, ?, 'openneuro', ?, 0, 'active', 'public', '2026-01-01 00:00:00')`,
    [DS, `A sufficiently descriptive title for ${DS}`, adminId, UPSTREAM],
  );
  repullId = seedRepull("pr_open");
  markScreen("clean");
  seedReview(db, {
    ds: DS,
    n: 7,
    sha: HEAD,
    state: "reported",
    verdict: "pass",
    login: NEMAR_APP_BOT_LOGIN,
    authorId: NEMAR_APP_BOT_USER_ID,
  });
  gh.pulls[`${DS}#7`] = appPull();
  gh.mainRefs[DS] = BASE;
  gh.checkRuns[`${DS}@${HEAD}`] = greenRuns();
  __resetRateLimitStateForTests();
});

afterEach(() => {
  gh.reset();
  __setRepullGitHubReadTimeoutForTests(null);
});

function env(over: Partial<Bindings> = {}): Bindings {
  return {
    DB: realD1(db),
    ENVIRONMENT: "production",
    AUTO_REPULL_ENABLED: "1",
    AUTO_REPULL_MERGE_ENABLED: "1",
    GITHUB_ADMIN_PAT: "ghp_repull_facts_test",
    ...over,
  } as Bindings;
}

/** The automatic record of a re-pull of DS at `status`, its head HEAD on BASE; its id. */
function seedRepull(status: RepullStatus, over: Row = {}): number {
  const row = rowAt(status, {
    dataset_id: DS,
    upstream_ds: UPSTREAM,
    origin: "automatic",
    planner: 2,
    actor_user_id: adminId,
    head_sha: HEAD,
    base_sha: BASE,
    counts: JSON.stringify({ unexplained: 0, conflicts: 0, corrections: 0, copy_bytes: 1024 }),
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

/** A scan report of DS at `head`, as the screen's callback stores it. */
function scanReport(head: string, status: string) {
  return parseScreenReport({
    version: 1,
    scanner: "identifier-scan@abcdef1",
    head,
    scan: {
      id: DS,
      version: null,
      scanned_at: "2026-10-24T12:00:00.000Z",
      manifest_source: "clone",
      status,
      incomplete: status === "unchecked",
      incomplete_reasons: status === "unchecked" ? ["edf-headers-unread"] : [],
      files: { total: 10, edf_bdf: 4, header_read: 4, header_read_failed: 0 },
    },
  });
}

/** Store the screen of HEAD as its callback leaves it, replacing any earlier one. */
function markScreen(
  status: string,
  o: { reportHead?: string; ack?: boolean; dispatchedAt?: string } = {},
): void {
  db.run("DELETE FROM upstream_repull_screens WHERE repull_id = ?", [repullId]);
  if (status === "pending") {
    db.run(
      `INSERT INTO upstream_repull_screens (repull_id, pr, sha, status, nonce, dispatched_at)
       VALUES (?, 'n0', ?, 'pending', 'nonce-1', COALESCE(?, datetime('now')))`,
      [repullId, HEAD, o.dispatchedAt ?? null],
    );
    return;
  }
  const report =
    status === "error"
      ? { version: 1, scanner: null, head: null, error: "workflow-failed" }
      : scanReport(o.reportHead ?? HEAD, status);
  db.run(
    `INSERT INTO upstream_repull_screens (repull_id, pr, sha, status, report, reported_at,
                                          ack_by, ack_reason, ack_at)
     VALUES (?, 'n0', ?, ?, ?, datetime('now'), ?, ?, ?)`,
    [
      repullId,
      HEAD,
      status,
      JSON.stringify(report),
      o.ack ? adminId : null,
      o.ack ? "Looked at every flagged header by hand." : null,
      o.ack ? "2026-10-25 00:00:00" : null,
    ],
  );
}

/** The App's pull request #7 of DS at HEAD, open and clean, from the release branch into main. */
function appPull(over: Partial<PullAnswer> = {}): PullAnswer {
  return {
    state: "open",
    draft: false,
    merged: false,
    user: { login: NEMAR_APP_BOT_LOGIN, id: NEMAR_APP_BOT_USER_ID, type: "Bot" },
    head: { sha: HEAD, ref: "release/v2.0.0", repo: { full_name: `nemarDatasets/${DS}` } },
    base: { ref: "main", repo: { full_name: `nemarDatasets/${DS}` } },
    mergeable_state: "clean",
    ...over,
  };
}

/** Both checks green, the App's own, beside the shims' own job runs (GitHub Actions'). */
function greenRuns(): CheckRunAnswer[] {
  return [
    {
      id: 20,
      name: "Run BIDS Validation",
      status: "completed",
      conclusion: "success",
      app_id: NEMAR_APP_ID,
    },
    {
      id: 21,
      name: "version-check",
      status: "completed",
      conclusion: "success",
      app_id: NEMAR_APP_ID,
    },
    {
      id: 18,
      name: "Dispatch central BIDS validation",
      status: "completed",
      conclusion: "success",
      app_id: GITHUB_ACTIONS,
    },
    {
      id: 19,
      name: "Dispatch central version check",
      status: "completed",
      conclusion: "success",
      app_id: GITHUB_ACTIONS,
    },
  ];
}

/** Replace the runs named `name` with `runs`. */
function setRuns(name: string, runs: Array<Partial<CheckRunAnswer>>, sha = HEAD): void {
  const kept = (gh.checkRuns[`${DS}@${sha}`] as CheckRunAnswer[]).filter((r) => r.name !== name);
  gh.checkRuns[`${DS}@${sha}`] = [
    ...kept,
    ...runs.map((r, i) => ({
      id: 100 + i,
      name,
      status: "completed",
      conclusion: "success",
      app_id: NEMAR_APP_ID,
      ...r,
    })),
  ];
}

/** The dataset's import, at `status`. */
function importAt(status: string): void {
  db.run(
    "INSERT INTO import_jobs (dataset_id, source, source_id, status) VALUES (?, 'openneuro', ?, ?)",
    [DS, UPSTREAM, status],
  );
}

/** Gather the facts of the record as it is now, and ask the rule. */
async function decide(stage: MachineCleanStage = "gates", over: Partial<Bindings> = {}) {
  const row = await getRepull(realD1(db), repullId);
  if (!row) throw new Error("no record");
  const facts = await gatherMachineCleanFacts(env(over), row, stage);
  const verdict = machineClean(facts);
  return { facts, hold: verdict.clean ? "clean" : verdict.hold };
}

const githubReads = () => gh.requests.filter((r) => r.startsWith("GET /repos/nemarDatasets/"));

describe("a clean automatic re-pull", () => {
  test("is machine clean at the gates, from four GitHub reads and the record", async () => {
    const { hold } = await decide();
    expect(hold).toBe("clean");
    expect(githubReads().sort()).toEqual(
      [
        `GET /repos/nemarDatasets/${DS}/commits/${HEAD}/check-runs`,
        `GET /repos/nemarDatasets/${DS}/commits/${HEAD}/check-runs`,
        `GET /repos/nemarDatasets/${DS}/git/ref/heads/main`,
        `GET /repos/nemarDatasets/${DS}/pulls/7`,
      ].sort(),
    );
    // Each check is asked for by its name, from the App only, the latest run.
    const asked = gh.urls.filter((u) => u.includes("/check-runs?"));
    expect(asked).toHaveLength(2);
    for (const u of asked) {
      const q = new URL(`http://x${u.slice(u.indexOf(" ") + 1)}`).searchParams;
      expect(q.get("app_id")).toBe(String(NEMAR_APP_ID));
      expect(q.get("filter")).toBe("latest");
    }
    expect(
      asked.map((u) => new URL(`http://x${u.slice(4)}`).searchParams.get("check_name")).sort(),
    ).toEqual(["Run BIDS Validation", "version-check"]);
  });

  test("is machine clean at the merge, read at the screened head", async () => {
    db.run("DELETE FROM upstream_repulls");
    repullId = seedRepull("gates_clear");
    markScreen("clean");
    expect((await decide("merge")).hold).toBe("clean");
  });
});

describe("each fact, flipped alone at its source, holds with its own word", () => {
  const cases: Array<[string, () => void, string, MachineCleanStage?]> = [
    [
      "the record is an administrator's",
      () => db.run("UPDATE upstream_repulls SET origin = 'administrator'"),
      "not-automatic",
    ],
    [
      "the plan stated a correction",
      () =>
        db.run(
          `UPDATE upstream_repulls SET counts = '{"unexplained":0,"conflicts":0,"corrections":2}'`,
        ),
      "has-corrections",
    ],
    [
      "the plan left a count out",
      () => db.run(`UPDATE upstream_repulls SET counts = '{"unexplained":0,"conflicts":0}'`),
      "has-corrections",
    ],
    [
      "the record has an N.0.1",
      () => db.run("UPDATE upstream_repulls SET patch_version = '2.0.1'"),
      "has-corrections",
    ],
    [
      "the dataset became anonymous",
      () => db.run("UPDATE datasets SET first_published_at = NULL, anonymous = 1"),
      "dataset-anonymous",
    ],
    ["the dataset row is gone", () => db.run("DELETE FROM datasets"), "dataset-anonymous"],
    [
      "the dataset was withdrawn",
      () => db.run("UPDATE datasets SET withdrawn_at = datetime('now')"),
      "dataset-withdrawn",
    ],
    [
      "an import is preparing",
      () =>
        db.run(
          `INSERT INTO import_jobs (dataset_id, source, source_id, status) VALUES ('${DS}', 'openneuro', '${UPSTREAM}', 'preparing')`,
        ),
      "import-in-flight",
    ],
    ["an import the retry engine is repairing", () => importAt("incomplete"), "import-in-flight"],
    ["an import in a status nobody declared", () => importAt("resuming"), "import-in-flight"],
    [
      "the dataset mirrors another ds",
      () => db.run("UPDATE datasets SET source_id = 'ds000001'"),
      "dataset-not-mirror",
    ],
    [
      "GitHub has no such pull request",
      () => {
        delete gh.pulls[`${DS}#7`];
      },
      "pr-unreadable",
    ],
    [
      "the pull request's answer is malformed",
      () => {
        gh.pulls[`${DS}#7`] = appPull({ omit: ["user"] });
      },
      "pr-unreadable",
    ],
    [
      "the pull request was closed",
      () => {
        gh.pulls[`${DS}#7`] = appPull({ state: "closed" });
      },
      "pr-closed",
    ],
    [
      "the pull request was merged",
      () => {
        gh.pulls[`${DS}#7`] = appPull({ state: "closed", merged: true });
      },
      "pr-closed",
    ],
    [
      "it comes from another branch",
      () => {
        gh.pulls[`${DS}#7`] = appPull({
          head: { sha: HEAD, ref: "release/v3.0.0", repo: { full_name: `nemarDatasets/${DS}` } },
        });
      },
      "pr-mismatch",
    ],
    [
      "it aims at another base",
      () => {
        gh.pulls[`${DS}#7`] = appPull({
          base: { ref: "dev", repo: { full_name: `nemarDatasets/${DS}` } },
        });
      },
      "pr-mismatch",
    ],
    [
      "its head is a fork",
      () => {
        gh.pulls[`${DS}#7`] = appPull({
          head: { sha: HEAD, ref: "release/v2.0.0", repo: { full_name: `someone/${DS}` } },
        });
      },
      "pr-mismatch",
    ],
    [
      "its head is a deleted fork",
      () => {
        gh.pulls[`${DS}#7`] = appPull({ head: { sha: HEAD, ref: "release/v2.0.0", repo: null } });
      },
      "pr-mismatch",
    ],
    // GitHub always names both repositories; one not named, or not as a name, is unreadable.
    [
      "the head's repository is not named",
      () => {
        gh.pulls[`${DS}#7`] = appPull({
          head: { sha: HEAD, ref: "release/v2.0.0", repo: undefined },
        });
      },
      "pr-unreadable",
    ],
    [
      "the head's repository has no name",
      () => {
        gh.pulls[`${DS}#7`] = appPull({
          head: { sha: HEAD, ref: "release/v2.0.0", repo: {} as never },
        });
      },
      "pr-unreadable",
    ],
    [
      "the base's repository is not named",
      () => {
        gh.pulls[`${DS}#7`] = appPull({ base: { ref: "main", repo: undefined } });
      },
      "pr-unreadable",
    ],
    [
      "the base's repository is named by a number",
      () => {
        gh.pulls[`${DS}#7`] = appPull({ base: { ref: "main", repo: { full_name: 5 as never } } });
      },
      "pr-unreadable",
    ],
    [
      "GitHub answers for another number",
      () => {
        gh.pulls[`${DS}#7`] = appPull({ number: 8 });
      },
      "pr-mismatch",
    ],
    [
      "it was made a draft",
      () => {
        gh.pulls[`${DS}#7`] = appPull({ draft: true });
      },
      "pr-draft",
    ],
    [
      "another bot opened it",
      () => {
        gh.pulls[`${DS}#7`] = appPull({
          user: { login: "dependabot[bot]", id: 49699333, type: "Bot" },
        });
      },
      "pr-not-app",
    ],
    [
      "the App's login with another id",
      () => {
        gh.pulls[`${DS}#7`] = appPull({ user: { login: NEMAR_APP_BOT_LOGIN, id: 1, type: "Bot" } });
      },
      "pr-not-app",
    ],
    [
      "the App's login and id, as a user",
      () => {
        gh.pulls[`${DS}#7`] = appPull({
          user: { login: NEMAR_APP_BOT_LOGIN, id: NEMAR_APP_BOT_USER_ID, type: "User" },
        });
      },
      "pr-not-app",
    ],
    [
      "its head moved",
      () => {
        gh.pulls[`${DS}#7`] = appPull({
          head: { sha: OTHER, ref: "release/v2.0.0", repo: { full_name: `nemarDatasets/${DS}` } },
        });
      },
      "head-moved",
    ],
    [
      "main cannot be read",
      () => {
        gh.mainRefs[DS] = 500;
      },
      "main-unreadable",
    ],
    [
      "main is not there",
      () => {
        delete gh.mainRefs[DS];
      },
      "main-unreadable",
    ],
    [
      "main moved",
      () => {
        gh.mainRefs[DS] = OTHER;
      },
      "main-moved",
    ],
    [
      "the checks cannot be read",
      () => {
        gh.checkRuns[`${DS}@${HEAD}`] = 502;
      },
      "checks-unreadable",
    ],
    ["BIDS validation never ran", () => setRuns("Run BIDS Validation", []), "bids-pending"],
    [
      "BIDS validation is running",
      () => setRuns("Run BIDS Validation", [{ status: "in_progress", conclusion: null }]),
      "bids-pending",
    ],
    [
      "BIDS validation is queued",
      () => setRuns("Run BIDS Validation", [{ status: "queued", conclusion: null }]),
      "bids-pending",
    ],
    [
      "BIDS validation failed",
      () => setRuns("Run BIDS Validation", [{ conclusion: "failure" }]),
      "bids-failed",
    ],
    [
      "BIDS validation was neutral",
      () => setRuns("Run BIDS Validation", [{ conclusion: "neutral" }]),
      "bids-failed",
    ],
    [
      "only another App posted BIDS validation",
      () => setRuns("Run BIDS Validation", [{ app_id: GITHUB_ACTIONS }]),
      "bids-pending",
    ],
    ["the version check never ran", () => setRuns("version-check", []), "version-check-pending"],
    [
      "the version check failed",
      () => setRuns("version-check", [{ conclusion: "failure" }]),
      "version-check-failed",
    ],
    [
      "the version check was skipped",
      () => setRuns("version-check", [{ conclusion: "skipped" }]),
      "version-check-failed",
    ],
    ["the screen is running", () => markScreen("pending"), "screen-pending"],
    [
      "the screen never reported",
      () => markScreen("pending", { dispatchedAt: "2026-01-01 00:00:00" }),
      "screen-unreported",
    ],
    ["the screen asks for a person", () => markScreen("review"), "screen-acknowledge"],
    [
      "the screen asks for a person, and one answered",
      () => markScreen("review", { ack: true }),
      "screen-acknowledge",
    ],
    ["the screen could not read EDF only", () => markScreen("not-screened"), "screen-acknowledge"],
    [
      "the screen found a direct identifier",
      () => markScreen("direct-identifiers"),
      "screen-blocks",
    ],
    ["the screen was unchecked", () => markScreen("unchecked"), "screen-unchecked"],
    [
      "the head was never screened",
      () => db.run("DELETE FROM upstream_repull_screens"),
      "screen-rerun",
    ],
    ["the screen errored", () => markScreen("error"), "screen-error"],
    [
      "the clear verdict names another head",
      () => markScreen("clean", { reportHead: OTHER }),
      "screen-unreadable",
    ],
    ["the head was never reviewed", () => db.run("DELETE FROM pr_reviews"), "review-absent"],
    [
      "the review is running",
      () =>
        db.run(
          "UPDATE pr_reviews SET state = 'dispatched', verdict = NULL, report = NULL, decided_at = NULL",
        ),
      "review-running",
    ],
    [
      "the review failed",
      () =>
        db.run(
          `UPDATE pr_reviews SET verdict = 'fail', report = '${JSON.stringify(goodReport({ no_degradation: "fail" }))}'`,
        ),
      "review-not-pass",
    ],
    [
      "the review could not decide",
      () =>
        db.run(
          "UPDATE pr_reviews SET state = 'errored', detail = 'model_unavailable', verdict = NULL, report = NULL",
        ),
      "review-not-pass",
    ],
    [
      "the review was declined",
      () =>
        db.run(
          "UPDATE pr_reviews SET state = 'declined', detail = 'contributor_paused', verdict = NULL, report = NULL",
        ),
      "review-not-pass",
    ],
    [
      "the review never reported",
      () => db.run("UPDATE pr_reviews SET state = 'unreported', verdict = NULL, report = NULL"),
      "review-not-pass",
    ],
    [
      "GitHub has not computed mergeability",
      () => {
        gh.pulls[`${DS}#7`] = appPull({ mergeable_state: "unknown" });
      },
      "not-clean",
    ],
    [
      "GitHub names no mergeable state",
      () => {
        gh.pulls[`${DS}#7`] = appPull({ mergeable_state: null });
      },
      "not-clean",
    ],
    [
      "GitHub says blocked",
      () => {
        gh.pulls[`${DS}#7`] = appPull({ mergeable_state: "blocked" });
      },
      "not-clean",
    ],
    [
      "GitHub says unstable",
      () => {
        gh.pulls[`${DS}#7`] = appPull({ mergeable_state: "unstable" });
      },
      "not-clean",
    ],
  ];

  for (const [name, flip, word] of cases) {
    test(`${name}: ${word}`, async () => {
      flip();
      expect((await decide()).hold).toBe(word);
    });
  }
});

describe("an import holds the re-pull until it has settled", () => {
  test("a settled import does not hold it", async () => {
    for (const status of SETTLED_IMPORT_STATUSES) {
      db.run("DELETE FROM import_jobs");
      importAt(status);
      expect([status, (await decide()).hold]).toEqual([status, "clean"]);
    }
  });

  test("every import status is either settled or holds, and the settled ones are real words", () => {
    // `import-recovery.ts` mails, so the facts reader keeps its own list; this keeps the two in step.
    for (const s of SETTLED_IMPORT_STATUSES) expect(IMPORT_STATUSES as string[]).toContain(s);
    for (const s of TERMINAL_IMPORT_STATUSES)
      expect([s, SETTLED_IMPORT_STATUSES.has(s)]).toEqual([s, true]);
    const holding = IMPORT_STATUSES.filter((s) => !SETTLED_IMPORT_STATUSES.has(s));
    expect(holding.sort()).toEqual(["copying", "finalizing", "incomplete", "preparing"]);
  });
});

describe("the switches and the record decide before GitHub is asked", () => {
  /** A D1 that counts what it is asked to prepare. */
  function countingDb(): { d1: D1Database; prepared: () => number } {
    const real = realD1(db);
    let n = 0;
    const d1 = {
      ...real,
      prepare(sql: string) {
        n++;
        return real.prepare(sql);
      },
      batch: real.batch.bind(real),
    } as unknown as D1Database;
    return { d1, prepared: () => n };
  }

  const offCases: Array<[string, Partial<Bindings>, string, MachineCleanStage]> = [
    ["ENVIRONMENT unset", { ENVIRONMENT: undefined }, "not-production", "gates"],
    ["ENVIRONMENT dev", { ENVIRONMENT: "dev" }, "not-production", "gates"],
    ["ENVIRONMENT Production", { ENVIRONMENT: "Production" }, "not-production", "gates"],
    ["the open switch unset", { AUTO_REPULL_ENABLED: undefined }, "switch-off", "gates"],
    ["the open switch true", { AUTO_REPULL_ENABLED: "true" }, "switch-off", "gates"],
    [
      "the merge switch unset, at the merge",
      { AUTO_REPULL_MERGE_ENABLED: undefined },
      "merge-switch-off",
      "merge",
    ],
  ];
  for (const [name, over, word, stage] of offCases) {
    test(`${name}: ${word}, and nothing is read, the database included`, async () => {
      const row = await getRepull(realD1(db), repullId);
      const counting = countingDb();
      const facts = await gatherMachineCleanFacts(
        { ...env(over), DB: counting.d1 },
        row as NonNullable<typeof row>,
        stage,
      );
      const v = machineClean(facts);
      expect(v.clean ? "clean" : v.hold).toBe(word);
      expect(gh.requests).toEqual([]);
      expect(counting.prepared()).toBe(0);
    });
  }

  test("the merge switch is not read at the gates", async () => {
    expect((await decide("gates", { AUTO_REPULL_MERGE_ENABLED: undefined })).hold).toBe("clean");
  });

  test("a record or a dataset the rule refuses asks GitHub nothing", async () => {
    db.run("UPDATE upstream_repulls SET origin = 'administrator'");
    expect((await decide()).hold).toBe("not-automatic");
    db.run("UPDATE upstream_repulls SET origin = 'automatic'");
    db.run("UPDATE datasets SET withdrawn_at = datetime('now')");
    expect((await decide()).hold).toBe("dataset-withdrawn");
    expect(gh.requests).toEqual([]);
  });
});

describe("GitHub that cannot be read is never clean", () => {
  test("a 500 on the pull request is unreadable", async () => {
    gh.pulls[`${DS}#7`] = { status: 500 };
    expect((await decide()).hold).toBe("pr-unreadable");
  });

  test("a pull request that never answers is unreadable", async () => {
    __setRepullGitHubReadTimeoutForTests(100);
    gh.slow = "/pulls/7";
    expect((await decide()).hold).toBe("pr-unreadable");
  });

  test("a 404 on the checks is unreadable, not absent", async () => {
    gh.checkRuns[`${DS}@${HEAD}`] = 404;
    expect((await decide()).hold).toBe("checks-unreadable");
  });

  test("checks that never answer are unreadable", async () => {
    __setRepullGitHubReadTimeoutForTests(100);
    gh.slow = "/check-runs";
    expect((await decide()).hold).toBe("checks-unreadable");
  });

  test("a page of check runs that is not all of them is unreadable", async () => {
    gh.checkTotalCount = 101;
    expect((await decide()).hold).toBe("checks-unreadable");
  });

  test("a check run of an unknown status is unreadable", async () => {
    setRuns("version-check", [{ status: "paused", conclusion: null }]);
    expect((await decide()).hold).toBe("checks-unreadable");
  });

  test("main that never answers is unreadable", async () => {
    __setRepullGitHubReadTimeoutForTests(100);
    gh.slow = "/git/ref/";
    expect((await decide()).hold).toBe("main-unreadable");
  });
});

describe("a record that cannot be read is never clean", () => {
  /** The real database, with every statement whose SQL holds `needle` refused at prepare. */
  function refusing(needle: string): D1Database {
    const real = realD1(db);
    return {
      ...real,
      prepare(sql: string) {
        if (sql.includes(needle)) throw new Error("D1_ERROR: injected fault");
        return real.prepare(sql);
      },
      batch: real.batch.bind(real),
    } as unknown as D1Database;
  }

  /** Write a row as a writer that skips the schema's CHECKs would leave it. */
  function unchecked(write: () => void): void {
    db.run("PRAGMA ignore_check_constraints = ON");
    try {
      write();
    } finally {
      db.run("PRAGMA ignore_check_constraints = OFF");
    }
  }

  test("a screen table that cannot be read holds screen-unreadable", async () => {
    db.run("DROP TABLE upstream_repull_screens");
    expect((await decide()).hold).toBe("screen-unreadable");
  });

  test("a review table that cannot be read holds review-unreadable", async () => {
    db.run("DROP TABLE pr_reviews");
    expect((await decide()).hold).toBe("review-unreadable");
  });

  test("a dataset that cannot be read holds as anonymous, and GitHub is asked nothing", async () => {
    const row = await getRepull(realD1(db), repullId);
    const facts = await gatherMachineCleanFacts(
      { ...env(), DB: refusing("FROM datasets d LEFT JOIN import_jobs") },
      row as NonNullable<typeof row>,
      "gates",
    );
    const v = machineClean(facts);
    expect(v.clean ? "clean" : v.hold).toBe("dataset-anonymous");
    expect(facts.dataset.anonymous).toBeNull();
    expect(gh.requests).toEqual([]);
  });

  test("a screen in a state the vocabulary does not know is unreadable", async () => {
    unchecked(() => db.run("UPDATE upstream_repull_screens SET status = 'bogus'"));
    expect(await readScreenFact(realD1(db), { id: repullId, dataset_id: DS }, HEAD)).toBe(
      "unreadable",
    );
    expect((await decide()).hold).toBe("screen-unreadable");
  });

  test("a review in a state the vocabulary does not know is unreadable, whatever its verdict", async () => {
    // A pass with a report that re-derives a pass: only the state is wrong.
    unchecked(() => db.run("UPDATE pr_reviews SET state = 'foo'"));
    expect(await readReviewFact(realD1(db), DS, 7, HEAD)).toBe("unreadable");
    expect((await decide()).hold).toBe("review-unreadable");
  });
});

describe("the check runs are the App's own, the latest of each", () => {
  test("another App's run of the same name is not read, even when GitHub ignores the filter", async () => {
    // A failing App run and a passing GitHub Actions run of the same name: only the App's counts.
    setRuns("Run BIDS Validation", [
      { id: 300, conclusion: "failure" },
      { id: 301, conclusion: "success", app_id: GITHUB_ACTIONS },
    ]);
    gh.checkFiltersIgnored = true;
    expect((await decide()).hold).toBe("bids-failed");
    // And with only the other App's passing run, BIDS validation has not run at all.
    setRuns("Run BIDS Validation", [{ id: 302, conclusion: "success", app_id: GITHUB_ACTIONS }]);
    expect((await decide()).hold).toBe("bids-pending");
  });

  test("a run on another commit is not read", async () => {
    gh.checkFiltersIgnored = true;
    setRuns("version-check", [{ conclusion: "success", head_sha: OTHER }]);
    expect((await decide()).hold).toBe("version-check-pending");
  });

  test("a re-run's latest result is the one read", async () => {
    gh.checkFiltersIgnored = true;
    setRuns("Run BIDS Validation", [
      { id: 400, conclusion: "failure" },
      { id: 401, conclusion: "success" },
    ]);
    expect((await decide()).hold).toBe("clean");
    setRuns("Run BIDS Validation", [
      { id: 401, conclusion: "success" },
      { id: 402, conclusion: "failure" },
    ]);
    expect((await decide()).hold).toBe("bids-failed");
  });
});

describe("the review, read as the stricter of its two verdicts", () => {
  const fact = () => readReviewFact(realD1(db), DS, 7, HEAD);

  test("a stored pass whose report re-derives a fail is a fail", async () => {
    db.run("UPDATE pr_reviews SET report = ?", [
      JSON.stringify(goodReport({ no_degradation: "fail" })),
    ]);
    expect(await fact()).toBe("fail");
    expect((await decide()).hold).toBe("review-not-pass");
  });

  test("a stored fail whose report re-derives a pass is a fail", async () => {
    db.run("UPDATE pr_reviews SET verdict = 'fail'");
    expect(await fact()).toBe("fail");
  });

  test("a stored report that no longer parses is an error, not a pass", async () => {
    db.run(`UPDATE pr_reviews SET report = '{"v":99}'`);
    expect(await fact()).toBe("error");
    expect((await decide()).hold).toBe("review-not-pass");
  });

  test("a review of another head, or of another pull request, is no review of this one", async () => {
    db.run("UPDATE pr_reviews SET head_sha = ?", [OTHER]);
    expect(await fact()).toBe("absent");
    db.run("UPDATE pr_reviews SET head_sha = ?, pr_number = 8", [HEAD]);
    expect(await fact()).toBe("absent");
  });

  test("a pass reset between two decisions is read as it is now", async () => {
    expect((await decide()).hold).toBe("clean");
    // What `nemar admin pr-reviews start --redo` writes when it restarts a reported review.
    db.run(
      "UPDATE pr_reviews SET state = 'dispatched', verdict = NULL, report = NULL, decided_at = NULL, nonce = 'n2'",
    );
    expect((await decide()).hold).toBe("review-running");
  });
});

describe("the screen, read for the head and never acknowledged", () => {
  test("an `xx` dataset's screen is exempt, which is never clear", async () => {
    expect(await readScreenFact(realD1(db), { id: repullId, dataset_id: "xx090123" }, HEAD)).toBe(
      "exempt",
    );
  });

  test("a clear verdict for another head is not this head's", async () => {
    expect(await readScreenFact(realD1(db), { id: repullId, dataset_id: DS }, OTHER)).toBe(
      "absent",
    );
  });
});

describe("the merge stage", () => {
  beforeEach(() => {
    db.run("DELETE FROM upstream_repull_screens");
    db.run("DELETE FROM upstream_repulls");
    repullId = seedRepull("gates_clear");
    markScreen("clean");
  });

  test("the merge holds when the gates screened another head than GitHub's", async () => {
    db.run("UPDATE upstream_repulls SET gates_sha = ?", [OTHER]);
    expect((await decide("merge")).hold).toBe("head-moved");
  });

  test("the merge reads the checks, the screen and the review at the screened head", async () => {
    // A screened head that is not the recorded one holds, and is still the head that is read.
    db.run("UPDATE upstream_repulls SET gates_sha = ?", [OTHER]);
    const { facts } = await decide("merge");
    expect(githubReads()).toContain(`GET /repos/nemarDatasets/${DS}/commits/${OTHER}/check-runs`);
    expect(githubReads()).not.toContain(
      `GET /repos/nemarDatasets/${DS}/commits/${HEAD}/check-runs`,
    );
    // HEAD's screen and review exist; OTHER has neither.
    expect(facts.screen).toBe("absent");
    expect(facts.review).toBe("absent");
  });
});
