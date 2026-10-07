/**
 * #1399: `git annex init` with no description records `user@host:/path` in the
 * git-annex branch's uuid.log, which is public once the dataset is; from a
 * cluster node that is e.g. `alice@node-1-20:/scratch/lab/alice/.../bids`.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import { join } from "node:path";
import { spawn } from "bun";
import {
  ANNEX_DEPOSIT_DESCRIPTION,
  ensureGitAnnexInitialized,
  initDataset,
  isDefaultAnnexDescription,
  replaceDefaultAnnexDescription,
} from "../src/lib/git-annex/init";

const TMP_DIR = join(import.meta.dir, ".test-annex-init-description");

async function run(cmd: string[], cwd?: string) {
  const proc = spawn({ cmd, cwd, stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  await new Response(proc.stderr).text();
  return { stdout, exitCode: await proc.exited };
}

function freshDir(name: string): string {
  const dir = join(TMP_DIR, `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function uuidLog(dir: string): Promise<string> {
  return (await run(["git", "show", "git-annex:uuid.log"], dir)).stdout;
}

function assertNoIdentity(log: string, dir: string): void {
  expect(log).not.toContain(`${userInfo().username}@`);
  expect(log).not.toContain(hostname());
  expect(log).not.toContain(dir);
}

afterAll(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true, force: true });
});

describe("isDefaultAnnexDescription", () => {
  test("matches git-annex's default form only", () => {
    expect(isDefaultAnnexDescription("alice@node-1-20:/scratch/lab/x/bids")).toBe(true);
    expect(isDefaultAnnexDescription("me@laptop.lan:/private/tmp/ds [here]")).toBe(true);
    expect(isDefaultAnnexDescription("me@laptop.lan:~/data/ds [here]")).toBe(true);
    expect(isDefaultAnnexDescription("nemar-deposit")).toBe(false);
    expect(isDefaultAnnexDescription("my lab's copy")).toBe(false);
    expect(isDefaultAnnexDescription("")).toBe(false);
  });
});

describe("annex repository description (real git-annex)", () => {
  test("initDataset records the fixed description, not user@host:/path", async () => {
    const dir = freshDir("init");
    const res = await initDataset(dir, { author: { name: "T", email: "t@t" } });
    expect(res.success).toBe(true);
    const log = await uuidLog(dir);
    expect(log).toContain(ANNEX_DEPOSIT_DESCRIPTION);
    assertNoIdentity(log, dir);
  });

  test("ensureGitAnnexInitialized on a plain git repo does the same", async () => {
    const dir = freshDir("ensure");
    expect((await run(["git", "init", "-q", dir])).exitCode).toBe(0);
    expect((await ensureGitAnnexInitialized(dir)).success).toBe(true);
    const log = await uuidLog(dir);
    expect(log).toContain(ANNEX_DEPOSIT_DESCRIPTION);
    assertNoIdentity(log, dir);
  });

  test("a repository with the default description is re-described; a chosen one is kept", async () => {
    const dir = freshDir("legacy");
    await run(["git", "init", "-q", dir]);
    await run(["git", "annex", "init", "-q"], dir); // old behaviour: default description
    expect(await uuidLog(dir)).toContain(`${userInfo().username}@`);

    expect(await replaceDefaultAnnexDescription(dir)).toBe(true);
    const info = await run(["git", "annex", "info", "here", "--json", "--fast"], dir);
    expect(JSON.parse(info.stdout).description).toContain(ANNEX_DEPOSIT_DESCRIPTION);
    // Idempotent: nothing left to replace.
    expect(await replaceDefaultAnnexDescription(dir)).toBe(false);

    const chosen = freshDir("chosen");
    await run(["git", "init", "-q", chosen]);
    await run(["git", "annex", "init", "-q", "lab archive"], chosen);
    expect(await replaceDefaultAnnexDescription(chosen)).toBe(false);
  });
});
