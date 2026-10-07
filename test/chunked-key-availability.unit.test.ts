/**
 * Chunk-aware presence through the CLI entry points: `keysWithoutObjects` (the
 * publish gate, the exemplar clone, content recovery) and `dataAvailability` (the
 * ADR 0064 share), both in src/lib/s3-server-copy.ts.
 *
 * The grammar and the presence rules live in shared/annex-key.ts and are covered
 * in test/annex-key.unit.test.ts; the Worker entry points are covered in
 * backend/test/import-integrity-chunked.test.ts. This file proves the CLI callers
 * reach the shared rule, so a regression in how a caller combines it is caught
 * where the caller is.
 *
 * Datasets uploaded through a chunked special remote (nm000276, chunk=1GiB) hold
 * only `<key with -S<size>-C<n>>` objects. Every presence check keyed on the plain
 * key called them missing (#1565), which is what made `nemar dataset status` say
 * "incomplete" and fleet tooling treat the content as lost.
 */

import { describe, expect, test } from "bun:test";
import * as workerModule from "../backend/src/services/import-integrity";
import * as sharedModule from "../shared/annex-key";
import * as cliModule from "../src/lib/s3-server-copy";
import {
  MIN_DATA_AVAILABILITY,
  dataAvailability,
  keysWithoutObjects,
} from "../src/lib/s3-server-copy";

const GiB = 1073741824;
const BASE_EEG = "SHA256E-s2500000000--abc.eeg";
const PLAIN = "SHA256E-s5--plain.edf";
const chunk = (n: number) => `SHA256E-s2500000000-S${GiB}-C${n}--abc.eeg`;
const LAST = 2500000000 - 2 * GiB;

type Entries = [string, number][];

/** BASE_EEG at 1 GiB: two full chunks and a 352,516,352-byte remainder. */
const complete1G = (): Entries => [
  [chunk(1), GiB],
  [chunk(2), GiB],
  [chunk(3), LAST],
];

describe("keysWithoutObjects with chunked content", () => {
  test("does not report a chunked key as missing", () => {
    const existing = new Map([["SHA256E-s982-S1073741824-C1--ba3d.vhdr", 982]]);
    expect(
      keysWithoutObjects(["SHA256E-s982--ba3d.vhdr", "SHA256E-s5--gone.edf"], existing),
    ).toEqual(["SHA256E-s5--gone.edf"]);
  });

  test("reports a chunked key whose chunk set is incomplete", () => {
    const missingTail = new Map<string, number>(complete1G().slice(0, 2));
    expect(keysWithoutObjects([BASE_EEG], missingTail)).toEqual([BASE_EEG]);
  });

  test("reports a key whose plain object is truncated, even beside a complete chunk set", () => {
    // The caller must not OR the chunk rule in over the plain one: the plain key is
    // what gets served, and it is short.
    for (const plainSize of [0, 7, 2500000001]) {
      const existing = new Map<string, number>([[BASE_EEG, plainSize], ...complete1G()]);
      expect(keysWithoutObjects([BASE_EEG], existing)).toEqual([BASE_EEG]);
    }
  });
});

describe("dataAvailability over a chunked dataset (ADR 0064)", () => {
  const annexed = [BASE_EEG, PLAIN];

  test("a chunked key with a complete chunk set leaves the data complete", () => {
    const listing = new Map<string, number>([[PLAIN, 5], ...complete1G()]);
    const missingContent = keysWithoutObjects(annexed, listing);
    expect(missingContent).toEqual([]);
    expect(dataAvailability({ annexed, missingContent })).toBe(1);
  });

  test("a chunked key with a short chunk costs availability", () => {
    const listing = new Map<string, number>([
      [PLAIN, 5],
      [chunk(1), GiB],
      [chunk(2), GiB],
      [chunk(3), LAST - 1],
    ]);
    const missingContent = keysWithoutObjects(annexed, listing);
    expect(missingContent).toEqual([BASE_EEG]);
    const available = dataAvailability({ annexed, missingContent });
    expect(available).toBe(0.5);
    expect(available).toBeLessThan(MIN_DATA_AVAILABILITY);
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
