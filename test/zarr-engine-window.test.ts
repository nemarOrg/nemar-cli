/**
 * `rangeCeiling` (src/lib/zarr-engine/window.ts): the most bytes one `Range` read of a window
 * may ask for. The hostile side (a footer claiming more is refused) is proven in
 * zarr-engine-runtime.test.ts; these tests pin the LEGITIMATE side, which the runtime fixtures
 * cannot (they compress well, so a ceiling that is too tight would still pass there).
 */

import { describe, expect, test } from "bun:test";
import { rangeCeiling, windowByteBudget } from "../src/lib/zarr-engine/window.js";

/** The worst case for one stored chunk: the raw bytes plus at most 32 bytes of blosc2 overhead
 *  (BLOSC2_MAX_OVERHEAD), in a chunk that is still stored compressed (the decoder refuses a
 *  memcpyed frame). Independent of the engine's own constant. */
const BLOSC2_MAX_OVERHEAD = 32;

describe("rangeCeiling", () => {
  test("exact value: two chunks of every channel plus 64 bytes each", () => {
    // 2 channels, 100-sample chunks, a 100-sample window: ceil(100/100) + 1 = 2 chunks of
    // 2 * 100 * 2 = 400 bytes, each + 64.
    expect(rangeCeiling({ nChannels: 2, chunkSamples: 100, nInner: 10, nSamples: 100 })).toBe(
      2 * (400 + 64),
    );
  });

  test("exact value: a store with tiny chunks is floored at its footer length", () => {
    // 2 * (2 * 10 * 2 + 64) = 208 bytes of chunks, but the footer read is 200 * 16 + 4 bytes.
    expect(rangeCeiling({ nChannels: 2, chunkSamples: 10, nInner: 200, nSamples: 10 })).toBe(3204);
  });

  test("every window, at every alignment, fits incompressible chunks and its footer", () => {
    // About 27 million comparisons: each is checked in plain code and every violation is
    // collected, then asserted once, because one expect() per comparison took over the default
    // 5 s timeout on a CI runner.
    const violations: string[] = [];
    for (const nChannels of [1, 3, 129]) {
      for (const chunkSamples of [1, 7, 10, 100, 1000]) {
        for (const nInner of [1, 4, 200]) {
          const shardSamples = chunkSamples * nInner;
          for (let nSamples = 1; nSamples <= 3 * chunkSamples + 1; nSamples++) {
            const ceiling = rangeCeiling({ nChannels, chunkSamples, nInner, nSamples });
            const footer = nInner * 16 + 4;
            const where = JSON.stringify({ nChannels, chunkSamples, nInner, nSamples });
            if (!(ceiling >= footer)) violations.push(`footer ${where}: ${ceiling} < ${footer}`);
            for (let start = 0; start < chunkSamples; start++) {
              const first = Math.floor(start / chunkSamples);
              const last = Math.floor((start + nSamples - 1) / chunkSamples);
              // One coalesced read never crosses a shard: count the most chunks of one shard.
              let most = 0;
              for (let c = first; c <= last; ) {
                const shardEnd = (Math.floor(c / nInner) + 1) * nInner - 1;
                const upTo = Math.min(last, shardEnd);
                most = Math.max(most, upTo - c + 1);
                c = upTo + 1;
              }
              const worst = most * (nChannels * chunkSamples * 2 + BLOSC2_MAX_OVERHEAD);
              if (!(ceiling >= worst)) {
                violations.push(
                  `start ${start} ${where} (shard ${shardSamples}): ${ceiling} < ${worst}`,
                );
              }
            }
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });
});

describe("windowByteBudget", () => {
  test("exact value: the chunks the window can touch plus one footer per shard it touches", () => {
    // 2 channels, 100-sample chunks, 10 per shard (1000-sample shards). A 100-sample window at
    // 950 crosses the shard boundary: 2 chunks of 2 * 100 * 2 + 64 bytes and 2 footers of
    // 10 * 16 + 4.
    const geometry = { nChannels: 2, chunkSamples: 100, shardSamples: 1000, nInner: 10 };
    expect(windowByteBudget({ ...geometry, startSample: 950, nSamples: 100 })).toBe(
      2 * (400 + 64) + 2 * 164,
    );
    expect(windowByteBudget({ ...geometry, startSample: 0, nSamples: 100 })).toBe(
      2 * (400 + 64) + 164,
    );
  });

  test("every window, at every alignment, fits its incompressible chunks and every footer", () => {
    // The legitimate side: a cold read of a window asks for every footer of the shards it
    // touches and every chunk it touches, each chunk at worst its raw bytes plus 32.
    const violations: string[] = [];
    for (const nChannels of [1, 3, 129]) {
      for (const chunkSamples of [1, 7, 100]) {
        for (const nInner of [1, 4, 50]) {
          const shardSamples = chunkSamples * nInner;
          const footer = nInner * 16 + 4;
          for (let nSamples = 1; nSamples <= 2 * shardSamples + 1; nSamples++) {
            for (let start = 0; start < shardSamples + chunkSamples; start++) {
              const end = start + nSamples - 1;
              const chunks = Math.floor(end / chunkSamples) - Math.floor(start / chunkSamples) + 1;
              const shards = Math.floor(end / shardSamples) - Math.floor(start / shardSamples) + 1;
              const worst =
                chunks * (nChannels * chunkSamples * 2 + BLOSC2_MAX_OVERHEAD) + shards * footer;
              const budget = windowByteBudget({
                nChannels,
                chunkSamples,
                shardSamples,
                nInner,
                startSample: start,
                nSamples,
              });
              if (!(budget >= worst)) {
                violations.push(
                  `${JSON.stringify({ nChannels, chunkSamples, nInner, start, nSamples })}: ${budget} < ${worst}`,
                );
              }
            }
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
