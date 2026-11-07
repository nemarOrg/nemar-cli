/**
 * How long jobs have waited to start, per partition (epic #2021 phase D2, #2023; design section 8).
 *
 * The figure is the median and the 90th percentile of `remote_submitted_at` to `started_at`, the two
 * times the scheduler's own record gives (Tapis `remoteSubmitted` and `remoteStarted`), over the jobs
 * that STARTED in the last seven days, the newest 2,000 of each partition, whoever submitted them and
 * whichever front door they came through. It is an aggregate of the platform's queue, not of a person:
 * the answer names no job and no account, and it is the same for everybody.
 *
 * A thin sample is not an estimate. With fewer than five jobs the figures are `null` and the count is
 * still reported, so a reader sees "3 jobs" and not a median of three that looks like a forecast.
 *
 * `nearestRankPercentile` and `buildQueueEstimates` are pure. `computeQueueEstimates` reads the rows;
 * `QUEUE_WAITS_SQL` is exported so a test runs, and plans, the real statement.
 */

import {
  COMPUTE_QUEUE_MIN_SAMPLES,
  COMPUTE_QUEUE_SAMPLE_CAP,
  COMPUTE_QUEUE_WINDOW_DAYS,
  type ComputeQueueEstimate,
} from "../../../shared/contract/compute-user.js";

/**
 * The value at nearest rank: the smallest sample such that at least `p` percent of the samples are at or
 * below it, which is the sample at rank `ceil(p / 100 * n)` of the sorted list (1-based). For an even
 * count the median is therefore the LOWER of the two middle samples, and the 90th percentile of ten
 * samples is the ninth. `null` for no samples. `p` is in (0, 100]; the samples must be ascending.
 */
export function nearestRankPercentile(sortedSeconds: readonly number[], p: number): number | null {
  if (!(p > 0 && p <= 100)) throw new RangeError("a percentile is above 0 and at most 100");
  for (let i = 1; i < sortedSeconds.length; i++) {
    if ((sortedSeconds[i] as number) < (sortedSeconds[i - 1] as number)) {
      throw new RangeError("the samples must be sorted ascending");
    }
  }
  if (sortedSeconds.length === 0) return null;
  const rank = Math.ceil((p / 100) * sortedSeconds.length);
  return sortedSeconds[rank - 1] as number;
}

/** One started job's wait, in whole seconds. */
export interface QueueWait {
  partition: string;
  waitSeconds: number;
}

/**
 * The estimate of each partition. `partitions` names (and orders) the partitions to answer for, each
 * with its count even when it has no rows; without it, the partitions that have rows, by name.
 */
export function buildQueueEstimates(
  rows: readonly QueueWait[],
  partitions?: readonly string[],
): ComputeQueueEstimate[] {
  const byPartition = new Map<string, number[]>();
  for (const name of partitions ?? []) byPartition.set(name, []);
  for (const row of rows) {
    if (partitions !== undefined && !byPartition.has(row.partition)) continue;
    const list = byPartition.get(row.partition) ?? [];
    list.push(row.waitSeconds);
    byPartition.set(row.partition, list);
  }
  const names = partitions ?? [...byPartition.keys()].sort();
  return names.map((partition) => {
    const sorted = [...(byPartition.get(partition) ?? [])].sort((a, b) => a - b);
    const enough = sorted.length >= COMPUTE_QUEUE_MIN_SAMPLES;
    return {
      partition,
      median_seconds: enough ? nearestRankPercentile(sorted, 50) : null,
      p90_seconds: enough ? nearestRankPercentile(sorted, 90) : null,
      count: sorted.length,
      window_days: COMPUTE_QUEUE_WINDOW_DAYS,
    };
  });
}

/**
 * The waits of one partition's jobs that started in the window, newest start first, at most the cap:
 * `?1` the partition. A job with no scheduler submission time, no start, or whose start is before its
 * submission (a clock fault), is not a sample: both comparisons are NULL for a missing time, which also
 * lets the planner use the partial index of migration 0132 (its two `IS NOT NULL` terms are implied).
 */
export const QUEUE_WAITS_SQL = `SELECT
    CAST(strftime('%s', started_at) AS INTEGER)
      - CAST(strftime('%s', remote_submitted_at) AS INTEGER) AS wait_seconds
  FROM compute_jobs
  WHERE partition = ?1
    AND started_at >= datetime('now', '-${COMPUTE_QUEUE_WINDOW_DAYS} days')
    AND started_at >= remote_submitted_at
  ORDER BY started_at DESC
  LIMIT ${COMPUTE_QUEUE_SAMPLE_CAP}`;

/** How long one partition's estimate is reused, and how many partitions one database's cache holds. */
export const QUEUE_CACHE_MS = 30_000;
export const QUEUE_CACHE_MAX = 32;

/** The size the cache is held to; a test lowers it. */
export const queueCacheLimits = { max: QUEUE_CACHE_MAX };

/** The clock the cache reads; a test moves it, nothing else does. */
export const queueEstimateClock = { now: (): number => Date.now() };

type Estimate = ReturnType<typeof buildQueueEstimates>[number];

/**
 * Best-effort and per isolate, per database binding (one database's figures are never served for
 * another's): the platform's queue changes slowly and every call of `GET /compute/me` asks for every
 * offered partition, so an estimate is reused for 30 seconds from the time it was READ. A second isolate,
 * or a binding that is not the same object twice, only means one more read.
 */
const queueCaches = new WeakMap<object, Map<string, { at: number; estimate: Estimate }>>();

/**
 * The estimates of the named partitions, read from the job index (all partitions at once, each from the
 * cache while it is under 30 seconds old). A failed read throws; it is never zero.
 */
export async function computeQueueEstimates(
  db: D1Database,
  partitions: readonly string[],
): Promise<ComputeQueueEstimate[]> {
  let cache = queueCaches.get(db);
  if (!cache) {
    cache = new Map();
    queueCaches.set(db, cache);
  }
  const held = cache;
  const nowMs = queueEstimateClock.now();
  return Promise.all(
    partitions.map(async (partition) => {
      const hit = held.get(partition);
      if (hit && nowMs - hit.at < QUEUE_CACHE_MS) return hit.estimate;
      const waits = (
        await db.prepare(QUEUE_WAITS_SQL).bind(partition).all<{ wait_seconds: number }>()
      ).results;
      const [estimate] = buildQueueEstimates(
        waits.map((w) => ({ partition, waitSeconds: w.wait_seconds })),
        [partition],
      );
      held.delete(partition);
      held.set(partition, { at: nowMs, estimate: estimate as Estimate });
      while (held.size > queueCacheLimits.max) {
        const oldest = held.keys().next().value;
        if (oldest === undefined) break;
        held.delete(oldest);
      }
      return estimate as Estimate;
    }),
  );
}
