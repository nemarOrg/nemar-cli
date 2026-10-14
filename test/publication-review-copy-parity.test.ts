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
 * 3. The words the page shares with the CLI are the CLI's own sentences (always runs), so the two
 *    surfaces cannot disagree where they must not.
 * 4. The website's file matches, string for string. Two modes, and the difference is deliberate:
 *      NEMAR_WEBSITE_REVIEW_COPY set   that path IS the contract. A file that is not there FAILS,
 *                                      naming the path and the variable.
 *      unset                           search the sibling checkouts a developer is likely to have;
 *                                      absent is a VISIBLE skip (`describe.skipIf`), never an
 *                                      early return, which would be reported as success.
 *    The comparison itself is proved on in-memory fixtures (always runs), so the failure modes of
 *    the strict path are exercised without the other repository.
 *
 * Wiring the strict path into the CI workflow is a follow-up that needs the website file on its
 * `staging` branch first; see the header of the copy file.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { ScreenGateRefusal } from "../backend/src/services/identifier-screen.js";
import { START_STARTED_REASONS } from "../shared/contract/publication-review-admin.js";
import {
  PUBLICATION_REVIEW_COPY,
  type PublicationReviewCopyKey,
} from "../shared/contract/publication-review-copy.js";
import {
  ACKNOWLEDGMENT_MAX_LENGTH,
  ACKNOWLEDGMENT_MIN_LENGTH,
} from "../shared/publication-limits.js";
import {
  APPROVAL_PUBLISHING_LINE,
  NOT_ASSESSED_LINE,
  REVIEW_GATE_REFUSALS,
  REVIEW_GATE_REFUSAL_TEXT,
} from "../shared/publication-review.js";
import {
  MODEL_WRITTEN_FINDINGS,
  MODEL_WRITTEN_SUMMARY,
} from "../src/lib/publication-review-display.js";
import { terminalFlaws } from "./helpers/terminal-words.js";

const REPO_ROOT = join(import.meta.dir, "..");
const COPY_FILE = join(REPO_ROOT, "shared", "contract", "publication-review-copy.ts");

/**
 * Where a website checkout is expected to sit relative to this one: one level up from the
 * repository root whatever the root is called, because this repository is often a worktree.
 * Only consulted when {@link WEBSITE_ENV_VAR} is unset.
 */
const WEBSITE_CANDIDATES = [
  join(REPO_ROOT, "..", "website", "src", "lib", "publication-review-copy.ts"),
  join(REPO_ROOT, "..", "..", "website", "src", "lib", "publication-review-copy.ts"),
];

/** Set by a CI job to the sparse checkout it made. A relative value resolves against the repo root. */
const WEBSITE_ENV_VAR = "NEMAR_WEBSITE_REVIEW_COPY";
const declaredRaw = process.env[WEBSITE_ENV_VAR];
const DECLARED_PATH =
  declaredRaw && declaredRaw.trim() !== ""
    ? isAbsolute(declaredRaw)
      ? declaredRaw
      : join(REPO_ROOT, declaredRaw)
    : null;

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

/** What differs between this table and another: a changed value, a key it lacks, a key we lack. */
interface CopyDifference {
  drifted: string[];
  absent: string[];
  unmirrored: string[];
}

function compare(
  ours: ReadonlyMap<string, string>,
  theirs: ReadonlyMap<string, string>,
): CopyDifference {
  const drifted: string[] = [];
  const absent: string[] = [];
  for (const [key, mine] of ours) {
    const yours = theirs.get(key);
    if (yours === undefined) absent.push(key);
    else if (yours !== mine)
      drifted.push(`${key}\n    nemar-cli: ${mine}\n    website:   ${yours}`);
  }
  const unmirrored = [...theirs.keys()].filter((key) => !ours.has(key));
  return { drifted, absent, unmirrored };
}

const KEYS = Object.keys(PUBLICATION_REVIEW_COPY) as PublicationReviewCopyKey[];
const OURS = new Map<string, string>(Object.entries(PUBLICATION_REVIEW_COPY));

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

describe("the page and the CLI say the same where they must", () => {
  test("the two gate sentences that name no terminal are the code's own", () => {
    const hardReason: string = PUBLICATION_REVIEW_COPY["gate.hard_reason"];
    const unverified: string = PUBLICATION_REVIEW_COPY["gate.unverified"];
    expect(hardReason).toBe(REVIEW_GATE_REFUSAL_TEXT.hard_reason);
    expect(unverified).toBe(REVIEW_GATE_REFUSAL_TEXT.unverified);
  });

  test("the other four gate sentences are the page's own, because the Worker's name a terminal", () => {
    // The reason `gate.*` exists: if the Worker's text ever stops naming a terminal, a key here
    // would be a second copy of a sentence that no longer needs one, and this says so.
    for (const refusal of [
      "needs_override",
      "override_not_covering",
      "review_changed",
      "no_review_row",
    ] as const) {
      expect({
        refusal,
        terminalFlaws: terminalFlaws(REVIEW_GATE_REFUSAL_TEXT[refusal], 1).length > 0,
      }).toEqual({
        refusal,
        terminalFlaws: true,
      });
      expect(PUBLICATION_REVIEW_COPY[`gate.${refusal}`]).not.toBe(
        REVIEW_GATE_REFUSAL_TEXT[refusal],
      );
    }
  });

  test("the unverified screen sentence keeps the Worker's remedy for a refusal that retrying cannot clear", () => {
    // The Worker says "try again, or re-run the screen" for a stored report that names no commit;
    // the page has no control to re-run it, so its sentence names the administrator who does.
    expect(PUBLICATION_REVIEW_COPY["screen_gate.unverified"]).toBe(
      "The identifier screen's result could not be checked against the current commit just now, so the approval is refused. Try again. If it keeps happening, an administrator runs the screen again.",
    );
  });

  test("the resumed approval's line is the description's", () => {
    expect(PUBLICATION_REVIEW_COPY["approve.resume"]).toBe(APPROVAL_PUBLISHING_LINE);
  });

  test("the standing not-assessed line is the description's", () => {
    expect(PUBLICATION_REVIEW_COPY["review.not_assessed"]).toBe(NOT_ASSESSED_LINE);
  });

  test("the labels on the model's text are the CLI's", () => {
    expect(PUBLICATION_REVIEW_COPY["review.model_summary_label"]).toBe(MODEL_WRITTEN_SUMMARY);
    expect(PUBLICATION_REVIEW_COPY["review.model_findings_label"]).toBe(MODEL_WRITTEN_FINDINGS);
  });

  test("the acknowledgment sentence's written-out bounds still match the constants", () => {
    // Rule 1 forbids interpolating them, so this is what keeps the sentence honest when they move.
    expect(PUBLICATION_REVIEW_COPY["screen_gate.acknowledge"]).toContain(
      `${ACKNOWLEDGMENT_MIN_LENGTH} to ${ACKNOWLEDGMENT_MAX_LENGTH} characters`,
    );
  });
});

describe("the drift comparison, proved on fixtures", () => {
  test("two identical tables differ in nothing", () => {
    expect(compare(OURS, new Map(OURS))).toEqual({ drifted: [], absent: [], unmirrored: [] });
  });

  test("it reports a changed value, naming both sides", () => {
    const theirs = new Map(OURS);
    theirs.set("review.not_assessed", "Not assessed: whether the text names the depositor.");
    const diff = compare(OURS, theirs);
    expect(diff.absent).toEqual([]);
    expect(diff.unmirrored).toEqual([]);
    expect(diff.drifted).toHaveLength(1);
    expect(diff.drifted[0]).toContain("review.not_assessed");
    expect(diff.drifted[0]).toContain("names the depositors.");
    expect(diff.drifted[0]).toContain("names the depositor.");
  });

  test("it reports a key the other side lacks", () => {
    const theirs = new Map(OURS);
    theirs.delete("gate.no_review_row");
    expect(compare(OURS, theirs)).toEqual({
      drifted: [],
      absent: ["gate.no_review_row"],
      unmirrored: [],
    });
  });

  test("it reports a key only the other side has", () => {
    const theirs = new Map(OURS);
    theirs.set("gate.invented", "A sentence with no source of truth.");
    expect(compare(OURS, theirs)).toEqual({
      drifted: [],
      absent: [],
      unmirrored: ["gate.invented"],
    });
  });

  test("it reports all three at once, so one run shows the whole disagreement", () => {
    const theirs = new Map(OURS);
    theirs.set("start.dispatched", "The review began.");
    theirs.delete("approve.blocked");
    theirs.set("start.extra", "Another.");
    const diff = compare(OURS, theirs);
    expect(diff.drifted).toHaveLength(1);
    expect(diff.absent).toEqual(["approve.blocked"]);
    expect(diff.unmirrored).toEqual(["start.extra"]);
  });

  test("a table extracted from this very file compares equal to the table", () => {
    const extracted = extractCopy(readFileSync(COPY_FILE, "utf8"));
    expect(compare(OURS, extracted)).toEqual({ drifted: [], absent: [], unmirrored: [] });
  });
});

/** Where the website's table is, or null when nobody has told us and no sibling checkout is
 *  present. A DECLARED path counts as found whether or not it exists: the existence check is a
 *  failing assertion, not a reason to skip. */
const FOUND = DECLARED_PATH ?? WEBSITE_CANDIDATES.find((path) => existsSync(path)) ?? null;
const NO_CHECKOUT = FOUND === null;

if (NO_CHECKOUT) {
  console.info(
    [
      `[publication-review-copy parity] skipping: no website checkout at ${WEBSITE_CANDIDATES.join(" or ")},`,
      `and ${WEBSITE_ENV_VAR} is unset. A CI job sets it once the website file is on its staging branch;`,
      "this is the developer-machine path.",
    ].join(" "),
  );
}

/** The website's table, or a failure that says exactly what to fix. */
function websiteCopy(): Map<string, string> {
  if (FOUND === null) throw new Error("unreachable: the parity block is skipped without a file");
  if (!existsSync(FOUND)) {
    throw new Error(
      [
        `${WEBSITE_ENV_VAR}=${declaredRaw} resolves to ${FOUND}, which does not exist.`,
        "That variable is the contract: the job that sets it points it at a checkout of",
        "nemarOrg/website. If that step changed or was removed, fix the workflow;",
        "do not unset the variable to make this pass.",
      ].join(" "),
    );
  }
  return extractCopy(readFileSync(FOUND, "utf8"));
}

describe.skipIf(NO_CHECKOUT)("website parity", () => {
  const found = FOUND as string;

  test("every key matches the website's string for string", () => {
    const { drifted, absent } = compare(OURS, websiteCopy());
    expect(
      drifted,
      `Copy drifted from ${found}. This contract is the source of truth; update the website.`,
    ).toEqual([]);
    expect(
      absent,
      `Keys absent from ${found}. Every key here is meant to be mirrored there.`,
    ).toEqual([]);
  });

  test("nothing the website carries is missing here", () => {
    // The direction this repository can fix: a key the website has and this table does not is a
    // sentence with no source of truth.
    const { unmirrored } = compare(OURS, websiteCopy());
    expect(unmirrored, "Add these to shared/contract/publication-review-copy.ts.").toEqual([]);
  });

  test("the whole table is mirrored: it has no cli. keys for the website to ignore", () => {
    expect(KEYS.filter((key) => key.startsWith("cli."))).toEqual([]);
    const theirs = websiteCopy();
    for (const key of KEYS) expect(theirs.has(key)).toBe(true);
  });
});
