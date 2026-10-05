/**
 * A stage that stops on purpose prints exactly one line to stderr, `s3-scrub: <fixed word>`.
 * Matching the whole line, not a substring, matters: several words contain another
 * (`verified-stale` is inside `new-hash-verified-stale`), so a substring check lets a stage that
 * skipped one guard pass because the next guard stopped it with a longer word.
 */

import { expect } from "bun:test";
import type { RunResult } from "./support";

export function expectStopped(r: RunResult, exitCode: number, word: string, label = word): void {
  expect(r.exitCode, `${label}: ${r.all}`).toBe(exitCode);
  expect(r.stderr.trim(), label).toBe(`s3-scrub: ${word}`);
}

/** A usage stop (exit 2) prints the same one line first, then the usage text. */
export function expectUsage(r: RunResult, word: string, label = word): void {
  expect(r.exitCode, `${label}: ${r.all}`).toBe(2);
  expect(r.stderr.split("\n")[0], label).toBe(`s3-scrub: ${word}`);
}
