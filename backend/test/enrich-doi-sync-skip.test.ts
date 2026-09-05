/**
 * The enrichment pipeline's DOI-sync skip (#1255, review items 1, 26, 27).
 *
 * `enrichDataset` rebuilds a dataset's whole DataCite record from live DB
 * state and pushes it to EZID. For an already-published dataset whose owner
 * has no researcher name -- most of the catalogue until `nemar admin
 * backfill-names --apply` has been run -- that rebuild has no DataCurator, so
 * pushing it would DELETE the curator from a permanent record. The pipeline
 * therefore skips the sync, reports it, and leaves the record alone.
 *
 * WHY THE REAL `enrichDataset` IS NOT DRIVEN HERE
 * ----------------------------------------------
 * It was attempted, and the blocker is not the LLM. The Claude call is
 * already injectable: `callClaude` posts to `${config.baseUrl}/v1/messages`
 * and `baseUrl` comes straight from the `ANTHROPIC_BASE_URL` binding, so a
 * local `Bun.serve()` returning a normal messages response is enough, and
 * `clientCommits: true` avoids the commit path entirely.
 *
 * The blocker is `backend/test/manifest-small-root-files.test.ts`, which
 * installs a PROCESS-WIDE `mock.module("../src/services/github", ...)` whose
 * `getTreeAtRef` returns an empty array. `test/` and `backend/test/` share one
 * bun process, `mock.module` is permanent (neither `mock.restore()` nor
 * re-registering the real namespace undoes it -- both were tried), and
 * `enrichDataset` reads the tree early:
 *
 *     const readmeFile = tree.find((f) => f.path === "README.md" || ...);
 *     if (!readmeFile) return { ok: true, status: 200, body: { skipped: true } };
 *
 * With an empty tree it returns "No README found" long before the DOI-sync
 * block, so a test driving it would pass alone and silently stop testing
 * anything in a full run -- the worst outcome. Re-registering our own github
 * fake to win the race would break that file's tests instead.
 *
 * So the skip is covered three ways that DO hold in-suite:
 *  1. the same rule through a real route, with the EZID payload captured, in
 *     `doi-attribution-routes.test.ts` (the admin metadata refresh);
 *  2. the decision function against real owner rows, in
 *     `uploader-real-name-doi.test.ts`;
 *  3. the source-level guard below, which is the only thing that can catch
 *     the skip being moved to the wrong side of the EZID call.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  extractEnrichmentSkips,
  extractEnrichmentSubErrors,
} from "../src/services/dataset-reindex";

const ENRICH_SOURCE = readFileSync(
  join(import.meta.dir, "../src/services/enrich-dataset.ts"),
  "utf-8",
);

describe("enrichDataset wires the skip BEFORE the EZID write", () => {
  test("the guard is evaluated, and it is evaluated first", () => {
    const guardAt = ENRICH_SOURCE.indexOf("refreshWouldStripAttribution(dataset, doiUploader)");
    const ezidWriteAt = ENRICH_SOURCE.indexOf("await updateIdentifier(ezidAuth");

    expect(guardAt).toBeGreaterThan(-1);
    expect(ezidWriteAt).toBeGreaterThan(-1);
    // Moving the guard after the write, or dropping it, is the regression
    // this file exists for: the push would then already have happened.
    expect(guardAt).toBeLessThan(ezidWriteAt);
  });

  test("the sync is the ELSE of the skip, so the two can never both run", () => {
    // `if (concept_doi && wouldStrip) { ...skip... } else if (concept_doi) { ...sync... }`
    // A refactor that turns the else-if into a second independent `if` would
    // skip AND push.
    const skipBranch = ENRICH_SOURCE.indexOf(
      "if (dataset.concept_doi && refreshWouldStripAttribution(dataset, doiUploader)) {",
    );
    const syncBranch = ENRICH_SOURCE.indexOf("} else if (dataset.concept_doi) {");
    expect(skipBranch).toBeGreaterThan(-1);
    expect(syncBranch).toBeGreaterThan(skipBranch);
    expect(ENRICH_SOURCE.indexOf("await updateIdentifier(ezidAuth")).toBeGreaterThan(syncBranch);
  });

  test("the skip is reported on the response body, not only logged", () => {
    // Without this the operator running a bulk reindex has no signal at all.
    expect(ENRICH_SOURCE).toContain("doi_sync: doiSyncOutcome");
    expect(ENRICH_SOURCE).toContain("reason: OWNER_NAME_MISSING_REASON");
  });
});

describe("a deliberate skip is a warning, never a failure (#1255 review item 26)", () => {
  const SKIP_BODY = {
    doi_sync: {
      status: "skipped",
      reason: "owner_name_missing",
      message: "DOI metadata sync skipped for nm000282: the owner has no researcher name.",
    },
  };

  test("the skip does NOT appear in the sub-ERROR list", () => {
    // It used to. `runEnrichmentForDataset` treats a non-empty sub-error list
    // as ok:false, so every reindex of a nameless-owner dataset reported
    // "failed" and logged "enrichment failed" -- burying the real failures in
    // the same batch behind the majority of the catalogue.
    expect(extractEnrichmentSubErrors(SKIP_BODY)).toEqual([]);
  });

  test("it appears in the skip list instead, with its reason and message", () => {
    const skips = extractEnrichmentSkips(SKIP_BODY);
    expect(skips).toHaveLength(1);
    expect(skips[0]).toContain("doi_sync: skipped (owner_name_missing)");
    expect(skips[0]).toContain("nm000282");
  });

  test("a real sub-error and a skip are reported through different channels", () => {
    const body = { commit_error: "push rejected", ...SKIP_BODY };
    expect(extractEnrichmentSubErrors(body)).toEqual(["commit_error: push rejected"]);
    expect(extractEnrichmentSkips(body)).toHaveLength(1);
  });

  test("a non-skip doi_sync object yields nothing", () => {
    expect(extractEnrichmentSkips({ doi_sync: { status: "ok" } })).toEqual([]);
    expect(extractEnrichmentSkips({ doi_sync: "nonsense" })).toEqual([]);
    expect(extractEnrichmentSkips({})).toEqual([]);
    expect(extractEnrichmentSkips(null)).toEqual([]);
  });

  test("runEnrichmentForDataset's own branch keeps ok:true for a skip-only body", () => {
    // The decision itself, read from the source it is made in: a skip-only
    // body must not take the ok:false branch. (The function calls
    // enrichDataset, which cannot be driven here -- see the file header.)
    const source = readFileSync(
      join(import.meta.dir, "../src/services/dataset-reindex.ts"),
      "utf-8",
    );
    const subErrorReturn = source.indexOf("return { ok: false, error: subErrors.join");
    const skipsAt = source.indexOf("const skips = extractEnrichmentSkips(outcome.body);");
    expect(subErrorReturn).toBeGreaterThan(-1);
    expect(skipsAt).toBeGreaterThan(subErrorReturn);
    // The skip path returns ok:true and carries `warnings`.
    expect(source.slice(skipsAt)).toContain("ok: true");
    expect(source.slice(skipsAt)).toContain("warnings: skips");
  });
});
