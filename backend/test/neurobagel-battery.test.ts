/**
 * The mutation battery's own soundness (epic #1586, phase 4).
 *
 * The battery (`scripts/neurobagel/writer-mutation-battery.ts`) edits one line of the feature
 * at a time and runs its tests. Two things make its report worth reading, and both are checked
 * here without running it: every mutant's anchor still matches the source it edits (a refactor
 * that moves a line must not turn a mutant into a silent no-op), and a mutant counts as KILLED
 * only when a test fails on an assertion, never because the run exited non-zero for another
 * reason (a suite that did not load, a server that refused a connection).
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MUTANTS, mutate, readTestLog } from "../../scripts/neurobagel/writer-mutation-battery";

const ROOT = join(import.meta.dir, "../..");

describe("the mutants", () => {
  test("every anchor still matches exactly the source it edits, and changes it", () => {
    for (const m of MUTANTS) {
      const source = readFileSync(join(ROOT, m.file), "utf8");
      const mutated = mutate(source, m);
      expect(mutated, m.id).not.toBe(source);
    }
  });

  test("ids are unique, every mutant names a note, and every test file it runs exists", () => {
    const ids = MUTANTS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const m of MUTANTS) {
      expect(m.note.length, m.id).toBeGreaterThan(10);
      for (const t of m.tests ?? []) expect(existsSync(join(ROOT, t)), `${m.id}: ${t}`).toBe(true);
    }
  });

  test("a mutant believed equivalent says why, in a sentence", () => {
    for (const m of MUTANTS.filter((x) => x.equivalent)) {
      expect(m.equivalent?.length, m.id).toBeGreaterThan(40);
    }
  });

  test("an anchor that no longer applies is an error, never a pass", () => {
    const m = MUTANTS[0];
    expect(() => mutate("nothing like it", m as (typeof MUTANTS)[number])).toThrow(
      /the mutant no longer applies/,
    );
  });
});

describe("reading a test log: a kill needs a failing assertion", () => {
  test("a failing test whose error is an assertion is asserted", () => {
    const log = [
      "error: expect(received).toEqual(expected)",
      "",
      "✗ the writer > a thing [3.1ms]",
      "✓ the writer > another [1ms]",
    ].join("\n");
    const run = readTestLog(log, 1);
    expect(run.passed).toBe(false);
    expect(run.failures.map((f) => f.name)).toEqual(["the writer > a thing"]);
    expect(run.asserted.map((f) => f.name)).toEqual(["the writer > a thing"]);
  });

  test("the `(fail)` form of the status line is read too", () => {
    const run = readTestLog("error: boom\n(fail) a suite > a test [2ms]\n(pass) other [1ms]", 1);
    expect(run.asserted).toHaveLength(1);
  });

  test("a test that failed because a test server refused a connection is infrastructure, not a kill", () => {
    const log = [
      "error: ConnectionRefused: Unable to connect. Is the computer able to access the url?",
      "✗ the cli > a thing [9ms]",
    ].join("\n");
    const run = readTestLog(log, 1);
    expect(run.failures).toHaveLength(1);
    expect(run.failures[0]?.infra).toBe(true);
    expect(run.asserted).toEqual([]);
  });

  test("an error printed before an EARLIER test is not blamed on a later one", () => {
    const log = [
      "error: ConnectionRefused",
      "✗ first [1ms]",
      "error: expect(received).toBe(expected)",
      "✗ second [1ms]",
    ].join("\n");
    const run = readTestLog(log, 1);
    expect(run.failures.map((f) => f.infra)).toEqual([true, false]);
    expect(run.asserted.map((f) => f.name)).toEqual(["second"]);
  });

  test("a non-zero exit with no failing test at all (a suite that did not load) has nothing asserted", () => {
    const run = readTestLog("error: Cannot find module './nope'\n 0 pass\n 1 fail\n", 1);
    expect(run.passed).toBe(false);
    expect(run.failures).toEqual([]);
    expect(run.asserted).toEqual([]);
  });

  test("a clean run passes", () => {
    const run = readTestLog("✓ a [1ms]\n✓ b [1ms]\n 2 pass\n 0 fail\n", 0);
    expect(run.passed).toBe(true);
    expect(run.failures).toEqual([]);
  });
});
