/**
 * The publication review's contract (ADR 0101), and the shared pieces it stands on.
 *
 * Pure: no database and no network. Real parser, real reasons table, real renderer, driven with
 * the inputs a hostile job, a hostile depositor or a hostile model controls.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as prompt from "../scripts/ci/pr-review-prompt";
import * as prReview from "../shared/pr-review";
import { README_CANDIDATES, firstReadme } from "../shared/readme-candidates";
import {
  MINIMUM_FAILURES,
  type MinimumFailure,
  evaluateSubmissionMinimums,
  minimumFailureSentence,
  submissionMinimumFailures,
} from "../shared/submission-minimums";
import * as untrusted from "../shared/untrusted-text";

/** A value no fixture text contains by accident; finding it in an output means it was quoted. */
const SENTINEL = "Zqxjvw Sentinelname";

describe("the text tools moved to shared/untrusted-text.ts", () => {
  test("the pull-request review re-exports the same sanitizer, not a copy", () => {
    expect(prReview.sanitizeNote).toBe(untrusted.sanitizeNote);
    expect(untrusted.DEFAULT_NOTE_MAX).toBe(prReview.NOTE_MAX);
  });

  test("the prompt module re-exports the same fence and tidy functions, not copies", () => {
    expect(prompt.fence).toBe(untrusted.fence);
    expect(prompt.tidy).toBe(untrusted.tidy);
    expect(prompt.tidyPath).toBe(untrusted.tidyPath);
  });
});

describe("the submission minimums as closed words", () => {
  const LONG_NAME = "A sufficiently descriptive title of a dataset";
  const descriptions: (string | null)[] = [null, "{not json", "[]", "null", '"a string"'];
  for (const name of [undefined, "Short", LONG_NAME]) {
    for (const authors of [
      undefined,
      [],
      ["", "  "],
      [SENTINEL],
      ["Anonymous"],
      ["n/a", SENTINEL],
      [42],
    ]) {
      for (const ethics of [undefined, [""], ["Approved by the board, ref 12"]]) {
        const desc: Record<string, unknown> = {};
        if (name !== undefined) desc.Name = name;
        if (authors !== undefined) desc.Authors = authors;
        if (ethics !== undefined) desc.EthicsApprovals = ethics;
        descriptions.push(JSON.stringify(desc));
      }
    }
  }
  const readmes = [null, "A README with no statement.", "Approved by the IRB of somewhere."];

  test("the words and the sentences agree in count and order, named and anonymous", () => {
    let cases = 0;
    for (const description of descriptions) {
      for (const readme of readmes) {
        for (const anonymousRelease of [false, true]) {
          cases++;
          const words = submissionMinimumFailures(description, readme, { anonymousRelease });
          const sentences = evaluateSubmissionMinimums(description, readme, { anonymousRelease });
          expect(words.length).toBe(sentences.length);
          // Unique, and in the declared order, so a report can be checked against it.
          const indexes = words.map((w) => MINIMUM_FAILURES.indexOf(w));
          expect(indexes).toEqual([...new Set(indexes)].sort((a, b) => a - b));
          words.forEach((word, i) => {
            if (word === "name_too_short") {
              expect(sentences[i]).toStartWith("Dataset Name must be a descriptive title");
            } else if (word === "authors_not_blinded") {
              expect(sentences[i]).toStartWith("This is an anonymous release, but Authors");
            } else {
              expect(sentences[i]).toBe(minimumFailureSentence(word));
            }
          });
          // The Authors words belong to one kind of release each.
          if (anonymousRelease) expect(words).not.toContain("authors_missing");
          else {
            expect(words).not.toContain("authors_empty_for_anonymous");
            expect(words).not.toContain("authors_not_blinded");
          }
          // A description that cannot be read is the only failure reported.
          if (words.some((w) => w.startsWith("description_"))) expect(words.length).toBe(1);
        }
      }
    }
    expect(cases).toBeGreaterThan(300);
  });

  test("every word is produced by some input, so none is dead", () => {
    const seen = new Set<MinimumFailure>();
    for (const description of descriptions) {
      for (const readme of readmes) {
        for (const anonymousRelease of [false, true]) {
          for (const w of submissionMinimumFailures(description, readme, { anonymousRelease })) {
            seen.add(w);
          }
        }
      }
    }
    expect([...seen].sort()).toEqual([...MINIMUM_FAILURES].sort());
  });

  test("the sentence for a word quotes nothing, where the long form names the authors", () => {
    const description = JSON.stringify({ Name: "x", Authors: [SENTINEL] });
    const long = evaluateSubmissionMinimums(description, null, { anonymousRelease: true });
    expect(long.join(" ")).toContain(SENTINEL);
    const words = submissionMinimumFailures(description, null, { anonymousRelease: true });
    expect(words).toEqual(["name_too_short", "authors_not_blinded", "ethics_statement_missing"]);
    for (const w of MINIMUM_FAILURES) {
      expect(minimumFailureSentence(w)).not.toContain(SENTINEL);
      expect(minimumFailureSentence(w)).not.toMatch(/currently \d/);
      expect(minimumFailureSentence(w).length).toBeGreaterThan(20);
    }
  });
});

describe("one README list (shared/readme-candidates.ts)", () => {
  test("is the four forms BIDS allows, in the order the first present one is chosen", () => {
    expect([...README_CANDIDATES]).toEqual(["README.md", "README", "README.rst", "README.txt"]);
  });

  test("firstReadme picks by that order, with exact case, and null when there is none", () => {
    expect(firstReadme(["README.rst", "README.md", "CHANGES"])).toBe("README.md");
    expect(firstReadme(["README.rst"])).toBe("README.rst");
    expect(firstReadme(["README.txt", "README.rst"])).toBe("README.rst");
    expect(firstReadme(new Set(["README", "README.txt"]))).toBe("README");
    expect(firstReadme(["readme.md", "Readme", "sub-01/README.md"])).toBeNull();
    expect(firstReadme([])).toBeNull();
  });

  test("the submission gate and the anonymity sweep import it and keep no list of their own", () => {
    const root = join(import.meta.dir, "..");
    for (const file of [
      "backend/src/services/submission-gate.ts",
      "backend/src/services/anonymity-sweep.ts",
    ]) {
      const text = readFileSync(join(root, file), "utf8");
      expect(text).toContain(
        'import { README_CANDIDATES } from "../../../shared/readme-candidates.js";',
      );
      expect(text).not.toMatch(/"README(\.[a-z]+)?"/);
    }
  });
});
