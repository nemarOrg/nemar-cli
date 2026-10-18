/**
 * Every place that brings a dataset repository to its spec also decides the required pull-request
 * review for it (ADR 0107), decides it from the dataset's row, and asks the owner's switch first
 * (PR_REVIEW_AUTO_REQUIRE): until the owner turns it on, no automatic path requires the review.
 *
 * Publishing a dataset (the orchestrator and the direct route), flipping its visibility, and the
 * two enforce routes all end in `ensureRepoToSpec`. What the review step does for each intent is
 * tested against a GitHub stand-in (ensure-repo-spec.test.ts). What each of the five callers does
 * with the switch off and on is driven through the real routes: the enforce routes in
 * review-ruleset-routes.test.ts, the other three in review-auto-require-paths.test.ts, which
 * stands in for S3's bucket policy as well.
 *
 * This scan stays because those tests can only drive the callers that exist today. A sixth call
 * to `ensureRepoToSpec`, added later, would not be in any of them, and the scan is what notices
 * it, in the shape of the scans in anonymity-publication-paths.test.ts.
 *
 * Three ways for a caller to be wrong, and the scan fails on all of them:
 *  - it says nothing about the review, so the repository's ruleset is never kept in step with the
 *    dataset (a published dataset is never gated, or an unpublished one keeps a ruleset);
 *  - it passes a literal, which puts the requirement on, or takes it off, whatever the row says;
 *  - it asks the row alone (`reviewIntentOf`), which has no switch, so the review is required on
 *    that path whatever the owner has decided.
 *
 * A path can also reach the ruleset without `ensureRepoToSpec`: by calling `ensureReviewRuleset`,
 * `removeReviewRuleset` or `reconcileReviewRuleset` itself, or by asking `reviewIntentOf` for an
 * intent of its own. Those are not calls to `ensureRepoToSpec`, so the scan above never sees them,
 * and a new route that did either would put the requirement on, or take it off, with none of the
 * owner's switches asked. The second half of this file fails on any module that names one of the
 * four and is not on an explicit list of the modules that legitimately do, each with its reason.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

const SRC = join(import.meta.dir, "..", "src");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(path));
    else if (entry.name.endsWith(".ts")) out.push(path);
  }
  return out;
}

/** An awaited CALL. `await` excludes the declaration and the comments that name the function. */
const CALL = /await\s+ensureRepoToSpec\s*\(/g;

/** The text of one call, from its `await` to the first line that closes it with `});`. */
function callText(text: string, at: number): string {
  const closes = /\n\s*\}\);/.exec(text.slice(at));
  return closes ? text.slice(at, at + closes.index + closes[0].length) : text.slice(at, at + 2000);
}

/**
 * What the `review` option is given: the answer of the two functions that ask the switch, never a
 * literal and never `reviewIntentOf`, which is the row's answer without it.
 */
const COMPUTED_REVIEW = /\breview:\s*(await\s+)?(readReviewIntent|automaticReviewIntent)\(/;

interface Site {
  where: string;
  text: string;
}

function sites(): Site[] {
  const found: Site[] = [];
  for (const file of sourceFiles(SRC)) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(CALL)) {
      const line = text.slice(0, match.index).split("\n").length;
      found.push({
        where: `${relative(SRC, file).split(sep).join("/")}:${line}`,
        text: callText(text, match.index ?? 0),
      });
    }
  }
  return found;
}

/**
 * The same text with its comments blanked, so that a name in the documentation is not a use of it.
 * Block comments keep their newlines, so a line number is still the file's own.
 */
function code(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, "");
}

/** The functions that put the review ruleset on a repository or take it off one. */
const RULESET_WRITER = /\b(ensureReviewRuleset|removeReviewRuleset|reconcileReviewRuleset)\b/;

/** The row's answer on its own, which has no switch: see the scan above. */
const ROW_ALONE = /\breviewIntentOf\b/;

/**
 * The modules that may name a function that writes the review ruleset, and why. Adding a module
 * here is the decision this test exists to make somebody take: whatever it does, it does without
 * the review and the owner's switches asked for it unless it asks them itself.
 */
const MAY_WRITE_THE_RULESET: Readonly<Record<string, string>> = {
  "services/github/branch-protection.ts":
    "defines them, and the review step of ensureRepoToSpec is their caller",
  "services/github.ts":
    "the barrel that re-exports them (its surface is pinned by github-export-surface.unit.test.ts)",
  "routes/admin/fleet.ts":
    "the explicit review-ruleset routes, which the owner or an administrator runs by hand, a dry run first",
};

/** The modules that may ask the row alone, and why. */
const MAY_ASK_THE_ROW_ALONE: Readonly<Record<string, string>> = {
  "services/pr-review-eligibility.ts":
    "defines it, and automaticReviewIntent is its one caller that adds the switches",
  "routes/admin/fleet.ts": "the drift report, which asks what a row calls for and writes nothing",
};

/** The modules whose code matches `pattern`, by path under src, with the line of the first match. */
function namingModules(pattern: RegExp): Map<string, number> {
  const found = new Map<string, number>();
  for (const file of sourceFiles(SRC)) {
    const text = code(readFileSync(file, "utf8"));
    const match = pattern.exec(text);
    if (!match) continue;
    found.set(
      relative(SRC, file).split(sep).join("/"),
      text.slice(0, match.index).split("\n").length,
    );
  }
  return found;
}

describe("nothing else writes the review ruleset, or asks the row alone", () => {
  test("no module outside the list names a function that writes the review ruleset", () => {
    const offenders = [...namingModules(RULESET_WRITER)]
      .filter(([path]) => !(path in MAY_WRITE_THE_RULESET))
      .map(([path, line]) => `${path}:${line}`);
    expect(offenders).toEqual([]);
  });

  test("no module outside the list asks the row alone with reviewIntentOf", () => {
    const offenders = [...namingModules(ROW_ALONE)]
      .filter(([path]) => !(path in MAY_ASK_THE_ROW_ALONE))
      .map(([path, line]) => `${path}:${line}`);
    expect(offenders).toEqual([]);
  });

  test("the lists are not stale: every module on them still does what it is allowed to", () => {
    // Without this a pattern that matched nothing would pass the two tests above forever, and a
    // module that stopped using a name would stay on a list that says it may.
    const writers = namingModules(RULESET_WRITER);
    for (const path of Object.keys(MAY_WRITE_THE_RULESET)) {
      expect(writers.has(path), `${path} no longer names a function that writes the ruleset`).toBe(
        true,
      );
    }
    const askers = namingModules(ROW_ALONE);
    for (const path of Object.keys(MAY_ASK_THE_ROW_ALONE)) {
      expect(askers.has(path), `${path} no longer uses reviewIntentOf`).toBe(true);
    }
  });

  test("the patterns tell an import, a call and a re-export from a mention in a comment", () => {
    for (const use of [
      'import { removeReviewRuleset } from "../../services/github";',
      "await ensureReviewRuleset(repo, pat);",
      'export { reconcileReviewRuleset } from "./github/branch-protection";',
      "const f = gh.removeReviewRuleset;",
      'const { ensureReviewRuleset } = await import("../../services/github");',
    ]) {
      expect(RULESET_WRITER.test(code(use)), use).toBe(true);
    }
    expect(ROW_ALONE.test(code("const intent = reviewIntentOf(id, row, on);"))).toBe(true);
    expect(
      ROW_ALONE.test(
        code('import { reviewIntentOf } from "../../services/pr-review-eligibility";'),
      ),
    ).toBe(true);
    // The documentation names them all the time.
    for (const mention of [
      "// calls removeReviewRuleset when a dataset stops being reviewed",
      "/* ensureReviewRuleset writes it,\n   reconcileReviewRuleset decides */",
      "/**\n * `reviewIntentOf` is the row's answer\n */",
    ]) {
      expect(RULESET_WRITER.test(code(mention)), mention).toBe(false);
      expect(ROW_ALONE.test(code(mention)), mention).toBe(false);
    }
    // A comment does not hide code on the next line, and a longer name that contains one is not it.
    expect(RULESET_WRITER.test(code("// note\nawait removeReviewRuleset(r, p);"))).toBe(true);
    expect(RULESET_WRITER.test(code("const x = ensureReviewRulesetExists();"))).toBe(false);
    expect(ROW_ALONE.test(code("const x = reviewIntentOfRow();"))).toBe(false);
  });
});

describe("every caller of ensureRepoToSpec decides the required review from the row", () => {
  test("none leaves it out, passes a literal, or skips the owner's switch", () => {
    const offenders = sites()
      .filter((s) => !COMPUTED_REVIEW.test(s.text))
      .map((s) => s.where);
    expect(offenders).toEqual([]);
  });

  test("the scan would notice: it finds the callers it is scanning", () => {
    // Publication (two paths), a visibility flip, and the two enforce routes. Without this a
    // pattern that matched nothing would pass the test above forever.
    const found = sites().map((s) => s.where.split(":")[0]);
    expect(found.length).toBeGreaterThanOrEqual(5);
    for (const file of [
      "routes/admin/fleet.ts",
      "routes/datasets/publication.ts",
      "services/publication-orchestrator.ts",
      "services/visibility.ts",
    ]) {
      expect(found, file).toContain(file);
    }
  });

  test("the pattern tells a decided call from an undecided one, a literal and one with no switch", () => {
    expect(COMPUTED_REVIEW.test("review: await readReviewIntent(c.env, datasetId),")).toBe(true);
    expect(COMPUTED_REVIEW.test("review: automaticReviewIntent(c.env, id, row),")).toBe(true);
    // The row's answer alone has no switch, so a caller that uses it requires the review on its own.
    expect(COMPUTED_REVIEW.test("review: reviewIntentOf(id, row, enabled),")).toBe(false);
    expect(COMPUTED_REVIEW.test('review: "require",')).toBe(false);
    expect(COMPUTED_REVIEW.test("review: undefined,")).toBe(false);
    expect(COMPUTED_REVIEW.test("visibility: 'public', dryRun,")).toBe(false);
  });
});
