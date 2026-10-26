/**
 * The automatic re-pull's advance tick (epic #1046 phase 7, #1913; ADR 0111, decisions 6 and 7),
 * through its real entry point, `runRepullAdvanceCron`, which the production 30-minute tick calls.
 *
 * Real engine only: bun:sqlite behind realD1 with every migration applied, the real record, its
 * transitions, the machine-clean facts and rule, the screen bound to the row and the ADR 0107
 * review's own start. A `Bun.serve()` stand-in for api.github.com (`helpers/repull-github-standin.ts`,
 * through NEMAR_GITHUB_API_URL) answers the pull request, `main`, the check runs, the review's check
 * and comment writes and every dispatch, and records each request; no dataset id here is asked of
 * the real GitHub. The happy paths run against the stand-in as well, as in every re-pull suite: the
 * organization is shared with production, so no suite asks the real GitHub, and what GitHub itself
 * answers is checked only by the first production runs. The Resend capture is armed around every
 * test and must stay empty.
 *
 * The properties, each with a test that fails when its line is changed:
 *  - outside ENVIRONMENT exactly `production` nothing is read, written or sent;
 *  - with the open switch not exactly "1" GitHub is asked nothing, and the row says `switch-off`;
 *  - a hold is the first rule that does not hold, written once per change of word with one audit
 *    row, never over a row that moved, and ended by an edge into another status;
 *  - an administrator's row is never read, and a tick reads at most five rows of each kind, in two
 *    rotations, every stalled row inside the resume window;
 *  - the screen of the head is started once every rule before the screen holds, at most three
 *    times a head, and the review only behind a clear screen, a refusal of it said by its reason;
 *  - only a clean verdict writes `pr_open -> gates_clear`, as the system user, with the head, and a
 *    refused edge holds `gates-refused`;
 *  - a stalled row is resumed inside the window, once quiet, under the open cap and within three
 *    open dispatches, and every refusal or failure on the way is a word in the result.
 */

import type { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { parseScreenReport } from "../../shared/identifier-screen-report";
import { NEMAR_APP_BOT_LOGIN, NEMAR_APP_BOT_USER_ID, NEMAR_APP_ID } from "../../shared/nemar-app";
import {
  DISPATCH_CODES,
  type DispatchRow,
  FIXED_WORD_RE,
  REPULL_SCHEDULER_OUTCOMES,
  type RepullStatus,
} from "../../shared/repull-state";
import { SYSTEM_USER_ID } from "../src/lib/constants";
import { verifyRepullDispatchToken } from "../src/services/github";
import { __resetRateLimitStateForTests } from "../src/services/github/transport";
import {
  CREATE_FACTS_SQL,
  REPULL_BY_ID_SQL,
  getRepull,
  isRefusal,
  transitionRepull,
} from "../src/services/upstream-repull";
import {
  ADVANCE_FAILURES,
  ADVANCE_ROWS_PER_TICK,
  ADVANCE_ROWS_SQL,
  ADVANCE_TICK_MINUTES,
  AUTOMATIC_OPEN_DISPATCHES_MAX,
  AUTOMATIC_SCREENS_MAX,
  type AdvanceTickResult,
  REPULL_HOLD_SQL,
  RESUME_QUIET_MINUTES,
  RESUME_WINDOW_UTC,
  REVIEW_RETRY_MINUTES,
  ROW_DISPATCHES_SQL,
  advanceSelection,
  inResumeWindow,
  repullAdvanceLogLine,
  resumeWindowTurn,
  rotate,
  runRepullAdvanceCron,
  sendResumeDispatch,
} from "../src/services/upstream-repull-advance";
import {
  OPEN_DISPATCHES_TODAY_SQL,
  claimOpenDispatch,
} from "../src/services/upstream-repull-dispatch";
import { REVIEW_OF_HEAD_SQL } from "../src/services/upstream-repull-facts";
import type { Bindings } from "../src/types/bindings";
import { freshDb, interceptingD1, realD1 } from "./helpers/d1";
import { seedReview } from "./helpers/pr-queue-fixtures";
import {
  type CheckRunAnswer,
  type PullAnswer,
  type RepullGitHub,
  startRepullGitHub,
} from "./helpers/repull-github-standin";
import { type Row, rowAt } from "./helpers/repull-rows";
import { type CapturedEmail, withFakeResend } from "./helpers/resend";

const DS = "on098801";
const HEAD = "0123456789abcdef0123456789abcdef01234567";
const BASE = "89abcdef0123456789abcdef0123456789abcdef";
const OTHER = "fedcba9876543210fedcba9876543210fedcba98";
const API = "https://api.test.nemar.org";
const HALF_HOUR = ADVANCE_TICK_MINUTES * 60_000;

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
     VALUES ('advadmin', 'advadmin@example.org', 'x', 'approved', 'admin', 1)`,
  );
  adminId = (db.query("SELECT id FROM users WHERE username = 'advadmin'").get() as { id: number })
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
});

/**
 * Production, the open switch on, the review on, a callback secret and the API's address, unless
 * overridden (`undefined` removes a binding).
 */
function env(over: Record<string, string | undefined> = {}, d1?: D1Database): Bindings {
  const bindings: Record<string, unknown> = {
    DB: d1 ?? realD1(db),
    ENVIRONMENT: "production",
    AUTO_REPULL_ENABLED: "1",
    PR_REVIEW_ENABLED: "1",
    PRESCREEN_CALLBACK_SECRET: "repull-advance-callback-secret",
    API_BASE_URL: API,
    GITHUB_ADMIN_PAT: "ghp_repull_advance_test",
    RESEND_API_KEY: "re_test",
    FROM_EMAIL: "NEMAR <noreply@nemar.org>",
  };
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) delete bindings[k];
    else bindings[k] = v;
  }
  return bindings as unknown as Bindings;
}

/** A real instant whose half hour starts the rotation at `start` of `n` rows. */
function instantAt(start: number, n: number): Date {
  let slot = Math.floor(Date.now() / HALF_HOUR);
  while ((slot * ADVANCE_ROWS_PER_TICK) % n !== start) slot++;
  return new Date(slot * HALF_HOUR + 60_000);
}

const tick = (e: Bindings = env(), now?: Date) =>
  runRepullAdvanceCron(e, now ? { now } : {}) as Promise<AdvanceTickResult>;

// ----------------------------------------------------------------------------
// Seeding
// ----------------------------------------------------------------------------

/** A named, published mirror of `ds<id digits>`. */
function mirror(ds: string, over: { anonymous?: number } = {}): void {
  db.run(
    `INSERT INTO datasets (dataset_id, name, owner_user_id, source, source_id, anonymous, status,
                           visibility, github_repo, first_published_at)
     VALUES (?, ?, ?, 'openneuro', ?, ?, 'active', 'public', ?, '2026-01-01 00:00:00')`,
    [
      ds,
      `A sufficiently descriptive title for ${ds}`,
      adminId,
      `ds${ds.slice(2)}`,
      over.anonymous ?? 0,
      `nemarDatasets/${ds}`,
    ],
  );
}

/** An automatic record of `ds` at `status`, its head HEAD on BASE, pull request #7; its id. */
function seedRow(ds: string, status: RepullStatus, over: Row = {}): number {
  const row = rowAt(status, {
    dataset_id: ds,
    upstream_ds: `ds${ds.slice(2)}`,
    origin: "automatic",
    planner: 2,
    actor_user_id: adminId,
    head_sha: HEAD,
    base_sha: BASE,
    counts: JSON.stringify({ unexplained: 0, conflicts: 0, corrections: 0, copy_bytes: 1024 }),
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

/** Both checks of the head, the App's own, green. */
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
  ];
}

/** GitHub as it is for a clean automatic pull request of `ds`. */
function githubClean(ds: string): void {
  gh.pulls[`${ds}#7`] = appPull(ds);
  gh.mainRefs[ds] = BASE;
  gh.checkRuns[`${ds}@${HEAD}`] = greenRuns();
}

/** A mirror with a clean automatic pull request on GitHub; the record's id. */
function openRow(ds: string = DS, over: Row = {}): number {
  mirror(ds);
  githubClean(ds);
  return seedRow(ds, "pr_open", over);
}

/** The screen of HEAD of re-pull `id`, stored as its callback leaves it. */
function markScreen(
  id: number,
  status: string,
  ds: string = DS,
  o: { dispatchedMinutesAgo?: number } = {},
): void {
  db.run("DELETE FROM upstream_repull_screens WHERE repull_id = ?", [id]);
  if (status === "pending") {
    db.run(
      `INSERT INTO upstream_repull_screens (repull_id, pr, sha, status, nonce, dispatched_at)
       VALUES (?, 'n0', ?, 'pending', 'nonce-advance-test', datetime('now', ?))`,
      [id, HEAD, `-${o.dispatchedMinutesAgo ?? 0} minutes`],
    );
    return;
  }
  const report =
    status === "error"
      ? { version: 1, scanner: null, head: null, error: "workflow-failed" }
      : parseScreenReport({
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
function review(verdict: "pass" | "fail", ds: string = DS): void {
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

/** `main` of `ds` moved: every rule before the screen does not hold, so no gate work starts. */
function moveMain(ds: string = DS): void {
  gh.mainRefs[ds] = OTHER;
}

interface RowNow {
  status: string;
  hold_reason: string | null;
  hold_since: string | null;
  revision: number;
  updated_at: string;
  gates_sha: string | null;
}

const rowOf = (id: number) =>
  db
    .query(
      "SELECT status, hold_reason, hold_since, revision, updated_at, gates_sha FROM upstream_repulls WHERE id = ?",
    )
    .get(id) as RowNow;

const auditsOf = (action: string, id?: number) =>
  (
    db.query("SELECT * FROM audit_log WHERE action = ? ORDER BY id").all(action) as Array<
      Record<string, unknown>
    >
  ).filter((a) => id === undefined || a.resource_id === String(id));

const holdAudits = (id?: number) => auditsOf("repull_hold", id);

const githubRequests = () => gh.requests.filter((r) => r.includes("/repos/"));

/** The dispatches GitHub took, of one event type. */
const dispatched = (event: string) =>
  (
    gh.dispatches as unknown as Array<{
      event_type: string;
      client_payload: Record<string, unknown>;
    }>
  )
    .filter((d) => d.event_type === event)
    .map((d) => d.client_payload);

const screens = () =>
  db.query("SELECT * FROM upstream_repull_screens ORDER BY id").all() as Array<
    Record<string, unknown>
  >;

const reviews = () =>
  db.query("SELECT * FROM pr_reviews ORDER BY id").all() as Array<Record<string, unknown>>;

/** Every table the tick could write, as text, to show that nothing moved. */
function snapshot(): string {
  return JSON.stringify(
    [
      "upstream_repulls",
      "upstream_repull_dispatches",
      "upstream_repull_scheduler",
      "upstream_repull_screens",
      "pr_reviews",
      "audit_log",
    ].map((t) => db.query(`SELECT * FROM ${t} ORDER BY rowid`).all()),
  );
}

// ----------------------------------------------------------------------------
// Production only, and the switch
// ----------------------------------------------------------------------------

describe("outside exact production nothing is read, written or sent", () => {
  for (const environment of [
    "development",
    "staging",
    "test",
    "",
    undefined,
    "prod",
    "Production",
    " production",
  ]) {
    test(`ENVIRONMENT=${JSON.stringify(environment)}: null, no request, no write`, async () => {
      openRow();
      const before = snapshot();
      const r = await runRepullAdvanceCron(env({ ENVIRONMENT: environment }));
      expect(r).toBeNull();
      expect(gh.requests).toEqual([]);
      expect(snapshot()).toBe(before);
    });
  }
});

describe("with the open switch off GitHub is asked nothing", () => {
  test("even a row a run is out for says switch-off: the Worker takes it no further", async () => {
    const id = openRow();
    db.run(
      `INSERT INTO upstream_repull_dispatches (kind, dataset_id, upstream_ds, from_tag, to_tag,
                                              repull_id, nonce, status)
       VALUES ('open', ?, ?, '1.0.0', '1.0.1', ?, ?, 'dispatched')`,
      [DS, `ds${DS.slice(2)}`, id, "n".repeat(36)],
    );
    const r = await tick(env({ AUTO_REPULL_ENABLED: undefined }));
    expect(r).toMatchObject({ running: 0, held: { "switch-off": 1 } });
    expect(rowOf(id).hold_reason).toBe("switch-off");
  });

  for (const value of [undefined, "true", "0", " 1", ""]) {
    test(`AUTO_REPULL_ENABLED=${JSON.stringify(value)}: the pull request is not read, and the row says switch-off`, async () => {
      const id = openRow();
      const r = await tick(env({ AUTO_REPULL_ENABLED: value }));
      expect(githubRequests()).toEqual([]);
      expect(r).toMatchObject({
        examined: 1,
        screensStarted: 0,
        reviewsStarted: 0,
        gatesCleared: 0,
        held: { "switch-off": 1 },
        holdsChanged: 1,
      });
      expect(rowOf(id)).toMatchObject({ status: "pr_open", hold_reason: "switch-off" });
      // The tick ran, in production, and says so.
      const stamp = db
        .query("SELECT last_advance_at FROM upstream_repull_scheduler WHERE id = 1")
        .get() as { last_advance_at: string | null };
      expect(stamp.last_advance_at).not.toBeNull();
    });
  }
});

// ----------------------------------------------------------------------------
// Holds
// ----------------------------------------------------------------------------

describe("a hold is the first rule that does not hold", () => {
  const cases: Array<[string, () => void, string, { github: boolean }]> = [
    [
      "the dataset became anonymous",
      () => db.run("UPDATE datasets SET first_published_at = NULL, anonymous = 1"),
      "dataset-anonymous",
      { github: false },
    ],
    [
      "an import of the dataset has not settled",
      () =>
        db.run(
          `INSERT INTO import_jobs (dataset_id, source, source_id, status)
           VALUES (?, 'openneuro', ?, 'incomplete')`,
          [DS, `ds${DS.slice(2)}`],
        ),
      "import-in-flight",
      { github: false },
    ],
    [
      "the pull request was closed",
      () => {
        gh.pulls[`${DS}#7`] = appPull(DS, { state: "closed" });
      },
      "pr-closed",
      { github: true },
    ],
    [
      "the head moved",
      () => {
        gh.pulls[`${DS}#7`] = appPull(DS, {
          head: { sha: OTHER, ref: "release/v2.0.0", repo: { full_name: `nemarDatasets/${DS}` } },
        });
      },
      "head-moved",
      { github: true },
    ],
    ["main moved", () => moveMain(), "main-moved", { github: true }],
    [
      "BIDS validation is still running",
      () => {
        gh.checkRuns[`${DS}@${HEAD}`] = [
          { ...(greenRuns()[0] as CheckRunAnswer), status: "in_progress", conclusion: null },
          greenRuns()[1] as CheckRunAnswer,
        ];
      },
      "bids-pending",
      { github: true },
    ],
    [
      "GitHub does not say the pull request is clean",
      () => {
        gh.pulls[`${DS}#7`] = appPull(DS, { mergeable_state: "unstable" });
      },
      "not-clean",
      { github: true },
    ],
  ];

  for (const [name, flip, word, o] of cases) {
    test(`${name}: ${word}, written once over two ticks`, async () => {
      const id = openRow();
      // Every rule holds but the one flipped, so the word is that rule's.
      markScreen(id, "clean");
      review("pass");
      flip();
      await tick();
      expect(rowOf(id)).toMatchObject({ status: "pr_open", hold_reason: word });
      if (!o.github) expect(githubRequests()).toEqual([]);
      const first = rowOf(id);
      const [audit] = holdAudits(id);
      expect(holdAudits(id)).toHaveLength(1);
      expect(audit).toMatchObject({ user_id: SYSTEM_USER_ID, resource_type: "upstream_repull" });
      expect(JSON.parse(String(audit?.details))).toEqual({
        dataset_id: DS,
        status: "pr_open",
        from: null,
        to: word,
      });

      const again = await tick();
      expect(again.holdsChanged).toBe(0);
      expect(again.held).toEqual({ [word]: 1 });
      // The same word: no second audit row, and the time it began is kept.
      expect(holdAudits(id)).toHaveLength(1);
      expect(rowOf(id)).toEqual(first);
    });
  }

  test("a hold is an observation: it moves neither the revision nor updated_at", async () => {
    // An old time, so a hold that stamped updated_at would show; the resume's quiet time reads it.
    const id = openRow(DS, { updated_at: "2026-01-01 00:00:00" });
    moveMain();
    const before = rowOf(id);
    expect(before.updated_at).toBe("2026-01-01 00:00:00");
    await tick();
    const after = rowOf(id);
    expect(after.hold_reason).toBe("main-moved");
    expect(after.revision).toBe(before.revision);
    expect(after.updated_at).toBe(before.updated_at);
  });

  test("a new word replaces the old one, from the time it began, with one audit row more", async () => {
    const id = openRow();
    markScreen(id, "clean");
    review("pass");
    moveMain();
    await tick();
    expect(rowOf(id).hold_reason).toBe("main-moved");
    db.run("UPDATE upstream_repulls SET hold_since = '2026-01-01 00:00:00' WHERE id = ?", [id]);
    gh.mainRefs[DS] = BASE;
    gh.pulls[`${DS}#7`] = appPull(DS, { mergeable_state: "blocked" });
    await tick();
    const now = rowOf(id);
    expect(now.hold_reason).toBe("not-clean");
    expect(now.hold_since).not.toBe("2026-01-01 00:00:00");
    expect(holdAudits(id).map((a) => JSON.parse(String(a.details)))).toEqual([
      { dataset_id: DS, status: "pr_open", from: null, to: "main-moved" },
      { dataset_id: DS, status: "pr_open", from: "main-moved", to: "not-clean" },
    ]);
  });

  test("a row that moved while the tick read it is not written", async () => {
    const id = openRow();
    markScreen(id, "clean");
    review("pass");
    moveMain();
    // Another writer moves the row (a transition bumps its revision) after the tick read it and
    // before it records the hold.
    const moving = interceptingD1(realD1(db), (sql) => {
      if (sql === REVIEW_OF_HEAD_SQL) {
        db.run("UPDATE upstream_repulls SET revision = revision + 1 WHERE id = ?", [id]);
      }
    });
    const r = await tick(env({}, moving));
    expect(r.held).toEqual({ "main-moved": 1 });
    expect(r.holdsChanged).toBe(0);
    expect(rowOf(id).hold_reason).toBeNull();
    expect(holdAudits(id)).toEqual([]);
  });

  test("the statement writes only a change, only to the revision read, only an automatic row", () => {
    const id = openRow();
    const { revision } = rowOf(id);
    const run = (rev: number, from: string | null, to: string | null) =>
      db.query(REPULL_HOLD_SQL).run(id, rev, from, to).changes;
    expect(run(revision + 1, null, "bids-pending")).toBe(0);
    expect(run(revision, "main-moved", "bids-pending")).toBe(0);
    expect(run(revision, null, null)).toBe(0);
    expect(run(revision, null, "bids-pending")).toBe(1);
    expect(run(revision, "bids-pending", "bids-pending")).toBe(0);
    expect(run(revision, "bids-pending", null)).toBe(1);
    expect(rowOf(id)).toMatchObject({ hold_reason: null, hold_since: null });
    db.run("UPDATE upstream_repulls SET origin = 'administrator' WHERE id = ?", [id]);
    expect(run(revision, null, "bids-pending")).toBe(0);
  });

  test("while a run is out for the dataset, GitHub is asked nothing and the row is not held", async () => {
    const id = openRow();
    db.run("UPDATE upstream_repulls SET hold_reason = 'head-moved', hold_since = datetime('now')");
    db.run(
      `INSERT INTO upstream_repull_dispatches (kind, dataset_id, upstream_ds, from_tag, to_tag,
                                              repull_id, nonce, status)
       VALUES ('open', ?, ?, '1.0.0', '1.0.1', ?, ?, 'dispatched')`,
      [DS, `ds${DS.slice(2)}`, id, "n".repeat(36)],
    );
    const r = await tick();
    expect(r).toMatchObject({ examined: 1, running: 1, held: {}, holdsChanged: 1 });
    expect(githubRequests()).toEqual([]);
    expect(rowOf(id)).toMatchObject({ hold_reason: null, hold_since: null });
    expect(JSON.parse(String(holdAudits(id)[0]?.details))).toMatchObject({
      from: "head-moved",
      to: null,
    });
  });
});

describe("an edge into another status ends the hold; a self-edge keeps it", () => {
  test("pr_open to abandoned clears it, pr_open to pr_open does not", async () => {
    const id = openRow();
    moveMain();
    await tick();
    expect(rowOf(id).hold_reason).toBe("main-moved");
    const admin = { id: adminId };
    const self = await transitionRepull(env(), admin, id, {
      from: "pr_open",
      to: "pr_open",
      fields: { branch: "release/v2.0.0", pr_number: 7, head_sha: OTHER },
    });
    expect(isRefusal(self)).toBe(false);
    expect(rowOf(id)).toMatchObject({ status: "pr_open", hold_reason: "main-moved" });
    const ended = await transitionRepull(env(), admin, id, { from: "pr_open", to: "abandoned" });
    expect(isRefusal(ended)).toBe(false);
    expect(rowOf(id)).toMatchObject({ status: "abandoned", hold_reason: null, hold_since: null });
    expect((await getRepull(realD1(db), id))?.hold_reason).toBeNull();
  });
});

// ----------------------------------------------------------------------------
// Which rows
// ----------------------------------------------------------------------------

describe("which rows a tick reads", () => {
  test("a row that moved on between the list and its own read is left alone", async () => {
    const id = openRow();
    // The list reads the row at pr_open; it reaches gates_clear before the tick reads it by id.
    const moving = interceptingD1(realD1(db), (sql, binds) => {
      if (sql === REPULL_BY_ID_SQL && binds[0] === id) {
        db.run(
          "UPDATE upstream_repulls SET status = 'gates_clear', gates_sha = head_sha, revision = revision + 1 WHERE id = ?",
          [id],
        );
      }
    });
    const r = await tick(env({}, moving));
    expect(r).toMatchObject({ examined: 0, held: {}, holdsChanged: 0, errors: [] });
    expect(rowOf(id)).toMatchObject({ status: "gates_clear", hold_reason: null });
    expect(githubRequests()).toEqual([]);
    expect(holdAudits(id)).toEqual([]);
  });

  test("an administrator's row is never read, and takes no place in the rotation", async () => {
    const admins: number[] = [];
    for (let i = 2; i <= ADVANCE_ROWS_PER_TICK + 1; i++) {
      admins.push(openRow(`on09880${i}`, { origin: "administrator" }));
    }
    const autoDs = "on098809";
    const auto = openRow(autoDs);
    moveMain(autoDs);
    // The rotation would start at the first row of every row, administrators' included.
    const r = await tick(env(), instantAt(0, admins.length + 1));
    expect(r.examined).toBe(1);
    expect(rowOf(auto).hold_reason).toBe("main-moved");
    for (const id of admins) expect(rowOf(id).hold_reason).toBeNull();
    // Nothing of an administrator's pull request was asked of GitHub.
    for (let i = 2; i <= ADVANCE_ROWS_PER_TICK + 1; i++) {
      expect(githubRequests().filter((q) => q.includes(`on09880${i}`))).toEqual([]);
    }
  });

  test("at most five rows a tick, and the next half hour reads the rest", async () => {
    const ids: number[] = [];
    for (let i = 1; i <= 7; i++) {
      const ds = `on0988${String(i).padStart(2, "0")}`;
      ids.push(openRow(ds));
      moveMain(ds);
    }
    const first = instantAt(0, ids.length);
    const r1 = await tick(env(), first);
    expect(r1.examined).toBe(ADVANCE_ROWS_PER_TICK);
    expect(ids.filter((id) => rowOf(id).hold_reason !== null)).toHaveLength(5);
    const r2 = await tick(env(), new Date(first.getTime() + HALF_HOUR));
    expect(r2.examined).toBe(ADVANCE_ROWS_PER_TICK);
    expect(ids.every((id) => rowOf(id).hold_reason === "main-moved")).toBe(true);
  });

  test("a rotation covers every row of a stable set in consecutive turns, however long any waits", () => {
    const ids = [3, 5, 8, 13, 21, 34, 55, 89, 144, 233, 377];
    for (const n of [1, 5, 6, ids.length]) {
      const set = ids.slice(0, n);
      const start = Math.floor(Date.now() / HALF_HOUR);
      const seen = new Set<number>();
      for (let k = 0; k < Math.ceil(n / ADVANCE_ROWS_PER_TICK); k++) {
        const turn = rotate(set, start + k);
        expect(turn.length).toBe(Math.min(n, ADVANCE_ROWS_PER_TICK));
        for (const id of turn) seen.add(id);
      }
      expect([...seen].sort((a, b) => a - b)).toEqual(set);
    }
  });

  test("inside the resume window its half hours are consecutive turns, across days", () => {
    const day = utcToday(0).getTime();
    const turns: Array<number | null> = [];
    for (let h = 0; h < 96; h++)
      turns.push(resumeWindowTurn(new Date(day + h * HALF_HOUR + 60_000)));
    const inside = turns.filter((x): x is number => x !== null);
    // 03:00 to 15:30 of each of two days: 26 half hours a day, numbered one after another.
    expect(inside).toHaveLength(52);
    for (let i = 1; i < inside.length; i++) expect(inside[i]).toBe((inside[i - 1] as number) + 1);
    expect(turns[5]).toBeNull();
    expect(turns[6]).not.toBeNull();
    expect(turns[31]).not.toBeNull();
    expect(turns[32]).toBeNull();
  });

  // The cron fires at :00 and :30; a stalled row can be resumed only inside the window, so each
  // must be read inside it. One rotation turned by the half hour of the day came back to the same
  // rows at the same hours every day: of 240 rows only 130 were ever read inside the window.
  for (const [stalledRows, openRows] of [
    [239, 0],
    [240, 0],
    [241, 0],
    [480, 0],
    [120, 120],
    [240, 37],
  ] as const) {
    test(`over 60 days every one of ${stalledRows} stalled rows (beside ${openRows} at pr_open) is read inside the window`, () => {
      // The two kinds interleaved by id, as they would be in the table.
      const total = stalledRows + openRows;
      const openAt = new Set(
        Array.from({ length: openRows }, (_, k) => Math.floor((k * total) / openRows)),
      );
      const rows = Array.from({ length: total }, (_, i) => ({
        id: i + 1,
        status: openAt.has(i) ? "pr_open" : "copied",
      }));
      expect(rows.filter((r) => r.status === "pr_open")).toHaveLength(openRows);
      const stalledIds = rows.filter((r) => r.status === "copied").map((r) => r.id);
      const seen = new Set<number>();
      const start = utcToday(0).getTime();
      for (let tickAt = 0; tickAt < 60 * 48; tickAt++) {
        const now = new Date(start + tickAt * HALF_HOUR + 60_000);
        const picked = advanceSelection(rows, now);
        expect(picked.filter((id) => !stalledIds.includes(id)).length).toBeLessThanOrEqual(
          ADVANCE_ROWS_PER_TICK,
        );
        if (!inResumeWindow(now)) {
          expect(picked.filter((id) => stalledIds.includes(id))).toEqual([]);
          continue;
        }
        for (const id of picked) if (stalledIds.includes(id)) seen.add(id);
      }
      expect(stalledIds.filter((id) => !seen.has(id))).toEqual([]);
    });
  }
});

// ----------------------------------------------------------------------------
// The gates
// ----------------------------------------------------------------------------

describe("the gates of an automatic pull request", () => {
  test("with no screen, the screen is dispatched for the head; the review waits for it to clear", async () => {
    const id = openRow();
    const r = await tick();
    expect(r).toMatchObject({ screensStarted: 1, reviewsStarted: 0, gatesCleared: 0 });

    // The screen: the publication screen's workflow, at the head, request 0, with the re-pull's
    // own callback.
    const [screen] = dispatched("run-identifier-screen");
    expect(dispatched("run-identifier-screen")).toHaveLength(1);
    expect(screen).toMatchObject({
      dataset_id: DS,
      ref: HEAD,
      request_id: 0,
      callback_url: `${API}/webhooks/identifier-screen-repull-result`,
    });
    expect(screens()).toEqual([
      expect.objectContaining({ repull_id: id, pr: "n0", sha: HEAD, status: "pending" }),
    ]);
    expect(auditsOf("repull_screen_dispatched", id)).toEqual([
      expect.objectContaining({ user_id: SYSTEM_USER_ID }),
    ]);
    // No model call while the screen may still block or ask for a person.
    expect(dispatched("run-pr-review")).toEqual([]);
    expect(reviews()).toEqual([]);
    expect(rowOf(id)).toMatchObject({ status: "pr_open", hold_reason: "screen-pending" });

    // The next tick, with the screen still out, starts nothing again.
    const waiting = await tick();
    expect(waiting).toMatchObject({ screensStarted: 0, reviewsStarted: 0 });
    expect(gh.dispatches).toHaveLength(1);

    // Once the screen is clear, the review is started: the App's pull request, admitted by the
    // Worker's own start, at the head.
    markScreen(id, "clean");
    const cleared = await tick();
    expect(cleared).toMatchObject({ screensStarted: 0, reviewsStarted: 1 });
    expect(dispatched("run-pr-review")).toEqual([
      expect.objectContaining({ dataset_id: DS, pr_number: 7, head_sha: HEAD }),
    ]);
    expect(reviews()).toEqual([
      expect.objectContaining({
        dataset_id: DS,
        pr_number: 7,
        head_sha: HEAD,
        author_login: NEMAR_APP_BOT_LOGIN,
        state: "dispatched",
      }),
    ]);
    expect(rowOf(id).hold_reason).toBe("review-running");
    expect((await tick()).reviewsStarted).toBe(0);
    expect(dispatched("run-pr-review")).toHaveLength(1);
  });

  test("a screen in error the tick will not run again: the review is not started", async () => {
    const id = openRow();
    markScreen(id, "error");
    for (let n = 0; n < 3; n++) {
      db.run(
        `INSERT INTO audit_log (user_id, action, resource_type, resource_id, details)
         VALUES (?, 'repull_screen_dispatched', 'upstream_repull', ?, ?)`,
        [SYSTEM_USER_ID, String(id), JSON.stringify({ dataset_id: DS, pr: "n0", sha: HEAD })],
      );
    }
    const r = await tick();
    expect(r).toMatchObject({ screensStarted: 0, reviewsStarted: 0, reviewRefused: {} });
    expect(rowOf(id).hold_reason).toBe("screen-error");
    expect(gh.dispatches).toEqual([]);
    expect(reviews()).toEqual([]);
  });

  test("a review the review's own start declines is counted by its reason, and logged", async () => {
    const id = openRow();
    markScreen(id, "clean");
    const r = await tick(env({ PR_REVIEW_ENABLED: undefined }));
    expect(r).toMatchObject({ reviewsStarted: 0, reviewRefused: { pr_review_disabled: 1 } });
    expect(rowOf(id).hold_reason).toBe("review-absent");
    expect(gh.dispatches).toEqual([]);
    expect(repullAdvanceLogLine(r)?.line).toContain("review_refused=pr_review_disabled:1");
    // It says so on every tick it declines, not only when the hold first changed.
    const again = await tick(env({ PR_REVIEW_ENABLED: undefined }));
    expect(again.holdsChanged).toBe(0);
    expect(repullAdvanceLogLine(again)?.line).toContain("review_refused=pr_review_disabled:1");
  });

  test("the next tick with screen clear, review pass, both checks green, clean and main unmoved: gates_clear", async () => {
    const id = openRow();
    await tick();
    expect(rowOf(id).hold_reason).toBe("screen-pending");
    markScreen(id, "clean");
    db.run("DELETE FROM pr_reviews");
    review("pass");
    gh.dispatches = [];

    const r = await tick();
    expect(r).toMatchObject({ gatesCleared: 1, screensStarted: 0, reviewsStarted: 0, refused: {} });
    expect(rowOf(id)).toMatchObject({
      status: "gates_clear",
      gates_sha: HEAD,
      hold_reason: null,
      hold_since: null,
    });
    expect(gh.dispatches).toEqual([]);
    const [edge] = auditsOf("repull_transition", id);
    expect(edge).toMatchObject({ user_id: SYSTEM_USER_ID });
    expect(JSON.parse(String(edge?.details))).toMatchObject({
      from: "pr_open",
      to: "gates_clear",
      fields: ["gates_sha"],
      automatic: true,
    });
    // The record's own transition read GitHub's live head before it wrote.
    expect(githubRequests().filter((q) => q.endsWith(`/${DS}/pulls/7`)).length).toBeGreaterThan(1);
    // A gates_clear row is no longer the tick's: nothing more is read or written for it.
    gh.requests = [];
    expect((await tick()).examined).toBe(0);
    expect(githubRequests()).toEqual([]);
  });

  const unknown: Array<[string, () => void, string]> = [
    [
      "GitHub has not computed a mergeable state",
      () => {
        gh.pulls[`${DS}#7`] = appPull(DS, { mergeable_state: null });
      },
      "not-clean",
    ],
    [
      "GitHub says the mergeable state is unknown",
      () => {
        gh.pulls[`${DS}#7`] = appPull(DS, { mergeable_state: "unknown" });
      },
      "not-clean",
    ],
    [
      "GitHub says the pull request is blocked",
      () => {
        gh.pulls[`${DS}#7`] = appPull(DS, { mergeable_state: "blocked" });
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
      "main cannot be read",
      () => {
        gh.mainRefs[DS] = 500;
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
    ["the screen is still out", () => markScreen(1, "pending"), "screen-pending"],
    [
      "the review failed",
      () => {
        db.run("DELETE FROM pr_reviews");
        review("fail");
      },
      "review-not-pass",
    ],
  ];

  for (const [name, flip, word] of unknown) {
    test(`${name}: never gates_clear, held ${word}`, async () => {
      const id = openRow();
      expect(id).toBe(1);
      markScreen(id, "clean");
      review("pass");
      flip();
      const r = await tick();
      expect(r.gatesCleared).toBe(0);
      expect(rowOf(id)).toMatchObject({ status: "pr_open", gates_sha: null, hold_reason: word });
      expect(auditsOf("repull_transition", id)).toEqual([]);
      expect(gh.dispatches).toEqual([]);
    });
  }

  const before: Array<[string, () => void, string]> = [
    [
      "a check is still running",
      () => {
        gh.checkRuns[`${DS}@${HEAD}`] = [
          greenRuns()[0] as CheckRunAnswer,
          { ...(greenRuns()[1] as CheckRunAnswer), status: "queued", conclusion: null },
        ];
      },
      "version-check-pending",
    ],
    [
      "BIDS validation failed",
      () => {
        gh.checkRuns[`${DS}@${HEAD}`] = [
          { ...(greenRuns()[0] as CheckRunAnswer), conclusion: "failure" },
          greenRuns()[1] as CheckRunAnswer,
        ];
      },
      "bids-failed",
    ],
    ["main moved", () => moveMain(), "main-moved"],
    [
      "another bot opened the pull request",
      () => {
        gh.pulls[`${DS}#7`] = appPull(DS, {
          user: { login: "dependabot[bot]", id: 49699333, type: "Bot" },
        });
      },
      "pr-not-app",
    ],
  ];

  for (const [name, flip, word] of before) {
    test(`${name}: nothing is started, held ${word}`, async () => {
      const id = openRow();
      flip();
      const r = await tick();
      expect(r).toMatchObject({ screensStarted: 0, reviewsStarted: 0 });
      expect(rowOf(id).hold_reason).toBe(word);
      expect(gh.dispatches).toEqual([]);
      expect(gh.writes).toEqual([]);
      expect(screens()).toEqual([]);
      expect(reviews()).toEqual([]);
    });
  }

  test("the screen of one head is dispatched 3 times at most", async () => {
    const id = openRow();
    review("pass");
    for (let n = 1; n <= 3; n++) {
      markScreen(id, "error");
      const r = await tick();
      expect([n, r.screensStarted]).toEqual([n, 1]);
      expect(rowOf(id).hold_reason).toBe("screen-pending");
    }
    expect(auditsOf("repull_screen_dispatched", id)).toHaveLength(3);
    markScreen(id, "error");
    const r = await tick();
    expect(r.screensStarted).toBe(0);
    expect(rowOf(id).hold_reason).toBe("screen-error");
    expect(dispatched("run-identifier-screen")).toHaveLength(3);
  });

  test("a screen that never reported is dispatched again", async () => {
    const id = openRow();
    // Out longer than the report deadline: it reads as unreported, never as still running.
    markScreen(id, "pending", DS, { dispatchedMinutesAgo: 120 });
    const r = await tick();
    expect(r.screensStarted).toBe(1);
    expect(dispatched("run-identifier-screen")).toHaveLength(1);
    expect(rowOf(id).hold_reason).toBe("screen-pending");
  });

  test("the bound is per head: three dispatches of an earlier head leave the new head its own", async () => {
    const id = openRow();
    for (let n = 0; n < 3; n++) {
      db.run(
        `INSERT INTO audit_log (user_id, action, resource_type, resource_id, details)
         VALUES (?, 'repull_screen_dispatched', 'upstream_repull', ?, ?)`,
        [SYSTEM_USER_ID, String(id), JSON.stringify({ dataset_id: DS, pr: "n0", sha: OTHER })],
      );
    }
    markScreen(id, "error");
    const r = await tick();
    expect(r.screensStarted).toBe(1);
    expect(dispatched("run-identifier-screen")[0]).toMatchObject({ ref: HEAD });
  });

  test("a screen that asks for a person is not run again, and the review is not started", async () => {
    const id = openRow();
    markScreen(id, "review");
    const r = await tick();
    expect(r).toMatchObject({ screensStarted: 0, reviewsStarted: 0 });
    expect(rowOf(id).hold_reason).toBe("screen-acknowledge");
    expect(gh.dispatches).toEqual([]);
    expect(reviews()).toEqual([]);
  });

  test("a screen that blocks: the review is not started", async () => {
    const id = openRow();
    markScreen(id, "direct-identifiers");
    const r = await tick();
    expect(r).toMatchObject({ screensStarted: 0, reviewsStarted: 0 });
    expect(rowOf(id).hold_reason).toBe("screen-blocks");
    expect(reviews()).toEqual([]);
  });

  test("a review whose dispatch failed is asked for again after 60 minutes, not before", async () => {
    const id = openRow();
    markScreen(id, "clean");
    const failedAt = (minutesAgo: number) => {
      db.run("DELETE FROM pr_reviews");
      seedReview(db, {
        ds: DS,
        n: 7,
        sha: HEAD,
        state: "errored",
        detail: "dispatch_failed",
        login: NEMAR_APP_BOT_LOGIN,
        authorId: NEMAR_APP_BOT_USER_ID,
        createdAt: new Date(Date.now() - minutesAgo * 60_000)
          .toISOString()
          .slice(0, 19)
          .replace("T", " "),
      });
    };
    failedAt(55);
    expect((await tick()).reviewsStarted).toBe(0);
    expect(rowOf(id).hold_reason).toBe("review-not-pass");
    failedAt(65);
    expect((await tick()).reviewsStarted).toBe(1);
    expect(rowOf(id).hold_reason).toBe("review-running");
    expect(dispatched("run-pr-review")).toHaveLength(1);
  });

  test("a review that errored for another reason is not asked for again", async () => {
    const id = openRow();
    markScreen(id, "clean");
    seedReview(db, {
      ds: DS,
      n: 7,
      sha: HEAD,
      state: "errored",
      detail: "model_unavailable",
      login: NEMAR_APP_BOT_LOGIN,
      authorId: NEMAR_APP_BOT_USER_ID,
    });
    expect((await tick()).reviewsStarted).toBe(0);
    expect(rowOf(id).hold_reason).toBe("review-not-pass");
    expect(gh.dispatches).toEqual([]);
    // The review's start is not even asked: it would read the pull request again and restate the
    // stored result on it, on every tick.
    expect(githubRequests().filter((q) => q.endsWith(`/${DS}/pulls/7`))).toHaveLength(1);
    expect(gh.writes).toEqual([]);
  });

  test("a clean row whose edge the record refuses writes nothing, and says so", async () => {
    const id = openRow();
    markScreen(id, "clean");
    review("pass");
    // The dataset is withdrawn between the facts the rule read and the record's own fences.
    let reads = 0;
    const withdrawing = interceptingD1(realD1(db), (sql) => {
      if (sql === CREATE_FACTS_SQL && ++reads === 2) {
        db.run("UPDATE datasets SET withdrawn_at = datetime('now')");
      }
    });
    const r = await tick(env({}, withdrawing));
    expect(r).toMatchObject({ gatesCleared: 0, refused: { withdrawn: 1 } });
    expect(rowOf(id)).toMatchObject({
      status: "pr_open",
      gates_sha: null,
      hold_reason: "gates-refused",
    });
    expect(auditsOf("repull_transition", id)).toEqual([]);
    expect(DISPATCH_CODES as readonly string[]).toContain("withdrawn");
    expect(repullAdvanceLogLine(r)).toMatchObject({ level: "error" });
    expect(repullAdvanceLogLine(r)?.line).toContain("refused=withdrawn:1");
    // Refused again on the next tick: the hold stands, and the log says so again.
    db.run("UPDATE datasets SET withdrawn_at = NULL");
    reads = 0;
    const again = await tick(env({}, withdrawing));
    expect(again).toMatchObject({ holdsChanged: 0, refused: { withdrawn: 1 } });
    expect(holdAudits(id)).toHaveLength(1);
    expect(repullAdvanceLogLine(again)?.level).toBe("error");
  });

  test("a screen the Worker cannot dispatch is an error the next tick dispatches again", async () => {
    const id = openRow();
    const r = await tick(env({ PRESCREEN_CALLBACK_SECRET: undefined }));
    expect(r.errors).toEqual(["dispatch-unconfigured"]);
    expect(r).toMatchObject({ screensStarted: 0, reviewsStarted: 0 });
    expect(rowOf(id).hold_reason).toBe("screen-error");
    expect(gh.dispatches).toEqual([]);
    expect((await tick()).screensStarted).toBe(1);
  });
});

// ----------------------------------------------------------------------------
// What the tick says
// ----------------------------------------------------------------------------

describe("the bounds, as the record says them", () => {
  test("are the numbers ADR 0111's Phase 7f amendment states", () => {
    expect(ADVANCE_ROWS_PER_TICK).toBe(5);
    expect(AUTOMATIC_SCREENS_MAX).toBe(3);
    expect(REVIEW_RETRY_MINUTES).toBe(60);
    expect(AUTOMATIC_OPEN_DISPATCHES_MAX).toBe(3);
    expect(RESUME_QUIET_MINUTES).toBe(60);
    expect(RESUME_WINDOW_UTC).toEqual({ from: 3, to: 15 });
  });
});

describe("a failure", () => {
  test("of one row is named by its id, and the next row is still taken up", async () => {
    const first = openRow();
    moveMain();
    const second = openRow("on098802");
    moveMain("on098802");
    const failing = interceptingD1(realD1(db), (sql, binds) => {
      if (sql === REPULL_BY_ID_SQL && binds[0] === first) throw new Error(`a message about ${DS}`);
    });
    const logged: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    };
    let r: AdvanceTickResult;
    try {
      r = await tick(env({}, failing));
    } finally {
      console.error = original;
    }
    expect(r).toMatchObject({ examined: 1, errors: ["row-failed"], errorClass: "Error" });
    expect(rowOf(second).hold_reason).toBe("main-moved");
    expect(rowOf(first).hold_reason).toBeNull();
    const line = logged.find((l) => l.startsWith("[repull-advance]"));
    expect(line).toBe(`[repull-advance] re-pull ${first}: its step failed (Error)`);
    expect(logged.join("\n")).not.toContain(DS);
    // The tick went through its rows, so it is stamped.
    expect(
      (
        db.query("SELECT last_advance_at FROM upstream_repull_scheduler").get() as {
          last_advance_at: string | null;
        }
      ).last_advance_at,
    ).not.toBeNull();
  });

  test("of the tick itself, before any row, leaves the stamp alone", async () => {
    openRow();
    const failing = interceptingD1(realD1(db), (sql) => {
      if (sql === ADVANCE_ROWS_SQL) throw new Error("the list could not be read");
    });
    const r = await tick(env({}, failing));
    expect(r).toMatchObject({ examined: 0, errors: ["tick-failed"] });
    expect(
      (
        db.query("SELECT last_advance_at FROM upstream_repull_scheduler").get() as {
          last_advance_at: string | null;
        }
      ).last_advance_at,
    ).toBeNull();
    expect(repullAdvanceLogLine(r)?.level).toBe("error");
  });
});

describe("the log line", () => {
  test("says nothing when nothing changed, and counts when something did", async () => {
    openRow();
    moveMain();
    const r = await tick();
    expect(repullAdvanceLogLine(r)).toEqual({
      level: "info",
      line: "[repull-advance] examined=1 running=0 not_due=0 screens=0 reviews=0 review_refused=none gates_cleared=0 resumed=0 unconfirmed=0 holds_changed=1 held=main-moved:1 refused=none",
    });
    expect(repullAdvanceLogLine(await tick())).toBeNull();
  });

  test("is an error, with fixed words only, when something failed", async () => {
    openRow();
    moveMain();
    const broken = interceptingD1(realD1(db), (sql) => {
      if (sql.includes("upstream_repull_scheduler")) throw new Error("a message never logged");
    });
    const r = await tick(env({}, broken));
    expect(r.errors).toEqual(["stamp-failed"]);
    const log = repullAdvanceLogLine(r);
    expect(log?.level).toBe("error");
    expect(log?.line).toContain("errors=stamp-failed");
    expect(log?.line).not.toContain("message");
    expect(log?.line).not.toContain(DS);
  });

  test("every failure word has the stored shape, and is the dispatch record's or the scheduler's", () => {
    const known = new Set<string>([...DISPATCH_CODES, ...REPULL_SCHEDULER_OUTCOMES]);
    const own = ["time-unreadable", "row-failed", "tick-failed", "stamp-failed"];
    for (const w of ADVANCE_FAILURES) {
      expect(w).toMatch(FIXED_WORD_RE);
      expect([w, known.has(w) || own.includes(w)]).toEqual([w, true]);
    }
  });
});

// ----------------------------------------------------------------------------
// Stalled rows
// ----------------------------------------------------------------------------

const SECRET = "repull-advance-callback-secret";
const CLI = "1.2.3";

/** Today at `hour`:`minute` UTC, a real instant. */
function utcToday(hour: number, minute = 0): Date {
  const d = new Date();
  d.setUTCHours(hour, minute, 0, 0);
  return d;
}

const d1Time = (d: Date) => d.toISOString().slice(0, 19).replace("T", " ");

/** A mirror with an automatic record of `ds` stalled at `status`, last written `quietMinutes` before `now`. */
function stalled(
  status: RepullStatus,
  now: Date,
  o: { ds?: string; quietMinutes?: number; over?: Row } = {},
): number {
  const ds = o.ds ?? DS;
  mirror(ds);
  return seedRow(ds, status, {
    updated_at: d1Time(new Date(now.getTime() - (o.quietMinutes ?? 120) * 60_000)),
    ...o.over,
  });
}

/**
 * A dispatch of re-pull `id` that ended as `status`, sent yesterday so it takes none of today's
 * cap; `reportedAt` (a D1 time) is when it reported, yesterday by default.
 */
function endedDispatch(id: number, status: string, ds: string = DS, reportedAt?: string): void {
  const code =
    status === "unreported"
      ? null
      : status === "dispatch_failed"
        ? "dispatch-refused"
        : "copy-failed";
  const reported =
    status === "unreported" || status === "dispatch_failed"
      ? null
      : reportedAt === undefined
        ? "datetime('now', '-1 day')"
        : `'${reportedAt}'`;
  db.run(
    `INSERT INTO upstream_repull_dispatches (kind, dataset_id, upstream_ds, from_tag, to_tag,
                                            repull_id, nonce, status, code, dispatched_at, reported_at)
     VALUES ('open', ?, ?, '1.0.0', '1.0.1', ?, NULL, ?, ?, datetime('now', '-1 day'),
             ${reported ?? "NULL"})`,
    [ds, `ds${ds.slice(2)}`, id, status, code],
  );
}

const resumeTick = (
  now: Date,
  e: Bindings = env(),
  opts: { cliVersion?: string; dispatchTimeoutMs?: number } = {},
) => runRepullAdvanceCron(e, { now, cliVersion: CLI, ...opts }) as Promise<AdvanceTickResult>;

const dispatchesOf = (id: number) =>
  db
    .query("SELECT * FROM upstream_repull_dispatches WHERE repull_id = ? ORDER BY id")
    .all(id) as DispatchRow[];

const usedToday = () => (db.query(OPEN_DISPATCHES_TODAY_SQL).get() as { used: number }).used;

describe("a stalled automatic re-pull is resumed", () => {
  const TEN = () => utcToday(10);

  test("a copied row whose run failed gets one resume dispatch, which counts against the open cap", async () => {
    const id = stalled("copied", TEN());
    endedDispatch(id, "failed");
    expect(usedToday()).toBe(0);

    const r = await resumeTick(TEN());
    expect(r).toMatchObject({ examined: 1, resumed: 1, unconfirmed: 0, errors: [] });
    const sent = dispatched("run-upstream-repull");
    expect(sent).toHaveLength(1);
    const claimed = dispatchesOf(id).at(-1) as DispatchRow;
    expect(claimed).toMatchObject({ kind: "open", status: "dispatched", repull_id: id });
    expect(claimed.nonce).not.toBeNull();
    expect(sent[0]).toEqual({
      mode: "open",
      dataset_id: DS,
      upstream_ds: `ds${DS.slice(2)}`,
      from_tag: "1.0.0",
      to_tag: "1.0.1",
      dispatch_id: String(claimed.id),
      dispatch_token: expect.any(String),
      cli_version: CLI,
      repull_id: String(id),
    });
    expect(
      await verifyRepullDispatchToken(
        String(sent[0]?.dispatch_token),
        { dispatchId: claimed.id, datasetId: DS, nonce: claimed.nonce as string },
        SECRET,
      ),
    ).toBe(true);
    // It took one of today's units, as a first dispatch does.
    expect(usedToday()).toBe(1);
    expect(rowOf(id)).toMatchObject({ status: "copied", hold_reason: null });
    // GitHub was asked nothing about the dataset's repository: the row has no pull request.
    expect(githubRequests().filter((q) => q.includes(`/${DS}/`))).toEqual([]);
  });

  test("while its run is out the next tick resumes nothing", async () => {
    const id = stalled("registered", TEN());
    endedDispatch(id, "failed");
    await resumeTick(TEN());
    const r = await resumeTick(new Date(TEN().getTime() + HALF_HOUR));
    expect(r).toMatchObject({ resumed: 0, running: 1 });
    expect(dispatched("run-upstream-repull")).toHaveLength(1);
  });

  test("while a run is out for the dataset the row is left to it, whatever else it would say", async () => {
    const id = stalled("copied", TEN());
    db.run(
      `INSERT INTO upstream_repull_dispatches (kind, dataset_id, upstream_ds, from_tag, to_tag,
                                              repull_id, nonce, status, reported_at)
       VALUES ('open', ?, ?, '1.0.0', '1.0.1', ?, ?, 'started', datetime('now'))`,
      [DS, `ds${DS.slice(2)}`, id, "n".repeat(36)],
    );
    // The run's own create refuses an anonymous dataset; the tick does not speak for the run.
    db.run("UPDATE datasets SET first_published_at = NULL, anonymous = 1");
    const r = await resumeTick(TEN());
    expect(r).toMatchObject({ resumed: 0, running: 1, held: {} });
    expect(rowOf(id).hold_reason).toBeNull();
  });

  for (const last of ["failed", "unreported", "dispatch_failed", null] as const) {
    test(`a planned row whose last dispatch is ${last ?? "none"} is resumed`, async () => {
      const id = stalled("planned", TEN());
      if (last !== null) endedDispatch(id, last);
      expect((await resumeTick(TEN())).resumed).toBe(1);
    });
  }

  for (const [hour, minute, resumed] of [
    [0, 30, false],
    [2, 59, false],
    [3, 0, true],
    [15, 59, true],
    [16, 0, false],
    [23, 30, false],
  ] as const) {
    test(`at ${hour}:${String(minute).padStart(2, "0")} UTC it is ${resumed ? "" : "not "}resumed`, async () => {
      const now = utcToday(hour, minute);
      expect(inResumeWindow(now)).toBe(resumed);
      const id = stalled("copied", now);
      endedDispatch(id, "failed");
      const r = await resumeTick(now);
      expect(r.resumed).toBe(resumed ? 1 : 0);
      expect(dispatched("run-upstream-repull")).toHaveLength(resumed ? 1 : 0);
      if (!resumed) expect(rowOf(id).hold_reason).toBeNull();
    });
  }

  test("a row that moved within 60 minutes waits", async () => {
    const id = stalled("copied", TEN(), { quietMinutes: 59 });
    endedDispatch(id, "failed");
    expect(await resumeTick(TEN())).toMatchObject({ resumed: 0, notDue: 1 });
    expect(gh.dispatches).toEqual([]);
  });

  test("the attempt after 3 dispatches holds resume-exhausted: the creating one and two resumes", async () => {
    const id = stalled("copied", TEN());
    endedDispatch(id, "failed");
    endedDispatch(id, "dispatch_failed");
    expect((await resumeTick(TEN())).resumed).toBe(1);
    expect(dispatchesOf(id)).toHaveLength(3);
    // That run fails too, and the next tick finds the row's dispatches spent.
    db.run(
      "UPDATE upstream_repull_dispatches SET status = 'failed', code = 'copy-failed', nonce = NULL, reported_at = datetime('now') WHERE status = 'dispatched'",
    );
    const r = await resumeTick(new Date(TEN().getTime() + HALF_HOUR));
    expect(r).toMatchObject({ resumed: 0, held: { "resume-exhausted": 1 } });
    expect(rowOf(id).hold_reason).toBe("resume-exhausted");
    expect(dispatched("run-upstream-repull")).toHaveLength(1);
    expect(dispatchesOf(id)).toHaveLength(3);
  });

  const opensOf = (id: number) =>
    (db.query(ROW_DISPATCHES_SQL).get(DS, id) as { opens: number }).opens;

  for (const [status, code, spends] of [
    [401, "dispatch-deferred", false],
    [403, "dispatch-deferred", false],
    [429, "dispatch-deferred", false],
    [404, "dispatch-refused", true],
    [422, "dispatch-refused", true],
  ] as const) {
    test(`a resume GitHub refuses with ${status} ends ${code}, and ${spends ? "spends" : "does not spend"} one of the row's dispatches`, async () => {
      const id = stalled("copied", TEN());
      endedDispatch(id, "failed");
      expect(opensOf(id)).toBe(1);
      gh.dispatchStatus = status;
      const r = await resumeTick(TEN());
      expect(r).toMatchObject({ resumed: 0, errors: [code] });
      expect(dispatchesOf(id).at(-1)).toMatchObject({
        status: "dispatch_failed",
        code,
        nonce: null,
      });
      expect(opensOf(id)).toBe(spends ? 2 : 1);
      expect(usedToday()).toBe(0);
    });
  }

  test("runs that never reported spend the row's dispatches as runs that failed do", async () => {
    const id = stalled("copied", TEN());
    for (let n = 0; n < 3; n++) endedDispatch(id, "unreported");
    const r = await resumeTick(TEN());
    expect(r).toMatchObject({ resumed: 0, held: { "resume-exhausted": 1 } });
    expect(gh.dispatches).toEqual([]);
  });

  test("the latest dispatch decides: a refusal followed by a failure is resumed", async () => {
    const id = stalled("copied", TEN());
    endedDispatch(id, "refused");
    endedDispatch(id, "failed");
    expect((await resumeTick(TEN())).resumed).toBe(1);
  });

  test("the latest dispatch decides: a failure followed by a refusal holds resume-refused", async () => {
    const id = stalled("copied", TEN());
    endedDispatch(id, "failed");
    endedDispatch(id, "refused");
    const r = await resumeTick(TEN());
    expect(r).toMatchObject({ resumed: 0, held: { "resume-refused": 1 } });
  });

  test("a resume whose payload cannot be built after its claim ends the claim, and frees its unit", async () => {
    const id = stalled("copied", TEN());
    const e = env();
    const claim = await claimOpenDispatch(e, {
      datasetId: DS,
      upstreamDs: `ds${DS.slice(2)}`,
      fromTag: "1.0.0",
      toTag: "1.0.1",
      repullId: id,
    });
    if ("refused" in claim) throw new Error(`no claim: ${claim.refused}`);
    expect(usedToday()).toBe(1);
    // Every field is checked before a claim, so a payload that cannot be built means the two
    // checks drifted apart: here the row the send is given names no upstream dataset.
    const sent = await sendResumeDispatch(
      e,
      { id, dataset_id: DS, upstream_ds: "ds12", from_tag: "1.0.0", to_tag: "1.0.1" },
      claim,
      "ghp_repull_advance_test",
      { cliVersion: CLI, timeoutMs: 1_000 },
    );
    expect(sent).toEqual({ kind: "unbuilt", errorClass: "Error" });
    expect(dispatchesOf(id).at(-1)).toMatchObject({
      id: claim.id,
      status: "dispatch_failed",
      code: "dispatch-failed",
      nonce: null,
    });
    expect(usedToday()).toBe(0);
    expect(gh.dispatches).toEqual([]);
  });

  test("a row that records its tags with a leading v is resumed, and the dispatch names them bare", async () => {
    const id = stalled("copied", TEN(), { over: { from_tag: "v1.0.0", to_tag: "v1.0.1" } });
    endedDispatch(id, "failed");
    const r = await resumeTick(TEN());
    expect(r).toMatchObject({ resumed: 1, errors: [] });
    expect(dispatched("run-upstream-repull")[0]).toMatchObject({
      from_tag: "1.0.0",
      to_tag: "1.0.1",
    });
    expect(dispatchesOf(id).at(-1)).toMatchObject({
      status: "dispatched",
      from_tag: "1.0.0",
      to_tag: "1.0.1",
    });
  });

  test("a claim that does not find the row the tick read is an error, not a silent wait", async () => {
    const id = stalled("copied", TEN());
    endedDispatch(id, "failed");
    // The row's tag changes after the tick read it and before the claim's own statement reads it.
    const moving = interceptingD1(realD1(db), (sql) => {
      if (sql === CREATE_FACTS_SQL) db.run("UPDATE upstream_repulls SET to_tag = '9.9.9'");
    });
    const r = await resumeTick(TEN(), env({}, moving));
    expect(r).toMatchObject({ resumed: 0, errors: ["repull-mismatch"] });
    expect(dispatchesOf(id)).toHaveLength(1);
    expect(gh.dispatches).toEqual([]);
    expect(repullAdvanceLogLine(r)?.level).toBe("error");
  });

  test("two ticks in a row do not resume a row whose run failed between them", async () => {
    const id = stalled("copied", TEN());
    endedDispatch(id, "failed");
    expect((await resumeTick(TEN())).resumed).toBe(1);
    // The resumed run fails five minutes in, writing nothing to the row: its updated_at is still
    // two hours old, and only the dispatch says when the row last moved.
    db.run(
      `UPDATE upstream_repull_dispatches SET status = 'failed', code = 'copy-failed', nonce = NULL,
         reported_at = ? WHERE status = 'dispatched'`,
      [d1Time(new Date(TEN().getTime() + 5 * 60_000))],
    );
    const next = await resumeTick(new Date(TEN().getTime() + HALF_HOUR));
    expect(next).toMatchObject({ resumed: 0, notDue: 1 });
    expect(dispatched("run-upstream-repull")).toHaveLength(1);
    // An hour after that failure it is resumed again.
    const later = await resumeTick(new Date(TEN().getTime() + 65 * 60_000));
    expect(later.resumed).toBe(1);
    expect(dispatched("run-upstream-repull")).toHaveLength(2);
  });

  for (const [minutes, resumed] of [
    [59, false],
    [60, true],
  ] as const) {
    test(`a run that reported ${minutes} minutes ago is ${resumed ? "" : "not "}resumed`, async () => {
      const id = stalled("copied", TEN());
      endedDispatch(id, "failed", DS, d1Time(new Date(TEN().getTime() - minutes * 60_000)));
      expect((await resumeTick(TEN())).resumed).toBe(resumed ? 1 : 0);
    });
  }

  test("a time that does not parse is an error, never a quiet wait", async () => {
    const id = stalled("copied", TEN(), { over: { updated_at: "not a time" } });
    endedDispatch(id, "failed");
    const r = await resumeTick(TEN());
    expect(r).toMatchObject({ resumed: 0, notDue: 0, errors: ["time-unreadable"] });
    expect(dispatchesOf(id)).toHaveLength(1);
    expect(gh.dispatches).toEqual([]);
    expect(repullAdvanceLogLine(r)?.level).toBe("error");
  });

  test("a run that refused holds resume-refused, and is not sent again", async () => {
    const id = stalled("prepared", TEN());
    endedDispatch(id, "refused");
    const r = await resumeTick(TEN());
    expect(r).toMatchObject({ resumed: 0, held: { "resume-refused": 1 } });
    expect(gh.dispatches).toEqual([]);
  });

  test("a full day of the open cap: no resume, and the row says cap-exhausted", async () => {
    const id = stalled("copied", TEN());
    endedDispatch(id, "failed");
    const other = stalled("copied", TEN(), { ds: "on098802" });
    endedDispatch(other, "failed", "on098802");
    // Another dataset's first dispatch of today takes the one unit the cap allows.
    db.run(
      `INSERT INTO upstream_repull_dispatches (kind, dataset_id, upstream_ds, from_tag, to_tag, status,
                                              code, reported_at)
       VALUES ('open', 'on098803', 'ds098803', '1.0.0', '1.0.1', 'failed', 'copy-failed', datetime('now'))`,
    );
    const r = await resumeTick(TEN(), env({ REPULL_DAILY_OPEN_CAP: "1" }));
    expect(r).toMatchObject({ resumed: 0, held: { "cap-exhausted": 2 } });
    expect(gh.dispatches).toEqual([]);
    expect(dispatchesOf(id)).toHaveLength(1);
    expect(dispatchesOf(other)).toHaveLength(1);
    expect(usedToday()).toBe(1);
  });

  for (const [cap, errors, word] of [
    ["0", [], "cap-exhausted"],
    ["x", ["cap-unreadable"], "cap-unreadable"],
    ["21", ["cap-unreadable"], "cap-unreadable"],
  ] as const) {
    test(`REPULL_DAILY_OPEN_CAP=${cap}: no resume, and both stalled rows say ${word}`, async () => {
      const id = stalled("copied", TEN());
      endedDispatch(id, "failed");
      const other = stalled("copied", TEN(), { ds: "on098802" });
      endedDispatch(other, "failed", "on098802");
      const r = await resumeTick(TEN(), env({ REPULL_DAILY_OPEN_CAP: cap }));
      expect(r).toMatchObject({ resumed: 0, errors, held: { [word]: 2 } });
      expect(rowOf(id).hold_reason).toBe(word);
      expect(rowOf(other).hold_reason).toBe(word);
      expect(gh.dispatches).toEqual([]);
    });
  }

  const fenced: Array<[string, () => void, string]> = [
    [
      "the dataset became anonymous",
      () => db.run("UPDATE datasets SET first_published_at = NULL, anonymous = 1"),
      "dataset-anonymous",
    ],
    [
      "the dataset was withdrawn",
      () => db.run("UPDATE datasets SET withdrawn_at = datetime('now')"),
      "dataset-withdrawn",
    ],
    [
      "an import of it has not settled",
      () =>
        db.run(
          `INSERT INTO import_jobs (dataset_id, source, source_id, status)
           VALUES (?, 'openneuro', ?, 'copying')`,
          [DS, `ds${DS.slice(2)}`],
        ),
      "import-in-flight",
    ],
    [
      "it is no longer the mirror the record names",
      () => db.run("UPDATE datasets SET source_id = 'ds000001'"),
      "dataset-not-mirror",
    ],
    [
      "the plan stated a correction",
      () =>
        db.run(
          `UPDATE upstream_repulls SET counts = '{"unexplained":0,"conflicts":0,"corrections":1}'`,
        ),
      "has-corrections",
    ],
  ];
  for (const [name, flip, word] of fenced) {
    test(`${name}: held ${word}, nothing sent`, async () => {
      const id = stalled("copied", TEN());
      endedDispatch(id, "failed");
      flip();
      const r = await resumeTick(TEN());
      expect(r).toMatchObject({ resumed: 0, held: { [word]: 1 } });
      expect(gh.dispatches).toEqual([]);
      expect(dispatchesOf(id)).toHaveLength(1);
      expect(githubRequests()).toEqual([]);
    });
  }

  test("GitHub refuses the resume: its dispatch ends dispatch_failed, its unit is freed, and the tick sends no more", async () => {
    const a = stalled("copied", TEN());
    endedDispatch(a, "failed");
    const b = stalled("copied", TEN(), { ds: "on098802" });
    endedDispatch(b, "failed", "on098802");
    gh.dispatchStatus = 422;
    const r = await resumeTick(TEN());
    expect(r).toMatchObject({ resumed: 0, notDue: 1, errors: ["dispatch-refused"] });
    expect(dispatchesOf(a).at(-1)).toMatchObject({
      status: "dispatch_failed",
      code: "dispatch-refused",
      nonce: null,
    });
    expect(dispatchesOf(b)).toHaveLength(1);
    expect(usedToday()).toBe(0);
    expect(gh.requests.filter((q) => q.endsWith("/.github/dispatches"))).toHaveLength(1);
  });

  test("a resume whose answer was lost keeps its dispatch and its unit, and is an error to log", async () => {
    const id = stalled("copied", TEN());
    endedDispatch(id, "failed");
    gh.slow = "/dispatches";
    gh.slowMs = 400;
    const r = await resumeTick(TEN(), env(), { dispatchTimeoutMs: 50 });
    expect(r).toMatchObject({ resumed: 0, unconfirmed: 1 });
    expect(dispatchesOf(id).at(-1)).toMatchObject({ status: "dispatched" });
    expect(usedToday()).toBe(1);
    expect(repullAdvanceLogLine(r)?.level).toBe("error");
  });

  test("with the open switch off a stalled row says switch-off, and nothing is claimed or sent", async () => {
    const id = stalled("copied", TEN());
    endedDispatch(id, "failed");
    const r = await resumeTick(TEN(), env({ AUTO_REPULL_ENABLED: undefined }));
    expect(r).toMatchObject({ resumed: 0, held: { "switch-off": 1 } });
    expect(dispatchesOf(id)).toHaveLength(1);
    expect(gh.requests).toEqual([]);
  });

  test("with the open switch off even a stalled row a run is out for says switch-off", async () => {
    const id = stalled("copied", TEN());
    db.run(
      `INSERT INTO upstream_repull_dispatches (kind, dataset_id, upstream_ds, from_tag, to_tag,
                                              repull_id, nonce, status)
       VALUES ('open', ?, ?, '1.0.0', '1.0.1', ?, ?, 'dispatched')`,
      [DS, `ds${DS.slice(2)}`, id, "n".repeat(36)],
    );
    const r = await resumeTick(TEN(), env({ AUTO_REPULL_ENABLED: undefined }));
    expect(r).toMatchObject({ running: 0, held: { "switch-off": 1 } });
  });

  test("no GitHub token: nothing is claimed, and the tick says no-github-token", async () => {
    const id = stalled("copied", TEN());
    endedDispatch(id, "failed");
    const r = await resumeTick(TEN(), env({ GITHUB_ADMIN_PAT: undefined }));
    expect(r).toMatchObject({ resumed: 0, errors: ["no-github-token"] });
    expect(dispatchesOf(id)).toHaveLength(1);
    expect(gh.requests).toEqual([]);
  });

  test("no callback secret: nothing is claimed, and the tick says dispatch-unconfigured", async () => {
    const id = stalled("copied", TEN());
    endedDispatch(id, "failed");
    const r = await resumeTick(TEN(), env({ PRESCREEN_CALLBACK_SECRET: undefined }));
    expect(r).toMatchObject({ resumed: 0, errors: ["dispatch-unconfigured"] });
    expect(dispatchesOf(id)).toHaveLength(1);
    expect(gh.dispatches).toEqual([]);
  });

  test("a recorded tag that is not a tag: nothing is claimed, and the tick says to-tag-malformed", async () => {
    const id = stalled("copied", TEN(), { over: { to_tag: "not a tag" } });
    endedDispatch(id, "failed");
    const r = await resumeTick(TEN());
    expect(r).toMatchObject({ resumed: 0, errors: ["to-tag-malformed"] });
    expect(dispatchesOf(id)).toHaveLength(1);
    expect(gh.dispatches).toEqual([]);
  });

  test("a development build resumes nothing", async () => {
    const id = stalled("copied", TEN());
    endedDispatch(id, "failed");
    const r = await resumeTick(TEN(), env(), { cliVersion: "0.10.21-dev0" });
    expect(r).toMatchObject({ resumed: 0, errors: ["cli-unreleased"] });
    expect(dispatchesOf(id)).toHaveLength(1);
    expect(gh.dispatches).toEqual([]);
  });

  test("an administrator's stalled row is never resumed", async () => {
    const id = stalled("copied", TEN(), { over: { origin: "administrator" } });
    const r = await resumeTick(TEN());
    expect(r).toMatchObject({ examined: 0, resumed: 0 });
    expect(rowOf(id).hold_reason).toBeNull();
    expect(gh.requests).toEqual([]);
  });
});

describe("what a tick costs", () => {
  // The 30-minute tick shares one invocation's subrequest allowance with every job on it, so the
  // advance tick's own use is counted here from the code as it runs: every D1 statement prepared
  // (a batch's statements each count) and every request to GitHub. Five rows, the most a tick reads.
  test("five rows starting their screens, waiting on them, starting their reviews, and clearing", async () => {
    let statements = 0;
    const base = realD1(db);
    const counting = {
      prepare(sql: string) {
        statements++;
        return base.prepare(sql);
      },
      batch: (s: never[]) => base.batch(s),
    } as unknown as D1Database;
    const measure = async () => {
      statements = 0;
      gh.requests = [];
      await tick(env({}, counting));
      return { d1: statements, github: githubRequests().length };
    };
    const datasets = [1, 2, 3, 4, 5].map((i) => `on0988${String(i).padStart(2, "0")}`);
    const ids = datasets.map((ds) => openRow(ds));

    const seen: Array<{ d1: number; github: number }> = [];
    // Each row's screen is started.
    seen.push(await measure());
    // Each waits on it: the facts are read again, and nothing is written.
    seen.push(await measure());
    // Each screen is clear, and each row's review is started: the most a tick spends.
    ids.forEach((id, k) => markScreen(id, "clean", datasets[k]));
    seen.push(await measure());
    // Each is clean, and the record's own transition reads its live head before it writes.
    db.run("DELETE FROM pr_reviews");
    datasets.forEach((ds) => review("pass", ds));
    seen.push(await measure());
    expect(seen).toEqual([
      { d1: 67, github: 25 },
      { d1: 37, github: 20 },
      { d1: 82, github: 35 },
      { d1: 52, github: 25 },
    ]);
    expect(ids.every((id) => rowOf(id).status === "gates_clear")).toBe(true);
  });

  test("a stalled row's resume", async () => {
    let statements = 0;
    const base = realD1(db);
    const counting = {
      prepare(sql: string) {
        statements++;
        return base.prepare(sql);
      },
      batch: (s: never[]) => base.batch(s),
    } as unknown as D1Database;
    const now = utcToday(10);
    const id = stalled("copied", now);
    endedDispatch(id, "failed");
    const r = await resumeTick(now, env({}, counting));
    expect(r.resumed).toBe(1);
    // Eight for the row and two for the tick (the list of rows, the stamp); one dispatch.
    expect({ d1: statements, github: gh.requests.length }).toEqual({ d1: 10, github: 1 });
  });
});
