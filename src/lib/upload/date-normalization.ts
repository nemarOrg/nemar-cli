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
 *     only through the uploader's own commits; and every file at all when it cannot be told which
 *     files git tracks;
 *   - a symbolic link, wherever it points (an annex object, a raw-data folder);
 *   - a file the uploader cannot write, that someone else owns, or in a directory it cannot write;
 *   - a file on another filesystem than the dataset's directory;
 *   - a file that changed after the plan (device, inode, size, modification time and the header
 *     bytes are compared again), or while it was being copied;
 *   - a scans table: the upload edits no table (ADR 0091).
 *
 * HOW A FILE CHANGES. Never in place: the file is copied into the dataset's own `.nemar/` directory
 * (same filesystem, excluded from the upload and from git), the new header is written into the copy
 * and synced, the copy is checked (size, header), the original is checked again, and the copy is
 * renamed over the original. A rename replaces the directory entry and not the file's contents, so
 * another hard link to the same file (a backup made with `cp -l`) keeps its date, and an
 * interruption leaves either the old file or the new one, never a mix. Permission bits are kept;
 * the modification time is the time of the change.
 *
 * NOTHING PRINTED NAMES ANYTHING. The preflight prints one neutral line with a count
 * (`dateNormalizationLine`); this module prints nothing, and no path, value, warning or prompt.
 */

import { randomBytes } from "node:crypto";
import {
  constants,
  type Stats,
  accessSync,
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { EDF_HEADER_BYTES } from "../../../shared/identifier-scan.js";
import {
  DateNormalizationUnverified,
  ScrubRefused,
  normalizeEdfDates,
} from "../../../shared/identifier-scrub.js";
import { runCommand } from "../git-annex/run-command.js";
import { walkDatasetTree } from "./identifier-preflight.js";

/** The files the preflight reads as recordings (`EDF_FILE` in the fleet scan). */
const RECORDING = /\.(edf|bdf)$/i;

/** Where the copies are made: the CLI's own directory, which the upload never sends. */
const WORK_DIR = join(".nemar", "date-normalization");

/** Why a recording whose dates the rule would set is left as it is. Counts only. */
export type DateLeftReason =
  | "tracked"
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
 * then reads as tracked, which leaves a file alone and never touches one git tracks.
 */
const folded = (path: string) => path.normalize("NFC").toLowerCase();

/**
 * The dataset-relative paths git tracks, folded, or null when that cannot be told. Outside any
 * repository nothing is tracked and git is not run; inside one, `git ls-files` lists the index,
 * which holds every file git or git-annex tracks.
 */
export async function trackedPaths(root: string): Promise<Set<string> | null> {
  if (!mayBeInRepository(root)) return new Set();
  try {
    const r = await runCommand(["git", "ls-files", "-z"], { cwd: root });
    if (r.exitCode !== 0) return null;
    return new Set(r.stdout.split("\0").filter(Boolean).map(folded));
  } catch {
    return null;
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
    closeSync(fd);
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
 * What the upload would change, and nothing changed. Read-only: it lists the tree the way the
 * preflight does, reads each recording's header, and asks the shared rule. A file whose dates the
 * rule would set goes into the plan only when every condition in the module comment holds; the
 * others are counted by reason and keep their dates.
 */
export async function planUploadDates(root: string): Promise<DatePlan> {
  const plan = emptyDatePlan();
  let rootDev: number;
  try {
    rootDev = statSync(root).dev;
  } catch {
    return plan;
  }
  const tree = walkDatasetTree(root);
  let tracked: Set<string> | null | undefined;
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  for (const entry of tree.entries) {
    if (!RECORDING.test(entry.path)) continue;
    const path = tree.readable.get(entry.url);
    if (path === undefined) continue;
    const before = readHead(path);
    if (before === null) continue;
    let after: Uint8Array;
    try {
      const result = normalizeEdfDates(before);
      if (!result.changed) continue;
      after = result.header;
    } catch (error) {
      if (error instanceof ScrubRefused) continue;
      if (error instanceof DateNormalizationUnverified) {
        plan.left.unverified++;
        continue;
      }
      throw error;
    }
    // Asked once, and only when some recording has a date to set.
    tracked ??= await trackedPaths(root);
    if (tracked === null) {
      plan.left["tracking-unknown"]++;
      continue;
    }
    if (tracked.has(folded(entry.path))) {
      plan.left.tracked++;
      continue;
    }
    let st: Stats;
    try {
      st = lstatSync(path);
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
      !writable(path) ||
      !writable(dirname(path))
    ) {
      plan.left["not-writable"]++;
      continue;
    }
    plan.items.push({
      path,
      rel: entry.path,
      dev: st.dev,
      ino: st.ino,
      size: st.size,
      mtimeMs: st.mtimeMs,
      mode: st.mode,
      before,
      after,
    });
  }
  return plan;
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

/**
 * The work directory inside the dataset's `.nemar/`, made where missing and never through a link,
 * with the directories it made, or null when it is not a plain directory on the dataset's
 * filesystem. A copy a crashed run left there is removed.
 */
function workDir(root: string, rootDev: number): { dir: string; made: string[] } | null {
  const made: string[] = [];
  try {
    const nemar = join(root, ".nemar");
    const dir = join(root, WORK_DIR);
    for (const d of [nemar, dir]) {
      let st: Stats | null = null;
      try {
        st = lstatSync(d);
      } catch {
        mkdirSync(d);
        made.push(d);
        st = lstatSync(d);
      }
      if (!st.isDirectory() || st.dev !== rootDev) return null;
    }
    for (const name of readdirSync(dir)) {
      if (COPY_NAME.test(name)) rmSync(join(dir, name), { force: true });
    }
    return { dir, made };
  } catch {
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
    const unchanged = (st: Stats) =>
      st.isFile() &&
      !st.isSymbolicLink() &&
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
  } catch {
    return null;
  } finally {
    if (copy !== null) rmSync(copy, { force: true });
  }
}

/**
 * Set the planned dates. Each file is set or left on its own; one that cannot be set keeps its
 * dates, and the second screen warns about them. Prints nothing.
 */
export function applyUploadDates(root: string, plan: DatePlan): DateApplyResult {
  const result: DateApplyResult = { set: 0, left: 0, mtimes: new Map() };
  if (plan.items.length === 0) return result;
  let rootDev: number;
  try {
    rootDev = statSync(root).dev;
  } catch {
    result.left = plan.items.length;
    return result;
  }
  const work = workDir(root, rootDev);
  if (work === null) {
    result.left = plan.items.length;
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
    for (const d of [work.dir, ...work.made.filter((d) => d !== work.dir)]) {
      try {
        rmdirSync(d);
      } catch {}
    }
  }
  return result;
}
