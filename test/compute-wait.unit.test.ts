/**
 * `--wait` (epic #2021 phase D3b, #2024; `src/lib/compute/wait.ts`): the poll loop with an injected sleep and
 * clock, so nothing here waits. The reads are a script of answers (the loop is what is under test); the
 * REAL poll against the real routes, and a real SIGINT sent to the real process, are in
 * `compute-user-e2e-cli.test.ts` and `compute-submit-cli.test.ts`.
 *
 * Pinned: each terminal state ends the wait; the interval starts at 5 s, grows by half to 30 s and starts
 * over on a change; five consecutive 5xx (or network failures) end it as `unavailable`, a good read resets
 * the count; a 4xx ends it at once as `refused`; SIGINT and an outside abort DETACH, remove the listener, and
 * cut a sleep short; and nothing in the module can cancel a job.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ComputeUserJob } from "../shared/contract/compute-user";
import { ApiError } from "../src/lib/api/errors";
import {
  CONSECUTIVE_FAILURE_LIMIT,
  MAX_INTERVAL_MS,
  MIN_INTERVAL_MS,
  type WaitOptions,
  waitForJob,
} from "../src/lib/compute/wait";

const job = (state: string): ComputeUserJob =>
  ({
    id: "job_0123456789abcdef01234567",
    kind: "batch",
    source: "cli",
    state,
    app_id: "x",
    app_version: "1",
    partition: "shared",
    pool: "cpu",
    resources: { nodes: 1, cores_per_node: 1, memory_mb: null, gpus: 0, minutes: 60 },
    created_at: "2026-11-07 00:00:00",
    started_at: null,
    ended_at: null,
    charged_milli: 0,
    failure_code: null,
    cancel_requested: false,
  }) as ComputeUserJob;

type Step = string | { stale: string } | Error;

/** A reader that plays `steps` in order; the last step repeats. */
function script(steps: Step[]) {
  let at = 0;
  const calls: number[] = [];
  return {
    calls,
    fetchJob: async () => {
      calls.push(at);
      const step = steps[Math.min(at++, steps.length - 1)] as Step;
      if (step instanceof Error) throw step;
      if (typeof step === "string") return { job: job(step) };
      return { job: job(step.stale), stale: true };
    },
  };
}

function harness(steps: Step[], over: Partial<WaitOptions> = {}) {
  const sleeps: number[] = [];
  const seen: string[] = [];
  let clock = 1_000;
  const reader = script(steps);
  const options: WaitOptions = {
    fetchJob: reader.fetchJob,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    now: () => clock,
    onState: (j, stale) => seen.push(stale ? `${j.state}(stale)` : j.state),
    listenForSigint: false,
    ...over,
  };
  return { options, sleeps, seen, reader };
}

describe("the terminal states end the wait", () => {
  for (const state of ["finished", "failed", "cancelled"]) {
    test(state, async () => {
      const h = harness(["uploading", "submitted", "queued", "running", state]);
      const outcome = await waitForJob(h.options);
      expect(outcome).toMatchObject({ kind: "terminal", job: { state }, stale: false });
      expect(h.seen).toEqual(["uploading", "submitted", "queued", "running", state]);
    });
  }

  test("unreported is not an end: the wait goes on", async () => {
    const h = harness(["running", "unreported", "unreported", "finished"]);
    const outcome = await waitForJob(h.options);
    expect(outcome.kind).toBe("terminal");
    expect(h.seen).toEqual(["running", "unreported", "finished"]);
  });

  test("a job already over is read once and no sleep happens", async () => {
    const h = harness(["finished"]);
    expect((await waitForJob(h.options)).kind).toBe("terminal");
    expect(h.sleeps).toEqual([]);
    expect(h.reader.calls).toEqual([0]);
  });

  test("a stale read is reported as a change, and the end says whether it was stale", async () => {
    const h = harness(["running", { stale: "running" }, "running", { stale: "finished" }]);
    const outcome = await waitForJob(h.options);
    expect(h.seen).toEqual(["running", "running(stale)", "running", "finished(stale)"]);
    expect(outcome).toMatchObject({ kind: "terminal", stale: true });
  });
});

describe("the interval", () => {
  test("starts at the minimum, grows by half while nothing changes, stops at the maximum", async () => {
    const h = harness(Array.from({ length: 12 }, () => "queued").concat("finished"));
    await waitForJob(h.options);
    expect(h.sleeps.slice(0, 5)).toEqual([5000, 7500, 11250, 16875, 25313]);
    expect(h.sleeps.slice(5)).toEqual(Array(h.sleeps.length - 5).fill(MAX_INTERVAL_MS));
    expect(MIN_INTERVAL_MS).toBe(5000);
  });

  test("a change of state starts it over", async () => {
    const h = harness(["queued", "queued", "queued", "running", "running", "finished"]);
    await waitForJob(h.options);
    // queued (first read, change): 5000; same: 7500, 11250; running (change): 5000; same: 7500
    expect(h.sleeps).toEqual([5000, 7500, 11250, 5000, 7500]);
  });

  test("the time waited is on the injected clock", async () => {
    const h = harness(["queued", "finished"]);
    const outcome = await waitForJob(h.options);
    expect(outcome.waitedMs).toBe(5000);
  });
});

describe("a read that fails", () => {
  const e503 = () => new ApiError(503, "unavailable");
  const net = () => new ApiError(0, "Network error: Could not connect");

  test("five in a row end the wait as unavailable, with the last known job", async () => {
    const h = harness(["running", e503(), e503(), e503(), e503(), e503()]);
    const outcome = await waitForJob(h.options);
    expect(outcome).toMatchObject({
      kind: "unavailable",
      detail: "HTTP 503",
      job: { state: "running" },
    });
    expect(CONSECUTIVE_FAILURE_LIMIT).toBe(5);
    // one read, then five failures: the wait slept after the first read and after the first four failures
    expect(h.reader.calls).toHaveLength(6);
    expect(h.sleeps).toHaveLength(5);
  });

  test("four in a row, then a good read, do not end it, and the count starts over", async () => {
    const h = harness([
      e503(),
      e503(),
      e503(),
      e503(),
      "running",
      e503(),
      e503(),
      e503(),
      e503(),
      "finished",
    ]);
    const retries: number[] = [];
    const outcome = await waitForJob({ ...h.options, onRetry: (_d, n) => retries.push(n) });
    expect(outcome.kind).toBe("terminal");
    expect(retries).toEqual([1, 2, 3, 4, 1, 2, 3, 4]);
  });

  test("network failures count as the same kind of failure", async () => {
    const h = harness([net(), net(), net(), net(), net()]);
    const outcome = await waitForJob(h.options);
    expect(outcome).toMatchObject({ kind: "unavailable", job: null });
  });

  test("a failed read backs off like an unchanged one", async () => {
    const h = harness([e503(), e503(), e503(), "finished"]);
    await waitForJob(h.options);
    expect(h.sleeps).toEqual([7500, 11250, 16875]);
  });

  test("a 4xx ends it at once as refused, with the error", async () => {
    for (const status of [400, 401, 403, 404]) {
      const h = harness(["running", new ApiError(status, "no")]);
      const outcome = await waitForJob(h.options);
      expect(outcome).toMatchObject({ kind: "refused", job: { state: "running" } });
      if (outcome.kind === "refused") expect(outcome.error.statusCode).toBe(status);
      expect(h.reader.calls).toHaveLength(2);
    }
  });

  test("an error that is not an ApiError is treated as a failed read, not a crash", async () => {
    const h = harness([new TypeError("boom"), "finished"]);
    expect((await waitForJob(h.options)).kind).toBe("terminal");
  });
});

describe("detaching leaves the job running", () => {
  test("SIGINT during a sleep detaches, removes its listener, and reads nothing more", async () => {
    const before = process.listenerCount("SIGINT");
    let sleeping: () => void = () => {};
    const entered = new Promise<void>((r) => {
      sleeping = r;
    });
    const h = harness(["running"], {
      listenForSigint: true,
      // a real abortable sleep, but the test is told when it starts
      sleep: (_ms, signal) =>
        new Promise((resolve) => {
          sleeping();
          signal.addEventListener("abort", () => resolve(), { once: true });
        }),
    });
    const waiting = waitForJob(h.options);
    await entered;
    expect(process.listenerCount("SIGINT")).toBe(before + 1);
    process.emit("SIGINT");
    const outcome = await waiting;
    expect(outcome).toMatchObject({ kind: "detached", job: { state: "running" } });
    expect(process.listenerCount("SIGINT")).toBe(before);
    expect(h.reader.calls).toEqual([0]);
  });

  test("an outside abort in flight during a read also detaches", async () => {
    const outside = new AbortController();
    const h = harness(["queued"], {
      signal: outside.signal,
      fetchJob: (signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new ApiError(0, "aborted")), {
            once: true,
          });
          outside.abort();
        }),
    });
    expect(await waitForJob(h.options)).toMatchObject({ kind: "detached", job: null });
  });

  test("an abort that came before the wait began detaches without reading", async () => {
    const outside = new AbortController();
    outside.abort();
    const h = harness(["running"], { signal: outside.signal });
    expect(await waitForJob(h.options)).toMatchObject({ kind: "detached" });
    expect(h.reader.calls).toEqual([]);
  });

  test("the listener is removed on every way out", async () => {
    const before = process.listenerCount("SIGINT");
    for (const steps of [["finished"], [new ApiError(404, "no")], ["running"]] as Step[][]) {
      const h = harness(steps, { listenForSigint: true });
      if (steps[0] === "running") {
        h.options.sleep = async () => {
          process.emit("SIGINT");
        };
      }
      await waitForJob(h.options);
      expect(process.listenerCount("SIGINT")).toBe(before);
    }
  });

  test("the module has nothing that can cancel a job", () => {
    const source = readFileSync(
      join(import.meta.dir, "..", "src", "lib", "compute", "wait.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/cancel[A-Z]|\/cancel|api\/compute/);
  });
});
