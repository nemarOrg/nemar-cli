/**
 * The gate that decides whether an import may register its keys (#1396).
 *
 * Finalize used to verify the import MANIFEST against the bucket. A manifest is
 * what the copy phase believed it transferred, so a copy that built a partial
 * manifest verified cleanly while the tree still referenced keys nothing had
 * moved -- sixteen datasets published that way, 12,039 keys with no object, each
 * one advertised to clones by the location log (ADR 0062).
 *
 * So the question has to be asked of the tree. The tree side of it comes from a
 * real git-annex repository here rather than a literal list, because that is the
 * half that was wrong: the rule was never the problem, what it was applied to
 * was.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "../src/lib/git-annex/run-command";
import { listAnnexedKeys } from "../src/lib/git-annex/transfer";
import { annexKeyDeclaredSize, keysWithoutObjects } from "../src/lib/s3-server-copy";

let repo: string;
const scratch: string[] = [];

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout, stderr, exitCode } = await runCommand(args, { cwd });
  if (exitCode !== 0) {
    throw new Error(`${args.join(" ")} failed: ${stderr.trim() || `exit ${exitCode}`}`);
  }
  return stdout;
}

beforeEach(async () => {
  const root = mkdtempSync(join(tmpdir(), "nemar-publish-gate-"));
  scratch.push(root);
  repo = join(root, "dataset");
  mkdirSync(repo, { recursive: true });
  await git(["git", "init", "-q", "--initial-branch", "main", "."], repo);
  await git(["git", "config", "user.email", "test@nemar.test"], repo);
  await git(["git", "config", "user.name", "NEMAR Test"], repo);
  await git(["git", "annex", "init", "--quiet", "gate"], repo);
  for (const [name, content] of [
    ["sub-01/eeg.dat", "recording one".repeat(100)],
    ["sub-02/eeg.dat", "recording two".repeat(100)],
    ["sub-03/eeg.dat", "recording three".repeat(100)],
  ]) {
    mkdirSync(join(repo, name, ".."), { recursive: true });
    writeFileSync(join(repo, name), content);
  }
  await git(["git", "annex", "add", "--quiet", "."], repo);
  await git(["git", "commit", "-qm", "recordings"], repo);
}, 120_000);

afterEach(() => {
  while (scratch.length > 0) {
    const dir = scratch.pop();
    if (!dir || !existsSync(dir)) continue;
    Bun.spawnSync(["chmod", "-R", "u+w", dir]);
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A bucket listing in the shape `listExistingObjects` returns. */
function listing(keys: string[]): Map<string, number> {
  return new Map(keys.map((key) => [key, annexKeyDeclaredSize(key) ?? 0]));
}

describe("keysWithoutObjects, against a real annexed tree", () => {
  test("names the tree's keys the bucket does not hold", async () => {
    const keys = [...(await listAnnexedKeys(repo)).values()];
    expect(keys).toHaveLength(3);

    // The shape that got published: a manifest covering one of three recordings
    // verifies perfectly, and the other two are content no clone can fetch.
    const unbacked = keysWithoutObjects(keys, listing(keys.slice(0, 1)));

    expect(unbacked.sort()).toEqual(keys.slice(1).sort());
  }, 120_000);

  test("passes when the bucket accounts for every key", async () => {
    const keys = [...(await listAnnexedKeys(repo)).values()];
    expect(keysWithoutObjects(keys, listing(keys))).toEqual([]);
  }, 120_000);

  test("counts an object of the wrong size as absent", async () => {
    // A truncated object is the #967 failure and it still passes a presence
    // check. The key asserts its own size, so the comparison is against that.
    const keys = [...(await listAnnexedKeys(repo)).values()];
    const truncated = new Map(listing(keys));
    truncated.set(keys[0], 0);

    expect(keysWithoutObjects(keys, truncated)).toEqual([keys[0]]);
  }, 120_000);

  test("an empty tree needs nothing from the bucket", async () => {
    expect(keysWithoutObjects([], new Map())).toEqual([]);
  }, 120_000);
});
