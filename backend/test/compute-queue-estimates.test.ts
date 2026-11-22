/**
 * Queue estimates (epic #2021 phase D2, #2023; design section 8): the nearest-rank percentile, the
 * per-partition figures, and the statement that reads the waits from the job index.
 *
 * The pure functions are checked with a known sample whose answer is worked out by hand in the test.
 * The statement is run against the real migrated schema: a job that started eight days ago is not a
 * sample, a job with no scheduler submission time is not a sample, the newest 2,000 of a partition are,
 * and fewer than five samples give `null` figures with the count.
 */

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  COMPUTE_QUEUE_MIN_SAMPLES,
  COMPUTE_QUEUE_SAMPLE_CAP,
  COMPUTE_QUEUE_WINDOW_DAYS,
} from "../../shared/contract/compute-user";
import {
  QUEUE_CACHE_MAX,
  QUEUE_CACHE_MS,
  QUEUE_WAITS_SQL,
  buildQueueEstimates,
  computeQueueEstimates,
  nearestRankPercentile,
  queueCacheLimits,
  queueEstimateClock,
} from "../src/services/compute-queue-estimates";
import { insertJob, sqliteAt } from "./helpers/compute-user-seed";
import { freshDb, realD1, wrapD1 } from "./helpers/d1";

const DAY = 86_400_000;

describe("nearestRankPercentile", () => {
  test("ten samples: the median is the fifth, the 90th percentile the ninth, the 100th the last", () => {
    const sorted = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    expect(nearestRankPercentile(sorted, 50)).toBe(50);
    expect(nearestRankPercentile(sorted, 90)).toBe(90);
    expect(nearestRankPercentile(sorted, 100)).toBe(100);
    expect(nearestRankPercentile(sorted, 1)).toBe(10);
  });

  test("five samples: the median is the third, the 90th percentile is the fifth (rank ceil(4.5))", () => {
    const sorted = [1, 2, 3, 4, 100];
    expect(nearestRankPercentile(sorted, 50)).toBe(3);
    expect(nearestRankPercentile(sorted, 90)).toBe(100);
  });

  test("an even count takes the LOWER middle sample, not an average", () => {
    expect(nearestRankPercentile([10, 20], 50)).toBe(10);
    expect(nearestRankPercentile([10, 20, 30, 40], 50)).toBe(20);
  });

  test("one sample is every percentile; no samples is null", () => {
    expect(nearestRankPercentile([7], 50)).toBe(7);
    expect(nearestRankPercentile([7], 90)).toBe(7);
    expect(nearestRankPercentile([], 50)).toBeNull();
  });

  test("a percentile outside (0, 100] and an unsorted list are refused", () => {
    expect(() => nearestRankPercentile([1, 2], 0)).toThrow(RangeError);
    expect(() => nearestRankPercentile([1, 2], 101)).toThrow(RangeError);
    expect(() => nearestRankPercentile([1, 2], Number.NaN)).toThrow(RangeError);
    expect(() => nearestRankPercentile([2, 1], 50)).toThrow(RangeError);
  });
});

describe("buildQueueEstimates", () => {
  const waits = (partition: string, seconds: number[]) =>
    seconds.map((waitSeconds) => ({ partition, waitSeconds }));

  test("a known sample gives the exact median and 90th percentile, whatever order the rows come in", () => {
    // Twelve waits, shuffled. Sorted: 5 9 12 20 33 41 58 77 120 300 650 900.
    // Median: rank ceil(0.5 * 12) = 6 -> 41. 90th: rank ceil(0.9 * 12) = ceil(10.8) = 11 -> 650.
    const shuffled = [300, 12, 900, 5, 58, 41, 9, 650, 20, 120, 33, 77];
    const [shared] = buildQueueEstimates(waits("shared", shuffled), ["shared"]);
    expect(shared).toEqual({
      partition: "shared",
      median_seconds: 41,
      p90_seconds: 650,
      count: 12,
      window_days: COMPUTE_QUEUE_WINDOW_DAYS,
    });
  });

  test("four samples give null figures and the count; five give figures", () => {
    const four = buildQueueEstimates(waits("shared", [1, 2, 3, 4]), ["shared"])[0];
    expect(four).toEqual({
      partition: "shared",
      median_seconds: null,
      p90_seconds: null,
      count: 4,
      window_days: COMPUTE_QUEUE_WINDOW_DAYS,
    });
    expect(COMPUTE_QUEUE_MIN_SAMPLES).toBe(5);
    const five = buildQueueEstimates(waits("shared", [1, 2, 3, 4, 5]), ["shared"])[0];
    expect(five?.median_seconds).toBe(3);
    expect(five?.p90_seconds).toBe(5);
  });

  test("a named partition with no rows is answered with count 0, in the order named; others are left out", () => {
    const out = buildQueueEstimates(
      [...waits("gpu", [1, 2, 3, 4, 5]), ...waits("preempt", [9])],
      ["shared", "gpu"],
    );
    expect(out.map((e) => [e.partition, e.count])).toEqual([
      ["shared", 0],
      ["gpu", 5],
    ]);
  });

  test("without a list, the partitions that have rows, by name", () => {
    const out = buildQueueEstimates([...waits("shared", [1]), ...waits("gpu", [2])]);
    expect(out.map((e) => e.partition)).toEqual(["gpu", "shared"]);
  });
});

describe("computeQueueEstimates reads the job index", () => {
  let db: Database;
  beforeEach(() => {
    db = freshDb();
  });

  /** A job that waited `wait` seconds and started `startedAgoMs` before now. */
  function started(partition: string, wait: number, startedAgoMs: number, over = {}) {
    const startedAt = Date.now() - startedAgoMs;
    insertJob(db, {
      partition,
      state: "finished",
      started_at: sqliteAt(startedAt),
      remote_submitted_at: sqliteAt(startedAt - wait * 1000),
      ...over,
    });
  }

  test("the median and 90th percentile are exact; a job that started eight days ago is not a sample", async () => {
    // Waits 10, 20, ..., 100 seconds started yesterday; one 5,000-second wait that started eight days ago.
    for (let i = 1; i <= 10; i++) started("shared", i * 10, DAY);
    started("shared", 5000, 8 * DAY);
    const [shared] = await computeQueueEstimates(realD1(db), ["shared"]);
    expect(shared).toMatchObject({
      partition: "shared",
      count: 10,
      median_seconds: 50,
      p90_seconds: 90,
      window_days: 7,
    });
  });

  test("the edge of the window: six days is in, eight is out", async () => {
    for (let i = 0; i < 5; i++) started("compute", 30, 6 * DAY);
    for (let i = 0; i < 5; i++) started("compute", 9999, 8 * DAY);
    const [compute] = await computeQueueEstimates(realD1(db), ["compute"]);
    expect(compute?.count).toBe(5);
    expect(compute?.median_seconds).toBe(30);
  });

  test("four samples give null figures with the count", async () => {
    for (let i = 0; i < 4; i++) started("debug", 12, DAY);
    const [debug] = await computeQueueEstimates(realD1(db), ["debug"]);
    expect(debug).toMatchObject({ count: 4, median_seconds: null, p90_seconds: null });
  });

  test("a job with no scheduler submission time, no start, or a start before its submission is not a sample", async () => {
    for (let i = 0; i < 5; i++) started("shared", 20, DAY);
    started("shared", 0, DAY, { remote_submitted_at: null });
    insertJob(db, { partition: "shared", state: "queued", started_at: null });
    // Started 100 seconds BEFORE its submission: a clock fault, not a wait of minus 100.
    insertJob(db, {
      partition: "shared",
      started_at: sqliteAt(Date.now() - DAY),
      remote_submitted_at: sqliteAt(Date.now() - DAY + 100_000),
    });
    const [shared] = await computeQueueEstimates(realD1(db), ["shared"]);
    expect(shared?.count).toBe(5);
    expect(shared?.median_seconds).toBe(20);
  });

  test("every front door counts, and a partition's rows never reach another's figures", async () => {
    for (const source of ["cli", "web", "partner", "pipeline", "cli"] as const) {
      started("shared", 100, DAY, { source });
    }
    for (let i = 0; i < 5; i++) started("gpu", 900, DAY);
    const out = await computeQueueEstimates(realD1(db), ["shared", "gpu"]);
    expect(out.map((e) => [e.partition, e.count, e.median_seconds])).toEqual([
      ["shared", 5, 100],
      ["gpu", 5, 900],
    ]);
  });

  test(
    "only the newest 2,000 of a partition are read: older rows, which waited far longer, change nothing",
    async () => {
      // 2,000 recent jobs that waited 10 seconds, started within the last two days; 300 older jobs (still
      // inside the window) that waited 10,000 seconds. The cap keeps the newest 2,000, so the 90th
      // percentile is 10. Read oldest-first, or without the cap, the 300 (15% of the sample, more than the
      // 10% above the 90th percentile) would push it to their wait.
      const now = Date.now();
      const insert = db.query(
        `INSERT INTO compute_jobs (id, account_id, source, kind, state, app_id, app_version,
           spec_digest, partition, pool, nodes, cores_per_node, minutes, started_at, remote_submitted_at)
         VALUES (?, 1, 'cli', 'batch', 'finished', 'a', '1', ?, 'shared', 'cpu', 1, 1, 1, ?, ?)`,
      );
      db.transaction(() => {
        for (let i = 0; i < COMPUTE_QUEUE_SAMPLE_CAP; i++) {
          const startedAt = now - 1000 * (i + 1);
          insert.run(
            `job_${(100_000 + i).toString(16).padStart(24, "0")}`,
            "0".repeat(64),
            sqliteAt(startedAt),
            sqliteAt(startedAt - 10_000),
          );
        }
        for (let i = 0; i < 300; i++) {
          const startedAt = now - 3 * DAY - 1000 * i;
          insert.run(
            `job_${(900_000 + i).toString(16).padStart(24, "0")}`,
            "0".repeat(64),
            sqliteAt(startedAt),
            sqliteAt(startedAt - 10_000_000),
          );
        }
      })();
      const [shared] = await computeQueueEstimates(realD1(db), ["shared"]);
      expect(shared?.count).toBe(COMPUTE_QUEUE_SAMPLE_CAP);
      expect(shared?.median_seconds).toBe(10);
      expect(shared?.p90_seconds).toBe(10);
    },
    { timeout: 60_000 },
  );
});

describe("the 30-second cache of an estimate", () => {
  let db: Database;
  let queries: string[];
  let d1: D1Database;
  let nowMs: number;
  const realNow = queueEstimateClock.now;

  beforeEach(() => {
    db = freshDb();
    queries = [];
    // One database object, as a Worker's binding is: the cache is per database.
    d1 = wrapD1(realD1(db), (sql, binds) => {
      if (sql === QUEUE_WAITS_SQL) queries.push(String(binds[0]));
    });
    nowMs = Date.now();
    queueEstimateClock.now = () => nowMs;
  });
  afterEach(() => {
    queueEstimateClock.now = realNow;
    queueCacheLimits.max = QUEUE_CACHE_MAX;
  });

  function startedJobs(partition: string, n: number, wait: number) {
    for (let i = 0; i < n; i++) {
      const at = Date.now() - 3_600_000;
      insertJob(db, {
        partition,
        started_at: sqliteAt(at),
        remote_submitted_at: sqliteAt(at - wait * 1000),
      });
    }
  }

  test("a second call within 30 seconds runs no queue query and answers the same; after 30 seconds it does", async () => {
    startedJobs("shared", 5, 10);
    const first = await computeQueueEstimates(d1, ["shared", "compute"]);
    expect(queries.sort()).toEqual(["compute", "shared"]);
    // New jobs change what a fresh read would say; the cached answer does not.
    startedJobs("shared", 5, 500);
    nowMs += QUEUE_CACHE_MS - 1;
    const second = await computeQueueEstimates(d1, ["shared", "compute"]);
    expect(queries).toHaveLength(2);
    expect(second).toEqual(first);
    nowMs += 1;
    const third = await computeQueueEstimates(d1, ["shared", "compute"]);
    expect(queries).toHaveLength(4);
    expect(third[0]?.count).toBe(10);
    expect(third[0]?.p90_seconds).toBe(500);
  });

  test("the partitions are read together, not one after the other", async () => {
    let open = 0;
    let most = 0;
    const slow = wrapD1(realD1(db), async (sql) => {
      if (sql !== QUEUE_WAITS_SQL) return;
      open += 1;
      most = Math.max(most, open);
      await new Promise((resolve) => setTimeout(resolve, 5));
      open -= 1;
    });
    await computeQueueEstimates(slow, ["shared", "compute", "debug", "gpu"]);
    expect(most).toBe(4);
  });

  test("another database's cache is not this one's, and the cache is bounded", async () => {
    startedJobs("shared", 5, 10);
    await computeQueueEstimates(d1, ["shared"]);
    const otherDb = freshDb();
    const other = await computeQueueEstimates(realD1(otherDb), ["shared"]);
    expect(other[0]?.count).toBe(0);
    const many = Array.from({ length: QUEUE_CACHE_MAX + 5 }, (_, i) => `p${i}`);
    queries.length = 0;
    await computeQueueEstimates(d1, many);
    expect(queries).toHaveLength(many.length);
    queries.length = 0;
    // The oldest were forgotten (and read again); the newest are still held.
    await computeQueueEstimates(d1, many);
    expect(queries.length).toBe(many.length - QUEUE_CACHE_MAX);
  });

  test("an entry that is read again is the newest: the one forgotten is the one read longest ago", async () => {
    queueCacheLimits.max = 2;
    await computeQueueEstimates(d1, ["p1"]); // t0
    nowMs += 20_000;
    await computeQueueEstimates(d1, ["p2"]); // t0 + 20 s
    nowMs += 11_000;
    await computeQueueEstimates(d1, ["p1"]); // t0 + 31 s: p1 had expired, is read again and is now the newest
    nowMs += 1_000;
    await computeQueueEstimates(d1, ["p3"]); // t0 + 32 s: the cache is over its size; p2 (read at 20 s) goes
    queries.length = 0;
    nowMs += 1_000;
    await computeQueueEstimates(d1, ["p1", "p2", "p3"]); // t0 + 33 s: p1 and p3 are held, p2 is not
    expect(queries).toEqual(["p2"]);
  });
});
