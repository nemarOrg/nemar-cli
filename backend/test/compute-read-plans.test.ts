/**
 * The query plans of the compute read routes (epic #2021 phase D2, #2023; migration 0132), on the REAL
 * statements the routes run, over the real migrated schema.
 *
 * The phase's rule: an index is added only where `EXPLAIN QUERY PLAN` shows a scan of the jobs or the
 * ledger that Epic A's indexes do not cover. This test is that evidence kept: each statement names the
 * index it must use, and none may SCAN `compute_jobs` or `compute_ledger`. Without migration 0132 the
 * queue estimate, the partner's aggregate usage, the count of people and the count of outcomes all scan
 * (the migration's header says so); a person's own reads never did.
 */

import { describe, expect, test } from "bun:test";
import { LIVE_JOBS_GUARD_SQL } from "../src/services/compute-jobs";
import { ACCOUNT_POOLS_SQL } from "../src/services/compute-ledger";
import { QUEUE_WAITS_SQL } from "../src/services/compute-queue-estimates";
import {
  ACTIVE_PEOPLE_SQL,
  JOBS_BY_OUTCOME_SQL,
  USER_JOB_SQL,
  jobsPageSql,
  usageSql,
} from "../src/services/compute-user-reads";
import { freshDb } from "./helpers/d1";

const db = freshDb();

function planOf(sql: string, binds: unknown[]): string[] {
  return (
    db.query(`EXPLAIN QUERY PLAN ${sql}`).all(...(binds as never[])) as Array<{ detail: string }>
  ).map((row) => row.detail);
}

const WINDOW = ["2026-01-01 00:00:00", "2026-02-01 00:00:00"];

const CASES: Array<{ name: string; sql: string; binds: unknown[]; index: string }> = [
  {
    name: "queue estimate",
    sql: QUEUE_WAITS_SQL,
    binds: ["shared"],
    index: "compute_jobs_queue_started",
  },
  {
    name: "a person's usage, grouped",
    sql: usageSql("account", ["day", "app", "partition", "source"]),
    binds: ["7", ...WINDOW],
    index: "compute_ledger_pool",
  },
  {
    name: "a person's usage, one total",
    sql: usageSql("account", []),
    binds: ["7", ...WINDOW],
    index: "compute_ledger_pool",
  },
  {
    name: "the partner's usage",
    sql: usageSql("platform", ["day", "partition", "source"]),
    binds: [...WINDOW],
    index: "compute_ledger_created",
  },
  {
    name: "a person's jobs",
    sql: jobsPageSql({ state: false, cursor: false }),
    binds: [7, 26],
    index: "compute_jobs_account_created_id",
  },
  {
    name: "a person's jobs by state, after a cursor",
    sql: jobsPageSql({ state: true, cursor: true }),
    binds: [7, "running", WINDOW[0], "job_000000000000000000000005", 26],
    index: "compute_jobs_account_created_id",
  },
  {
    name: "one job",
    sql: USER_JOB_SQL,
    binds: ["job_000000000000000000000001", 7],
    index: "sqlite_autoindex_compute_jobs_1",
  },
  {
    name: "active people",
    sql: ACTIVE_PEOPLE_SQL,
    binds: [...WINDOW],
    index: "compute_jobs_created",
  },
  {
    name: "jobs by outcome",
    sql: JOBS_BY_OUTCOME_SQL,
    binds: [...WINDOW],
    index: "compute_jobs_created",
  },
  {
    name: "a person's pools",
    sql: ACCOUNT_POOLS_SQL,
    binds: ["7"],
    index: "sqlite_autoindex_compute_pools_1",
  },
];

describe("no read route scans the jobs or the ledger", () => {
  for (const c of CASES) {
    test(`${c.name} uses ${c.index}`, () => {
      const plan = planOf(c.sql, c.binds);
      expect(plan.some((line) => line.includes(c.index))).toBe(true);
      const scans = plan.filter((line) =>
        /^SCAN (e|j|compute_jobs|compute_ledger|compute_pools)\b/.test(line),
      );
      expect(scans).toEqual([]);
    });
  }

  test("a person's job list needs no sort: the index order is the statement's order", () => {
    const plan = planOf(jobsPageSql({ state: true, cursor: true }), [
      7,
      "running",
      WINDOW[0],
      5,
      26,
    ]);
    expect(plan.filter((line) => /TEMP B-TREE FOR .*ORDER BY/.test(line))).toEqual([]);
  });

  test("the list index is partial on flag_unreserved = 0, so it cannot take Epic A's plans for queries that name only the account", () => {
    const sql = db
      .query<{ sql: string }, []>(
        "SELECT sql FROM sqlite_master WHERE name = 'compute_jobs_account_created_id'",
      )
      .get()?.sql;
    expect(sql).toContain("WHERE flag_unreserved = 0");
    // The quota sums (answered by Epic A's partial index `compute_jobs_results`) and the live-job count
    // (`compute_jobs_live`) keep the plan they had before migration 0132: a plain index on the account
    // took the first of them once.
    const quota = planOf(
      "SELECT COALESCE(SUM(results_bytes), 0) FROM compute_jobs WHERE account_id = 7 AND results_bytes IS NOT NULL",
      [],
    );
    expect(quota.join(" ")).toContain("compute_jobs_results");
    const all = planOf(
      "SELECT COALESCE(SUM(results_bytes), 0) FROM compute_jobs WHERE account_id = 7",
      [],
    );
    expect(all.join(" ")).not.toContain("compute_jobs_account_created_id");
    const live = planOf(`SELECT ${LIVE_JOBS_GUARD_SQL.replace(/\?/g, "7")}`, []);
    expect(live.join(" ")).toContain("compute_jobs_live");
    expect(live.join(" ")).not.toContain("compute_jobs_account_created_id");
  });

  test("the four indexes of migration 0132 exist, and the queue index is partial", () => {
    const rows = db
      .query<{ name: string; sql: string }, []>(
        "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND name IN ('compute_jobs_queue_started', 'compute_jobs_created', 'compute_ledger_created', 'compute_jobs_account_created_id')",
      )
      .all();
    expect(rows.map((r) => r.name).sort()).toEqual([
      "compute_jobs_account_created_id",
      "compute_jobs_created",
      "compute_jobs_queue_started",
      "compute_ledger_created",
    ]);
    const queue = rows.find((r) => r.name === "compute_jobs_queue_started");
    expect(queue?.sql).toContain("started_at IS NOT NULL AND remote_submitted_at IS NOT NULL");
  });
});
