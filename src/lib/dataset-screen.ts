/**
 * `nemar dataset screen`: the identifier screen, run on the depositor's own copy (card A9, issue
 * #2184).
 *
 * ONE QUESTION, ASKED THE SAME WAY. The publication screen (`scripts/identifier-screen-ci-lib.ts`,
 * ADR 0086) turns a git tree into manifest entries and hands them to the fleet scan's
 * `scanDatasetFromManifest`, then to `finalizeScanReport`. This command does the same two steps
 * with the same readers, the same limits and the same folds; only the bytes come from somewhere
 * else (a local file, a git blob through `git cat-file`, or the annex object store on this
 * machine). Its words are `describeScreen`'s, so a status, a per-format count, a finding kind, a
 * remedy and a docs link read exactly as they do in the admin mail and in `publish status`.
 *
 * WHAT IT READS. By default the files in the directory as they are now (the upload preflight's
 * walk, ADR 0087). With `committed` the tree of `HEAD`, which is what the server screens. In a git
 * repository the history is walked as the server walks it: every path that ever existed goes
 * through the path rules, and a recording an earlier commit held that the tree no longer does is
 * read when its content is on this machine.
 *
 * WHAT IT DOES NOT READ, AND SAYS SO (the help text lists the same). The server's own copy
 * (storage, its version manifest, branches pushed there); the contents of sidecars and tables in
 * earlier commits (the server's own "Not read" line); annexed content that is not on this machine
 * (a recording is then `partial` with reason `content-absent`, in the tree or in an earlier
 * commit, so the screen is incomplete and never clean); and, in the working-tree mode, the
 * committed tree. `LOCAL_COPY` holds those sentences. Anything the machine refuses to show
 * (permission, I/O) is a failed read, not an absent one, and a git that fails is an error, never a
 * screen without history.
 *
 * NON-MUTATING. No network, no git write, no file write. Every git command is a read (`rev-parse`,
 * `ls-tree`, `log`, `cat-file`) run with no user or system configuration, no optional lock and no
 * lazy fetch, so a partial clone's missing blob is "missing", never a hidden download. git-annex is
 * not run at all (it can auto-initialize a repository); the annex object store is read directly.
 *
 * NOTHING PRINTED NAMES ANYTHING: kinds, counts and fixed words only, as on the server.
 */

import { existsSync, lstatSync, readdirSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { open } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { Command } from "commander";
import {
  LOCAL_SCAN_LIMITS,
  type ManifestEntry,
  type ScanExtras,
  createContext,
  scanDatasetFromManifest,
} from "../../scripts/identifier-fleet-lib.js";
import {
  GitBlobReader,
  type ResolvedTree,
  type Tree,
  createEntryReader,
  declaredSize,
  finalizeScanReport,
  findSuperseded,
  listTree,
  objectSizes,
  parseAnnexPointer,
  resolveEntries,
  walkHistory,
} from "../../scripts/identifier-screen-ci-lib.js";
import {
  type FormatReader,
  READERS,
  ReadFailure,
  readerFor,
} from "../../shared/identifier-readers.js";
import {
  LOCAL_READER_CLASS_LIMITS,
  readerForEntry,
} from "../../shared/identifier-report-builder.js";
import {
  type Copy,
  LOCAL_COPY,
  type LocalScannerKind,
  remedyLines,
} from "../../shared/identifier-screen-copy.js";
import {
  type DatasetStatus,
  type ScreenReport,
  describeScreen,
  foldOddFailures,
  foldOddFormats,
} from "../../shared/identifier-screen-report.js";
import { markReportedExit } from "./debug-log.js";
import { identifierScreenLines } from "./identifier-screen-display.js";
import { createLocalReader, walkDatasetTree } from "./upload/identifier-preflight.js";
import { version } from "./version.js";

// ---------------------------------------------------------------------------------------
// Errors and exit codes
// ---------------------------------------------------------------------------------------

/** The words of a run that could not be made; their sentences are `LOCAL_COPY.errors`. */
export type LocalErrorCode = keyof typeof LOCAL_COPY.errors;

export class LocalScreenError extends Error {
  readonly code: LocalErrorCode;
  /** For `git-failed`: the class of the failure, a fixed word. */
  readonly failure: string | undefined;
  constructor(code: LocalErrorCode, cause?: string) {
    super(code);
    this.name = "LocalScreenError";
    this.code = code;
    this.failure = cause;
  }
}

/** The sentence for a run that could not be made. Never a path. */
export function localErrorSentence(error: unknown): string {
  if (!(error instanceof LocalScreenError)) return LOCAL_COPY.fallbackError;
  const sentence = LOCAL_COPY.errors[error.code];
  return typeof sentence === "function" ? sentence(error.failure ?? "unknown") : sentence;
}

/** 0 for a clear verdict, 3 for a direct identifier, 2 for every other state (a person must look). */
export function exitCodeFor(status: DatasetStatus): 0 | 2 | 3 {
  if (status === "direct-identifiers") return 3;
  if (status === "clean" || status === "dates-only" || status === "no-recordings") return 0;
  return 2;
}

// ---------------------------------------------------------------------------------------
// Git, read only
// ---------------------------------------------------------------------------------------

const NULL_OID = "0".repeat(40);

/** No user or system configuration, no prompt, no optional lock (no index refresh), no lazy fetch. */
function gitEnv(): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: process.env.HOME ?? "/",
    LC_ALL: "C",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_NO_LAZY_FETCH: "1",
    GIT_OPTIONAL_LOCKS: "0",
    // Git's own switch for treating the repository as another user's. It lets a test reproduce the
    // `safe.directory` refusal, which otherwise needs a second account; it is never set otherwise.
    ...(process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER
      ? { GIT_TEST_ASSUME_DIFFERENT_OWNER: process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER }
      : {}),
  };
}

export type GitResult =
  | { ok: true; text: string }
  | {
      ok: false;
      /** git's own answer that this is no repository; every other failure is `failed`. */
      kind: "not-a-repository" | "failed";
      /** The exit code, or null when git could not be started. */
      code: number | null;
      /** A fixed word for the failure's class. */
      cause: string;
    };

/**
 * What kind of failure a git exit was, from its exit code and message. The message is read here
 * and never kept or printed: it can name a path. Only "this is no repository" (exit 128 with that
 * message) is a plain absence; a refusal of ownership, a corrupt directory or any other exit is
 * a failure to read.
 */
export function classifyGitFailure(code: number | null, stderr: string): GitResult & { ok: false } {
  if (code === null) return { ok: false, kind: "failed", code, cause: "spawn-failed" };
  if (code === 128 && /not a git repository/i.test(stderr)) {
    return { ok: false, kind: "not-a-repository", code, cause: "not-a-repository" };
  }
  if (/dubious ownership|safe\.directory/i.test(stderr)) {
    return { ok: false, kind: "failed", code, cause: "unsafe-directory" };
  }
  return { ok: false, kind: "failed", code, cause: `exit-${code}` };
}

/** One git read, with its failure classed. stderr is read for the class and never kept. */
export async function gitRun(root: string, args: readonly string[]): Promise<GitResult> {
  try {
    const proc = Bun.spawn(["git", "-C", root, ...args], {
      env: gitEnv(),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [text, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return code === 0 ? { ok: true, text: text.trim() } : classifyGitFailure(code, stderr);
  } catch {
    return classifyGitFailure(null, "");
  }
}

/** The stdout of a git read, or null when it failed for any reason. */
async function gitText(root: string, args: readonly string[]): Promise<string | null> {
  const result = await gitRun(root, args);
  return result.ok ? result.text : null;
}

interface Repository {
  /** The shared git directory, where `annex/objects` lives (a linked worktree shares it). */
  commonDir: string;
  /** The commit `HEAD` names, or null in a repository with none yet. */
  head: string | null;
}

/**
 * The repository whose top level is `root`, or null when `root` is plainly not one (git says so
 * and there is no `.git` here). A directory that has a `.git` but that git cannot read (a corrupt
 * HEAD, a refused ownership, a spawn error) is a {@link LocalScreenError} `git-failed`: a screen
 * without the history would read less than the server does and still look complete.
 */
async function repositoryAt(root: string): Promise<Repository | null> {
  const top = await gitRun(root, ["rev-parse", "--show-toplevel"]);
  if (!top.ok) {
    if (top.kind === "not-a-repository" && !existsSync(join(root, ".git"))) return null;
    throw new LocalScreenError(
      "git-failed",
      top.kind === "not-a-repository" ? "git-dir-unusable" : top.cause,
    );
  }
  try {
    // A subdirectory of a repository is not the repository: no history is claimed for it.
    if (realpathSync(top.text) !== realpathSync(root)) return null;
  } catch {
    throw new LocalScreenError("git-failed", "path-unreadable");
  }
  const common = await gitRun(root, ["rev-parse", "--git-common-dir"]);
  if (!common.ok) throw new LocalScreenError("git-failed", common.cause);
  // `--quiet` answers an unborn HEAD (no commit yet) with exit 1 and nothing; any other failure
  // is git failing.
  const head = await gitRun(root, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  if (!head.ok && head.code !== 1) throw new LocalScreenError("git-failed", head.cause);
  return {
    commonDir: resolve(root, common.text),
    head: head.ok && /^[0-9a-f]{40}$/.test(head.text) ? head.text : null,
  };
}

// ---------------------------------------------------------------------------------------
// The annex object store on this machine
// ---------------------------------------------------------------------------------------

/**
 * Where an annexed file's content is, by key. The store is indexed once, on first use, by listing
 * `annex/objects/<xx>/<yy>/<key>/`, so no hash-directory layout is assumed (it differs with the
 * repository's tuning) and git-annex is never run.
 */
export type AnnexLookup =
  | { kind: "found"; path: string }
  /** The store is readable and holds no such object: the content is not on this machine. */
  | { kind: "absent" }
  /** The machine refused to show the store or the object (permission, I/O): not the same as absent. */
  | { kind: "unreadable" };

/** An error that means "there is nothing there", as opposed to "the machine would not say". */
const isNothingThere = (error: unknown): boolean => {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
};

export class AnnexObjects {
  private index: Map<string, string> | null = null;
  /** Some directory of the store could not be listed, so an object missing from the index may exist. */
  private partial = false;
  constructor(private readonly gitDir: string | null) {}

  private build(): Map<string, string> {
    const index = new Map<string, string>();
    if (!this.gitDir) return index;
    const root = join(this.gitDir, "annex", "objects");
    const list = (dir: string): string[] => {
      try {
        return readdirSync(dir);
      } catch (error) {
        if (!isNothingThere(error)) this.partial = true;
        return [];
      }
    };
    for (const a of list(root)) {
      for (const b of list(join(root, a))) {
        for (const key of list(join(root, a, b))) index.set(key, join(root, a, b, key, key));
      }
    }
    return index;
  }

  /** The content file of `key`: found, absent from a store that could be read, or unreadable. */
  find(key: string): AnnexLookup {
    this.index ??= this.build();
    const path = this.index.get(key);
    if (!path) return this.partial ? { kind: "unreadable" } : { kind: "absent" };
    try {
      return statSync(path).isFile() ? { kind: "found", path } : { kind: "absent" };
    } catch (error) {
      return isNothingThere(error) ? { kind: "absent" } : { kind: "unreadable" };
    }
  }
}

// ---------------------------------------------------------------------------------------
// Entries
// ---------------------------------------------------------------------------------------

/** The reader an annex key's extension names, as the entry hint `scanDatasetFromManifest` reads. */
function hintFor(key: string): Pick<ManifestEntry, "edf" | "reader"> {
  const reader = readerFor(key);
  if (!reader) return {};
  return reader.id === "edf" ? { edf: true } : { reader: reader.id };
}

/**
 * Where the content of an `annex:<key>` entry is: into `readable` when it is on this machine,
 * into `unreadable` when the machine would not show the store. Neither: it is absent.
 */
function locate(
  objects: AnnexObjects,
  url: string,
  readable: Map<string, string>,
  unreadable: Set<string>,
): AnnexLookup {
  const found = objects.find(url.slice(6));
  if (found.kind === "found") readable.set(url, found.path);
  else if (found.kind === "unreadable") unreadable.add(url);
  return found;
}

/** Pointer files and symlink targets are tiny; anything bigger is content. */
const POINTER_MAX_BYTES = 1024;

/** A bounded concurrent map over `items`. */
async function mapPool<T>(items: readonly T[], size: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) await fn(items[next++] as T);
    }),
  );
}

/** The first bytes of a small file, as text, or null when it cannot be read. */
async function smallText(path: string): Promise<string | null> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(path, "r");
    const buffer = new Uint8Array(POINTER_MAX_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return bytesRead > POINTER_MAX_BYTES
      ? null
      : new TextDecoder().decode(buffer.subarray(0, bytesRead));
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * The working tree's entries as the scan reads them. A symlink into the annex, or a small file
 * that is an unlocked pointer, is an annexed file: its content is read from where it is on this
 * machine, and a file whose content is not here is `annex:<key>` with no readable path (the scan
 * then counts it `content-absent`, never as a file it could not open).
 */
async function workingTreeEntries(
  root: string,
  objects: AnnexObjects,
  readable: Map<string, string>,
  unreadable: Set<string>,
): Promise<{ entries: ManifestEntry[]; unlisted: number }> {
  const walked = walkDatasetTree(root);
  const annexed = (entry: ManifestEntry, key: string, size: number): void => {
    const url = `annex:${key}`;
    entry.url = url;
    entry.size = declaredSize({ key, size });
    Object.assign(entry, hintFor(key));
    locate(objects, url, readable, unreadable);
  };
  for (const [url, path] of walked.readable) readable.set(url, path);
  await mapPool(walked.entries, 16, async (entry) => {
    const absolute = join(root, entry.path);
    let symlink = false;
    try {
      symlink = lstatSync(absolute).isSymbolicLink();
    } catch {
      // Left as the walk listed it: a file that cannot be examined is never opened, and the scan
      // counts it a failed read (`unreadable-entry`), not an absent one.
      return;
    }
    if (symlink) {
      let target: string;
      try {
        target = readlinkSync(absolute);
      } catch {
        // A link whose target cannot be read stays as listed: a failed read, never `content-absent`.
        return;
      }
      const pointed = parseAnnexPointer(target, true);
      if (!pointed) return;
      // Content that resolves through the link is read through it; anything else is looked up.
      if (entry.size !== null && readable.has(entry.url))
        Object.assign(entry, hintFor(pointed.key));
      else annexed(entry, pointed.key, pointed.size);
      return;
    }
    if (entry.size === null || entry.size > POINTER_MAX_BYTES || !readable.has(entry.url)) return;
    // A small file that cannot be read (`smallText` is null) stays a plain local entry, so the
    // scan opens it, fails, and counts a failed read: an unreadable pointer is not an absent one.
    const text = await smallText(absolute);
    const pointed = text === null ? null : parseAnnexPointer(text, false);
    if (pointed) {
      readable.delete(entry.url);
      annexed(entry, pointed.key, pointed.size);
    }
  });
  return { entries: walked.entries, unlisted: walked.unlisted };
}

// ---------------------------------------------------------------------------------------
// Readers that name an absent file
// ---------------------------------------------------------------------------------------

/** The class a source throws for an annexed recording whose content is not on this machine. */
const CONTENT_ABSENT = "content-absent";

/**
 * A reader that reports a recording whose content is not here as `partial` with the reason
 * `content-absent` (A1's vocabulary), instead of as a failed read. The source throws for it, so
 * the reader never sees a byte and the wrapper changes nothing else about the read: limits,
 * versions, companions and extensions are the reader's own.
 */
export function absenceAware(reader: FormatReader): FormatReader {
  return {
    ...reader,
    async scan(src, path, limits) {
      try {
        return await reader.scan(src, path, limits);
      } catch (error) {
        if (error instanceof ReadFailure && error.cls === CONTENT_ABSENT) {
          return { findings: [], coverage: "partial", incomplete: "content-absent" };
        }
        throw error;
      }
    },
  };
}

// ---------------------------------------------------------------------------------------
// The scanner
// ---------------------------------------------------------------------------------------

/** The most a local screen's history walk may take. */
const LOCAL_DEADLINE_MS = 30 * 60 * 1000;

/** The dataset id of a screen with no dataset: `xx` ids are the sandbox's, and 000000 is never allocated. */
export const LOCAL_DATASET_ID = "xx000000";

/**
 * The scanner's id. From a checkout it is `identifier-scan@<revision>`, the revision of the
 * checkout this code runs from, exactly as the publication screen names it. A packaged CLI has no
 * checkout, so it is `identifier-scan@nemar-cli-v<version>`: the release tag of the build, which
 * names an exact commit. The kind is printed with the report.
 */
export async function localScannerId(
  here: string = import.meta.dir,
): Promise<{ id: string; kind: LocalScannerKind }> {
  if (basename(here) === "lib" && basename(dirname(here)) === "src") {
    const root = dirname(dirname(here));
    if (existsSync(join(root, ".git"))) {
      const rev = await gitText(root, ["rev-parse", "--short=7", "HEAD"]);
      if (rev !== null && /^[0-9a-f]{7,40}$/.test(rev)) {
        return { id: `identifier-scan@${rev}`, kind: "checkout" };
      }
    }
  }
  return { id: `identifier-scan@nemar-cli-v${version}`, kind: "release" };
}

export interface LocalScreen {
  report: ScreenReport;
  /** The verdict, from the report's scan. */
  status: DatasetStatus;
  /** The scanner's id, as the report carries it. */
  scannerId: string;
  source: "working-tree" | "committed";
  /** The commit named: `HEAD` of a repository, null with no repository. */
  commit: string | null;
  /** Whether the directory is the top level of a repository whose history was walked. */
  history: boolean;
  /** Recordings of earlier commits whose content is not on this machine. */
  supersededNotRead: number;
  /** Which kind of id `report.scanner` is. */
  scannerKind: LocalScannerKind;
}

/**
 * Screen the dataset at `root` and return the report, the same one the publication screen makes
 * for the same commit. Throws {@link LocalScreenError} for a run that could not be made (never for
 * a dataset's content).
 */
export async function screenLocalDataset(
  root: string,
  options: { committed: boolean; readers?: readonly FormatReader[] },
): Promise<LocalScreen> {
  try {
    if (!statSync(root).isDirectory()) throw new LocalScreenError("not-a-directory");
  } catch (error) {
    if (error instanceof LocalScreenError) throw error;
    throw new LocalScreenError("not-a-directory");
  }
  // Throws `git-failed` for a directory git cannot read, never a screen without history.
  const repository = await repositoryAt(root);
  if (options.committed && !repository) throw new LocalScreenError("not-a-repository");
  if (options.committed && !repository?.head) throw new LocalScreenError("no-commit");
  const head = repository?.head ?? null;
  const deadlineAt = Date.now() + LOCAL_DEADLINE_MS;
  const scanner = await localScannerId();
  const readers = (options.readers ?? READERS).map(absenceAware);
  const objects = new AnnexObjects(repository?.commonDir ?? null);
  const readable = new Map<string, string>();
  const unreadable = new Set<string>();
  let blobs: GitBlobReader | null = null;
  try {
    // HEAD's tree: the committed mode's entries, and in both modes what "superseded" is measured
    // against.
    let headTree: ResolvedTree | null = null;
    let tree: Tree | null = null;
    let treeOids = new Set<string>();
    if (head) {
      tree = await listTree(root, head);
      if (!tree) throw new LocalScreenError("git-failed", "ls-tree");
      treeOids = new Set(tree.entries.map((t) => t.oid));
      const sizes = await objectSizes(root, [...treeOids]);
      if (!sizes) throw new LocalScreenError("git-failed", "cat-file");
      blobs = new GitBlobReader(root);
      headTree = await resolveEntries(tree.entries, sizes, blobs);
    }

    let entries: ManifestEntry[];
    let unlisted = 0;
    if (options.committed) {
      entries = (headTree as ResolvedTree).entries;
    } else {
      ({ entries, unlisted } = await workingTreeEntries(root, objects, readable, unreadable));
    }
    for (const entry of entries) {
      if (!entry.url.startsWith("annex:") || readable.has(entry.url)) continue;
      locate(objects, entry.url, readable, unreadable);
    }

    // History: every path that ever existed, and the recordings an earlier commit held that the
    // tree no longer does, read when their content is here.
    const extras: ScanExtras = {
      extraIncompleteReasons: [
        ...(unlisted > 0 ? ["tree-truncated"] : []),
        ...(tree && tree.gitlinks > 0 ? ["submodule-unread"] : []),
      ],
      readers,
    };
    let supersededNotRead = 0;
    if (head && headTree && blobs) {
      const walk = await walkHistory(root, deadlineAt);
      const superseded = walk
        ? await findSuperseded(root, walk, headTree, treeOids, blobs)
        : { entries: [], unreadable: 0, sizes: new Map<string, number | null>() };
      const present: ManifestEntry[] = [];
      for (const entry of superseded.entries) {
        if (entry.url.startsWith("annex:")) {
          // Unreadable is read and fails (a failed read); only a store that was read and holds no
          // such object is "not here".
          if (locate(objects, entry.url, readable, unreadable).kind !== "absent") {
            present.push(entry);
          }
        } else if (superseded.sizes.get(entry.url.slice(4)) !== null) {
          present.push(entry);
        }
      }
      supersededNotRead = superseded.entries.length - present.length;
      const here = new Set(entries.map((e) => e.path));
      extras.extraPaths = walk ? [...walk.paths].filter((p) => !here.has(p)) : [];
      extras.supersededRecordings = present;
      if (!walk || superseded.unreadable > 0) {
        extras.extraIncompleteReasons = [
          ...(extras.extraIncompleteReasons ?? []),
          "history-unread",
        ];
      }
      // The server reads these from storage, so a local "clean" would contradict it: the screen
      // is incomplete, with the same reason as a recording of the tree that is not here.
      if (supersededNotRead > 0) {
        extras.extraIncompleteReasons = [
          ...(extras.extraIncompleteReasons ?? []),
          "content-absent",
        ];
      }
    }

    const fromGit = blobs ? createEntryReader({ blobs, presign: null, deadlineAt }) : null;
    const fromDisk = createLocalReader(readable);
    const ctx = createContext({
      fileConcurrency: 16,
      // At most 2 MAT/EEGLAB, HDF5 or ZIP files at once on the depositor's machine (risk R15).
      readerClassLimits: LOCAL_READER_CLASS_LIMITS,
      workerConcurrency: 1,
      limits: { ...LOCAL_SCAN_LIMITS },
      // A scan of given entries never fetches a manifest or a token. If it ever did, these make
      // it fail here rather than reach a network.
      githubToken: async () => null,
      readVersionManifest: async () => {
        throw new ReadFailure("unreadable-entry");
      },
      sleep: async () => undefined,
      readEntryHead: async (entry, n, readOptions) => {
        if (entry.url.startsWith("git:")) {
          if (!fromGit) throw new ReadFailure("blob-closed");
          return fromGit(entry, n, readOptions);
        }
        if (readable.has(entry.url)) return fromDisk(entry, n, readOptions);
        if (unreadable.has(entry.url)) throw new ReadFailure("unreadable-entry");
        if (entry.url.startsWith("annex:")) {
          // A recording is `content-absent`; any other file is one that could not be opened.
          throw new ReadFailure(
            readerForEntry(entry, readers) ? CONTENT_ABSENT : "unreadable-entry",
          );
        }
        throw new ReadFailure("unreadable-entry");
      },
    });
    const record = await scanDatasetFromManifest(
      ctx,
      LOCAL_DATASET_ID,
      null,
      entries,
      "clone",
      extras,
    );
    const report = finalizeScanReport(
      foldOddFailures(foldOddFormats(record)),
      scanner.id,
      head ?? NULL_OID,
    );
    const scan = report.scan;
    if (!scan || report.scanner === null) throw new LocalScreenError("report-refused");
    return {
      report,
      status: scan.status,
      scannerId: report.scanner,
      source: options.committed ? "committed" : "working-tree",
      commit: head,
      history: head !== null,
      supersededNotRead,
      scannerKind: scanner.kind,
    };
  } finally {
    await blobs?.close().catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------------------

/** The local run's own lines: what this run read, and what it could not see. */
export function localNotRead(result: LocalScreen): { banner: string; copies: Copy[] } {
  const copies: Copy[] = [LOCAL_COPY.server];
  if (result.history) {
    copies.unshift(result.source === "committed" ? LOCAL_COPY.committed : LOCAL_COPY.workingTree);
  } else {
    copies.push(LOCAL_COPY.noHistory);
  }
  if (result.supersededNotRead > 0)
    copies.push(LOCAL_COPY.supersededAbsent(result.supersededNotRead));
  return { banner: LOCAL_COPY.banner(result.source, result.commit, version), copies };
}

/** The terminal text of a local screen: the report as the server words it, then what was not read. */
export function renderLocalScreen(result: LocalScreen): { head: string[]; body: string[] } {
  const description = describeScreen(result.status, result.report);
  // With no commit the report carries the null object id: its "commit" line would say nothing.
  const noCommit = result.commit === null;
  const lines = noCommit
    ? description.lines.filter((l) => !l.startsWith(`Scanner ${result.scannerId};`))
    : description.lines;
  const { banner, copies } = localNotRead(result);
  const own = copies.flatMap((copy) => [copy.statement, ...remedyLines(copy)]);
  return {
    head: [banner],
    body: identifierScreenLines(
      {
        state: result.status,
        ...description,
        lines: [...lines, LOCAL_COPY.scannerKind(result.scannerKind, result.scannerId), ...own],
      },
      0,
    ),
  };
}

/**
 * The action of `nemar dataset screen`. Prints the report (or, with `--json`, the report alone) and
 * sets the exit code: 0 clear, 3 direct identifiers, 2 everything else.
 */
export async function runDatasetScreen(
  path: string,
  options: { json?: boolean; committed?: boolean },
): Promise<void> {
  let result: LocalScreen;
  try {
    result = await screenLocalDataset(path, { committed: options.committed === true });
  } catch (error) {
    console.error(localErrorSentence(error));
    markReportedExit();
    process.exitCode = 2;
    return;
  }
  const { head, body } = renderLocalScreen(result);
  if (options.json) {
    // The report alone on stdout, for a script; what this run could not see goes to stderr.
    console.log(JSON.stringify(result.report, null, 2));
    for (const line of [...head, ...body]) console.error(line);
  } else {
    for (const line of [...head, ...body]) console.log(line);
  }
  const code = exitCodeFor(result.status);
  if (code !== 0) markReportedExit();
  process.exitCode = code;
}

// ---------------------------------------------------------------------------------------
// Commands that never reach the network
// ---------------------------------------------------------------------------------------

const localOnly = new WeakSet<Command>();

/** Mark a command as one that sends nothing: the root hook then skips its notices request. */
export function markLocalOnly(command: Command): Command {
  localOnly.add(command);
  return command;
}

/** True for a command marked by {@link markLocalOnly}. */
export function isLocalOnlyCommand(command: Command): boolean {
  return localOnly.has(command);
}

/**
 * True when `argv` (user arguments) addresses a command marked by {@link markLocalOnly}. The CLI
 * asks it before Commander parses anything, because the update check (a blocking fetch, a cache
 * write and a background refresh) runs before any command does. The walk is the moved-command
 * walk: it skips every "-" token and descends while a word names a subcommand (or an alias), and
 * stops at "--" or at a command with no subcommands, where the rest are its arguments.
 */
export function isLocalOnlyInvocation(program: Command, argv: readonly string[]): boolean {
  let current = program;
  const end = argv.indexOf("--") < 0 ? argv.length : argv.indexOf("--");
  for (let i = 0; i < end && current.commands.length > 0; i++) {
    const word = argv[i] as string;
    if (word.startsWith("-")) continue;
    const next = current.commands.find((c) => c.name() === word || c.aliases().includes(word));
    if (!next) return false;
    current = next;
  }
  return localOnly.has(current);
}
