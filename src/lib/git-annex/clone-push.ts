/**
 * git-annex service: clone, save, and push flows. The save flow can skip re-reading
 * annexed content under a set of guards; see {@link saveDataset}.
 */

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { statSync, writeSync } from "node:fs";
import { join } from "node:path";
import { displayName, displayNames, isPrintableInCommand } from "../display-name.js";
import { getGitHubToken, resolveGitHubCloneAuth } from "./github.js";
import { ANNEX_CLONE_DESCRIPTION, chunkAddTargets, isDefaultAnnexDescription } from "./init.js";
import { getCurrentBranch } from "./repo-state.js";
import { runCommand } from "./run-command.js";

/**
 * An annexed path whose working-tree content `saveDataset` may skip re-reading, with
 * the size and mtime the upload plan recorded for it. `path` is relative to the
 * directory `saveDataset` is called with.
 */
export interface SkipContentCheckEntry {
  path: string;
  size: number;
  mtimeMs: number;
}

/** Git's lowercase `ls-files -v` tag marks a path assume-unchanged. */
const ASSUME_UNCHANGED_TAG = /^[a-z] /;

// #1399 exempts the NEMAR import runner: its generic account and /tmp scratch
// path are not the depositor's account or project directory.
function isNEMARImportRunnerDescription(description: string): boolean {
  return /^runner@[^:\s]+:\/tmp\/nemar-import-[^/\s]+(?:\/.*)?$/.test(description);
}

function defaultDescriptionsForUuidHistory(diff: string): Set<string> {
  const descriptions = new Set<string>();
  for (const line of diff.split("\n")) {
    if (!line.startsWith("+") || line.startsWith("+++")) continue;
    const addedLine = line.slice(1);
    const separator = addedLine.indexOf(" ");
    if (separator <= 0) continue;
    const uuid = addedLine.slice(0, separator);
    const entry = addedLine.slice(separator + 1);
    const description = entry.replace(/\s+timestamp=\d+(?:\.\d+)?s?$/, "");
    if (isDefaultAnnexDescription(description) && !isNEMARImportRunnerDescription(description)) {
      descriptions.add(`${uuid}\0${description}`);
    }
  }
  return descriptions;
}

async function defaultDescriptionHistory(
  path: string,
  revision: string,
): Promise<{ success: true; descriptions: Set<string> } | { success: false }> {
  const history = await runCommand(
    [
      "git",
      "log",
      "--format=",
      "--no-color",
      "--no-ext-diff",
      "--no-renames",
      "-m",
      "-p",
      revision,
      "--",
      "uuid.log",
    ],
    { cwd: path },
  );
  if (history.exitCode !== 0) return { success: false };
  return { success: true, descriptions: defaultDescriptionsForUuidHistory(history.stdout) };
}

async function fetchRemoteAnnexOid(
  path: string,
  remoteName: string,
): Promise<{ success: true; oid: string } | { success: false }> {
  const checkRef = `refs/nemar/git-annex-check/${randomUUID()}`;
  const fetch = await runCommand(
    ["git", "fetch", "--no-tags", remoteName, `refs/heads/git-annex:${checkRef}`],
    { cwd: path },
  );
  if (fetch.exitCode !== 0) return { success: false };

  const remote = await runCommand(["git", "rev-parse", `${checkRef}^{commit}`], { cwd: path });
  const cleanup = await runCommand(["git", "update-ref", "-d", checkRef], { cwd: path });
  if (remote.exitCode !== 0 || remote.stdout.trim() === "" || cleanup.exitCode !== 0) {
    return { success: false };
  }
  return { success: true, oid: remote.stdout.trim() };
}

async function prepareAnnexBranchPush(
  path: string,
  remoteName: string,
): Promise<{ success: true; localOid: string } | { success: false; error: string }> {
  const remoteRef = await runCommand(
    ["git", "ls-remote", "--heads", remoteName, "refs/heads/git-annex"],
    { cwd: path },
  );
  if (remoteRef.exitCode !== 0) {
    return { success: false, error: "the remote git-annex branch could not be checked" };
  }

  let remoteOid: string | undefined;
  if (remoteRef.stdout.trim() === "") {
    const forget = await runCommand(["git", "annex", "forget", "--force"], { cwd: path });
    if (forget.exitCode !== 0) {
      return { success: false, error: "the local git-annex history could not be pruned" };
    }
  } else {
    const remote = await fetchRemoteAnnexOid(path, remoteName);
    if (!remote.success) {
      return { success: false, error: "the existing git-annex branch could not be fetched" };
    }
    remoteOid = remote.oid;
  }

  const local = await runCommand(["git", "rev-parse", "refs/heads/git-annex^{commit}"], {
    cwd: path,
  });
  if (local.exitCode !== 0 || local.stdout.trim() === "") {
    return { success: false, error: "the local git-annex branch could not be identified" };
  }
  const localOid = local.stdout.trim();

  const localHistory = await defaultDescriptionHistory(
    path,
    remoteOid ? `${remoteOid}..${localOid}` : localOid,
  );
  if (!localHistory.success) {
    return { success: false, error: "the local git-annex description history could not be read" };
  }
  if (remoteOid) {
    const remoteHistory = await defaultDescriptionHistory(path, remoteOid);
    if (!remoteHistory.success) {
      return {
        success: false,
        error: "the remote git-annex description history could not be read",
      };
    }
    const hasUnpublished = [...localHistory.descriptions].some(
      (description) => !remoteHistory.descriptions.has(description),
    );
    if (hasUnpublished) {
      return {
        success: false,
        error: "the local history contains an unpublished machine-specific description",
      };
    }
  } else if (localHistory.descriptions.size > 0) {
    return {
      success: false,
      error: "first-push history still contains a machine-specific description after pruning",
    };
  }

  return { success: true, localOid };
}

/** Signals on which an interrupted save still takes its assume-unchanged bits back. */
const INTERRUPT_SIGNALS: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];

/**
 * Save all changes to the dataset
 *
 * If author info is provided, sets GIT_AUTHOR_NAME and GIT_AUTHOR_EMAIL
 * to ensure commits are attributed to the correct NEMAR user.
 *
 * `skipContentCheck` names annexed, already-staged paths whose working-tree
 * content `git add -A` must NOT re-read. `git annex add` stages unlocked files
 * through `git update-index --index-info`, which leaves their index entries
 * with zero stat data; the next `git add -A` (and `git status`) then treats
 * every one of them as possibly modified and streams its full content through
 * `git-annex filter-process` to find out it is not. On nm000358 (165 files,
 * 1.6 TB on Ceph) the "Saving dataset changes" step after the S3 copy took hours;
 * this re-read is the likely cause (it reproduces at small scale), but the save was
 * not timed at that size. These paths are marked `assume-unchanged`
 * for the duration of the add/status/commit and unmarked afterwards, so the
 * commit records exactly the pointers that were staged, the ones whose content
 * is recorded at the S3 remote.
 *
 * The skip DEFERS the re-read, it does not remove it: the entries stay zero-stat,
 * so the first `git status` afterwards re-reads the annexed content once (measured
 * on local disk: about 0.35 to 0.45 s against 0.01 s at 600 files of 120 KB, and
 * 4 to 7 s against 0.04 s at 10,000 annexed files plus 5,000 JSON files).
 *
 * Marking a path hides it from git, so the skip is only taken where it cannot
 * hide an edit, and cannot outlive the save:
 *
 *  - A path is skipped only if its size and mtime still match what the upload plan
 *    recorded. The record predates a possibly multi-hour `git annex add`, and it
 *    is still the right thing to compare with because `git annex add` leaves the
 *    size, mtime and inode of an unlocked file unchanged (verified against
 *    git-annex 10.20260901 on APFS; other filesystems unverified). A path that
 *    changed FAILS the save, naming the first few: the commit would otherwise
 *    carry the pointer that was uploaded while the tree held different bytes, and
 *    the user would see "Upload complete". The comparison runs again after the
 *    commit, for a file that changed (or disappeared, or became unreadable) while
 *    the save itself ran.
 *  - A path that no longer exists before the save is left unmarked, so its
 *    deletion is staged.
 *  - Every entry to this function first clears any assume-unchanged bit left on an
 *    annexed path by an earlier save that never got to unmark (a kill, a power
 *    loss): the bit lives in the index and outlasts the process, and from then on
 *    `git add -A` silently omits that file's edits and deletion. If the bits cannot
 *    be checked or cleared the save FAILS, because the alternative is a "saved"
 *    result that is not.
 *  - A failure to mark degrades to the plain add, with a warning: the skip is an
 *    optimization, never a reason to refuse a save.
 *  - The bits are cleared in a `finally`, retried once, and a failure to clear
 *    them after the commit FAILS the save with the way out. On SIGINT, SIGTERM and
 *    SIGHUP the clear is attempted before the process dies, and it is best effort:
 *    a SIGKILL or a power loss cannot run it, and an `index.lock` that outlasts the
 *    retry window defeats it (the recovery is then printed). What is left behind is
 *    cleared by the next save's entry clear.
 *
 * The stale-bit check and the clear run at the repository's top level, and
 * `git add -A` stages the whole tree, so a save started from a subdirectory sees and
 * clears flags everywhere, not only under its own path.
 */
export async function saveDataset(
  path: string,
  message: string,
  author?: { name: string; email: string },
  options: { skipContentCheck?: SkipContentCheckEntry[] } = {},
): Promise<{ success: boolean; error?: string }> {
  const top = await repositoryRoot(path);
  if ("error" in top) return { success: false, error: top.error };

  const stale = await clearStaleAssumeUnchanged(top.root);
  if (stale.error) return { success: false, error: describeStaleFlagFailure(stale) };
  if (stale.cleared > 0) {
    console.warn(
      `Warning: cleared ${stale.cleared} assume-unchanged flag(s) on annexed files, so this save includes their changes.`,
    );
  }

  // A flag cleared just now was hiding its file from git for some time, so the upload
  // plan's record of that file (taken, perhaps, AFTER an edit the flag hid) cannot be
  // trusted to say the file is unchanged. A save that found stale flags reads every file.
  const candidates = stale.cleared > 0 ? [] : (options.skipContentCheck ?? []);
  let marked: SkipContentCheckEntry[] = [];
  if (candidates.length > 0) {
    const check = compareRecordedStat(path, candidates);
    if (check.changed.length > 0) {
      return { success: false, error: describeChangedSinceTracked(check.changed, "before") };
    }
    if (check.unchanged.length > 0) {
      const mark = await setAssumeUnchanged(
        path,
        check.unchanged.map((e) => e.path),
        true,
      );
      if (mark.success) {
        marked = check.unchanged;
      } else {
        console.warn(
          `Warning: could not skip re-reading ${check.unchanged.length} annexed file(s) (${mark.error}); saving without the skip.`,
        );
        // git writes the index only after every path is marked, so a failure marks
        // nothing; this keeps that from being an assumption.
        const cleanup = await clearStaleAssumeUnchanged(top.root);
        if (cleanup.error) return { success: false, error: describeStaleFlagFailure(cleanup) };
      }
    }
  }

  const disarm = marked.length > 0 ? armUnmarkOnInterrupt(path, marked) : () => {};
  let outcome: { success: boolean; error?: string };
  let unmarkError: string | undefined;
  try {
    outcome = await stageAndCommit(path, message, author);
    if (outcome.success && marked.length > 0) {
      const after = compareRecordedStat(path, marked);
      const moved = [...after.changed, ...after.vanished, ...after.unreadable];
      if (moved.length > 0) {
        outcome = { success: false, error: describeChangedSinceTracked(moved, "during") };
      }
    }
  } finally {
    // Disarmed only AFTER the final unmark: a signal that lands while it runs must still
    // find a handler, or the bits outlive the process.
    if (marked.length > 0) {
      unmarkError = await unmarkWithRetry(
        path,
        marked.map((e) => e.path),
      );
    }
    disarm();
  }

  if (unmarkError) {
    const stuck = describeUnmarkFailure(marked.length, unmarkError, outcome.success);
    return { success: false, error: outcome.error ? `${outcome.error}\n${stuck}` : stuck };
  }
  return outcome;
}

/**
 * Clear every stale assume-unchanged flag in the repository `path` belongs to, failing
 * closed. A caller about to ask git to look at a file (`git annex add`, `git add`) must
 * do this first: a flag left by a killed save makes git skip the file, exit 0 and
 * report nothing, so an edit made since is neither tracked, uploaded nor committed.
 * `saveDataset` does it on entry too; this is for the steps before it.
 */
export async function clearStaleFlags(
  path: string,
): Promise<{ success: boolean; cleared: number; error?: string }> {
  const top = await repositoryRoot(path);
  if ("error" in top) {
    return {
      success: false,
      cleared: 0,
      error: `Could not find the git repository to check for assume-unchanged flags (${top.error}). A flag left behind would make git skip a file, so the upload stopped before tracking anything. Run the upload again from the dataset directory.`,
    };
  }
  const stale = await clearStaleAssumeUnchanged(top.root);
  if (stale.error) {
    return { success: false, cleared: 0, error: describeStaleFlagFailure(stale, "upload") };
  }
  return { success: true, cleared: stale.cleared };
}

/** The repository's top-level directory, or git's complaint when `path` is in none. */
async function repositoryRoot(path: string): Promise<{ root: string } | { error: string }> {
  try {
    const top = await runCommand(["git", "rev-parse", "--show-toplevel"], { cwd: path });
    if (top.exitCode !== 0) {
      return { error: top.stderr.trim() || "Not inside a git repository" };
    }
    return { root: top.stdout.trim() || path };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/** Clear the bits, and try once more if git refuses. Returns git's complaint, or nothing. */
async function unmarkWithRetry(path: string, paths: string[]): Promise<string | undefined> {
  let last = await setAssumeUnchanged(path, paths, false);
  if (!last.success) last = await setAssumeUnchanged(path, paths, false);
  return last.success ? undefined : last.error;
}

/** How long one synchronous unmark may run; a hung git must not make Ctrl-C unresponsive. */
const SIGNAL_UNMARK_TIMEOUT_MS = 5_000;

/** How long a signal handler keeps retrying an unmark that fails, usually on `index.lock`. */
const SIGNAL_UNMARK_RETRY_MS = 2_500;

/** Pause between those retries. */
const SIGNAL_UNMARK_PAUSE_MS = 100;

/** The most paths a recovery message spells out as a command. */
const MAX_RECOVERY_PATHS = 10;

/** How long the handler keeps trying to get its message out, and the pause between tries. */
const STDERR_WRITE_MS = 500;
const STDERR_WRITE_PAUSE_MS = 20;

/** Sleep without leaving the signal handler: it cannot await. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** One synchronous `git update-index --no-assume-unchanged`; its complaint when it fails. */
function unmarkSync(path: string, input: string, timeoutMs: number): string | undefined {
  const r = spawnSync("git", ["update-index", "--no-assume-unchanged", "-z", "--stdin"], {
    cwd: path,
    input,
    stdio: ["pipe", "ignore", "pipe"],
    timeout: timeoutMs,
  });
  if (r.error) return r.error.message;
  if (r.status === 0) return undefined;
  const said = r.stderr?.toString().trim();
  return said || `git update-index exited ${r.status ?? r.signal}`;
}

/** Ask the children of this process to stop, so an in-flight `git add` lets go of `index.lock`. */
function stopChildren(): void {
  // git removes its lock files when it receives SIGTERM. Where pkill is missing this does
  // nothing, and the retry window below is all there is.
  spawnSync("pkill", ["-TERM", "-P", String(process.pid)], { stdio: "ignore", timeout: 1_000 });
}

/**
 * What a person needs when the signal handler could not clear the bits: always the two
 * nemar commands that clear them, and, for at most {@link MAX_RECOVERY_PATHS} paths none
 * of which (nor the repository path) has a character a command cannot carry, the
 * `git update-index` command itself.
 */
function describeStuckFlags(
  path: string,
  entries: SkipContentCheckEntry[],
  reason: string,
): string {
  const quoted = (p: string) => `'${p.replace(/'/g, `'\\''`)}'`;
  const printable =
    entries.length <= MAX_RECOVERY_PATHS &&
    isPrintableInCommand(path) &&
    entries.every((e) => isPrintableInCommand(e.path));
  const manual = printable
    ? ` To clear them by hand: git -C ${quoted(path)} update-index --no-assume-unchanged -- ${entries.map((e) => quoted(e.path)).join(" ")}`
    : "";
  return `\nInterrupted while ${entries.length} annexed file(s) were marked assume-unchanged, and git would not clear them (${displayName(reason)}). Until they are cleared, git hides later edits to those files. Run \`nemar dataset commit\` in ${displayName(path)}, or run the upload again: both clear them first.${manual}\n`;
}

/**
 * Write to stderr from a signal handler, which cannot await. A pipe can take part of a
 * write or answer EAGAIN, so this loops on the byte count for a short while; a stderr
 * that is closed (EPIPE) or stays unwritable ends it, and then the text is lost.
 */
function writeStderrSync(text: string): void {
  const bytes = Buffer.from(text);
  const deadline = Date.now() + STDERR_WRITE_MS;
  let offset = 0;
  while (offset < bytes.length && Date.now() < deadline) {
    try {
      offset += writeSync(2, bytes, offset);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EAGAIN") return;
      sleepSync(STDERR_WRITE_PAUSE_MS);
    }
  }
}

/**
 * Take the bits back if the process is interrupted while they are set, as far as a
 * signal handler can. It cannot await, so this is a synchronous `git update-index`. If
 * that fails (an `index.lock` held by the `git add` the signal interrupted is the usual
 * reason: a signal sent to the CLI alone, unlike a terminal's Ctrl-C, does not reach its
 * children), the in-flight git children are asked to stop, which releases the lock, and
 * the unmark is retried for {@link SIGNAL_UNMARK_RETRY_MS}. If it still fails the
 * recovery is written to stderr (see {@link describeStuckFlags}). Each attempt has a
 * timeout.
 *
 * The handler then removes itself and re-raises the signal. The process dies the way the
 * signal says only if no other handler for it is registered; any other handler runs, and
 * decides. Best effort by construction: SIGKILL cannot be caught. Returns the function
 * that disarms it.
 */
function armUnmarkOnInterrupt(path: string, entries: SkipContentCheckEntry[]): () => void {
  const input = entries.map((e) => `${e.path}\0`).join("");
  function disarm(): void {
    for (const signal of INTERRUPT_SIGNALS) process.removeListener(signal, onSignal);
  }
  function onSignal(signal: NodeJS.Signals): void {
    const deadline = Date.now() + SIGNAL_UNMARK_RETRY_MS;
    let failure = unmarkSync(path, input, SIGNAL_UNMARK_TIMEOUT_MS);
    if (failure) {
      stopChildren();
      while (failure && Date.now() < deadline) {
        sleepSync(SIGNAL_UNMARK_PAUSE_MS);
        failure = unmarkSync(path, input, SIGNAL_UNMARK_TIMEOUT_MS);
      }
    }
    if (failure) writeStderrSync(describeStuckFlags(path, entries, failure));
    disarm();
    process.kill(process.pid, signal);
  }
  for (const signal of INTERRUPT_SIGNALS) process.on(signal, onSignal);
  return disarm;
}

/**
 * Split `entries` by comparing each file's current size and mtime with the ones the
 * upload plan recorded. A path that is gone (`vanished`) or whose stat cannot be
 * read (`unreadable`) is in neither of the other lists: before a save it is simply
 * not skipped, and git (which stages the deletion, or fails loudly on the
 * unreadable file) deals with it; after a save, for a path that WAS skipped, either
 * means the tree no longer matches the commit. Exported for tests.
 */
export function compareRecordedStat(
  path: string,
  entries: SkipContentCheckEntry[],
): {
  unchanged: SkipContentCheckEntry[];
  changed: string[];
  vanished: string[];
  unreadable: string[];
} {
  const unchanged: SkipContentCheckEntry[] = [];
  const changed: string[] = [];
  const vanished: string[] = [];
  const unreadable: string[] = [];
  for (const entry of entries) {
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(join(path, entry.path));
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") vanished.push(entry.path);
      else unreadable.push(entry.path);
      continue;
    }
    if (st.size !== entry.size || st.mtimeMs !== entry.mtimeMs) changed.push(entry.path);
    else unchanged.push(entry);
  }
  return { unchanged, changed, vanished, unreadable };
}

/**
 * The failure text for annexed files that changed under a save that skips
 * re-reading them. `when` says whether it was found before the save began or after
 * the commit. Exported for tests.
 */
export function describeChangedSinceTracked(changed: string[], when: "before" | "during"): string {
  const shown = displayNames(changed.slice(0, 3));
  const more = changed.length > 3 ? ` (and ${changed.length - 3} more)` : "";
  if (when === "during") {
    return `${changed.length} annexed file(s) changed, disappeared or became unreadable while the save was running, so the commit does not match the tree: ${shown}${more}. Re-run the upload command to re-track them.`;
  }
  return `${changed.length} annexed file(s) changed since the upload plan recorded them, so the commit would not match the tree: ${shown}${more}. Re-run the upload command to re-track them.`;
}

/** What `clearStaleAssumeUnchanged` reports. */
export interface StaleFlagResult {
  /** How many flags it cleared. */
  cleared: number;
  /** How many annexed paths carried a flag; those it could not clear are the difference. */
  found: number;
  /** Git's complaint, when the check or the clear failed. */
  error?: string;
  /** Which stage failed: reading the flags, deciding which are annexed, or clearing them. */
  stage?: "list" | "classify" | "clear";
}

/**
 * The failure text for a stale-flag check or clear that did not complete, worded for
 * what the person ran: a save (the default) that saved nothing, or an upload that stopped
 * before it tracked anything.
 */
export function describeStaleFlagFailure(
  result: StaleFlagResult,
  context: "save" | "upload" = "save",
): string {
  if (context === "upload") {
    if (result.stage === "clear") {
      return `Could not clear ${result.found} assume-unchanged flag(s) on annexed files (${result.error}). git skips those files until they are cleared, so the upload stopped before tracking anything. Run the upload again.`;
    }
    return `Could not check this repository for assume-unchanged flags (${result.error}). A flag left behind would make git skip a file, so the upload stopped before tracking anything. Run the upload again; if git keeps failing, the repository needs attention.`;
  }
  if (result.stage === "clear") {
    return `Found ${result.found} assume-unchanged flag(s) on annexed files but could not clear them (${result.error}). They would hide edits from this save, so nothing was saved. Run the save again: every save clears them first.`;
  }
  return `Could not check this repository for assume-unchanged flags (${result.error}). A flag left behind would hide edits from this save, so nothing was saved. Run the save again; if git keeps failing, the repository needs attention.`;
}

/** The failure text for flags a finished save could not take back. */
function describeUnmarkFailure(count: number, error: string, committed: boolean): string {
  return `${committed ? "The save was committed, but " : ""}${count} assume-unchanged flag(s) it set could not be cleared (${error}). Until they are, git hides later edits to those files. Run \`nemar dataset commit\` in this directory, or the upload again: both clear stale flags before they save.`;
}

/**
 * Clear git's assume-unchanged bit from every ANNEXED path that carries it.
 *
 * `git ls-files -v` tags such a path with a lowercase letter. A flag on a path
 * that is not annexed is not ours (nothing in NEMAR sets one) and is left alone.
 * Annexed is decided from the index, never the working tree, so it still answers
 * for a path whose file has been deleted: a symlink entry is a locked annexed
 * file, and any other entry is an unlocked one when it holds git-annex's pointer
 * line, `/annex/objects/KEY` (`git grep --cached`, which matches any line, not only
 * the first). Run it at the repository's top level: `ls-files` lists only the
 * subtree under the directory it runs in.
 */
export async function clearStaleAssumeUnchanged(path: string): Promise<StaleFlagResult> {
  const fail = (stage: "list" | "classify" | "clear", error: string, found = 0) => ({
    cleared: 0,
    found,
    error,
    stage,
  });
  try {
    const listed = await runCommand(["git", "ls-files", "-v", "-z"], { cwd: path });
    if (listed.exitCode !== 0) {
      return fail("list", listed.stderr.trim() || "git ls-files failed");
    }
    const flagged = listed.stdout
      .split("\0")
      .filter((entry) => ASSUME_UNCHANGED_TAG.test(entry))
      .map((entry) => entry.slice(2));
    if (flagged.length === 0) return { cleared: 0, found: 0 };

    const annexed: string[] = [];
    for (const chunk of chunkAddTargets(flagged)) {
      const staged = await runCommand(
        ["git", "--literal-pathspecs", "ls-files", "-s", "-z", "--", ...chunk],
        { cwd: path },
      );
      if (staged.exitCode !== 0) {
        return fail("classify", staged.stderr.trim() || "git ls-files -s failed");
      }
      const regular: string[] = [];
      for (const entry of staged.stdout.split("\0").filter(Boolean)) {
        const match = entry.match(/^(\d{6}) \S+ \d\t(.*)$/s);
        if (!match) continue;
        if (match[1] === "120000") annexed.push(match[2]);
        else regular.push(match[2]);
      }
      if (regular.length === 0) continue;

      const grep = await runCommand(
        [
          "git",
          "--literal-pathspecs",
          "grep",
          "--cached",
          "-l",
          "-z",
          "-e",
          "^/annex/objects/",
          "--",
          ...regular,
        ],
        { cwd: path },
      );
      // Exit 1 is "no match", which is an answer; anything else is not.
      if (grep.exitCode > 1) {
        return fail("classify", grep.stderr.trim() || `git grep exited ${grep.exitCode}`);
      }
      annexed.push(...grep.stdout.split("\0").filter(Boolean));
    }
    if (annexed.length === 0) return { cleared: 0, found: 0 };

    const cleared = await setAssumeUnchanged(path, annexed, false);
    if (!cleared.success)
      return fail("clear", cleared.error ?? "git update-index failed", annexed.length);
    return { cleared: annexed.length, found: annexed.length };
  } catch (e) {
    return fail("classify", e instanceof Error ? e.message : String(e));
  }
}

/**
 * Set or clear git's assume-unchanged bit for `paths` (NUL-separated on stdin,
 * so any filename and any count is safe). Exported for unit tests.
 */
export async function setAssumeUnchanged(
  path: string,
  paths: string[],
  on: boolean,
): Promise<{ success: boolean; error?: string }> {
  try {
    const { stderr, exitCode } = await runCommand(
      ["git", "update-index", on ? "--assume-unchanged" : "--no-assume-unchanged", "-z", "--stdin"],
      { cwd: path, stdin: paths.map((p) => `${p}\0`).join("") },
    );
    if (exitCode !== 0) {
      return { success: false, error: stderr.trim() || `git update-index exited ${exitCode}` };
    }
    return { success: true };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : String(e) };
  }
}

async function stageAndCommit(
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
    const annexPreflight = await prepareAnnexBranchPush(path, remoteName);
    if (!annexPreflight.success) {
      return {
        success: false,
        error: `Push stopped before the main branch was updated because ${annexPreflight.error}.`,
      };
    }
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
    let prepared = annexPreflight;
    for (let attempt = 0; attempt <= PUSH_REBASE_RETRIES; attempt++) {
      if (attempt > 0) {
        const checked = await prepareAnnexBranchPush(path, remoteName);
        if (!checked.success) {
          return {
            success: false,
            error: `Main branch pushed, but the git-annex branch was not pushed because ${checked.error}.`,
          };
        }
        prepared = checked;
      }
      // Pin both the local commit inspected by the privacy check and the remote
      // tip used to classify already-published descriptions. A concurrent local
      // update cannot make an unchecked commit the push source; after a merge
      // retry this loop fetches and checks again.
      const res = await runCommand(
        ["git", "push", remoteName, `${prepared.localOid}:refs/heads/git-annex`],
        { cwd: path },
      );
      if (res.exitCode === 0) {
        const currentRef = await runCommand(["git", "rev-parse", "refs/heads/git-annex^{commit}"], {
          cwd: path,
        });
        if (currentRef.exitCode !== 0 || currentRef.stdout.trim() !== prepared.localOid) {
          return {
            success: false,
            error:
              "The checked git-annex history was pushed, but the local annex branch advanced during the push. Review and retry to publish the remaining changes.",
          };
        }
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
  options: {
    useGitHubToken?: boolean;
    /**
     * Committer to configure in the clone before `git annex init` runs.
     *
     * `git annex init` COMMITS to the git-annex branch, so on a host with no
     * `user.email` it fails with "Author identity unknown" -- and the caller then
     * reports a clone failure for something that has nothing to do with cloning.
     * A CI runner is exactly such a host. Omit it where a human's own identity
     * should be used.
     */
    identity?: { name: string; email: string };
  } = {},
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

    // Before `git annex init`, which commits.
    if (options.identity) {
      await runCommand(["git", "config", "user.name", options.identity.name], { cwd: outputPath });
      await runCommand(["git", "config", "user.email", options.identity.email], {
        cwd: outputPath,
      });
    }

    // Initialize git-annex in the cloned repo
    // A fixed description, never git-annex's default user@host:/path: the
    // clone's uuid.log entry is pushed by any later sync (#1399).
    const { stderr: initStderr, exitCode: initExitCode } = await runCommand(
      ["git", "annex", "init", ANNEX_CLONE_DESCRIPTION],
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
