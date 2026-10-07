/**
 * `git init -b main` needs git >= 2.28. On git 2.25 (Ubuntu 20.04 system git)
 * the upload's dataset init failed with "unknown switch `b'" and depositors had
 * to put a git shim on PATH. initGitRepoOnMain falls back to `git init` plus
 * `git symbolic-ref HEAD refs/heads/main`.
 *
 * The old-git case is reproduced with a PATH shim that answers `git init -b`
 * exactly like git 2.25 and passes everything else to the real git.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "bun";
import { initGitRepoOnMain, isInitialBranchUnsupported } from "../src/lib/git-annex/init";

const TMP_DIR = join(import.meta.dir, ".test-git-init-fallback");
const GIT_225_STDERR = [
  "error: unknown switch `b'",
  "usage: git init [-q | --quiet] [--bare] [--template=<template-directory>] [--shared[=<permissions>]] [<directory>]",
  "",
  "    --template <template-directory>",
  "                          directory from which templates will be used",
].join("\n");

describe("isInitialBranchUnsupported", () => {
  test("recognises git 2.25's answer to -b", () => {
    expect(isInitialBranchUnsupported(GIT_225_STDERR)).toBe(true);
  });

  test("does not mistake other init failures for it", () => {
    expect(isInitialBranchUnsupported("fatal: cannot mkdir /root/x: Permission denied")).toBe(
      false,
    );
    expect(isInitialBranchUnsupported("")).toBe(false);
  });
});

describe("initGitRepoOnMain", () => {
  const realGit = spawnSync(["sh", "-c", "command -v git"]).stdout.toString().trim();
  const shimDir = join(TMP_DIR, "bin");
  let savedPath: string | undefined;

  beforeAll(() => {
    mkdirSync(shimDir, { recursive: true });
    const shim = join(shimDir, "git");
    writeFileSync(
      shim,
      [
        "#!/bin/sh",
        '# Behaves like git 2.25 for "git init -b"; everything else goes to the real git.',
        `echo "$*" >> "${join(TMP_DIR, "shim.log")}"`,
        'if [ "$1" = "init" ] && [ "$2" = "-b" ]; then',
        `  cat >&2 <<'EOF'\n${GIT_225_STDERR}\nEOF`,
        "  exit 129",
        "fi",
        `exec "${realGit}" "$@"`,
        "",
      ].join("\n"),
    );
    chmodSync(shim, 0o755);
  });

  afterAll(() => {
    if (savedPath !== undefined) process.env.PATH = savedPath;
    if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true, force: true });
  });

  function headOf(dir: string): string {
    return spawnSync([realGit, "symbolic-ref", "HEAD"], { cwd: dir }).stdout.toString().trim();
  }

  test("modern git: -b main is used directly", async () => {
    const dir = join(TMP_DIR, "modern");
    expect(await initGitRepoOnMain(dir)).toEqual({ success: true });
    expect(headOf(dir)).toBe("refs/heads/main");
  });

  test("git without -b: falls back and still lands on main", async () => {
    savedPath = process.env.PATH;
    process.env.PATH = `${shimDir}:${savedPath}`;
    try {
      // Sanity: the shim really refuses -b.
      const probe = spawnSync(["git", "init", "-b", "main", join(TMP_DIR, "probe")], {
        env: process.env,
      });
      expect(probe.exitCode).toBe(129);

      const dir = join(TMP_DIR, "old");
      expect(await initGitRepoOnMain(dir)).toEqual({ success: true });
      expect(headOf(dir)).toBe("refs/heads/main");
      // The CLI went through the shim: -b was refused, then the fallback ran.
      const calls = readFileSync(join(TMP_DIR, "shim.log"), "utf8");
      expect(calls).toContain(`init -b main ${dir}`);
      expect(calls).toContain(`init ${dir}`);
      expect(calls).toContain("symbolic-ref HEAD refs/heads/main");
      // The unborn branch is main even if the host's init.defaultBranch is not.
      const commit = spawnSync(
        [
          realGit,
          "-c",
          "user.name=t",
          "-c",
          "user.email=t@t",
          "commit",
          "--allow-empty",
          "-qm",
          "x",
        ],
        { cwd: dir },
      );
      expect(commit.exitCode).toBe(0);
      expect(
        spawnSync([realGit, "branch", "--show-current"], { cwd: dir }).stdout.toString().trim(),
      ).toBe("main");
    } finally {
      process.env.PATH = savedPath;
    }
  });

  test("a different init failure is reported, not retried", async () => {
    const blocker = join(TMP_DIR, "afile");
    writeFileSync(blocker, "x");
    const res = await initGitRepoOnMain(join(blocker, "sub"));
    expect(res.success).toBe(false);
    expect(res.error).toBeTruthy();
  });
});
