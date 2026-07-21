/**
 * git-annex service: clone, save, and push flows.
 *
 * Split from lib/git-annex.ts by concern (#908, epic #902); bodies moved
 * verbatim.
 */

import { getGitHubToken, resolveGitHubCloneAuth } from "./github.js";
import { getCurrentBranch } from "./repo-state.js";
import { runCommand } from "./run-command.js";

/**
 * Save all changes to the dataset
 *
 * If author info is provided, sets GIT_AUTHOR_NAME and GIT_AUTHOR_EMAIL
 * to ensure commits are attributed to the correct NEMAR user.
 */
export async function saveDataset(
  path: string,
  message: string,
  author?: { name: string; email: string },
): Promise<{ success: boolean; error?: string }> {
  try {
    // Build environment with optional author override
    const env: Record<string, string> = {};
    if (author) {
      env.GIT_AUTHOR_NAME = author.name;
      env.GIT_AUTHOR_EMAIL = author.email;
      env.GIT_COMMITTER_NAME = author.name;
      env.GIT_COMMITTER_EMAIL = author.email;
    }

    // Stage all changes with git add
    const { stderr: addStderr, exitCode: addExitCode } = await runCommand(["git", "add", "-A"], {
      cwd: path,
      ...(Object.keys(env).length > 0 ? { env } : {}),
    });

    if (addExitCode !== 0) {
      return { success: false, error: addStderr.trim() || "Failed to stage changes" };
    }

    // Check if there are changes to commit
    const {
      stdout: statusOut,
      exitCode: statusExitCode,
      stderr: statusStderr,
    } = await runCommand(["git", "status", "--porcelain"], {
      cwd: path,
    });

    if (statusExitCode !== 0) {
      return { success: false, error: statusStderr.trim() || "Failed to check git status" };
    }

    if (!statusOut.trim()) {
      // Nothing to commit
      return { success: true };
    }

    // Commit the changes
    const { stderr: commitStderr, exitCode: commitExitCode } = await runCommand(
      ["git", "commit", "-m", message],
      {
        cwd: path,
        ...(Object.keys(env).length > 0 ? { env } : {}),
      },
    );

    if (commitExitCode !== 0) {
      // Check if there's nothing to commit
      if (commitStderr.includes("nothing to commit")) {
        return { success: true };
      }
      return { success: false, error: commitStderr.trim() || "Failed to commit changes" };
    }

    return { success: true };
  } catch (e) {
    return { success: false, error: (e as Error).message };
  }
}

/**
 * Push data to S3 remote with parallel uploads
 */
/**
 * Push metadata to GitHub
 */
/**
 * True when `git push` was rejected because the remote ref advanced since our
 * clone/fetch (non-fast-forward). The cure is fetch + rebase + retry, not a hard
 * fail. Matches git's stderr wording across versions. Exported for testing.
 */
export function isNonFastForwardPush(stderr: string): boolean {
  return /\[rejected\]|fetch first|non-fast-forward|Updates were rejected/i.test(stderr);
}

/** How many fetch+rebase+retry cycles to attempt on a non-fast-forward push. */
const PUSH_REBASE_RETRIES = 3;

export async function pushToGitHub(
  path: string,
  remoteName = "origin",
  branch?: string,
): Promise<{ success: boolean; error?: string; warning?: string }> {
  try {
    // Detect current branch if not specified
    let branchToPush = branch;
    if (!branchToPush) {
      const currentBranch = await getCurrentBranch(path);
      if (!currentBranch || currentBranch === "HEAD") {
        // Check if there are any commits
        const { exitCode: logExitCode } = await runCommand(["git", "log", "-1", "--oneline"], {
          cwd: path,
        });

        if (logExitCode !== 0) {
          return {
            success: false,
            error:
              "No commits found. The repository may not have been initialized correctly, " +
              "or no changes were saved before pushing.",
          };
        }

        // In detached HEAD state with commits, we can push using HEAD:main
        if (currentBranch === "HEAD") {
          branchToPush = "HEAD:main";
        } else {
          return { success: false, error: "Could not detect current branch" };
        }
      } else if (currentBranch.startsWith("adjusted/")) {
        // git-annex adjusted branches (e.g. "adjusted/main(unlocked)") track a base branch.
        // Extract the base branch name and push with the correct refspec.
        const baseBranch = currentBranch.replace(/^adjusted\//, "").replace(/\(.*\)$/, "");
        branchToPush = `${currentBranch}:${baseBranch}`;
      } else {
        branchToPush = currentBranch;
      }
    }

    // Push current branch. On a non-fast-forward rejection -- the remote
    // advanced between our clone and this push, e.g. the async LLM-enrichment
    // workflow committing `.nemar/metadata.json` to main right after an import's
    // first push (the on005342 finalize race) -- integrate the remote commits
    // and retry. Bounded so a genuine divergence still fails loud. Adjusted
    // (DataLad) branches keep the original behavior: rebasing a git-annex
    // adjusted branch is unsafe.
    const baseBranch = branchToPush.includes(":")
      ? branchToPush.slice(branchToPush.indexOf(":") + 1)
      : branchToPush;
    // Detached HEAD (HEAD:main) has no local branch to rebase, and adjusted
    // (DataLad) branches must not be rebased -- both keep the plain push behavior.
    const canRebase = !branchToPush.startsWith("adjusted/") && branchToPush !== "HEAD:main";
    let mainStderr = "";
    let pushed = false;
    let rebaseCycles = 0;
    for (let attempt = 0; attempt <= PUSH_REBASE_RETRIES; attempt++) {
      const res = await runCommand(["git", "push", "-u", remoteName, branchToPush], { cwd: path });
      if (res.exitCode === 0) {
        pushed = true;
        break;
      }
      mainStderr = res.stderr;
      if (!canRebase || attempt === PUSH_REBASE_RETRIES || !isNonFastForwardPush(res.stderr)) {
        break;
      }
      // Integrate the remote's new commits, then retry. A fresh import clone has
      // no local commits on this branch, so the rebase is a clean fast-forward;
      // a caller with real local commits gets them replayed onto the remote tip.
      const fetchRes = await runCommand(["git", "fetch", remoteName], { cwd: path });
      if (fetchRes.exitCode !== 0) {
        return {
          success: false,
          error: `Push rejected (non-fast-forward) and the retry fetch of ${remoteName} failed: ${fetchRes.stderr.trim() || `exit ${fetchRes.exitCode}`}. Cannot integrate remote commits.`,
        };
      }
      const rebase = await runCommand(["git", "rebase", `${remoteName}/${baseBranch}`], {
        cwd: path,
      });
      if (rebase.exitCode !== 0) {
        await runCommand(["git", "rebase", "--abort"], { cwd: path });
        return {
          success: false,
          error: `Push rejected: ${remoteName}/${baseBranch} has diverging commits and auto-rebase failed: ${rebase.stderr.trim()}`,
        };
      }
      rebaseCycles++;
    }

    if (!pushed) {
      const note =
        rebaseCycles > 0
          ? ` (still rejected after ${rebaseCycles} fetch+rebase retry cycle(s))`
          : "";
      return { success: false, error: `${mainStderr.trim() || "Failed to push to GitHub"}${note}` };
    }

    // Push git-annex branch (critical for cloning). On non-fast-forward
    // rejection, fetch + `git annex merge` and retry -- the git-annex branch
    // must never be rebased (its append-only log format merges natively via
    // git-annex's own union-merge machinery); that's the one difference from
    // the main-branch retry above. Bounded so a genuine problem still surfaces.
    //
    // NOTE (#969): this is a LAST-RESORT SAFETY NET, not the idempotent-retry
    // mechanism. A retried `prepare` (src/lib/import-openneuro.ts) now
    // fetches + merges nemarDatasets' existing git-annex branch BEFORE
    // registering the S3 special remote, so a re-dispatch reuses the prior
    // nemar-s3 UUID via `enableremote` instead of minting a new one -- the
    // push below is then a trivial fast-forward. Relying on THIS loop instead
    // (merging divergent branches AFTER two independent `initremote` calls
    // already minted two different UUIDs for the same name) does not fix
    // that: finalize's `git annex info nemar-s3` sees "multiple repositories
    // with that description" and its `enableremote` fallback hard-errors
    // ("Multiple remotes have that name"), permanently breaking the import.
    // This loop only helps for a genuine, unrelated divergence (e.g. two
    // concurrent pushes), not the retry-created-a-second-UUID case.
    let annexStderr = "";
    let annexPushed = false;
    let annexMergeCycles = 0;
    for (let attempt = 0; attempt <= PUSH_REBASE_RETRIES; attempt++) {
      const res = await runCommand(["git", "push", remoteName, "git-annex"], { cwd: path });
      if (res.exitCode === 0) {
        annexPushed = true;
        break;
      }
      annexStderr = res.stderr;
      if (attempt === PUSH_REBASE_RETRIES || !isNonFastForwardPush(res.stderr)) {
        break;
      }
      const fetchRes = await runCommand(["git", "fetch", remoteName, "git-annex"], { cwd: path });
      if (fetchRes.exitCode !== 0) break;
      const mergeRes = await runCommand(["git", "annex", "merge"], { cwd: path });
      if (mergeRes.exitCode !== 0) break;
      annexMergeCycles++;
    }

    if (!annexPushed) {
      const note =
        annexMergeCycles > 0
          ? ` (still rejected after ${annexMergeCycles} fetch+merge retry cycle(s))`
          : "";
      // Not a fatal error, but return warning so callers can inform users
      return {
        success: true,
        warning: `Main branch pushed, but git-annex branch failed: ${annexStderr.trim()}${note}. Clone operations may have issues.`,
      };
    }

    return { success: true };
  } catch (e) {
    return { success: false, error: (e as Error).message };
  }
}

/**
 * Clone a dataset from GitHub.
 *
 * With `useGitHubToken`, a private `git@github.com:` repo is cloned over HTTPS
 * authenticated by `GH_TOKEN` (or a local `gh` token). The token is injected via
 * `GIT_CONFIG_*` env for the clone (never argv) and then persisted into the
 * cloned repo's config so a later push to the same origin authenticates too.
 * Used by the OpenNeuro import's finalize phase, which runs on a CI runner with
 * an HTTPS App token but no SSH key (nemarOrg/nemar-cli#768).
 */
export async function cloneDataset(
  repoUrl: string,
  outputPath: string,
  options: { useGitHubToken?: boolean } = {},
): Promise<{ success: boolean; error?: string }> {
  try {
    let cloneUrl = repoUrl;
    let credentialHelper: string | undefined;
    if (options.useGitHubToken) {
      let token = process.env.GH_TOKEN?.trim() || null;
      let ghError: string | undefined;
      if (!token) {
        const gh = await getGitHubToken();
        token = gh.token;
        ghError = gh.error;
      }
      const auth = resolveGitHubCloneAuth(repoUrl, token);
      cloneUrl = auth.url;
      credentialHelper = auth.credentialHelper;
      // For a private SSH URL the whole point of useGitHubToken is to avoid the
      // raw SSH clone that fails on a keyless CI runner (#768). If we could not
      // build a credential helper (no/malformed token), fail loudly here instead
      // of falling back to SSH and surfacing a cryptic "Permission denied
      // (publickey)" three steps later.
      if (repoUrl.startsWith("git@github.com:") && !credentialHelper) {
        return {
          success: false,
          error: `No usable GitHub token for authenticated clone of ${repoUrl} (GH_TOKEN unset/malformed${ghError ? `; gh CLI: ${ghError}` : ""}). Set GH_TOKEN on this runner.`,
        };
      }
    }

    // Inject the credential helper via GIT_CONFIG_* (not argv/URL) so the token
    // never lands in a process listing or CI command echo.
    const cloneEnv = credentialHelper
      ? {
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: "credential.https://github.com.helper",
          GIT_CONFIG_VALUE_0: credentialHelper,
        }
      : undefined;

    // Clone with git
    const { stderr: cloneStderr, exitCode: cloneExitCode } = await runCommand(
      ["git", "clone", cloneUrl, outputPath],
      cloneEnv ? { env: cloneEnv } : {},
    );

    if (cloneExitCode !== 0) {
      return { success: false, error: cloneStderr.trim() || "Failed to clone dataset" };
    }

    // Persist the credential helper so subsequent pushes to origin authenticate;
    // the GIT_CONFIG_* env above only covered the clone process itself. If this
    // write fails the later push would fail with a misleading auth error, so
    // surface it here.
    if (credentialHelper) {
      const { exitCode: cfgCode, stderr: cfgStderr } = await runCommand(
        ["git", "config", "credential.https://github.com.helper", credentialHelper],
        { cwd: outputPath },
      );
      if (cfgCode !== 0) {
        return {
          success: false,
          error: `Cloned but failed to persist the credential helper (later pushes would fail to authenticate): ${cfgStderr.trim() || "git config returned non-zero"}`,
        };
      }
    }

    // Initialize git-annex in the cloned repo
    const { stderr: initStderr, exitCode: initExitCode } = await runCommand(
      ["git", "annex", "init"],
      { cwd: outputPath },
    );

    if (initExitCode !== 0) {
      // Verify git-annex is actually initialized despite the error
      const { exitCode: checkCode } = await runCommand(["git", "annex", "info"], {
        cwd: outputPath,
      });

      if (checkCode !== 0) {
        return {
          success: false,
          error: `Cloned repository but git-annex initialization failed: ${initStderr.trim()}`,
        };
      }
      // Already initialized, non-fatal
      console.warn("git annex init returned non-zero but annex is initialized");
    }

    return { success: true };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Create a revert branch from the current state to a target version
 */
export async function createRevertBranch(
  datasetPath: string,
  targetVersion: string,
  branchName: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    // Create and checkout the revert branch
    const { stderr: branchErr, exitCode: branchCode } = await runCommand(
      ["git", "checkout", "-b", branchName],
      { cwd: datasetPath },
    );

    if (branchCode !== 0) {
      return { success: false, error: branchErr.trim() || "Failed to create branch" };
    }

    // Get the tag name
    const tag = targetVersion.startsWith("v") ? targetVersion : `v${targetVersion}`;

    // Checkout all files from the target version (except .git)
    const { stderr: checkoutErr, exitCode: checkoutCode } = await runCommand(
      ["git", "checkout", tag, "--", "."],
      { cwd: datasetPath },
    );

    if (checkoutCode !== 0) {
      return {
        success: false,
        error: checkoutErr.trim() || "Failed to checkout files from target version",
      };
    }

    return { success: true };
  } catch (e) {
    return { success: false, error: (e as Error).message };
  }
}

/**
 * Commit the revert changes
 */
export async function commitRevert(
  datasetPath: string,
  targetVersion: string,
  message?: string,
): Promise<{ success: boolean; error?: string }> {
  const commitMessage = message || `Revert to ${targetVersion}`;

  try {
    // Stage all changes
    const { exitCode: addCode } = await runCommand(["git", "add", "-A"], { cwd: datasetPath });

    if (addCode !== 0) {
      return { success: false, error: "Failed to stage changes" };
    }

    // Check if there are changes to commit
    const { stdout: statusOut } = await runCommand(["git", "status", "--porcelain"], {
      cwd: datasetPath,
    });

    if (!statusOut.trim()) {
      return { success: false, error: "No changes to revert (already at target version)" };
    }

    // Commit
    const { stderr: commitErr, exitCode: commitCode } = await runCommand(
      ["git", "commit", "-m", commitMessage],
      { cwd: datasetPath },
    );

    if (commitCode !== 0) {
      return { success: false, error: commitErr.trim() || "Failed to commit" };
    }

    return { success: true };
  } catch (e) {
    return { success: false, error: (e as Error).message };
  }
}

/**
 * Push a branch to remote
 */
export async function pushBranch(
  datasetPath: string,
  branchName: string,
  remoteName = "origin",
): Promise<{ success: boolean; error?: string }> {
  try {
    const { stderr, exitCode } = await runCommand(["git", "push", "-u", remoteName, branchName], {
      cwd: datasetPath,
    });

    if (exitCode !== 0) {
      return { success: false, error: stderr.trim() || "Failed to push branch" };
    }

    return { success: true };
  } catch (e) {
    return { success: false, error: (e as Error).message };
  }
}
