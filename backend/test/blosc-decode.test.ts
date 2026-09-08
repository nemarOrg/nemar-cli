/**
 * `decodeBloscZstdInt16` against the real committed chunk fixture (epic
 * #1065 phase 2, issue #1294) -- promoted from the phase 1 spike's
 * `decode_chunk` verification, but now driving the production module
 * (`backend/src/services/blosc-decode.ts`) directly rather than the spike's
 * MCP tool wrapper.
 *
 * `chunk.bin` is one real inner chunk of nm000329's level-0 array (see
 * `chunk.expected.json`'s `source` field for exactly which shard/offset);
 * `chunk.expected.json` is the Python-derived ground truth (a real
 * `zstandard` decompress + manual unshuffle, cross-checked against
 * `numcodecs.Blosc().decode()`).
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decodeBloscZstdInt16 } from "../src/services/blosc-decode";

const FIXTURE_DIR = join(import.meta.dir, "fixtures/blosc");

const chunkBytes = new Uint8Array(readFileSync(join(FIXTURE_DIR, "chunk.bin")));
const expected = JSON.parse(readFileSync(join(FIXTURE_DIR, "chunk.expected.json"), "utf-8")) as {
  first_16_flat: number[];
  sum: number;
  weighted_checksum: number;
};

function checksum(values: Int16Array): { sum: number; weighted: number } {
  let sum = 0n;
  let weighted = 0n;
  for (let i = 0; i < values.length; i++) {
    const v = BigInt(values[i]);
    sum += v;
    weighted += v * BigInt(i + 1);
  }
  return { sum: Number(sum), weighted: Number(weighted) };
}

describe("decodeBloscZstdInt16", () => {
  test("decodes the fixture chunk and matches the Python-derived ground truth", () => {
    const decoded = decodeBloscZstdInt16(chunkBytes);
    expect(Array.from(decoded.slice(0, 16))).toEqual(expected.first_16_flat);
    const { sum, weighted } = checksum(decoded);
    expect(sum).toBe(expected.sum);
    expect(weighted).toBe(expected.weighted_checksum);
  });

  test("throws on a truncated buffer (shorter than the 16-byte header)", () => {
    expect(() => decodeBloscZstdInt16(chunkBytes.subarray(0, 8))).toThrow(
      /shorter than the 16-byte/,
    );
  });

  test("throws when typesize is mutated away from int16 (2)", () => {
    const mutated = chunkBytes.slice();
    mutated[3] = 4; // typesize byte
    expect(() => decodeBloscZstdInt16(mutated)).toThrow(/typesize 4 is not int16/);
  });

  test("throws when blocksize is mutated to 0", () => {
    const mutated = chunkBytes.slice();
    const view = new DataView(mutated.buffer);
    view.setUint32(8, 0, true); // blocksize field
    expect(() => decodeBloscZstdInt16(mutated)).toThrow(/invalid blosc2 header/);
  });

  test("throws when cbytes is mutated off by one from the real buffer length", () => {
    const mutated = chunkBytes.slice();
    const view = new DataView(mutated.buffer);
    const realCbytes = view.getUint32(12, true);
    view.setUint32(12, realCbytes + 1, true); // cbytes field
    expect(() => decodeBloscZstdInt16(mutated)).toThrow(/disagrees with the/);
  });

  test("throws when the buffer is truncated after the header (offset table does not fit)", () => {
    // The fixture is a single block (nbytes === blocksize), so its offset
    // table is exactly one 4-byte entry at bytes [16, 20). Truncating to 18
    // bytes -- and correcting cbytes to match, to isolate this guard from
    // the cbytes-length check above -- leaves the table one byte short.
    const truncated = chunkBytes.slice(0, 18);
    const view = new DataView(truncated.buffer);
    view.setUint32(12, truncated.length, true); // cbytes = the truncated length
    expect(() => decodeBloscZstdInt16(truncated)).toThrow(/offset table does not fit/);
  });
});
