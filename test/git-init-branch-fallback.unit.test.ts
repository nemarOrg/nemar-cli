/**
 * `git init -b main` needs git >= 2.28. On git 2.25 (Ubuntu 20.04's system git,
 * common on HPC images) the upload's dataset init failed at "Initializing
 * git-annex dataset" with an unknown-switch error. `initDataset` now retries
 * with a plain `git init` and points an unborn HEAD at `refs/heads/main`.
 *
 * What is under test is the production entry point, `initDataset`, run against
 * real git and real git-annex. The only stand-in is a `git` on PATH that stands
 * in for an OLDER git BINARY: it logs every call, answers `git init -b` the way
 * git 2.25 does (a hand-written usage error, exit status 129), and hands every
 * other call to the real git, so every repository below is initialized by real
 * git. The fallback must key on that exit status and never on the message,
 * because git localizes its messages: the stand-in is run with English, German
 * and French text and with no text at all.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "bun";
import { initDataset } from "../src/lib/git-annex/init";

const REAL_GIT = Bun.which("git") ?? "";
const AUTHOR = { name: "Test", email: "test@test.com" };

// `-b` reached git in 2.28. On a host whose own git is older, the modern-git
// assertions below would be describing a git the host does not have.
const gitVersion = spawnSync([REAL_GIT, "--version"])
  .stdout.toString()
  .match(/(\d+)\.(\d+)/);
const REAL_GIT_HAS_INITIAL_BRANCH =
  gitVersion !== null &&
  (Number(gitVersion[1]) > 2 || (Number(gitVersion[1]) === 2 && Number(gitVersion[2]) >= 28));

/** How git 2.25 answers `git init -b main`, and how a localized git words the same refusal. */
const OLD_GIT_STDERR = {
  english: [
    "error: unknown switch `b'",
    "usage: git init [-q | --quiet] [--bare] [--template=<template-directory>] [--shared[=<permissions>]] [<directory>]",
  ].join("\n"),
  german: [
    "Fehler: Unbekannter Schalter `b'",
    "Verwendung: git init [-q | --quiet] [--bare] [--template=<Vorlagenverzeichnis>] [--shared[=<Berechtigungen>]] [<Verzeichnis>]",
  ].join("\n"),
  french: [
    "erreur : bascule inconnue « b »",
    "usage : git init [-q | --quiet] [--bare] [--template=<répertoire-de-modèles>] [--shared[=<permissions>]] [<répertoire>]",
  ].join("\n"),
  // A git whose catalog is missing, or whose stderr was discarded.
  empty: "",
};

interface ShimSpec {
  /** Answer `git init -b ...` with this status and stderr. Absent: the real git runs it. */
  initB?: { exit: number; stderr: string };
  /** Fail a plain `git init <dir>` (the fallback's first step) with status 128. */
  failPlainInit?: string;
  /** Fail `git symbolic-ref HEAD refs/heads/main` (the fallback's second step) with status 128. */
  failHeadRepoint?: string;
}

interface Shim {
  dir: string;
  log: string;
}

let root = "";
let gitConfig = "";
let shimCount = 0;

/** Lines of a heredoc that writes `stderr` and exits with `status`. */
function refusal(status: number, stderr: string): string[] {
  return [
    ...(stderr ? ["  cat >&2 <<'NEMAR_SHIM_EOF'", stderr, "NEMAR_SHIM_EOF"] : []),
    `  exit ${status}`,
  ];
}

function makeShim(spec: ShimSpec): Shim {
  const dir = join(root, `shim-${shimCount++}`);
  const log = join(dir, "calls.log");
  mkdirSync(dir, { recursive: true });
  const body = [
    "#!/bin/sh",
    `printf '%s\\n' "$*" >> '${log}'`,
    ...(spec.initB
      ? [
          'if [ "$1" = "init" ] && [ "$2" = "-b" ]; then',
          ...refusal(spec.initB.exit, spec.initB.stderr),
          "fi",
        ]
      : []),
    ...(spec.failPlainInit !== undefined
      ? [
          'if [ "$1" = "init" ] && [ "$2" != "-b" ]; then',
          ...refusal(128, spec.failPlainInit),
          "fi",
        ]
      : []),
    ...(spec.failHeadRepoint !== undefined
      ? [
          'if [ "$1" = "symbolic-ref" ] && [ "$2" = "HEAD" ] && [ "$3" = "refs/heads/main" ]; then',
          ...refusal(128, spec.failHeadRepoint),
          "fi",
        ]
      : []),
    `exec '${REAL_GIT}' "$@"`,
    "",
  ];
  const shim = join(dir, "git");
  writeFileSync(shim, body.join("\n"));
  chmodSync(shim, 0o755);
  writeFileSync(log, "");
  return { dir, log };
}

/** An older-git stand-in: `git init -b` is a usage error with this text. */
function oldGit(stderr: string, extra: Omit<ShimSpec, "initB"> = {}): Shim {
  return makeShim({ initB: { exit: 129, stderr }, ...extra });
}

/** The same logging wrapper over a modern git: nothing is refused. */
function loggingGit(): Shim {
  return makeShim({});
}

function calls(shim: Shim): string[] {
  return readFileSync(shim.log, "utf8").split("\n").filter(Boolean);
}

const initCalls = (shim: Shim): string[] => calls(shim).filter((l) => l.startsWith("init "));
const headRepoints = (shim: Shim): string[] =>
  calls(shim).filter((l) => l === "symbolic-ref HEAD refs/heads/main");

/** Run `fn` with `shim` first on PATH, and an init.defaultBranch that is not main. */
async function withShim<T>(shim: Shim, fn: () => Promise<T>): Promise<T> {
  const overrides: Record<string, string> = {
    PATH: `${shim.dir}:${process.env.PATH ?? ""}`,
    GIT_CONFIG_GLOBAL: gitConfig,
  };
  const saved = Object.keys(overrides).map((k) => [k, process.env[k]] as const);
  Object.assign(process.env, overrides);
  try {
    return await fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) Reflect.deleteProperty(process.env, k);
      else process.env[k] = v;
    }
  }
}

/** Real git, by absolute path, so inspecting a repository never writes to a shim log. */
function git(dir: string, ...args: string[]): { exit: number; out: string } {
  const r = spawnSync([REAL_GIT, ...args], { cwd: dir, env: { ...process.env } });
  return { exit: r.exitCode ?? -1, out: r.stdout.toString().trim() };
}

const subjects = (dir: string, ref: string): string[] =>
  git(dir, "log", "--format=%s", ref).out.split("\n").filter(Boolean);

const hasBranch = (dir: string, name: string): boolean =>
  git(dir, "show-ref", "--verify", "--quiet", `refs/heads/${name}`).exit === 0;

let dirCount = 0;
function freshDir(): string {
  return join(root, `repo-${dirCount++}`);
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "nemar-git-init-"));
  // A host default that is not "main": plain `git init` then leaves HEAD on
  // "trunk", so a fallback that forgot to re-point HEAD cannot pass by accident.
  gitConfig = join(root, "gitconfig");
  writeFileSync(gitConfig, "[init]\n\tdefaultBranch = trunk\n");
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("the older-git stand-ins", () => {
  for (const [name, stderr] of Object.entries(OLD_GIT_STDERR)) {
    test(`${name}: refuse git init -b with status 129 and say so on stderr`, async () => {
      const shim = oldGit(stderr);
      const r = await withShim(shim, async () =>
        spawnSync(["git", "init", "-b", "main", join(root, "probe")], { env: { ...process.env } }),
      );
      expect(r.exitCode).toBe(129);
      expect(r.stderr.toString().trim()).toBe(stderr);
    });
  }
});

describe("initDataset on a git that rejects --initial-branch (exit status 129)", () => {
  for (const [name, stderr] of Object.entries(OLD_GIT_STDERR)) {
    test(`${name} text: falls back, and the fresh dataset is on main`, async () => {
      const shim = oldGit(stderr);
      const dir = freshDir();
      const res = await withShim(shim, () => initDataset(dir, { author: AUTHOR }));

      expect(res).toEqual({ success: true });
      // -b was tried and refused, then the plain init, then HEAD was re-pointed.
      expect(initCalls(shim)).toEqual([`init -b main ${dir}`, `init ${dir}`]);
      expect(headRepoints(shim)).toHaveLength(1);
      // The unborn branch was main although the host's default is trunk, so
      // the initial commit and the adjusted branch both sit on main.
      expect(subjects(dir, "refs/heads/main")).toEqual(["Initialize dataset"]);
      expect(hasBranch(dir, "trunk")).toBe(false);
      expect(git(dir, "symbolic-ref", "--short", "HEAD").out).toStartWith("adjusted/main");
    }, 30_000);
  }
});

describe("initDataset when git init fails for any other reason", () => {
  const cases = [
    {
      name: "fatal status 128 that happens to carry the old usage text",
      exit: 128,
      stderr: OLD_GIT_STDERR.english,
      error: OLD_GIT_STDERR.english,
    },
    {
      name: "status 1 with no message",
      exit: 1,
      stderr: "",
      error: "Failed to initialize git repository",
    },
  ];

  for (const c of cases) {
    test(`${c.name}: reported once, not retried`, async () => {
      const shim = makeShim({ initB: { exit: c.exit, stderr: c.stderr } });
      const dir = freshDir();
      const res = await withShim(shim, () => initDataset(dir, { author: AUTHOR }));

      expect(res).toEqual({ success: false, error: c.error });
      expect(initCalls(shim)).toEqual([`init -b main ${dir}`]);
      expect(headRepoints(shim)).toHaveLength(0);
    }, 30_000);
  }

  test("a path that cannot be created is reported by the real git, once", async () => {
    const shim = loggingGit();
    const blocker = join(root, "a-file");
    writeFileSync(blocker, "x");
    const target = join(blocker, "sub");
    const res = await withShim(shim, () => initDataset(target, { author: AUTHOR }));

    expect(res.success).toBe(false);
    expect(res.error).toBeTruthy();
    expect(initCalls(shim)).toEqual([`init -b main ${target}`]);
    expect(headRepoints(shim)).toHaveLength(0);
  });

  test("a failing plain git init in the fallback is reported", async () => {
    const shim = oldGit(OLD_GIT_STDERR.english, { failPlainInit: "fatal: plain init refused" });
    const dir = freshDir();
    const res = await withShim(shim, () => initDataset(dir, { author: AUTHOR }));

    expect(res).toEqual({ success: false, error: "fatal: plain init refused" });
    expect(initCalls(shim)).toEqual([`init -b main ${dir}`, `init ${dir}`]);
    expect(headRepoints(shim)).toHaveLength(0);
  });

  test("a failing HEAD re-point in the fallback is reported", async () => {
    const shim = oldGit(OLD_GIT_STDERR.english, { failHeadRepoint: "fatal: head refused" });
    const dir = freshDir();
    const res = await withShim(shim, () => initDataset(dir, { author: AUTHOR }));

    expect(res).toEqual({ success: false, error: "fatal: head refused" });
    expect(headRepoints(shim)).toHaveLength(1);
  });
});

describe("initDataset on a modern git", () => {
  test.skipIf(!REAL_GIT_HAS_INITIAL_BRANCH)(
    "uses -b main directly: the fallback never runs",
    async () => {
      const shim = loggingGit();
      const dir = freshDir();
      const res = await withShim(shim, () => initDataset(dir, { author: AUTHOR }));

      expect(res).toEqual({ success: true });
      // Exactly one init, and it is the one with -b; no plain init, no re-point.
      expect(initCalls(shim)).toEqual([`init -b main ${dir}`]);
      expect(headRepoints(shim)).toHaveLength(0);
      expect(subjects(dir, "refs/heads/main")).toEqual(["Initialize dataset"]);
      expect(hasBranch(dir, "trunk")).toBe(false);
    },
    30_000,
  );
});
