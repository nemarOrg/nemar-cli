/**
 * Packing a job's code into ONE deterministic `bundle.tar.gz` and its `bundle-manifest.json` (epic #2021
 * phase D3b, #2024; ADR 0118 and the amendment of phase D3).
 *
 * THE CAPS ARE THE WORKER'S. Every number comes from `shared/contract/compute-bundle.ts` and the one rule
 * for what a manifest may hold is its `checkBundleManifest`: this file declares no limit of its own. A
 * bundle the Worker would refuse is refused here first, with the Worker's word and sentence
 * (`COMPUTE_SUBMIT_SENTENCES`), before any request; `test/compute-pack.unit.test.ts` holds the two sides
 * together.
 *
 * WHAT GOES IN. A folder's regular files, except: `.git`, caches (`__pycache__`, `.pytest_cache`, ...),
 * virtual environments (a folder with a `pyvenv.cfg`, or named `.venv` or `venv`), `node_modules`,
 * editor and operating-system droppings, anything a `.nemarignore` names, SYMLINKS and special files
 * (the launcher refuses a link, so one is left out and counted, never followed), and any file over the
 * per-file cap (left out and listed: data belongs in a dataset, not in the code). Everything left out is
 * counted in `skipped`, so the command can say so.
 *
 * WHAT THE ARCHIVE IS. A ustar archive of regular files and directories only, gzip-compressed with
 * `Bun.gzipSync` (no dependency; Python 3.9's `tarfile` reads it). The same input makes the same bytes:
 * entries sorted by name (UTF-8 byte order), owner and group zero and unnamed, times zero, mode 0644 or
 * 0755 (the executable bit survives: an image job runs `/code/<entry>` directly), and the gzip header's
 * time and operating-system bytes written as zero and 255. The archive's SHA-256 is of the compressed
 * file, which is what the specification's `bundle` and the launcher compare.
 *
 * WHAT IS REFUSED. Not an error of the person's making here but the Worker's own rules, applied early:
 * a path the contract refuses (control character, backslash, traversal, over 240 characters, a percent
 * encoding that decodes to one), more files than the cap, a running total over the cap, an entry that is
 * not in the bundle, or an archive over the cap. A refusal that is about SIZE names the five largest files.
 */

import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import {
  BUNDLE_ARCHIVE_FILE,
  BUNDLE_DEFAULT_LIMITS,
  BUNDLE_PATH_MAX,
  type BundleLimits,
  type BundleManifestRefusal,
  checkBundleManifest,
} from "../../../shared/contract/compute-bundle.js";
import { COMPUTE_SUBMIT_SENTENCES } from "../../../shared/contract/compute-submit.js";
import { COMPUTE_DOT_SEGMENT_RE } from "../../../shared/contract/compute.js";

export { BUNDLE_ARCHIVE_FILE };

// --- What is always left out ---------------------------------------------------------------------

/** Folders never packed, by name, wherever they are. */
export const SKIPPED_DIRECTORY_NAMES: readonly string[] = [
  ".git",
  "node_modules",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".ipynb_checkpoints",
  ".tox",
  ".nox",
  ".eggs",
  ".venv",
  "venv",
];

/** Files never packed, by name. `.git` as a FILE is a worktree's pointer. */
export const SKIPPED_FILE_NAMES: readonly string[] = [".git", ".DS_Store", "Thumbs.db"];

/** Files never packed, by extension. */
export const SKIPPED_FILE_SUFFIXES: readonly string[] = [".pyc", ".pyo"];

/** The ignore file a folder may carry. */
export const IGNORE_FILE = ".nemarignore";

// --- .nemarignore ----------------------------------------------------------------------------------

export interface IgnoreRule {
  line: number;
  dirOnly: boolean;
  anchored: boolean;
  regex: RegExp;
}

export type IgnoreParse = { ok: true; rules: IgnoreRule[] } | { ok: false; problems: string[] };

const IGNORE_MAX_LINES = 1000;
const IGNORE_MAX_PATTERN = 200;

function globToRegexSource(pattern: string): string {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i] as string;
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        // `**/` is zero or more directories; any other `**` is any run of characters.
        if (pattern[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else {
        out += "[^/]*";
      }
    } else if (ch === "?") {
      out += "[^/]";
    } else {
      out += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return out;
}

/**
 * `.nemarignore`, a small subset of gitignore: one pattern a line, `#` comments, blank lines; `*` and `?`
 * stay inside a path segment and `**` crosses them; a trailing `/` matches folders only; a pattern with a
 * `/` in it (or a leading one) is matched from the folder root and any other against a name at any depth.
 * Negation (`!`) and classes are not supported and are errors naming the line, so no file is ever left in
 * (or out) on a guess.
 */
export function parseIgnore(text: string): IgnoreParse {
  const problems: string[] = [];
  const rules: IgnoreRule[] = [];
  const lines = text.split(/\r?\n/);
  if (lines.length > IGNORE_MAX_LINES) {
    return { ok: false, problems: [`${IGNORE_FILE}: more than ${IGNORE_MAX_LINES} lines`] };
  }
  lines.forEach((raw, index) => {
    const line = index + 1;
    const trimmed = raw.trim();
    if (trimmed === "" || trimmed.startsWith("#")) return;
    if (trimmed.startsWith("!")) {
      problems.push(`${IGNORE_FILE}:${line}: a pattern cannot start with ! (no negation)`);
      return;
    }
    if (trimmed.length > IGNORE_MAX_PATTERN || trimmed.includes("[") || trimmed.includes("\\")) {
      problems.push(
        `${IGNORE_FILE}:${line}: a pattern is at most ${IGNORE_MAX_PATTERN} characters with no [ ] classes or backslash`,
      );
      return;
    }
    let pattern = trimmed;
    const dirOnly = pattern.endsWith("/");
    if (dirOnly) pattern = pattern.slice(0, -1);
    const anchored = pattern.startsWith("/") || pattern.includes("/");
    if (pattern.startsWith("/")) pattern = pattern.slice(1);
    if (pattern === "") {
      problems.push(`${IGNORE_FILE}:${line}: this pattern names nothing`);
      return;
    }
    rules.push({
      line,
      dirOnly,
      anchored,
      regex: new RegExp(`^${globToRegexSource(pattern)}$`),
    });
  });
  return problems.length > 0 ? { ok: false, problems } : { ok: true, rules };
}

/** Whether a rule names the entry at `rel` (a folder or a file). */
function ignored(rules: readonly IgnoreRule[], rel: string, isDir: boolean): boolean {
  const name = rel.slice(rel.lastIndexOf("/") + 1);
  return rules.some((rule) => {
    if (rule.dirOnly && !isDir) return false;
    return rule.regex.test(rule.anchored ? rel : name);
  });
}

// --- A path that cannot be read -----------------------------------------------------------------------

/**
 * A file or folder of the target that cannot be read (permission, or it vanished since it was listed).
 * `path` is RELATIVE to the folder, never the absolute path, so what is said names the person's own file
 * and nothing else about this machine. The command turns it into a local refusal (exit 2).
 */
export class UnreadablePath extends Error {
  constructor(public readonly path: string) {
    super("a path cannot be read");
    this.name = "UnreadablePath";
  }
}

function reading<T>(rel: string, read: () => T): T {
  try {
    return read();
  } catch {
    throw new UnreadablePath(rel === "" ? "." : rel);
  }
}

// --- Collecting -------------------------------------------------------------------------------------

export interface CollectedFile {
  /** The path inside the archive: relative, `/`-separated. */
  path: string;
  /** Where it is on disk. */
  abs: string;
  size: number;
  executable: boolean;
}

/** What was left out, for the command to say. Lists are bounded: they name the first few. */
export interface Skipped {
  symlinks: number;
  special: number;
  ignored: number;
  directories: number;
  tooLarge: Array<{ path: string; size: number }>;
}

export interface CollectOptions {
  limits?: BundleLimits;
}

export interface Collected {
  files: CollectedFile[];
  skipped: Skipped;
  /** The walk stopped after the file cap: there are more files than the cap, and the count is not known. */
  overFileCap: boolean;
}

const emptySkipped = (): Skipped => ({
  symlinks: 0,
  special: 0,
  ignored: 0,
  directories: 0,
  tooLarge: [],
});

const byteCompare = (a: string, b: string): number =>
  Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));

/**
 * The files of a folder that go in the bundle, sorted. `problems` is non-empty when the folder's
 * `.nemarignore` could not be read (nothing is collected then).
 */
export function collectFolder(
  root: string,
  options: CollectOptions = {},
): { ok: true; collected: Collected } | { ok: false; problems: string[] } {
  const limits = options.limits ?? BUNDLE_DEFAULT_LIMITS;
  let rules: readonly IgnoreRule[] = [];
  const ignorePath = join(root, IGNORE_FILE);
  if (existsSync(ignorePath) && statSync(ignorePath).isFile()) {
    const parsed = parseIgnore(reading(IGNORE_FILE, () => readFileSync(ignorePath, "utf8")));
    if (!parsed.ok) return { ok: false, problems: parsed.problems };
    rules = parsed.rules;
  }
  const files: CollectedFile[] = [];
  const skipped = emptySkipped();
  let overFileCap = false;

  const walk = (dirAbs: string, prefix: string): void => {
    const entries = reading(prefix, () => readdirSync(dirAbs, { withFileTypes: true })).sort(
      (a, b) => byteCompare(a.name, b.name),
    );
    for (const entry of entries) {
      if (overFileCap) return;
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      const abs = join(dirAbs, entry.name);
      if (entry.isSymbolicLink()) {
        skipped.symlinks++;
        continue;
      }
      if (entry.isDirectory()) {
        if (
          SKIPPED_DIRECTORY_NAMES.includes(entry.name) ||
          existsSync(join(abs, "pyvenv.cfg")) ||
          ignored(rules, rel, true)
        ) {
          skipped.directories++;
          continue;
        }
        walk(abs, rel);
        continue;
      }
      if (!entry.isFile()) {
        skipped.special++;
        continue;
      }
      if (
        SKIPPED_FILE_NAMES.includes(entry.name) ||
        SKIPPED_FILE_SUFFIXES.some((s) => entry.name.endsWith(s)) ||
        ignored(rules, rel, false)
      ) {
        skipped.ignored++;
        continue;
      }
      const st = reading(rel, () => lstatSync(abs));
      if (st.size > limits.maxFileBytes) {
        skipped.tooLarge.push({ path: rel, size: st.size });
        continue;
      }
      files.push({ path: rel, abs, size: st.size, executable: (st.mode & 0o111) !== 0 });
      if (files.length > limits.maxFiles) overFileCap = true;
    }
  };
  walk(root, "");
  files.sort((a, b) => byteCompare(a.path, b.path));
  return { ok: true, collected: { files, skipped, overFileCap } };
}

/** The one file a person named: the bundle is that file alone, under its own name. */
export function collectFile(file: string, options: CollectOptions = {}): Collected {
  const limits = options.limits ?? BUNDLE_DEFAULT_LIMITS;
  const name = basename(file);
  const st = reading(name, () => statSync(file));
  const skipped = emptySkipped();
  if (st.size > limits.maxFileBytes) {
    skipped.tooLarge.push({ path: name, size: st.size });
    return { files: [], skipped, overFileCap: false };
  }
  return {
    files: [{ path: name, abs: file, size: st.size, executable: (st.mode & 0o111) !== 0 }],
    skipped,
    overFileCap: false,
  };
}

// --- Refusals -----------------------------------------------------------------------------------------

export type PackRefusalCode =
  | "bundle_too_large"
  | "bundle_too_many_files"
  | "entry_not_in_bundle"
  | "invalid_spec"
  | "empty_bundle";

export interface PackRefusal {
  code: PackRefusalCode;
  /** The Worker's sentence for the word (`COMPUTE_SUBMIT_SENTENCES`), or ours for `empty_bundle`. */
  message: string;
  /** For `invalid_spec`: the path that cannot be sent. */
  path?: string;
  /** For a size refusal: the five largest files and their sizes. */
  largest?: Array<{ path: string; size: number }>;
}

const LARGEST = 5;

function largestOf(files: ReadonlyArray<{ path: string; size: number }>): PackRefusal["largest"] {
  return [...files]
    .sort((a, b) => b.size - a.size || byteCompare(a.path, b.path))
    .slice(0, LARGEST)
    .map((f) => ({ path: f.path, size: f.size }));
}

const PLACEHOLDER_SHA256 = "0".repeat(64);

function hasControlCharacter(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** A percent-encoded `..` or `/` the records bucket would decode: refused here as it is there. */
function hidesTraversal(path: string): boolean {
  let current = path;
  for (let layer = 0; layer < 2; layer++) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(current);
    } catch {
      return false;
    }
    if (decoded === current) return false;
    if (decoded.startsWith("/") || decoded.includes("\\") || hasControlCharacter(decoded)) {
      return true;
    }
    if (COMPUTE_DOT_SEGMENT_RE.test(decoded)) return true;
    current = decoded;
  }
  return false;
}

/**
 * The Worker's own check of a bundle, applied to the files found and BEFORE a byte is read: the same
 * `checkBundleManifest` with the same limits (digests are placeholders, which the rule checks only for
 * shape). Returns null when the Worker would take it as far as the manifest goes.
 */
export function refuseCollected(
  collected: Collected,
  options: { entry?: string; limits?: BundleLimits } = {},
): PackRefusal | null {
  const limits = options.limits ?? BUNDLE_DEFAULT_LIMITS;
  const { files } = collected;
  if (files.length === 0) {
    const big = collected.skipped.tooLarge;
    return {
      code: "empty_bundle",
      message:
        big.length > 0
          ? "Every file is over the per-file size limit, so there is nothing to send."
          : "There are no files to send.",
      ...(big.length > 0 ? { largest: largestOf(big) } : {}),
    };
  }
  for (const f of files) {
    if (hidesTraversal(f.path)) {
      return { code: "invalid_spec", message: "A file path cannot be sent.", path: f.path };
    }
  }
  const verdict = checkBundleManifest(
    files.map((f) => ({ path: f.path, size: f.size, sha256: PLACEHOLDER_SHA256 })),
    limits,
    options.entry,
  );
  return verdict.ok ? null : fromVerdict(verdict, files);
}

function fromVerdict(
  verdict: BundleManifestRefusal,
  files: ReadonlyArray<{ path: string; size: number }>,
): PackRefusal {
  if (verdict.code === "invalid_spec") {
    const index = /^files\.(\d+)/.exec(verdict.field)?.[1];
    const path = index === undefined ? undefined : files[Number(index)]?.path;
    return {
      code: "invalid_spec",
      message:
        path === undefined
          ? "The list of files is not valid."
          : `A file path cannot be sent: it is empty, over ${BUNDLE_PATH_MAX} characters, holds a backslash or a control character, or is a .. path.`,
      ...(path === undefined ? {} : { path }),
    };
  }
  const base = { code: verdict.code, message: COMPUTE_SUBMIT_SENTENCES[verdict.code] };
  return verdict.code === "entry_not_in_bundle" ? base : { ...base, largest: largestOf(files) };
}

// --- The archive ------------------------------------------------------------------------------------

const BLOCK = 512;
const encoder = new TextEncoder();

function octal(value: number, width: number): Uint8Array {
  // `width` bytes: digits, zero padded, then a NUL.
  const text = value.toString(8).padStart(width - 1, "0");
  if (text.length > width - 1) throw new RangeError("a tar field overflowed");
  return encoder.encode(`${text}\0`);
}

/** Splits a name over the ustar `prefix` and `name` fields, or null when it fits neither. */
function splitName(name: string): { prefix: Uint8Array; name: Uint8Array } | null {
  const bytes = encoder.encode(name);
  if (bytes.length <= 100) return { prefix: new Uint8Array(0), name: bytes };
  // The first `/` that leaves a name of at most 100 bytes and a prefix of at most 155.
  for (let i = 0; i < bytes.length - 1; i++) {
    if (bytes[i] !== 0x2f) continue;
    const rest = bytes.length - i - 1;
    if (rest >= 1 && rest <= 100 && i <= 155) {
      return { prefix: bytes.subarray(0, i), name: bytes.subarray(i + 1) };
    }
  }
  return null;
}

function header(
  name: string,
  kind: "file" | "dir",
  size: number,
  executable: boolean,
): Uint8Array | null {
  const parts = splitName(name);
  if (parts === null) return null;
  const block = new Uint8Array(BLOCK);
  const put = (offset: number, bytes: Uint8Array) => block.set(bytes, offset);
  put(0, parts.name);
  put(100, octal(kind === "dir" || executable ? 0o755 : 0o644, 8));
  put(108, octal(0, 8));
  put(116, octal(0, 8));
  put(124, octal(kind === "dir" ? 0 : size, 12));
  put(136, octal(0, 12));
  block.fill(0x20, 148, 156); // the checksum is summed over spaces
  block[156] = kind === "dir" ? 0x35 : 0x30;
  put(257, encoder.encode("ustar\0"));
  put(263, encoder.encode("00"));
  put(345, parts.prefix);
  let sum = 0;
  for (const byte of block) sum += byte;
  put(148, encoder.encode(`${sum.toString(8).padStart(6, "0")}\0 `));
  return block;
}

interface TarItem {
  path: string;
  dir: boolean;
  file?: CollectedFile;
}

/** Every folder that holds a packed file, then the files, sorted by name so the parent comes first. */
function tarItems(files: readonly CollectedFile[]): TarItem[] {
  const dirs = new Set<string>();
  for (const f of files) {
    const parts = f.path.split("/");
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
  }
  const items: TarItem[] = [
    ...[...dirs].map((path) => ({ path, dir: true })),
    ...files.map((file) => ({ path: file.path, dir: false, file })),
  ];
  return items.sort((a, b) => byteCompare(a.path, b.path));
}

/** gzip with the header's modification time and operating-system byte fixed, so the bytes do not depend on when or where. */
export function gzipDeterministic(data: Uint8Array): Uint8Array {
  const out = new Uint8Array(Bun.gzipSync(Buffer.from(data), { level: 9 }));
  out.fill(0, 4, 8);
  out[9] = 0xff;
  return out;
}

export interface PackedBundle {
  archive: Uint8Array;
  /** The archive's size in bytes and the SHA-256 (lowercase hex) of the archive itself. */
  size: number;
  sha256: string;
  manifest: { files: Array<{ path: string; size: number; sha256: string }> };
  /** The sum of the sizes of the files inside, uncompressed. */
  contentBytes: number;
}

const sha256Hex = (bytes: Uint8Array | string): string =>
  createHash("sha256")
    .update(
      typeof bytes === "string"
        ? bytes
        : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    )
    .digest("hex");

export type PackResult =
  | { ok: true; bundle: PackedBundle }
  | { ok: false; reason: "refused"; refusal: PackRefusal }
  /** The caller's inspection of the bytes found something: no archive was made. */
  | { ok: false; reason: "inspected"; inspected: number };

export interface PackOptions {
  entry?: string;
  limits?: BundleLimits;
  /**
   * Called once with every file's path and bytes, in order, as they are read; returns how many problems it
   * found. If any, no archive is made. The secret scan uses this, so it looks at the exact bytes packed.
   */
  inspect?: (path: string, bytes: Uint8Array) => number;
}

/**
 * Reads the files, checks the whole against the Worker's rule once more with the real digests, and makes
 * the archive. Order of events: the collected list is judged first (no byte read); then each file is read
 * once, hashed and shown to `inspect`; then the manifest is judged; then the archive is built and its size
 * judged.
 */
export function packCollected(collected: Collected, options: PackOptions = {}): PackResult {
  const limits = options.limits ?? BUNDLE_DEFAULT_LIMITS;
  const early = refuseCollected(collected, {
    limits,
    ...(options.entry ? { entry: options.entry } : {}),
  });
  if (early !== null) return { ok: false, reason: "refused", refusal: early };

  const contents = new Map<string, Uint8Array>();
  const manifestFiles: PackedBundle["manifest"]["files"] = [];
  let inspected = 0;
  for (const file of collected.files) {
    const bytes = new Uint8Array(reading(file.path, () => readFileSync(file.abs)));
    // The file may have changed since it was listed: what is packed is what was read.
    if (options.inspect) inspected += options.inspect(file.path, bytes);
    contents.set(file.path, bytes);
    manifestFiles.push({ path: file.path, size: bytes.length, sha256: sha256Hex(bytes) });
  }
  if (inspected > 0) return { ok: false, reason: "inspected", inspected };

  const verdict = checkBundleManifest(manifestFiles, limits, options.entry);
  if (!verdict.ok)
    return { ok: false, reason: "refused", refusal: fromVerdict(verdict, manifestFiles) };

  const blocks: Uint8Array[] = [];
  for (const item of tarItems(collected.files)) {
    if (item.dir) {
      const h = header(`${item.path}/`, "dir", 0, true);
      if (h === null) {
        return {
          ok: false,
          reason: "refused",
          refusal: {
            code: "invalid_spec",
            message: "A folder path is too long for the archive.",
            path: item.path,
          },
        };
      }
      blocks.push(h);
      continue;
    }
    const file = item.file as CollectedFile;
    const bytes = contents.get(file.path) as Uint8Array;
    const h = header(file.path, "file", bytes.length, file.executable);
    if (h === null) {
      return {
        ok: false,
        reason: "refused",
        refusal: {
          code: "invalid_spec",
          message: "A file path is too long for the archive.",
          path: file.path,
        },
      };
    }
    blocks.push(h, bytes);
    const pad = (BLOCK - (bytes.length % BLOCK)) % BLOCK;
    if (pad > 0) blocks.push(new Uint8Array(pad));
  }
  blocks.push(new Uint8Array(BLOCK * 2));
  const tar = new Uint8Array(blocks.reduce((n, b) => n + b.length, 0));
  let at = 0;
  for (const b of blocks) {
    tar.set(b, at);
    at += b.length;
  }
  const archive = gzipDeterministic(tar);
  if (archive.length > limits.maxTotalBytes) {
    return {
      ok: false,
      reason: "refused",
      refusal: {
        code: "bundle_too_large",
        message: COMPUTE_SUBMIT_SENTENCES.bundle_too_large,
        largest: largestOf(manifestFiles),
      },
    };
  }
  return {
    ok: true,
    bundle: {
      archive,
      size: archive.length,
      sha256: sha256Hex(archive),
      manifest: { files: manifestFiles },
      contentBytes: manifestFiles.reduce((n, f) => n + f.size, 0),
    },
  };
}
