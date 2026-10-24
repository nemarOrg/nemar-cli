/**
 * Pace a bulk start of dataset pull request reviews (ADR 0093, amendment of 2026-10-24).
 *
 * Every review reserves its output budget against the workspace's output-tokens-per-minute limit
 * the moment its request begins (ADR 0107, Consequences), so starting a hundred at once asks for a
 * hundred budgets at once. `runPaced` keeps at most `concurrency` of the reviews THIS run started
 * in progress: it starts the next one as each leaves `in_progress`. That is a sliding window, not
 * fixed batches: a batch would wait for its slowest review (one that truncates runs half an hour)
 * while the other slots sat idle.
 *
 * The scheduling is separate from the command so it can be tested on its own: the command passes
 * the real start and the real queue read, and the tests pass functions that simulate a pool of jobs.
 * Only reviews this run started count. Reviews that other people's pushes started are running too,
 * but counting them would let a busy hour stall the run for something it did not cause.
 */

/** The shape of a queue entry or a start target: a pull request of a dataset. */
export interface PaceEntry {
  dataset_id: string;
  pr_number: number;
}

/** The key a pull request has in the set of reviews in progress. */
export function paceKey(e: PaceEntry): string {
  return `${e.dataset_id}#${e.pr_number}`;
}

export interface PaceDeps<E extends PaceEntry, R> {
  /** Start one review. Throws when the start itself failed. */
  start(entry: E): Promise<R>;
  /** Whether the answer put a review in progress. A start that was declined takes no slot. */
  isRunning(answer: R): boolean;
  /** The reviews in progress now, or null when that cannot be told (an incomplete list, an error). */
  inProgress(): Promise<ReadonlySet<string> | null>;
  /** Wait `ms`, or until the signal aborts. */
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  /** Called with each outcome as it happens, so the command can print it. */
  onResult(entry: E, outcome: { answer: R } | { error: unknown }): void;
  /** Called before each wait for a slot, with the numbers to show. */
  onWait?(info: { running: number; remaining: number }): void;
  /** After an answer: true ends the run there (the older-Worker check of `--redo`). */
  stopAfter?(answer: R): boolean;
}

export interface PaceOptions {
  /** At most this many reviews started by this run in progress at once. `Infinity` never waits. */
  concurrency: number;
  /** Milliseconds between two reads of the queue while waiting for a slot. */
  pollMs: number;
  /** How many reads in a row may fail to tell before the run stops. */
  maxUnknownPolls: number;
  /** Aborted by Ctrl-C: the run stops after the start in flight. */
  signal: AbortSignal;
}

export type PaceStop = "interrupted" | "unknown_polls" | "answer";

export interface PaceOutcome<E extends PaceEntry, R> {
  results: Array<{ entry: E; answer: R } | { entry: E; error: unknown }>;
  /** Entries the run never tried, in order. */
  notStarted: E[];
  /** Why the run ended before the list was done; null when it was done. */
  stoppedBy: PaceStop | null;
}

/**
 * Start `todo` in order, never more than `options.concurrency` in progress from this run.
 *
 * A read of the queue that cannot tell (null, or a throw) is not "finished": the review might still
 * be running, so the window stays full. After `maxUnknownPolls` of them in a row the run stops,
 * because it cannot keep its limit blind. A review that never reports leaves `in_progress` when the
 * Worker calls it overdue, so no wait is unbounded.
 */
export async function runPaced<E extends PaceEntry, R>(
  todo: readonly E[],
  deps: PaceDeps<E, R>,
  options: PaceOptions,
): Promise<PaceOutcome<E, R>> {
  const results: PaceOutcome<E, R>["results"] = [];
  const mine = new Set<string>();
  let next = 0;
  let unknown = 0;
  let stoppedBy: PaceStop | null = null;

  while (next < todo.length) {
    if (options.signal.aborted) {
      stoppedBy = "interrupted";
      break;
    }
    if (mine.size >= options.concurrency) {
      deps.onWait?.({ running: mine.size, remaining: todo.length - next });
      // A review started a moment ago is certainly still in progress, so wait before asking.
      await deps.sleep(options.pollMs, options.signal);
      if (options.signal.aborted) continue;
      const running = await deps.inProgress().catch(() => null);
      if (running === null) {
        unknown++;
        if (unknown >= options.maxUnknownPolls) {
          stoppedBy = "unknown_polls";
          break;
        }
        continue;
      }
      unknown = 0;
      for (const key of [...mine]) if (!running.has(key)) mine.delete(key);
      continue;
    }
    const entry = todo[next++] as E;
    try {
      const answer = await deps.start(entry);
      results.push({ entry, answer });
      deps.onResult(entry, { answer });
      if (deps.isRunning(answer)) mine.add(paceKey(entry));
      if (deps.stopAfter?.(answer)) {
        stoppedBy = "answer";
        break;
      }
    } catch (error) {
      results.push({ entry, error });
      deps.onResult(entry, { error });
    }
  }
  return { results, notStarted: todo.slice(next), stoppedBy };
}

/** A sleep that ends at once when the signal aborts. */
export function sleepUnlessAborted(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * The value of `--concurrency`: a whole number of at least 1, written as digits. Null for anything
 * else (zero, a sign, a fraction, an exponent, a word), so the command refuses it before the API is
 * asked.
 */
export function parseConcurrency(raw: string): number | null {
  if (!/^[1-9][0-9]{0,5}$/.test(raw.trim())) return null;
  return Number(raw.trim());
}
