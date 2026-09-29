/**
 * enrichDataset wires the #1549 relation guard, the resolved DOI titles, the
 * Dataset evidence for IsDerivedFrom, and the shared registry cache.
 *
 * WHY THE REAL `enrichDataset` IS NOT DRIVEN HERE
 * ----------------------------------------------
 * The same blocker `enrich-doi-sync-skip.test.ts` documents in full:
 * `manifest-small-root-files.test.ts` installs a process-wide
 * `mock.module("../src/services/github", ...)` whose `getTreeAtRef` returns
 * an empty array, `mock.module` cannot be undone, and `enrichDataset` returns
 * "No README found" on an empty tree long before any relation is written. A
 * test driving it would pass alone and test nothing in a full run.
 *
 * So the behavior is covered where it lives (enforceNeverDataPaper and
 * mergeWithExisting in test/never-data-paper.test.ts and
 * test/llm-guards.test.ts; the resolver in test/doi-metadata*.test.ts), and
 * this file pins the one thing those cannot see: that enrichDataset calls
 * them with the right arguments, in the right order.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (file: string): string =>
  readFileSync(join(import.meta.dir, "../src/services", file), "utf-8");
const ENRICH_SOURCE = read("enrich-dataset.ts");

/** The argument text of every call to `fn` (up to the balancing paren). */
function callArguments(source: string, fn: string): string[] {
  const calls: string[] = [];
  let at = source.indexOf(`${fn}(`);
  while (at !== -1) {
    const open = at + fn.length;
    let depth = 0;
    let end = open;
    for (; end < source.length; end++) {
      if (source[end] === "(") depth++;
      else if (source[end] === ")" && --depth === 0) break;
    }
    calls.push(source.slice(open + 1, end));
    at = source.indexOf(`${fn}(`, end);
  }
  return calls;
}

describe("the relation guard runs with context at every stage", () => {
  test("every enforceNeverDataPaper call passes guardContext", () => {
    const calls = callArguments(ENRICH_SOURCE, "enforceNeverDataPaper");
    // seed, resolve, enrich merge, correction merge, final
    expect(calls).toHaveLength(5);
    for (const args of calls) expect(args).toContain("guardContext");
  });

  test("guardContext carries the dataset id from the seed, and titles once resolved", () => {
    const seedContext = ENRICH_SOURCE.indexOf(
      "let guardContext: RelationGuardContext = { datasetId };",
    );
    const seedGuard = ENRICH_SOURCE.indexOf(
      "enforceNeverDataPaper(seedPrune.result, guardContext)",
    );
    const resolve = ENRICH_SOURCE.indexOf(
      "await resolveDoisForEnrichment(candidateDois, registryCache)",
    );
    const withTitles = ENRICH_SOURCE.indexOf(
      "guardContext = { datasetId, resolvedTitles: titlesByDoi(doiResolution) };",
    );
    const firstLlm = ENRICH_SOURCE.indexOf("await enrichFromReadme(");
    for (const at of [seedContext, seedGuard, resolve, withTitles, firstLlm]) {
      expect(at).toBeGreaterThan(-1);
    }
    expect(seedContext).toBeLessThan(seedGuard);
    expect(resolve).toBeLessThan(withTitles);
    // Titles must be in the context before the first LLM merge is guarded.
    expect(withTitles).toBeLessThan(firstLlm);
  });

  test("the final guard runs after the last merge and before anything is committed", () => {
    const merges = [...ENRICH_SOURCE.matchAll(/mergeWithExisting\(/g)].map((m) => m.index ?? -1);
    const finalGuard = ENRICH_SOURCE.indexOf("enforceNeverDataPaper(finalMetadata, guardContext)");
    const commit = ENRICH_SOURCE.indexOf("const documentToCommit");
    expect(finalGuard).toBeGreaterThan(Math.max(...merges));
    expect(finalGuard).toBeLessThan(commit);
  });
});

describe("IsDerivedFrom evidence and the registry cache are passed through", () => {
  test("every mergeWithExisting call gets the Dataset evidence", () => {
    const calls = callArguments(ENRICH_SOURCE, "mergeWithExisting");
    expect(calls).toHaveLength(2);
    for (const args of calls) expect(args).toContain("derivableDois");
    expect(ENRICH_SOURCE).toContain("const derivableDois = datasetDoisOf(doiResolution);");
  });

  test("ORCID discovery (both passes) and DOI resolution share one cache", () => {
    const orcidCalls = callArguments(ENRICH_SOURCE, "discoverOrcidsFromReferencedDois");
    expect(orcidCalls).toHaveLength(2);
    for (const args of orcidCalls) expect(args).toContain("registryCache");
    const cacheAt = ENRICH_SOURCE.indexOf("const registryCache: RegistryCache = new Map();");
    expect(cacheAt).toBeGreaterThan(-1);
    expect(cacheAt).toBeLessThan(ENRICH_SOURCE.indexOf("discoverOrcidsFromReferencedDois("));
  });

  test("the LLM stages see the resolved metadata", () => {
    for (const fn of ["enrichFromReadme", "validateMetadata", "correctFromFeedback"]) {
      const calls = callArguments(ENRICH_SOURCE, fn);
      expect(calls.length).toBeGreaterThan(0);
      for (const args of calls) expect(args).toContain("doiResolution");
    }
  });
});

describe("the DOI lookup counts reach the reindex response", () => {
  test("enrichDataset reports them on its success body", () => {
    expect(ENRICH_SOURCE).toContain("doi_resolution: summarizeDoiResolution(doiResolution),");
  });

  test("runEnrichmentForDataset carries them on both of its result branches", () => {
    const source = read("dataset-reindex.ts");
    expect(source).toContain('"doi_resolution" in outcome.body ? outcome.body.doi_resolution');
    // Both returns spread `reported`: the sub-error branch and the ok branch.
    expect(source).toContain(
      'return { ok: false, error: subErrors.join("; "), ref, ...reported };',
    );
    const okBranch = source.slice(
      source.indexOf("const skips = extractEnrichmentSkips(outcome.body);"),
    );
    expect(okBranch.slice(0, okBranch.indexOf("} catch"))).toContain("...reported,");
  });
});
