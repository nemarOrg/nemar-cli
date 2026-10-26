/**
 * The upstream re-pulls' week in the weekly import report (epic #1046 phase 7, #1913; ADR 0111's
 * Phase 7h slice; ADR 0053 and ADR 0054), driven through the report's own entry point,
 * `runWeeklyImportSummary`, against real in-memory SQLite carrying every migration. The rows the
 * counts read are seeded the way the tables take them (the CHECKs of migrations 0105 and 0111 are
 * live), and the merges, whose audit rows the counts are read from, are written by the production
 * writers (`transitionRepull`, `recordRepullMerged`), so the keys the SQL reads are the keys those
 * writers leave. Only GitHub, OpenNeuro and the coverage sweep are stood in for.
 *
 * The properties, each with a test that fails when its line is changed:
 *  - the section arrives every week, in a week with no re-pull work and the switches off too (ADR
 *    0054), and says the switches are off;
 *  - every count is read from the table that holds it, in the window it belongs to: dispatches by
 *    kind, state and word; open automatic re-pulls and their holds by word; claims to merge held
 *    over an hour; re-pulls that ended failed; merges by who held the claim;
 *  - the report names no dataset: a dataset id, even one stored where a word is, never reaches the
 *    body or the log line, and a word that names anonymity is counted under `other`;
 *  - a read that fails leaves the facts null, lists a failed part, and the section says unknown (ADR
 *    0054), never zero;
 *  - attention follows ADR 0053 exactly: each reason alone, none for a switch that is off, a hold
 *    waiting on a gate or a run's refusal, and the thresholds exactly where they are stated;
 *  - the headline, the log line and `nemar admin import-weekly`'s rule are one function.
 * Mail is pinned by `repull-no-mail-scan.test.ts`; the Resend capture below stays empty.
 */

import type { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { weeklyAttention } from "../../shared/contract/weekly-attention";
import { parseScreenReport } from "../../shared/identifier-screen-report";
import {
  DISPATCH_STATUSES,
  type DispatchStatus,
  REPULL_HOLD_REASONS,
  type RepullStatus,
} from "../../shared/repull-state";
import { SYSTEM_USER_ID } from "../src/lib/constants";
import type { ImportCoverageSweepResult } from "../src/services/import-coverage-sweep";
import {
  buildWeeklySummaryBody,
  weeklyHeadline,
  weeklySummaryLogLine,
} from "../src/services/import-weekly-summary";
import {
  type WeeklySummaryDeps,
  runWeeklyImportSummary,
} from "../src/services/import-weekly-summary-sweep";
import { transitionRepull } from "../src/services/upstream-repull";
import { recordRepullMerged } from "../src/services/upstream-repull-verified";
import {
  HELD_CLAIM_ATTENTION_HOURS,
  REPULL_WEEK_SQL,
  SCHEDULER_STALE_HOURS,
  gatherRepullWeek,
  repullAttention,
} from "../src/services/upstream-repull-weekly";
import type { Bindings } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";
import { startOpenNeuroStandin } from "./helpers/openneuro-standin";
import { startRawHost } from "./helpers/raw-mirror-standin";
import {
  type RepullGitHub,
  STANDIN_MERGE_SHA,
  startRepullGitHub,
} from "./helpers/repull-github-standin";
import {
  type DispatchSeed,
  type Row,
  rowAt,
  seedDispatch as seedDispatchRow,
} from "./helpers/repull-rows";
import { repullWeekFacts } from "./helpers/repull-week";
import { type CapturedEmail, withFakeResend } from "./helpers/resend";
import { lastWeeklyCronFiring } from "./helpers/weekly-cron-firing";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = lastWeeklyCronFiring(new Date());
const HEAD = "0123456789abcdef0123456789abcdef01234567";

const openneuro = startOpenNeuroStandin();
const rawMirror = startRawHost();
let gh: RepullGitHub;
let mail: CapturedEmail[] = [];
let releaseMail: (() => void) | null = null;
let mailDone: Promise<void> | null = null;

beforeAll(() => {
  gh = startRepullGitHub({ defaultHead: HEAD });
});
afterAll(() => {
  openneuro.stop();
  rawMirror.stop();
  gh.stop();
});

let db: Database;
beforeEach(async () => {
  db = freshDb();
  openneuro.reset();
  rawMirror.reset();
  gh.reset();
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

// ----------------------------------------------------------------------------
// Fixtures
// ----------------------------------------------------------------------------

/** SQLite's `datetime()` shape for an instant `ms` after NOW (negative: before it). */
const at = (ms: number): string =>
  new Date(NOW.getTime() + ms).toISOString().slice(0, 19).replace("T", " ");

function envFor(
  over: Record<string, string | undefined> = {},
  d1: D1Database = realD1(db),
): Bindings {
  const bindings: Record<string, unknown> = {
    DB: d1,
    ENVIRONMENT: "production",
    OPENNEURO_GRAPHQL_URL: openneuro.url,
    GITHUB_RAW_BASE: rawMirror.base,
    GITHUB_ADMIN_PAT: "weekly-repull-test-pat",
    RESEND_API_KEY: "re_test",
    FROM_EMAIL: "NEMAR <noreply@nemar.org>",
  };
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) delete bindings[k];
    else bindings[k] = v;
  }
  return bindings as unknown as Bindings;
}

function coverageResult(): ImportCoverageSweepResult {
  return {
    applied: false,
    status: "healthy",
    kind: null,
    reason: "nothing outstanding",
    enabled: true,
    lastDispatchAt: "2026-09-07 01:00:00",
    dispatchAgeHours: 2,
    lastDispatchSourceId: "ds000001",
    dispatchLost: false,
    discovered: 766,
    imported: 764,
    importedInScan: 760,
    importedNotInScan: 4,
    inFlight: 0,
    terminal: 0,
    backlog: { neverAttempted: [], untracked: [], tracked: [], blocklisted: [] },
    issue: null,
    errors: [],
  };
}

const deps = (): WeeklySummaryDeps => ({
  token: async () => "test-token",
  listOpenIssues: async () => [],
  coverage: async () => coverageResult(),
});

/** The report, produced the way the cron and the admin route produce it (a dry run). */
async function report(
  over: Record<string, string | undefined> = {},
  now: Date = NOW,
  d1?: D1Database,
) {
  const r = await runWeeklyImportSummary(envFor(over, d1), { now }, deps());
  if (r.facts === null) throw new Error("the report gathered nothing");
  return { ...r, facts: r.facts, body: r.renderedBody ?? "" };
}

/** The section of the body, up to the next heading. */
function sectionOf(body: string): string {
  const start = body.indexOf("## Upstream re-pulls");
  if (start === -1) return "";
  const rest = body.slice(start + 3);
  const next = rest.search(/^## /m);
  return next === -1 ? body.slice(start) : body.slice(start, start + 3 + next);
}

/** The re-pull reasons of a report: the shared rule's problems that concern the re-pulls. */
const repullProblems = (facts: Parameters<typeof weeklyAttention>[0]): string[] =>
  weeklyAttention(facts).problems.filter((p) => /re-pull/i.test(p));

let seq = 0;
/** A fresh `on09xxxx` dataset id, so a seeded row never meets another's unique index. */
const nextDataset = (): string => `on09${String(++seq).padStart(4, "0")}`;

/** A dispatch of a fresh dataset, or the one named, in the state and at the instant named; the dataset. */
function seedDispatch(o: Omit<DispatchSeed, "dataset"> & { dataset?: string }): string {
  const dataset = o.dataset ?? nextDataset();
  seedDispatchRow(db, { ...o, dataset });
  return dataset;
}

function seedRepull(status: RepullStatus, over: Row = {}): number {
  const row = rowAt(status, { dataset_id: nextDataset(), upstream_ds: "ds004362", ...over });
  const cols = Object.keys(row);
  return Number(
    db
      .query(
        `INSERT INTO upstream_repulls (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
      )
      .run(...(cols.map((c) => row[c]) as never[])).lastInsertRowid,
  );
}

/** An open automatic re-pull at `status`, held for `word` since an hour ago when one is named. */
function seedAutomatic(status: RepullStatus, word: string | null = null, over: Row = {}): number {
  return seedRepull(status, {
    origin: "automatic",
    ...(word === null ? {} : { hold_reason: word, hold_since: at(-HOUR) }),
    ...over,
  });
}

function stampScheduler(o: {
  tick?: string | null;
  outcome?: string | null;
  advance?: string | null;
}): void {
  db.query(
    "UPDATE upstream_repull_scheduler SET last_tick_at = ?, last_outcome = ?, last_advance_at = ?",
  ).run(o.tick ?? null, o.outcome ?? null, o.advance ?? null);
}

/** Production, the open switch on, and a scheduler that ran an hour ago: nothing for a person to do. */
const ON = { AUTO_REPULL_ENABLED: "1" };
function stampFresh(): void {
  stampScheduler({ tick: at(-HOUR), outcome: "ran", advance: at(-HOUR / 2) });
}

// ----------------------------------------------------------------------------
// The section arrives every week (ADR 0054)
// ----------------------------------------------------------------------------

describe("the section arrives every week", () => {
  test("a week with no re-pull work and the switches off still has its section, with true zeros", async () => {
    stampScheduler({ tick: at(-HOUR), outcome: "switch-off", advance: at(-HOUR / 2) });
    const r = await report();
    const section = sectionOf(r.body);
    expect(section).toContain("## Upstream re-pulls");
    // Between the upstream freshness section and the dispatch liveness one.
    expect(r.body.indexOf("## Upstream freshness")).toBeLessThan(
      r.body.indexOf("## Upstream re-pulls"),
    );
    expect(r.body.indexOf("## Upstream re-pulls")).toBeLessThan(
      r.body.indexOf("## Dispatch liveness"),
    );
    expect(section).toContain("Open switch (`AUTO_REPULL_ENABLED`): off.");
    expect(section).toContain("Merge switch (`AUTO_REPULL_MERGE_ENABLED`): off.");
    expect(section).toContain("Daily open cap: 2 (the default). Daily merge cap: 5 (the default).");
    expect(section).toContain(
      `The scheduler's daily tick last ran ${at(-HOUR)} UTC and concluded \`switch-off\`. The advance tick last ran ${at(-HOUR / 2)} UTC.`,
    );
    expect(section).toContain("| Dispatches sent this week | 0 |");
    expect(section).toContain("| Merged by the Worker | 0 |");
    expect(section).toContain("| Open automatic re-pulls now | 0 |");
    expect(section).not.toContain("unknown");
    // Nothing for a person: no reason of the re-pulls' own, in the facts or in the headline.
    expect(r.facts.repulls?.attention).toEqual([]);
    expect(repullProblems(r.facts)).toEqual([]);
  });

  test("a scheduler nothing has stamped yet is said to be never recorded, not unknown", async () => {
    const r = await report();
    const section = sectionOf(r.body);
    expect(section).toContain("The scheduler's daily tick has no recorded run.");
    expect(section).toContain("The advance tick has no recorded run.");
    expect(r.facts.repulls?.scheduler).toEqual({
      last_tick_at: null,
      last_outcome: null,
      last_advance_at: null,
    });
    // The switches are off, so a scheduler with nothing to do is quiet (ADR 0053).
    expect(repullProblems(r.facts)).toEqual([]);
  });

  test("the switches in force are said as the Worker reads them", async () => {
    stampFresh();
    const on = sectionOf(
      (await report({ ...ON, AUTO_REPULL_MERGE_ENABLED: "1", REPULL_DAILY_OPEN_CAP: "1" })).body,
    );
    expect(on).toContain("Open switch (`AUTO_REPULL_ENABLED`): **on**.");
    expect(on).toContain("Merge switch (`AUTO_REPULL_MERGE_ENABLED`): **on**.");
    expect(on).toContain("Daily open cap: 1 (set).");
    // `"true"` is not `"1"`, and a Worker that is not production honors neither.
    const notOne = sectionOf((await report({ AUTO_REPULL_ENABLED: "true" })).body);
    expect(notOne).toContain("Open switch (`AUTO_REPULL_ENABLED`): off.");
    const staging = sectionOf((await report({ ...ON, ENVIRONMENT: "staging" })).body);
    expect(staging).toContain("Open switch (`AUTO_REPULL_ENABLED`): off.");
    expect(staging).toContain("This is not the production Worker, so neither switch is honored.");
  });
});

// ----------------------------------------------------------------------------
// Each count
// ----------------------------------------------------------------------------

describe("dispatches are counted by kind, state and word", () => {
  test("each count is read from the dispatch record, and the states add up to the total", async () => {
    const week = at(-3 * DAY);
    seedDispatch({ status: "dispatched", at: week });
    seedDispatch({ status: "started", at: week });
    seedDispatch({ status: "opened", at: week, repullId: 11 });
    seedDispatch({ status: "finished", at: week });
    seedDispatch({ status: "refused", code: "auto-not-clean-plan", at: week });
    seedDispatch({ status: "refused", code: "auto-not-clean-plan", at: week });
    seedDispatch({ status: "refused", code: "gitlink", at: week });
    seedDispatch({ status: "failed", code: "runner-failed", at: week });
    seedDispatch({
      status: "failed",
      code: "finish-incomplete",
      kind: "finish",
      at: week,
      repullId: 12,
    });
    seedDispatch({ status: "unreported", at: week });
    seedDispatch({ status: "dispatch_failed", code: "dispatch-refused", at: week });

    const r = await report();
    const d = r.facts.repulls?.dispatches;
    expect(d?.sent).toBe(11);
    expect(d?.by_kind).toEqual({ open: 9, finish: 2 });
    expect(d?.by_status).toEqual({
      dispatched: 1,
      started: 1,
      opened: 1,
      finished: 1,
      refused: 3,
      failed: 2,
      unreported: 1,
      dispatch_failed: 1,
    });
    expect(Object.values(d?.by_status ?? {}).reduce((a, b) => a + b, 0)).toBe(d?.sent ?? -1);
    expect(d?.by_word).toEqual({
      refused: { "auto-not-clean-plan": 2, gitlink: 1 },
      failed: { "runner-failed": 1, "finish-incomplete": 1 },
      dispatch_failed: { "dispatch-refused": 1 },
    });
    const section = sectionOf(r.body);
    for (const line of [
      "| Dispatches sent this week | 11 |",
      "| Opened a pull request | 1 |",
      "| Finished after a merge | 1 |",
      "| Refused by the run | 3 |",
      "| Failed in the run | 2 |",
      "| Not reported in time | 1 |",
      "| Not accepted by GitHub | 1 |",
      "| Still running | 2 |",
      "| `auto-not-clean-plan` | 2 |",
      "| `gitlink` | 1 |",
      "| `runner-failed` | 1 |",
      "| `finish-incomplete` | 1 |",
      "| `dispatch-refused` | 1 |",
    ]) {
      expect(section).toContain(line);
    }
  });

  test("the window is [from, to): a dispatch at the start counts, one at the end belongs to the next week", async () => {
    const from = -7 * DAY;
    seedDispatch({ status: "refused", code: "gitlink", at: at(from - 1000) });
    seedDispatch({ status: "refused", code: "gitlink", at: at(from) });
    seedDispatch({ status: "refused", code: "gitlink", at: at(-1000) });
    seedDispatch({ status: "refused", code: "gitlink", at: at(0) });
    seedDispatch({ status: "refused", code: "gitlink", at: at(DAY) });
    const r = await report();
    expect(r.facts.repulls?.dispatches.sent).toBe(2);
    expect(r.facts.repulls?.window).toEqual({ from: at(from), to: at(0) });
  });

  test("consecutive weeks count every dispatch once", async () => {
    for (const offset of [-13 * DAY, -8 * DAY - 1000, -7 * DAY, -2 * DAY, -1000]) {
      seedDispatch({ status: "refused", code: "gitlink", at: at(offset) });
    }
    const thisWeek = (await report()).facts.repulls?.dispatches.sent;
    const lastWeek = (await report({}, new Date(NOW.getTime() - 7 * DAY))).facts.repulls?.dispatches
      .sent;
    expect([lastWeek, thisWeek]).toEqual([2, 3]);
  });
});

describe("open automatic re-pulls are counted with the word each is held for", () => {
  test("only open automatic rows count, by hold word, and an unheld one is open and not held", async () => {
    seedAutomatic("pr_open", "screen-acknowledge");
    seedAutomatic("pr_open", "screen-acknowledge");
    seedAutomatic("pr_open", "review-not-pass");
    seedAutomatic("gates_clear");
    seedAutomatic("planned", "resume-exhausted");
    // An administrator's row is never the automatic path's, and a terminal one is not open.
    seedRepull("pr_open", { origin: "administrator" });
    seedAutomatic("complete");
    seedAutomatic("abandoned");
    const r = await report();
    expect(r.facts.repulls?.open_automatic).toEqual({
      total: 5,
      held: 4,
      holds: { "screen-acknowledge": 2, "review-not-pass": 1, "resume-exhausted": 1 },
    });
    const section = sectionOf(r.body);
    expect(section).toContain("| Open automatic re-pulls now | 5 |");
    expect(section).toContain("| Of those, held | 4 |");
    expect(section).toContain("| `screen-acknowledge` | 2 |");
  });
});

describe("a claim to merge held over an hour is counted", () => {
  test("any open re-pull, either pull request, with no merge recorded and a claim older than the bound", async () => {
    const claim = (ago: number) => ({ merge_claimed_at: at(-ago), merge_claim_sha: HEAD });
    seedAutomatic("gates_clear", null, claim(90 * 60_000));
    seedAutomatic("gates_clear", null, claim(30 * 60_000));
    seedRepull("gates_clear", { origin: "administrator", ...claim(3 * HOUR) });
    seedRepull("patch_gates_clear", {
      origin: "administrator",
      patch_merge_claimed_at: at(-2 * HOUR),
      patch_merge_claim_sha: HEAD,
    });
    // A merge is recorded, so the claim is resolved; a terminal row is not open.
    seedAutomatic("merged", null, claim(5 * HOUR));
    seedAutomatic("abandoned", null, claim(5 * HOUR));
    const r = await report();
    expect(r.facts.repulls?.held_claims).toBe(3);
    expect(sectionOf(r.body)).toContain("| Claims to merge held over an hour | 3 |");
  });

  test("older than the bound means older: exactly an hour is not, a second more is", async () => {
    // Literal hours, not the constant: a test that reads the bound it checks cannot see it move.
    expect(HELD_CLAIM_ATTENTION_HOURS).toBe(1);
    seedAutomatic("gates_clear", null, { merge_claimed_at: at(-HOUR), merge_claim_sha: HEAD });
    expect((await report()).facts.repulls?.held_claims).toBe(0);
    seedAutomatic("gates_clear", null, {
      merge_claimed_at: at(-HOUR - 1000),
      merge_claim_sha: HEAD,
    });
    expect((await report()).facts.repulls?.held_claims).toBe(1);
  });
});

describe("re-pulls that ended failed are counted in the week they ended", () => {
  test("any origin, by the time the record ended, and no other terminal state", async () => {
    seedAutomatic("failed", null, { terminal_at: at(-2 * DAY) });
    seedRepull("failed", { origin: "administrator", terminal_at: at(-1000) });
    seedAutomatic("failed", null, { terminal_at: at(-8 * DAY) });
    seedAutomatic("failed", null, { terminal_at: at(0) });
    seedAutomatic("abandoned", null, { terminal_at: at(-2 * DAY) });
    seedAutomatic("superseded", null, { terminal_at: at(-2 * DAY) });
    const r = await report();
    expect(r.facts.repulls?.ended_failed).toBe(2);
    expect(sectionOf(r.body)).toContain("| Re-pulls that ended failed this week | 2 |");
  });
});

describe("merges are counted by who held the claim, from the audit rows the writers leave", () => {
  const ADMIN = 4242;
  const MERGE = STANDIN_MERGE_SHA;

  beforeEach(() => {
    db.run(
      `INSERT INTO users (id, username, email, password_hash, status, role, email_verified)
       VALUES (?, 'mergeadmin', 'mergeadmin@example.org', 'x', 'approved', 'admin', 1)`,
      [ADMIN],
    );
  });

  function seedMirror(dataset: string): void {
    db.run(
      `INSERT INTO datasets (dataset_id, name, owner_user_id, source, source_id)
       VALUES (?, ?, ?, 'openneuro', 'ds099999')`,
      [dataset, dataset, ADMIN],
    );
  }
  function markClear(repullId: number, pr: "n0" | "n1"): void {
    const report = parseScreenReport({
      version: 1,
      scanner: "identifier-scan@abcdef1",
      head: HEAD,
      scan: {
        id: "on099999",
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
       VALUES (?, ?, ?, 'clean', ?, datetime('now'))`,
      [repullId, pr, HEAD, JSON.stringify(report)],
    );
  }

  /**
   * A re-pull merged through the real writers: claimed by `claimant` (null: no claim, a merge
   * outside NEMAR's tools), then recorded from GitHub's word that it merged, by `recorder`.
   */
  async function merged(o: {
    claimant: number | null;
    recorder?: number;
    patch?: boolean;
    origin?: "automatic" | "administrator";
  }): Promise<{ id: number; dataset: string }> {
    const dataset = nextDataset();
    seedMirror(dataset);
    const patch = o.patch === true;
    const status: RepullStatus =
      o.claimant === null ? "pr_open" : patch ? "patch_gates_clear" : "gates_clear";
    const id = seedRepull(status, {
      dataset_id: dataset,
      upstream_ds: "ds099999",
      origin: o.origin ?? "automatic",
      actor_user_id: ADMIN,
      head_sha: HEAD,
      ...(status === "gates_clear" ? { gates_sha: HEAD } : {}),
      ...(patch ? { patch_head_sha: HEAD, patch_gates_sha: HEAD } : {}),
    });
    const pr = patch ? "n1" : "n0";
    if (o.claimant !== null) {
      markClear(id, pr);
      const claim = await transitionRepull(envFor(), { id: o.claimant }, id, {
        from: status,
        to: status,
        fields: patch ? { patch_merge_claim_sha: HEAD } : { merge_claim_sha: HEAD },
      });
      expect(claim, JSON.stringify(claim)).toHaveProperty("row");
    }
    gh.pulls[`${dataset}#${patch ? 8 : 7}`] = {
      merged: true,
      merge_commit_sha: MERGE,
      head: { sha: HEAD, ref: patch ? "release/v2.0.1" : "release/v2.0.0" },
    };
    const done = await recordRepullMerged(envFor(), { id: o.recorder ?? o.claimant ?? ADMIN }, id, {
      pr,
    });
    expect(done, JSON.stringify(done)).toHaveProperty("merged_outside_tool");
    return { id, dataset };
  }

  /**
   * What a release step writes when the tag or the version row is not there yet: the self-edge
   * `resume` records on a merged record, through the same writer as every other edge. It is an
   * edge from `merged` to `merged` (from `patch_merged` to itself for N.0.1), and it is not a merge.
   */
  async function releaseError(id: number, status: "merged" | "patch_merged"): Promise<void> {
    const done = await transitionRepull(envFor(), { id: ADMIN }, id, {
      from: status,
      to: status,
      fields: {},
      error: "[release:tag-missing] the tag is not on GitHub yet",
    });
    expect(done, JSON.stringify(done)).toHaveProperty("row");
  }

  /** The edges into a merged status the audit log holds for a record, in the order written. */
  function mergedEdges(id: number): string[] {
    return db
      .query<{ edge: string }, [string]>(
        `SELECT json_extract(details, '$.from') || ' > ' || json_extract(details, '$.to') AS edge
           FROM audit_log
          WHERE action = 'repull_transition' AND resource_id = ?
            AND json_extract(details, '$.to') IN ('merged', 'patch_merged')
          ORDER BY id`,
      )
      .all(String(id))
      .map((r) => r.edge);
  }

  // The real clock stamps the audit rows, so this report is made as of just after them.
  const soon = () => new Date(Date.now() + 60_000);

  test("the Worker, an administrator's tool and no tool at all are three counts, and N.0.1 counts too", async () => {
    await merged({ claimant: SYSTEM_USER_ID });
    await merged({ claimant: SYSTEM_USER_ID });
    await merged({ claimant: ADMIN, origin: "administrator" });
    await merged({ claimant: ADMIN, patch: true, origin: "administrator" });
    await merged({ claimant: null });
    const r = await report({}, soon());
    expect(r.facts.repulls?.merged).toEqual({
      worker: 2,
      administrator: 2,
      outside_tool: 1,
      unattributed: 0,
    });
    const section = sectionOf(r.body);
    expect(section).toContain("| Merged by the Worker | 2 |");
    expect(section).toContain("| Merged by an administrator | 2 |");
    expect(section).toContain("| Merged outside NEMAR's tools | 1 |");
  });

  test("an automatic re-pull an administrator merged is the administrator's, not the Worker's", async () => {
    await merged({ claimant: ADMIN, origin: "automatic" });
    const merges = (await report({}, soon())).facts.repulls?.merged;
    expect(merges).toEqual({ worker: 0, administrator: 1, outside_tool: 0, unattributed: 0 });
  });

  test("a claim the audit log does not hold is unattributed, never the Worker's", async () => {
    await merged({ claimant: SYSTEM_USER_ID });
    db.run(
      `DELETE FROM audit_log WHERE action = 'repull_transition'
         AND json_extract(details, '$.from') = 'gates_clear'
         AND json_extract(details, '$.to') = 'gates_clear'`,
    );
    const merges = (await report({}, soon())).facts.repulls?.merged;
    expect(merges).toEqual({ worker: 0, administrator: 0, outside_tool: 0, unattributed: 1 });
  });

  test("a merge recorded before the window belongs to an earlier week", async () => {
    await merged({ claimant: SYSTEM_USER_ID });
    const tick = (await report({}, soon())).facts.repulls?.merged.worker;
    expect(tick).toBe(1);
    // The same merge, a report that covers the week before it was recorded.
    const earlier = (await report({}, new Date(Date.now() - 8 * DAY))).facts.repulls?.merged;
    expect(earlier).toEqual({ worker: 0, administrator: 0, outside_tool: 0, unattributed: 0 });
  });

  test("a release step's error on a merged record is not another merge: one merge and two errors count once", async () => {
    const rec = await merged({ claimant: SYSTEM_USER_ID });
    await releaseError(rec.id, "merged");
    await releaseError(rec.id, "merged");
    // The premise: the writer left the merge's edge and two edges that end where they began.
    expect(mergedEdges(rec.id)).toEqual([
      "gates_clear > merged",
      "merged > merged",
      "merged > merged",
    ]);
    const merges = (await report({}, soon())).facts.repulls?.merged;
    expect(merges).toEqual({ worker: 1, administrator: 0, outside_tool: 0, unattributed: 0 });
  });

  test("a merge outside NEMAR's tools followed by a release error is one merge outside, and none unattributed", async () => {
    const rec = await merged({ claimant: null });
    await releaseError(rec.id, "merged");
    expect(mergedEdges(rec.id)).toEqual(["pr_open > merged", "merged > merged"]);
    const merges = (await report({}, soon())).facts.repulls?.merged;
    expect(merges).toEqual({ worker: 0, administrator: 0, outside_tool: 1, unattributed: 0 });
  });

  test("N.0.1's release error is no more a merge than N.0.0's", async () => {
    const rec = await merged({ claimant: ADMIN, patch: true, origin: "administrator" });
    await releaseError(rec.id, "patch_merged");
    expect(mergedEdges(rec.id)).toEqual([
      "patch_gates_clear > patch_merged",
      "patch_merged > patch_merged",
    ]);
    const merges = (await report({}, soon())).facts.repulls?.merged;
    expect(merges).toEqual({ worker: 0, administrator: 1, outside_tool: 0, unattributed: 0 });
  });
});

// ----------------------------------------------------------------------------
// The public report names no dataset
// ----------------------------------------------------------------------------

describe("no dataset reaches the public report", () => {
  const IDS = ["on098701", "on098702", "on098703", "on098704", "on098799"];

  test("no id, in any form, is in the body, the facts or the log line, even where a word is stored", async () => {
    // A dataset id has the shape of a word, and the tables check only the shape.
    seedDispatch({ dataset: "on098701", status: "refused", code: "on098799", at: at(-DAY) });
    seedDispatch({ dataset: "on098702", status: "failed", code: "gitlink", at: at(-DAY) });
    seedDispatch({ dataset: "on098703", status: "started", at: at(-DAY) });
    seedAutomatic("pr_open", "ds098799", { dataset_id: "on098704" });
    seedAutomatic("gates_clear", null, {
      dataset_id: "on098705",
      merge_claimed_at: at(-3 * HOUR),
      merge_claim_sha: HEAD,
    });
    seedRepull("failed", {
      dataset_id: "on098706",
      origin: "automatic",
      terminal_at: at(-DAY),
      last_error: "[auto:head-foreign] on098706",
    });
    stampScheduler({ tick: at(-HOUR), outcome: "on098799", advance: at(-HOUR) });
    const r = await report(ON);
    const everything = `${r.body}\n${JSON.stringify(r.facts)}\n${JSON.stringify(r.facts.errors)}`;
    for (const id of [...IDS, "on098705", "on098706"]) {
      expect(everything).not.toContain(id);
      expect(everything).not.toContain(id.slice(2));
    }
    expect(everything).not.toMatch(/\b(nm|on|ds|xx)\d{6}\b/);
    const line = weeklySummaryLogLine(r.facts, 12);
    expect(line).not.toMatch(/\b(nm|on|ds|xx)\d{6}\b/);
    // The word that was an id is counted, under `other`.
    expect(r.facts.repulls?.dispatches.by_word.refused).toEqual({ other: 1 });
    expect(r.facts.repulls?.open_automatic.holds).toEqual({ other: 1 });
    expect(r.facts.repulls?.scheduler?.last_outcome).toBe("other");
  });

  test("a word that names anonymity is never printed, whichever list it is on", async () => {
    seedDispatch({ status: "refused", code: "anonymous-dataset", at: at(-DAY) });
    seedDispatch({ status: "refused", code: "anonymity-unknown", at: at(-DAY) });
    seedDispatch({ status: "refused", code: "gitlink", at: at(-DAY) });
    seedAutomatic("pr_open", "dataset-anonymous");
    const r = await report();
    expect(r.facts.repulls?.dispatches.by_word.refused).toEqual({ other: 2, gitlink: 1 });
    expect(r.facts.repulls?.open_automatic.holds).toEqual({ other: 1 });
    expect(r.body).not.toMatch(/anonym/i);
  });

  test("a word that is not on its list is counted as other, and a listed one is printed", async () => {
    seedDispatch({ status: "refused", code: "made-up-word", at: at(-DAY) });
    seedDispatch({ status: "refused", code: "gitlink", at: at(-DAY) });
    seedAutomatic("pr_open", "not-a-hold-word");
    seedAutomatic("pr_open", "screen-acknowledge");
    const r = await report();
    expect(r.facts.repulls?.dispatches.by_word.refused).toEqual({ other: 1, gitlink: 1 });
    expect(r.facts.repulls?.open_automatic.holds).toEqual({
      other: 1,
      "screen-acknowledge": 1,
    });
    const section = sectionOf(r.body);
    expect(section).toContain("| `other` | 1 |");
    expect(section).not.toContain("made-up-word");
    expect(section).not.toContain("not-a-hold-word");
  });

  test("the section and the headline carry no dataset id, whatever the week", async () => {
    for (const repulls of [
      repullWeekFacts(),
      repullWeekFacts({
        attention: ["1 re-pull(s) ended failed"],
        ended_failed: 1,
        open_automatic: { total: 1, held: 1, holds: { "screen-acknowledge": 1 } },
      }),
      null,
    ]) {
      const r = await report();
      const facts = { ...r.facts, repulls };
      const body = buildWeeklySummaryBody(facts, "x");
      expect(sectionOf(body)).not.toMatch(/\b(nm|on|ds|xx)\d{6}\b/);
      expect(weeklyHeadline(facts).line).not.toMatch(/\b(nm|on|ds|xx)\d{6}\b/);
    }
  });
});

// ----------------------------------------------------------------------------
// Unknown is never zero (ADR 0054)
// ----------------------------------------------------------------------------

/** A D1 whose statements that name `needle` throw when prepared, as a failing read would. */
function failingOn(d1: D1Database, needle: string): D1Database {
  return {
    ...d1,
    prepare(sql: string) {
      if (sql.includes(needle)) throw new Error("D1_ERROR: the re-pull read failed");
      return d1.prepare(sql);
    },
    batch: d1.batch.bind(d1),
  } as unknown as D1Database;
}

describe("a read that fails is unknown, never zero", () => {
  test("a throw leaves the facts null, lists a failed part, and the section says unknown", async () => {
    db.run(
      "INSERT INTO import_jobs (dataset_id, source, source_id, stage, status) VALUES ('on098800', 'openneuro', 'ds098800', 'prepare', 'failed')",
    );
    const r = await report({}, NOW, failingOn(realD1(db), "upstream_repull_dispatches"));
    expect(r.facts.repulls).toBeNull();
    const failed = r.facts.errors.filter((e) => e.stage === "repulls");
    expect(failed).toHaveLength(1);
    expect(failed[0]?.error).toContain("the re-pull read failed");
    const section = sectionOf(r.body);
    expect(section).toContain("could not be read");
    expect(section).toContain("**unknown**, not zero");
    // Not one count of the section is a number, and no switch is claimed to be off.
    expect(section).not.toMatch(/\| \d+ \|/);
    expect(section).not.toContain("off");
    expect(r.body).toContain("## Parts of this report that failed");
    expect(r.body).toContain("- `repulls`: ");
    // The headline asks: a report that cannot see is not one that found nothing.
    expect(repullProblems(r.facts)).toEqual(["upstream re-pull activity could not be determined"]);
    expect(r.body).toContain("Needs attention");
    // Every other section is intact.
    expect(r.facts.openFailureTotal).toBe(1);
    expect(r.facts.upstream).not.toBeNull();
  });

  test("the log line says unknown for each of its re-pull counts", async () => {
    const r = await report({}, NOW, failingOn(realD1(db), "upstream_repull_dispatches"));
    const line = weeklySummaryLogLine(r.facts, 12);
    expect(line).toContain("repull_dispatched=unknown");
    expect(line).toContain("repull_merged_worker=unknown");
    expect(line).toContain("repull_unreported=unknown");
  });

  test("the scheduler's row missing is unknown, not never, and a switch on asks for attention", async () => {
    db.run("DELETE FROM upstream_repull_scheduler");
    const off = await report();
    expect(off.facts.repulls?.scheduler).toBeNull();
    expect(sectionOf(off.body)).toContain("so when it last ran is **unknown**, not never.");
    expect(repullProblems(off.facts)).toEqual([]);
    const on = await report(ON);
    expect(on.facts.repulls?.attention).toEqual([
      "the automatic re-pull is on, and its scheduler's last run could not be read",
    ]);
  });
});

// ----------------------------------------------------------------------------
// Attention follows ADR 0053
// ----------------------------------------------------------------------------

describe("each reason asks for attention alone", () => {
  const WEEK = at(-2 * DAY);
  const cases: Array<{
    name: string;
    env?: Record<string, string | undefined>;
    seed: () => void;
    phrase: string;
  }> = [
    {
      name: "a switch on and a scheduler that never recorded a run",
      env: ON,
      seed: () => stampScheduler({}),
      phrase: "the automatic re-pull is on, and its scheduler has never recorded a run",
    },
    {
      name: "a switch on and a scheduler silent for over 26 hours",
      env: ON,
      seed: () => stampScheduler({ tick: at(-(26 * HOUR + 1000)), outcome: "ran" }),
      phrase: "the automatic re-pull is on, and its scheduler has not run for over 26 hours",
    },
    {
      name: "a dispatch nobody answered",
      seed: () => seedDispatch({ status: "unreported", at: WEEK }),
      phrase: "1 re-pull dispatch(es) were not reported by their run in time",
    },
    {
      name: "a dispatch GitHub refused",
      seed: () => seedDispatch({ status: "dispatch_failed", code: "dispatch-refused", at: WEEK }),
      phrase: "1 re-pull dispatch(es) were not accepted by GitHub",
    },
    {
      name: "a claim to merge held over an hour",
      seed: () => {
        seedAutomatic("gates_clear", null, {
          merge_claimed_at: at(-2 * HOUR),
          merge_claim_sha: HEAD,
        });
      },
      phrase: "1 re-pull merge claim(s) have been held for over 1 hour",
    },
    {
      name: "a re-pull that ended failed",
      seed: () => {
        seedAutomatic("failed", null, { terminal_at: WEEK });
      },
      phrase: "1 re-pull(s) ended failed",
    },
    {
      name: "a re-pull that used all its resumes",
      seed: () => {
        seedAutomatic("copied", "resume-exhausted");
      },
      phrase: "1 re-pull(s) have used all their resumes (resume-exhausted)",
    },
    {
      name: "a merged re-pull that used all its finish runs",
      seed: () => {
        seedAutomatic("merged", "finish-exhausted");
      },
      phrase: "1 merged re-pull(s) have used all their finish runs (finish-exhausted)",
    },
    {
      name: "an open cap set to something unreadable",
      env: { REPULL_DAILY_OPEN_CAP: "two" },
      seed: () => {},
      phrase: "the re-pull open cap is set to something unreadable, so it reads 0",
    },
    {
      name: "a merge cap set to something unreadable",
      env: { REPULL_DAILY_MERGE_CAP: "21" },
      seed: () => {},
      phrase: "the re-pull merge cap is set to something unreadable, so it reads 0",
    },
  ];

  for (const c of cases) {
    test(`${c.name}: that reason and no other, in the facts, the shared rule and the headline`, async () => {
      stampFresh();
      c.seed();
      const r = await report(c.env);
      expect(r.facts.repulls?.attention).toEqual([c.phrase]);
      expect(repullProblems(r.facts)).toEqual([c.phrase]);
      expect(r.body).toContain("Needs attention");
      expect(r.body).toContain(c.phrase);
    });
  }

  test("the reasons that do not need a switch are reasons with the switches on too", async () => {
    for (const c of cases.filter((x) => x.env === undefined)) {
      db.run("DELETE FROM upstream_repull_dispatches");
      db.run("DELETE FROM upstream_repulls");
      stampFresh();
      c.seed();
      expect([c.name, (await report(ON)).facts.repulls?.attention]).toEqual([c.name, [c.phrase]]);
    }
  });

  test("several reasons are listed in the order the headline gives them", async () => {
    stampScheduler({});
    seedDispatch({ status: "unreported", at: WEEK });
    seedAutomatic("failed", null, { terminal_at: WEEK });
    const r = await report({ ...ON, REPULL_DAILY_OPEN_CAP: "x" });
    expect(r.facts.repulls?.attention).toEqual([
      "the automatic re-pull is on, and its scheduler has never recorded a run",
      "1 re-pull dispatch(es) were not reported by their run in time",
      "1 re-pull(s) ended failed",
      "the re-pull open cap is set to something unreadable, so it reads 0",
    ]);
  });
});

describe("the thresholds are where they are stated", () => {
  test("the scheduler may be silent for 26 hours exactly, and not a second longer", async () => {
    // Literal hours, not the constant: a test that reads the bound it checks cannot see it move.
    expect(SCHEDULER_STALE_HOURS).toBe(26);
    stampScheduler({ tick: at(-26 * HOUR), outcome: "ran" });
    expect((await report(ON)).facts.repulls?.attention).toEqual([]);
    stampScheduler({ tick: at(-26 * HOUR - 1000), outcome: "ran" });
    expect((await report(ON)).facts.repulls?.attention).toEqual([
      "the automatic re-pull is on, and its scheduler has not run for over 26 hours",
    ]);
    stampScheduler({ tick: at(-25 * HOUR - 59 * 60_000), outcome: "ran" });
    expect((await report(ON)).facts.repulls?.attention).toEqual([]);
  });

  test("a claim to merge may be an hour old exactly, and no older", async () => {
    stampFresh();
    seedAutomatic("gates_clear", null, { merge_claimed_at: at(-HOUR), merge_claim_sha: HEAD });
    expect((await report()).facts.repulls?.attention).toEqual([]);
    seedAutomatic("gates_clear", null, {
      merge_claimed_at: at(-HOUR - 1000),
      merge_claim_sha: HEAD,
    });
    expect((await report()).facts.repulls?.attention).toEqual([
      "1 re-pull merge claim(s) have been held for over 1 hour",
    ]);
  });
});

describe("what is not a reason, with nothing to do", () => {
  test("switches off and a scheduler that never ran: quiet, whatever the week holds that is routine", async () => {
    // The path is off: no stamp is a scheduler with nothing to do.
    stampScheduler({});
    seedDispatch({ status: "refused", code: "auto-not-clean-plan", at: at(-DAY) });
    seedDispatch({ status: "opened", at: at(-DAY), repullId: 3 });
    seedDispatch({ status: "finished", at: at(-DAY) });
    seedDispatch({ status: "started", at: at(-DAY) });
    const r = await report();
    expect(r.facts.repulls?.attention).toEqual([]);
    expect(repullProblems(r.facts)).toEqual([]);
  });

  test("a switch spelled any other way than 1 is off, so a silent scheduler is quiet", async () => {
    stampScheduler({});
    for (const value of ["true", " 1", "", "yes", "0"]) {
      expect([
        value,
        (await report({ AUTO_REPULL_ENABLED: value })).facts.repulls?.attention,
      ]).toEqual([value, []]);
    }
    // And a Worker that is not exactly production honors no switch.
    for (const environment of ["staging", "Production", "development", undefined]) {
      const r = await report({ ...ON, ENVIRONMENT: environment });
      expect([environment, r.facts.repulls?.attention]).toEqual([environment, []]);
    }
  });

  test("a hold waiting on a gate is the expected state of a path that works", async () => {
    stampFresh();
    const gateHolds = REPULL_HOLD_REASONS.filter((w) =>
      /^(screen|review|bids|version-check|checks)-|^not-clean$/.test(w),
    );
    // The families named: the screen, the review, BIDS validation, the checks, and `not-clean`.
    expect(gateHolds.length).toBeGreaterThanOrEqual(20);
    for (const word of gateHolds) seedAutomatic("pr_open", word);
    const r = await report(ON);
    expect(r.facts.repulls?.open_automatic.held).toBe(gateHolds.length);
    expect(r.facts.repulls?.attention).toEqual([]);
  });

  test("a switch on, a fresh scheduler and a routine week: nothing for a person", async () => {
    stampFresh();
    seedDispatch({ status: "opened", at: at(-DAY), repullId: 3 });
    seedDispatch({ status: "refused", code: "gitlink", at: at(-DAY) });
    seedAutomatic("pr_open", "screen-acknowledge");
    const r = await report({ ...ON, AUTO_REPULL_MERGE_ENABLED: "1" });
    expect(r.facts.repulls?.attention).toEqual([]);
    expect(repullProblems(r.facts)).toEqual([]);
  });
});

// ----------------------------------------------------------------------------
// One rule
// ----------------------------------------------------------------------------

describe("the headline, the log line and the command's exit code are one function", () => {
  test("the headline asks exactly when the shared rule does, for every week of the re-pulls", async () => {
    const base = (await report()).facts;
    for (const repulls of [
      repullWeekFacts(),
      repullWeekFacts({ attention: ["1 re-pull(s) ended failed"] }),
      null,
    ]) {
      const f = { ...base, repulls };
      expect(weeklyHeadline(f).attention).toBe(weeklyAttention(f).attention);
      for (const p of repulls?.attention ?? []) expect(weeklyHeadline(f).line).toContain(p);
    }
    expect(weeklyAttention({ ...base, repulls: undefined }).problems).toContain(
      "upstream re-pull activity could not be determined",
    );
  });

  test("the log line carries the three counts", async () => {
    seedDispatch({ status: "opened", at: at(-DAY), repullId: 3 });
    seedDispatch({ status: "unreported", at: at(-DAY) });
    const r = await report();
    const line = weeklySummaryLogLine(r.facts, 12);
    expect(line).toContain("repull_dispatched=2");
    expect(line).toContain("repull_merged_worker=0");
    expect(line).toContain("repull_unreported=1");
  });
});

// ----------------------------------------------------------------------------
// The statements
// ----------------------------------------------------------------------------

describe("the statements the report reads", () => {
  test("none of them selects a dataset id", () => {
    for (const [name, sql] of Object.entries(REPULL_WEEK_SQL)) {
      expect([name, /dataset_id\s*(,|\s+FROM|\))/.test(sql.split("FROM")[0] ?? "")]).toEqual([
        name,
        false,
      ]);
    }
  });

  test("the gather reads the week in one batch and agrees with a direct count", async () => {
    seedDispatch({ status: "refused", code: "gitlink", at: at(-DAY) });
    seedDispatch({ status: "unreported", at: at(-DAY) });
    const calls: string[] = [];
    const counting = realD1(db);
    const wrapped = {
      ...counting,
      prepare: counting.prepare.bind(counting),
      batch: async (stmts: unknown[]) => {
        calls.push("batch");
        return (counting as unknown as { batch(s: unknown[]): Promise<unknown> }).batch(stmts);
      },
    } as unknown as D1Database;
    const week = await gatherRepullWeek(
      { DB: wrapped },
      { from: new Date(NOW.getTime() - 7 * DAY), to: NOW },
    );
    expect(calls).toEqual(["batch"]);
    expect(week.dispatches.sent).toBe(2);
    expect(week.dispatches.sent).toBe(
      (db.query("SELECT COUNT(*) AS n FROM upstream_repull_dispatches").get() as { n: number }).n,
    );
  });

  test("repullAttention is empty for every status the path can be in while it is off", () => {
    const week = repullWeekFacts();
    const states = Object.fromEntries(DISPATCH_STATUSES.map((s) => [s, 0])) as Record<
      DispatchStatus,
      number
    >;
    for (const s of ["dispatched", "started", "opened", "finished", "refused", "failed"] as const) {
      states[s] = 2;
    }
    expect(
      repullAttention(
        { ...week, dispatches: { ...week.dispatches, by_status: states } },
        week.switches,
        null,
      ),
    ).toEqual([]);
  });
});
