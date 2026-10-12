/**
 * git-annex service: record index stat data for large annexed files without streaming
 * their content through `git-annex filter-process`. See ADR 0098 and
 * {@link primeIndexStat}.
 */

import { spawnSync } from "node:child_process";
import { displayName, isPrintableInCommand } from "../display-name.js";
import { INTERRUPT_SIGNALS, writeStderrSync } from "./clone-push.js";
import { chunkAddTargets } from "./init.js";
import { runCommand } from "./run-command.js";

/** The long-running filter git pipes every file's whole content into. */
export const FILTER_PROCESS_KEY = "filter.annex.process";

/**
 * git-annex's own record of a filter process it took out of the configuration for a
 * restage. git-annex writes it before it unsets {@link FILTER_PROCESS_KEY}, and its next
 * restage puts the value back from it, so using the same key means either program
 * recovers what the other left behind.
 */
export const FILTER_PROCESS_MARKER = "filter.annex.process-temp-disabled";

/**
 * Recorded size at or above which a tracked file's index stat data is recorded through
 * git-annex's per-file clean filter instead of being left for a later git command to
 * re-read through filter-process.
 *
 * The per-file filter costs one git-annex process per file, and that cost does not
 * depend on the file's size: 0.06 to 0.18 s a file on local APFS (6 to 2,000 annexed
 * files in the index), and the issue that motivated this (#1704) reports 3.7 s for one
 * 25 GB file on CephFS. The read it replaces costs the file's size over filter-process
 * throughput: about 1.7 GB/s on local APFS, 75 to 95 MB/s a stream on that CephFS. A
 * 1 GiB file therefore takes about 0.6 s to re-read locally and 11 to 14 s on CephFS,
 * which leaves the per-file filter at least twice as cheap on both. Below a few
 * hundred megabytes it is not: on CephFS a 256 MiB file re-reads in about 3 s. Re-measure
 * on the target host before moving it.
 */
export const PRIME_MIN_FILE_BYTES = 1024 ** 3;

/** How long one synchronous restore may run inside a signal handler. */
const SIGNAL_RESTORE_TIMEOUT_MS = 5_000;

/** Paths per `git add --refresh`; small enough that a progress callback means something. */
const REFRESH_CHUNK_PATHS = 100;

/** `git config --unset-all` exits 5 when the key is already absent, which is the goal. */
const CONFIG_KEY_ABSENT = 5;

/** What {@link primeIndexStat} did. */
export interface PrimeResult {
  /** Indexed paths handed to git's refresh. */
  primed: number;
  /**
   * Why nothing (or only part) was primed, when that was a choice or a degradation the
   * caller should mention: git will read those files the old way. Never a failure.
   */
  skipped?: string;
  /** A filter process an earlier, interrupted run left out of the configuration and that was put back first. */
  recovered?: boolean;
  /**
   * The repository's configuration could not be checked or put back. The caller must
   * fail its step: this says what is wrong and what to do.
   */
  error?: string;
}

/** Values of `key` in one scope (`--local`) or in every scope, NUL-separated so any value is safe. */
async function readConfigValues(
  path: string,
  key: string,
  scope: "local" | "all",
): Promise<{ values: string[] } | { error: string }> {
  const args =
    scope === "local"
      ? ["git", "config", "--local", "--null", "--get-all", key]
      : ["git", "config", "--null", "--get-all", key];
  try {
    const out = await runCommand(args, { cwd: path });
    // Exit 1 is "no such key", which is an answer.
    if (out.exitCode === 1 && out.stderr.trim() === "") return { values: [] };
    if (out.exitCode !== 0) {
      return { error: out.stderr.trim() || `git config exited ${out.exitCode}` };
    }
    return { values: out.stdout.split("\0").filter((v) => v.length > 0) };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

async function gitConfig(path: string, args: string[]): Promise<string | undefined> {
  try {
    const out = await runCommand(["git", "config", "--local", ...args], { cwd: path });
    if (out.exitCode === 0) return undefined;
    if (args[0] === "--unset-all" && out.exitCode === CONFIG_KEY_ABSENT) return undefined;
    return out.stderr.trim() || `git config exited ${out.exitCode}`;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/**
 * Put `value` back as the repository's filter process and drop the marker, then read
 * both back. Returns git's complaint, or nothing when the configuration is as it was.
 */
async function restoreFilterProcess(path: string, value: string): Promise<string | undefined> {
  const set = await gitConfig(path, [FILTER_PROCESS_KEY, value]);
  if (set) return set;
  const unset = await gitConfig(path, ["--unset-all", FILTER_PROCESS_MARKER]);
  if (unset) return unset;
  const now = await readConfigValues(path, FILTER_PROCESS_KEY, "local");
  if ("error" in now) return now.error;
  if (now.values.length !== 1 || now.values[0] !== value) {
    return `${FILTER_PROCESS_KEY} reads back as ${JSON.stringify(now.values)}, not ${JSON.stringify(value)}`;
  }
  const marker = await readConfigValues(path, FILTER_PROCESS_MARKER, "local");
  if ("error" in marker) return marker.error;
  if (marker.values.length > 0) return `${FILTER_PROCESS_MARKER} is still set`;
  return undefined;
}

/** The two commands that put the filter process back, for a person to run. */
function manualRestore(path: string, value: string): string {
  const quoted = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  if (!isPrintableInCommand(path) || !isPrintableInCommand(value)) {
    return "Run the upload again, which puts it back first.";
  }
  return `Run the upload again, which puts it back first, or by hand: git -C ${quoted(path)} config ${FILTER_PROCESS_KEY} ${quoted(value)} && git -C ${quoted(path)} config --unset-all ${FILTER_PROCESS_MARKER}`;
}

/** The failure text for a filter process that could not be put back. */
function describeRestoreFailure(path: string, value: string, error: string): string {
  return `Could not put git-annex's filter process back into ${displayName(path)}'s configuration (${displayName(error)}). Files are still stored correctly without it, but git runs one git-annex process per file until it is back. ${manualRestore(path, value)}`;
}

/**
 * Put back a filter process an interrupted run took out of the configuration.
 *
 * {@link primeIndexStat} records the value under {@link FILTER_PROCESS_MARKER} before it
 * unsets {@link FILTER_PROCESS_KEY}, and so does git-annex's own restage. A SIGKILL or a
 * power loss in between leaves the marker set. When the key is then missing it is set
 * back from the marker; when the key is present (`git annex init` sets it again, for
 * one) it is left alone. The marker is removed either way.
 *
 * A repository without the marker costs one `git config` read. A failure to read or
 * restore is returned as `error`, and the caller fails its step: what was left behind is
 * not a correctness problem (git falls back to git-annex's per-file filters, which store
 * files the same way), but it is a change to the person's configuration that nothing
 * else would undo.
 */
export async function restoreSuspendedFilterProcess(
  path: string,
): Promise<{ restored: boolean; error?: string }> {
  const marker = await readConfigValues(path, FILTER_PROCESS_MARKER, "local");
  if ("error" in marker) {
    return {
      restored: false,
      error: `Could not check whether an earlier upload left git-annex's filter process out of the configuration (${displayName(marker.error)}). Run the upload again; if git keeps failing, the repository needs attention.`,
    };
  }
  if (marker.values.length === 0) return { restored: false };
  const saved = marker.values[marker.values.length - 1];
  const current = await readConfigValues(path, FILTER_PROCESS_KEY, "local");
  if ("error" in current) {
    return { restored: false, error: describeRestoreFailure(path, saved, current.error) };
  }
  if (current.values.length > 0) {
    const unset = await gitConfig(path, ["--unset-all", FILTER_PROCESS_MARKER]);
    if (unset) return { restored: false, error: describeRestoreFailure(path, saved, unset) };
    return { restored: false };
  }
  let failure = await restoreFilterProcess(path, saved);
  if (failure) failure = await restoreFilterProcess(path, saved);
  if (failure) return { restored: false, error: describeRestoreFailure(path, saved, failure) };
  return { restored: true };
}

/** One synchronous restore, for a signal handler that cannot await; git's complaint on failure. */
function restoreSync(path: string, value: string): string | undefined {
  const run = (args: string[]) =>
    spawnSync("git", ["config", "--local", ...args], {
      cwd: path,
      stdio: ["ignore", "ignore", "pipe"],
      timeout: SIGNAL_RESTORE_TIMEOUT_MS,
    });
  const set = run([FILTER_PROCESS_KEY, value]);
  if (set.error) return set.error.message;
  if (set.status !== 0) return set.stderr?.toString().trim() || `git config exited ${set.status}`;
  const unset = run(["--unset-all", FILTER_PROCESS_MARKER]);
  if (unset.error) return unset.error.message;
  if (unset.status !== 0 && unset.status !== CONFIG_KEY_ABSENT) {
    return unset.stderr?.toString().trim() || `git config exited ${unset.status}`;
  }
  return undefined;
}

/**
 * Put the filter process back if the process is interrupted while it is out of the
 * configuration. `git config` takes `.git/config.lock`, not the `index.lock` an
 * in-flight `git add --refresh` holds, so the restore does not wait on the refresh. The
 * handler then removes itself and re-raises the signal; as with the save's handler, the
 * process dies the way the signal says only when no other handler for it is registered.
 * SIGKILL cannot be caught: the marker it leaves is restored by the next upload's
 * {@link restoreSuspendedFilterProcess}, or by git-annex's next restage. Returns the
 * function that disarms it.
 */
function armRestoreOnInterrupt(path: string, value: string): () => void {
  function disarm(): void {
    for (const signal of INTERRUPT_SIGNALS) process.removeListener(signal, onSignal);
  }
  function onSignal(signal: NodeJS.Signals): void {
    const failure = restoreSync(path, value);
    if (failure) {
      writeStderrSync(`\n${describeRestoreFailure(path, value, failure)}\n`);
    }
    disarm();
    process.kill(process.pid, signal);
  }
  for (const signal of INTERRUPT_SIGNALS) process.on(signal, onSignal);
  return disarm;
}

/** The subset of `paths` that is in the index; `git add --refresh` refuses a whole list over one that is not. */
async function indexedPaths(
  path: string,
  paths: string[],
): Promise<{ paths: string[] } | { error: string }> {
  const indexed: string[] = [];
  for (const chunk of chunkAddTargets(paths)) {
    const out = await runCommand(["git", "--literal-pathspecs", "ls-files", "-z", "--", ...chunk], {
      cwd: path,
    });
    if (out.exitCode !== 0) return { error: out.stderr.trim() || "git ls-files failed" };
    indexed.push(...out.stdout.split("\0").filter(Boolean));
  }
  return { paths: indexed };
}

/** True when `filter.annex.clean` is git-annex's per-file clean filter. */
function isAnnexCleanFilter(value: string): boolean {
  return /\bgit-annex\b.*\bsmudge\b.*--clean\b/.test(value);
}

/**
 * Record index stat data for `paths` so git stops treating them as possibly modified,
 * without streaming their content through `git-annex filter-process`.
 *
 * `git annex add` stages an unlocked file through `git update-index --index-info`,
 * which leaves its index entry with zero stat data. Every later git command that
 * compares the worktree with the index (`git status`, `git diff`, `git add -A`, the
 * tracking step's own check of already-indexed paths) then runs the file through the
 * clean filter. With `filter.annex.process` configured that is the long-running filter,
 * and git sends it the whole content over a pipe before git-annex can answer from its
 * inode cache that nothing changed: the tracking check reads a file twice, `git status`
 * once. git-annex's per-file clean filter (`filter.annex.clean`) is given the path and
 * answers from the same inode cache without reading the content; git consumes only a
 * pipe buffer's worth. git uses it only when no filter process is configured, so for the
 * duration of one `git add --refresh` the filter process is taken out of the
 * repository's configuration, exactly as git-annex's own restage does, under the same
 * marker key.
 *
 * What this cannot do is change what is committed. `git add --refresh` only records
 * stat data for an entry whose content cleans to the blob already staged; it never
 * stages anything. A file that changed since it was tracked cleans to a different
 * pointer and keeps zero stat data, so git still reads it and still sees the change.
 * Both filter forms answer from the same inode cache (inode, size, mtime), so they agree
 * on which files are unchanged, including the one case the cache cannot see: an edit in
 * place that puts the size and the exact mtime back is missed by `git status` through
 * filter-process as well. The only difference is the bytes git sends first.
 *
 * Guards, each a way the configuration change could outlive the call or do harm:
 *  - A marker left by an interrupted run (this one's or git-annex's) is restored first.
 *  - Nothing is primed unless `filter.annex.clean` is git-annex's and the filter process,
 *    if any, is set once and only in the repository's own configuration. One set
 *    anywhere else cannot be taken out for one command, so those files are left to be
 *    read as before (`skipped`). With no filter process at all, git already uses the
 *    per-file filter and nothing is changed.
 *  - The value is recorded under {@link FILTER_PROCESS_MARKER} before the key is unset,
 *    and restored in a `finally`, retried once and read back. On SIGINT, SIGTERM and
 *    SIGHUP it is restored before the process dies.
 *  - Only paths that are in the index are handed to git, literally.
 *  - A refresh that fails is a degradation (`skipped`): it can only have recorded stat
 *    data. A configuration that cannot be read or put back is an `error`.
 *
 * `onSuspended` runs while the filter process is out of the configuration; it exists so
 * a test can interrupt the process there. `onProgress` reports paths handed to git so far.
 */
export async function primeIndexStat(
  path: string,
  paths: string[],
  options: {
    onSuspended?: () => void;
    onProgress?: (done: number, total: number) => void;
  } = {},
): Promise<PrimeResult> {
  const recovery = await restoreSuspendedFilterProcess(path);
  if (recovery.error) return { primed: 0, error: recovery.error };
  const recovered = recovery.restored ? { recovered: true } : {};
  if (paths.length === 0) return { primed: 0, ...recovered };

  const listed = await indexedPaths(path, paths);
  if ("error" in listed) {
    return { primed: 0, skipped: `could not read the index: ${listed.error}`, ...recovered };
  }
  if (listed.paths.length === 0) return { primed: 0, ...recovered };

  const clean = await readConfigValues(path, "filter.annex.clean", "all");
  if ("error" in clean) {
    return { primed: 0, error: describeConfigReadFailure(clean.error) };
  }
  const cleanValue = clean.values[clean.values.length - 1];
  if (cleanValue === undefined || !isAnnexCleanFilter(cleanValue)) {
    return {
      primed: 0,
      skipped: "filter.annex.clean is not git-annex's clean filter",
      ...recovered,
    };
  }
  const local = await readConfigValues(path, FILTER_PROCESS_KEY, "local");
  if ("error" in local) return { primed: 0, error: describeConfigReadFailure(local.error) };
  const all = await readConfigValues(path, FILTER_PROCESS_KEY, "all");
  if ("error" in all) return { primed: 0, error: describeConfigReadFailure(all.error) };
  if (local.values.length > 1 || all.values.length > local.values.length) {
    return {
      primed: 0,
      skipped: `${FILTER_PROCESS_KEY} is set outside this repository's configuration, or more than once`,
      ...recovered,
    };
  }
  const saved = local.values[0];

  let disarm = () => {};
  if (saved !== undefined) {
    const marked = await gitConfig(path, [FILTER_PROCESS_MARKER, saved]);
    if (marked) {
      // Nothing was unset; drop a marker git may have half-written.
      const undo = await gitConfig(path, ["--unset-all", FILTER_PROCESS_MARKER]);
      if (undo) return { primed: 0, error: describeRestoreFailure(path, saved, undo) };
      return {
        primed: 0,
        skipped: `could not record ${FILTER_PROCESS_MARKER}: ${marked}`,
        ...recovered,
      };
    }
    disarm = armRestoreOnInterrupt(path, saved);
  }

  let primed = 0;
  let refreshFailure: string | undefined;
  let restoreFailure: string | undefined;
  try {
    if (saved !== undefined) {
      const unset = await gitConfig(path, ["--unset-all", FILTER_PROCESS_KEY]);
      if (unset) refreshFailure = `could not unset ${FILTER_PROCESS_KEY}: ${unset}`;
    }
    if (!refreshFailure) {
      options.onSuspended?.();
      for (const chunk of chunkAddTargets(listed.paths, REFRESH_CHUNK_PATHS)) {
        const out = await runCommand(
          ["git", "--literal-pathspecs", "add", "--refresh", "--", ...chunk],
          { cwd: path },
        );
        if (out.exitCode !== 0) {
          refreshFailure = out.stderr.trim() || `git add --refresh exited ${out.exitCode}`;
          break;
        }
        primed += chunk.length;
        options.onProgress?.(primed, listed.paths.length);
      }
    }
  } finally {
    // Disarmed only after the restore: a signal that lands while it runs must still find
    // a handler, or the filter process stays out of the configuration.
    if (saved !== undefined) {
      restoreFailure = await restoreFilterProcess(path, saved);
      if (restoreFailure) restoreFailure = await restoreFilterProcess(path, saved);
    }
    disarm();
  }

  if (restoreFailure && saved !== undefined) {
    return { primed, error: describeRestoreFailure(path, saved, restoreFailure), ...recovered };
  }
  if (refreshFailure) {
    return { primed, skipped: `git add --refresh failed: ${refreshFailure}`, ...recovered };
  }
  return { primed, ...recovered };
}

function describeConfigReadFailure(error: string): string {
  return `Could not read the repository's git-annex filter configuration (${displayName(error)}). Run the upload again; if git keeps failing, the repository needs attention.`;
}
