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
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { which } from "bun";
import { classifyImportFailure } from "../backend/src/services/import-failure-cause";
import { decideRetryAction } from "../backend/src/services/import-retry";
import { NEMAR_ANNEX_UUID_CONFLICT_MARKER } from "../shared/import-markers";
import {
  NEMAR_S3_REMOTE_NAME,
  type OriginAnnexState,
  annexUuidPreflightAction,
  fetchOriginAnnexBranch,
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

function preflight(repo: string, nemarId: string, originAnnex: OriginAnnexState = "absent") {
  return preflightBucketAnnexUuid(repo, {
    bucket: BUCKET,
    prefix: `${nemarId}/objects`,
    region: REGION,
    originAnnex,
    env: awsEnv,
  });
}

/** A bare repository holding `repo`'s main and git-annex branches, as a dataset's origin would. */
async function bareOriginOf(repo: string): Promise<string> {
  n += 1;
  const bare = join(scratch.root, `origin-${n}`);
  mkdirSync(bare, { recursive: true });
  await run(["git", "init", "-q", "--bare", "-b", "main"], bare);
  await run(["git", "commit", "-q", "--allow-empty", "-m", "init"], repo);
  await run(["git", "push", "-q", bare, "main", "git-annex"], repo);
  return bare;
}

const OTHER_UUID = "0e6c1f3a-9b1d-4c2e-8f00-000000000001";

// CI has the aws CLI; a skip there would hide the preflight's coverage, so it is a failure instead.
test.if(process.env.CI === "true")("the aws CLI is present in CI", () => {
  expect(awsInstalled).toBe(true);
});

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
    expect(result.detail).toContain(
      `Once no clone records ${OTHER_UUID}: aws s3 rm s3://nemar/on001003/objects/annex-uuid`,
    );
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

  test("a failed Step 4b is unchecked, never a conflict, and prepare is told to warn and go on", async () => {
    // Without origin's branch merged, the clone's branch cannot say which remote the bucket is.
    const repo = await annexRepo("unmerged");
    bucketHolds("on001007", OTHER_UUID);
    const result = await preflight(repo, "on001007", "failed");
    expect(result.kind).toBe("unchecked");
    const action = annexUuidPreflightAction(result);
    expect("warn" in action && action.warn).toContain("could not be fetched or merged");
    expect("refuse" in action).toBe(false);
  }, 60_000);

  test("a git failure reading the branch is unchecked, not 'no remote'", async () => {
    const { repo } = await repoWithRemote();
    bucketHolds("on001008", OTHER_UUID);
    // The blob holding remote.log goes missing: git can list it and cannot read it.
    const blob = (await run(["git", "rev-parse", "git-annex:remote.log"], repo)).stdout.trim();
    const objectPath = join(repo, ".git", "objects", blob.slice(0, 2), blob.slice(2));
    chmodSync(objectPath, 0o644);
    rmSync(objectPath);
    const result = await preflight(repo, "on001008");
    expect(result.kind).toBe("unchecked");
    expect(result.kind === "unchecked" && result.reason).toContain("reading remote.log failed");
  }, 60_000);

  test("origin's branch exists and records no nemar-s3: unchecked, never 'remove the marker'", async () => {
    // A clone of a dataset whose origin has a git-annex branch without the remote. That branch
    // should have named it; not finding it is not evidence the marker is stale.
    const source = await annexRepo("origin-without-remote");
    const bare = await bareOriginOf(source);
    n += 1;
    const clone = join(scratch.root, `clone-${n}`);
    await run(["git", "clone", "-q", bare, clone]);
    bucketHolds("on001009", OTHER_UUID);
    for (const state of ["merged", "absent"] as const) {
      const result = await preflight(clone, "on001009", state);
      expect(result.kind).toBe("unchecked");
    }
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

describe("Step 4b says which of merged, absent and failed it reached", () => {
  test("an origin without a git-annex branch is absent; an unreachable one is failed", async () => {
    const withBranch = await annexRepo("has-branch");
    const bareWith = await bareOriginOf(withBranch);
    n += 1;
    const withoutBranch = join(scratch.root, `origin-bare-empty-${n}`);
    mkdirSync(withoutBranch, { recursive: true });
    await run(["git", "init", "-q", "--bare", "-b", "main"], withoutBranch);

    const clone = await annexRepo("step4b");
    await run(["git", "remote", "add", "origin", bareWith], clone);
    expect((await fetchOriginAnnexBranch(clone)).state).toBe("merged");
    await run(["git", "remote", "set-url", "origin", withoutBranch], clone);
    expect((await fetchOriginAnnexBranch(clone)).state).toBe("absent");
    await run(["git", "remote", "set-url", "origin", join(scratch.root, "no-such-origin")], clone);
    const failed = await fetchOriginAnnexBranch(clone);
    expect(failed.state).toBe("failed");
    expect(failed.error).toBeTruthy();
  }, 60_000);

  // Directory permissions do not bind root, so the failure cannot be induced there.
  test.skipIf(process.getuid?.() === 0)(
    "a fetch that lands and a merge that fails is failed, not merged",
    async () => {
      const source = await annexRepo("merge-source");
      const bare = await bareOriginOf(source);
      const clone = await annexRepo("merge-target");
      await run(["git", "remote", "add", "origin", bare], clone);
      // git-annex cannot write its own state, so `git annex merge` fails after the fetch succeeds.
      const annexDir = join(clone, ".git", "annex");
      chmodSync(annexDir, 0o555);
      try {
        const result = await fetchOriginAnnexBranch(clone);
        expect(result.state).toBe("failed");
      } finally {
        chmodSync(annexDir, 0o755);
      }
    },
    60_000,
  );

  test("what prepare does with each answer", () => {
    expect(annexUuidPreflightAction({ kind: "clear", bucketUuid: null })).toEqual({
      proceed: true,
    });
    expect(
      annexUuidPreflightAction({
        kind: "conflict",
        bucketUuid: OTHER_UUID,
        branchUuids: [],
        detail: "the detail",
      }),
    ).toEqual({ refuse: "the detail" });
  });
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
