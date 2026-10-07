/**
 * The state `delete.test.ts` and `delete-preconditions.test.ts` share: one dataset carried through
 * plan, hash, assemble and verify once per file, and the helpers that read it. It is one module
 * so the two files, split only so that CI can run them on different runners, stay the same
 * fixture. Each test restores that state and a pristine working directory.
 */

import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { ZarrVerifiedFile } from "../../../scripts/scrub/contract";
import { type S3Standin, type Snapshot, startS3Standin } from "../helpers/s3-standin";
import {
  type Assembled,
  BUCKET,
  DATASET,
  type PublicEndpoint,
  SLOW,
  buildAssembled,
  copyDir,
  deleteRequests,
  fixtureA,
  fixtureB,
  fixtureD,
  has,
  objectPath,
  readJson,
  runScrub,
  seedManifest,
  sha256,
  startPublicEndpoint,
  verifyArgs,
  writeGitVerified,
  writeJson,
} from "./support";

export let standin: S3Standin;
export let pub: PublicEndpoint;
export let snap: Snapshot;
export let built: Assembled;
export let dir: string;

export const [a, b, d] = [fixtureA(), fixtureB(), fixtureD()];

/** Every version id, and delete marker, of one old key as seeded. */
export let oldIds: Record<string, string[]>;

export const assembledSha = () => sha256(readFileSync(path.join(dir, "assembled.json")));

/** Write both proofs for the assembled.json in `dir` as it is now. */
export function writeProofs(count = 2) {
  writeJson(dir, "verified.json", {
    version: 1,
    dataset: DATASET,
    verifiedAt: new Date().toISOString(),
    assembledSha256: assembledSha(),
    counts: { keys: count, headersChecked: count, rangesCompared: 0 },
  });
  writeJson(dir, "new-hash-verified.json", {
    version: 1,
    dataset: DATASET,
    assembledSha256: assembledSha(),
    count,
  });
}

/**
 * The proof the `zarr` stage leaves, made by the REAL stage over whatever Zarr objects the test
 * put in the stand-in, so the binding it checks is the binding the stage writes. `over` then
 * replaces fields of the proof, to make it stale.
 */
export async function proveZarr(over: Partial<ZarrVerifiedFile> = {}) {
  const r = await runScrub(standin, ["zarr", "--dir", dir, "--execute"]);
  if (r.exitCode !== 0) throw new Error(`the zarr stage failed: ${r.all}`);
  if (Object.keys(over).length > 0) {
    writeJson(dir, "zarr-verified.json", {
      ...readJson<ZarrVerifiedFile>(dir, "zarr-verified.json"),
      ...over,
    });
  }
}

/** A store root with an identifier key in it: the zarr stage rewrites it before it proves it. */
export const dirtyStore = JSON.stringify({
  zarr_format: 3,
  node_type: "group",
  attributes: { recording_metadata: { patientcode: "P0042", startdate: "02.02.20" } },
});
export const cleanStore = JSON.stringify({
  zarr_format: 3,
  node_type: "group",
  attributes: { recording_metadata: { startdate: "02.02.20" } },
});

export const deleteArgs = (extra: string[] = [], publicBase: string = pub.url) => [
  "delete-old",
  "--dir",
  dir,
  "--confirm-dataset",
  DATASET,
  "--public-base",
  publicBase,
  "--concurrency",
  "8",
  ...extra,
];
export const executeArgs = (extra: string[] = []) => deleteArgs(["--execute", ...extra]);

export const versionIdsOf = (key: string) =>
  standin.versions(BUCKET, objectPath(key)).map((v) => v.versionId);

/** The new key the privacy probe asks about: the first of the assembled new keys, sorted. */
export const firstNewKey = () => [a.newKey as string, b.newKey as string].sort()[0] as string;

/** Nothing was deleted: every old version and marker is still there. */
export function expectOldIntact() {
  expect(deleteRequests(standin)).toBe(0);
  for (const f of [a, b]) {
    expect(versionIdsOf(f.oldKey).sort()).toEqual([...(oldIds[f.oldKey] as string[])].sort());
  }
}

/**
 * Register the file's hooks: build the dataset once (`beforeAll`), then give every test the
 * stand-in as it was and a pristine copy of the working directory (`beforeEach`). A hook
 * registered at the top level of an IMPORTED module binds to the first importing file only, so
 * each test file calls this itself.
 */
export function useDeleteHarness(): void {
  beforeAll(async () => {
    standin = startS3Standin();
    pub = startPublicEndpoint();
    built = await buildAssembled(standin, [a, b, d], {
      // Older versions and a delete marker: more than one thing to delete per key.
      A: { olderVersions: 2, marker: true },
      B: { marker: true },
    });
    oldIds = {
      [a.oldKey]: versionIdsOf(a.oldKey),
      [b.oldKey]: versionIdsOf(b.oldKey),
    };
    const v = await runScrub(standin, verifyArgs(built.dir));
    if (v.exitCode !== 0) throw new Error(`verify failed: ${v.all}`);
    // Runbook step 12 has run: the manifest now names each scrubbed file by its new key. Its older
    // version (naming the old keys) is dropped here so the shared state has no history; the tests of
    // history put it back on purpose.
    const manifestKey = `${DATASET}/version/v1.0.0.json`;
    const original = standin.versions(BUCKET, manifestKey)[0]?.versionId as string;
    seedManifest(standin, "v1.0.0", [a, b, d], {}, DATASET, true);
    standin.dropVersion(BUCKET, manifestKey, original);
    const sha = sha256(readFileSync(path.join(built.dir, "assembled.json")));
    writeJson(built.dir, "new-hash-verified.json", {
      version: 1,
      dataset: DATASET,
      assembledSha256: sha,
      count: 2,
    });
    // Runbook step 14 has run: a fresh clone of the pushed repository verified.
    writeGitVerified(built.dir);
    snap = standin.snapshot();
  }, SLOW);

  afterAll(() => {
    standin?.stop();
    pub?.stop();
  });

  beforeEach(() => {
    standin.restore(snap);
    pub.reset();
    dir = copyDir(built.dir);
  });
}
