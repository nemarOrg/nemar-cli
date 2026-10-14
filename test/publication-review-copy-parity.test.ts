/**
 * The words the administrator's approval page owns, and their drift check against the website's
 * transcription (ADR 0102, Phase 4 of epic #1726; the pattern of `account-copy-parity.test.ts`,
 * ADR 0045).
 *
 * CI TIER: unit-pure. Pure: no database, no network, no spawn.
 *
 * `shared/contract/publication-review-copy.ts` is the source of truth; the website's
 * `src/lib/publication-review-copy.ts` is a transcription of it. The two repositories share no
 * package, so each side reads the other's file as TEXT and compares it key by key. What this file
 * proves, in four blocks:
 *
 * 1. The table obeys its own rules (always runs): literal strings only, dotted keys, plain ASCII,
 *    and no word that points at a terminal, which is the reason the table exists.
 * 2. The table covers exactly what it must (always runs): one key for each refusal word the
 *    Worker words for a terminal, and no key without a reason to exist.
 *
 * The ties to the CLI's own sentences and the comparison with the website's file follow.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ScreenGateRefusal } from "../backend/src/services/identifier-screen.js";
import { START_STARTED_REASONS } from "../shared/contract/publication-review-admin.js";
import {
  PUBLICATION_REVIEW_COPY,
  type PublicationReviewCopyKey,
} from "../shared/contract/publication-review-copy.js";
import { REVIEW_GATE_REFUSALS } from "../shared/publication-review.js";
import { terminalFlaws } from "./helpers/terminal-words.js";

const REPO_ROOT = join(import.meta.dir, "..");
const COPY_FILE = join(REPO_ROOT, "shared", "contract", "publication-review-copy.ts");

/**
 * Pull `"key": "value"` pairs out of a TypeScript source file.
 *
 * Byte for byte the extractor the website's drift test uses (its `test/copy-drift.ts`), so the two
 * halves of the mirror cannot disagree about what they compare. Comments are stripped first so a
 * key quoted in prose cannot become an entry; a value that is not a plain string literal is
 * invisible to it, which is why the literal-only rule is asserted below.
 */
function extractCopy(source: string): Map<string, string> {
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^[ \t]*\/\/.*$/gm, " ");
  const entries = new Map<string, string>();
  const pattern = /"([A-Za-z0-9_.]+)"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  for (const match of withoutComments.matchAll(pattern)) {
    entries.set(match[1], match[2].replace(/\\(.)/g, "$1"));
  }
  return entries;
}

const KEYS = Object.keys(PUBLICATION_REVIEW_COPY) as PublicationReviewCopyKey[];

function keysWithPrefix(prefix: string): string[] {
  return KEYS.filter((key) => key.startsWith(`${prefix}.`)).map((key) =>
    key.slice(prefix.length + 1),
  );
}

describe("the copy table's own rules", () => {
  test("every value is a plain string literal, so the drift check can see it", () => {
    // A template literal or a concatenation is extracted as NOTHING, so a silently unread key
    // becomes a silently unchecked key on both sides of the mirror.
    const extracted = extractCopy(readFileSync(COPY_FILE, "utf8"));
    expect(Object.fromEntries(extracted)).toEqual({ ...PUBLICATION_REVIEW_COPY });
  });

  test("the file imports nothing and exports no accessor, so it can be lifted out whole", () => {
    const source = readFileSync(COPY_FILE, "utf8");
    expect(source).not.toMatch(/^\s*import\s/m);
    expect(source).not.toMatch(/^\s*export\s+(async\s+)?function\s/m);
  });

  test("the extractor ignores a key quoted inside a comment", () => {
    const source = [
      '/* the key "gate.hard_reason": "Not this one" appears in prose */',
      '// "gate.hard_reason": "Nor this one"',
      'const X = { "gate.hard_reason": "The real one." };',
    ].join("\n");
    expect(extractCopy(source).get("gate.hard_reason")).toBe("The real one.");
    expect(extractCopy(source).size).toBe(1);
  });

  test("the extractor invents nothing for a computed value", () => {
    const source = 'const X = { "a.b": `${MIN} to ${MAX}`, "c.d": "plain" };';
    expect(extractCopy(source).has("a.b")).toBe(false);
    expect(extractCopy(source).get("c.d")).toBe("plain");
  });

  test("keys are dotted lowercase tokens, which is what makes them extractable", () => {
    expect(KEYS.length).toBeGreaterThan(0);
    for (const key of KEYS) expect(key).toMatch(/^[a-z0-9_]+(\.[a-z0-9_]+)+$/);
  });

  test("no value holds a brace, a quote, a backslash, a template, an em-dash or a non-ASCII character", () => {
    for (const key of KEYS) {
      const value = PUBLICATION_REVIEW_COPY[key];
      expect({ key, value, ok: /^[\x20-\x7e]+$/.test(value) }).toEqual({ key, value, ok: true });
      expect({ key, hit: value.match(/[{}"\\`]|\$\{/)?.[0] ?? null }).toEqual({ key, hit: null });
      expect({ key, hit: value.includes("\u2014") || value.includes("--") }).toEqual({
        key,
        hit: false,
      });
    }
  });

  test("every value is a sentence a person reads, with no terminal word in it", () => {
    // The point of the table: the Worker words these for a terminal, the page words them for a
    // person. Tiers 1 and 2 of the one list every other web-safety test uses.
    for (const key of KEYS) {
      expect({ key, flaws: terminalFlaws(PUBLICATION_REVIEW_COPY[key]) }).toEqual({
        key,
        flaws: [],
      });
    }
  });

  test("every value but the two labels is a sentence: a capital, a full stop, nothing else at the ends", () => {
    // The two labels are phrases that sit after a colon beside the model's text.
    const LABELS = new Set<string>(["review.model_summary_label", "review.model_findings_label"]);
    for (const key of KEYS) {
      const value = PUBLICATION_REVIEW_COPY[key];
      expect({ key, sentence: LABELS.has(key) || /^[A-Z].*\.$/.test(value) }).toEqual({
        key,
        sentence: true,
      });
      expect({ key, padded: value !== value.trim() }).toEqual({ key, padded: false });
    }
  });
});

describe("the copy table covers exactly what it must", () => {
  test("the gate.* keys are exactly the review gate's refusal words", () => {
    expect(keysWithPrefix("gate").sort()).toEqual([...REVIEW_GATE_REFUSALS].sort());
  });

  test("the screen_gate.* keys are exactly the six words the screen's refusal can carry", () => {
    // `clear` is not a refusal. The type-level half of this line is the `satisfies`: a word the
    // service adds to `ScreenGateRefusal["gate"]` fails the typecheck here until it is listed.
    const SCREEN_REFUSALS = [
      "blocks",
      "acknowledge",
      "rerun",
      "wait",
      "stale",
      "unverified",
    ] as const satisfies readonly Exclude<ScreenGateRefusal["gate"], "clear">[];
    expect(keysWithPrefix("screen_gate").sort()).toEqual([...SCREEN_REFUSALS].sort());
  });

  test("the start.* keys are exactly the reasons a started review can carry", () => {
    expect(keysWithPrefix("start").sort()).toEqual([...START_STARTED_REASONS].sort());
  });

  test("the approve.* keys are exactly the four states of the approve control", () => {
    expect(keysWithPrefix("approve").sort()).toEqual(
      ["blocked", "override_control", "resume", "unavailable"].sort(),
    );
  });

  test("the review.* keys are exactly the standing word and the two labels on the model's text", () => {
    expect(keysWithPrefix("review").sort()).toEqual(
      ["model_findings_label", "model_summary_label", "not_assessed"].sort(),
    );
  });

  test("no other prefix exists", () => {
    const prefixes = new Set(KEYS.map((key) => key.split(".")[0]));
    expect([...prefixes].sort()).toEqual(["approve", "gate", "review", "screen_gate", "start"]);
  });

  test("the table holds twenty-two keys, and a count that moves is a decision", () => {
    expect(KEYS.length).toBe(22);
  });
});
