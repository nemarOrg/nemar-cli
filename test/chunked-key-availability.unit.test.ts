/**
 * Chunk-aware key presence (CLI copy, src/lib/s3-server-copy.ts).
 *
 * Datasets uploaded through a chunked special remote (nm000276, chunk=1GiB)
 * hold only `<key-with -S<size>-C<n>>` objects. Every presence check keyed on
 * the plain key called them missing (#1565), which is what made
 * `nemar dataset status` say "incomplete" and fleet tooling treat the content
 * as lost.
 */

import { describe, expect, test } from "bun:test";
import { annexKeyDeclaredSize, annexKeyFieldSize, parseChunkKey } from "../shared/annex-key";
import { isKeyPresentAtDeclaredSize, keysWithoutObjects } from "../src/lib/s3-server-copy";

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

  test("parseChunkKey reads only the fields before the first --", () => {
    // The same text inside the free-text name is not a chunk.
    expect(parseChunkKey("WORM-m17--x-s5-S4-C1--y")).toBeNull();
    expect(parseChunkKey("SHA256E-s5--a-S4-C1--b.edf")).toBeNull();
    // A zero chunk number or size is not a chunk.
    expect(parseChunkKey("SHA256E-s5-S4-C0--a")).toBeNull();
    expect(parseChunkKey("SHA256E-s5-S0-C1--a")).toBeNull();
    // A pair that is not the last field is not a chunk.
    expect(parseChunkKey("SHA256E-s5-S4-C1-m17--a")).toBeNull();
  });

  test("annexKeyFieldSize reads -s past -m, from the fields only", () => {
    expect(annexKeyFieldSize("SHA256E-s982--ba3d.vhdr")).toBe(982);
    expect(annexKeyFieldSize("WORM-s5-m17--x")).toBe(5);
    expect(annexKeyFieldSize("SHA256E-s0--e.edf")).toBe(0);
    // A -sN inside the free-text name is not a size.
    expect(annexKeyFieldSize("WORM-m17--sub-01-s5--x.edf")).toBeNull();
    expect(annexKeyFieldSize("git:abc")).toBeNull();
    expect(annexKeyFieldSize("SHA256E-s5")).toBeNull();
  });

  test("a plain -m key keeps its present-if-listed contract", () => {
    // annexKeyDeclaredSize is unchanged: it returns null for a -m key, so a
    // listed plain object is present at any size. Only the chunk path reads -m.
    expect(annexKeyDeclaredSize("WORM-s5-m17--x")).toBeNull();
    expect(isKeyPresentAtDeclaredSize("WORM-s5-m17--x", new Map([["WORM-s5-m17--x", 99]]))).toBe(
      true,
    );
  });

  test("a chunked key with an -m field is present when its chunks are complete", () => {
    const key = "WORM-s10-m1700000000--rec.edf";
    const c = (n: number) => `WORM-s10-m1700000000-S4-C${n}--rec.edf`;
    expect(
      isKeyPresentAtDeclaredSize(
        key,
        new Map([
          [c(1), 4],
          [c(2), 4],
          [c(3), 2],
        ]),
      ),
    ).toBe(true);
  });

  test("a chunked key with an -m field and a missing or short chunk is absent", () => {
    const key = "WORM-s10-m1700000000--rec.edf";
    const c = (n: number) => `WORM-s10-m1700000000-S4-C${n}--rec.edf`;
    expect(
      isKeyPresentAtDeclaredSize(
        key,
        new Map([
          [c(1), 4],
          [c(3), 2],
        ]),
      ),
    ).toBe(false);
    expect(
      isKeyPresentAtDeclaredSize(
        key,
        new Map([
          [c(1), 4],
          [c(2), 4],
          [c(3), 1],
        ]),
      ),
    ).toBe(false);
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

describe("keysWithoutObjects with chunked content", () => {
  test("does not report a chunked key as missing", () => {
    const existing = new Map([["SHA256E-s982-S1073741824-C1--ba3d.vhdr", 982]]);
    expect(
      keysWithoutObjects(["SHA256E-s982--ba3d.vhdr", "SHA256E-s5--gone.edf"], existing),
    ).toEqual(["SHA256E-s5--gone.edf"]);
  });
});
