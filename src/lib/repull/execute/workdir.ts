/**
 * Where a re-pull is executed, and the working clone it is prepared in (ADR 0111, decision 2;
 * epic #1046 phase 6). Execution runs on the administrator's machine.
 *
 * The execution directory is `$NEMAR_CONFIG_DIR/repull/<id>/work/<digest8>/`, mode 0700, because a
 * path can itself be an identifier and the clone holds every path of the dataset. It holds:
 *  - `repo/`, a fresh, non-partial clone of NEMAR's `main` at depth 2 (so the base commit and its
 *    parent are present), checked out at the base on the branch `repull-work`, with git-annex
 *    initialized and NO special remote enabled: uploads go through `awsCliUpload` and are
 *    registered against the uuid the plan checked;
 *  - `plan/`, the planner's bare clones of the live plan (`nemar.git`, `upstream.git`), the second
 *    being where upstream's blobs are read from; made again on every run, since the plan is;
 *  - `upload/`, `awsCliUpload`'s staging, outside the clone so it is never a changed path.
 * It is kept until the pull request is open. Only a `prepared` row resumes from it (its working
 * clone, or the checkpoint beside it); a `planned` row is prepared again from scratch.
 *
 * Every git call here carries its credentials in the environment (`fleetCloneEnv`), never in the
 * argv or the URL, reads neither the global nor the system git configuration
 * ({@link ISOLATED_GIT_ENV}), and no message it throws repeats git's stderr, which names files.
 */

import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fleetCloneEnv } from "../../fleet-key-registration.js";
import { runCommand } from "../../git-annex/run-command.js";
import { ExecuteRefused } from "./verify-plan.js";

/** The identity every commit a re-pull makes carries (its dates are the row's `created_at`). */
export const REPULL_IDENTITY = { name: "NEMAR re-pull", email: "noreply@nemar.org" } as const;

/** The branch the working clone prepares on; it ends at the synthesized commit. */
export const WORK_BRANCH = "repull-work";

export interface WorkPaths {
  /** `$NEMAR_CONFIG_DIR/repull/<id>/work/<digest8>/` */
  root: string;
  repo: string;
  plan: string;
  upload: string;
  /** The checkpoint bundle, beside the plan files: `$NEMAR_CONFIG_DIR/repull/<id>/<digest8>.bundle`. */
  bundle: string;
  /** The one execution's lock: `$NEMAR_CONFIG_DIR/repull/<id>/<digest8>.lock`. */
  lock: string;
}

export function digest8(digest: string): string {
  return digest.slice("sha256:".length, "sha256:".length + 8);
}

export function workPaths(configDir: string, datasetId: string, digest: string): WorkPaths {
  const dsDir = join(configDir, "repull", datasetId);
  const root = join(dsDir, "work", digest8(digest));
  return {
    root,
    repo: join(root, "repo"),
    plan: join(root, "plan"),
    upload: join(root, "upload"),
    bundle: join(dsDir, `${digest8(digest)}.bundle`),
    lock: join(dsDir, `${digest8(digest)}.lock`),
  };
}

/** A directory, and each one above it up to `top`, created with mode 0700. */
export function privateDir(path: string, top: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  // `mode` applies only to directories mkdir creates, so the ones that existed are set as well.
  for (let dir = path; dir.startsWith(top); dir = dirname(dir)) {
    chmodSync(dir, 0o700);
    if (dir === top) break;
  }
}

/**
 * The environment every git and git-annex call of an execution runs with: neither the
 * administrator's global configuration nor the system's is read, so nothing on the machine
 * (`annex.addunlocked`, `core.autocrlf`, a global attributes or excludes file, a hook, a backend)
 * can change what is prepared. The working clone's own configuration is set where it is made.
 */
export const ISOLATED_GIT_ENV = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
} as const;

/**
 * The working clone's local configuration, set when it is cloned so even its first checkout obeys
 * it: no background gc or maintenance (a writer in the clone would race its removal), locked
 * annexed files, no line-ending conversion, no hooks, and no attributes or excludes file but the
 * tree's own.
 */
const CLONE_CONFIG = [
  "gc.auto=0",
  "maintenance.auto=false",
  "annex.addunlocked=false",
  "core.autocrlf=false",
  "core.hooksPath=/dev/null",
  "core.attributesFile=/dev/null",
  "core.excludesFile=/dev/null",
] as const;

/**
 * Run `fn` with {@link ISOLATED_GIT_ENV} in the process environment, which every git subprocess
 * inherits, the importer's scrub and upload included; the previous values are put back after.
 */
export async function withIsolatedGit<T>(fn: () => Promise<T>): Promise<T> {
  const saved = Object.keys(ISOLATED_GIT_ENV).map((k) => [k, process.env[k]] as const);
  Object.assign(process.env, ISOLATED_GIT_ENV);
  try {
    return await fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) Reflect.deleteProperty(process.env, k);
      else process.env[k] = v;
    }
  }
}

export interface GitResult {
  stdout: string;
  exitCode: number;
}

/**
 * Run git in the working clone. A failure throws {@link ExecuteRefused} with `code` and the step
 * named, never git's own stderr: it names paths.
 */
export async function git(
  repo: string,
  args: string[],
  opts: {
    code?: string;
    step?: string;
    stdin?: string;
    env?: Record<string, string>;
    ok?: boolean;
  } = {},
): Promise<GitResult> {
  const r = await runCommand(["git", ...args], {
    cwd: repo,
    ...(opts.stdin !== undefined ? { stdin: opts.stdin } : {}),
    env: { ...ISOLATED_GIT_ENV, ...opts.env },
  });
  if (r.exitCode !== 0 && !opts.ok) {
    throw new ExecuteRefused(
      opts.code ?? "git-failed",
      `git ${opts.step ?? args[0] ?? ""} failed in the working clone (exit ${r.exitCode}).`,
    );
  }
  return { stdout: r.stdout, exitCode: r.exitCode };
}

/** True when the commit exists in the repository (no fetch). */
export async function hasCommit(repo: string, sha: string): Promise<boolean> {
  const r = await runCommand(["git", "cat-file", "-e", `${sha}^{commit}`], {
    cwd: repo,
    env: { ...ISOLATED_GIT_ENV, GIT_NO_LAZY_FETCH: "1" },
  });
  return r.exitCode === 0;
}

/**
 * A fresh working clone of `originUrl` at `main`, checked out at `baseSha` on {@link WORK_BRANCH},
 * with the git-annex branch fetched and git-annex initialized without enabling any special remote.
 * `main-moved` when `baseSha` is not `main` or reachable from it within the clone's depth and
 * cannot be fetched by id.
 */
export async function workClone(args: {
  dir: string;
  originUrl: string;
  baseSha: string;
  token: string | null;
  /** The git-annex commit the plan read; the clone refuses one that moved (`plan-stale`). */
  annexCommit: string;
}): Promise<string> {
  removeTree(args.dir);
  const env = fleetCloneEnv(args.originUrl, args.token);
  const clone = await runCommand(
    [
      "git",
      "clone",
      "--quiet",
      "--no-tags",
      "--depth=2",
      ...CLONE_CONFIG.flatMap((c) => ["--config", c]),
      "--branch",
      "main",
      args.originUrl,
      args.dir,
    ],
    { env: { ...ISOLATED_GIT_ENV, ...env } },
  );
  if (clone.exitCode !== 0) {
    throw new ExecuteRefused(
      "clone-failed",
      `NEMAR's repository could not be cloned (exit ${clone.exitCode}).`,
    );
  }
  const repo = args.dir;
  const opts = env ? { env } : {};
  if (!(await hasCommit(repo, args.baseSha))) {
    await git(repo, ["fetch", "--quiet", "--no-tags", "--depth=2", "origin", args.baseSha], {
      ...opts,
      ok: true,
    });
  }
  if (!(await hasCommit(repo, args.baseSha))) {
    throw new ExecuteRefused(
      "main-moved",
      "The commit the re-pull bases on is no longer reachable on NEMAR's main: plan again.",
    );
  }
  await git(repo, ["config", "user.name", REPULL_IDENTITY.name]);
  await git(repo, ["config", "user.email", REPULL_IDENTITY.email]);
  await git(repo, ["config", "commit.gpgsign", "false"]);
  await git(repo, ["checkout", "--quiet", "-B", WORK_BRANCH, args.baseSha], { step: "checkout" });
  await git(
    repo,
    [
      "fetch",
      "--quiet",
      "--no-tags",
      "--depth=1",
      "origin",
      "+refs/heads/git-annex:refs/remotes/origin/git-annex",
    ],
    { ...opts, code: "clone-failed", step: "fetch of the git-annex branch" },
  );
  // NEMAR's git-annex branch is where the plan read it, or the plan is stale: presence, dead marks
  // and remote.log all come from it, and the copy manifest was made against it.
  const annex = (
    await git(repo, ["rev-parse", "--verify", "--quiet", "refs/remotes/origin/git-annex"], {
      ok: true,
    })
  ).stdout.trim();
  if (annex !== args.annexCommit) {
    throw new ExecuteRefused(
      "plan-stale",
      "NEMAR's git-annex branch moved since the plan was made again: plan again and review the new digest.",
    );
  }
  await git(repo, ["annex", "init", "--quiet", "--no-autoenable", "nemar-repull"], {
    code: "clone-failed",
    step: "annex init",
  });
  return repo;
}

/**
 * Save the prepared state as a git bundle, mode 0600: the synthesized commit (on
 * {@link WORK_BRANCH}) and the local git-annex branch, which holds what this host uploaded and the
 * keys the scrub retired. Its prerequisites are the base and origin's git-annex branch as fetched,
 * so it holds only what the preparation added. A lost working directory is restored from it
 * without preparing again.
 */
export async function saveCheckpoint(repo: string, bundle: string, baseSha: string): Promise<void> {
  rmSync(bundle, { force: true });
  await git(
    repo,
    [
      "bundle",
      "create",
      "--quiet",
      bundle,
      `refs/heads/${WORK_BRANCH}`,
      "refs/heads/git-annex",
      `^${baseSha}`,
      "^refs/remotes/origin/git-annex",
    ],
    { code: "checkpoint-failed", step: "bundle create" },
  );
  chmodSync(bundle, 0o600);
}

/** Why a checkpoint was not used, in fixed words, for the operator. */
export type RestoreCause =
  | "no-checkpoint"
  | "clone-failed"
  | "checkpoint-unverified"
  | "checkpoint-unreadable"
  | "commit-not-in-checkpoint"
  | "annex-merge-failed";

/**
 * Restore a checkpoint into a fresh working clone. Null when the bundle verifies and delivers the
 * recorded commit `synthSha`, the clone is checked out at it with the tree `synthTree` on the
 * parent `baseSha`, and the bundle's git-annex branch is merged; otherwise why not (the caller
 * prepares again).
 */
export async function restoreCheckpoint(args: {
  dir: string;
  bundle: string;
  originUrl: string;
  baseSha: string;
  token: string | null;
  annexCommit: string;
  synthSha: string;
  synthTree: string;
}): Promise<RestoreCause | null> {
  if (!existsSync(args.bundle)) return "no-checkpoint";
  let repo: string;
  try {
    repo = await workClone({
      dir: args.dir,
      originUrl: args.originUrl,
      baseSha: args.baseSha,
      token: args.token,
      annexCommit: args.annexCommit,
    });
  } catch {
    return "clone-failed";
  }
  const verified = await git(repo, ["bundle", "verify", "--quiet", args.bundle], { ok: true });
  if (verified.exitCode !== 0) return "checkpoint-unverified";
  const fetched = await git(
    repo,
    [
      "fetch",
      "--quiet",
      "--no-tags",
      args.bundle,
      `refs/heads/${WORK_BRANCH}:refs/remotes/checkpoint/${WORK_BRANCH}`,
      "refs/heads/git-annex:refs/remotes/checkpoint/git-annex",
    ],
    { ok: true },
  );
  if (fetched.exitCode !== 0) return "checkpoint-unreadable";
  // The clone must end at the recorded commit, whose tree is the recorded tree: whatever ref the
  // bundle names, only the commit itself, by its id, is taken.
  await git(repo, ["checkout", "--quiet", "-B", WORK_BRANCH, args.synthSha], { ok: true });
  const rev = async (spec: string) =>
    (await git(repo, ["rev-parse", "--verify", "--quiet", spec], { ok: true })).stdout.trim();
  if (
    (await rev("HEAD")) !== args.synthSha ||
    (await rev("HEAD^{tree}")) !== args.synthTree ||
    (await rev("HEAD^")) !== args.baseSha
  ) {
    return "commit-not-in-checkpoint";
  }
  // `git annex merge` takes every `refs/remotes/*/git-annex`, the checkpoint's included.
  const merged = await git(repo, ["annex", "merge", "--quiet"], { ok: true });
  return merged.exitCode === 0 ? null : "annex-merge-failed";
}

/**
 * Hold the one execution of a plan: a directory created atomically beside the plan's working
 * directory, holding the process id. A second execution of the same plan refuses
 * (`execution-locked`) rather than delete a live run's clones; a lock whose process is gone (a
 * crash) is taken over. Returns the release.
 */
export function acquireLock(path: string): () => void {
  const pidFile = join(path, "pid");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      mkdirSync(path, { mode: 0o700 });
      writeFileSync(pidFile, `${process.pid}\n`, { mode: 0o600 });
      return () => rmSync(path, { recursive: true, force: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    const pid = Number.parseInt(
      (() => {
        try {
          return readFileSync(pidFile, "utf8");
        } catch {
          return "";
        }
      })(),
      10,
    );
    if (Number.isSafeInteger(pid) && pid > 0 && isAlive(pid)) {
      throw new ExecuteRefused(
        "execution-locked",
        `Another execution of this plan is running (process ${pid}); wait for it to finish.`,
      );
    }
    // A crashed run's lock, or one being written right now: removed and tried once more.
    rmSync(path, { recursive: true, force: true });
  }
  throw new ExecuteRefused(
    "execution-locked",
    "Another execution of this plan holds its lock; wait for it to finish.",
  );
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it exists, and belongs to someone else.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Give the owner write access to every directory under `path` (git-annex makes its objects' read-only). */
function makeWritable(path: string): void {
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(path);
  } catch {
    return;
  }
  if (!st.isDirectory()) return;
  try {
    chmodSync(path, (st.mode & 0o7777) | 0o700);
  } catch {
    // rmSync below reports what could not be removed.
  }
  for (const name of readdirSync(path)) makeWritable(join(path, name));
}

/**
 * Remove a directory tree; nothing when it is absent. git-annex leaves the directories that hold
 * annexed content read-only, so they are made writable first, or the removal would fail on them.
 * It is never left half removed in silence: it tries again while the tree is there, and refuses
 * (`workdir-busy`) when it cannot, since a clone made into the rest would fail obscurely.
 */
export function removeTree(path: string): void {
  for (let attempt = 1; existsSync(path); attempt++) {
    makeWritable(path);
    try {
      rmSync(path, { recursive: true, maxRetries: 5, retryDelay: 50 });
    } catch (err) {
      // An entry that vanished under the walk (ENOENT) is no failure: the loop looks again.
      if (attempt >= 5) {
        throw new ExecuteRefused(
          "workdir-busy",
          `A working directory could not be removed (${(err as NodeJS.ErrnoException).code ?? "error"}); is another run using it?`,
        );
      }
    }
  }
}
