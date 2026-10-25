/**
 * `nemar admin repull canary` (ADR 0111, decision 8; epic #1046 phase 6, #1912), driven through the
 * real entry point as a subprocess, with the REAL `aws` CLI against the S3 stand-in.
 *
 * The canary exists because only stand-ins answer the copy's S3 calls in the suites: it is the
 * check the owner runs against the real buckets. Here it is pinned that it sends exactly the calls
 * its help lists, in order, each copy at a version id, that it leaves its scratch prefix empty by
 * version (no delete marker), that a dry run sends nothing, that a prefix which is not a scratch
 * prefix is refused before any call, and that a copy it cannot delete (a lock) fails the canary
 * rather than being bypassed.
 *
 * CI TIER: unit-pure. It starts the binary and the real aws CLI against a loopback S3 stand-in; it
 * needs no live backend, no database and no network beyond loopback.
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, which } from "bun";
import { isCanaryPrefix, runCanary } from "../src/lib/repull/canary";
import { toolOrFail } from "./scrub/helpers/require-tools";
import { type S3Standin, startS3Standin } from "./scrub/helpers/s3-standin";

setDefaultTimeout(240_000);

const awsInstalled = toolOrFail("aws", which("aws") !== null);
const CLI_ENTRY = join(import.meta.dir, "..", "src", "index.ts");
const REPO_ROOT = join(import.meta.dir, "..");
const MIB = 1024 * 1024;
const PREFIX = "nm099999/repull-canary-20261024T000000Z/";
const SMALL = "ds004362/sub-01/eeg/sub-01_task-a_eeg.edf";
const BIG = "ds004362/sub-02/eeg/sub-02_task-a_eeg.edf";

let s3: S3Standin;
let home: string;
let versions: { small: string; big: string };

function noise(n: number, seed: number): Uint8Array {
  const out = new Uint8Array(n);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < n; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    out[i] = x & 0xff;
  }
  return out;
}

beforeAll(() => {
  s3 = startS3Standin({ region: "us-east-2" });
  home = mkdtempSync(join(tmpdir(), "nemar-repull-canary-"));
  mkdirSync(join(home, "aws"), { recursive: true });
  writeFileSync(join(home, "aws", "config"), "[profile canary]\nregion = us-east-2\n");
  writeFileSync(join(home, "aws", "credentials"), "");
});

afterAll(() => {
  s3?.stop();
  rmSync(home, { recursive: true, force: true });
});

beforeEach(() => {
  s3.restore(new Map());
  // Each source has a NEWER version of other bytes on top of the pinned one.
  versions = {
    small: s3.putObject("openneuro.org", SMALL, noise(2000, 1)),
    big: s3.putObject("openneuro.org", BIG, noise(12 * MIB + 7, 2)),
  };
  s3.putObject("openneuro.org", SMALL, noise(2000, 3));
  s3.putObject("openneuro.org", BIG, noise(12 * MIB + 7, 4));
  s3.log.length = 0;
});

async function canary(args: string[]): Promise<{ exitCode: number; all: string }> {
  const proc = spawn({
    cmd: ["bun", "run", CLI_ENTRY, "admin", "repull", "canary", ...args],
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      NEMAR_CONFIG_DIR: home,
      NEMAR_NO_UPDATE_CHECK: "1",
      NO_COLOR: "1",
      AWS_ACCESS_KEY_ID: "ASIATESTDUMMY000001",
      AWS_SECRET_ACCESS_KEY: "dummySecretAccessKeyForRepullCanary",
      AWS_SESSION_TOKEN: "dummy-session-token-for-repull-canary",
      AWS_CONFIG_FILE: join(home, "aws", "config"),
      AWS_SHARED_CREDENTIALS_FILE: join(home, "aws", "credentials"),
      AWS_PROFILE: "canary",
      AWS_EC2_METADATA_DISABLED: "true",
      AWS_MAX_ATTEMPTS: "1",
      AWS_ENDPOINT_URL_S3: s3.url,
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, all: `${stdout}\n${stderr}` };
}

const args = (prefix = PREFIX) => [
  "--prefix",
  prefix,
  "--source",
  `${SMALL}@${versions.small}`,
  "--multipart-source",
  `${BIG}@${versions.big}`,
];

describe.skipIf(!awsInstalled)("the S3 canary", () => {
  test("--execute sends exactly the listed calls, each copy at its version, and leaves the prefix empty", async () => {
    const run = await canary([...args(), "--execute"]);
    expect(run.exitCode, run.all).toBe(0);
    expect(run.all).toContain("The canary passed.");
    const calls = s3.log.map((e) => `${e.op} ${e.bucket}/${e.key}`);
    expect(calls).toEqual([
      `HeadObject openneuro.org/${SMALL}`,
      `HeadObject openneuro.org/${BIG}`,
      `CopyObject nemar/${PREFIX}copy-single`,
      `CreateMultipartUpload nemar/${PREFIX}copy-multipart`,
      `UploadPartCopy nemar/${PREFIX}copy-multipart`,
      `UploadPartCopy nemar/${PREFIX}copy-multipart`,
      `UploadPartCopy nemar/${PREFIX}copy-multipart`,
      `CompleteMultipartUpload nemar/${PREFIX}copy-multipart`,
      `HeadObject nemar/${PREFIX}copy-single`,
      `HeadObject nemar/${PREFIX}copy-multipart`,
      `PutObject nemar/${PREFIX}staging/repull-canary.json`,
      `DeleteObject nemar/${PREFIX}staging/repull-canary.json`,
      `DeleteObject nemar/${PREFIX}copy-single`,
      `DeleteObject nemar/${PREFIX}copy-multipart`,
      `ListObjectVersions nemar/${PREFIX}`,
      `ListMultipartUploads nemar/${PREFIX}`,
    ]);
    expect(s3.log.every((e) => e.status < 300)).toBe(true);
    const heads = s3.log.filter((e) => e.op === "HeadObject" && e.bucket === "openneuro.org");
    expect(heads.map((h) => h.versionId)).toEqual([versions.small, versions.big]);
    expect(s3.calls("CopyObject")[0]?.copySource).toContain(`?versionId=${versions.small}`);
    for (const p of s3.calls("UploadPartCopy")) {
      expect(p.copySource).toContain(`?versionId=${versions.big}`);
    }
    // Every delete named a version id, so nothing, not even a delete marker, is left.
    expect(s3.calls("DeleteObject").every((d) => typeof d.versionId === "string")).toBe(true);
    expect(s3.keys("nemar", PREFIX)).toEqual([]);
    expect(s3.openUploads()).toBe(0);
  });

  test("a dry run sends nothing and prints the calls", async () => {
    const run = await canary(args());
    expect(run.exitCode, run.all).toBe(0);
    expect(run.all).toContain("Dry run");
    expect(run.all).toContain(`?versionId=${versions.small}`);
    expect(s3.log).toEqual([]);
  });

  test("a prefix that is not a scratch prefix is refused before any call", async () => {
    for (const prefix of [
      "nm000103/objects/",
      "nm099999/objects/",
      "nm099999/repull-canary-x",
      "on099999/repull-canary-x/",
      "nm099999/staging/repull-canary-x/",
    ]) {
      const run = await canary([...args(prefix), "--execute"]);
      expect(run.exitCode, prefix).toBe(1);
      expect(run.all).toContain("Refused");
    }
    expect(s3.log).toEqual([]);
  });

  test("an endpoint that copies the current version instead of the pinned one fails the canary", async () => {
    // Ignored and said so, by an endpoint that honors no condition either: the version S3 names
    // as the one it copied is not the pin.
    s3.setCopySourceVersionMode("ignore");
    s3.setIgnoreIfMatch(true);
    const ignored = await canary([...args(), "--execute"]);
    expect(ignored.exitCode, ignored.all).toBe(1);
    // Right after the failing run, with the stand-in still ignoring versions: nothing is left,
    // not the copy whose check failed, and not a delete marker.
    expect(s3.keys("nemar", PREFIX)).toEqual([]);
    expect(s3.versions("nemar", `${PREFIX}copy-single`)).toEqual([]);
    expect(s3.versions("nemar", `${PREFIX}copy-multipart`)).toEqual([]);
    expect(s3.openUploads()).toBe(0);
    expect(ignored.all).toContain("ok list the prefix's open multipart uploads");
    expect(ignored.all).toContain("FAILED copy the small source by version: copied from version");
    expect(ignored.all).toContain(
      "FAILED copy the multipart source by version, in parts: part 1 copied from version",
    );
    // Ignored and not said: the small copy's ETag is the current version's, not the pin's.
    s3.restore(new Map());
    versions = {
      small: s3.putObject("openneuro.org", SMALL, noise(2000, 1)),
      big: s3.putObject("openneuro.org", BIG, noise(12 * MIB + 7, 2)),
    };
    s3.putObject("openneuro.org", SMALL, noise(2000, 3));
    s3.setCopySourceVersionMode("lie");
    // The copy's ETag condition, on the pinned version, refuses the current one.
    const refused = await canary([...args(), "--execute"]);
    expect(refused.exitCode, refused.all).toBe(1);
    expect(refused.all).toContain(
      "FAILED copy the small source by version: CopyObject:precondition-failed",
    );
    // An endpoint that honors neither: only the copy's own ETag shows the bytes are not the pin's.
    s3.setIgnoreIfMatch(true);
    const lied = await canary([...args(), "--execute"]);
    expect(lied.exitCode, lied.all).toBe(1);
    expect(lied.all).toContain("ok copy the small source by version");
    expect(lied.all).toContain("FAILED head the small copy");
    // What it wrote is still deleted by version.
    expect(s3.keys("nemar", PREFIX)).toEqual([]);
  });

  test("a copy the bucket locked is not bypassed: the delete fails and so does the canary", async () => {
    // A bucket whose default retention locks every new object, seen at the first delete.
    s3.beforeOp("DeleteObject", () => {
      for (const key of [`${PREFIX}copy-single`, `${PREFIX}copy-multipart`]) {
        const v = s3.current("nemar", key);
        if (v)
          s3.setLock("nemar", key, v.versionId, "GOVERNANCE", new Date(Date.now() + 86_400_000));
      }
    });
    const run = await canary([...args(), "--execute"]);
    expect(run.exitCode, run.all).toBe(1);
    expect(run.all).toContain("FAILED delete the small copy by version");
    expect(run.all).toContain("The canary FAILED");
    expect(s3.calls("DeleteObject").some((d) => d.bypass)).toBe(false);
  });

  test("the permanent exemplar fleet and other buckets are refused before any call", async () => {
    for (const id of ["xx099900", "xx099907", "xx099999", "xx090000", "xx100000"]) {
      const run = await canary([...args(`${id}/repull-canary-x/`), "--execute"]);
      expect(run.exitCode, id).toBe(1);
      expect(run.all, id).toContain("Refused");
    }
    const bucket = await canary([...args(), "--bucket", "nemar-other", "--execute"]);
    expect(bucket.exitCode, bucket.all).toBe(1);
    expect(bucket.all).toContain("--bucket must be nemar");
    expect(s3.log).toEqual([]);
    // The ends of the dev-ephemeral band are scratch prefixes.
    for (const id of ["xx090001", "xx099899"]) {
      const run = await canary(args(`${id}/repull-canary-x/`));
      expect(run.exitCode, run.all).toBe(0);
    }
    expect(isCanaryPrefix("nm099999/repull-canary-x/")).toBe(true);
    expect(isCanaryPrefix("nm099998/repull-canary-x/")).toBe(false);
  });

  test("runCanary itself refuses what the command would, so no caller can skip the check", async () => {
    const out: string[] = [];
    const source = { ds: "ds004362", object: SMALL, version: versions.small };
    const bad = await runCanary({
      prefix: "xx099950/repull-canary-x/",
      single: source,
      multipart: { ds: "ds004362", object: BIG, version: versions.big },
      bucket: "nemar",
      region: "us-east-2",
      env: { AWS_ENDPOINT_URL_S3: s3.url },
      out: (l) => out.push(l),
    });
    expect(bad.ok).toBe(false);
    expect(out.join("\n")).toContain("FAILED check the arguments");
    const otherBucket = await runCanary({
      prefix: PREFIX,
      single: source,
      multipart: { ds: "ds004362", object: BIG, version: versions.big },
      bucket: "elsewhere",
      region: "us-east-2",
      env: { AWS_ENDPOINT_URL_S3: s3.url },
      out: () => {},
    });
    expect(otherBucket.ok).toBe(false);
    expect(s3.log).toEqual([]);
  });

  test("a failed part and a failed abort fail the canary and name the upload left open", async () => {
    s3.inject("UploadPartCopy", { code: "InternalError", status: 500, after: 1 });
    s3.inject("AbortMultipartUpload", { code: "InternalError", status: 500 });
    const run = await canary([...args(), "--execute"]);
    expect(run.exitCode, run.all).toBe(1);
    expect(run.all).toMatch(/the abort of upload \S+ failed and it stays open/);
    expect(run.all).toContain("FAILED list the prefix's open multipart uploads");
    expect(s3.openUploads()).toBe(1);
  });
});
