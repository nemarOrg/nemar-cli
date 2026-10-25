/**
 * The automatic re-pull's advance tick (epic #1046 phase 7, #1913; ADR 0111, decisions 6 and 7),
 * through its real entry point, `runRepullAdvanceCron`, which the production 30-minute tick calls.
 *
 * Real engine only: bun:sqlite behind realD1 with every migration applied, the real record, its
 * transitions, the machine-clean facts and rule. A `Bun.serve()` stand-in for api.github.com
 * (`helpers/repull-github-standin.ts`, through NEMAR_GITHUB_API_URL) answers the pull request,
 * `main` and the check runs and records every request; no dataset id here is asked of the real
 * GitHub. The Resend capture is armed around every test and must stay empty.
 *
 * The properties, each with a test that fails when its line is changed:
 *  - outside ENVIRONMENT exactly `production` nothing is read, written or sent;
 *  - with the open switch not exactly "1" GitHub is asked nothing, and the row says `switch-off`;
 *  - a hold is the first rule that does not hold, written once per change of word with one audit
 *    row, never over a row that moved, and ended by an edge into another status;
 *  - an administrator's row is never read, and a tick reads at most five rows, in rotation.
 */

import type { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { parseScreenReport } from "../../shared/identifier-screen-report";
import { NEMAR_APP_BOT_LOGIN, NEMAR_APP_BOT_USER_ID, NEMAR_APP_ID } from "../../shared/nemar-app";
import type { RepullStatus } from "../../shared/repull-state";
import { SYSTEM_USER_ID } from "../src/lib/constants";
import { __resetRateLimitStateForTests } from "../src/services/github/transport";
import { getRepull, isRefusal, transitionRepull } from "../src/services/upstream-repull";
import {
  ADVANCE_ROWS_PER_TICK,
  ADVANCE_TICK_MINUTES,
  type AdvanceTickResult,
  REPULL_HOLD_SQL,
  advanceWindow,
  repullAdvanceLogLine,
  runRepullAdvanceCron,
} from "../src/services/upstream-repull-advance";
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

/** Production and the open switch on, unless overridden (`undefined` removes a binding). */
function env(over: Record<string, string | undefined> = {}, d1?: D1Database): Bindings {
  const bindings: Record<string, unknown> = {
    DB: d1 ?? realD1(db),
    ENVIRONMENT: "production",
    AUTO_REPULL_ENABLED: "1",
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

/** Both checks of `sha`, the App's own, green. */
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
function markScreen(id: number, status: string, ds: string = DS): void {
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

/** A passing ADR 0107 review of HEAD of `ds`'s pull request #7. */
function passReview(ds: string = DS): void {
  seedReview(db, {
    ds,
    n: 7,
    sha: HEAD,
    state: "reported",
    verdict: "pass",
    login: NEMAR_APP_BOT_LOGIN,
    authorId: NEMAR_APP_BOT_USER_ID,
  });
}

interface RowNow {
  status: string;
  hold_reason: string | null;
  hold_since: string | null;
  revision: number;
  updated_at: string;
}

const rowOf = (id: number) =>
  db
    .query(
      "SELECT status, hold_reason, hold_since, revision, updated_at FROM upstream_repulls WHERE id = ?",
    )
    .get(id) as RowNow;

const holdAudits = (id?: number) =>
  (
    db.query("SELECT * FROM audit_log WHERE action = 'repull_hold' ORDER BY id").all() as Array<
      Record<string, unknown>
    >
  ).filter((a) => id === undefined || a.resource_id === String(id));

const githubRequests = () => gh.requests.filter((r) => r.includes("/repos/"));

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
      const id = openRow();
      markScreen(id, "clean");
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
    expect(r).toMatchObject({ waiting: 0, held: { "switch-off": 1 } });
    expect(rowOf(id).hold_reason).toBe("switch-off");
  });

  for (const value of [undefined, "true", "0", " 1", ""]) {
    test(`AUTO_REPULL_ENABLED=${JSON.stringify(value)}: the pull request is not read, and the row says switch-off`, async () => {
      const id = openRow();
      const r = await tick(env({ AUTO_REPULL_ENABLED: value }));
      expect(githubRequests()).toEqual([]);
      expect(r).toMatchObject({ examined: 1, held: { "switch-off": 1 }, holdsChanged: 1 });
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
    [
      "main moved",
      () => {
        gh.mainRefs[DS] = OTHER;
      },
      "main-moved",
      { github: true },
    ],
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
      passReview();
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
    const id = openRow();
    const before = rowOf(id);
    await tick();
    const after = rowOf(id);
    expect(after.hold_reason).toBe("screen-rerun");
    expect(after.revision).toBe(before.revision);
    expect(after.updated_at).toBe(before.updated_at);
  });

  test("a new word replaces the old one, from the time it began, with one audit row more", async () => {
    const id = openRow();
    gh.mainRefs[DS] = OTHER;
    await tick();
    expect(rowOf(id).hold_reason).toBe("main-moved");
    db.run("UPDATE upstream_repulls SET hold_since = '2026-01-01 00:00:00' WHERE id = ?", [id]);
    gh.mainRefs[DS] = BASE;
    await tick();
    const now = rowOf(id);
    expect(now.hold_reason).toBe("screen-rerun");
    expect(now.hold_since).not.toBe("2026-01-01 00:00:00");
    expect(holdAudits(id).map((a) => JSON.parse(String(a.details)))).toEqual([
      { dataset_id: DS, status: "pr_open", from: null, to: "main-moved" },
      { dataset_id: DS, status: "pr_open", from: "main-moved", to: "screen-rerun" },
    ]);
  });

  test("a row that moved while the tick read it is not written", async () => {
    const id = openRow();
    // Another writer moves the row (a transition bumps its revision) after the tick read it and
    // before it records the hold.
    const moving = interceptingD1(realD1(db), (sql) => {
      if (sql === REVIEW_OF_HEAD_SQL) {
        db.run("UPDATE upstream_repulls SET revision = revision + 1 WHERE id = ?", [id]);
      }
    });
    const r = await tick(env({}, moving));
    expect(r.held).toEqual({ "screen-rerun": 1 });
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
    expect(r).toMatchObject({ examined: 1, waiting: 1, held: {}, holdsChanged: 1 });
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
    await tick();
    expect(rowOf(id).hold_reason).toBe("screen-rerun");
    const admin = { id: adminId };
    const self = await transitionRepull(env(), admin, id, {
      from: "pr_open",
      to: "pr_open",
      fields: { branch: "release/v2.0.0", pr_number: 7, head_sha: OTHER },
    });
    expect(isRefusal(self)).toBe(false);
    expect(rowOf(id)).toMatchObject({ status: "pr_open", hold_reason: "screen-rerun" });
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
  test("an administrator's row is never read, and takes no place in the rotation", async () => {
    const admins: number[] = [];
    for (let i = 2; i <= ADVANCE_ROWS_PER_TICK + 1; i++) {
      const ds = `on09880${i}`;
      admins.push(openRow(ds, { origin: "administrator" }));
    }
    const auto = openRow(DS.replace("01", "09"));
    // The rotation would start at the first row of every row, administrators' included.
    const r = await tick(env(), instantAt(0, admins.length + 1));
    expect(r.examined).toBe(1);
    expect(rowOf(auto).hold_reason).toBe("screen-rerun");
    for (const id of admins) expect(rowOf(id).hold_reason).toBeNull();
    // Nothing of an administrator's pull request was asked of GitHub.
    for (let i = 2; i <= ADVANCE_ROWS_PER_TICK + 1; i++) {
      expect(githubRequests().filter((q) => q.includes(`on09880${i}`))).toEqual([]);
    }
  });

  test("at most five rows a tick, and the next half hour reads the rest", async () => {
    const ids: number[] = [];
    for (let i = 1; i <= 7; i++) ids.push(openRow(`on0988${String(i).padStart(2, "0")}`));
    const first = instantAt(0, ids.length);
    const r1 = await tick(env(), first);
    expect(r1.examined).toBe(ADVANCE_ROWS_PER_TICK);
    expect(ids.filter((id) => rowOf(id).hold_reason !== null)).toHaveLength(5);
    const r2 = await tick(env(), new Date(first.getTime() + HALF_HOUR));
    expect(r2.examined).toBe(ADVANCE_ROWS_PER_TICK);
    expect(ids.every((id) => rowOf(id).hold_reason === "screen-rerun")).toBe(true);
  });

  test("the rotation covers every row of a stable set, however long any of them waits", () => {
    const ids = [3, 5, 8, 13, 21, 34, 55, 89, 144, 233, 377];
    for (const n of [1, 5, 6, ids.length]) {
      const set = ids.slice(0, n);
      const start = Math.floor(Date.now() / HALF_HOUR);
      const seen = new Set<number>();
      for (let k = 0; k < Math.ceil(n / ADVANCE_ROWS_PER_TICK); k++) {
        const window = advanceWindow(set, new Date((start + k) * HALF_HOUR));
        expect(window.length).toBe(Math.min(n, ADVANCE_ROWS_PER_TICK));
        for (const id of window) seen.add(id);
      }
      expect([...seen].sort((a, b) => a - b)).toEqual(set);
    }
  });
});

describe("the log line", () => {
  test("says nothing when nothing changed, and counts when something did", async () => {
    openRow();
    const r = await tick();
    expect(repullAdvanceLogLine(r)).toEqual({
      level: "info",
      line: "[repull-advance] examined=1 waiting=0 holds_changed=1 held=screen-rerun:1",
    });
    expect(repullAdvanceLogLine(await tick())).toBeNull();
  });

  test("is an error, with fixed words only, when something failed", async () => {
    openRow();
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
});
