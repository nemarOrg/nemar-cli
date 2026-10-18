/**
 * Every place that brings a dataset repository to its spec also decides the required pull-request
 * review for it (ADR 0107), decides it from the dataset's row, and asks the owner's switch first
 * (PR_REVIEW_AUTO_REQUIRE): until the owner turns it on, no automatic path requires the review.
 *
 * Publishing a dataset, flipping its visibility, withdrawing or restoring it, and the two enforce
 * routes all end in `ensureRepoToSpec`. What the review step does for each intent is tested
 * against a GitHub stand-in (ensure-repo-spec.test.ts), and the enforce routes are driven through
 * the real router (review-ruleset-routes.test.ts). The other three callers sit behind a live S3 and
 * cannot be driven here, which is the boundary visibility.test.ts documents, so this scan is what
 * stands behind them, in the shape of the scans in anonymity-publication-paths.test.ts.
 *
 * Three ways for a caller to be wrong, and the scan fails on all of them:
 *  - it says nothing about the review, so the repository's ruleset is never kept in step with the
 *    dataset (a published dataset is never gated, or an unpublished one keeps a ruleset);
 *  - it passes a literal, which puts the requirement on, or takes it off, whatever the row says;
 *  - it asks the row alone (`reviewIntentOf`), which has no switch, so the review is required on
 *    that path whatever the owner has decided.
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

describe("every caller of ensureRepoToSpec decides the required review from the row", () => {
  test("none leaves it out, and none passes a literal", () => {
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
