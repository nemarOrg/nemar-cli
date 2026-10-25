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
 * It is kept until the pull request is open, so a crash leaves it to resume.
 *
 * Every git call here carries its credentials in the environment (`fleetCloneEnv`), never in the
 * argv or the URL, and no message it throws repeats git's stderr, which names files.
 */

import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, rmSync } from "node:fs";
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
    ...(opts.env ? { env: opts.env } : {}),
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
    env: { GIT_NO_LAZY_FETCH: "1" },
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
      // No detached gc or maintenance after a fetch: a background writer in the clone would race
      // its removal, and nothing here needs it.
      "--config",
      "gc.auto=0",
      "--config",
      "maintenance.auto=false",
      "--branch",
      "main",
      args.originUrl,
      args.dir,
    ],
    env ? { env } : {},
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

/**
 * Restore a checkpoint into a fresh working clone. True only when the bundle verifies and delivers
 * the recorded commit `synthSha`, the clone is checked out at it with the tree `synthTree` on the
 * parent `baseSha`, and the bundle's git-annex branch is merged; false otherwise (the caller
 * prepares again).
 */
export async function restoreCheckpoint(args: {
  dir: string;
  bundle: string;
  originUrl: string;
  baseSha: string;
  token: string | null;
  synthSha: string;
  synthTree: string;
}): Promise<boolean> {
  if (!existsSync(args.bundle)) return false;
  let repo: string;
  try {
    repo = await workClone({
      dir: args.dir,
      originUrl: args.originUrl,
      baseSha: args.baseSha,
      token: args.token,
    });
  } catch {
    return false;
  }
  const verified = await git(repo, ["bundle", "verify", "--quiet", args.bundle], { ok: true });
  if (verified.exitCode !== 0) return false;
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
  if (fetched.exitCode !== 0) return false;
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
    return false;
  }
  // `git annex merge` takes every `refs/remotes/*/git-annex`, the checkpoint's included.
  const merged = await git(repo, ["annex", "merge", "--quiet"], { ok: true });
  return merged.exitCode === 0;
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
