/**
 * Registering git-annex keys against a remote, and proving it (#1392).
 *
 * This is the step that decides whether a clone can fetch a dataset's content from
 * NEMAR at all. It used to run fifty `git annex setpresentkey` processes at once and
 * count every exit-0 as a registration: an import of 117 keys reported "Registered
 * 117 files" and the pushed location log recorded none of them, after which the
 * dataset was published with a permanent DOI and content no clone could resolve.
 *
 * So these tests assert against the location log, never against a return value alone,
 * and they run on a real git-annex repository with a real `type=directory` remote.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "../src/lib/git-annex/run-command";
import { batchSetKeysPresent } from "../src/lib/git-annex/transfer";

let repo: string;
let remoteUuid: string;
const scratch: string[] = [];

async function run(args: string[], cwd: string): Promise<string> {
  const { stdout, stderr, exitCode } = await runCommand(args, { cwd });
  if (exitCode !== 0) {
    throw new Error(`${args.join(" ")} failed: ${stderr.trim() || `exit ${exitCode}`}`);
  }
  return stdout;
}

function removeTree(dir: string): void {
  Bun.spawnSync(["chmod", "-R", "u+w", dir]);
  rmSync(dir, { recursive: true, force: true });
}

/** Keys the location log records at the remote, read independently of the helper. */
async function recordedKeys(): Promise<Set<string>> {
  const out = await run(
    ["git", "annex", "find", "--include", "*", "--in", remoteUuid, "--format=${key}\n"],
    repo,
  );
  return new Set(out.split("\n").filter(Boolean));
}

beforeEach(async () => {
  const root = mkdtempSync(join(tmpdir(), "nemar-keyreg-"));
  scratch.push(root);
  repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });
  await run(["git", "init", "-q", "--initial-branch", "main", "."], repo);
  // An identity per repository: git-annex commits to its own branch, and the
  // required CI tier runs with none configured.
  await run(["git", "config", "user.email", "test@nemar.test"], repo);
  await run(["git", "config", "user.name", "NEMAR Test"], repo);
  await run(["git", "annex", "init", "--quiet", "local"], repo);
  const store = join(root, "store");
  mkdirSync(store, { recursive: true });
  await run(
    [
      "git",
      "annex",
      "initremote",
      "stand-in",
      "type=directory",
      `directory=${store}`,
      "encryption=none",
    ],
    repo,
  );
  remoteUuid = (await run(["git", "config", "remote.stand-in.annex-uuid"], repo)).trim();
}, 120_000);

afterEach(() => {
  while (scratch.length > 0) {
    const dir = scratch.pop();
    if (!dir || !existsSync(dir)) continue;
    removeTree(dir);
  }
});

/** Add `count` distinct annexed files and return their keys. */
async function addFiles(count: number): Promise<string[]> {
  for (let i = 0; i < count; i++) {
    writeFileSync(join(repo, `f${i}.bin`), `content-${i}-`.repeat(200));
  }
  await run(["git", "annex", "add", "--quiet", "."], repo);
  await run(["git", "commit", "-qm", "add"], repo);
  const listed = await run(["git", "annex", "find", "--include", "*", "--format=${key}\n"], repo);
  return listed.split("\n").filter(Boolean);
}

describe("batchSetKeysPresent", () => {
  test("records every key, and the location log agrees", async () => {
    const keys = await addFiles(6);
    expect(keys).toHaveLength(6);

    const result = await batchSetKeysPresent(repo, keys, remoteUuid);

    expect(result).toEqual({ success: 6, failed: 0, missing: [] });
    // The claim that matters, asked of git-annex rather than of the return value.
    expect([...(await recordedKeys())].sort()).toEqual([...keys].sort());
  }, 120_000);

  test("records a large batch without losing any of it", async () => {
    // The production failure was silent loss under concurrency: 117 keys reported
    // registered, zero recorded. One process cannot lose a race with itself, and this
    // is the size at which the old implementation started dropping writes.
    const keys = await addFiles(120);
    expect(keys).toHaveLength(120);

    const result = await batchSetKeysPresent(repo, keys, remoteUuid);

    expect(result.failed).toBe(0);
    expect(result.success).toBe(120);
    expect((await recordedKeys()).size).toBe(120);
  }, 240_000);

  test("counts a key no file references, which `find` cannot see", async () => {
    // `git annex find` walks the working tree, so a key nothing references is
    // invisible to it even when the log records it. Reporting that as a failure would
    // abort a correct import; the helper asks `whereis --key` about exactly those.
    const [tracked] = await addFiles(1);
    const orphan =
      "SHA256E-s12345--0000000000000000000000000000000000000000000000000000000000000000.bin";

    const result = await batchSetKeysPresent(repo, [tracked, orphan], remoteUuid);

    expect(result.failed).toBe(0);
    expect(result.success).toBe(2);
    const whereis = await run(["git", "annex", "whereis", "--key", orphan], repo);
    expect(whereis).toContain(remoteUuid);
  }, 120_000);

  test("reports a key the log will not record as failed, and names it", async () => {
    // git-annex refuses a malformed key, so nothing is written for it. The helper has
    // to notice from the log rather than from a count it kept itself -- that is the
    // whole defect -- and the caller aborts before publishing on the strength of it.
    const [tracked] = await addFiles(1);

    const result = await batchSetKeysPresent(repo, [tracked, "not-a-valid-key"], remoteUuid);

    expect(result.failed).toBe(1);
    expect(result.success).toBe(1);
    expect(result.missing).toEqual(["not-a-valid-key"]);
    expect(await recordedKeys()).toEqual(new Set([tracked]));
  }, 120_000);

  test("an empty key list is a no-op, not an empty batch", async () => {
    expect(await batchSetKeysPresent(repo, [], remoteUuid)).toEqual({
      success: 0,
      failed: 0,
      missing: [],
    });
  }, 60_000);
});
