/**
 * Upload pipeline: a new recording's acquisition dates are set to 1 January of their year before
 * anything is sent (epic #1610 phase 9, ADR 0091).
 *
 * WHY HERE, AND WHY THE UPLOADER'S OWN FILES. `nemar dataset upload` makes the uploader's directory
 * the dataset's git-annex repository and annexes the files in place, so the bytes NEMAR stores are
 * the bytes in that directory when `git annex add` runs. Setting a date in the stored copy and not
 * in the directory is not possible without keeping a second copy of every recording; so the file in
 * the directory is the one that changes, which is also what the upload already does to it (it
 * becomes a link into the annex).
 *
 * TWO STEPS, AND NOTHING CHANGES UNTIL THE UPLOADER CONFIRMS.
 *
 * 1. {@link planUploadDates} runs before the identifier preflight and only reads. For every EDF and
 *    BDF file the preflight would read, it asks the shared rule (`normalizeEdfDates`, the same one
 *    the importer runs) what the header would become, and keeps the file in the plan only when
 *    changing it is safe. The preflight then screens the tree as it will be sent: the planned
 *    headers are read as the plan will write them, so a date the upload will set is not warned
 *    about, and one it leaves is (ADR 0090's warning). A dry run plans, screens and stops.
 * 2. {@link applyUploadDates} runs after the final confirmation and right before the second screen,
 *    which then reads the files as they are and is the record that is sent.
 *
 * WHAT IS NEVER TOUCHED, each left as it is and its dates warned about:
 *   - a file git tracks, which includes every file git-annex tracks (`git ls-files`): those change
 *     only through the uploader's own commits;
 *   - a file inside a nested repository (a directory below the dataset's that holds a `.git`, such
 *     as a DataLad subdataset), whose index the dataset's own does not include;
 *   - a file git would ignore (`git check-ignore`), which the upload's `git annex add` skips and so
 *     never sends;
 *   - every file at all, when git cannot answer those questions (no git, or it fails);
 *   - a symbolic link, wherever it points (an annex object, a raw-data folder);
 *   - a file the uploader cannot write, does not own, or whose read-only bit is set, or in a
 *     directory it cannot write;
 *   - a file on another filesystem than the dataset's directory;
 *   - a file that changed after the plan (device, inode, modification time and the header bytes
 *     are compared again), or while it was being copied;
 *   - a scans table: the upload edits no table (ADR 0091).
 *
 * HOW A FILE CHANGES. Never in place: the file is copied into the dataset's own `.nemar/` directory
 * (same filesystem, excluded from the upload and from git), given the original's group and
 * permission bits, the new header is written into the copy and synced, the copy is checked (size,
 * header), the original is checked again, and the copy is renamed over the original. A rename
 * replaces the directory entry and not the file's contents, so another hard link to the same file
 * (a backup made with `cp -l`) keeps its date, and an interruption leaves either the old file or
 * the new one, never a mix. Extended attributes and access control lists are those the copy gets;
 * the modification time is the time of the change. A copy an interrupted run left behind stays in
 * `.nemar/` until the next apply removes it.
 *
 * NOTHING HERE STOPS AN UPLOAD. A date never gates (ADR 0090), so a file that cannot be planned or
 * set keeps its dates and the second screen warns about them; a fault is written to the debug log
 * in fixed words.
 *
 * NOTHING PRINTED NAMES ANYTHING. One neutral line with the number of headers actually set
 * (`dateNormalizationLine`), after they are set; no path, no value, no warning and no prompt.
 */

import { randomBytes } from "node:crypto";
import {
  constants,
  type Stats,
  accessSync,
  chmodSync,
  chownSync,
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import chalk from "chalk";
import { EDF_HEADER_BYTES } from "../../../shared/identifier-scan.js";
import { dateNormalizationLine } from "../../../shared/identifier-screen-report.js";
import { ScrubRefused, normalizeEdfDates } from "../../../shared/identifier-scrub.js";
import { dlog } from "../debug-log.js";
import { runCommand } from "../git-annex/run-command.js";
import { walkDatasetTree } from "./identifier-preflight.js";

/** The files the preflight reads as recordings (`EDF_FILE` in the fleet scan). */
const RECORDING = /\.(edf|bdf)$/i;

/** Where the copies are made: the CLI's own directory, which the upload never sends. */
const WORK_DIR = join(".nemar", "date-normalization");

/** Why a recording whose dates the rule would set is left as it is. Counts only. */
export type DateLeftReason =
  | "tracked"
  | "nested-repository"
  | "ignored"
  | "tracking-unknown"
  | "link"
  | "not-writable"
  | "other-filesystem"
  | "unverified";

export interface DatePlanItem {
  /** Absolute path. For this process's own use; never printed, logged or sent. */
  path: string;
  /** The dataset-relative path, as the upload plan spells it. Never printed. */
  rel: string;
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  mode: number;
  gid: number;
  /** The first {@link EDF_HEADER_BYTES} bytes as they are. */
  before: Uint8Array;
  /** The same bytes with the dates set, as `normalizeEdfDates` proved them. */
  after: Uint8Array;
}

export interface DatePlan {
  items: DatePlanItem[];
  /** Recordings with a date the rule would set that this upload leaves, by reason. */
  left: Record<DateLeftReason, number>;
}

const emptyLeft = (): Record<DateLeftReason, number> => ({
  tracked: 0,
  "nested-repository": 0,
  ignored: 0,
  "tracking-unknown": 0,
  link: 0,
  "not-writable": 0,
  "other-filesystem": 0,
  unverified: 0,
});

/** A plan that changes nothing. */
export function emptyDatePlan(): DatePlan {
  return { items: [], left: emptyLeft() };
}

/** Whether `dir` or a directory above it holds a `.git`, or git is pointed elsewhere by the environment. */
function mayBeInRepository(dir: string): boolean {
  if (process.env.GIT_DIR || process.env.GIT_WORK_TREE) return true;
  for (let at = dir; ; at = dirname(at)) {
    if (existsSync(join(at, ".git"))) return true;
    if (dirname(at) === at) return false;
  }
}

/**
 * A path as compared with git's: Unicode NFC and lower case. git on macOS precomposes names and a
 * case-insensitive filesystem lets the two spellings differ, so both sides are folded; a collision
 * then reads as tracked or ignored, which leaves a file alone and never touches one git tracks.
 */
const folded = (path: string) => path.normalize("NFC").toLowerCase();

/** What git says about the candidate files, folded; null when it cannot be told. */
export interface GitView {
  tracked: Set<string>;
  ignored: Set<string>;
}

async function gitPaths(args: string[], cwd: string, stdin?: string): Promise<Set<string> | null> {
  try {
    const r = await runCommand(args, { cwd, ...(stdin === undefined ? {} : { stdin }) });
    // `check-ignore` exits 1 when nothing is ignored; anything else but 0 is a failure.
    const ok = r.exitCode === 0 || (args.includes("check-ignore") && r.exitCode === 1);
    if (!ok) return null;
    return new Set(r.stdout.split("\0").filter(Boolean).map(folded));
  } catch {
    return null;
  }
}

/**
 * Which of `candidates` (dataset-relative) git tracks, and which it would ignore, or null when that
 * cannot be told. Inside a repository, `git ls-files` lists the index, which holds every file git or
 * git-annex tracks, and `git check-ignore` applies its ignore rules. Outside any repository nothing
 * is tracked, and the ignore rules the upload's own repository will apply (the tree's `.gitignore`
 * files and the user's global excludes) are applied through an empty repository made for the
 * question and removed after it.
 */
export async function gitView(root: string, candidates: string[]): Promise<GitView | null> {
  const stdin = `${candidates.join("\0")}\0`;
  if (mayBeInRepository(root)) {
    const tracked = await gitPaths(["git", "ls-files", "-z"], root);
    const ignored = await gitPaths(["git", "check-ignore", "-z", "--stdin"], root, stdin);
    return tracked && ignored ? { tracked, ignored } : null;
  }
  let scratch: string | null = null;
  try {
    scratch = mkdtempSync(join(tmpdir(), "nemar-ignore-"));
    const init = await runCommand(["git", "init", "-q", "--bare", scratch], { cwd: root });
    if (init.exitCode !== 0) return null;
    const ignored = await gitPaths(
      [
        "git",
        `--git-dir=${scratch}`,
        `--work-tree=${root}`,
        "check-ignore",
        "--no-index",
        "-z",
        "--stdin",
      ],
      root,
      stdin,
    );
    return ignored ? { tracked: new Set(), ignored } : null;
  } catch {
    return null;
  } finally {
    if (scratch !== null) {
      try {
        rmSync(scratch, { recursive: true, force: true });
      } catch {}
    }
  }
}

function readHead(path: string): Uint8Array | null {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return null;
  }
  try {
    const out = new Uint8Array(EDF_HEADER_BYTES);
    let got = 0;
    while (got < EDF_HEADER_BYTES) {
      const n = readSync(fd, out, got, EDF_HEADER_BYTES - got, got);
      if (n === 0) break;
      got += n;
    }
    return got === EDF_HEADER_BYTES ? out : null;
  } catch {
    return null;
  } finally {
    try {
      closeSync(fd);
    } catch {}
  }
}

const sameBytes = (a: Uint8Array | null, b: Uint8Array) =>
  a !== null && a.length === b.length && a.every((x, i) => x === b[i]);

function writable(path: string): boolean {
  try {
    accessSync(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether a directory between the dataset's (exclusive) and the file's (inclusive) holds a `.git`:
 * the file belongs to a nested repository, whose index is not the dataset's.
 */
function inNestedRepository(root: string, rel: string, cache: Map<string, boolean>): boolean {
  const parts = rel.split("/").slice(0, -1);
  for (let i = 1; i <= parts.length; i++) {
    const dir = parts.slice(0, i).join("/");
    let nested = cache.get(dir);
    if (nested === undefined) {
      nested = existsSync(join(root, dir, ".git"));
      try {
        nested ||= lstatSync(join(root, dir, ".git")).isSymbolicLink();
      } catch {}
      cache.set(dir, nested);
    }
    if (nested) return true;
  }
  return false;
}

interface Candidate {
  path: string;
  rel: string;
  before: Uint8Array;
  after: Uint8Array;
}

/**
 * What the upload would change, and nothing changed. Read-only: it lists the tree the way the
 * preflight does, reads each recording's header, and asks the shared rule. A file whose dates the
 * rule would set goes into the plan only when every condition in the module comment holds; the
 * others are counted by reason and keep their dates. It never throws: a fault leaves the plan as far
 * as it got, which only means fewer files change.
 */
export async function planUploadDates(root: string): Promise<DatePlan> {
  const plan = emptyDatePlan();
  try {
    await fillPlan(root, plan);
  } catch (error) {
    dlog(
      `date normalization: planning stopped (${error instanceof Error ? error.name : "unknown"})`,
    );
  }
  return plan;
}

async function fillPlan(root: string, plan: DatePlan): Promise<void> {
  const rootDev = statSync(root).dev;
  const tree = walkDatasetTree(root);
  const candidates: Candidate[] = [];
  for (const entry of tree.entries) {
    if (!RECORDING.test(entry.path)) continue;
    const path = tree.readable.get(entry.url);
    if (path === undefined) continue;
    const before = readHead(path);
    if (before === null) continue;
    try {
      const result = normalizeEdfDates(before);
      if (result.changed) candidates.push({ path, rel: entry.path, before, after: result.header });
    } catch (error) {
      if (error instanceof ScrubRefused) continue;
      // An unproven result, or any fault in the rule: this file keeps its dates and is warned
      // about, and the upload is not stopped over a change it was never asked to make.
      plan.left.unverified++;
      dlog(
        `date normalization: a header was not planned (${error instanceof Error ? error.name : "unknown"})`,
      );
    }
  }
  if (candidates.length === 0) return;
  // Asked once, for every candidate together.
  const git = await gitView(
    root,
    candidates.map((c) => c.rel),
  );
  const nested = new Map<string, boolean>();
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  for (const c of candidates) {
    if (git === null) {
      plan.left["tracking-unknown"]++;
      continue;
    }
    if (git.tracked.has(folded(c.rel))) {
      plan.left.tracked++;
      continue;
    }
    if (inNestedRepository(root, c.rel, nested)) {
      plan.left["nested-repository"]++;
      continue;
    }
    if (git.ignored.has(folded(c.rel))) {
      plan.left.ignored++;
      continue;
    }
    let st: Stats;
    try {
      st = lstatSync(c.path);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) {
      plan.left.link++;
      continue;
    }
    if (!st.isFile()) continue;
    if (st.dev !== rootDev) {
      plan.left["other-filesystem"]++;
      continue;
    }
    if (
      (uid !== null && st.uid !== uid) ||
      (st.mode & 0o200) === 0 ||
      !writable(c.path) ||
      !writable(dirname(c.path))
    ) {
      plan.left["not-writable"]++;
      continue;
    }
    plan.items.push({
      path: c.path,
      rel: c.rel,
      dev: st.dev,
      ino: st.ino,
      size: st.size,
      mtimeMs: st.mtimeMs,
      mode: st.mode,
      gid: st.gid,
      before: c.before,
      after: c.after,
    });
  }
}

export interface DateApplyResult {
  /** Recordings whose dates were set. */
  set: number;
  /** Planned recordings left as they are, because something changed or could not be checked. */
  left: number;
  /** The new modification time of each changed file, by dataset-relative path. */
  mtimes: Map<string, number>;
}

/** A copy this module made: `<pid>-<16 hex>`. */
const COPY_NAME = /^\d+-[0-9a-f]{16}$/;

/** Remove the copies an interrupted run left in the work directory, if it is a plain directory. */
function sweepStaleCopies(root: string): void {
  try {
    const dir = join(root, WORK_DIR);
    for (const d of [join(root, ".nemar"), dir]) {
      if (!lstatSync(d).isDirectory()) return;
    }
    for (const name of readdirSync(dir)) {
      if (COPY_NAME.test(name)) rmSync(join(dir, name), { force: true });
    }
  } catch {}
}

/** Remove directories, deepest first, where empty. */
function removeEmpty(dirs: string[]): void {
  for (const d of dirs) {
    try {
      rmdirSync(d);
    } catch {}
  }
}

/**
 * The work directory inside the dataset's `.nemar/`, made where missing and never through a link,
 * with the directories it made, or null (having removed what it made) when it is not a plain
 * directory on the dataset's filesystem.
 */
function workDir(root: string, rootDev: number): { dir: string; made: string[] } | null {
  const made: string[] = [];
  const dir = join(root, WORK_DIR);
  try {
    for (const d of [join(root, ".nemar"), dir]) {
      let st: Stats;
      try {
        st = lstatSync(d);
      } catch {
        mkdirSync(d);
        made.push(d);
        st = lstatSync(d);
      }
      if (!st.isDirectory() || st.dev !== rootDev) {
        removeEmpty([...made].reverse());
        return null;
      }
    }
    return { dir, made };
  } catch {
    removeEmpty([...made].reverse());
    return null;
  }
}

function syncDirectory(dir: string): void {
  // Best effort: a directory cannot be synced on every platform, and the rename already happened.
  try {
    const fd = openSync(dir, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {}
}

/**
 * Set one planned file's dates by copy, check and rename, and return its new modification time;
 * null, with the file as it was, when anything differs from the plan or cannot be checked.
 */
function applyOne(item: DatePlanItem, dir: string): number | null {
  let copy: string | null = null;
  try {
    // `lstat` of a link is not a file, so a file replaced by a link fails the first term. The size is
    // compared too: a filesystem with coarse timestamps (FAT, exFAT, HFS+) can keep the same
    // modification time across a write, and a recording still being written grows.
    const unchanged = (st: Stats) =>
      st.isFile() &&
      st.dev === item.dev &&
      st.ino === item.ino &&
      st.size === item.size &&
      st.mtimeMs === item.mtimeMs;
    if (!unchanged(lstatSync(item.path)) || !sameBytes(readHead(item.path), item.before)) {
      return null;
    }
    copy = join(dir, `${process.pid}-${randomBytes(8).toString("hex")}`);
    // A clone where the filesystem has one (APFS, Btrfs, XFS), else a full copy.
    copyFileSync(item.path, copy, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
    // The group a new file gets is its directory's or the process's, not the original's.
    if (lstatSync(copy).gid !== item.gid) chownSync(copy, -1, item.gid);
    chmodSync(copy, item.mode & 0o7777);
    const fd = openSync(copy, "r+");
    try {
      if (writeSync(fd, item.after, 0, EDF_HEADER_BYTES, 0) !== EDF_HEADER_BYTES) return null;
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    if (lstatSync(copy).size !== item.size || !sameBytes(readHead(copy), item.after)) return null;
    // The original did not change while it was copied.
    if (!unchanged(lstatSync(item.path))) return null;
    renameSync(copy, item.path);
    copy = null;
    syncDirectory(dirname(item.path));
    return lstatSync(item.path).mtimeMs;
  } catch (error) {
    dlog(
      `date normalization: a header was not set (${error instanceof Error ? error.name : "unknown"})`,
    );
    return null;
  } finally {
    if (copy !== null) {
      try {
        rmSync(copy, { force: true });
      } catch {}
    }
  }
}

/**
 * Set the planned dates, and say how many in one line. Each file is set or left on its own; one
 * that cannot be set keeps its dates, and the second screen warns about them. It never throws.
 */
export function applyUploadDates(root: string, plan: DatePlan): DateApplyResult {
  const result: DateApplyResult = { set: 0, left: 0, mtimes: new Map() };
  sweepStaleCopies(root);
  if (plan.items.length === 0) return result;
  let work: ReturnType<typeof workDir> = null;
  try {
    work = workDir(root, statSync(root).dev);
  } catch {}
  if (work === null) {
    result.left = plan.items.length;
    dlog("date normalization: no work directory, nothing set");
    return result;
  }
  try {
    for (const item of plan.items) {
      const mtime = applyOne(item, work.dir);
      if (mtime === null) {
        result.left++;
        continue;
      }
      result.set++;
      result.mtimes.set(item.rel, mtime);
    }
  } finally {
    // The work directory, and `.nemar/` too when this made it; either stays if anything is in it.
    removeEmpty([work.dir, ...[...work.made].reverse().filter((d) => d !== work.dir)]);
  }
  if (result.set > 0) console.log(chalk.dim(`  ${dateNormalizationLine(result.set)}`));
  return result;
}
