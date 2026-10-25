/**
 * The automatic re-pull's scheduler (epic #1046 phase 7, #1913; ADR 0111, decision 6 and the
 * Phase 7 slices), through its real entry point, `runRepullSchedulerCron`, which the production
 * daily cron calls.
 *
 * Real engine only: bun:sqlite behind realD1 with every migration applied, the real staleness
 * report, the real dispatch record and its claim. Three loopback servers stand in for the outside
 * world and record every request: OpenNeuro's GraphQL endpoint (`helpers/openneuro-standin.ts`, in
 * its synthetic mode: every dataset here has the snapshots 0.9.0 then 1.0.0), OpenNeuro's GitHub
 * mirror on the raw content host (`helpers/raw-mirror-standin.ts`), and GitHub's dispatch endpoint.
 * No dataset id here is a real mirror's, except the two the design record's gate G4 names, which
 * appear only as re-pull records in the in-memory database (nothing is asked about them, here or
 * anywhere). The UTC day of the cap is D1's clock, so "yesterday" and
 * "ten days ago" are seeded as past timestamps, never by moving a clock. The Resend capture is armed
 * around every test and must stay empty.
 *
 * The properties, each with a test that fails when its line is changed:
 *  - outside ENVIRONMENT exactly `production` nothing is read, written or sent;
 *  - with the open switch not exactly "1" the tick asks OpenNeuro nothing and dispatches nothing;
 *  - only `stale_ready` mirrors are dispatched, to the latest tag, lowest ids after the cursor, and
 *    never an unpublished, lagging, unverified, anonymous, recently pulled, content-refused or
 *    unreconciled one;
 *  - the cap is the dispatch record's: a full day asks OpenNeuro nothing, a refused send frees its
 *    unit, an unanswered one keeps it, and two ticks at once cannot pass it;
 *  - a refusal the next mirror would meet too (401, 403, 404, 429, or a second one) stops the tick
 *    as `send-refused` before that mirror;
 *  - nothing is dispatched before both of gate G4's re-pulls were run by hand to `complete`, from a
 *    development build, or from what OpenNeuro, the probes or their credential could not show;
 *  - the cursor rotates, wraps, never passes a stale mirror the probes did not reach, passes a
 *    mirror the report could not compare, and is held by one that always throws (or by probes
 *    that all fail) for two ticks at most; a tick reads at most three pages, makes at most ten
 *    probes, and its subrequests are counted.
 */

import type { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import pkg from "../../package.json" with { type: "json" };
import type { DispatchRow } from "../../shared/repull-state";
import { verifyRepullDispatchToken } from "../src/services/github";
import {
  CANDIDATE_BLOCKERS_SQL,
  type CandidateBlockers,
  MANUAL_RUN_PROOF_SQL,
  REPULL_G4_DATASETS,
  REPULL_SCAN_PAGES,
  REPULL_SCAN_PROBE_BUDGET,
  type SchedulerTickResult,
  candidateSkip,
  readCandidateBlockers,
  repullSchedulerLogLine,
  runRepullSchedulerCron,
} from "../src/services/upstream-repull-scheduler";
import type { Bindings } from "../src/types/bindings";
import { freshDb, realD1, wrapD1, yieldingD1 } from "./helpers/d1";
import { startOpenNeuroStandin } from "./helpers/openneuro-standin";
import { startRawHost } from "./helpers/raw-mirror-standin";
import { type Row, SHA, rowAt } from "./helpers/repull-rows";
import { type CapturedEmail, withFakeResend } from "./helpers/resend";

const SECRET = "repull-scheduler-test-secret";
const PAT = "repull-scheduler-test-pat";
const CLI = "1.2.3";

// ----------------------------------------------------------------------------
// Stand-ins
// ----------------------------------------------------------------------------

interface Dispatched {
  path: string;
  authorization: string | null;
  body: { event_type: string; client_payload: Record<string, string> };
}

let openneuro: ReturnType<typeof startOpenNeuroStandin>;
let raw: ReturnType<typeof startRawHost>;
let github: Server;
const sent: Dispatched[] = [];
/** What the dispatch endpoint answers, one entry per request, then 204. */
let answers: Array<number | "hang"> = [];
let previousBase: string | undefined;

beforeAll(() => {
  openneuro = startOpenNeuroStandin();
  raw = startRawHost();
  github = Bun.serve({
    port: 0,
    async fetch(req) {
      sent.push({
        path: new URL(req.url).pathname,
        authorization: req.headers.get("authorization"),
        body: (await req.json()) as Dispatched["body"],
      });
      const answer = answers.shift() ?? 204;
      if (answer === "hang") return new Promise<Response>(() => {});
      return new Response(answer === 204 ? null : "no", { status: answer });
    },
  });
  const g = globalThis as { NEMAR_GITHUB_API_URL?: string };
  previousBase = g.NEMAR_GITHUB_API_URL;
  g.NEMAR_GITHUB_API_URL = `http://127.0.0.1:${github.port}`;
});

afterAll(() => {
  (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL = previousBase;
  openneuro.stop();
  raw.stop();
  github.stop(true);
});

let db: Database;
let mail: CapturedEmail[] = [];
let releaseMail: (() => void) | null = null;
let mailDone: Promise<void> | null = null;
let ownerId = 0;

beforeEach(async () => {
  db = freshDb();
  openneuro.reset();
  openneuro.synthetic(true);
  raw.reset();
  sent.length = 0;
  answers = [];
  db.run(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified)
     VALUES ('schedowner', 'schedowner@example.org', 'x', 'approved', 'admin', 1)`,
  );
  ownerId =
    db.query<{ id: number }, []>("SELECT id FROM users WHERE username = 'schedowner'").get()?.id ??
    0;
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
  releaseMail = null;
  mailDone = null;
  expect(mail).toEqual([]);
});

/** Production, the open switch on, a callback secret and the probes' credential, unless overridden. */
function env(over: Record<string, string | undefined> = {}, d1?: D1Database): Bindings {
  const bindings: Record<string, unknown> = {
    DB: d1 ?? realD1(db),
    ENVIRONMENT: "production",
    AUTO_REPULL_ENABLED: "1",
    PRESCREEN_CALLBACK_SECRET: SECRET,
    GITHUB_ADMIN_PAT: PAT,
    GITHUB_RAW_BASE: raw.base,
    OPENNEURO_GRAPHQL_URL: openneuro.url,
  };
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) delete bindings[k];
    else bindings[k] = v;
  }
  return bindings as unknown as Bindings;
}

const tick = (
  e: Bindings = env(),
  opts: { dispatchTimeoutMs?: number; cliVersion?: string } = {},
) => runRepullSchedulerCron(e, { cliVersion: CLI, ...opts }) as Promise<SchedulerTickResult>;

// ----------------------------------------------------------------------------
// Seeding
// ----------------------------------------------------------------------------

const dsOf = (id: string) => `ds${id.slice(2)}`;

interface MirrorOptions {
  /** The recorded tag of 1.0.0; null records `unknown`; undefined is 0.9.0 (stale). */
  tag?: string | null;
  /** No version row at all. */
  unpublished?: boolean;
  anonymous?: number;
  /** What OpenNeuro's GitHub mirror answers at the latest tag: ready (default), lag or error. */
  mirror?: "ready" | "lag" | "error";
}

/** A managed mirror with version 1.0.0 recorded at 0.9.0, so upstream's 1.0.0 is newer. */
function mirror(id: string, o: MirrorOptions = {}): void {
  db.query(
    `INSERT INTO datasets (dataset_id, name, owner_user_id, github_repo, visibility, source, source_id, anonymous)
     VALUES (?, ?, ?, ?, 'public', 'openneuro', ?, ?)`,
  ).run(id, id, ownerId, `nemarDatasets/${id}`, dsOf(id), o.anonymous ?? 0);
  if (!o.unpublished) {
    const tag = o.tag === undefined ? "0.9.0" : o.tag;
    db.query(
      `INSERT INTO dataset_versions (dataset_id, version, doi, source_version, source_version_basis, created_at)
       VALUES (?, '1.0.0', ?, ?, ?, '2025-06-01 00:00:00')`,
    ).run(id, `10.82901/${id}.v1.0.0`, tag, tag === null ? "unknown" : "doi");
  }
  const m = o.mirror ?? "ready";
  if (m === "ready") raw.serve(dsOf(id), "1.0.0");
  if (m === "error") raw.serve(dsOf(id), "1.0.0", 500);
  if (m === "lag") raw.serve(dsOf(id), "HEAD");
}

function insert(table: string, row: Row): number {
  const cols = Object.keys(row);
  return Number(
    db
      .query(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`)
      .run(...(cols.map((c) => row[c]) as never[])).lastInsertRowid,
  );
}

function repull(id: string, status: Parameters<typeof rowAt>[0], over: Row = {}): number {
  return insert(
    "upstream_repulls",
    rowAt(status, {
      dataset_id: id,
      upstream_ds: dsOf(id),
      from_tag: "0.9.0",
      to_tag: "1.0.0",
      actor_user_id: ownerId,
      ...over,
    }),
  );
}

/** An ended dispatch of `id` (no nonce), sent `daysAgo` days ago. */
function pastDispatch(id: string, daysAgo: number, over: Row = {}): number {
  return insert("upstream_repull_dispatches", {
    kind: "open",
    dataset_id: id,
    upstream_ds: dsOf(id),
    from_tag: "0.9.0",
    to_tag: "1.0.0",
    status: "failed",
    code: "runner-failed",
    dispatched_at: db
      .query<{ t: string }, [string]>("SELECT datetime('now', ?) AS t")
      .get(`-${daysAgo} days`)?.t as string,
    reported_at: "2026-01-01 00:00:00",
    ...over,
  });
}

/** One of gate G4's re-pulls, run by an administrator to `complete` with its tag. */
function manualRun(id: string, over: Row = {}): void {
  repull(id, "complete", { origin: "administrator", created_at: "2026-01-01 00:00:00", ...over });
}

/** Gate G4: both re-pulls the design record names, run by an administrator to `complete`. */
function manualRunDone(): void {
  for (const id of REPULL_G4_DATASETS) manualRun(id);
}

/**
 * A fleet with every case ADR 0111's Phase 7 amendment (the 7c slice) names: four eligible
 * `stale_ready` mirrors (01, 06, 11, 12), one `current`, one `unknown`, one `unpublished` with
 * upstream newer, an anonymous `stale_ready`, one with an open re-pull, one dispatched ten days
 * ago, one refused for content at the same tag, one with an unreconciled merge claim, one whose tag
 * has not reached the GitHub mirror and one the mirror could not answer for.
 */
function fleet(): void {
  manualRunDone();
  mirror("on099901");
  mirror("on099902", { tag: "1.0.0" });
  mirror("on099903", { tag: null });
  mirror("on099904", { unpublished: true });
  mirror("on099905", { anonymous: 1 });
  mirror("on099906");
  mirror("on099907");
  repull("on099907", "pr_open", { origin: "administrator" });
  mirror("on099908");
  pastDispatch("on099908", 10);
  mirror("on099909");
  pastDispatch("on099909", 40, { status: "refused", code: "auto-not-clean-plan" });
  mirror("on099910");
  repull("on099910", "failed", {
    merge_claimed_at: "2026-01-01 00:00:00",
    merge_claim_sha: SHA,
    created_at: "2026-01-01 00:00:00",
  });
  mirror("on099911");
  mirror("on099912");
  mirror("on099913", { mirror: "lag" });
  mirror("on099914", { mirror: "error" });
}

const dispatches = () =>
  db.query("SELECT * FROM upstream_repull_dispatches ORDER BY id").all() as DispatchRow[];
const liveDispatches = () => dispatches().filter((d) => d.status === "dispatched");
const scheduler = () =>
  db.query("SELECT * FROM upstream_repull_scheduler").get() as {
    scan_after: string;
    last_tick_at: string | null;
    last_outcome: string | null;
  };
const sentFor = () => sent.map((s) => s.body.client_payload.dataset_id);
const setCursor = (c: string) =>
  db.query("UPDATE upstream_repull_scheduler SET scan_after = ?").run(c);
/** Every table a tick could write. */
const tables = () => ({
  dispatches: dispatches(),
  scheduler: db.query("SELECT * FROM upstream_repull_scheduler").all(),
  repulls: db.query("SELECT * FROM upstream_repulls ORDER BY id").all(),
  audit: db.query("SELECT * FROM audit_log ORDER BY id").all(),
  versions: db.query("SELECT * FROM dataset_versions ORDER BY dataset_id, version").all(),
});

// ----------------------------------------------------------------------------
// The fences
// ----------------------------------------------------------------------------

describe("outside exact production nothing is read, written or sent", () => {
  for (const value of ["development", "staging", "test", undefined, "Production", " production"]) {
    test(`ENVIRONMENT ${JSON.stringify(value)}, both switches "1"`, async () => {
      fleet();
      const before = tables();
      let statements = 0;
      const counted = wrapD1(realD1(db), () => {
        statements++;
      });
      const e = env({ ENVIRONMENT: value, AUTO_REPULL_MERGE_ENABLED: "1" }, counted);
      expect(await runRepullSchedulerCron(e, { cliVersion: CLI })).toBeNull();
      expect(statements).toBe(0);
      expect(openneuro.log).toEqual([]);
      expect(raw.log).toEqual([]);
      expect(sent).toEqual([]);
      expect(tables()).toEqual(before);
    });
  }
});

describe("the open switch", () => {
  for (const value of [undefined, "true", "0", " 1", ""]) {
    test(`AUTO_REPULL_ENABLED ${JSON.stringify(value)}: switch-off, and OpenNeuro is not asked`, async () => {
      fleet();
      setCursor("on099905");
      const r = await tick(env({ AUTO_REPULL_ENABLED: value }));
      expect(r.outcome).toBe("switch-off");
      expect(openneuro.log).toEqual([]);
      expect(raw.log).toEqual([]);
      expect(sent).toEqual([]);
      expect(
        dispatches().filter((d) => d.dataset_id !== "on099908" && d.dataset_id !== "on099909"),
      ).toEqual([]);
      const s = scheduler();
      expect(s.last_outcome).toBe("switch-off");
      expect(s.last_tick_at).not.toBeNull();
      expect(s.scan_after).toBe("on099905");
    });
  }
});

// ----------------------------------------------------------------------------
// Candidates
// ----------------------------------------------------------------------------

describe("which mirrors are dispatched", () => {
  test("the two lowest eligible after the cursor, each to the latest tag the report read", async () => {
    fleet();
    const r = await tick();
    expect(r).toMatchObject({ outcome: "ran", dispatched: 2, sendFailed: 0, unconfirmed: 0 });
    expect(r.skipped).toEqual({ anonymous: 1 });
    expect(sentFor()).toEqual(["on099901", "on099906"]);

    const rows = liveDispatches();
    expect(rows.map((d) => d.dataset_id)).toEqual(["on099901", "on099906"]);
    for (const [i, s] of sent.entries()) {
      const d = rows[i] as DispatchRow;
      expect(s.path).toBe("/repos/nemarDatasets/.github/dispatches");
      expect(s.authorization).toBe(`Bearer ${PAT}`);
      expect(s.body.event_type).toBe("run-upstream-repull");
      const { dispatch_token: token, ...rest } = s.body.client_payload;
      expect(rest).toEqual({
        mode: "open",
        dataset_id: d.dataset_id,
        upstream_ds: dsOf(d.dataset_id),
        from_tag: "0.9.0",
        to_tag: "1.0.0",
        dispatch_id: String(d.id),
        cli_version: CLI,
      });
      expect(
        await verifyRepullDispatchToken(
          token as string,
          { dispatchId: d.id, datasetId: d.dataset_id, nonce: d.nonce as string },
          SECRET,
        ),
      ).toBe(true);
      expect(d).toMatchObject({
        kind: "open",
        from_tag: "0.9.0",
        to_tag: "1.0.0",
        repull_id: null,
      });
    }
    expect(scheduler()).toMatchObject({ scan_after: "on099906", last_outcome: "ran" });
    // Each claim wrote its audit row; the token is in none of them.
    const audit = db.query("SELECT details FROM audit_log WHERE action = 'repull_dispatch'").all();
    expect(audit).toHaveLength(2);
    expect(JSON.stringify(audit)).not.toContain(sent[0]?.body.client_payload.dispatch_token);
  });

  test("the next UTC day: the next eligible, past each blocker in turn", async () => {
    fleet();
    setCursor("on099906");
    // Yesterday's units, ended: they no longer count, and the cursor is past them.
    pastDispatch("on099901", 1);
    pastDispatch("on099906", 1);
    const r = await tick();
    expect(sentFor()).toEqual(["on099911", "on099912"]);
    expect(r.skipped).toEqual({ recent: 1, "final-refusal": 1, unreconciled: 1 });
    expect(scheduler().scan_after).toBe("on099912");
  });

  test("the rotation wraps at the end of the fleet, and a lagging or unverified mirror is never dispatched", async () => {
    fleet();
    setCursor("on099912");
    const r = await tick();
    expect(r).toMatchObject({ outcome: "ran", scanned: 2, staleReady: 0, dispatched: 0 });
    expect(sent).toEqual([]);
    expect(scheduler().scan_after).toBe("");
    // The next tick starts again from the first mirror.
    await tick();
    expect(sentFor()).toEqual(["on099901", "on099906"]);
  });

  test("a mirror pulled within thirty days is not dispatched again, and one a month ago is", async () => {
    manualRunDone();
    mirror("on099901");
    mirror("on099902");
    mirror("on099903");
    pastDispatch("on099901", 29);
    repull("on099902", "abandoned", { created_at: "2026-01-01 00:00:00" });
    db.run(
      "UPDATE upstream_repulls SET created_at = datetime('now', '-29 days') WHERE dataset_id = 'on099902'",
    );
    pastDispatch("on099903", 31);
    const r = await tick();
    expect(sentFor()).toEqual(["on099903"]);
    expect(r.skipped).toEqual({ recent: 2 });
  });

  test("a mirror with a live dispatch is skipped, and nothing is claimed or sent for it", async () => {
    manualRunDone();
    mirror("on099901");
    mirror("on099902");
    // Sent yesterday and still running: it holds the dataset's one live slot, not today's cap.
    pastDispatch("on099901", 1, {
      status: "started",
      nonce: "0f4b8e3c-7a1d-4c2e-9b6f-1d2e3f4a5b6c",
      code: null,
    });
    const before = dispatches();
    const r = await tick();
    expect(r.skipped).toEqual({ live: 1 });
    expect(sentFor()).toEqual(["on099902"]);
    expect(dispatches().filter((d) => d.dataset_id === "on099901")).toEqual(
      before.filter((d) => d.dataset_id === "on099901"),
    );
  });

  test("a dispatch GitHub refused does not count toward the window", async () => {
    manualRunDone();
    mirror("on099901");
    pastDispatch("on099901", 2, {
      status: "dispatch_failed",
      code: "dispatch-refused",
      reported_at: null,
    });
    await tick();
    expect(sentFor()).toEqual(["on099901"]);
  });

  test("the dataset's fences are read again after the report: a mirror withdrawn meanwhile is skipped", async () => {
    manualRunDone();
    mirror("on099901");
    mirror("on099902");
    // Land the withdrawal between the report's page and the candidate's own reads.
    const d1 = wrapD1(realD1(db), (sql, binds) => {
      if (sql === CANDIDATE_BLOCKERS_SQL && binds[0] === "on099901") {
        db.run(
          "UPDATE datasets SET withdrawn_at = '2026-10-25 00:00:00' WHERE dataset_id = 'on099901'",
        );
      }
    });
    const r = await tick(env({}, d1));
    expect(r.skipped).toEqual({ withdrawn: 1 });
    expect(sentFor()).toEqual(["on099902"]);
  });

  test("staleReady counts the stale_ready mirrors the tick considered, dispatched or skipped", async () => {
    fleet();
    setCursor("on099906");
    pastDispatch("on099901", 1);
    pastDispatch("on099906", 1);
    // 08 (recent), 09 (final refusal), 10 (unreconciled), 11 and 12 (dispatched); 07 is in progress.
    const r = await tick();
    expect(r).toMatchObject({ staleReady: 5, dispatched: 2, scanned: 6 });
    expect(r.staleReady).toBe(r.dispatched + Object.values(r.skipped).reduce((a, b) => a + b, 0));
  });

  test("an unpublished mirror is never a candidate, whatever upstream did", async () => {
    manualRunDone();
    mirror("on099904", { unpublished: true });
    const r = await tick();
    expect(r).toMatchObject({ outcome: "ran", scanned: 1, staleReady: 0, dispatched: 0 });
    // Not even considered: it is no candidate at all, not one skipped for want of a tag.
    expect(r.skipped).toEqual({});
    expect(sent).toEqual([]);
  });
});

// ----------------------------------------------------------------------------
// The cap
// ----------------------------------------------------------------------------

describe("the open cap is the dispatch record's", () => {
  test("a second tick the same day is cap-reached and asks OpenNeuro nothing", async () => {
    fleet();
    await tick();
    const asked = openneuro.log.length;
    const r = await tick();
    expect(r.outcome).toBe("cap-reached");
    expect(openneuro.log).toHaveLength(asked);
    expect(sent).toHaveLength(2);
    expect(scheduler()).toMatchObject({ scan_after: "on099906", last_outcome: "cap-reached" });
  });

  test("a cap of 1 dispatches one", async () => {
    fleet();
    const r = await tick(env({ REPULL_DAILY_OPEN_CAP: "1" }));
    expect(r.dispatched).toBe(1);
    expect(sentFor()).toEqual(["on099901"]);
  });

  for (const [value, outcome] of [
    ["0", "cap-zero"],
    ["x", "cap-unreadable"],
    ["21", "cap-unreadable"],
    ["", "cap-unreadable"],
  ] as const) {
    test(`a cap of ${JSON.stringify(value)} is ${outcome}, and nothing is asked or sent`, async () => {
      fleet();
      const r = await tick(env({ REPULL_DAILY_OPEN_CAP: value }));
      expect(r.outcome).toBe(outcome);
      expect(openneuro.log).toEqual([]);
      expect(sent).toEqual([]);
      expect(scheduler().last_outcome).toBe(outcome);
    });
  }

  test("a dispatch GitHub refused frees its unit, and the next candidate is dispatched", async () => {
    fleet();
    answers = [422];
    const r = await tick();
    expect(r).toMatchObject({ outcome: "ran", dispatched: 2, sendFailed: 1 });
    expect(sentFor()).toEqual(["on099901", "on099906", "on099911"]);
    const rows = dispatches().filter((d) => d.dataset_id === "on099901");
    expect(rows).toEqual([
      expect.objectContaining({ status: "dispatch_failed", code: "dispatch-refused", nonce: null }),
    ]);
    expect(liveDispatches().map((d) => d.dataset_id)).toEqual(["on099906", "on099911"]);
    expect(repullSchedulerLogLine(r).level).toBe("error");
  });

  for (const status of [401, 403, 404]) {
    test(`a credential GitHub refuses (${status}) stops the tick as send-refused before the mirror`, async () => {
      fleet();
      answers = [status];
      const r = await tick();
      expect(r).toMatchObject({
        outcome: "send-refused",
        dispatched: 0,
        sendFailed: 1,
        refusedStatus: status,
      });
      expect(sent).toHaveLength(1);
      expect(scheduler()).toMatchObject({ scan_after: "", last_outcome: "send-refused" });
      expect(repullSchedulerLogLine(r)).toMatchObject({ level: "error" });
      // The refused dispatch freed its unit, and the next tick takes that mirror first.
      await tick();
      expect(sentFor()).toEqual(["on099901", "on099901", "on099906"]);
    });
  }

  test("a rate limit (429) on every send stops the tick at once and passes nothing by", async () => {
    fleet();
    answers = [429, 429, 429, 429];
    const r = await tick();
    expect(r).toMatchObject({ outcome: "send-refused", sendFailed: 1, refusedStatus: 429 });
    expect(r.skipped).toEqual({});
    expect(sent).toHaveLength(1);
    expect(scheduler().scan_after).toBe("");
  });

  test("a second refusal in one tick stops it before that mirror; the first frees and moves on", async () => {
    fleet();
    answers = [422, 422];
    const r = await tick();
    expect(r).toMatchObject({ outcome: "send-refused", dispatched: 0, sendFailed: 2 });
    expect(sentFor()).toEqual(["on099901", "on099906"]);
    // Past the first (its unit freed), before the second.
    expect(scheduler().scan_after).toBe("on099905");
    expect(dispatches().filter((d) => d.status === "dispatch_failed")).toHaveLength(2);
  });

  test("a dispatch whose answer was lost keeps its unit and stays dispatched (a 5xx, and a hang)", async () => {
    fleet();
    answers = [502, "hang"];
    const r = await tick(env(), { dispatchTimeoutMs: 2_000 });
    expect(r).toMatchObject({ outcome: "ran", dispatched: 0, unconfirmed: 2, sendFailed: 0 });
    expect(liveDispatches().map((d) => d.dataset_id)).toEqual(["on099901", "on099906"]);
    // Both units are used: the day is full.
    expect((await tick()).outcome).toBe("cap-reached");
    expect(repullSchedulerLogLine(r).level).toBe("error");
  });

  test("two ticks at once cannot pass the cap or dispatch one mirror twice", async () => {
    fleet();
    const d1 = yieldingD1(realD1(db));
    const results = await Promise.all([tick(env({}, d1)), tick(env({}, d1))]);
    const claimed = dispatches().filter((d) => d.status === "dispatched");
    expect(claimed).toHaveLength(2);
    expect(new Set(claimed.map((d) => d.dataset_id)).size).toBe(claimed.length);
    expect(sent.length).toBe(claimed.length);
    // The day filled while one of them ran: the claim stopped it with the cap's own word.
    expect(results.map((x) => x.outcome)).toContain("cap-reached");
  });

  // The claim reads the switch, the secret and the cap when it claims, so a binding that changed
  // since the tick's own checks ends the tick with the claim's word. The change is landed between
  // the candidate's reads and its claim.
  for (const [name, change, outcome] of [
    ["the open switch went off", { AUTO_REPULL_ENABLED: undefined }, "switch-off"],
    ["the callback secret went", { PRESCREEN_CALLBACK_SECRET: undefined }, "unconfigured"],
    ["the cap became unreadable", { REPULL_DAILY_OPEN_CAP: "x" }, "cap-unreadable"],
    ["the cap went to zero", { REPULL_DAILY_OPEN_CAP: "0" }, "cap-reached"],
  ] as const) {
    test(`the claim's own refusal ends the tick: ${name} is ${outcome}`, async () => {
      fleet();
      const bindings = env() as unknown as Record<string, unknown>;
      bindings.DB = wrapD1(realD1(db), (sql) => {
        if (sql !== CANDIDATE_BLOCKERS_SQL) return;
        for (const [k, v] of Object.entries(change)) {
          if (v === undefined) delete bindings[k];
          else bindings[k] = v;
        }
      });
      const r = await tick(bindings as unknown as Bindings);
      expect(r.outcome).toBe(outcome);
      expect(sent).toEqual([]);
      expect(dispatches().filter((d) => d.status === "dispatched")).toEqual([]);
      // Stopped before the mirror, so the next tick starts with it.
      expect(scheduler()).toMatchObject({ scan_after: "", last_outcome: outcome });
    });
  }
});

// ----------------------------------------------------------------------------
// What stops a tick before it dispatches
// ----------------------------------------------------------------------------

describe("what keeps a tick from dispatching", () => {
  test("gate G4 names the two first re-pulls", () => {
    expect([...REPULL_G4_DATASETS]).toEqual(["on003645", "on004362"]);
  });

  /** The fleet without its G4 rows, and the given ones instead. */
  const fleetWith = (seed: () => void) => {
    fleet();
    db.run("DELETE FROM upstream_repulls WHERE dataset_id IN ('on003645', 'on004362')");
    seed();
  };
  const waits = async () => {
    const r = await tick();
    expect(r.outcome).toBe("waiting-for-manual-run");
    expect(openneuro.log).toEqual([]);
    expect(sent).toEqual([]);
    expect(scheduler().last_outcome).toBe("waiting-for-manual-run");
  };

  for (const id of REPULL_G4_DATASETS) {
    test(`one of gate G4's re-pulls alone (${id}) does not open the scheduler`, async () => {
      fleetWith(() => manualRun(id));
      await waits();
      expect(db.query(MANUAL_RUN_PROOF_SQL).get()).toEqual({ n: 1 });
    });
  }

  test("both of gate G4's re-pulls together open it", async () => {
    fleetWith(() => {
      manualRun("on003645");
      manualRun("on004362");
    });
    expect(db.query(MANUAL_RUN_PROOF_SQL).get()).toEqual({ n: 2 });
    expect((await tick()).outcome).toBe("ran");
    expect(sentFor()).toEqual(["on099901", "on099906"]);
  });

  test("nothing else counts toward G4: another mirror, another origin, an unfinished run, two of one", async () => {
    fleetWith(() => {
      manualRun("on003645");
      // Two complete runs of the same dataset are still one of the two.
      manualRun("on003645", { to_tag: "1.0.2" });
      // Any other `on` mirror's completed manual re-pull.
      manualRun("on099801");
      // The second named dataset, but automatic, or still released.
      repull("on004362", "complete", { origin: "automatic", created_at: "2026-01-01 00:00:00" });
      repull("on004362", "released", { origin: "administrator", to_tag: "1.0.3" });
    });
    await waits();
    expect(db.query(MANUAL_RUN_PROOF_SQL).get()).toEqual({ n: 1 });
  });

  test("the default CLI version is the Worker's own, and only a release opens the path", async () => {
    fleet();
    const r = await runRepullSchedulerCron(env());
    const release = /^\d+\.\d+\.\d+$/.test(pkg.version);
    expect([pkg.version, r?.outcome === "cli-unreleased"]).toEqual([pkg.version, !release]);
    if (release) expect(sent.map((x) => x.body.client_payload.cli_version)).toContain(pkg.version);
    else expect(sent).toEqual([]);
  });

  test("a development build of the Worker is cli-unreleased", async () => {
    fleet();
    const r = await tick(env(), { cliVersion: "0.10.24-dev11" });
    expect(r.outcome).toBe("cli-unreleased");
    expect(openneuro.log).toEqual([]);
    expect(sent).toEqual([]);
    expect(repullSchedulerLogLine(r).level).toBe("error");
  });

  test("no callback secret is unconfigured", async () => {
    fleet();
    const r = await tick(env({ PRESCREEN_CALLBACK_SECRET: undefined }));
    expect(r.outcome).toBe("unconfigured");
    expect(openneuro.log).toEqual([]);
    expect(dispatches().filter((d) => d.status === "dispatched")).toEqual([]);
  });

  test("OpenNeuro down is blind: nothing dispatched, and the cursor does not move", async () => {
    fleet();
    setCursor("on099900");
    openneuro.status(500);
    const r = await tick();
    expect(r.outcome).toBe("blind");
    expect(sent).toEqual([]);
    expect(scheduler()).toMatchObject({ scan_after: "on099900", last_outcome: "blind" });
    expect(repullSchedulerLogLine(r).level).toBe("error");
  });

  test("one mirror OpenNeuro could not answer for is passed by and counted, and the rest go on", async () => {
    manualRunDone();
    mirror("on099901");
    mirror("on099902");
    mirror("on099903");
    // A null latest beside a non-empty list is a read the report will not turn into a verdict.
    openneuro.override("ds099901", {
      id: "ds099901",
      latestSnapshot: null,
      snapshots: [{ tag: "0.9.0", created: "2019-01-01T00:00:00.000Z" }],
    });
    const r = await tick();
    expect(r).toMatchObject({ outcome: "ran", unchecked: 1, dispatched: 2 });
    expect(sentFor()).toEqual(["on099902", "on099903"]);
    expect(repullSchedulerLogLine(r).level).toBe("error");
  });

  test("a lone mirror at the tail that OpenNeuro could not answer for does not wedge the rotation", async () => {
    manualRunDone();
    mirror("on099901", { tag: "1.0.0" });
    mirror("on099902");
    openneuro.override("ds099902", {
      id: "ds099902",
      latestSnapshot: null,
      snapshots: [{ tag: "0.9.0", created: "2019-01-01T00:00:00.000Z" }],
    });
    setCursor("on099901");
    // Its page holds only that mirror, so every row needing a verdict is `unchecked`; with no
    // batch failure that is per-dataset trouble, and the cursor passes it and wraps.
    const r = await tick();
    expect(r).toMatchObject({ outcome: "ran", scanned: 1, unchecked: 1 });
    expect(scheduler().scan_after).toBe("");
    const next = await tick();
    expect(next).toMatchObject({ outcome: "ran", scanned: 2 });
  });

  test("no GitHub credential for the probes is blind, and the cursor stops before the first stale mirror", async () => {
    fleet();
    const r = await tick(env({ GITHUB_ADMIN_PAT: undefined }));
    expect(r).toMatchObject({ outcome: "blind", error: "probe-credential-missing" });
    expect(raw.log).toEqual([]);
    expect(sent).toEqual([]);
    expect(scheduler().scan_after).toBe("");
    expect(repullSchedulerLogLine(r).line).toContain("error=probe-credential-missing");
  });

  test("every probe failing is blind and holds the cursor, for two ticks at most", async () => {
    manualRunDone();
    for (const id of ["on099901", "on099902", "on099903", "on099904"]) {
      mirror(id, { mirror: "error" });
    }
    setCursor("on099900");
    for (let held = 1; held <= 2; held++) {
      const r = await tick();
      expect(r).toMatchObject({
        outcome: "blind",
        error: "probes-unverified",
        probed: 4,
        probeUnverified: 4,
      });
      expect(scheduler()).toMatchObject({ scan_after: "on099900", last_outcome: "blind" });
      expect(repullSchedulerLogLine(r).level).toBe("error");
    }
    // The third tick at that place passes on, still at error level, so a mirror whose OpenNeuro
    // repository is gone cannot hold the rotation for good.
    const third = await tick();
    expect(third).toMatchObject({ outcome: "ran", error: "probes-unverified", probeUnverified: 4 });
    expect(scheduler().scan_after).toBe("");
    expect(repullSchedulerLogLine(third).level).toBe("error");
    expect(sent).toEqual([]);
  });

  test("some probes failing is not blind, but is logged at error level with the counts", async () => {
    manualRunDone();
    mirror("on099901", { mirror: "error" });
    mirror("on099902");
    const r = await tick();
    expect(r).toMatchObject({ outcome: "ran", probed: 2, probeUnverified: 1, dispatched: 1 });
    const log = repullSchedulerLogLine(r);
    expect(log.level).toBe("error");
    expect(log.line).toContain("probed=2 probe_unverified=1");
  });

  test("a candidate that always throws holds the tick twice, then is passed by and counted", async () => {
    manualRunDone();
    mirror("on099901");
    mirror("on099902");
    const d1 = wrapD1(realD1(db), (sql, binds) => {
      if (sql === CANDIDATE_BLOCKERS_SQL && binds[0] === "on099901") {
        throw new Error(`D1_ERROR: simulated for ${binds[0]}`);
      }
    });
    for (let held = 1; held <= 2; held++) {
      const r = await tick(env({}, d1));
      expect(r).toMatchObject({
        outcome: "error",
        error: "candidate-failed",
        errorClass: "Error",
        candidateErrors: 1,
      });
      expect(scheduler()).toMatchObject({ scan_after: "", last_outcome: "error" });
      // A fixed word and a class, never the message.
      expect(repullSchedulerLogLine(r).line).not.toContain("simulated");
    }
    expect(sent).toEqual([]);
    const third = await tick(env({}, d1));
    expect(third).toMatchObject({ outcome: "ran", candidateErrors: 1, dispatched: 1 });
    expect(third.skipped).toEqual({ "candidate-error": 1 });
    expect(sentFor()).toEqual(["on099902"]);
    expect(
      db.query("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'repull_scheduler_held'").get(),
    ).toEqual({ n: 2 });
  });

  test("a failure outside any candidate is the outcome error, stamped, and never a throw", async () => {
    fleet();
    const d1 = wrapD1(realD1(db), (sql) => {
      if (sql.includes("FROM upstream_repull_scheduler WHERE id = 1") && sql.startsWith("SELECT")) {
        throw new Error("D1_ERROR: simulated");
      }
    });
    const r = await tick(env({}, d1));
    expect(r).toMatchObject({ outcome: "error", error: "tick-failed", errorClass: "Error" });
    expect(sent).toEqual([]);
    expect(scheduler().last_outcome).toBe("error");
  });
});

// ----------------------------------------------------------------------------
// The cursor and the budget
// ----------------------------------------------------------------------------

describe("the cursor and the probe budget", () => {
  test("a stale mirror the probes did not reach is the next tick's first, not passed by", async () => {
    manualRunDone();
    const ids = Array.from({ length: 12 }, (_, i) => `on0999${String(21 + i)}`);
    for (const id of ids) mirror(id);
    // The first ten were pulled five days ago; only the last two are eligible.
    for (const id of ids.slice(0, 10)) pastDispatch(id, 5);
    expect(REPULL_SCAN_PROBE_BUDGET).toBe(10);

    const first = await tick();
    expect(first).toMatchObject({ outcome: "ran", dispatched: 0, deferred: true });
    expect(first.skipped).toEqual({ recent: 10 });
    expect(raw.log.filter((l) => l.path.endsWith("/1.0.0/dataset_description.json"))).toHaveLength(
      10,
    );
    expect(scheduler().scan_after).toBe(ids[9]);

    const second = await tick();
    expect(sentFor()).toEqual([ids[10], ids[11]]);
    expect(second.deferred).toBe(false);
  });

  test("a tick reads at most three pages of the report", async () => {
    manualRunDone();
    const ids = Array.from({ length: 301 }, (_, i) => `on09${String(9000 + i).padStart(4, "0")}`);
    for (const id of ids) mirror(id, { tag: "1.0.0" });
    const r = await tick();
    expect(REPULL_SCAN_PAGES).toBe(3);
    expect(r).toMatchObject({ outcome: "ran", scanned: 300, dispatched: 0 });
    // Two GraphQL batches of 50 per page of 100.
    expect(openneuro.log).toHaveLength(6);
    expect(scheduler().scan_after).toBe(ids[299]);
    const next = await tick();
    expect(next.scanned).toBe(1);
    expect(scheduler().scan_after).toBe("");
  });

  test("the probe budget is the whole tick's: five stale mirrors on each of three pages get ten probes", async () => {
    manualRunDone();
    const ids = Array.from({ length: 300 }, (_, i) => `on09${String(9000 + i).padStart(4, "0")}`);
    for (const [i, id] of ids.entries()) {
      // Five anonymous (never dispatched) stale mirrors on each page of 100; the rest current.
      const stale = i % 100 < 5;
      mirror(id, stale ? { anonymous: 1 } : { tag: "1.0.0" });
    }
    const r = await tick();
    const probes = raw.log.filter((l) => l.path.endsWith("/1.0.0/dataset_description.json"));
    expect(probes.length).toBeLessThanOrEqual(REPULL_SCAN_PROBE_BUDGET);
    expect(probes).toHaveLength(10);
    // The budget ran out at the end of the second page, so the third is not read at all.
    expect(r).toMatchObject({ outcome: "ran", probed: 10, deferred: false, scanned: 200 });
    expect(r.skipped).toEqual({ anonymous: 10 });
    expect(openneuro.log).toHaveLength(4);
    expect(scheduler().scan_after).toBe(ids[199]);
  });

  test("the heaviest tick the suite builds: three pages, ten probes, ten dispatches, 79 calls", async () => {
    manualRunDone();
    const ids = Array.from({ length: 300 }, (_, i) => `on09${String(9000 + i).padStart(4, "0")}`);
    // Three eligible stale mirrors on each of the first two pages and four on the third.
    const eligible = new Set([0, 1, 2, 100, 101, 102, 200, 201, 202, 203]);
    for (const [i, id] of ids.entries()) mirror(id, eligible.has(i) ? {} : { tag: "1.0.0" });
    let d1Calls = 0;
    const inner = realD1(db);
    const counting = wrapD1(inner, () => {
      d1Calls++;
    });
    const counted = {
      prepare: (sql: string) => counting.prepare(sql),
      batch: (stmts: D1PreparedStatement[]) => {
        d1Calls++;
        return counting.batch(stmts);
      },
    } as unknown as D1Database;
    const r = await tick(env({ REPULL_DAILY_OPEN_CAP: "20" }, counted));
    expect(r).toMatchObject({ outcome: "ran", dispatched: 10, probed: 10 });
    const requests = openneuro.log.length + raw.log.length + sent.length;
    // 6 GraphQL and 10 probes and 10 sends; 3 + 3 x 3 + 10 x 4 + 1 D1 calls (a token, not an App).
    expect({ requests, d1Calls }).toEqual({ requests: 26, d1Calls: 53 });
    expect(requests + d1Calls).toBe(79);
  });

  test("a stored cursor that is not a dataset id restarts the rotation", async () => {
    fleet();
    setCursor("zz' OR 1=1 --");
    await tick();
    expect(sentFor()).toEqual(["on099901", "on099906"]);
  });
});

// ----------------------------------------------------------------------------
// The blockers, statement by statement
// ----------------------------------------------------------------------------

describe("CANDIDATE_BLOCKERS_SQL", () => {
  const read = (id = "on099901", tag = "1.0.0") =>
    db.query(CANDIDATE_BLOCKERS_SQL).get(id, tag) as CandidateBlockers;
  const zero = {
    anonymous: 0,
    unreconciled: 0,
    open_rows: 0,
    live: 0,
    final_refusals: 0,
    recent_rows: 0,
    recent_dispatches: 0,
  };

  test("a clean mirror is all zero, and a missing one has no anonymity", () => {
    mirror("on099901");
    expect(read()).toEqual(zero);
    expect(candidateSkip(read())).toBeNull();
    expect(read("on099999").anonymous).toBeNull();
    expect(candidateSkip(read("on099999"))).toBe("missing");
  });

  test("each fact raises its own count only", () => {
    mirror("on099901");
    const cases: Array<[string, () => void, Partial<CandidateBlockers>]> = [
      ["anonymous", () => db.run("UPDATE datasets SET anonymous = 1"), { anonymous: 1 }],
      [
        "an open re-pull",
        () => repull("on099901", "pr_open", { created_at: "2026-01-01 00:00:00" }),
        { open_rows: 1 },
      ],
      [
        "a live dispatch",
        () =>
          insert("upstream_repull_dispatches", {
            kind: "open",
            dataset_id: "on099901",
            upstream_ds: "ds099901",
            from_tag: "0.9.0",
            to_tag: "1.0.0",
            nonce: "0f4b8e3c-7a1d-4c2e-9b6f-1d2e3f4a5b6c",
            status: "dispatched",
            dispatched_at: "2026-01-01 00:00:00",
          }),
        { live: 1 },
      ],
      [
        "a content refusal at this tag",
        () => pastDispatch("on099901", 90, { status: "refused", code: "gitlink" }),
        { final_refusals: 1 },
      ],
      [
        "an unreconciled merge claim",
        () =>
          repull("on099901", "failed", {
            merge_claimed_at: "2026-01-01 00:00:00",
            merge_claim_sha: SHA,
            created_at: "2026-01-01 00:00:00",
          }),
        { unreconciled: 1 },
      ],
      ["a re-pull created this month", () => repull("on099901", "abandoned"), { recent_rows: 1 }],
      ["a first dispatch this month", () => pastDispatch("on099901", 3), { recent_dispatches: 1 }],
    ];
    for (const [name, seed, expected] of cases) {
      db.run("DELETE FROM upstream_repulls");
      db.run("DELETE FROM upstream_repull_dispatches");
      db.run("UPDATE datasets SET anonymous = 0");
      seed();
      expect([name, read()]).toEqual([name, { ...zero, ...expected }]);
    }
  });

  test("what does not count: another tag, another word, a resume, a refused send, a reconciled merge", () => {
    mirror("on099901");
    pastDispatch("on099901", 90, { status: "refused", code: "gitlink", to_tag: "0.9.1" });
    pastDispatch("on099901", 90, { status: "refused", code: "runner-failed" });
    pastDispatch("on099901", 3, {
      status: "dispatch_failed",
      code: "dispatch-refused",
      reported_at: null,
    });
    const old = repull("on099901", "complete", { created_at: "2026-01-01 00:00:00" });
    pastDispatch("on099901", 3, { repull_id: old });
    // A failed row that merged and was tagged is reconciled.
    repull("on099901", "failed", {
      to_tag: "0.9.5",
      merge_claimed_at: "2026-01-01 00:00:00",
      merge_claim_sha: SHA,
      tag_sha: SHA,
      created_at: "2026-01-01 00:00:00",
    });
    expect(read()).toEqual(zero);
  });

  test("a refusal recorded at 1.0.0 blocks a pull to v1.0.0: the tag is normalized before it is bound", async () => {
    mirror("on099901");
    pastDispatch("on099901", 90, { status: "refused", code: "gitlink" });
    const b = await readCandidateBlockers(realD1(db), "on099901", "v1.0.0");
    expect(b?.final_refusals).toBe(1);
    expect(candidateSkip(b)).toBe("final-refusal");
    // The raw spelling would not have matched.
    expect(read("on099901", "v1.0.0").final_refusals).toBe(0);
  });

  test("candidateSkip: unknown anonymity is never clean, and an unreadable count stops the tick", () => {
    expect(candidateSkip(null)).toBe("missing");
    expect(candidateSkip({ ...zero, anonymous: 2 })).toBe("anonymous");
    expect(candidateSkip({ ...zero, anonymous: 1, live: 1 })).toBe("anonymous");
    expect(() => candidateSkip({ ...zero, live: undefined as unknown as number })).toThrow(
      /live count could not be read/,
    );
  });
});

describe("the log line", () => {
  test("counts and fixed words, at error level only for trouble", () => {
    const base: SchedulerTickResult = {
      outcome: "ran",
      scanned: 3,
      staleReady: 2,
      unchecked: 0,
      probed: 2,
      probeUnverified: 0,
      dispatched: 1,
      sendFailed: 0,
      refusedStatus: null,
      unconfirmed: 0,
      candidateErrors: 0,
      skipped: { recent: 1 },
      deferred: false,
      error: null,
      errorClass: null,
    };
    expect(repullSchedulerLogLine(base)).toEqual({
      level: "info",
      line: "[repull-scheduler] outcome=ran scanned=3 stale_ready=2 unchecked=0 probed=2 probe_unverified=0 dispatched=1 send_failed=0 unconfirmed=0 candidate_error=0 deferred=false skipped=recent:1",
    });
    expect(
      repullSchedulerLogLine({
        ...base,
        outcome: "send-refused",
        sendFailed: 1,
        refusedStatus: 403,
        error: "tick-failed",
        errorClass: "TypeError",
      }).line,
    ).toEndWith(" refused_status=403 error=tick-failed error_class=TypeError");
    for (const outcome of [
      "switch-off",
      "cap-zero",
      "waiting-for-manual-run",
      "cap-reached",
    ] as const) {
      expect(repullSchedulerLogLine({ ...base, outcome }).level).toBe("info");
    }
    for (const outcome of [
      "blind",
      "error",
      "send-refused",
      "cap-unreadable",
      "cli-unreleased",
      "unconfigured",
    ] as const) {
      expect(repullSchedulerLogLine({ ...base, outcome }).level).toBe("error");
    }
    for (const trouble of [
      { sendFailed: 1 },
      { unconfirmed: 1 },
      { unchecked: 1 },
      { probeUnverified: 1 },
      { candidateErrors: 1 },
    ]) {
      expect(repullSchedulerLogLine({ ...base, ...trouble }).level).toBe("error");
    }
  });
});
