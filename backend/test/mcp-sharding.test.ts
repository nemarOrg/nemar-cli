/**
 * Pure tests for `backend/src/mcp/sharding.ts` (epic #1065 phase 4, issue
 * #1296). No I/O -- these are footer arithmetic, footer parsing, and window
 * planning only.
 *
 * The real-footer test parses `backend/test/fixtures/mcp/nm000329-shard-index-c-0-0.bin`,
 * captured live and unmodified:
 *
 *   curl -s -A "nemar-cli/mcp-phase4" -H "Range: bytes=-1204" \
 *     -o backend/test/fixtures/mcp/nm000329-shard-index-c-0-0.bin \
 *     "https://nemar.s3.us-east-2.amazonaws.com/nm000329/zarr/sub-1/ses-0/eeg/sub-1_ses-0_task-imagery_acq-calibration_run-0_eeg.zarr/eeg_250hz/0/c/0/0"
 *
 * S3 answered `Content-Range: bytes 8969556-8970759/8970760` (captured
 * 2026-09-08) -- the shard's real total size is 8,970,760 bytes, confirmed
 * again below via `sum(nbytes) + 1204`.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  SHARD_ABSENT_MARKER,
  type ShardIndexEntry,
  chunkSampleSpan,
  footerByteLength,
  innerIndicesForWindowInShard,
  nInnerForShard,
  parseShardFooter,
  planShardReads,
  shardEntriesFromPairs,
  shardEntriesToPairs,
  shardsForWindow,
} from "../src/mcp/sharding.js";

describe("footerByteLength", () => {
  test("n_inner * 16 + 4", () => {
    expect(footerByteLength(75)).toBe(75 * 16 + 4);
    expect(footerByteLength(1)).toBe(20);
  });

  test("refuses a non-positive or non-integer nInner", () => {
    expect(() => footerByteLength(0)).toThrow();
    expect(() => footerByteLength(-1)).toThrow();
    expect(() => footerByteLength(1.5)).toThrow();
  });
});

describe("nInnerForShard", () => {
  // nm000329 eeg_250hz: shape [63, 138750], shard_samples 75000, chunk_samples 1000.
  const NM000329 = { shardSamples: 75000, chunkSamples: 1000, nSamples: 138750 };

  test("a full shard (shard 0) has ceil(75000/1000) = 75 inner chunks", () => {
    expect(nInnerForShard({ shardIndex: 0, ...NM000329 })).toBe(75);
  });

  test("the boundary (last) shard is truncated: ceil(63750/1000) = 64", () => {
    // shard 1 covers [75000, 138750) -- only 63750 samples remain.
    expect(nInnerForShard({ shardIndex: 1, ...NM000329 })).toBe(64);
  });

  test("a partial last shard with a non-round remainder still ceils correctly", () => {
    // A synthetic geometry: shard_samples 4000, chunk_samples 1000, nSamples
    // 6500 -- shard 1 covers [4000, 6500), 2500 samples, ceil(2500/1000) = 3.
    expect(
      nInnerForShard({ shardIndex: 1, shardSamples: 4000, chunkSamples: 1000, nSamples: 6500 }),
    ).toBe(3);
  });

  test("throws for a shard index entirely past nSamples", () => {
    expect(() => nInnerForShard({ shardIndex: 2, ...NM000329 })).toThrow();
  });
});

describe("parseShardFooter against the REAL captured nm000329 footer", () => {
  const bytes = new Uint8Array(
    readFileSync(new URL("./fixtures/mcp/nm000329-shard-index-c-0-0.bin", import.meta.url)),
  );

  test("the fixture is exactly 1204 bytes (75 entries)", () => {
    expect(bytes.length).toBe(1204);
    expect(footerByteLength(75)).toBe(1204);
  });

  test("parses to exactly 75 entries, all present", () => {
    const entries = parseShardFooter(bytes, 75);
    expect(entries.length).toBe(75);
    expect(entries.every((e) => e.present)).toBe(true);
  });

  test("offsets chain contiguously from 0", () => {
    const entries = parseShardFooter(bytes, 75);
    expect(entries[0].offset).toBe(0);
    for (let i = 1; i < entries.length; i++) {
      expect(entries[i].offset).toBe(entries[i - 1].offset + entries[i - 1].nbytes);
    }
  });

  test("sum(nbytes) + 1204 == 8_970_760, the shard's real Content-Length", () => {
    const entries = parseShardFooter(bytes, 75);
    const totalNbytes = entries.reduce((sum, e) => sum + e.nbytes, 0);
    expect(totalNbytes).toBe(8_969_556);
    expect(totalNbytes + 1204).toBe(8_970_760);
  });

  test("the first entry is offset 0, nbytes 119327 (the chunk render_overview's precedent decodes)", () => {
    const entries = parseShardFooter(bytes, 75);
    expect(entries[0]).toEqual({ offset: 0, nbytes: 119327, present: true });
  });

  test("refuses a byte length that does not match footerByteLength(nInner)", () => {
    expect(() => parseShardFooter(bytes, 74)).toThrow();
    expect(() => parseShardFooter(bytes, 76)).toThrow();
    expect(() => parseShardFooter(bytes.slice(1), 75)).toThrow();
  });
});

describe("parseShardFooter: the 2^64 - 1 absent marker", () => {
  function buildFooter(entries: Array<{ offset: bigint; nbytes: bigint }>): Uint8Array {
    const out = new Uint8Array(entries.length * 16 + 4);
    const view = new DataView(out.buffer);
    entries.forEach((e, i) => {
      view.setBigUint64(i * 16, e.offset, true);
      view.setBigUint64(i * 16 + 8, e.nbytes, true);
    });
    return out; // trailing 4 bytes (crc32c) left as zero -- never verified
  }

  test("an entry marked 2^64 - 1 in both fields parses as absent", () => {
    const bytes = buildFooter([
      { offset: 0n, nbytes: 100n },
      { offset: SHARD_ABSENT_MARKER, nbytes: SHARD_ABSENT_MARKER },
      { offset: 100n, nbytes: 50n },
    ]);
    const entries = parseShardFooter(bytes, 3);
    expect(entries[0]).toEqual({ offset: 0, nbytes: 100, present: true });
    expect(entries[1].present).toBe(false);
    expect(entries[2]).toEqual({ offset: 100, nbytes: 50, present: true });
  });

  test("a marker in only ONE of the two fields is still treated as absent (defensive)", () => {
    const bytes = buildFooter([{ offset: SHARD_ABSENT_MARKER, nbytes: 0n }]);
    const entries = parseShardFooter(bytes, 1);
    expect(entries[0].present).toBe(false);
  });
});

describe("shardsForWindow", () => {
  const SHARD_SAMPLES = 75000;

  test("a window inside one shard", () => {
    expect(shardsForWindow(1000, 2000, SHARD_SAMPLES)).toEqual([0]);
  });

  test("a window spanning two shards", () => {
    expect(shardsForWindow(74000, 76000, SHARD_SAMPLES)).toEqual([0, 1]);
  });

  test("a window ending exactly on a shard boundary excludes the next shard", () => {
    expect(shardsForWindow(70000, 75000, SHARD_SAMPLES)).toEqual([0]);
  });

  test("a window starting exactly on a shard boundary excludes the previous shard", () => {
    expect(shardsForWindow(75000, 76000, SHARD_SAMPLES)).toEqual([1]);
  });

  test("an empty (end <= start) window spans no shards", () => {
    expect(shardsForWindow(1000, 1000, SHARD_SAMPLES)).toEqual([]);
  });
});

describe("innerIndicesForWindowInShard", () => {
  const BASE = { shardIndex: 0, shardSamples: 75000, chunkSamples: 1000, nInnerThisShard: 75 };

  test("a window inside one chunk", () => {
    expect(
      innerIndicesForWindowInShard({ ...BASE, startSample: 1500, endSampleExclusive: 1800 }),
    ).toEqual([1]);
  });

  test("a window spanning two chunks", () => {
    expect(
      innerIndicesForWindowInShard({ ...BASE, startSample: 1500, endSampleExclusive: 2500 }),
    ).toEqual([1, 2]);
  });

  test("a window ending exactly on a chunk boundary does not pull in the next chunk", () => {
    expect(
      innerIndicesForWindowInShard({ ...BASE, startSample: 1000, endSampleExclusive: 2000 }),
    ).toEqual([1]);
  });

  test("a window starting exactly on a chunk boundary does not pull in the previous chunk", () => {
    expect(
      innerIndicesForWindowInShard({ ...BASE, startSample: 2000, endSampleExclusive: 2500 }),
    ).toEqual([2]);
  });

  test("a shard-relative window (shardIndex 1) offsets correctly", () => {
    expect(
      innerIndicesForWindowInShard({
        shardIndex: 1,
        shardSamples: 75000,
        chunkSamples: 1000,
        nInnerThisShard: 64,
        startSample: 75500,
        endSampleExclusive: 76500,
      }),
    ).toEqual([0, 1]);
  });
});

describe("chunkSampleSpan", () => {
  test("a mid-array chunk spans a full chunkSamples", () => {
    expect(
      chunkSampleSpan({
        shardIndex: 0,
        localIndex: 2,
        shardSamples: 75000,
        chunkSamples: 1000,
        nSamples: 138750,
      }),
    ).toEqual({ start: 2000, end: 3000 });
  });

  test("the boundary chunk of the boundary shard is truncated to the array's real extent", () => {
    // nm000329: shard 1 (starts at 75000) has 64 inner chunks; the last
    // (local index 63) covers [75000 + 63000, 138750) = [138000, 138750),
    // 750 samples -- not a full 1000.
    expect(
      chunkSampleSpan({
        shardIndex: 1,
        localIndex: 63,
        shardSamples: 75000,
        chunkSamples: 1000,
        nSamples: 138750,
      }),
    ).toEqual({ start: 138000, end: 138750 });
  });
});

describe("planShardReads: coalescing", () => {
  function present(offset: number, nbytes: number): ShardIndexEntry {
    return { offset, nbytes, present: true };
  }
  const absent: ShardIndexEntry = { offset: 0, nbytes: 0, present: false };

  test("a run of byte-adjacent, index-consecutive present entries coalesces into one range read", () => {
    const entries = [present(0, 100), present(100, 50), present(150, 75)];
    const reads = planShardReads(entries, [0, 1, 2]);
    expect(reads).toEqual([{ kind: "range", localIndices: [0, 1, 2], start: 0, end: 224 }]);
  });

  test("non-adjacent present entries (a gap in wanted indices) are NOT coalesced", () => {
    const entries = [present(0, 100), present(100, 50), present(150, 75), present(225, 40)];
    // Only local indices 0 and 3 are wanted -- not index-consecutive, so two reads.
    const reads = planShardReads(entries, [0, 3]);
    expect(reads).toEqual([
      { kind: "range", localIndices: [0], start: 0, end: 99 },
      { kind: "range", localIndices: [3], start: 225, end: 264 },
    ]);
  });

  test("an absent entry breaks a run and is its own kind: 'absent' read with no byte range", () => {
    const entries = [present(0, 100), absent, present(100, 50)];
    const reads = planShardReads(entries, [0, 1, 2]);
    expect(reads).toEqual([
      { kind: "range", localIndices: [0], start: 0, end: 99 },
      { kind: "absent", localIndices: [1] },
      { kind: "range", localIndices: [2], start: 100, end: 149 },
    ]);
  });

  test("index-consecutive but byte-NON-adjacent present entries do not coalesce (defensive)", () => {
    // Real shards chain contiguously (verified above), but the planner must
    // not assume it -- a gap in the byte offsets must still split the read.
    const entries = [present(0, 100), present(200, 50)];
    const reads = planShardReads(entries, [0, 1]);
    expect(reads).toEqual([
      { kind: "range", localIndices: [0], start: 0, end: 99 },
      { kind: "range", localIndices: [1], start: 200, end: 249 },
    ]);
  });

  test("wanted indices need not be sorted or deduplicated", () => {
    const entries = [present(0, 100), present(100, 50)];
    const reads = planShardReads(entries, [1, 0, 1, 0]);
    expect(reads).toEqual([{ kind: "range", localIndices: [0, 1], start: 0, end: 149 }]);
  });

  test("the real 75-entry nm000329 footer coalesces into ONE read end to end", () => {
    const bytes = new Uint8Array(
      readFileSync(new URL("./fixtures/mcp/nm000329-shard-index-c-0-0.bin", import.meta.url)),
    );
    const entries = parseShardFooter(bytes, 75);
    const reads = planShardReads(
      entries,
      Array.from({ length: 75 }, (_, i) => i),
    );
    expect(reads.length).toBe(1);
    expect(reads[0]).toEqual({
      kind: "range",
      localIndices: Array.from({ length: 75 }, (_, i) => i),
      start: 0,
      end: 8_969_555,
    });
  });

  test("throws when a wanted local index has no footer entry", () => {
    const entries = [present(0, 100)];
    expect(() => planShardReads(entries, [5])).toThrow();
  });
});

describe("shardEntriesToPairs / shardEntriesFromPairs (cache serialization)", () => {
  test("round-trips present and absent entries", () => {
    const entries: ShardIndexEntry[] = [
      { offset: 0, nbytes: 100, present: true },
      { offset: 0, nbytes: 0, present: false },
      { offset: 100, nbytes: 50, present: true },
    ];
    const pairs = shardEntriesToPairs(entries);
    expect(pairs).toEqual([
      [0, 100],
      [-1, -1],
      [100, 50],
    ]);
    expect(shardEntriesFromPairs(pairs)).toEqual(entries);
  });

  test("the real 75-entry nm000329 footer round-trips through pairs unchanged", () => {
    const bytes = new Uint8Array(
      readFileSync(new URL("./fixtures/mcp/nm000329-shard-index-c-0-0.bin", import.meta.url)),
    );
    const entries = parseShardFooter(bytes, 75);
    expect(shardEntriesFromPairs(shardEntriesToPairs(entries))).toEqual(entries);
  });
});
