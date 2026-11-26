/**
 * Local patch for nemarOrg/nemar-cli#2141 (ii): `nemar dataset push` copies through the upload's
 * renewing, location-log-driven path (copyAnnexedForPush -> copyAnnexedToRemote) and does so
 * BEFORE the git push. Real git-annex and a real `directory` special remote named nemar-s3; the
 * credential lease is a local value (a directory remote reads no credentials), so no S3, no NEMAR
 * API and no secret is involved.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gitAnnexAdd } from "../src/lib/git-annex/init";
import type { CredentialLease } from "../src/lib/upload/s3-copy-session";
import { S3_REMOTE_NAME, annexKeySize, copyAnnexedForPush } from "../src/lib/upload/transfer";
import {
  initDirectoryRemote,
  makeScratch,
  newDatasetRepo,
  run,
  writeFile,
} from "./helpers/annex-repo";

setDefaultTimeout(120_000);
const scratch = makeScratch("nemar-2141-push");
beforeAll(async () => {
  if ((await run(["git", "annex", "version"])).exitCode !== 0) {
    throw new Error("git-annex is required for this test file");
  }
});
afterAll(() => scratch.cleanup());

const CREDS = { accessKeyId: "local-test-not-a-key", secretAccessKey: "local-test-not-a-secret" };

async function repoWithData(name: string, files: string[]): Promise<string> {
  const dir = await newDatasetRepo(scratch.root, name);
  for (const p of files) writeFile(dir, p, `${p}:`.padEnd(4000, "z"));
  const added = await gitAnnexAdd(dir, files);
  if (!added.success) throw new Error(added.error);
  await run(["git", "commit", "-qm", "data"], dir);
  await initDirectoryRemote(scratch.root, dir, S3_REMOTE_NAME);
  return dir;
}

async function pendingAtRemote(dir: string): Promise<string[]> {
  const r = await run(
    ["git", "annex", "find", "--include", "*", "--not", "--in", S3_REMOTE_NAME],
    dir,
  );
  return r.stdout.split("\n").filter(Boolean);
}

describe("#2141 (ii) dataset push copy path", () => {
  test("copies only what the location log lacks, renewing a lease that is about to expire", async () => {
    const files = ["sub-01/a.edf", "sub-01/b.edf", "sub-02/c.edf", "sub-02/d.edf", "sub-03/e.edf"];
    const dir = await repoWithData("renew", files);
    // Two files are already at the remote, as after an interrupted earlier copy.
    expect(
      (await run(["git", "annex", "copy", "--to", S3_REMOTE_NAME, "--", files[0], files[1]], dir))
        .exitCode,
    ).toBe(0);
    expect((await pendingAtRemote(dir)).sort()).toEqual(files.slice(2).sort());

    let renewCalls = 0;
    const lease: CredentialLease = { credentials: CREDS, expiresAtMs: Date.now() + 1_000 };
    const result = await copyAnnexedForPush({
      absolutePath: dir,
      remote: S3_REMOTE_NAME,
      jobs: 2,
      lease,
      renewLease: async () => {
        renewCalls++;
        return { credentials: CREDS, expiresAtMs: Date.now() + 2 * 60 * 60 * 1000 };
      },
    });
    expect(result).toMatchObject({ success: true, total: 5, attempted: 3 });
    expect(renewCalls).toBeGreaterThanOrEqual(1);
    if (result.success) expect(result.renewals).toBe(renewCalls);
    expect(await pendingAtRemote(dir)).toEqual([]);
    // No credentials are left in .git/annex/creds.
    const creds = await run(["bash", "-c", "ls .git/annex/creds 2>/dev/null | wc -l"], dir);
    expect(creds.stdout.trim()).toBe("0");
  });

  test("a file with no content here and none at the remote fails with the fetch hint", async () => {
    const dir = await repoWithData("missing", ["a.edf", "b.edf"]);
    expect((await run(["git", "annex", "drop", "--force", "--", "b.edf"], dir)).exitCode).toBe(0);
    const result = await copyAnnexedForPush({
      absolutePath: dir,
      remote: S3_REMOTE_NAME,
      jobs: 2,
      lease: { credentials: CREDS, expiresAtMs: Date.now() + 2 * 60 * 60 * 1000 },
      renewLease: async () => ({ credentials: CREDS, expiresAtMs: Date.now() + 7_200_000 }),
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("b.edf");
      expect(result.hint).toContain("git annex get");
    }
    expect(await pendingAtRemote(dir)).toEqual(["b.edf"]);
  });

  test("annexKeySize reads the size field of a key", () => {
    expect(annexKeySize("SHA256E-s20480--abcdef.edf")).toBe(20480);
    expect(annexKeySize("MD5E-s0--d41d8cd98f00b204e9800998ecf8427e")).toBe(0);
    expect(annexKeySize("WORM-s12-m1700000000--name")).toBe(12);
    expect(annexKeySize("URL--https&c%%example.org%x")).toBeUndefined();
  });

  test("the push command copies data BEFORE pushing git, and stops before git on a copy failure", () => {
    const source = readFileSync(join(import.meta.dir, "../src/commands/dataset.ts"), "utf8");
    const action = source.slice(source.indexOf('.command("push")'));
    const copyAt = action.indexOf("await copyAnnexedForPush(");
    const stopAt = action.indexOf("Nothing was pushed to GitHub.");
    const gitAt = action.indexOf("await pushToGitHub(cwd)");
    expect(copyAt).toBeGreaterThan(0);
    expect(stopAt).toBeGreaterThan(copyAt);
    expect(gitAt).toBeGreaterThan(stopAt);
  });
});
