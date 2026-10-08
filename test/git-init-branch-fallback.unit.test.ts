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
import { ensureLocalMainBranch } from "../src/lib/git-annex/repo-state";

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

/**
 * A call the stand-in answers itself instead of passing it on: `when` is a shell
 * `case` pattern matched against the call's arguments joined by spaces.
 */
interface Answer {
  when: string;
  exit: number;
  stderr: string;
}

interface Shim {
  dir: string;
  log: string;
}

let root = "";
let gitConfig = "";
let shimCount = 0;

// The calls the stand-ins know how to answer.
const INIT_WITH_BRANCH = "'init -b '*";
const PLAIN_INIT = "'init '[!-]*";
const HEAD_REPOINT = "'symbolic-ref HEAD refs/heads/main'";

const answer = (when: string, exit: number, stderr: string): Answer => ({ when, exit, stderr });

/** A git stand-in on PATH: logs every call, answers the listed ones, runs the real git for the rest. */
function makeShim(answers: Answer[] = []): Shim {
  const dir = join(root, `shim-${shimCount++}`);
  const log = join(dir, "calls.log");
  mkdirSync(dir, { recursive: true });
  const arms = answers.flatMap((a) => [
    `  ${a.when})`,
    ...(a.stderr ? ["cat >&2 <<'NEMAR_SHIM_EOF'", a.stderr, "NEMAR_SHIM_EOF"] : []),
    `    exit ${a.exit}`,
    "    ;;",
  ]);
  const body = [
    "#!/bin/sh",
    `printf '%s\\n' "$*" >> '${log}'`,
    ...(arms.length > 0 ? ['case "$*" in', ...arms, "esac"] : []),
    `exec '${REAL_GIT}' "$@"`,
    "",
  ];
  const shim = join(dir, "git");
  writeFileSync(shim, body.join("\n"));
  chmodSync(shim, 0o755);
  writeFileSync(log, "");
  return { dir, log };
}

/** An older-git stand-in: `git init -b` is a usage error (status 129) with this text. */
function oldGit(stderr: string, ...more: Answer[]): Shim {
  return makeShim([answer(INIT_WITH_BRANCH, 129, stderr), ...more]);
}

/** The same logging wrapper over the modern git on this host: nothing is refused. */
function loggingGit(...answers: Answer[]): Shim {
  return makeShim(answers);
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
      const shim = makeShim([answer(INIT_WITH_BRANCH, c.exit, c.stderr)]);
      const dir = freshDir();
      const res = await withShim(shim, () => initDataset(dir, { author: AUTHOR }));

      expect(res).toEqual({ success: false, error: c.error });
      expect(initCalls(shim)).toEqual([`init -b main ${dir}`]);
      expect(headRepoints(shim)).toHaveLength(0);
    }, 30_000);
  }

  // On a git without -b the same path fails the retry as well; this one pins the
  // modern case, where the first and only init is the one that reports.
  test.skipIf(!REAL_GIT_HAS_INITIAL_BRANCH)(
    "a path that cannot be created is reported by the real git, once",
    async () => {
      const shim = loggingGit();
      const blocker = join(root, "a-file");
      writeFileSync(blocker, "x");
      const target = join(blocker, "sub");
      const res = await withShim(shim, () => initDataset(target, { author: AUTHOR }));

      // The report is git's own stderr, in whatever language git speaks here. A
      // later step failing on the missing directory would word it differently.
      const direct = spawnSync([REAL_GIT, "init", "-b", "main", target]);
      expect(direct.exitCode).not.toBe(0);
      expect(direct.stderr.toString().trim()).not.toBe("");
      expect(res).toEqual({ success: false, error: direct.stderr.toString().trim() });
      expect(initCalls(shim)).toEqual([`init -b main ${target}`]);
      expect(headRepoints(shim)).toHaveLength(0);
    },
  );

  test("a failing plain git init in the fallback is reported", async () => {
    const shim = oldGit(
      OLD_GIT_STDERR.english,
      answer(PLAIN_INIT, 128, "fatal: plain init refused"),
    );
    const dir = freshDir();
    const res = await withShim(shim, () => initDataset(dir, { author: AUTHOR }));

    expect(res).toEqual({ success: false, error: "fatal: plain init refused" });
    expect(initCalls(shim)).toEqual([`init -b main ${dir}`, `init ${dir}`]);
    expect(headRepoints(shim)).toHaveLength(0);
  });

  test("a failing HEAD re-point in the fallback is reported", async () => {
    const shim = oldGit(OLD_GIT_STDERR.english, answer(HEAD_REPOINT, 128, "fatal: head refused"));
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

/**
 * What the upload does next: `initializeAnnexDataset` initializes, then
 * `ensureLocalMainBranch` makes sure the branch is main, renaming it if not.
 */
async function initThenEnsureMain(shim: Shim, dir: string): Promise<boolean> {
  return withShim(shim, async () => {
    const res = await initDataset(dir, { author: AUTHOR });
    expect(res).toEqual({ success: true });
    return ensureLocalMainBranch(dir, { yes: true });
  });
}

describe("initDataset where the branch name was not chosen by git init", () => {
  /** A plain repository with two commits on master, made by the real git. */
  function seedMasterWithHistory(dir: string): void {
    mkdirSync(dir, { recursive: true });
    git(dir, "init", "-q", "-b", "master", ".");
    for (const message of ["c1", "c2"]) {
      git(
        dir,
        ...["-c", "user.name=t", "-c", "user.email=t@t"],
        ...["commit", "-q", "--allow-empty", "-m", message],
      );
    }
  }

  test("a fresh directory is already on main, so the upload renames nothing", async () => {
    const shim = oldGit(OLD_GIT_STDERR.english);
    const dir = freshDir();
    const renamedOrKept = await initThenEnsureMain(shim, dir);

    expect(renamedOrKept).toBe(true);
    expect(git(dir, "symbolic-ref", "--short", "HEAD").out).toStartWith("adjusted/main");
    expect(subjects(dir, "refs/heads/main")).toEqual(["Initialize dataset"]);
    expect(hasBranch(dir, "trunk")).toBe(false);
    expect(hasBranch(dir, "master")).toBe(false);
  });

  test("a repository with history keeps it: HEAD is not re-pointed at a new root", async () => {
    const shim = oldGit(OLD_GIT_STDERR.english);
    const dir = freshDir();
    seedMasterWithHistory(dir);
    const renamedOrKept = await initThenEnsureMain(shim, dir);

    expect(renamedOrKept).toBe(true);
    // Plain init re-initialized the repository and HEAD was left where it was.
    expect(initCalls(shim)).toEqual([`init -b main ${dir}`, `init ${dir}`]);
    expect(headRepoints(shim)).toHaveLength(0);
    // The history sits under the initial commit on master, three commits deep...
    expect(subjects(dir, "refs/heads/master")).toEqual(["Initialize dataset", "c2", "c1"]);
    // ...and the upload's rename path carries all of it to main. Re-pointing HEAD
    // at an unborn main would have made main a one-commit root and stranded c1
    // and c2 on master.
    const onMain = subjects(dir, "refs/heads/main");
    expect(onMain).toEqual(expect.arrayContaining(["Initialize dataset", "c2", "c1"]));
    expect(Number(git(dir, "rev-list", "--count", "refs/heads/main").out)).toBeGreaterThanOrEqual(
      3,
    );
  }, 30_000);

  test.skipIf(!REAL_GIT_HAS_INITIAL_BRANCH)(
    "the fallback ends where a modern git does on the same repository",
    async () => {
      // On a modern git `init -b main` is ignored for an existing repository
      // (it warns "re-init: ignored --initial-branch=main"), so this is the
      // reference outcome for the fallback to match.
      const modernDir = freshDir();
      seedMasterWithHistory(modernDir);
      await initThenEnsureMain(loggingGit(), modernDir);

      const oldDir = freshDir();
      seedMasterWithHistory(oldDir);
      await initThenEnsureMain(oldGit(OLD_GIT_STDERR.german), oldDir);

      expect(subjects(oldDir, "refs/heads/main")).toEqual(subjects(modernDir, "refs/heads/main"));
      expect(subjects(oldDir, "refs/heads/master")).toEqual(
        subjects(modernDir, "refs/heads/master"),
      );
      expect(git(oldDir, "symbolic-ref", "HEAD").out).toBe(
        git(modernDir, "symbolic-ref", "HEAD").out,
      );
    },
    60_000,
  );
});
