/**
 * `GET /compute/me/jobs` and `GET /compute/me/jobs/:id` (epic #2021 phase D2, #2023), through the REAL
 * compute router over real migrated SQLite, with real API keys.
 *
 * What is pinned:
 *  - the caller's jobs only, from every front door, newest first, with the cursor continuing exactly:
 *    a job made between two pages is neither repeated nor does it make the rest skip one, and rows
 *    with the same creation time are paged without a gap;
 *  - another person's job id, an absent one, a malformed one and a job the tenant sweep indexed are ONE
 *    answer, 404 `job_not_found` (the route is no oracle for what exists);
 *  - the job view is exactly its declared keys: no flag, no failure attribution, no Slurm or Tapis id,
 *    no pseudonym, no hold figure;
 *  - the query string is validated with the words of the contract.
 */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { COMPUTE_STATES } from "../../shared/compute-state";
import {
  ComputeUserJobResponseSchema,
  ComputeUserJobsResponseSchema,
} from "../../shared/contract/compute-user";
import {
  type Person,
  insertJob,
  personWithKey,
  readApp,
  sqliteAt,
} from "./helpers/compute-user-seed";
import { freshDb } from "./helpers/d1";

let db: Database;
let me: Person;
let other: Person;

beforeEach(async () => {
  db = freshDb();
  me = await personWithKey(db);
  other = await personWithKey(db);
});

const get = (path: string, key: string = me.key) => readApp(db).call(path, { key });

/** `n` jobs of `account`, one second apart, oldest first; their ids in creation order. */
function jobsOf(account: number, n: number, startMs = Date.UTC(2026, 9, 1, 12, 0, 0), over = {}) {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    ids.push(
      insertJob(db, { account_id: account, created_at: sqliteAt(startMs + i * 1000), ...over }),
    );
  }
  return ids;
}

describe("the list", () => {
  test("only the caller's jobs, from every front door, newest first", async () => {
    const mine = [
      insertJob(db, { account_id: me.id, source: "cli", created_at: "2026-10-01 10:00:00" }),
      insertJob(db, { account_id: me.id, source: "web", created_at: "2026-10-02 10:00:00" }),
      insertJob(db, { account_id: me.id, source: "partner", created_at: "2026-10-03 10:00:00" }),
      insertJob(db, { account_id: me.id, source: "pipeline", created_at: "2026-10-04 10:00:00" }),
    ];
    insertJob(db, { account_id: other.id, created_at: "2026-10-05 10:00:00" });
    insertJob(db, { account_id: null, source: "partner", created_at: "2026-10-06 10:00:00" });
    // A partner's job that no reservation covered, matched to this person by the tenant sweep: it was
    // charged to the partner's pool, not to them, so it is not in their list.
    insertJob(db, {
      account_id: me.id,
      source: "partner",
      flag_unreserved: 1,
      charged_milli: 5_000,
      created_at: "2026-10-07 10:00:00",
    });
    const res = await get("/me/jobs");
    expect(res.status).toBe(200);
    expect(ComputeUserJobsResponseSchema.safeParse(res.body).success).toBe(true);
    expect(res.body.jobs.map((j: { id: string }) => j.id)).toEqual([...mine].reverse());
    expect(res.body.jobs.map((j: { source: string }) => j.source)).toEqual([
      "pipeline",
      "partner",
      "web",
      "cli",
    ]);
    expect(res.body.next_after).toBeNull();
  });

  test("the fields are the job's, with resources, a charge and a failure code", async () => {
    const id = insertJob(db, {
      account_id: me.id,
      state: "failed",
      failure_code: "runtime_error",
      partition: "compute",
      nodes: 2,
      cores_per_node: 128,
      memory_mb: 4096,
      gpus: 0,
      minutes: 90,
      created_at: "2026-10-05 10:00:00",
      started_at: "2026-10-05 10:10:00",
      ended_at: "2026-10-05 10:40:00",
      charged_milli: 12_345,
    });
    const res = await get(`/me/jobs/${id}`);
    expect(res.status).toBe(200);
    expect(res.body.job).toEqual({
      id,
      kind: "batch",
      source: "cli",
      state: "failed",
      app_id: "nemar-launch",
      app_version: "1.0.0",
      partition: "compute",
      pool: "cpu",
      resources: { nodes: 2, cores_per_node: 128, memory_mb: 4096, gpus: 0, minutes: 90 },
      created_at: "2026-10-05 10:00:00",
      started_at: "2026-10-05 10:10:00",
      ended_at: "2026-10-05 10:40:00",
      charged_milli: 12_345,
      failure_code: "runtime_error",
      cancel_requested: false,
    });
  });

  test("a page of the default size is 25, and `next_after` continues it", async () => {
    jobsOf(me.id, 30);
    const first = await get("/me/jobs");
    expect(first.body.jobs).toHaveLength(25);
    expect(first.body.next_after).not.toBeNull();
    const second = await get(`/me/jobs?after=${encodeURIComponent(first.body.next_after)}`);
    expect(second.body.jobs).toHaveLength(5);
    expect(second.body.next_after).toBeNull();
  });

  test("the state filter, and the limit's bounds", async () => {
    insertJob(db, { account_id: me.id, state: "running", created_at: "2026-10-01 10:00:00" });
    insertJob(db, { account_id: me.id, state: "finished", created_at: "2026-10-02 10:00:00" });
    insertJob(db, { account_id: me.id, state: "running", created_at: "2026-10-03 10:00:00" });
    const running = await get("/me/jobs?state=running");
    expect(running.body.jobs.map((j: { state: string }) => j.state)).toEqual([
      "running",
      "running",
    ]);
    expect((await get("/me/jobs?limit=1")).body.jobs).toHaveLength(1);
    expect((await get("/me/jobs?limit=100")).status).toBe(200);
    for (const state of COMPUTE_STATES)
      expect((await get(`/me/jobs?state=${state}`)).status).toBe(200);
  });

  test("a bad state, limit or cursor is refused with its word", async () => {
    for (const [query, code] of [
      ["state=done", "invalid_state"],
      ["state=", "invalid_state"],
      ["state=RUNNING", "invalid_state"],
      ["limit=0", "invalid_limit"],
      ["limit=101", "invalid_limit"],
      ["limit=-1", "invalid_limit"],
      ["limit=1.5", "invalid_limit"],
      ["limit=abc", "invalid_limit"],
      ["limit=1e2", "invalid_limit"],
      ["limit=", "invalid_limit"],
      ["after=nonsense", "invalid_cursor"],
      ["after=", "invalid_cursor"],
      ["after=2026-10-01T10:00:00", "invalid_cursor"],
      ["after=2026-10-01T10:00:00_x", "invalid_cursor"],
      // The old shape, with a row number, and a job id that is not one.
      ["after=2026-10-01T10:00:00_41", "invalid_cursor"],
      ["after=2026-10-01T10:00:00|41", "invalid_cursor"],
      ["after=2026-10-01T10:00:00|job_XYZ", "invalid_cursor"],
      ["after=2026-10-01 10:00:00|job_000000000000000000000001", "invalid_cursor"],
    ] as const) {
      const res = await get(`/me/jobs?${query}`);
      expect([query, res.status, res.body.code]).toEqual([query, 400, code]);
    }
  });
});

describe("pagination", () => {
  test("pages cover every job once, in order, and a job made between two pages is not a gap or a repeat", async () => {
    const ids = jobsOf(me.id, 9); // oldest first
    const expected = [...ids].reverse();
    const page1 = await get("/me/jobs?limit=4");
    expect(page1.body.jobs.map((j: { id: string }) => j.id)).toEqual(expected.slice(0, 4));
    // A newer job appears between the pages: it is before the cursor, so it is not in the rest.
    const arrived = insertJob(db, {
      account_id: me.id,
      created_at: sqliteAt(Date.UTC(2026, 9, 1, 13, 0, 0)),
    });
    const page2 = await get(`/me/jobs?limit=4&after=${encodeURIComponent(page1.body.next_after)}`);
    expect(page2.body.jobs.map((j: { id: string }) => j.id)).toEqual(expected.slice(4, 8));
    const page3 = await get(`/me/jobs?limit=4&after=${encodeURIComponent(page2.body.next_after)}`);
    expect(page3.body.jobs.map((j: { id: string }) => j.id)).toEqual(expected.slice(8));
    expect(page3.body.next_after).toBeNull();
    const seen = [...page1.body.jobs, ...page2.body.jobs, ...page3.body.jobs].map(
      (j: { id: string }) => j.id,
    );
    expect(seen).not.toContain(arrived);
    expect(new Set(seen).size).toBe(seen.length);
    // And a fresh read starts with the new job.
    expect((await get("/me/jobs?limit=1")).body.jobs[0].id).toBe(arrived);
  });

  test("the cursor is the last job's time and id, and carries no row number of the table", async () => {
    const ids = jobsOf(me.id, 3);
    const page = await get("/me/jobs?limit=2");
    const last = page.body.jobs[1].id;
    expect(page.body.next_after).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\|job_[0-9a-f]{24}$/);
    expect(page.body.next_after.endsWith(`|${last}`)).toBe(true);
    expect(last).toBe(ids[1]);
  });

  test("jobs created in the same second are paged without a gap or a repeat", async () => {
    const same = "2026-10-05 10:00:00";
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) ids.push(insertJob(db, { account_id: me.id, created_at: same }));
    // One older, one newer, around the tie.
    const older = insertJob(db, { account_id: me.id, created_at: "2026-10-05 09:00:00" });
    const newer = insertJob(db, { account_id: me.id, created_at: "2026-10-05 11:00:00" });
    const expected = [newer, ...[...ids].reverse(), older];
    const seen: string[] = [];
    let after: string | null = null;
    for (let guard = 0; guard < 20; guard++) {
      const res = await get(
        `/me/jobs?limit=2${after ? `&after=${encodeURIComponent(after)}` : ""}`,
      );
      seen.push(...res.body.jobs.map((j: { id: string }) => j.id));
      after = res.body.next_after;
      if (after === null) break;
    }
    expect(seen).toEqual(expected);
  });

  test("a cursor of one person's list continues only that person's list", async () => {
    jobsOf(me.id, 3);
    jobsOf(other.id, 3, Date.UTC(2026, 9, 1, 12, 0, 1));
    const mine = await get("/me/jobs?limit=1");
    const theirs = await get(
      `/me/jobs?limit=5&after=${encodeURIComponent(mine.body.next_after)}`,
      other.key,
    );
    const theirIds = new Set(
      db
        .query<{ id: string }, [number]>("SELECT id FROM compute_jobs WHERE account_id = ?")
        .all(other.id)
        .map((r) => r.id),
    );
    expect(theirs.body.jobs.length).toBeGreaterThan(0);
    for (const j of theirs.body.jobs) expect(theirIds.has(j.id)).toBe(true);
  });
});

describe("one job", () => {
  test("another person's job, an absent job, a malformed id and a swept job are one answer", async () => {
    const theirs = insertJob(db, { account_id: other.id });
    const swept = insertJob(db, { account_id: me.id, flag_unreserved: 1, source: "partner" });
    const absent = "job_0000000000000000deadbeef";
    const answers: Array<{ status: number; body: unknown }> = [];
    for (const id of [theirs, absent, "not-a-job", swept, "job_%", "x".repeat(300)]) {
      const res = await get(`/me/jobs/${encodeURIComponent(id)}`);
      answers.push({ status: res.status, body: res.body });
    }
    for (const a of answers) {
      expect(a.status).toBe(404);
      expect(a.body).toEqual({ error: "No such job.", code: "job_not_found" });
    }
  });

  test("the owner reads their own job, and a job's id is not enough for anyone else", async () => {
    const id = insertJob(db, { account_id: me.id });
    expect((await get(`/me/jobs/${id}`)).status).toBe(200);
    expect((await get(`/me/jobs/${id}`, other.key)).status).toBe(404);
    // An administrator is a stranger to a person's job on this route too.
    const admin = await personWithKey(db);
    db.query("UPDATE users SET role = 'owner' WHERE id = ?").run(admin.id);
    expect((await get(`/me/jobs/${id}`, admin.key)).status).toBe(404);
  });

  test("the detail answer parses and carries `stale: false` when nothing was refreshed", async () => {
    const id = insertJob(db, { account_id: me.id, state: "finished" });
    const res = await get(`/me/jobs/${id}`);
    expect(ComputeUserJobResponseSchema.safeParse(res.body).success).toBe(true);
    expect(res.body.stale).toBe(false);
  });
});

describe("what a job view never carries", () => {
  test("the view is exactly its declared keys, and none of the admin-only values is on the wire", async () => {
    const id = insertJob(db, {
      account_id: me.id,
      state: "failed",
      failure_code: "tapis_record_lost",
      platform_failure: 1,
      flag_mismatch: 1,
      flag_overrun: 1,
      flag_unattributed: 1,
      tapis_uuid: "11111111-2222-3333-4444-555555555555",
      slurm_job_id: "9876543",
      held_milli: 777,
      tapis_owner: "someone.tapis",
      client_id: "partner-client-x",
      cancel_requested_at: "2026-10-05 11:00:00",
    });
    db.query(
      "UPDATE compute_jobs SET gateway_user = 'gw_abcdefghijklmnopqrst', tapis_status = 'FAILED' WHERE id = ?",
    ).run(id);
    const detail = await get(`/me/jobs/${id}`);
    const list = await get("/me/jobs");
    expect(Object.keys(detail.body.job).sort()).toEqual(
      [
        "app_id",
        "app_version",
        "cancel_requested",
        "charged_milli",
        "created_at",
        "ended_at",
        "failure_code",
        "id",
        "kind",
        "partition",
        "pool",
        "resources",
        "source",
        "started_at",
        "state",
      ].sort(),
    );
    expect(detail.body.job.cancel_requested).toBe(true);
    expect(list.body.jobs[0]).toEqual(detail.body.job);
    for (const text of [detail.text, list.text]) {
      for (const word of [
        "flag",
        "mismatch",
        "overrun",
        "unattributed",
        "platform_failure",
        "11111111-2222",
        "9876543",
        "777",
        "someone.tapis",
        "partner-client-x",
        "gw_",
        "gateway",
        "FAILED",
        "account_id",
        "failure_detail",
        "cancel_reason",
      ]) {
        expect([word, text.includes(word)]).toEqual([word, false]);
      }
    }
  });
});
