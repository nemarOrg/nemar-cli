/**
 * The files the scrub stages hand to each other, and the guards that read them back.
 *
 * A scrub is a sequence of separate programs run at different times, on different machines,
 * some of them dry runs: plan (read-only), hash (on a host with fast S3 reads), assemble
 * (admin credentials), verify, rewrite (git), switch, delete. Each stage reads the previous
 * stage's JSON from a working directory, so the shape of those files is the interface, and a
 * file that does not match is refused rather than guessed at.
 *
 * **No participant value is ever written here.** Keys are annex keys (a size and a content
 * hash), header patches are the SCRUBBED 256 bytes (placeholders only), and counts are counts.
 * The one exception is {@link GitPlanFile}: its `dropPaths` are file names, and a name can be
 * the identifier, so a working directory is private and deleted when the dataset is done.
 */

/** `SHA256E-s<size>--<64 hex>[.ext]`, the only key shape the scrub handles. */
export const ANNEX_KEY = /^SHA256E-s(\d+)--([0-9a-f]{64})(\.[A-Za-z0-9.+]*)?$/;

/**
 * A manifest entry for a file kept inline in git is keyed `git:<blob sha>` (SHA-1 or SHA-256).
 * It has no S3 object, so the scrub cannot read it; the plan records it as an unreadable entry.
 */
export const GIT_KEY = /^git:[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

export interface ParsedKey {
  size: number;
  sha256: string;
  /** Including the leading dot, or "" when the key has no extension. */
  ext: string;
}

export function parseKey(key: string): ParsedKey {
  const m = ANNEX_KEY.exec(key);
  if (!m) throw new ContractError("not a SHA256E annex key");
  return { size: Number(m[1]), sha256: m[2] as string, ext: m[3] ?? "" };
}

/** Build the key for scrubbed content: same extension, new size and hash. */
export function buildKey(size: number, sha256: string, ext: string): string {
  if (!/^[0-9a-f]{64}$/.test(sha256))
    throw new ContractError("sha256 must be 64 lowercase hex digits");
  return `SHA256E-s${size}--${sha256}${ext}`;
}

export class ContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContractError";
  }
}

/** `plan.json`: what a dataset has, and which of it needs a scrub. Written by the plan stage. */
export interface PlanFile {
  version: 1;
  dataset: string;
  bucket: string;
  /** Tags planned over, in order. */
  tags: string[];
  /**
   * True when the plan was made over only the tags it was told about (`--tags`), so a manifest it
   * did not read may name keys it does not hold. A partial plan can be read but never carried
   * through assemble, verify or delete-old.
   */
  partial?: boolean;
  createdAt: string;
  keys: PlanKey[];
  /** Counts only, for the report. */
  totals: { keys: number; needScrub: number; bytesToHash: number; unreadable: number };
}

export interface PlanKey {
  /**
   * The annex key of the original object. The one exception is an unreadable entry for a
   * recording kept inline in git, whose key is `git:<blob sha>` (reason `git-inline-recording`).
   */
  oldKey: string;
  size: number;
  /** True when its header carries identifier-severity content the scrub removes. */
  needsScrub: boolean;
  /** Every S3 version id of `<dataset>/objects/<oldKey>` and any delete marker, for the delete stage. */
  versionIds: string[];
  /** The fixed names of the findings that made it need a scrub; never values. */
  reasons: string[];
  /** "read" when the header was read and scanned; anything else means the key was NOT checked. */
  status: "read" | "unreadable";
}

/** `patches.json`: oldKey -> the scrubbed 256-byte header as lowercase hex (512 characters). */
export type PatchesFile = Record<string, string>;

/** `hashes.json`: written on the hashing host. oldKey -> the key the scrubbed content gets. */
export interface HashesFile {
  version: 1;
  dataset: string;
  entries: Record<string, { newKey: string; size: number; sourceSha256Verified: boolean }>;
}

/** `assembled.json`: oldKey -> the new object, after it was assembled and locked. */
export interface AssembledFile {
  version: 1;
  dataset: string;
  bucket: string;
  entries: Record<
    string,
    { newKey: string; newVersionId: string; retainUntil: string; mode: "GOVERNANCE" }
  >;
}

/** `keymap.json`: the whole point of the exercise, handed to the history rewrite. */
export type KeymapFile = Record<string, string>;

/** `verified.json`: proof the delete stage requires. It names the assembled file it vouches for. */
export interface VerifiedFile {
  version: 1;
  dataset: string;
  verifiedAt: string;
  /** sha256 of the exact bytes of assembled.json that were verified. */
  assembledSha256: string;
  counts: { keys: number; headersChecked: number; rangesCompared: number };
}

/**
 * `zarr-verified.json`: proof that every Zarr store root of the dataset carries no identifier key.
 * It names the exact bytes of the two files it was made from, so a re-plan or a re-run makes an
 * older proof stale: `planSha256` is the sha256 of plan.json and `zarrPlanSha256` that of the
 * `zarr-plan.json` the same run wrote. Counts only; the store keys stay in `zarr-plan.json`.
 */
export interface ZarrVerifiedFile {
  version: 1;
  dataset: string;
  verifiedAt: string;
  planSha256: string;
  zarrPlanSha256: string;
  /** Every store was clean after the run: `rewritten` had keys removed, `untouched` had none. */
  counts: { stores: number; rewritten: number; untouched: number };
}

/**
 * `git-plan.json`: the rewrite of the dataset's git history. Names here may be identifying.
 * `dropPaths` are exact repository paths removed from every commit. `blankJsonKeys` maps an exact
 * path to canonical key spellings (lowercase, no separators) whose values become empty strings.
 */
export interface GitPlanFile {
  version: 1;
  dataset: string;
  dropPaths: string[];
  blankJsonKeys: Record<string, string[]>;
  /** Appended to each listed text file in every commit that has it; the file is created if absent. */
  appendText: Record<string, string>;
  /**
   * Structural edits to JSON files, by exact path, applied in order in every commit that has the
   * file. Needed for a provenance file that lists the files being removed.
   */
  jsonOps?: Record<string, JsonOp[]>;
}

export type JsonOp =
  /** Remove entries of a top-level array whose `matchField` equals one of `matchValues`. */
  | { op: "drop-array-entries"; array: string; matchField: string; matchValues: string[] }
  /** Recompute a count and a byte total from a top-level array, after entries were dropped. */
  | { op: "recount"; array: string; countKey: string; sumKey: string; sumField: string }
  /** Set a top-level key to a constant string (for example a privacy-correction note). */
  | { op: "set"; key: string; value: string };

/** One line of the corrective-action ledger. Counts and fixed words only. */
export interface LedgerEntry {
  version: 1;
  at: string;
  dataset: string;
  action:
    | "plan"
    | "headers-scrubbed"
    | "files-removed"
    | "history-rewritten"
    | "locks-applied"
    | "manifests-regenerated"
    | "old-versions-deleted"
    | "published-again";
  versions: string[];
  counts: Record<string, number>;
  scanner: string;
  verification: string;
  actor: string;
}

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** A count: a non-negative whole number. */
function isCount(x: unknown): x is number {
  return typeof x === "number" && Number.isSafeInteger(x) && x >= 0;
}

/** Read a JSON file's text into a typed value, or refuse. `kind` names the file in the error. */
export function parsePlan(text: string): PlanFile {
  const x = JSON.parse(text) as unknown;
  if (!isObject(x) || x.version !== 1 || typeof x.dataset !== "string" || !Array.isArray(x.keys)) {
    throw new ContractError("plan.json does not match the contract");
  }
  if (x.partial !== undefined && typeof x.partial !== "boolean") {
    throw new ContractError("plan.json does not match the contract");
  }
  for (const k of x.keys as unknown[]) {
    const keyOk =
      isObject(k) &&
      typeof k.oldKey === "string" &&
      (ANNEX_KEY.test(k.oldKey) || (k.status === "unreadable" && GIT_KEY.test(k.oldKey)));
    if (!keyOk) {
      throw new ContractError("plan.json holds a key that is not a SHA256E annex key");
    }
  }
  return x as unknown as PlanFile;
}

export function parsePatches(text: string): PatchesFile {
  const x = JSON.parse(text) as unknown;
  if (!isObject(x)) throw new ContractError("patches.json is not an object");
  for (const [key, hex] of Object.entries(x)) {
    if (!ANNEX_KEY.test(key)) throw new ContractError("patches.json holds a bad key");
    if (typeof hex !== "string" || !/^[0-9a-f]{512}$/.test(hex)) {
      throw new ContractError("patches.json holds a header that is not 256 bytes of hex");
    }
  }
  return x as PatchesFile;
}

export function parseHashes(text: string): HashesFile {
  const x = JSON.parse(text) as unknown;
  if (!isObject(x) || x.version !== 1 || !isObject(x.entries)) {
    throw new ContractError("hashes.json does not match the contract");
  }
  for (const [oldKey, e] of Object.entries(x.entries)) {
    if (!ANNEX_KEY.test(oldKey) || !isObject(e) || typeof e.newKey !== "string") {
      throw new ContractError("hashes.json holds a bad entry");
    }
    const oldParsed = parseKey(oldKey);
    const newParsed = parseKey(e.newKey);
    if (oldParsed.size !== newParsed.size || oldParsed.ext !== newParsed.ext) {
      throw new ContractError("a scrubbed key must keep the size and extension of the original");
    }
    if (oldParsed.sha256 === newParsed.sha256) {
      throw new ContractError("a scrubbed key must not equal the original: nothing was changed");
    }
  }
  return x as unknown as HashesFile;
}

export function parseAssembled(text: string): AssembledFile {
  const x = JSON.parse(text) as unknown;
  if (!isObject(x) || x.version !== 1 || !isObject(x.entries)) {
    throw new ContractError("assembled.json does not match the contract");
  }
  for (const [oldKey, e] of Object.entries(x.entries)) {
    if (
      !ANNEX_KEY.test(oldKey) ||
      !isObject(e) ||
      typeof e.newKey !== "string" ||
      !ANNEX_KEY.test(e.newKey) ||
      e.mode !== "GOVERNANCE"
    ) {
      throw new ContractError("assembled.json holds a bad entry");
    }
  }
  return x as unknown as AssembledFile;
}

export function parseVerified(text: string): VerifiedFile {
  const x = JSON.parse(text) as unknown;
  if (!isObject(x) || x.version !== 1 || typeof x.assembledSha256 !== "string") {
    throw new ContractError("verified.json does not match the contract");
  }
  return x as unknown as VerifiedFile;
}

export function parseZarrVerified(text: string): ZarrVerifiedFile {
  const x = JSON.parse(text) as unknown;
  if (
    !isObject(x) ||
    x.version !== 1 ||
    typeof x.dataset !== "string" ||
    typeof x.verifiedAt !== "string" ||
    typeof x.planSha256 !== "string" ||
    !SHA256_HEX.test(x.planSha256) ||
    typeof x.zarrPlanSha256 !== "string" ||
    !SHA256_HEX.test(x.zarrPlanSha256) ||
    !isObject(x.counts)
  ) {
    throw new ContractError("zarr-verified.json does not match the contract");
  }
  const c = x.counts;
  if (
    !isCount(c.stores) ||
    !isCount(c.rewritten) ||
    !isCount(c.untouched) ||
    c.rewritten + c.untouched !== c.stores
  ) {
    throw new ContractError("zarr-verified.json holds counts that do not add up");
  }
  return x as unknown as ZarrVerifiedFile;
}

export function parseKeymap(text: string): KeymapFile {
  const x = JSON.parse(text) as unknown;
  if (!isObject(x)) throw new ContractError("keymap.json is not an object");
  for (const [a, b] of Object.entries(x)) {
    if (!ANNEX_KEY.test(a) || typeof b !== "string" || !ANNEX_KEY.test(b) || a === b) {
      throw new ContractError("keymap.json holds a bad pair");
    }
  }
  return x as KeymapFile;
}

export function parseGitPlan(text: string): GitPlanFile {
  const x = JSON.parse(text) as unknown;
  if (
    !isObject(x) ||
    x.version !== 1 ||
    !Array.isArray(x.dropPaths) ||
    !isObject(x.blankJsonKeys) ||
    !isObject(x.appendText)
  ) {
    throw new ContractError("git-plan.json does not match the contract");
  }
  if (x.jsonOps !== undefined) {
    if (!isObject(x.jsonOps)) throw new ContractError("git-plan.json jsonOps is not an object");
    for (const ops of Object.values(x.jsonOps)) {
      if (!Array.isArray(ops)) throw new ContractError("git-plan.json jsonOps holds a non-list");
      for (const o of ops as unknown[]) {
        const kind = isObject(o) ? o.op : undefined;
        if (kind !== "drop-array-entries" && kind !== "recount" && kind !== "set") {
          throw new ContractError("git-plan.json jsonOps holds an unknown op");
        }
      }
    }
  }
  return x as unknown as GitPlanFile;
}
