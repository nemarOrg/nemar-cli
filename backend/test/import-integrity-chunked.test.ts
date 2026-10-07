/**
 * Chunk-aware key presence (Workers copy, services/import-integrity.ts).
 *
 * verifyDatasetVersionS3 -> compareManifestToListing feeds `data_complete`,
 * which `nemar dataset status` prints. nm000276 (chunk=1GiB) showed
 * "incomplete" although every chunk object was in the bucket (#1565).
 */

import { describe, expect, test } from "bun:test";
import { parseChunkKey } from "../../shared/annex-key";
import {
  compareManifestToListing,
  isKeyPresentAtDeclaredSize,
} from "../src/services/import-integrity";

const GiB = 1073741824;
const BASE_EEG = "SHA256E-s2500000000--abc.eeg";
const chunk = (n: number) => `SHA256E-s2500000000-S${GiB}-C${n}--abc.eeg`;
const LAST = 2500000000 - 2 * GiB;

describe("chunked annex keys (#1565, nm000276)", () => {
  test("parseChunkKey recovers the whole-file key", () => {
    expect(parseChunkKey(chunk(3))).toEqual({ baseKey: BASE_EEG, chunkSize: GiB, chunkNumber: 3 });
    expect(parseChunkKey("SHA256E-s982-S1073741824-C1--ba3d.vhdr")).toEqual({
      baseKey: "SHA256E-s982--ba3d.vhdr",
      chunkSize: GiB,
      chunkNumber: 1,
    });
    expect(parseChunkKey("WORM-s5-m1700000000-S4-C2--name.edf")).toEqual({
      baseKey: "WORM-s5-m1700000000--name.edf",
      chunkSize: 4,
      chunkNumber: 2,
    });
    expect(parseChunkKey(BASE_EEG)).toBeNull();
    expect(parseChunkKey("git:abc")).toBeNull();
  });

  test("a key stored only as complete chunks is present", () => {
    const existing = new Map([
      [chunk(1), GiB],
      [chunk(2), GiB],
      [chunk(3), LAST],
    ]);
    expect(isKeyPresentAtDeclaredSize(BASE_EEG, existing)).toBe(true);
    // A one-chunk file (the .vhdr case from the issue).
    const small = new Map([["SHA256E-s982-S1073741824-C1--ba3d.vhdr", 982]]);
    expect(isKeyPresentAtDeclaredSize("SHA256E-s982--ba3d.vhdr", small)).toBe(true);
  });

  test("a missing or short chunk makes the key absent", () => {
    expect(
      isKeyPresentAtDeclaredSize(
        BASE_EEG,
        new Map([
          [chunk(1), GiB],
          [chunk(3), LAST],
        ]),
      ),
    ).toBe(false);
    expect(
      isKeyPresentAtDeclaredSize(
        BASE_EEG,
        new Map([
          [chunk(1), GiB],
          [chunk(2), GiB - 1],
          [chunk(3), LAST],
        ]),
      ),
    ).toBe(false);
    expect(
      isKeyPresentAtDeclaredSize(
        BASE_EEG,
        new Map([
          [chunk(1), GiB],
          [chunk(2), GiB],
        ]),
      ),
    ).toBe(false);
  });

  test("an empty file stored as one empty chunk is present", () => {
    expect(
      isKeyPresentAtDeclaredSize(
        "SHA256E-s0--e.edf",
        new Map([["SHA256E-s0-S1048576-C1--e.edf", 0]]),
      ),
    ).toBe(true);
  });

  test("a truncated plain object is rescued by a complete chunk set, not the reverse", () => {
    const existing = new Map([
      [BASE_EEG, 0],
      [chunk(1), GiB],
      [chunk(2), GiB],
      [chunk(3), LAST],
    ]);
    expect(isKeyPresentAtDeclaredSize(BASE_EEG, existing)).toBe(true);
    expect(isKeyPresentAtDeclaredSize(BASE_EEG, new Map([[BASE_EEG, 7]]))).toBe(false);
  });

  test("the chunk index follows a listing that grows after the first lookup", () => {
    const existing = new Map<string, number>([[chunk(1), GiB]]);
    expect(isKeyPresentAtDeclaredSize(BASE_EEG, existing)).toBe(false);
    existing.set(chunk(2), GiB);
    existing.set(chunk(3), LAST);
    expect(isKeyPresentAtDeclaredSize(BASE_EEG, existing)).toBe(true);
  });
});

describe("compareManifestToListing with chunked content", () => {
  test("a fully chunked dataset is complete", () => {
    const manifest = {
      "sub-01/ieeg/a.vhdr": { key: "SHA256E-s982--ba3d.vhdr", size: 982 },
      "sub-01/ieeg/a.eeg": { key: BASE_EEG, size: 2500000000 },
      README: { key: "git:0123", size: 10 },
    };
    const existing = new Map([
      ["SHA256E-s982-S1073741824-C1--ba3d.vhdr", 982],
      [chunk(1), GiB],
      [chunk(2), GiB],
      [chunk(3), LAST],
    ]);
    const r = compareManifestToListing(manifest, existing);
    expect(r).toMatchObject({ complete: true, missingKeys: [], expectedCount: 2, presentCount: 2 });
  });

  test("a dataset missing one chunk is still incomplete, naming the whole-file key", () => {
    const manifest = { "sub-01/ieeg/a.eeg": { key: BASE_EEG, size: 2500000000 } };
    const existing = new Map([
      [chunk(1), GiB],
      [chunk(3), LAST],
    ]);
    const r = compareManifestToListing(manifest, existing);
    expect(r.complete).toBe(false);
    expect(r.missingKeys).toEqual([BASE_EEG]);
  });
});
