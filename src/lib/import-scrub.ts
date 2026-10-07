/**
 * The importer's identifier scrub (ADR 0089): the prepare phase scrubs a cloned OpenNeuro tree
 * with ADR 0085's rules before anything is copied or pushed, and the copy manifest is then cut to
 * what the scrubbed tree names.
 *
 * Why here. The copy phase is a server-side copy by upstream key (ADR 0010): it copies upstream's
 * bytes as they are, has no clone, and the bucket grants anonymous read on every dataset prefix it
 * does not list as private, so a recording the copy writes is readable by key before anyone looks.
 * Prepare is the one phase that holds a clone before the first push, and it already moves bytes from
 * the host under a bound (ADR 0060). So a recording whose header must change is downloaded here,
 * patched, annexed under a new key, uploaded from here, and its upstream key never reaches the copy.
 *
 * What it changes, and nothing else:
 *
 * - an EDF or BDF header that `scrubEdfHeader` changes (the rule ADR 0085's plan uses): bytes 8 to
 *   168 only, proven by `verifyScrub`, the new content annexed as SHA256E and uploaded with ADR 0060's
 *   location-log proof, the old key retired in the git-annex branch as ADR 0085's `annex-registry`
 *   retires one;
 * - a value under an identifier key in an inline JSON file (`blankIdentifierJsonKeys`);
 * - when headers were scrubbed, the provenance file's `privacy_correction` sentence and the note in
 *   its README (`shared/privacy-correction-text.ts`);
 * - one `import-scrubbed` ledger line, counts only, in `.nemar/corrections.jsonl`.
 *
 * Images and documents are counted and left for the identifier screen, which holds them for a person;
 * nothing here removes a file.
 *
 * **It fails closed.** Anything it cannot read, verify or move refuses with
 * {@link ImportScrubRefused}, before the caller pushes, so nothing it could not check is copied.
 *
 * **It prints nothing, and nothing it writes or throws names a path, a key or a value.** The import
 * runs in `nemarDatasets/.github`, whose Actions logs are public, and a path can be the identifier:
 * refusals, the ledger line and the commit message carry counts and fixed words, and any other error
 * is converted to a refusal that names only its class (`scrub-failed`, `upload-failed`). The result
 * holds keys and paths for the caller's own use; the caller prints only its counts.
 */

import { createHash } from "node:crypto";
import {
  closeSync,
  createReadStream,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ANNEX_KEY } from "../../scripts/scrub/contract.js";
import { annexRegistry, isDead, locationLogs } from "../../scripts/scrub/git/git-lib.js";
import { LEDGER_REPO_PATH, appendLedger, readLedger } from "../../scripts/scrub/ledger.js";
import { EDF_HEADER_BYTES, scanPaths } from "../../shared/identifier-scan.js";
import {
  JsonBlankUnverified,
  ScrubRefused,
  blankIdentifierJsonKeys,
  scrubEdfHeader,
  verifyScrub,
} from "../../shared/identifier-scrub.js";
import {
  PROVENANCE_NOTE_KEY,
  PROVENANCE_PATH,
  PROVENANCE_README_PATH,
  provenanceNote,
  provenanceReadmeNote,
} from "../../shared/privacy-correction-text.js";
import { chunkAddTargets } from "./git-annex/init.js";
import { runCommand } from "./git-annex/run-command.js";
import { listAnnexedKeys } from "./git-annex/transfer.js";
import { IMPORT_SCRUB_MARKER, OPENNEURO_UPSTREAM_MARKER } from "./import-markers.js";
import {
  NORMALIZE_MAX_BYTES,
  type NormalizeImportResult,
  type UploadStrategy,
  normalizeImportedTree,
  normalizeUnannexedData,
} from "./import-normalize.js";
import {
  type ImportManifestItem,
  type ImportPrivacyRecord,
  type S3Ref,
  annexKeyDeclaredSize,
  isLocallyUploaded,
  parseS3Url,
} from "./s3-server-copy.js";
import { scannerRulesDigest } from "./scanner-rules-digest.js" with { type: "macro" };
import { listTrackedPaths } from "./upload/transfer.js";

// ---------------------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------------------

/**
 * Why the scrub refused, from a closed list. Each is a word an operator can act on, and none says
 * which file: the line reaches a public log and the public import-failure tracker.
 */
export const IMPORT_SCRUB_REFUSALS = [
  /** Some recording header could not be read, from upstream or from the clone. */
  "header-unreadable",
  /** Upstream's object is not the size its annex key declares: what it serves is not the key. */
  "upstream-size-mismatch",
  /** The bytes this host must move (downloads plus git-held data) are over the bound. */
  "bound-exceeded",
  /** A downloaded recording does not hash to the key it was downloaded for. */
  "content-mismatch",
  /** A key to replace is not SHA256E, which ADR 0085's tools cannot follow. */
  "unsupported-key-backend",
  /** A re-import whose tree already names a recording that needs a scrub: ADR 0085's procedure. */
  "already-imported-unscrubbed",
  /** After the scrub, the tree still names a key the scrub replaced. */
  "old-key-still-named",
  /** The git-annex branch did not record a replaced key as dead, or the new key as present. */
  "retire-failed",
  /** A patched header or a blanked document could not be proven. */
  "scrub-unverified",
  /** The scrubbed recordings could not be annexed or uploaded from the host. */
  "upload-failed",
  /** Anything else went wrong inside the scrub; the detail is the error's class, never its text. */
  "scrub-failed",
] as const;
export type ImportScrubRefusal = (typeof IMPORT_SCRUB_REFUSALS)[number];

/** A refusal: a fixed word and counts, never a path, a key or a value. */
export class ImportScrubRefused extends Error {
  constructor(
    readonly code: ImportScrubRefusal,
    detail: string,
    /** Prefix the upstream marker: the failure is OpenNeuro not serving its bytes (#808). */
    upstreamInaccessible = false,
  ) {
    super(
      `${upstreamInaccessible ? `${OPENNEURO_UPSTREAM_MARKER} ` : ""}${IMPORT_SCRUB_MARKER} refused: ${code} (${detail}). Nothing was pushed, and the copy phase did not run.`,
    );
    this.name = "ImportScrubRefused";
  }
}

/** Error classes whose messages are fixed words by construction (ADR 0085's scrub tools). */
const FIXED_WORD_ERRORS = new Set(["GitScrubError", "ContractError", "LedgerRefused"]);
/** An errno code: capital letters, digits and underscores. */
const ERRNO = /^[A-Z][A-Z0-9_]{1,20}$/;

/**
 * What an unexpected error may say in a public line: its class, its errno code, and its message
 * only when the class is one whose messages are fixed words. A Node fs error's message embeds the
 * path, and git's stderr names files, so neither is ever repeated.
 */
export function describeError(err: unknown): string {
  if (!(err instanceof Error)) return "non-error";
  const code = (err as NodeJS.ErrnoException).code;
  const parts = [/^[A-Za-z]{1,40}$/.test(err.name) ? err.name : "Error"];
  if (typeof code === "string" && ERRNO.test(code)) parts.push(code);
  if (FIXED_WORD_ERRORS.has(err.name) && /^[a-z0-9 :,-]{1,80}$/i.test(err.message)) {
    parts.push(err.message);
  }
  return parts.join(" ");
}

/** The scanner revision an import's ledger line names (ADR 0089): a digest of the rule files. */
export const IMPORT_SCANNER_ID = `identifier-scan@${scannerRulesDigest()}`;

/** The actor a ledger line names when the run has no GitHub handle of its own. */
export const IMPORT_SCRUB_ACTOR = "nemar-importer";

/** The ledger's actor rule (`scripts/scrub/ledger.ts`), checked here so a bad handle is replaced, not refused. */
const ACTOR = /^[a-z0-9][a-z0-9-]{0,38}$/i;

/** Inline JSON over this is not read (the bound ADR 0085's git plan uses). */
export const MAX_JSON_BYTES = 1024 * 1024;

const RECORDING = /\.(edf|bdf)$/i;
const JSON_FILE = /\.json$/i;

// ---------------------------------------------------------------------------------------
// Reading upstream
// ---------------------------------------------------------------------------------------

export type ReadFailure = string;

export type HeaderRead =
  | { ok: true; bytes: Uint8Array; total: number | null }
  | { ok: false; failure: ReadFailure };

export type Download = { ok: true; bytes: number } | { ok: false; failure: ReadFailure };

/**
 * Where an upstream object is read from: the S3 object the server-side copy copies (by path), or,
 * for a whereis URL that is not an S3 endpoint, that URL itself, which is what the copy phase's
 * curl fallback fetches (`copyOne` in `s3-server-copy.ts`).
 */
export type UpstreamSource = { kind: "s3"; ref: S3Ref } | { kind: "url"; url: string };

/**
 * How the scrub reads the upstream objects the copy phase would copy. {@link httpUpstreamReader} is
 * the only implementation; a test points it at a local server.
 */
export interface UpstreamReader {
  /** The first {@link EDF_HEADER_BYTES} bytes, and the object's whole size when the server says it. */
  header(source: UpstreamSource): Promise<HeaderRead>;
  /** The whole object, streamed to `dest`. */
  download(source: UpstreamSource, dest: string): Promise<Download>;
}

const USER_AGENT = "nemar-cli-import-scrub";

/** The object's anonymous URL: path style, the regional endpoint when the source names a region. */
export function upstreamObjectUrl(ref: S3Ref, baseUrl?: string): string {
  const host =
    baseUrl ??
    (ref.region && ref.region !== "us-east-1"
      ? `https://s3.${ref.region}.amazonaws.com`
      : "https://s3.amazonaws.com");
  const path = ref.key.split("/").map(encodeURIComponent).join("/");
  return `${host.replace(/\/+$/, "")}/${encodeURIComponent(ref.bucket)}/${path}`;
}

function urlOf(source: UpstreamSource, baseUrl?: string): string {
  return source.kind === "s3" ? upstreamObjectUrl(source.ref, baseUrl) : source.url;
}

/** Local errors that a retry cannot fix and that are not the network's. */
const LOCAL_IO = new Set(["ENOSPC", "EACCES", "EPERM", "EROFS", "EIO", "EMFILE", "ENFILE"]);

function failureOf(err: unknown): ReadFailure {
  const name = err instanceof Error ? err.name : "";
  if (name === "TimeoutError" || name === "AbortError") return "timeout";
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" && LOCAL_IO.has(code) ? "local-io" : "network";
}

/** A 4xx other than 408 and 429 will answer the same way again; so will a local I/O error. */
function isDeterministic(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

function totalOf(res: Response): number | null {
  const range = res.headers.get("content-range");
  if (range) {
    const m = /\/(\d+)\s*$/.exec(range);
    return m ? Number(m[1]) : null;
  }
  if (res.status === 200) {
    const length = res.headers.get("content-length");
    return length !== null && /^\d+$/.test(length) ? Number(length) : null;
  }
  return null;
}

async function readAtMost(res: Response, limit: number): Promise<Uint8Array> {
  const out = new Uint8Array(limit);
  let filled = 0;
  const reader = res.body?.getReader();
  if (!reader) return out.subarray(0, 0);
  try {
    while (filled < limit) {
      const { value, done } = await reader.read();
      if (done || !value) break;
      const take = Math.min(value.length, limit - filled);
      out.set(value.subarray(0, take), filled);
      filled += take;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return out.subarray(0, filled);
}

/**
 * Anonymous HTTPS reads of upstream objects: an S3 source by path, which is what the server-side
 * copy copies (it drops the whereis URL's version), and any other source at its own URL. Retried on
 * a timeout, a network error, a short read, a 5xx, a 408 and a 429; a failure is a fixed word
 * (`http-403`, `timeout`, `network`, `short-read`, `local-io`).
 *
 * A header read is accepted only when it holds every byte it should: the first
 * {@link EDF_HEADER_BYTES}, or the whole object when the server says the object is smaller. A body
 * that ends early is a failure, never a short header, because a short header reads as "not an
 * EDF" and would let the recording through unread.
 */
export function httpUpstreamReader(
  options: {
    /** Only a test sets this; production reads `s3.amazonaws.com`. Applies to S3 sources only. */
    baseUrl?: string;
    attempts?: number;
    headerTimeoutMs?: number;
    downloadTimeoutMs?: number;
    retryDelayMs?: number;
  } = {},
): UpstreamReader {
  const attempts = options.attempts ?? 3;
  const delay = options.retryDelayMs ?? 1_000;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  return {
    async header(source) {
      let failure: ReadFailure = "network";
      for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
          const res = await fetch(urlOf(source, options.baseUrl), {
            headers: { Range: `bytes=0-${EDF_HEADER_BYTES - 1}`, "User-Agent": USER_AGENT },
            signal: AbortSignal.timeout(options.headerTimeoutMs ?? 30_000),
          });
          if (res.status === 206 || res.status === 200) {
            const total = totalOf(res);
            const bytes = await readAtMost(res, EDF_HEADER_BYTES);
            const expected = total === null ? EDF_HEADER_BYTES : Math.min(EDF_HEADER_BYTES, total);
            if (bytes.length === expected) return { ok: true, bytes, total };
            failure = "short-read";
          } else {
            await res.body?.cancel().catch(() => undefined);
            failure = `http-${res.status}`;
            if (isDeterministic(res.status)) break;
          }
        } catch (err) {
          failure = failureOf(err);
          if (failure === "local-io") break;
        }
        if (attempt < attempts) await sleep(delay * attempt);
      }
      return { ok: false, failure };
    },
    async download(source, dest) {
      let failure: ReadFailure = "network";
      for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
          const res = await fetch(urlOf(source, options.baseUrl), {
            headers: { "User-Agent": USER_AGENT },
            signal: AbortSignal.timeout(options.downloadTimeoutMs ?? 60 * 60_000),
          });
          if (res.status === 200 && res.body) {
            // Streamed to disk: a recording can be gigabytes.
            await pipeline(
              Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]),
              createWriteStream(dest),
            );
            return { ok: true, bytes: lstatSync(dest).size };
          }
          await res.body?.cancel().catch(() => undefined);
          failure = `http-${res.status}`;
          if (isDeterministic(res.status)) {
            rmSync(dest, { force: true });
            break;
          }
        } catch (err) {
          failure = failureOf(err);
          if (failure === "local-io") {
            rmSync(dest, { force: true });
            break;
          }
        }
        rmSync(dest, { force: true });
        if (attempt < attempts) await sleep(delay * attempt);
      }
      return { ok: false, failure };
    },
  };
}

// ---------------------------------------------------------------------------------------
// The scrub
// ---------------------------------------------------------------------------------------

/** What the scrub did, as counts. The ledger line carries the same names. */
export interface ImportScrubCounts {
  /** EDF and BDF files in the tree. */
  recordings: number;
  /** Headers read and judged, from the clone or from upstream. */
  headers_read: number;
  /** Annexed headers not read because `--skip-data` copies no data. */
  headers_not_read_skip_data: number;
  /** Annexed headers with no upstream source; the copy cannot copy them either. */
  headers_not_read_no_source: number;
  /** Annexed headers whose key NEMAR already holds (a re-import's own keys); the screen reads them. */
  headers_not_read_nemar_held: number;
  /** Files named like a recording whose first bytes are not an EDF or BDF header. */
  headers_not_edf: number;
  /** Headers rewritten. */
  headers_scrubbed: number;
  /** Of those, recordings git held (their originals stay in the pushed history). */
  git_held_recordings_scrubbed: number;
  /** Upstream keys replaced by a scrubbed copy and retired. */
  upstream_keys_replaced: number;
  /** Bytes downloaded to scrub. */
  bytes_downloaded: number;
  /** Inline JSON files read. */
  json_files_read: number;
  /** JSON files not read: over the bound, not UTF-8 JSON, or not a regular file. */
  json_files_unread: number;
  /** JSON files upstream annexed; their content is not in the clone, and the screen reads them. */
  json_files_annexed: number;
  /** JSON files with a value blanked. */
  json_files_blanked: number;
  /** Values blanked. */
  json_values_blanked: number;
  /** Image and document paths in the tree, left for the screen and a person. */
  images_or_documents_held: number;
  /** 1 when the provenance file got the sentence, else 0. */
  provenance_annotated: number;
  /** 1 when the provenance README got the note, else 0. */
  provenance_readme_annotated: number;
  /** Provenance files tracked but not annotated (not a regular file, or not a JSON object). */
  provenance_not_annotated: number;
}

function zeroCounts(): ImportScrubCounts {
  return {
    recordings: 0,
    headers_read: 0,
    headers_not_read_skip_data: 0,
    headers_not_read_no_source: 0,
    headers_not_read_nemar_held: 0,
    headers_not_edf: 0,
    headers_scrubbed: 0,
    git_held_recordings_scrubbed: 0,
    upstream_keys_replaced: 0,
    bytes_downloaded: 0,
    json_files_read: 0,
    json_files_unread: 0,
    json_files_annexed: 0,
    json_files_blanked: 0,
    json_values_blanked: 0,
    images_or_documents_held: 0,
    provenance_annotated: 0,
    provenance_readme_annotated: 0,
    provenance_not_annotated: 0,
  };
}

export interface ImportScrubResult {
  counts: ImportScrubCounts;
  /** Manifest entries for the scrubbed recordings: new keys, already uploaded (`origin: "local"`). */
  items: ImportManifestItem[];
  /** Upstream keys the scrub replaced. None may reach the copy. */
  replacedKeys: Set<string>;
  /** Paths git held that the scrub annexed and uploaded itself; the annex-policy leg skips them. */
  handledPaths: Set<string>;
  /**
   * True when content git tracks was changed by a forward fix (a JSON value, a recording git held),
   * by this run or, on a re-import, by an earlier import whose ledger line says so: the history the
   * push carries still holds the original, so the publication is never approved automatically.
   */
  historyHoldsOriginals: boolean;
  /** Recording keys whose header this run read from upstream (flagged or not). */
  headerReadKeys: Set<string>;
  /** True when the scrub made a commit. */
  committed: boolean;
}

export interface ImportScrubInput {
  datasetPath: string;
  nemarId: string;
  /** Upstream key -> whereis URL, as `getAnnexWhereisAll` built it. */
  keyUrlMap: Map<string, string>;
  /** Files git holds that NEMAR policy calls data, as `findUnannexedData` found them. */
  unannexedData: Array<{ path: string; size: number }>;
  /** True when prepare reset the clone onto the dataset's own `main` (a re-import). */
  reimport: boolean;
  skipData: boolean;
  /** The bound on bytes this host moves; defaults to {@link NORMALIZE_MAX_BYTES}. */
  maxBytes?: number;
  reader: UpstreamReader;
  /** How scrubbed recordings reach the remote; required unless `skipData`. */
  upload?: UploadStrategy;
  remoteName: string;
  bucket: string;
  /** Header reads in flight. */
  concurrency?: number;
  /** The ledger line's time; tests fix it. */
  now?: Date;
  /** The ledger line's actor; defaults to `GITHUB_ACTOR` when it is a handle. */
  actor?: string;
}

/** Run `fn` over `items` with at most `limit` in flight, keeping order. */
async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i] as T);
    }
  });
  await Promise.all(workers);
  return out;
}

function countWords(words: string[]): string {
  const counts = new Map<string, number>();
  for (const w of words) counts.set(w, (counts.get(w) ?? 0) + 1);
  return [...counts]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([w, n]) => `${w} x${n}`)
    .join(", ");
}

/** The first header bytes of a file on disk; null when it cannot be opened or read. */
function readLocalHeader(path: string): Uint8Array | null {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return null;
  }
  try {
    const buf = new Uint8Array(EDF_HEADER_BYTES);
    const n = readSync(fd, buf, 0, EDF_HEADER_BYTES, 0);
    return buf.subarray(0, n);
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/** Whether `scrubEdfHeader` would change this header; null when it is not an EDF or BDF header. */
function needsScrub(header: Uint8Array): boolean | null {
  try {
    return scrubEdfHeader(header).changed;
  } catch (err) {
    if (err instanceof ScrubRefused) return null;
    throw err;
  }
}

/**
 * Patch a recording on disk in place: only the first {@link EDF_HEADER_BYTES} bytes are written, and
 * the result is read back and proven against the original header. Throws a refusal when it is not.
 */
function patchInPlace(path: string): void {
  const before = readLocalHeader(path);
  if (!before || before.length < EDF_HEADER_BYTES) {
    throw new ImportScrubRefused("scrub-unverified", "a header to patch could not be read back");
  }
  const { header, changed } = scrubEdfHeader(before);
  const proof = verifyScrub(before, header);
  if (!changed || !proof.ok) {
    throw new ImportScrubRefused("scrub-unverified", "a patched header failed its proof");
  }
  const fd = openSync(path, "r+");
  try {
    writeSync(fd, header, 0, EDF_HEADER_BYTES, 0);
  } finally {
    closeSync(fd);
  }
  const after = readLocalHeader(path);
  if (!after || !verifyScrub(before, after).ok) {
    throw new ImportScrubRefused("scrub-unverified", "a patched header failed its read-back");
  }
}

async function sha256OfFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

/**
 * Set a top-level string member of a JSON object's text, keeping every other byte: the member's
 * value is replaced where it is, or the member is appended before the closing brace, in the file's
 * own indentation. Returns null when the text is not a JSON object.
 */
export function setTopLevelString(text: string, key: string, value: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const literal = JSON.stringify(value);
  // Walk the top level, skipping strings and nested values by depth.
  const open = text.indexOf("{");
  let depth = 0;
  let i = open;
  let lastMemberEnd = -1;
  let found: { start: number; end: number } | null = null;
  const skipString = (j: number): number => {
    let k = j + 1;
    while (text[k] !== '"') k += text[k] === "\\" ? 2 : 1;
    return k + 1;
  };
  let close = -1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      const end = skipString(i);
      if (depth === 1) {
        // A top-level key: what follows the colon is its value.
        let k = end;
        while (/\s/.test(text[k] as string)) k++;
        if (text[k] === ":") {
          const name = JSON.parse(text.slice(i, end)) as string;
          let v = k + 1;
          while (/\s/.test(text[v] as string)) v++;
          // The value's end: scan to the next comma or brace at this depth.
          let w = v;
          let d = 0;
          while (w < text.length) {
            const c = text[w];
            if (c === '"') {
              w = skipString(w);
              continue;
            }
            if (c === "{" || c === "[") d++;
            else if (c === "}" || c === "]") {
              if (d === 0) break;
              d--;
            } else if (c === "," && d === 0) break;
            w++;
          }
          let valueEnd = w;
          while (valueEnd > v && /\s/.test(text[valueEnd - 1] as string)) valueEnd--;
          if (name === key) found = { start: v, end: valueEnd };
          lastMemberEnd = valueEnd;
          i = w;
          continue;
        }
      }
      i = end;
      continue;
    }
    if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") {
      depth--;
      if (depth === 0) {
        close = i;
        break;
      }
    }
    i++;
  }
  if (close < 0) return null;
  if (found) return `${text.slice(0, found.start)}${literal}${text.slice(found.end)}`;
  const indent = /\n([ \t]+)\S/.exec(text)?.[1];
  const member = `${JSON.stringify(key)}: ${literal}`;
  if (lastMemberEnd < 0) {
    return `${text.slice(0, open + 1)}${member}${text.slice(close)}`;
  }
  const sep = indent !== undefined ? `,\n${indent}` : ", ";
  return `${text.slice(0, lastMemberEnd)}${sep}${member}${text.slice(lastMemberEnd)}`;
}

/** A tracked path that is a regular file in the working tree (not a symlink, not missing). */
function isRegularFile(abs: string): boolean {
  try {
    return lstatSync(abs).isFile();
  } catch {
    return false;
  }
}

async function stageAsGit(datasetPath: string, paths: string[]): Promise<void> {
  // `annex.largefiles=nothing`: these are git content (JSON, text, the ledger), and a plain `git add`
  // in an annexed repository can turn a file into an annex pointer whose content nothing uploads.
  // It holds for these paths because the inherited `.gitattributes` OpenNeuro writes (ADR 0060) has
  // no catch-all `annex.largefiles` rule and keeps JSON under 1 MB in git; an attribute outranks
  // this config, so a tree that annexed JSON by attribute would annex these too, and the scrub
  // commit would then fail to carry them, which `git commit` below reports.
  for (const chunk of chunkAddTargets(paths)) {
    const r = await runCommand(["git", "-c", "annex.largefiles=nothing", "add", "--", ...chunk], {
      cwd: datasetPath,
    });
    if (r.exitCode !== 0) throw new Error(`git add failed for ${chunk.length} scrubbed file(s)`);
  }
}

/**
 * The history hold an earlier import left on this tree: true when the ledger has an
 * `import-scrubbed` line that changed git-tracked content with no `history-rewritten` line after it
 * (a rewrite by ADR 0085's tools removes the originals). A ledger that cannot be read holds.
 */
function earlierHistoryHold(datasetPath: string): boolean {
  const path = join(datasetPath, LEDGER_REPO_PATH);
  if (!existsSync(path)) return false;
  let entries: ReturnType<typeof readLedger>;
  try {
    entries = readLedger(path);
  } catch {
    return true;
  }
  let hold = false;
  for (const e of entries) {
    if (e.action === "history-rewritten") hold = false;
    if (
      e.action === "import-scrubbed" &&
      ((e.counts.json_values_blanked ?? 0) > 0 || (e.counts.git_held_recordings_scrubbed ?? 0) > 0)
    ) {
      hold = true;
    }
  }
  return hold;
}

/**
 * Scrub a cloned tree before its first push (ADR 0089). See the module comment for what it changes.
 * Throws {@link ImportScrubRefused} for anything it cannot do safely; on success the scrub is one
 * commit (when anything changed), and the result says what the copy manifest must and must not hold.
 */
export async function scrubImportedTree(input: ImportScrubInput): Promise<ImportScrubResult> {
  try {
    return await scrubTree(input);
  } catch (err) {
    if (err instanceof ImportScrubRefused) throw err;
    throw new ImportScrubRefused("scrub-failed", describeError(err));
  }
}

async function scrubTree(input: ImportScrubInput): Promise<ImportScrubResult> {
  const { datasetPath } = input;
  const counts = zeroCounts();
  const tracked = [...(await listTrackedPaths(datasetPath))].sort();
  const annexedKeys = await listAnnexedKeys(datasetPath);
  const recordings = tracked.filter((p) => RECORDING.test(p));
  counts.recordings = recordings.length;

  // 1. Read every header that can be read, and decide.
  const gitHeld: string[] = [];
  const upstream: Array<{ path: string; key: string; source: UpstreamSource }> = [];
  // Recording keys this run has seen the first bytes of (or that hold no bytes at all).
  const headerReadKeys = new Set<string>();
  const localFailures: string[] = [];
  for (const path of recordings) {
    const key = annexedKeys.get(path);
    if (key === undefined) {
      gitHeld.push(path);
      continue;
    }
    if (input.skipData) {
      counts.headers_not_read_skip_data++;
      continue;
    }
    if (annexKeyDeclaredSize(key) === 0) {
      // An empty file is no EDF header, and a ranged read of it answers 416.
      counts.headers_not_edf++;
      headerReadKeys.add(key);
      continue;
    }
    const url = input.keyUrlMap.get(key);
    if (url === undefined) {
      // No URL at all: no manifest entry, so the copy never copies this key. On a re-import it is
      // NEMAR's own key (a scrubbed or normalized copy), which the screen reads from NEMAR's bucket;
      // on a first import nothing can copy it, and finalize's tree gate refuses the dataset.
      if (input.reimport) counts.headers_not_read_nemar_held++;
      else counts.headers_not_read_no_source++;
      continue;
    }
    // A URL that is not an S3 endpoint is still copied, by the copy phase's curl fallback, so its
    // header is read at that same URL.
    const ref = parseS3Url(url);
    const source: UpstreamSource | null = ref
      ? { kind: "s3", ref }
      : /^https?:\/\//.test(url)
        ? { kind: "url", url }
        : null;
    if (!source) {
      localFailures.push("source-unsupported");
      continue;
    }
    upstream.push({ path, key, source });
  }

  const flaggedGitHeld: string[] = [];
  for (const path of gitHeld) {
    const header = readLocalHeader(join(datasetPath, path));
    if (header === null) {
      localFailures.push("local-unreadable");
      continue;
    }
    counts.headers_read++;
    const verdict = needsScrub(header);
    if (verdict === null) counts.headers_not_edf++;
    else if (verdict) flaggedGitHeld.push(path);
  }

  const reads = await mapPool(upstream, input.concurrency ?? 16, (u) =>
    input.reader.header(u.source),
  );
  const failures: string[] = [...localFailures];
  const sizeMismatches: string[] = [];
  const flaggedUpstream: Array<{
    path: string;
    key: string;
    source: UpstreamSource;
    size: number;
  }> = [];
  reads.forEach((read, i) => {
    const u = upstream[i] as (typeof upstream)[number];
    if (!read.ok) {
      failures.push(read.failure);
      return;
    }
    const size = annexKeyDeclaredSize(u.key);
    if (size !== null && read.total === null) {
      // The server did not say how big the object is, so nothing shows these bytes are the key's.
      failures.push("no-length");
      return;
    }
    if (size !== null && read.total !== size) {
      sizeMismatches.push(u.key);
      return;
    }
    counts.headers_read++;
    headerReadKeys.add(u.key);
    const verdict = needsScrub(read.bytes);
    if (verdict === null) counts.headers_not_edf++;
    else if (verdict) flaggedUpstream.push({ ...u, size: size ?? 0 });
  });

  // 2. Refuse what cannot be done safely, before a byte moves.
  if (failures.length > 0) {
    const upstreamOnly = failures.every((f) => f === "http-403" || f === "http-404");
    throw new ImportScrubRefused(
      "header-unreadable",
      `${failures.length} of ${recordings.length} recording header(s) could not be read: ${countWords(failures)}`,
      upstreamOnly,
    );
  }
  if (sizeMismatches.length > 0) {
    throw new ImportScrubRefused(
      "upstream-size-mismatch",
      `${sizeMismatches.length} upstream object(s) are not the size their annex key declares`,
    );
  }
  const flagged = flaggedUpstream.length + flaggedGitHeld.length;
  if (input.reimport && flagged > 0) {
    throw new ImportScrubRefused(
      "already-imported-unscrubbed",
      `${flagged} recording(s) in the dataset's own tree need a scrub; correct it with ADR 0085's procedure, not by re-importing`,
    );
  }
  if (flaggedUpstream.some((f) => !ANNEX_KEY.test(f.key) || f.size <= 0)) {
    const n = flaggedUpstream.filter((f) => !ANNEX_KEY.test(f.key) || f.size <= 0).length;
    throw new ImportScrubRefused(
      "unsupported-key-backend",
      `${n} recording key(s) to replace are not SHA256E with a declared size`,
    );
  }
  const maxBytes = input.maxBytes ?? NORMALIZE_MAX_BYTES;
  const toDownload = flaggedUpstream.reduce((n, f) => n + f.size, 0);
  const gitHeldData = input.unannexedData.reduce((n, f) => n + f.size, 0);
  if (toDownload + gitHeldData > maxBytes) {
    throw new ImportScrubRefused(
      "bound-exceeded",
      `${flaggedUpstream.length} recording(s) to scrub, ${(toDownload / 1024 ** 3).toFixed(1)} GiB to download and ${(gitHeldData / 1024 ** 3).toFixed(1)} GiB of git-held data to upload, over the ${(maxBytes / 1024 ** 3).toFixed(1)} GiB bound; run on a host that can move them with --normalize-max-gb`,
    );
  }

  // 3. Download, check, patch. Each download replaces the annex pointer at its path.
  for (const f of flaggedUpstream) {
    const abs = join(datasetPath, f.path);
    const tmp = `${abs}.nemar-scrub-download`;
    const got = await input.reader.download(f.source, tmp);
    if (!got.ok) {
      throw new ImportScrubRefused(
        "header-unreadable",
        `a recording to scrub could not be downloaded: ${got.failure}`,
        got.failure === "http-403" || got.failure === "http-404",
      );
    }
    const digest = ANNEX_KEY.exec(f.key)?.[2];
    if (got.bytes !== f.size || (await sha256OfFile(tmp)) !== digest) {
      rmSync(tmp, { force: true });
      throw new ImportScrubRefused(
        "content-mismatch",
        "a downloaded recording does not hash to the key it was downloaded for",
      );
    }
    counts.bytes_downloaded += got.bytes;
    patchInPlace(tmp);
    rmSync(abs, { force: true });
    renameSync(tmp, abs);
  }
  for (const path of flaggedGitHeld) patchInPlace(join(datasetPath, path));
  counts.headers_scrubbed = flagged;
  counts.git_held_recordings_scrubbed = flaggedGitHeld.length;

  // 4. Annex the scrubbed recordings as SHA256E and upload them, with the location-log proof.
  const items: ImportManifestItem[] = [];
  const replacedKeys = new Set<string>();
  const handledPaths = new Set<string>();
  const toStage: string[] = [];
  const annexTargets: Array<{ path: string; size: number }> = [
    ...flaggedUpstream.map((f) => ({ path: f.path, size: f.size })),
    ...(input.skipData
      ? []
      : flaggedGitHeld.map((p) => ({ path: p, size: lstatSync(join(datasetPath, p)).size }))),
  ];
  if (input.skipData) toStage.push(...flaggedGitHeld);
  if (annexTargets.length > 0) {
    if (!input.upload) throw new Error("scrubbed recordings need an upload strategy");
    let data: Awaited<ReturnType<typeof normalizeUnannexedData>>;
    try {
      data = await normalizeUnannexedData({
        datasetPath,
        files: annexTargets,
        remoteName: input.remoteName,
        bucket: input.bucket,
        nemarId: input.nemarId,
        maxBytes,
        upload: input.upload,
        backend: "SHA256E",
      });
    } catch (err) {
      // Its messages name up to three paths and quote git-annex's stderr: never repeated here.
      throw new ImportScrubRefused(
        "upload-failed",
        `${annexTargets.length} scrubbed recording(s) could not be annexed or uploaded: ${describeError(err)}`,
      );
    }
    items.push(...data.items);
    for (const p of flaggedGitHeld) handledPaths.add(p);
    const newKeyOf = new Map(data.files.map((f) => [f.path, f.key]));
    const keymap: Record<string, string> = {};
    for (const f of flaggedUpstream) {
      const newKey = newKeyOf.get(f.path);
      if (!newKey || !ANNEX_KEY.test(newKey) || newKey === f.key) {
        throw new ImportScrubRefused("scrub-unverified", "a scrubbed recording has no new key");
      }
      keymap[f.key] = newKey;
      replacedKeys.add(f.key);
    }
    counts.upstream_keys_replaced = replacedKeys.size;

    // 5. Retire the replaced keys the way ADR 0085's annex-registry does, and prove it from the log.
    if (replacedKeys.size > 0) {
      let retired: Awaited<ReturnType<typeof annexRegistry>>;
      try {
        retired = await annexRegistry({
          repo: datasetPath,
          keymap,
          remoteUuids: [],
          execute: true,
        });
      } catch (err) {
        throw new ImportScrubRefused(
          "retire-failed",
          `the git-annex branch could not be updated: ${describeError(err)}`,
        );
      }
      const newKeys = new Set(Object.values(keymap)).size;
      if (
        retired.oldStillHeld !== 0 ||
        retired.oldDead !== retired.oldKeys ||
        retired.deadRefused !== 0 ||
        retired.newPresent !== newKeys
      ) {
        throw new ImportScrubRefused(
          "retire-failed",
          `${retired.oldKeys - retired.oldDead} of ${retired.oldKeys} replaced key(s) not recorded dead, ${newKeys - retired.newPresent} new key(s) not recorded at the remote`,
        );
      }
    }
  }

  // 6. Blank identifier-keyed values in inline JSON.
  for (const path of tracked) {
    if (!JSON_FILE.test(path)) continue;
    if (annexedKeys.has(path)) {
      counts.json_files_annexed++;
      continue;
    }
    const abs = join(datasetPath, path);
    if (!isRegularFile(abs) || lstatSync(abs).size > MAX_JSON_BYTES) {
      counts.json_files_unread++;
      continue;
    }
    let result: ReturnType<typeof blankIdentifierJsonKeys>;
    try {
      result = blankIdentifierJsonKeys(readFileSync(abs));
    } catch (err) {
      if (err instanceof JsonBlankUnverified) {
        throw new ImportScrubRefused("scrub-unverified", "a blanked JSON file failed its proof");
      }
      throw err;
    }
    if (result.status === "unreadable") {
      counts.json_files_unread++;
      continue;
    }
    counts.json_files_read++;
    if (result.status === "blanked" && result.bytes) {
      writeFileSync(abs, result.bytes);
      toStage.push(path);
      counts.json_files_blanked++;
      counts.json_values_blanked += result.blanked;
    }
  }

  // 7. Images and documents: counted for the record, left for the screen and a person.
  counts.images_or_documents_held = scanPaths(tracked).filter(
    (f) => f.kind === "image-or-document-file",
  ).length;

  const changed = counts.headers_scrubbed > 0 || counts.json_values_blanked > 0;
  const now = input.now ?? new Date();
  const date = now.toISOString().slice(0, 10);

  // 8. The provenance file and README say the headers changed (ADR 0085's sentences).
  if (counts.headers_scrubbed > 0) {
    const provenance = join(datasetPath, PROVENANCE_PATH);
    if (tracked.includes(PROVENANCE_PATH) && isRegularFile(provenance)) {
      const text = readFileSync(provenance, "utf8");
      const bom = text.charCodeAt(0) === 0xfeff ? String.fromCharCode(0xfeff) : "";
      const next = setTopLevelString(
        text.slice(bom.length),
        PROVENANCE_NOTE_KEY,
        provenanceNote(date, "scrubbed-in-place"),
      );
      if (next !== null) {
        writeFileSync(provenance, `${bom}${next}`);
        toStage.push(PROVENANCE_PATH);
        counts.provenance_annotated = 1;
      } else {
        counts.provenance_not_annotated++;
      }
    } else if (tracked.includes(PROVENANCE_PATH)) {
      counts.provenance_not_annotated++;
    }
    const readme = join(datasetPath, PROVENANCE_README_PATH);
    if (tracked.includes(PROVENANCE_README_PATH) && isRegularFile(readme)) {
      const note = provenanceReadmeNote(date, "scrubbed-in-place");
      const text = readFileSync(readme, "utf8");
      if (!text.endsWith(note)) {
        writeFileSync(readme, `${text}${text === "" || text.endsWith("\n") ? "" : "\n"}${note}`);
        toStage.push(PROVENANCE_README_PATH);
      }
      counts.provenance_readme_annotated = 1;
    } else if (tracked.includes(PROVENANCE_README_PATH)) {
      counts.provenance_not_annotated++;
    }
  }

  // 9. The ledger line and the commit.
  let committed = false;
  if (changed) {
    const envActor = process.env.GITHUB_ACTOR;
    const actor = input.actor ?? (envActor && ACTOR.test(envActor) ? envActor : IMPORT_SCRUB_ACTOR);
    appendLedger(join(datasetPath, LEDGER_REPO_PATH), {
      version: 1,
      at: now.toISOString(),
      dataset: input.nemarId,
      action: "import-scrubbed",
      versions: [],
      counts: { ...counts },
      scanner: IMPORT_SCANNER_ID,
      verification: "scanner-clean+payload-identical",
      actor,
    });
    toStage.push(LEDGER_REPO_PATH);
    await stageAsGit(datasetPath, toStage);
    const body = [
      `Recording headers scrubbed: ${counts.headers_scrubbed} (identification fields only; signal bytes unchanged).`,
      `JSON values blanked: ${counts.json_values_blanked} in ${counts.json_files_blanked} file(s).`,
      `Images and documents left for review: ${counts.images_or_documents_held}.`,
      `Recorded in ${LEDGER_REPO_PATH}.`,
    ].join("\n");
    // Only the scrub's own paths: prepare has staged other changes by now (root metadata it
    // un-annexed), and they belong to the commits that describe them, not to this one. Passed in
    // a file, NUL-separated, because there can be more than one command line holds; the file is
    // private (a path can be the identifier) and removed at once.
    const paths = [...new Set([...toStage, ...annexTargets.map((t) => t.path)])];
    const specDir = mkdtempSync(join(tmpdir(), "nemar-scrub-pathspec-"));
    const specFile = join(specDir, "paths");
    writeFileSync(specFile, `${paths.join("\0")}\0`, { mode: 0o600 });
    try {
      const commit = await runCommand(
        [
          "git",
          "-c",
          "annex.largefiles=nothing",
          "commit",
          "-m",
          "Privacy correction on import (ADR 0089)",
          "-m",
          body,
          `--pathspec-from-file=${specFile}`,
          "--pathspec-file-nul",
        ],
        { cwd: datasetPath },
      );
      if (commit.exitCode !== 0) throw new Error("could not commit the import scrub");
    } finally {
      rmSync(specDir, { recursive: true, force: true });
    }
    committed = true;
  }

  return {
    counts,
    items,
    replacedKeys,
    handledPaths,
    historyHoldsOriginals:
      counts.json_values_blanked > 0 ||
      counts.git_held_recordings_scrubbed > 0 ||
      (input.reimport && earlierHistoryHold(datasetPath)),
    headerReadKeys,
    committed,
  };
}

// ---------------------------------------------------------------------------------------
// The copy manifest
// ---------------------------------------------------------------------------------------

export interface RestrictedManifest {
  items: ImportManifestItem[];
  /** Entries dropped because the committed tree does not name their key. */
  droppedNotInTree: number;
  /** Entries dropped because the git-annex branch records their key as dead. */
  droppedDead: number;
}

/**
 * Cut the copy manifest to what the committed tree names (ADR 0089).
 *
 * The manifest is built from upstream's whereis, which describes upstream's tree, not the one this
 * prepare pushes: a re-import resets onto the dataset's own `main`, and the scrub replaces keys. An
 * entry the tree does not name is dropped, and so is one whose key the git-annex branch records as
 * dead (the purge list ADR 0085's tooling and this importer write). A replaced key still named by
 * the tree refuses. Duplicate entries are kept once.
 */
export async function restrictManifestToTree(
  datasetPath: string,
  items: ImportManifestItem[],
  replacedKeys: ReadonlySet<string>,
): Promise<RestrictedManifest> {
  try {
    return await restrictToTree(datasetPath, items, replacedKeys);
  } catch (err) {
    if (err instanceof ImportScrubRefused) throw err;
    throw new ImportScrubRefused("scrub-failed", describeError(err));
  }
}

async function restrictToTree(
  datasetPath: string,
  items: ImportManifestItem[],
  replacedKeys: ReadonlySet<string>,
): Promise<RestrictedManifest> {
  const treeKeys = new Set((await listAnnexedKeys(datasetPath)).values());
  const stillNamed = [...replacedKeys].filter((k) => treeKeys.has(k)).length;
  if (stillNamed > 0) {
    throw new ImportScrubRefused(
      "old-key-still-named",
      `${stillNamed} replaced key(s) are still named by the tree`,
    );
  }
  const unique = new Map<string, ImportManifestItem>();
  for (const item of items) if (!unique.has(item.key)) unique.set(item.key, item);
  const inTree = [...unique.values()].filter((it) => treeKeys.has(it.key));
  const droppedNotInTree = unique.size - inTree.length;
  const logs = await locationLogs(
    datasetPath,
    inTree.map((it) => it.key),
  );
  const kept = inTree.filter((_it, i) => !isDead(logs[i] ?? ""));
  return { items: kept, droppedNotInTree, droppedDead: inTree.length - kept.length };
}

// ---------------------------------------------------------------------------------------
// The step as prepare runs it
// ---------------------------------------------------------------------------------------

export interface PreparedTree {
  scrub: ImportScrubResult;
  normalized: NormalizeImportResult;
  /** The copy manifest: upstream entries plus local ones, cut to the committed tree. */
  manifest: RestrictedManifest;
  privacy: ImportPrivacyRecord;
}

/**
 * The scrub, then ADR 0060's annex-policy step, then the manifest cut, in the order prepare runs
 * them (`prepareImport` calls this and only adds its own reporting). Exported as one unit so the
 * order and the hand-offs between the three are what the tests drive.
 */
export async function prepareImportedTreeForCopy(args: {
  datasetPath: string;
  nemarId: string;
  bucket: string;
  remoteName: string;
  keyUrlMap: Map<string, string>;
  /** Manifest entries for the upstream keys, as `buildManifestItems` made them. */
  upstreamItems: ImportManifestItem[];
  unannexedData: Array<{ path: string; size: number }>;
  reimport: boolean;
  skipData: boolean;
  maxBytes?: number;
  reader: UpstreamReader;
  upload: UploadStrategy;
  now?: Date;
  actor?: string;
}): Promise<PreparedTree> {
  const scrub = await scrubImportedTree({
    datasetPath: args.datasetPath,
    nemarId: args.nemarId,
    keyUrlMap: args.keyUrlMap,
    unannexedData: args.unannexedData,
    reimport: args.reimport,
    skipData: args.skipData,
    maxBytes: args.maxBytes,
    reader: args.reader,
    upload: args.upload,
    remoteName: args.remoteName,
    bucket: args.bucket,
    now: args.now,
    actor: args.actor,
  });
  const normalized = await normalizeImportedTree({
    datasetPath: args.datasetPath,
    nemarId: args.nemarId,
    bucket: args.bucket,
    remoteName: args.remoteName,
    unannexedData: args.unannexedData.filter((f) => !scrub.handledPaths.has(f.path)),
    upstreamKeys: new Set(args.keyUrlMap.keys()),
    carryOverUnaccountedKeys: args.reimport && !args.skipData,
    upload: args.upload,
    maxBytes: args.maxBytes,
  });
  const manifest = args.skipData
    ? { items: [], droppedNotInTree: 0, droppedDead: 0 }
    : await restrictManifestToTree(
        args.datasetPath,
        [...args.upstreamItems, ...scrub.items, ...normalized.items],
        scrub.replacedKeys,
      );
  // The closing check: every recording the copy phase will copy from upstream had its header read
  // by this run. Nothing above should break it; if something does, refuse rather than copy unread.
  let tree: Map<string, string>;
  try {
    tree = await listAnnexedKeys(args.datasetPath);
  } catch (err) {
    throw new ImportScrubRefused("scrub-failed", describeError(err));
  }
  const recordingKeys = new Set([...tree].filter(([p]) => RECORDING.test(p)).map(([, k]) => k));
  const unread = manifest.items.filter(
    (it) =>
      !isLocallyUploaded(it) && recordingKeys.has(it.key) && !scrub.headerReadKeys.has(it.key),
  ).length;
  if (unread > 0) {
    throw new ImportScrubRefused(
      "header-unreadable",
      `${unread} recording(s) in the copy manifest whose header this run did not read`,
    );
  }
  return {
    scrub,
    normalized,
    manifest,
    privacy: { version: 1, historyHoldsOriginals: scrub.historyHoldsOriginals },
  };
}
