/**
 * The verify stage, run as the real CLI against the S3 stand-in. One dataset is carried through
 * plan, hash and assemble once; each test restores that state, damages one thing in the new
 * objects the way a real fault would, and expects verify to name it and to write no proof.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  type AssembledFile,
  type VerifiedFile,
  parseVerified,
} from "../../../scripts/scrub/contract";
import { sampleRanges } from "../../../scripts/scrub/s3/s3-lib";
import { type S3Standin, type Snapshot, startS3Standin } from "../helpers/s3-standin";
import { expectStopped } from "./refusal";
import {
  type Assembled,
  BUCKET,
  DATASET,
  type Fixture,
  SLOW,
  addUnreadableKey,
  buildAssembled,
  centuryFromNow,
  copyDir,
  fileSha256,
  fixtureA,
  fixtureB,
  fixtureC,
  has,
  objectPath,
  readJson,
  rebindPatches,
  removeTempDirs,
  runScrub,
  sha256,
  verifyArgs,
  writeJson,
} from "./support";

afterAll(removeTempDirs);

let standin: S3Standin;
let snap: Snapshot;
let built: Assembled;
let dir: string;

const [a, b, c] = [fixtureA(), fixtureB(), fixtureC()];

beforeAll(async () => {
  standin = startS3Standin();
  built = await buildAssembled(standin, [a, b, c]);
  snap = standin.snapshot();
}, SLOW);

afterAll(() => standin?.stop());

beforeEach(() => {
  standin.restore(snap);
  dir = copyDir(built.dir);
});

const assembled = () => readJson<AssembledFile>(dir, "assembled.json");
const newVersion = (f: Fixture) =>
  (assembled().entries[f.oldKey] as { newVersionId: string }).newVersionId;
const newKeyPath = (f: Fixture) => objectPath(f.newKey as string);

describe("verify", () => {
  test(
    "a good assembly passes, and the proof names the exact bytes of assembled.json",
    async () => {
      const r = await runScrub(standin, verifyArgs(dir));
      expect(r.exitCode, r.all).toBe(0);
      const proof = parseVerified(JSON.stringify(readJson<VerifiedFile>(dir, "verified.json")));
      // The hash is computed here from the file's bytes, independently of the stage.
      expect(proof.assembledSha256).toBe(sha256(readFileSync(path.join(dir, "assembled.json"))));
      expect(proof.assembledSha256).toBe(fileSha256(dir, "assembled.json"));
      expect(proof.dataset).toBe(DATASET);
      expect(proof.counts.keys).toBe(3);
      expect(proof.counts.headersChecked).toBe(3);
      const windows = [a, b, c].reduce((n, f) => n + sampleRanges(f.bytes.length).length, 0);
      expect(proof.counts.rangesCompared).toBe(windows);
      expect(r.stdout).toContain("verify: ok keys=3 headersChecked=3");

      // Read-only, and it reached the final 64 KiB of the new 20 MiB object.
      for (const op of [
        "PutObject",
        "CreateMultipartUpload",
        "DeleteObject",
        "DeleteObjects",
      ] as const) {
        expect(standin.calls(op).length, op).toBe(0);
      }
      const last = `bytes=${c.bytes.length - 65536}-${c.bytes.length - 1}`;
      expect(
        standin.calls("GetObject").some((x) => x.key === newKeyPath(c) && x.range === last),
      ).toBe(true);
      // The header comparison and the retention read are made for each new object.
      expect(standin.calls("GetObjectRetention").length).toBe(3);
    },
    SLOW,
  );

  test(
    "refuses a plan with a key nobody read, even when its totals agree",
    async () => {
      addUnreadableKey(dir);
      const r = await runScrub(standin, verifyArgs(dir));
      expectStopped(r, 3, "plan-has-unreadable");
      expect(has(dir, "verified.json")).toBe(false);
      expect(standin.log.length).toBe(0);
    },
    SLOW,
  );

  test(
    "a corrupted byte inside a sampled window of the new object fails it and writes no proof",
    async () => {
      // A stale proof from an earlier pass must not survive a failing one.
      writeFileSync(path.join(dir, "verified.json"), "{}");
      const windows = sampleRanges(c.bytes.length);
      const [start, end] = windows[Math.floor(windows.length / 2)] as [number, number];
      standin.corruptByte(BUCKET, newKeyPath(c), newVersion(c), Math.floor((start + end) / 2));

      const r = await runScrub(standin, verifyArgs(dir));
      expect(r.exitCode, r.all).toBe(1);
      expect(r.stdout).toContain("range-mismatch=1");
      expect(r.stdout).toContain("verified.json NOT written");
      expect(has(dir, "verified.json")).toBe(false);
    },
    SLOW,
  );

  test(
    "corruption in the first window after the header and in the final window is also caught",
    async () => {
      const windows = sampleRanges(c.bytes.length);
      const first = windows[0] as [number, number];
      const final = windows[windows.length - 1] as [number, number];
      expect(first[0]).toBe(256);
      for (const offset of [first[0], final[1]]) {
        standin.corruptByte(BUCKET, newKeyPath(c), newVersion(c), offset);
        const r = await runScrub(standin, verifyArgs(dir));
        expect(r.exitCode, `offset ${offset}: ${r.all}`).toBe(1);
        expect(r.stdout).toContain("range-mismatch=1");
        // XOR twice restores the byte.
        standin.corruptByte(BUCKET, newKeyPath(c), newVersion(c), offset);
      }
      const ok = await runScrub(standin, verifyArgs(dir));
      expect(ok.exitCode, ok.all).toBe(0);
    },
    SLOW,
  );

  test(
    "a new header that is not the planned patch fails, in or out of the identification fields",
    async () => {
      standin.corruptByte(BUCKET, newKeyPath(a), newVersion(a), 10);
      const inField = await runScrub(standin, verifyArgs(dir));
      expect(inField.exitCode, inField.all).toBe(1);
      expect(inField.stdout).toContain("header-not-patch=1");
      standin.corruptByte(BUCKET, newKeyPath(a), newVersion(a), 10);

      standin.corruptByte(BUCKET, newKeyPath(a), newVersion(a), 3);
      const outside = await runScrub(standin, verifyArgs(dir));
      expect(outside.exitCode, outside.all).toBe(1);
      expect(outside.stdout).toContain("header-not-patch=1");
      expect(outside.stdout).toContain("scrub:bytes-before-patient-changed=1");
    },
    SLOW,
  );

  test(
    "the scrub proof is checked on its own, not only the equality with the patch",
    async () => {
      // Plant the SAME bad header in the new object and in patches.json: the equality holds,
      // so only verifyScrub(old, new) can refuse it.
      const v = standin.versions(BUCKET, newKeyPath(a)).find((x) => x.versionId === newVersion(a));
      (v as { data: Uint8Array }).data[3] = (v as { data: Uint8Array }).data[3] ^ 0xff;
      const patches = readJson<Record<string, string>>(dir, "patches.json");
      patches[a.oldKey] = Buffer.from((v as { data: Uint8Array }).data.subarray(0, 256)).toString(
        "hex",
      );
      writeJson(dir, "patches.json", patches);
      rebindPatches(dir);

      const r = await runScrub(standin, verifyArgs(dir));
      expect(r.exitCode, r.all).toBe(1);
      expect(r.stdout).toContain("scrub:bytes-before-patient-changed=1");
      expect(r.stdout).not.toContain("header-not-patch");
    },
    SLOW,
  );

  test(
    "a missing lock, a short lock and a vanished object are each named",
    async () => {
      standin.clearLock(BUCKET, newKeyPath(b), newVersion(b));
      const noLock = await runScrub(standin, verifyArgs(dir));
      expect(noLock.exitCode, noLock.all).toBe(1);
      expect(noLock.stdout).toContain("lock-missing=1");
      expect(noLock.stdout).toContain("retention-missing=1");

      standin.setLock(
        BUCKET,
        newKeyPath(b),
        newVersion(b),
        "GOVERNANCE",
        new Date(Date.now() + 10 * 365 * 24 * 3600 * 1000),
      );
      const short = await runScrub(standin, verifyArgs(dir));
      expect(short.exitCode, short.all).toBe(1);
      expect(short.stdout).toContain("retention-short=1");
      expect(short.stdout).not.toContain("lock-missing");

      standin.dropVersion(BUCKET, newKeyPath(b), newVersion(b));
      const gone = await runScrub(standin, verifyArgs(dir));
      expect(gone.exitCode, gone.all).toBe(1);
      expect(gone.stdout).toContain("new-missing=1");
      expect(has(dir, "verified.json")).toBe(false);
    },
    SLOW,
  );

  test(
    "a new object of the wrong size, and an old object that cannot be read, fail",
    async () => {
      const v = standin.versions(BUCKET, newKeyPath(a)).find((x) => x.versionId === newVersion(a));
      (v as { data: Uint8Array }).data = (v as { data: Uint8Array }).data.slice(0, 1000);
      const short = await runScrub(standin, verifyArgs(dir));
      expect(short.exitCode, short.all).toBe(1);
      expect(short.stdout).toContain("new-size-mismatch=1");
      standin.restore(snap);

      const [only] = standin.versions(BUCKET, objectPath(b.oldKey));
      standin.dropVersion(BUCKET, objectPath(b.oldKey), (only as { versionId: string }).versionId);
      const noOld = await runScrub(standin, verifyArgs(dir));
      expect(noOld.exitCode, noOld.all).toBe(1);
      // The class stays: an old object that is gone is not one that could not be reached.
      expect(noOld.stdout).toContain("old-unreadable:GetObject:not-found=1");
    },
    SLOW,
  );

  test(
    "refuses an assembly that does not cover the plan, or whose keymap disagrees",
    async () => {
      const full = assembled();
      const without = structuredClone(full);
      delete without.entries[a.oldKey];
      writeJson(dir, "assembled.json", without);
      const incomplete = await runScrub(standin, verifyArgs(dir));
      expectStopped(incomplete, 3, "assembled-incomplete");

      const extra = structuredClone(full);
      extra.entries[`SHA256E-s9--${"d".repeat(64)}.edf`] = {
        ...(full.entries[a.oldKey] as object),
        newKey: `SHA256E-s9--${"e".repeat(64)}.edf`,
      } as never;
      writeJson(dir, "assembled.json", extra);
      const unplanned = await runScrub(standin, verifyArgs(dir));
      expectStopped(unplanned, 3, "assembled-has-unplanned-key");

      writeJson(dir, "assembled.json", full);
      const keymap = readJson<Record<string, string>>(dir, "keymap.json");
      keymap[a.oldKey] = keymap[b.oldKey] as string;
      writeJson(dir, "keymap.json", keymap);
      const mismatch = await runScrub(standin, verifyArgs(dir));
      expectStopped(mismatch, 3, "keymap-mismatch");
      expect(has(dir, "verified.json")).toBe(false);
    },
    SLOW,
  );
});

describe("verify: the version that was assembled (T6, T4)", () => {
  test(
    "reads the recorded version of the new object, and refuses a newer one at the key",
    async () => {
      // Someone writes the new key after assembly, with different bytes (a header and a body
      // that are both wrong). Reading the recorded version finds it good; the newer version is
      // named on its own, never as a header or range failure.
      const other = a.bytes.slice();
      other[20] ^= 0xff;
      other[other.length - 1] ^= 0xff;
      standin.putObject(BUCKET, newKeyPath(a), other, { lockUntil: centuryFromNow() });
      const r = await runScrub(standin, verifyArgs(dir));
      expect(r.exitCode, r.all).toBe(1);
      expect(r.stdout).toContain("(new-not-current=1)");
      expect(has(dir, "verified.json")).toBe(false);
      // Every read of the new object named the recorded version.
      const reads = standin
        .calls("GetObject")
        .filter((x) => x.key === newKeyPath(a) && x.status === 206);
      expect(reads.length).toBeGreaterThan(1);
      const recorded = newVersion(a);
      const current = standin.current(BUCKET, newKeyPath(a))?.versionId;
      expect(current).not.toBe(recorded);
      expect(
        reads.every((x) => x.versionId === recorded),
        JSON.stringify(reads),
      ).toBe(true);
    },
    SLOW,
  );

  test(
    "an assembled.json of another dataset, or of another bucket, is refused, each on its own",
    async () => {
      const good = assembled();
      writeJson(dir, "assembled.json", { ...good, dataset: "xx090412" });
      expectStopped(await runScrub(standin, verifyArgs(dir)), 3, "assembled-wrong-dataset");
      writeJson(dir, "assembled.json", { ...good, bucket: "other-bucket" });
      expectStopped(await runScrub(standin, verifyArgs(dir)), 3, "assembled-wrong-bucket");
      expect(standin.log.length).toBe(0);
    },
    SLOW,
  );
});
