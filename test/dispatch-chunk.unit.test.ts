/**
 * Pure unit tests for chunkDatasetIds (src/commands/admin.ts), the batching
 * fix for the 256-job GitHub Actions matrix cap. onboard-openneuro.yml's copy
 * phase fans each dataset out into 8 shard jobs, so a single dispatch of more
 * than 32 datasets (256 / 8) silently instantiates 0 copy jobs instead of
 * erroring. No `gh` call, no network -- routes to the required unit-pure
 * tier.
 */

import { describe, expect, test } from "bun:test";
import { MAX_DATASETS_PER_DISPATCH, chunkDatasetIds } from "../src/commands/admin";

describe("chunkDatasetIds", () => {
  test("MAX_DATASETS_PER_DISPATCH is 30", () => {
    expect(MAX_DATASETS_PER_DISPATCH).toBe(30);
  });

  test("empty input -> no chunks", () => {
    expect(chunkDatasetIds([])).toEqual([]);
  });

  test("exactly at the cap (30) -> one chunk", () => {
    const ids = Array.from({ length: 30 }, (_, i) => `ds${i}`);
    const chunks = chunkDatasetIds(ids);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toEqual(ids);
  });

  test("31 ids -> [30, 1]", () => {
    const ids = Array.from({ length: 31 }, (_, i) => `ds${i}`);
    const chunks = chunkDatasetIds(ids);
    expect(chunks.map((c) => c.length)).toEqual([30, 1]);
  });

  test("45 ids -> [30, 15]", () => {
    const ids = Array.from({ length: 45 }, (_, i) => `ds${i}`);
    const chunks = chunkDatasetIds(ids);
    expect(chunks.map((c) => c.length)).toEqual([30, 15]);
  });

  test("60 ids -> [30, 30]", () => {
    const ids = Array.from({ length: 60 }, (_, i) => `ds${i}`);
    const chunks = chunkDatasetIds(ids);
    expect(chunks.map((c) => c.length)).toEqual([30, 30]);
  });

  test("total is preserved and order retained across chunks", () => {
    const ids = Array.from({ length: 73 }, (_, i) => `ds${String(i).padStart(6, "0")}`);
    const chunks = chunkDatasetIds(ids);
    expect(chunks.flat()).toEqual(ids);
  });

  test("a custom size is honored", () => {
    const ids = ["a", "b", "c", "d", "e"];
    expect(chunkDatasetIds(ids, 2)).toEqual([["a", "b"], ["c", "d"], ["e"]]);
  });
});
