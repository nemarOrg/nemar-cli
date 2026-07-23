/**
 * Unit tests for runReauditLoop -- the pure convergence loop driving
 * `nemar admin data-integrity-sweep --reaudit` (#980 review fix).
 *
 * Guards two properties nothing else tested before this file existed, and a
 * future edit to the loop could silently break:
 *  1. `getBefore()` is invoked exactly once; the SAME value is threaded into
 *     every `fetchBatch` call across a multi-batch run. A regression that
 *     re-derives `before` inside the loop (the exact "moving cutoff never
 *     converges" bug #980 fixed for `--older-than`) would show up here as
 *     differing values received across calls, not just as a slow production
 *     incident.
 *  2. The loop terminates the instant `remaining` reaches 0, and separately
 *     stops (marking `stalled`) when `remaining` fails to strictly decrease,
 *     rather than looping forever.
 *
 * No mocks (per project policy): `fetchBatch`/`getBefore`/the hooks are
 * plain dependency-injected functions, mirroring pollCiValidation's test
 * style (test/poll-ci-validation.test.ts) -- no network, no real sweep call.
 */

import { describe, expect, test } from "bun:test";
import "./setup";
import { type ReauditBatchResult, runReauditLoop } from "../src/commands/admin";

function batch(overrides: Partial<ReauditBatchResult> = {}): ReauditBatchResult {
  return {
    processed: 0,
    complete: 0,
    incomplete: 0,
    unknown: 0,
    errors: [],
    remaining: 0,
    ...overrides,
  };
}

/** Build a fetchBatch that returns queued results in order, one per call. */
function queuedFetch(results: ReauditBatchResult[]): {
  fetchBatch: (before: string | undefined) => Promise<ReauditBatchResult>;
  seenBefore: (string | undefined)[];
} {
  const seenBefore: (string | undefined)[] = [];
  const queue = [...results];
  return {
    seenBefore,
    fetchBatch: async (before) => {
      seenBefore.push(before);
      const next = queue.shift();
      if (!next) throw new Error("queue exhausted -- loop called fetchBatch more than expected");
      return next;
    },
  };
}

describe("runReauditLoop", () => {
  test("passes the SAME before value to every fetchBatch call across multiple batches", async () => {
    let getBeforeCalls = 0;
    const getBefore = () => {
      getBeforeCalls++;
      return `anchor-${getBeforeCalls}`; // would differ across calls if invoked more than once
    };
    const { fetchBatch, seenBefore } = queuedFetch([
      batch({ processed: 10, remaining: 20 }),
      batch({ processed: 10, remaining: 10 }),
      batch({ processed: 10, remaining: 0 }),
    ]);

    const result = await runReauditLoop(getBefore, fetchBatch);

    expect(getBeforeCalls).toBe(1); // captured exactly once
    expect(seenBefore).toEqual(["anchor-1", "anchor-1", "anchor-1"]); // same value every call
    expect(result.batches).toBe(3);
    expect(result.totals.processed).toBe(30);
    expect(result.remaining).toBe(0);
    expect(result.stalled).toBe(false);
  });

  test("without --reaudit, getBefore returning undefined stays undefined every call", async () => {
    const { fetchBatch, seenBefore } = queuedFetch([
      batch({ processed: 5, remaining: 5 }),
      batch({ processed: 5, remaining: 0 }),
    ]);
    await runReauditLoop(() => undefined, fetchBatch);
    expect(seenBefore).toEqual([undefined, undefined]);
  });

  test("terminates immediately when the first batch already reports remaining=0", async () => {
    let calls = 0;
    const fetchBatch = async () => {
      calls++;
      return batch({ processed: 5, remaining: 0 });
    };
    const result = await runReauditLoop(() => undefined, fetchBatch);
    expect(calls).toBe(1);
    expect(result.batches).toBe(1);
    expect(result.remaining).toBe(0);
    expect(result.stalled).toBe(false);
  });

  test("stops and marks stalled when remaining does not strictly decrease (regression guard)", async () => {
    const { fetchBatch } = queuedFetch([
      batch({ processed: 5, remaining: 10 }),
      batch({ processed: 5, remaining: 10 }), // stuck -- would loop forever without the guard
    ]);
    const result = await runReauditLoop(() => undefined, fetchBatch);
    expect(result.batches).toBe(2); // stopped after the stuck batch, not exhausted/looped forever
    expect(result.stalled).toBe(true);
    expect(result.remaining).toBe(10);
  });

  test("aggregates processed/complete/incomplete/unknown/errors across batches", async () => {
    const { fetchBatch } = queuedFetch([
      batch({
        processed: 2,
        complete: 1,
        incomplete: 1,
        unknown: 0,
        errors: [{ dataset_id: "on000001", error: "boom" }],
        remaining: 1,
      }),
      batch({ processed: 1, complete: 0, incomplete: 0, unknown: 1, errors: [], remaining: 0 }),
    ]);
    const result = await runReauditLoop(() => undefined, fetchBatch);
    expect(result.totals).toEqual({
      processed: 3,
      complete: 1,
      incomplete: 1,
      unknown: 1,
      errors: 1,
    });
  });

  test("onBatch hook receives each batch result and the running totals", async () => {
    const { fetchBatch } = queuedFetch([
      batch({ processed: 4, remaining: 2 }),
      batch({ processed: 4, remaining: 0 }),
    ]);
    const seen: { processed: number; runningTotal: number; batchNumber: number }[] = [];
    await runReauditLoop(() => undefined, fetchBatch, {
      onBatch: (res, totals, batchNumber) => {
        seen.push({ processed: res.processed, runningTotal: totals.processed, batchNumber });
      },
    });
    expect(seen).toEqual([
      { processed: 4, runningTotal: 4, batchNumber: 1 },
      { processed: 4, runningTotal: 8, batchNumber: 2 },
    ]);
  });

  test("sleepBetweenBatches runs between batches but not after the final one", async () => {
    const { fetchBatch } = queuedFetch([
      batch({ processed: 1, remaining: 1 }),
      batch({ processed: 1, remaining: 0 }),
    ]);
    let sleepCalls = 0;
    await runReauditLoop(() => undefined, fetchBatch, {
      sleepBetweenBatches: async () => {
        sleepCalls++;
      },
    });
    expect(sleepCalls).toBe(1); // only between the two batches, not after the last
  });
});
