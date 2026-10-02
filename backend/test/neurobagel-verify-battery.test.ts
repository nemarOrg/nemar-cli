/**
 * The verification mutation battery's own soundness (epic #1586, phase 6).
 *
 * The battery (`scripts/neurobagel/verification-mutation-battery.ts`) edits one line of the
 * sweep at a time and runs its tests; the way it reads a test log is the writer battery's, whose
 * own test (`neurobagel-battery.test.ts`) covers it. What can silently go wrong here is a
 * refactor that moves a line, which would turn a mutant into a no-op that "survives" nothing and
 * proves nothing. So every anchor must still match the source it edits exactly as often as it
 * declares, and must change it, and every test file a mutant names must exist.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ALL_TESTS, MUTANTS, mutate } from "../../scripts/neurobagel/verification-mutation-battery";

const ROOT = join(import.meta.dir, "../..");

describe("the verification mutants", () => {
  test("every anchor still matches exactly the source it edits, and changes it", () => {
    for (const m of MUTANTS) {
      const source = readFileSync(join(ROOT, m.file), "utf8");
      expect(mutate(source, m), m.id).not.toBe(source);
    }
  });

  test("ids are unique, every mutant says what mistake it makes, and every test it runs exists", () => {
    const ids = MUTANTS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const m of MUTANTS) {
      expect(m.note.length, m.id).toBeGreaterThan(20);
      for (const t of m.tests ?? []) expect(existsSync(join(ROOT, t)), `${m.id}: ${t}`).toBe(true);
    }
    for (const t of ALL_TESTS) expect(existsSync(join(ROOT, t)), t).toBe(true);
  });

  test("a mutant believed equivalent says why, in a sentence", () => {
    for (const m of MUTANTS.filter((x) => x.equivalent)) {
      expect(m.equivalent?.length, m.id).toBeGreaterThan(40);
    }
  });

  test("an anchor that no longer applies is an error, never a pass", () => {
    expect(() => mutate("nothing like it", MUTANTS[0] as (typeof MUTANTS)[number])).toThrow(
      /the mutant no longer applies/,
    );
  });

  test("the battery reaches every layer of the feature it claims to", () => {
    expect(new Set(MUTANTS.map((m) => m.layer))).toEqual(
      new Set(["verify", "drift", "run", "anonymity", "weekly", "cli", "contract"]),
    );
    expect(MUTANTS.length).toBeGreaterThanOrEqual(30);
  });
});
