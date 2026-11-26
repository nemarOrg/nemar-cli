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
 * WHAT IT DOES NOT READ, AND SAYS SO. The server's own copy (storage, its version manifest,
 * branches pushed there), the content of annexed files that are not on this machine (a recording
 * is then `partial` with reason `content-absent`), recordings of earlier commits whose content is
 * not here (counted and named, never read as clean), and, in the working-tree mode, the committed
 * tree. `LOCAL_COPY` holds those sentences.
 *
 * NON-MUTATING. No network, no git write, no file write. Every git command is a read (`rev-parse`,
 * `ls-tree`, `log`, `cat-file`) run with no user or system configuration, no optional lock and no
 * lazy fetch, so a partial clone's missing blob is "missing", never a hidden download. git-annex is
 * not run at all (it can auto-initialize a repository); the annex object store is read directly.
 *
 * NOTHING PRINTED NAMES ANYTHING: kinds, counts and fixed words only, as on the server.
 */

import { createHash } from "node:crypto";
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
import { readerForEntry } from "../../shared/identifier-report-builder.js";
import { type Copy, remedyLines } from "../../shared/identifier-screen-copy.js";
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
// Words
// ---------------------------------------------------------------------------------------

/** The docs section that explains what a local run does and does not read. */
const LOCAL_ANCHOR = "local-run";

const local = (statement: string, read: string, remedy: string): Copy => ({
  statement,
  read,
  remedy,
  anchor: LOCAL_ANCHOR,
});

/**
 * Every sentence only the local run says, declared once (ADR 0045). The statements name counts and
 * fixed words, never a path or a value.
 */
export const LOCAL_COPY = {
  /** The first line: which tree was read, the commit it names, and who read it. */
  banner: (source: "working-tree" | "committed", commit: string | null, cliVersion: string) =>
    `Local identifier screen of ${source === "committed" ? "the committed tree (HEAD)" : "the working tree, as the files are now"}; commit ${commit ? commit.slice(0, 12) : "none (no git history here)"}. Nothing was sent and nothing was changed (nemar-cli ${cliVersion}).`,
  /** What the server's copy holds that this run cannot see. */
  server: local(
    "Not read here: the server's copy of the dataset (its stored files, its version manifest and the branches pushed there), so the screen run on the server can differ from this one.",
    "this machine's files and git history only",
    "Request publication, or run 'nemar dataset publish status <id>', to see the server's own screen.",
  ),
  /** The working-tree mode, in a repository. */
  workingTree: local(
    "This run read the working tree; the server reads the committed tree, so a change that is not committed is read here and not there.",
    "the files in this directory as they are now",
    "Run with --committed to read what the server reads.",
  ),
  /** The committed mode. */
  committed: local(
    "This run read the committed tree (HEAD); a change that is not committed was not read.",
    "the tree of the HEAD commit",
    "Commit the change, or run without --committed to read the files as they are now.",
  ),
  /** No repository, or not its top level: no history. */
  noHistory: local(
    "Earlier commits were not read: this directory is not the top level of a readable git repository, so there is no history here, and the server screens every earlier path and recording.",
    "nothing of earlier commits",
    "Run the command at the top level of the dataset's repository to read its history too.",
  ),
  /** Recordings of earlier commits whose content is not on this machine. */
  supersededAbsent: (count: number) =>
    local(
      `${count} recording${count === 1 ? "" : "s"} from earlier commits ${count === 1 ? "has" : "have"} no content on this machine, so ${count === 1 ? "it was" : "they were"} not read; the server reads ${count === 1 ? "it" : "them"} from storage.`,
      "the paths of earlier commits only",
      "Fetch the old content (git annex get --all) and run the screen again, or leave it to the server's screen.",
    ),
} as const;

// ---------------------------------------------------------------------------------------
// Errors and exit codes
// ---------------------------------------------------------------------------------------

/** Why no screen could be made, as a fixed word with its sentence. Never a path. */
export const LOCAL_ERRORS = {
  "not-a-directory": "The path is not a directory.",
  "not-a-repository": "--committed needs the top level of a git repository, and this is not one.",
  "no-commit": "--committed needs a commit, and this repository has none yet.",
  "git-failed": "git could not list the commit's files.",
  "report-refused":
    "The scan did not fit the report contract, so no verdict was made. Please report this: https://github.com/nemarOrg/nemar-cli/issues",
} as const;
export type LocalErrorCode = keyof typeof LOCAL_ERRORS;

export class LocalScreenError extends Error {
  readonly code: LocalErrorCode;
  constructor(code: LocalErrorCode) {
    super(code);
    this.name = "LocalScreenError";
    this.code = code;
  }
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
  };
}

/** The stdout of a git read, or null when git failed or could not start. stderr is discarded. */
async function gitText(root: string, args: readonly string[]): Promise<string | null> {
  try {
    const proc = Bun.spawn(["git", "-C", root, ...args], {
      env: gitEnv(),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    const [text, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return code === 0 ? text.trim() : null;
  } catch {
    return null;
  }
}

interface Repository {
  /** The shared git directory, where `annex/objects` lives (a linked worktree shares it). */
  commonDir: string;
  /** The commit `HEAD` names, or null in a repository with none yet. */
  head: string | null;
}

/** The repository whose top level is `root`, or null when `root` is not one. */
async function repositoryAt(root: string): Promise<Repository | null> {
  const top = await gitText(root, ["rev-parse", "--show-toplevel"]);
  if (top === null || top === "") return null;
  try {
    if (realpathSync(top) !== realpathSync(root)) return null;
  } catch {
    return null;
  }
  const common = await gitText(root, ["rev-parse", "--git-common-dir"]);
  if (common === null || common === "") return null;
  const head = await gitText(root, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  return {
    commonDir: resolve(root, common),
    head: head !== null && /^[0-9a-f]{40}$/.test(head) ? head : null,
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
export class AnnexObjects {
  private index: Map<string, string> | null = null;
  constructor(private readonly gitDir: string | null) {}

  private build(): Map<string, string> {
    const index = new Map<string, string>();
    if (!this.gitDir) return index;
    const root = join(this.gitDir, "annex", "objects");
    const list = (dir: string): string[] => {
      try {
        return readdirSync(dir);
      } catch {
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

  /** The content file of `key`, when it is on this machine. */
  find(key: string): string | null {
    this.index ??= this.build();
    const path = this.index.get(key);
    if (!path) return null;
    try {
      return statSync(path).isFile() ? path : null;
    } catch {
      return null;
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
): Promise<{ entries: ManifestEntry[]; unlisted: number }> {
  const walked = walkDatasetTree(root);
  const annexed = (entry: ManifestEntry, key: string, size: number): void => {
    const found = objects.find(key);
    const url = `annex:${key}`;
    entry.url = url;
    entry.size = declaredSize({ key, size });
    Object.assign(entry, hintFor(key));
    if (found) readable.set(url, found);
  };
  for (const [url, path] of walked.readable) readable.set(url, path);
  await mapPool(walked.entries, 16, async (entry) => {
    const absolute = join(root, entry.path);
    let symlink = false;
    try {
      symlink = lstatSync(absolute).isSymbolicLink();
    } catch {
      return;
    }
    if (symlink) {
      let target: string;
      try {
        target = readlinkSync(absolute);
      } catch {
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
 * `identifier-scan@<revision>`: the revision of the checkout this code runs from, as the
 * publication screen names it. A packaged CLI has no checkout, so it is named by a digest of its
 * own version, which says which build ran and is never mistaken for a commit of the repository.
 */
export async function localScannerId(): Promise<string> {
  const here = import.meta.dir;
  if (basename(here) === "lib" && basename(dirname(here)) === "src") {
    const root = dirname(dirname(here));
    if (existsSync(join(root, ".git"))) {
      const rev = await gitText(root, ["rev-parse", "--short=7", "HEAD"]);
      if (rev !== null && /^[0-9a-f]{7,40}$/.test(rev)) return `identifier-scan@${rev}`;
    }
  }
  const digest = createHash("sha256").update(`nemar-cli@${version}`).digest("hex").slice(0, 12);
  return `identifier-scan@${digest}`;
}

export interface LocalScreen {
  report: ScreenReport;
  source: "working-tree" | "committed";
  /** The commit named: `HEAD` of a repository, null with no repository. */
  commit: string | null;
  /** Whether the directory is the top level of a repository whose history was walked. */
  history: boolean;
  /** Recordings of earlier commits whose content is not on this machine. */
  supersededNotRead: number;
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
  const repository = await repositoryAt(root);
  if (options.committed && !repository) throw new LocalScreenError("not-a-repository");
  if (options.committed && !repository?.head) throw new LocalScreenError("no-commit");
  const head = repository?.head ?? null;
  const deadlineAt = Date.now() + LOCAL_DEADLINE_MS;
  const scannerId = await localScannerId();
  const readers = (options.readers ?? READERS).map(absenceAware);
  const objects = new AnnexObjects(repository?.commonDir ?? null);
  const readable = new Map<string, string>();
  let blobs: GitBlobReader | null = null;
  try {
    // HEAD's tree: the committed mode's entries, and in both modes what "superseded" is measured
    // against.
    let headTree: ResolvedTree | null = null;
    let tree: Tree | null = null;
    let treeOids = new Set<string>();
    if (head) {
      tree = await listTree(root, head);
      if (!tree) throw new LocalScreenError("git-failed");
      treeOids = new Set(tree.entries.map((t) => t.oid));
      const sizes = await objectSizes(root, [...treeOids]);
      if (!sizes) throw new LocalScreenError("git-failed");
      blobs = new GitBlobReader(root);
      headTree = await resolveEntries(tree.entries, sizes, blobs);
    }

    let entries: ManifestEntry[];
    let unlisted = 0;
    if (options.committed) {
      entries = (headTree as ResolvedTree).entries;
    } else {
      ({ entries, unlisted } = await workingTreeEntries(root, objects, readable));
    }
    for (const entry of entries) {
      if (!entry.url.startsWith("annex:") || readable.has(entry.url)) continue;
      const found = objects.find(entry.url.slice(6));
      if (found) readable.set(entry.url, found);
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
          const found = objects.find(entry.url.slice(6));
          if (found) {
            readable.set(entry.url, found);
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
    }

    const fromGit = blobs ? createEntryReader({ blobs, presign: null, deadlineAt }) : null;
    const fromDisk = createLocalReader(readable);
    const ctx = createContext({
      fileConcurrency: 16,
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
      scannerId,
      head ?? NULL_OID,
    );
    if (!report.scan) throw new LocalScreenError("report-refused");
    return {
      report,
      source: options.committed ? "committed" : "working-tree",
      commit: head,
      history: head !== null,
      supersededNotRead,
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
  const scan = result.report.scan;
  if (!scan) throw new LocalScreenError("report-refused");
  const description = describeScreen(scan.status, result.report);
  // With no commit the report carries the null object id: its "commit" line would say nothing.
  const noCommit = result.commit === null;
  const lines = noCommit
    ? description.lines.filter((l) => !l.startsWith(`Scanner ${result.report.scanner};`))
    : description.lines;
  const { banner, copies } = localNotRead(result);
  const own = copies.flatMap((copy) => [copy.statement, ...remedyLines(copy)]);
  return {
    head: [banner],
    body: identifierScreenLines(
      { state: scan.status, ...description, lines: [...lines, ...own] },
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
    const code = error instanceof LocalScreenError ? error.code : null;
    console.error(
      code
        ? LOCAL_ERRORS[code]
        : "The screen could not be made. Please report this: https://github.com/nemarOrg/nemar-cli/issues",
    );
    markReportedExit();
    process.exitCode = 2;
    return;
  }
  const status = (result.report.scan as { status: DatasetStatus }).status;
  const { head, body } = renderLocalScreen(result);
  if (options.json) {
    // The report alone on stdout, for a script; what this run could not see goes to stderr.
    console.log(JSON.stringify(result.report, null, 2));
    for (const line of [...head, ...body]) console.error(line);
  } else {
    for (const line of [...head, ...body]) console.log(line);
  }
  const code = exitCodeFor(status);
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
