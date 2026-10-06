/**
 * The stages chained, with nothing in between standing in for a stage: the REAL TypeScript plan
 * writes plan.json and patches.json, the REAL Python hash stage reads them and streams the
 * objects with its default source (the real `aws` CLI against the S3 stand-in), and the REAL
 * TypeScript assemble reads hashes.json back. Each program's own tests write the other's files
 * by hand, so none of them can see a disagreement about the shape of a file or about what a
 * value means; this one can.
 */

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import path from "node:path";
import { spawn } from "bun";
import { type HashesFile, parseHashes, patchDigest } from "../../../scripts/scrub/contract";
import { type S3Standin, startS3Standin } from "../helpers/s3-standin";
import { expectStopped } from "./refusal";
import {
  BUCKET,
  REPO_ROOT,
  SLOW,
  assembleArgs,
  awsTestEnv,
  fixtureA,
  fixtureB,
  fixtureD,
  objectPath,
  planArgs,
  readJson,
  rebindPatches,
  removeTempDirs,
  runScrub,
  seedManifest,
  seedObject,
  sha256,
  tempDir,
  verifyArgs,
  withFields,
  writeJson,
} from "./support";

afterAll(removeTempDirs);

const HASH_STAGE = path.join(REPO_ROOT, "scripts", "scrub", "hash", "hash_stage.py");

let standin: S3Standin;
afterEach(() => standin?.stop());

/** The Python hash stage with its default source, pointed at the stand-in. */
async function hash(standin: S3Standin, args: string[]) {
  const proc = spawn({
    cmd: ["python3", HASH_STAGE, ...args, "--retries", "0", "--retry-backoff", "0"],
    env: awsTestEnv(standin, { AWS_DEFAULT_REGION: "us-east-2", PYTHONDONTWRITEBYTECODE: "1" }),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

const computeArgs = (dir: string) => [
  "compute",
  "--plan",
  path.join(dir, "plan.json"),
  "--patches",
  path.join(dir, "patches.json"),
  "--out",
  path.join(dir, "hashes.json"),
  "--workers",
  "2",
];

describe("plan, hash and assemble, chained", () => {
  test(
    "the keys Python computes are the keys TypeScript's assemble builds, and both verify passes agree",
    async () => {
      standin = startS3Standin();
      const [a, b, d] = [fixtureA(), fixtureB(), fixtureD()];
      for (const f of [a, b, d]) seedObject(standin, f);
      seedManifest(standin, "v1.0.0", [a, b, d]);

      const dir = tempDir("chain");
      const plan = await runScrub(standin, planArgs(dir));
      expect(plan.exitCode, plan.all).toBe(0);

      const computed = await hash(standin, computeArgs(dir));
      expect(computed.code, computed.stderr).toBe(0);

      // The new keys are the ones built independently from the bytes, bound to the patch that
      // TypeScript's plan wrote, and the clean file has no entry.
      const hashes = parseHashes(JSON.stringify(readJson<HashesFile>(dir, "hashes.json")));
      expect(Object.keys(hashes.entries).sort()).toEqual([a.oldKey, b.oldKey].sort());
      const patches = readJson<Record<string, string>>(dir, "patches.json");
      for (const f of [a, b]) {
        const e = hashes.entries[f.oldKey];
        expect(e?.newKey, f.label).toBe(f.newKey as string);
        expect(e?.patchSha256, f.label).toBe(patchDigest(patches[f.oldKey] as string));
      }

      // TypeScript reads the Python file back and builds what the key promises.
      const assembled = await runScrub(standin, assembleArgs(dir));
      expect(assembled.exitCode, assembled.all).toBe(0);
      for (const f of [a, b]) {
        const made = standin.current(BUCKET, objectPath(f.newKey as string));
        expect(Buffer.compare(made?.data as Uint8Array, f.expected as Uint8Array), f.label).toBe(0);
        expect(sha256(made?.data as Uint8Array), f.label).toBe(
          (f.newKey as string).split("--")[1]?.split(".")[0] as string,
        );
      }

      // Both verifications, each side reading the other's output.
      const verified = await runScrub(standin, verifyArgs(dir));
      expect(verified.exitCode, verified.all).toBe(0);
      const reread = await hash(standin, [
        "verify-new",
        "--assembled",
        path.join(dir, "assembled.json"),
        "--out",
        path.join(dir, "new-hash-verified.json"),
      ]);
      expect(reread.code, reread.stderr).toBe(0);
      expect(readJson<{ count: number }>(dir, "new-hash-verified.json").count).toBe(2);
    },
    SLOW,
  );

  test(
    "a patch changed after the hash stage ran cannot be assembled, and a re-run of the hash stage fixes it",
    async () => {
      standin = startS3Standin();
      const [a, b] = [fixtureA(), fixtureB()];
      for (const f of [a, b]) seedObject(standin, f);
      seedManifest(standin, "v1.0.0", [a, b]);
      const dir = tempDir("chain-stale");
      expect((await runScrub(standin, planArgs(dir))).exitCode).toBe(0);
      expect((await hash(standin, computeArgs(dir))).code).toBe(0);

      // Another scrub of A, as a later plan run would write it.
      const other = withFields(a.bytes, { patient: "X X X X", recording: "Startdate X X X X" });
      const otherKey = `SHA256E-s${a.bytes.length}--${sha256(other)}.edf`;
      const patches = readJson<Record<string, string>>(dir, "patches.json");
      writeJson(dir, "patches.json", {
        ...patches,
        [a.oldKey]: Buffer.from(other.subarray(0, 256)).toString("hex"),
      });
      // As that later plan run would have written its plan.json beside it.
      rebindPatches(dir);

      // The hashes in hand are for the first patch: assemble refuses, and nothing was written.
      expectStopped(await runScrub(standin, assembleArgs(dir)), 3, "hashes-stale");
      expect(standin.calls("PutObject").length).toBe(0);

      // Re-running the hash stage recomputes A only, and the pair then assembles to the new key.
      const rerun = await hash(standin, computeArgs(dir));
      expect(rerun.code, rerun.stderr).toBe(0);
      expect(rerun.stderr).toContain("1 entries were made for another patch");
      const hashes = readJson<HashesFile>(dir, "hashes.json");
      expect(hashes.entries[a.oldKey]?.newKey).toBe(otherKey);
      expect(hashes.entries[b.oldKey]?.newKey).toBe(b.newKey as string);
      const assembled = await runScrub(standin, assembleArgs(dir));
      expect(assembled.exitCode, assembled.all).toBe(0);
      const made = standin.current(BUCKET, objectPath(otherKey));
      expect(Buffer.compare(made?.data as Uint8Array, other)).toBe(0);
    },
    SLOW,
  );
});
