/**
 * The rules of `nemar admin dataset publish screen-batch` that need no terminal and no server
 * (ADR 0086, amendment of 2026-11-25): the pace, the ids file, and the dispatch loop.
 * The loop's two dependencies are its I/O (what a dispatch answers, how long to wait), which is
 * where a unit test must stand; what it decides (when to wait, when to stop, what to count) is
 * the production code.
 *
 * CI TIER: unit-pure.
 */

import { describe, expect, test } from "bun:test";
import { ApiError } from "../src/lib/api/errors";
import {
  type BatchRunDeps,
  type DispatchResult,
  UNREACHABLE_AFTER,
  dispatchFailure,
  paceGapMs,
  parseIdsFile,
  parsePerMinute,
  runBatch,
} from "../src/lib/screen-batch";

describe("the pace", () => {
  test("the default is 4 a minute and the gap is the minute divided by the rate, rounded up", () => {
    expect(parsePerMinute(undefined)).toBe(4);
    expect(paceGapMs(4)).toBe(15_000);
    expect(paceGapMs(10)).toBe(6_000);
    expect(paceGapMs(1)).toBe(60_000);
    expect(paceGapMs(7)).toBe(8_572);
  });

  test("a rate above 10, below 1 or not a whole number is refused with a sentence", () => {
    expect(parsePerMinute("10")).toBe(10);
    expect(parsePerMinute("1")).toBe(1);
    for (const bad of ["11", "0", "-3", "2.5", "fast", "", "1e1", "4 "]) {
      const got = parsePerMinute(bad);
      if (bad === "4 ") expect(got).toBe(4);
      else expect(typeof got === "object" && "problem" in got).toBe(true);
    }
  });
});

describe("the ids file", () => {
  test("one id per line, commas and spaces too, comments dropped, repeats dropped", () => {
    const parsed = parseIdsFile(
      [
        "nm000101",
        "nm000102, on000103  xx000104 # a comment nm000999",
        "# whole line",
        "",
        "nm000101",
      ].join("\n"),
    );
    expect(parsed).toEqual({ ids: ["nm000101", "nm000102", "on000103", "xx000104"], invalid: [] });
  });

  test("an entry that is not a dataset id is reported, not guessed at", () => {
    const parsed = parseIdsFile("nm000101\nnm1234\nNM000102\nnm000103x\r\nnm000104");
    expect(parsed.ids).toEqual(["nm000101", "nm000104"]);
    expect(parsed.invalid).toEqual(["nm1234", "NM000102", "nm000103x"]);
  });
});

function deps(script: DispatchResult[], opts: { stopAfter?: number } = {}) {
  const log: string[] = [];
  const waits: number[] = [];
  let stop = false;
  let n = 0;
  const d: BatchRunDeps = {
    dispatch: async (id) => {
      log.push(id);
      n++;
      if (opts.stopAfter !== undefined && n >= opts.stopAfter) stop = true;
      return script[Math.min(n - 1, script.length - 1)];
    },
    sleep: async (ms) => {
      waits.push(ms);
      return false;
    },
    stopped: () => stop,
    progress: () => {},
  };
  return { d, log, waits };
}

describe("the dispatch loop", () => {
  const ids = ["nm000101", "nm000102", "nm000103"];

  test("the first screen goes at once and each next one waits the gap", async () => {
    const { d, log, waits } = deps([{ kind: "dispatched" }]);
    const out = await runBatch(ids, 15_000, d);
    expect(log).toEqual(ids);
    expect(waits).toEqual([15_000, 15_000]);
    expect(out).toMatchObject({
      dispatched: 3,
      refused: 0,
      failed: 0,
      remaining: [],
      stoppedBecause: null,
    });
  });

  test("a refusal is reported and the run goes on; the Worker counted it", async () => {
    const { d, log } = deps([
      { kind: "dispatched" },
      { kind: "refused", message: "pending", closed: false },
      { kind: "dispatched" },
    ]);
    const out = await runBatch(ids, 1, d);
    expect(log).toEqual(ids);
    expect(out).toMatchObject({ dispatched: 2, refused: 1, stoppedBecause: null });
  });

  test("stopping dispatches no more and names the ones not reached", async () => {
    const { d, log } = deps([{ kind: "dispatched" }], { stopAfter: 1 });
    const out = await runBatch(ids, 1, d);
    expect(log).toEqual(["nm000101"]);
    expect(out).toMatchObject({
      dispatched: 1,
      remaining: ["nm000102", "nm000103"],
      stoppedBecause: "interrupted",
    });
  });

  test("a stop that lands during the wait ends the run before the next dispatch", async () => {
    const log: string[] = [];
    const out = await runBatch(ids, 1, {
      dispatch: async (id) => {
        log.push(id);
        return { kind: "dispatched" };
      },
      sleep: async () => true,
      stopped: () => false,
      progress: () => {},
    });
    expect(log).toEqual(["nm000101"]);
    expect(out.remaining).toEqual(["nm000102", "nm000103"]);
    expect(out.stoppedBecause).toBe("interrupted");
  });

  test("a finished batch ends the run", async () => {
    const { d, log } = deps([{ kind: "refused", message: "closed", closed: true }]);
    const out = await runBatch(ids, 1, d);
    expect(log).toEqual(["nm000101"]);
    expect(out).toMatchObject({
      refused: 1,
      remaining: ["nm000102", "nm000103"],
      stoppedBecause: "batch-closed",
    });
  });

  test("answers that never come end the run after the limit, not before", async () => {
    const many = Array.from({ length: UNREACHABLE_AFTER + 3 }, (_, i) => `nm00020${i}`);
    const { d, log } = deps([{ kind: "failed", message: "no route" }]);
    const out = await runBatch(many, 1, d);
    expect(log).toHaveLength(UNREACHABLE_AFTER);
    expect(out.stoppedBecause).toBe("unreachable");
    expect(out.failed).toBe(UNREACHABLE_AFTER);

    // An answer in between starts the count again.
    const mixed = deps([
      { kind: "failed", message: "x" },
      { kind: "failed", message: "x" },
      { kind: "dispatched" },
      { kind: "failed", message: "x" },
      { kind: "failed", message: "x" },
      { kind: "dispatched" },
    ]);
    const six = Array.from({ length: 6 }, (_, i) => `nm00030${i}`);
    expect((await runBatch(six, 1, mixed.d)).stoppedBecause).toBeNull();
  });
});

describe("what a thrown error means", () => {
  const plain = (s: string) => s;
  test("a 4xx is the Worker's refusal; a network failure or a 5xx is no answer", () => {
    expect(dispatchFailure(new ApiError(409, "a screen is running"), plain)).toEqual({
      kind: "refused",
      message: "a screen is running",
      closed: false,
    });
    const closed = new ApiError(409, "finished");
    closed.code = "screen_batch_closed";
    expect(dispatchFailure(closed, plain)).toMatchObject({ kind: "refused", closed: true });
    expect(dispatchFailure(new ApiError(0, "connection refused"), plain).kind).toBe("failed");
    expect(dispatchFailure(new ApiError(502, "bad gateway"), plain).kind).toBe("failed");
    expect(dispatchFailure(new Error("boom"), plain).kind).toBe("failed");
  });
});
