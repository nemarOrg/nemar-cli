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
import { beforeEach, describe, expect, test } from "bun:test";
import {
  COMPUTE_QUEUE_MIN_SAMPLES,
  COMPUTE_QUEUE_SAMPLE_CAP,
  COMPUTE_QUEUE_WINDOW_DAYS,
} from "../../shared/contract/compute-user";
import {
  buildQueueEstimates,
  computeQueueEstimates,
  nearestRankPercentile,
} from "../src/services/compute-queue-estimates";
import { insertJob, sqliteAt } from "./helpers/compute-user-seed";
import { freshDb, realD1 } from "./helpers/d1";

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
