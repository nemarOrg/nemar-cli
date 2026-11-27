/**
 * The rules of `nemar admin dataset publish screen-batch` that do not need a terminal: how a selection
 * is read, how fast screens are dispatched, and the loop that dispatches them (ADR 0086, amendment
 * of 2026-11-25). The command (`commands/admin-publish-screen-batch.ts`) is the terminal around it.
 *
 * Each screen is one GitHub Actions run in the central workflow repository, so the CLI paces the
 * dispatches itself: {@link paceGapMs} between one dispatch and the next, never faster than
 * {@link SCREEN_BATCH_MAX_PER_MINUTE} a minute. The Worker sends no per-request mail for a screen of
 * a batch and one digest when the batch ends, so nothing here mails anyone.
 */

import {
  PUBLICATION_DATASET_ID_RE,
  SCREEN_BATCH_DEFAULT_PER_MINUTE,
  SCREEN_BATCH_MAX_PER_MINUTE,
  SCREEN_BATCH_MAX_SIZE,
} from "../../shared/publication-limits.js";
import { ApiError } from "./api/errors.js";

export { SCREEN_BATCH_DEFAULT_PER_MINUTE, SCREEN_BATCH_MAX_PER_MINUTE, SCREEN_BATCH_MAX_SIZE };

/** The pause between two dispatches at `perMinute` screens a minute. */
export function paceGapMs(perMinute: number): number {
  return Math.ceil(60_000 / perMinute);
}

/**
 * `--per-minute` as typed: a whole number from 1 to {@link SCREEN_BATCH_MAX_PER_MINUTE}. Returns
 * the number, or a sentence saying what is wrong.
 */
export function parsePerMinute(raw: string | undefined): number | { problem: string } {
  if (raw === undefined) return SCREEN_BATCH_DEFAULT_PER_MINUTE;
  if (!/^\d+$/.test(raw.trim())) {
    return {
      problem: `--per-minute takes a whole number from 1 to ${SCREEN_BATCH_MAX_PER_MINUTE}.`,
    };
  }
  const n = Number(raw.trim());
  if (n < 1 || n > SCREEN_BATCH_MAX_PER_MINUTE) {
    return {
      problem: `--per-minute is at most ${SCREEN_BATCH_MAX_PER_MINUTE} (each screen is a GitHub Actions run) and at least 1; got ${n}.`,
    };
  }
  return n;
}

/**
 * The dataset ids of an `--ids` file: one per line, or separated by commas or spaces, `#` starts a
 * comment. Repeats are dropped. `invalid` are the tokens that are not dataset ids; none of them is
 * echoed back as a command would run it.
 */
export function parseIdsFile(text: string): { ids: string[]; invalid: string[] } {
  const ids: string[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const content = line.replace(/#.*$/, "");
    for (const token of content.split(/[\s,]+/).filter(Boolean)) {
      if (!PUBLICATION_DATASET_ID_RE.test(token)) {
        invalid.push(token);
      } else if (!seen.has(token)) {
        seen.add(token);
        ids.push(token);
      }
    }
  }
  return { ids, invalid };
}

/** What a dispatch of one screen came to. */
export type DispatchResult =
  | { kind: "dispatched" }
  | { kind: "refused"; message: string; closed: boolean }
  | { kind: "failed"; message: string };

export interface BatchRunDeps {
  /** Dispatch one screen of the batch. Throws what the API client throws. */
  dispatch: (datasetId: string) => Promise<DispatchResult>;
  /** Wait; resolves early (true) when the run was told to stop. */
  sleep: (ms: number) => Promise<boolean>;
  /** Whether the administrator asked to stop. */
  stopped: () => boolean;
  /** One line of progress per request. */
  progress: (line: string) => void;
}

export interface BatchRunOutcome {
  dispatched: number;
  /** Refused by the Worker (a recent screen, a changed request, no request): it settled them. */
  refused: number;
  /** Dispatches whose answer never came; the Worker may or may not have started them. */
  failed: number;
  /** Dataset ids never reached because the run stopped. */
  remaining: string[];
  /** Why the loop ended early, when it did. */
  stoppedBecause: "interrupted" | "batch-closed" | "unreachable" | null;
}

/** Consecutive failed dispatches after which the run gives up on reaching NEMAR. */
export const UNREACHABLE_AFTER = 3;

/**
 * Dispatch `ids` one at a time, `gapMs` apart: the first at once, then a pause before each next.
 * A refusal by the Worker is reported and the run goes on (the Worker counted it toward the
 * digest); the run ends early when the administrator stops it, when the batch has been closed by
 * its digest, or after {@link UNREACHABLE_AFTER} dispatches in a row that got no answer.
 */
export async function runBatch(
  ids: readonly string[],
  gapMs: number,
  deps: BatchRunDeps,
): Promise<BatchRunOutcome> {
  const out: BatchRunOutcome = {
    dispatched: 0,
    refused: 0,
    failed: 0,
    remaining: [],
    stoppedBecause: null,
  };
  let inARow = 0;
  for (let i = 0; i < ids.length; i++) {
    if (deps.stopped()) {
      out.stoppedBecause = "interrupted";
      out.remaining = ids.slice(i);
      return out;
    }
    if (i > 0 && (await deps.sleep(gapMs))) {
      out.stoppedBecause = "interrupted";
      out.remaining = ids.slice(i);
      return out;
    }
    const id = ids[i];
    const position = `[${i + 1}/${ids.length}] ${id}`;
    const result = await deps.dispatch(id);
    if (result.kind === "dispatched") {
      out.dispatched++;
      inARow = 0;
      deps.progress(`${position} screen dispatched`);
    } else if (result.kind === "refused") {
      out.refused++;
      inARow = 0;
      deps.progress(`${position} not dispatched: ${result.message}`);
      if (result.closed) {
        out.stoppedBecause = "batch-closed";
        out.remaining = ids.slice(i + 1);
        return out;
      }
    } else {
      out.failed++;
      inARow++;
      deps.progress(`${position} no answer: ${result.message}`);
      if (inARow >= UNREACHABLE_AFTER) {
        out.stoppedBecause = "unreachable";
        out.remaining = ids.slice(i + 1);
        return out;
      }
    }
  }
  return out;
}

/**
 * Sort a thrown error into what {@link runBatch} reports. The Worker's own answer (an `ApiError`
 * with a 4xx status) is a refusal; a network failure (status 0) or a 5xx is no answer.
 */
export function dispatchFailure(error: unknown, plain: (s: string) => string): DispatchResult {
  if (error instanceof ApiError && error.statusCode >= 400 && error.statusCode < 500) {
    return {
      kind: "refused",
      message: plain(error.message),
      closed: error.code === "screen_batch_closed" || error.code === "screen_batch_not_found",
    };
  }
  const message = error instanceof Error ? plain(error.message) : "unknown error";
  return { kind: "failed", message };
}
