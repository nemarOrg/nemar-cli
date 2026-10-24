/**
 * The #1320 preflight (epic #1046 Phase 3): before prepare configures `nemar-s3`, the annex-uuid
 * git-annex keeps at the bucket prefix is compared with the `nemar-s3` uuids the dataset's
 * git-annex branch records, and a disagreement refuses with both uuids and the recovery that fits,
 * instead of failing in `initremote` on this attempt and on every retry.
 *
 * Real throughout: `remote.log` comes from real git-annex repositories whose `nemar-s3` is a
 * `type=directory` special remote (the branch side does not care what type it is), and the bucket
 * is the local S3 stand-in reached by the real `aws` CLI, isolated from the developer's own AWS
 * setup. Skipped when `aws` is not on PATH.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { which } from "bun";
import { classifyImportFailure } from "../backend/src/services/import-failure-cause";
import { decideRetryAction } from "../backend/src/services/import-retry";
import { NEMAR_ANNEX_UUID_CONFLICT_MARKER } from "../shared/import-markers";
import {
  NEMAR_S3_REMOTE_NAME,
  preflightBucketAnnexUuid,
  uuidsNamedInRemoteLog,
} from "../src/lib/git-annex/s3-remote";
import { ImportRefused } from "../src/lib/import-markers";
import { initDirectoryRemote, makeScratch, run } from "./helpers/annex-repo";
import { type S3Standin, startS3Standin } from "./scrub/helpers/s3-standin";

const BUCKET = "nemar";
const REGION = "us-east-2";
const awsInstalled = which("aws") !== null;
const scratch = makeScratch("annex-uuid-preflight");
let standin: S3Standin;
let awsEnv: Record<string, string>;
let n = 0;

beforeAll(() => {
  standin = startS3Standin({ region: REGION });
  const home = join(scratch.root, "aws-home");
  mkdirSync(home, { recursive: true });
  // A profile of this test's own, named in AWS_PROFILE: the variables below are added on top of
  // the test's environment (as prepare adds its credentials), so a developer's own AWS_PROFILE
  // would otherwise survive, and an empty one is an error.
  writeFileSync(join(home, "config"), "[profile preflight-test]\nregion = us-east-2\n");
  writeFileSync(join(home, "credentials"), "");
  // The endpoint moves to the stand-in and nothing of the developer's AWS setup is read.
  awsEnv = {
    HOME: home,
    AWS_ACCESS_KEY_ID: "ASIATESTDUMMY000001",
    AWS_SECRET_ACCESS_KEY: "dummySecretAccessKeyForPreflightTest",
    AWS_CONFIG_FILE: join(home, "config"),
    AWS_SHARED_CREDENTIALS_FILE: join(home, "credentials"),
    AWS_EC2_METADATA_DISABLED: "true",
    AWS_MAX_ATTEMPTS: "1",
    AWS_ENDPOINT_URL_S3: standin.url,
    AWS_PROFILE: "preflight-test",
  };
});

afterAll(() => {
  standin.stop();
  scratch.cleanup();
});

async function annexRepo(name: string): Promise<string> {
  n += 1;
  const dir = join(scratch.root, `${name}-${n}`);
  mkdirSync(dir, { recursive: true });
  for (const cmd of [
    ["git", "init", "-q", "-b", "main"],
    ["git", "config", "user.email", "test@test.com"],
    ["git", "config", "user.name", "Test"],
    ["git", "annex", "init", "-q", name],
  ]) {
    const r = await run(cmd, dir);
    if (r.exitCode !== 0) throw new Error(`${cmd.join(" ")}: ${r.stderr}`);
  }
  return dir;
}

async function nemarS3Uuid(repo: string): Promise<string> {
  const r = await run(["git", "config", `remote.${NEMAR_S3_REMOTE_NAME}.annex-uuid`], repo);
  return r.stdout.trim();
}

/** A repo whose git-annex branch records one `nemar-s3` remote; its uuid. */
async function repoWithRemote(): Promise<{ repo: string; uuid: string }> {
  const repo = await annexRepo("dataset");
  await initDirectoryRemote(scratch.root, repo, NEMAR_S3_REMOTE_NAME);
  return { repo, uuid: await nemarS3Uuid(repo) };
}

function bucketHolds(nemarId: string, uuid: string): void {
  standin.putObject(BUCKET, `${nemarId}/objects/annex-uuid`, new TextEncoder().encode(`${uuid}\n`));
}

function preflight(repo: string, nemarId: string) {
  return preflightBucketAnnexUuid(repo, {
    bucket: BUCKET,
    prefix: `${nemarId}/objects`,
    region: REGION,
    env: awsEnv,
  });
}

const OTHER_UUID = "0e6c1f3a-9b1d-4c2e-8f00-000000000001";

describe.skipIf(!awsInstalled)("the bucket's annex-uuid against the git-annex branch", () => {
  test("no marker in the bucket: clear, whatever the branch says", async () => {
    const { repo } = await repoWithRemote();
    expect(await preflight(repo, "on001001")).toEqual({ kind: "clear", bucketUuid: null });
  }, 60_000);

  test("the marker is the branch's one nemar-s3: clear", async () => {
    const { repo, uuid } = await repoWithRemote();
    bucketHolds("on001002", uuid);
    expect(await preflight(repo, "on001002")).toEqual({ kind: "clear", bucketUuid: uuid });
  }, 60_000);

  test("the branch records no nemar-s3: refused, with the recovery that removes the marker", async () => {
    const repo = await annexRepo("no-remote");
    bucketHolds("on001003", OTHER_UUID);
    const result = await preflight(repo, "on001003");
    expect(result.kind).toBe("conflict");
    if (result.kind !== "conflict") return;
    expect(result.detail).toContain(`bucket ${OTHER_UUID}; branch none.`);
    expect(result.detail).toContain("aws s3 rm s3://nemar/on001003/objects/annex-uuid");
    expect(result.detail).not.toContain("Delete nothing");

    // The line the Worker receives, as prepare raises it: annex_uuid_conflict, parked at once.
    const refusal = new ImportRefused(NEMAR_ANNEX_UUID_CONFLICT_MARKER, result.detail);
    expect(refusal.message.length).toBeLessThan(600);
    expect(classifyImportFailure({ stage: "prepare", lastError: refusal.message }).cause).toBe(
      "annex_uuid_conflict",
    );
    const now = Date.now();
    expect(
      decideRetryAction({
        now,
        verified: { complete: false },
        firstIncompleteAtMs: now,
        lastError: refusal.message,
        recoveryAttempts: 0,
        hasSourceId: true,
      }),
    ).toEqual({ action: "blocklist", reason: "annex_uuid_conflict" });
  }, 60_000);

  test("the branch records a different nemar-s3: refused, and told to delete nothing", async () => {
    const { repo, uuid } = await repoWithRemote();
    bucketHolds("on001004", OTHER_UUID);
    const result = await preflight(repo, "on001004");
    expect(result.kind).toBe("conflict");
    if (result.kind !== "conflict") return;
    expect(result.detail).toContain(`bucket ${OTHER_UUID}; branch ${uuid}.`);
    expect(result.detail).toContain("Delete nothing");
    expect(result.detail).not.toContain("aws s3 rm");
  }, 60_000);

  test("two nemar-s3 remotes in the branch (#969's duplicate): refused even when one matches", async () => {
    // Two attempts each minted a remote under the same name, and the branches were merged, as
    // Step 4b merges origin's: enableremote would answer "Multiple remotes have that name".
    const a = await repoWithRemote();
    const b = await repoWithRemote();
    await run(["git", "fetch", "-q", b.repo, "git-annex:refs/remotes/other/git-annex"], a.repo);
    const merged = await run(["git", "annex", "merge"], a.repo);
    expect(merged.exitCode).toBe(0);
    bucketHolds("on001005", a.uuid);
    const result = await preflight(a.repo, "on001005");
    expect(result.kind).toBe("conflict");
    if (result.kind !== "conflict") return;
    expect(result.branchUuids.sort()).toEqual([a.uuid, b.uuid].sort());
  }, 60_000);

  test("a bucket that cannot be asked is unchecked, never clear and never a conflict", async () => {
    const { repo } = await repoWithRemote();
    bucketHolds("on001006", OTHER_UUID);
    standin.inject("ListObjectsV2", { code: "AccessDenied", status: 403, times: 1 });
    const listing = await preflight(repo, "on001006");
    expect(listing.kind).toBe("unchecked");
    standin.inject("GetObject", { code: "InternalError", status: 500, times: 1 });
    const reading = await preflight(repo, "on001006");
    expect(reading.kind).toBe("unchecked");
    standin.clearFaults();
  }, 60_000);
});

describe("which uuids remote.log names nemar-s3", () => {
  const A = "11111111-1111-4111-8111-111111111111";
  const B = "22222222-2222-4222-8222-222222222222";

  test("the latest line for each uuid is its configuration", () => {
    const log = [
      `${A} name=nemar-s3 type=S3 timestamp=100s`,
      `${B} name=nemar-s3 type=S3 timestamp=100s`,
      // B renamed away later; A renamed away earlier than its own newest line.
      `${B} name=retired type=S3 timestamp=200s`,
      `${A} name=old type=S3 timestamp=50s`,
    ].join("\n");
    expect(uuidsNamedInRemoteLog(log, "nemar-s3")).toEqual([A]);
  });

  test("other names and blank or broken lines are ignored", () => {
    const log = `\n${A} name=s3-PUBLIC type=S3 timestamp=1s\nnot-a-line\n${B} name=nemar-s3 timestamp=2s\n`;
    expect(uuidsNamedInRemoteLog(log, "nemar-s3")).toEqual([B]);
    expect(uuidsNamedInRemoteLog("", "nemar-s3")).toEqual([]);
  });
});
