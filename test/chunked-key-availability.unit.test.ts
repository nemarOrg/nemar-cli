/**
 * Chunk-aware key presence, driven through the CLI entry points
 * (`isKeyPresentAtDeclaredSize`, `keysWithoutObjects` in src/lib/s3-server-copy.ts).
 * The logic lives in shared/annex-key.ts and is shared with the Worker; the Worker
 * entry (`compareManifestToListing`) is covered in
 * backend/test/import-integrity-chunked.test.ts.
 *
 * Datasets uploaded through a chunked special remote (nm000276, chunk=1GiB)
 * hold only `<key-with -S<size>-C<n>>` objects. Every presence check keyed on
 * the plain key called them missing (#1565), which is what made
 * `nemar dataset status` say "incomplete" and fleet tooling treat the content
 * as lost.
 */

import { describe, expect, test } from "bun:test";
import * as workerModule from "../backend/src/services/import-integrity";
import {
  annexChunkKey,
  annexKeyDeclaredSize,
  annexKeyFieldSize,
  parseChunkKey,
} from "../shared/annex-key";
import * as sharedModule from "../shared/annex-key";
import * as cliModule from "../src/lib/s3-server-copy";
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

  test("annexChunkKey writes the name parseChunkKey reads", () => {
    expect(annexChunkKey("SHA256E-s982--ba3d.vhdr", GiB, 1)).toBe(
      "SHA256E-s982-S1073741824-C1--ba3d.vhdr",
    );
    expect(annexChunkKey("WORM-s10-m17--rec.edf", 4, 3)).toBe("WORM-s10-m17-S4-C3--rec.edf");
    expect(annexChunkKey("git:abc", 4, 1)).toBeNull();
    // Round trip, including a name that itself contains -- and chunk-shaped text.
    const key = "SHA256E-s5--a--b-S2-C1--c.edf";
    const name = annexChunkKey(key, 4, 2) as string;
    expect(parseChunkKey(name)).toEqual({ baseKey: key, chunkSize: 4, chunkNumber: 2 });
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

  // FLIPPED from the contributor's version, deliberately. The first cut pinned
  // "a truncated plain object is rescued by a complete chunk set" as present. The
  // data plane serves the PLAIN key, so a short plain object beside complete
  // chunks is the #967 signature (a listing that says complete over a served
  // object that is short), which is worse than absent. Chunks are consulted only
  // when the plain object is absent.
  test("a truncated plain object is NOT rescued by a complete chunk set", () => {
    const chunks = [
      [chunk(1), GiB],
      [chunk(2), GiB],
      [chunk(3), LAST],
    ] as [string, number][];
    expect(isKeyPresentAtDeclaredSize(BASE_EEG, new Map([[BASE_EEG, 0], ...chunks]))).toBe(false);
    expect(isKeyPresentAtDeclaredSize(BASE_EEG, new Map([[BASE_EEG, 7], ...chunks]))).toBe(false);
    expect(isKeyPresentAtDeclaredSize(BASE_EEG, new Map([[BASE_EEG, 7]]))).toBe(false);
  });

  test("a plain object at its declared size is present with or without chunks", () => {
    expect(isKeyPresentAtDeclaredSize(BASE_EEG, new Map([[BASE_EEG, 2500000000]]))).toBe(true);
    expect(
      isKeyPresentAtDeclaredSize(
        BASE_EEG,
        new Map([
          [BASE_EEG, 2500000000],
          [chunk(1), GiB],
        ]),
      ),
    ).toBe(true);
  });

  test("chunks added to a listing after the first lookup are seen", () => {
    const existing = new Map<string, number>([[chunk(1), GiB]]);
    expect(isKeyPresentAtDeclaredSize(BASE_EEG, existing)).toBe(false);
    existing.set(chunk(2), GiB);
    existing.set(chunk(3), LAST);
    expect(isKeyPresentAtDeclaredSize(BASE_EEG, existing)).toBe(true);
  });

  test("a chunk size first seen after the first lookup is tried too", () => {
    // The cached scan holds only the 512 MiB size after the first lookup. Growing
    // the listing with a complete 1 GiB set must invalidate it; a stale scan would
    // never try 1 GiB and keep answering absent.
    const MiB512 = 536870912;
    const existing = new Map<string, number>([
      [`SHA256E-s2500000000-S${MiB512}-C1--abc.eeg`, MiB512],
    ]);
    expect(isKeyPresentAtDeclaredSize(BASE_EEG, existing)).toBe(false);
    existing.set(chunk(1), GiB);
    existing.set(chunk(2), GiB);
    existing.set(chunk(3), LAST);
    expect(isKeyPresentAtDeclaredSize(BASE_EEG, existing)).toBe(true);
  });
});

/** Chunk object name for `key`'s `abc.eeg` file at an arbitrary chunk size. */
const chunkAt = (size: number, chunkSize: number, n: number) =>
  `SHA256E-s${size}-S${chunkSize}-C${n}--abc.eeg`;

describe("chunk geometry and edge cases", () => {
  // nm000276: the issue lists C1..C94 and the key is s100969566208. At 1 GiB that
  // is 94 full chunks and a 37,834,752-byte remainder, so 95 chunks: the listing in
  // the issue is INCOMPLETE without C95.
  const NM276 = 100969566208;
  const NM276_KEY = `SHA256E-s${NM276}--abc.eeg`;
  const NM276_TAIL = 37834752;
  const nm276 = (n: number) => chunkAt(NM276, GiB, n);
  const firstNinetyFour = () =>
    new Map<string, number>(Array.from({ length: 94 }, (_, i) => [nm276(i + 1), GiB]));

  test("the nm000276 vector: 94 full chunks plus a 37,834,752-byte tail", () => {
    // Guard the constants, so the vector cannot drift from the issue's numbers.
    expect(94 * GiB + NM276_TAIL).toBe(NM276);
    const listing = firstNinetyFour();
    expect(isKeyPresentAtDeclaredSize(NM276_KEY, listing)).toBe(false);
    listing.set(nm276(95), NM276_TAIL);
    expect(isKeyPresentAtDeclaredSize(NM276_KEY, listing)).toBe(true);
  });

  test("the last chunk must be the remainder, not a full chunk and not short", () => {
    const full = firstNinetyFour().set(nm276(95), GiB);
    expect(isKeyPresentAtDeclaredSize(NM276_KEY, full)).toBe(false);
    const short = firstNinetyFour().set(nm276(95), NM276_TAIL - 1);
    expect(isKeyPresentAtDeclaredSize(NM276_KEY, short)).toBe(false);
  });

  test("an oversized chunk makes the key absent", () => {
    const middle = new Map([
      [chunk(1), GiB],
      [chunk(2), GiB + 1],
      [chunk(3), LAST],
    ]);
    expect(isKeyPresentAtDeclaredSize(BASE_EEG, middle)).toBe(false);
    const last = new Map([
      [chunk(1), GiB],
      [chunk(2), GiB],
      [chunk(3), LAST + 1],
    ]);
    expect(isKeyPresentAtDeclaredSize(BASE_EEG, last)).toBe(false);
  });

  test("an empty file needs chunk 1 at 0 bytes, not just some chunk of the key", () => {
    const key = "SHA256E-s0--e.edf";
    const at = (n: number) => `SHA256E-s0-S1048576-C${n}--e.edf`;
    // Only C2: there is no chunk 1, so the file cannot be reassembled.
    expect(isKeyPresentAtDeclaredSize(key, new Map([[at(2), 0]]))).toBe(false);
    // A C1 that is not empty is not an empty file's chunk.
    expect(isKeyPresentAtDeclaredSize(key, new Map([[at(1), 1]]))).toBe(false);
    // Nothing at all.
    expect(isKeyPresentAtDeclaredSize(key, new Map([["SHA256E-s9-S4-C1--other.edf", 4]]))).toBe(
      false,
    );
    expect(isKeyPresentAtDeclaredSize(key, new Map([[at(1), 0]]))).toBe(true);
  });

  test("a key with no declared size is never present through chunks", () => {
    const unsized = "SHA256E--nosize.edf";
    const listing = new Map([["SHA256E-S4-C1--nosize.edf", 4]]);
    expect(isKeyPresentAtDeclaredSize(unsized, listing)).toBe(false);
    // The plain-object contract for an unsized key is unchanged: present if listed.
    expect(isKeyPresentAtDeclaredSize(unsized, new Map([[unsized, 5]]))).toBe(true);
    // A non-annex key absent from the listing is absent, with chunk objects around.
    expect(isKeyPresentAtDeclaredSize("git:abc", new Map([[chunk(1), GiB]]))).toBe(false);
  });

  test("another key's chunks do not make this key present", () => {
    const listing = new Map([
      [chunk(1), GiB],
      [chunk(2), GiB],
      [chunk(3), LAST],
    ]);
    expect(isKeyPresentAtDeclaredSize("SHA256E-s2500000000--other.eeg", listing)).toBe(false);
    expect(isKeyPresentAtDeclaredSize("SHA256E-s2500000001--abc.eeg", listing)).toBe(false);
  });

  describe("two chunk sizes for one key in one listing", () => {
    const SIZE = 2500000000;
    const MiB512 = 536870912;
    // 512 MiB chunking is 5 chunks: 4 full and a 352,516,352-byte tail.
    const TAIL512 = SIZE - 4 * MiB512;
    const key = `SHA256E-s${SIZE}--abc.eeg`;
    const partial512: [string, number][] = [
      [chunkAt(SIZE, MiB512, 1), MiB512],
      [chunkAt(SIZE, MiB512, 2), MiB512],
    ];
    const complete1G: [string, number][] = [
      [chunkAt(SIZE, GiB, 1), GiB],
      [chunkAt(SIZE, GiB, 2), GiB],
      [chunkAt(SIZE, GiB, 3), LAST],
    ];
    const complete512: [string, number][] = [
      ...Array.from({ length: 4 }, (_, i): [string, number] => [
        chunkAt(SIZE, MiB512, i + 1),
        MiB512,
      ]),
      [chunkAt(SIZE, MiB512, 5), TAIL512],
    ];
    const partial1G: [string, number][] = [[chunkAt(SIZE, GiB, 1), GiB]];

    test("a partial attempt and a complete set: present in either insertion order", () => {
      expect(isKeyPresentAtDeclaredSize(key, new Map([...partial512, ...complete1G]))).toBe(true);
      expect(isKeyPresentAtDeclaredSize(key, new Map([...complete1G, ...partial512]))).toBe(true);
      expect(isKeyPresentAtDeclaredSize(key, new Map([...partial1G, ...complete512]))).toBe(true);
      expect(isKeyPresentAtDeclaredSize(key, new Map([...complete512, ...partial1G]))).toBe(true);
    });

    test("two partial attempts: absent in either insertion order", () => {
      expect(isKeyPresentAtDeclaredSize(key, new Map([...partial512, ...partial1G]))).toBe(false);
      expect(isKeyPresentAtDeclaredSize(key, new Map([...partial1G, ...partial512]))).toBe(false);
    });
  });
});

describe("one definition shared by the CLI and the Worker", () => {
  test("both modules re-export the shared functions, not copies", () => {
    for (const name of ["annexKeyDeclaredSize", "isKeyPresentAtDeclaredSize"] as const) {
      expect(cliModule[name]).toBe(sharedModule[name]);
      expect(workerModule[name]).toBe(sharedModule[name]);
    }
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
