/**
 * Chunk-aware presence through the Worker entry points: compareManifestToListing
 * and computeVersionIntegrity (services/import-integrity.ts), which feed
 * `data_complete`, `bytes_present` and the availability report.
 *
 * nm000276 (chunk=1GiB) showed "incomplete" because its chunk objects never matched
 * a plain key (#1565). The grammar and the presence rules are shared with the CLI
 * and covered in test/annex-key.unit.test.ts; this file proves the Worker reaches
 * them, and pins what the Worker adds: which keys are missing, which are zero-byte,
 * and what the byte totals count.
 */

import { describe, expect, test } from "bun:test";
import {
  compareManifestToListing,
  computeVersionIntegrity,
} from "../src/services/import-integrity";

const GiB = 1073741824;
const MiB512 = 536870912;
const BASE_EEG = "SHA256E-s2500000000--abc.eeg";
const chunk = (n: number) => `SHA256E-s2500000000-S${GiB}-C${n}--abc.eeg`;
const LAST = 2500000000 - 2 * GiB;

type Entries = [string, number][];

/** BASE_EEG at 1 GiB: two full chunks and a 352,516,352-byte remainder. */
const complete1G = (): Entries => [
  [chunk(1), GiB],
  [chunk(2), GiB],
  [chunk(3), LAST],
];

/** BASE_EEG at 512 MiB, first two of five chunks: an attempt that stopped. */
const partial512 = (): Entries => [
  [`SHA256E-s2500000000-S${MiB512}-C1--abc.eeg`, MiB512],
  [`SHA256E-s2500000000-S${MiB512}-C2--abc.eeg`, MiB512],
];

describe("compareManifestToListing with chunked content", () => {
  test("a fully chunked dataset is complete", () => {
    const manifest = {
      "sub-01/ieeg/a.vhdr": { key: "SHA256E-s982--ba3d.vhdr", size: 982 },
      "sub-01/ieeg/a.eeg": { key: BASE_EEG, size: 2500000000 },
      README: { key: "git:0123", size: 10 },
    };
    const existing = new Map<string, number>([
      ["SHA256E-s982-S1073741824-C1--ba3d.vhdr", 982],
      ...complete1G(),
    ]);
    const r = compareManifestToListing(manifest, existing);
    expect(r).toMatchObject({ complete: true, missingKeys: [], expectedCount: 2, presentCount: 2 });
  });

  test("a chunked key with an -m field counts, and a short last chunk does not", () => {
    const key = "WORM-s10-m1700000000--rec.edf";
    const c = (n: number) => `WORM-s10-m1700000000-S4-C${n}--rec.edf`;
    const manifest = { "sub-01/eeg/rec.edf": { key, size: 10 } };
    const whole = new Map([
      [c(1), 4],
      [c(2), 4],
      [c(3), 2],
    ]);
    expect(compareManifestToListing(manifest, whole)).toMatchObject({
      complete: true,
      missingKeys: [],
    });
    const short = new Map([
      [c(1), 4],
      [c(2), 4],
      [c(3), 1],
    ]);
    expect(compareManifestToListing(manifest, short).missingKeys).toEqual([key]);
  });

  test("a truncated plain object over complete chunks is missing, and zero-byte only at 0", () => {
    // A plain object that exists decides the answer, so the chunks beside it do not
    // rescue it, and the #967 zero-byte distinction is the plain object's own.
    const manifest = { "sub-01/ieeg/a.eeg": { key: BASE_EEG, size: 2500000000 } };
    const zero = compareManifestToListing(manifest, new Map([[BASE_EEG, 0], ...complete1G()]));
    expect(zero).toMatchObject({
      complete: false,
      missingKeys: [BASE_EEG],
      zeroByteKeys: [BASE_EEG],
    });
    const short = compareManifestToListing(manifest, new Map([[BASE_EEG, 7], ...complete1G()]));
    expect(short).toMatchObject({ complete: false, missingKeys: [BASE_EEG], zeroByteKeys: [] });
  });

  test("an oversized plain object over complete chunks is missing and not zero-byte", () => {
    const manifest = { "sub-01/ieeg/a.eeg": { key: BASE_EEG, size: 2500000000 } };
    const listing = new Map([[BASE_EEG, 2500000001], ...complete1G()]);
    expect(compareManifestToListing(manifest, listing)).toMatchObject({
      complete: false,
      missingKeys: [BASE_EEG],
      zeroByteKeys: [],
    });
  });

  test("a partial attempt at one chunk size does not hide a complete set at another", () => {
    const manifest = { "sub-01/ieeg/a.eeg": { key: BASE_EEG, size: 2500000000 } };
    for (const entries of [
      [...partial512(), ...complete1G()],
      [...complete1G(), ...partial512()],
    ]) {
      expect(compareManifestToListing(manifest, new Map(entries))).toMatchObject({
        complete: true,
        missingKeys: [],
      });
    }
    expect(compareManifestToListing(manifest, new Map(partial512())).missingKeys).toEqual([
      BASE_EEG,
    ]);
  });

  test("the nm000276 key is incomplete at C94 and complete with the C95 tail", () => {
    // s100969566208 at 1 GiB: 94 full chunks plus a 37,834,752-byte remainder.
    const key = "SHA256E-s100969566208--abc.eeg";
    const manifest = { "sub-01/ieeg/big.eeg": { key, size: 100969566208 } };
    const at = (n: number) => `SHA256E-s100969566208-S${GiB}-C${n}--abc.eeg`;
    const listing = new Map<string, number>(Array.from({ length: 94 }, (_, i) => [at(i + 1), GiB]));
    expect(compareManifestToListing(manifest, listing).missingKeys).toEqual([key]);
    listing.set(at(95), 37834752);
    expect(compareManifestToListing(manifest, listing)).toMatchObject({
      complete: true,
      missingKeys: [],
    });
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

describe("computeVersionIntegrity with a chunked listing", () => {
  const files = {
    "sub-01/ieeg/a.vhdr": { key: "SHA256E-s982--ba3d.vhdr", size: 982 },
    "sub-01/ieeg/a.eeg": { key: BASE_EEG, size: 2500000000 },
    README: { key: "git:0123", size: 10 },
  };
  const vhdrChunk: Entries = [["SHA256E-s982-S1073741824-C1--ba3d.vhdr", 982]];

  test("a chunked dataset is complete, with every chunk byte counted as present", () => {
    const listing = new Map<string, number>([...vhdrChunk, ...complete1G()]);
    const r = computeVersionIntegrity({ version: "1.0.0", files }, listing);
    expect(r).toMatchObject({
      complete: true,
      expectedCount: 2,
      presentCount: 2,
      missingKeys: [],
      bytesPresent: 982 + 2500000000,
      declaredBytes: 982 + 2500000000 + 10,
      declaredFiles: 3,
    });
  });

  test("a missing chunk makes it incomplete; the chunks that are there still count as bytes", () => {
    const listing = new Map<string, number>([...vhdrChunk, ...complete1G().slice(0, 2)]);
    const r = computeVersionIntegrity({ version: "1.0.0", files }, listing);
    expect(r).toMatchObject({
      complete: false,
      expectedCount: 2,
      presentCount: 1,
      missingKeys: [BASE_EEG],
      bytesPresent: 982 + 2 * GiB,
    });
  });

  test("bytesPresent counts every stored byte, so two co-existing chunkings both count", () => {
    // INTENDED. bytesPresent is the physical content under <id>/objects/ (what the
    // bucket holds and bills), distinct from declaredBytes, the logical size. A
    // finished 1 GiB chunking beside an abandoned 512 MiB attempt stores both, so
    // both are counted. Completeness is a separate question and stays true.
    const listing = new Map<string, number>([...vhdrChunk, ...partial512(), ...complete1G()]);
    const r = computeVersionIntegrity({ version: "1.0.0", files }, listing);
    expect(r.complete).toBe(true);
    expect(r.bytesPresent).toBe(982 + 2 * MiB512 + 2500000000);
    expect(r.declaredBytes).toBe(982 + 2500000000 + 10);
  });
});
