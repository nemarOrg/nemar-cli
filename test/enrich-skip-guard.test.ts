/**
 * Skip-guard decision table for the LLM enrichment pipeline.
 *
 * Pins the source_hash short-circuit in `decideSkipEnrichment`. This is
 * the actual fix for nemarOrg/nemar-cli#643 — without coverage, a
 * refactor that drops "enriched" from CACHED_PIPELINE_STAGES, flips the
 * `=== undefined` polarity, or rearranges precedence could silently
 * re-open the self-firing loop that burned ~60 runs/hr on on007827.
 */

import { describe, expect, test } from "bun:test";
import { decideSkipEnrichment } from "../backend/src/services/enrich-dataset";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

describe("decideSkipEnrichment (#643)", () => {
  describe("cached stage + matching hash → skip", () => {
    test('stage="validated" + matching hash → skip', () => {
      const d = decideSkipEnrichment({
        pipelineStage: "validated",
        existingSourceHash: HASH_A,
        currentSourceHash: HASH_A,
        forceReenrich: false,
      });
      expect(d.skip).toBe(true);
      if (d.skip) expect(d.reason).toContain('stage="validated"');
    });

    test('stage="enriched" + matching hash → skip (the #643 fix)', () => {
      // The pre-#643 guard only fired at "validated". Datasets stuck at
      // "enriched" (Stage 3 fails) ran forever because Haiku's
      // non-deterministic output kept .nemar/metadata.json "changed".
      // This test is the primary regression pin.
      const d = decideSkipEnrichment({
        pipelineStage: "enriched",
        existingSourceHash: HASH_A,
        currentSourceHash: HASH_A,
        forceReenrich: false,
      });
      expect(d.skip).toBe(true);
      if (d.skip) expect(d.reason).toContain('stage="enriched"');
    });
  });

  describe("cached stage + non-matching hash → proceed", () => {
    test('stage="validated" + hash mismatch → proceed with "sources changed" reason', () => {
      const d = decideSkipEnrichment({
        pipelineStage: "validated",
        existingSourceHash: HASH_A,
        currentSourceHash: HASH_B,
        forceReenrich: false,
      });
      expect(d.skip).toBe(false);
      if (!d.skip) expect(d.proceedReason).toContain("sources changed");
    });

    test('stage="enriched" + hash mismatch → proceed with "sources changed" reason', () => {
      const d = decideSkipEnrichment({
        pipelineStage: "enriched",
        existingSourceHash: HASH_A,
        currentSourceHash: HASH_B,
        forceReenrich: false,
      });
      expect(d.skip).toBe(false);
      if (!d.skip) expect(d.proceedReason).toContain("enriched");
    });
  });

  describe("source_hash undefined (migration arm)", () => {
    test('stage="validated", no source_hash → proceed with migration reason', () => {
      // Pre-#643 records lack source_hash. First run after the migration
      // must run the LLM (to compute the hash) and then can short-circuit
      // on subsequent runs.
      const d = decideSkipEnrichment({
        pipelineStage: "validated",
        existingSourceHash: undefined,
        currentSourceHash: HASH_A,
        forceReenrich: false,
      });
      expect(d.skip).toBe(false);
      if (!d.skip) expect(d.proceedReason).toContain("migration");
    });

    test('stage="enriched", no source_hash → proceed with migration reason', () => {
      const d = decideSkipEnrichment({
        pipelineStage: "enriched",
        existingSourceHash: undefined,
        currentSourceHash: HASH_A,
        forceReenrich: false,
      });
      expect(d.skip).toBe(false);
      if (!d.skip) expect(d.proceedReason).toContain("migration");
    });
  });

  describe("non-cached stages always proceed", () => {
    test('stage="seeded" + matching hash → proceed (must not silently expand cache)', () => {
      // CACHED_PIPELINE_STAGES intentionally excludes "seeded": a
      // seeded-only record hasn't had the LLM passes yet. If a future
      // refactor adds "seeded" to the set, this assertion catches it.
      const d = decideSkipEnrichment({
        pipelineStage: "seeded",
        existingSourceHash: HASH_A,
        currentSourceHash: HASH_A,
        forceReenrich: false,
      });
      expect(d.skip).toBe(false);
    });

    test("stage=undefined → proceed", () => {
      const d = decideSkipEnrichment({
        pipelineStage: undefined,
        existingSourceHash: HASH_A,
        currentSourceHash: HASH_A,
        forceReenrich: false,
      });
      expect(d.skip).toBe(false);
    });

    test('arbitrary unknown stage (e.g., "draft") → proceed', () => {
      // Defensive: malformed `.nemar/metadata.json` with an unknown
      // pipeline_stage should NOT be treated as cached.
      const d = decideSkipEnrichment({
        pipelineStage: "draft",
        existingSourceHash: HASH_A,
        currentSourceHash: HASH_A,
        forceReenrich: false,
      });
      expect(d.skip).toBe(false);
    });
  });

  describe("forceReenrich bypasses the guard", () => {
    test("force=true with cached stage + matching hash → proceed", () => {
      // workflow_dispatch with force=true is the manual recovery path.
      // Must override the skip even when the cache would say "no work".
      const d = decideSkipEnrichment({
        pipelineStage: "validated",
        existingSourceHash: HASH_A,
        currentSourceHash: HASH_A,
        forceReenrich: true,
      });
      expect(d.skip).toBe(false);
      if (!d.skip) expect(d.proceedReason).toContain("force");
    });

    test('force=true with stage="enriched" + matching hash → proceed', () => {
      const d = decideSkipEnrichment({
        pipelineStage: "enriched",
        existingSourceHash: HASH_A,
        currentSourceHash: HASH_A,
        forceReenrich: true,
      });
      expect(d.skip).toBe(false);
    });

    test("force=true with stage=undefined → proceed (no double-negative)", () => {
      const d = decideSkipEnrichment({
        pipelineStage: undefined,
        existingSourceHash: undefined,
        currentSourceHash: HASH_A,
        forceReenrich: true,
      });
      expect(d.skip).toBe(false);
    });
  });

  describe("edge cases that must not skip", () => {
    test("empty-string source_hash is distinct from undefined → mismatch with real hash proceeds", () => {
      // Defensive: if a tooling bug writes "" instead of undefined, we
      // must treat it as a real value and detect the mismatch.
      const d = decideSkipEnrichment({
        pipelineStage: "validated",
        existingSourceHash: "",
        currentSourceHash: HASH_A,
        forceReenrich: false,
      });
      expect(d.skip).toBe(false);
    });

    test('both source_hashes empty → would skip ("")  — documents the trade-off', () => {
      // Two empty strings are equal. This is fine: the only way both are
      // empty is if some external writer set them, and at that point we
      // trust the equality. If this ever bites, tighten to
      // `existingSourceHash.length > 0` here. Pinned so the trade-off is
      // explicit.
      const d = decideSkipEnrichment({
        pipelineStage: "validated",
        existingSourceHash: "",
        currentSourceHash: "",
        forceReenrich: false,
      });
      expect(d.skip).toBe(true);
    });
  });
});
