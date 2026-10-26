/**
 * The automatic re-pull's fixed words (`shared/repull-state.ts`, epic #1046 phase 7, #1913; ADR
 * 0111, decision 6), checked against the code that produces them.
 *
 * A dispatch's `code` is a closed list: the callback refuses any other word, and the run reports
 * `no-code` for a refusal whose word the list does not hold. So the list must hold every word a
 * run can meet, or a refusal arrives as `no-code` and the weekly report cannot say why. This scans
 * the CLI's plan and execution code, the scrub's declared refusals and the Worker's re-pull
 * routes for the words they refuse with, and requires each to be on the list.
 *
 * A source scan finds the literal words only (`code: "x"`, `new ExecuteRefused("x"`, a local
 * `refuse("x"` or `refused("x"`, and a Worker refusal `{ status: 4xx, code: "x" }`); a word built at
 * run time is not seen, which is why a run maps any unknown word to `no-code` rather than trusting
 * this test alone. Each pattern is proven to find a word it should.
 *
 * CI TIER: unit-pure. Reads source files; no server, no database.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { OTHER_WORD, type WordList, publicWord } from "../shared/repull-observability";
import {
  AUTOMATIC_ERROR_PREFIX,
  CURRENT_PLANNER_VERSION,
  DISPATCH_CODES,
  DISPATCH_FINAL_CODES,
  FIXED_WORD_RE,
  REPULL_HOLD_REASONS,
  REPULL_SCHEDULER_OUTCOMES,
} from "../shared/repull-state";
import { IMPORT_SCRUB_REFUSALS } from "../src/lib/import-scrub";
import { PLANNER_VERSION } from "../src/lib/repull/digest";
import { PREPARE_ERROR_PREFIX } from "../src/lib/repull/execute/run";

const ROOT = join(import.meta.dir, "..");

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? tsFiles(p) : p.endsWith(".ts") ? [p] : [];
  });
}

const CLI_PATTERNS = [
  /\bcode:\s*"([a-z][a-z0-9-]*)"/g,
  /new ExecuteRefused\(\s*"([a-z][a-z0-9-]*)"/g,
  /\brefused?\(\s*"([a-z][a-z0-9-]*)"/g,
  /reason: [^\n]*\.code \?\? "([a-z][a-z0-9-]*)"/g,
];
/** A refusal: a 3xx to 5xx status beside its code (a success's word is not a refusal). */
const WORKER_PATTERN = /status: [3-5]\d{2},\s*code: "([a-z][a-z0-9-]*)"/g;

function wordsIn(files: string[], patterns: RegExp[]): Map<string, string> {
  const found = new Map<string, string>();
  for (const file of files) {
    const text = readFileSync(file, "utf-8");
    for (const re of patterns) {
      for (const m of text.matchAll(re)) {
        if (!found.has(m[1] as string)) found.set(m[1] as string, file.slice(ROOT.length + 1));
      }
    }
  }
  return found;
}

/** The automatic run's own words: the command glue states an outcome as `code: "<word>"`. */
const AUTOMATIC_COMMANDS = join(ROOT, "src/commands/admin-repull-automatic.ts");
const cliWords = () =>
  wordsIn([...tsFiles(join(ROOT, "src/lib/repull")), AUTOMATIC_COMMANDS], CLI_PATTERNS);
const workerWords = () =>
  wordsIn(
    [
      ...tsFiles(join(ROOT, "backend/src/services")).filter((f) =>
        /\/upstream-repull[^/]*\.ts$/.test(f),
      ),
      join(ROOT, "backend/src/routes/admin/upstream-repulls.ts"),
    ],
    [WORKER_PATTERN],
  );

const listed = new Set<string>(DISPATCH_CODES);
const missing = (words: Iterable<string>) => [...words].filter((w) => !listed.has(w)).sort();

describe("DISPATCH_CODES holds every word a run can meet", () => {
  test("the scans find what they should, so an empty result is not a pass", () => {
    const cli = cliWords();
    for (const w of [
      "plan-tampered",
      "gitlink",
      "latest-unknown",
      "order-unverified",
      "preflight",
      // The unattended run's: a refusal in the library and an outcome in the command glue.
      "auto-token-on-argv",
      "finish-incomplete",
    ]) {
      expect([w, cli.has(w)]).toEqual([w, true]);
    }
    const worker = workerWords();
    for (const w of ["repull-in-flight", "auto-not-clean-plan", "dispatch-mismatch", "merge-cap"]) {
      expect([w, worker.has(w)]).toEqual([w, true]);
    }
  });

  test("every refusal word of the CLI's plan and execution is listed", () => {
    const cli = cliWords();
    expect(missing(cli.keys()).map((w) => `${w} (${cli.get(w)})`)).toEqual([]);
  });

  test("every refusal the scrub declares is listed", () => {
    expect(missing(IMPORT_SCRUB_REFUSALS)).toEqual([]);
  });

  test("every refusal of the Worker's re-pull routes is listed", () => {
    const worker = workerWords();
    expect(missing(worker.keys()).map((w) => `${w} (${worker.get(w)})`)).toEqual([]);
  });

  test("every word has the stored shape, and none repeats", () => {
    for (const w of [...DISPATCH_CODES, ...REPULL_HOLD_REASONS, ...REPULL_SCHEDULER_OUTCOMES]) {
      expect(w).toMatch(FIXED_WORD_RE);
    }
    expect(new Set(DISPATCH_CODES).size).toBe(DISPATCH_CODES.length);
    expect(new Set(REPULL_HOLD_REASONS).size).toBe(REPULL_HOLD_REASONS.length);
    expect(new Set(REPULL_SCHEDULER_OUTCOMES).size).toBe(REPULL_SCHEDULER_OUTCOMES.length);
    expect(new Set(DISPATCH_FINAL_CODES).size).toBe(DISPATCH_FINAL_CODES.length);
    for (const w of DISPATCH_FINAL_CODES) expect(listed.has(w)).toBe(true);
  });
});

describe("the automatic path and the CLI agree", () => {
  test("the planner the automatic create takes is the planner the CLI runs", () => {
    expect(PLANNER_VERSION).toBe(CURRENT_PLANNER_VERSION);
  });

  test("an automatic error is never read as a preparation's own", () => {
    // A `prepared` self-edge clears only an error that begins with the preparation's prefix.
    expect(AUTOMATIC_ERROR_PREFIX.startsWith(PREPARE_ERROR_PREFIX)).toBe(false);
    expect(PREPARE_ERROR_PREFIX.startsWith(AUTOMATIC_ERROR_PREFIX)).toBe(false);
  });
});

describe("publicWord: the words a report on a public repository may print", () => {
  const LISTS: Array<[WordList, readonly string[]]> = [
    ["code", DISPATCH_CODES],
    ["hold", REPULL_HOLD_REASONS],
    ["outcome", REPULL_SCHEDULER_OUTCOMES],
  ];

  test("every listed word prints as itself, but one that names anonymity, which is `other`", () => {
    const withheld: string[] = [];
    for (const [list, words] of LISTS) {
      for (const word of words) {
        const expected = /anonym/i.test(word) ? OTHER_WORD : word;
        if (expected === OTHER_WORD) withheld.push(`${list}:${word}`);
        expect([list, word, publicWord(word, list)]).toEqual([list, word, expected]);
      }
    }
    // The anonymity rule has words to act on, so an empty set is not a pass.
    expect(withheld).toContain("hold:dataset-anonymous");
    expect(withheld).toContain("code:anonymous-dataset");
  });

  test("a word printed from the wrong list is `other`: a list admits its own words only", () => {
    expect(publicWord("screen-acknowledge", "code")).toBe(OTHER_WORD);
    expect(publicWord("gitlink", "hold")).toBe(OTHER_WORD);
    expect(publicWord("gitlink", "outcome")).toBe(OTHER_WORD);
    expect(publicWord("ran", "hold")).toBe(OTHER_WORD);
    expect(publicWord("ran", "outcome")).toBe("ran");
  });

  test("a dataset id of any shape, an absent word and a made-up word are `other`", () => {
    for (const [list] of LISTS) {
      for (const word of [
        "nm000123",
        "on098701",
        "xx099901",
        "ds004362",
        "NM000123",
        "made-up",
        "",
      ]) {
        expect([list, word, publicWord(word, list)]).toEqual([list, word, OTHER_WORD]);
      }
      expect(publicWord(null, list)).toBe(OTHER_WORD);
      expect(publicWord(undefined, list)).toBe(OTHER_WORD);
    }
  });

  test("a digit does not withhold a word: the list does, so the four codes that hold one print", () => {
    for (const word of ["nemar-s3-ambiguous", "no-nemar-s3", "no-nemar-s3-remote", "s3-failed"]) {
      expect(word).toMatch(/\d/);
      expect(publicWord(word, "code")).toBe(word);
    }
  });
});
