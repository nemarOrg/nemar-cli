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

import { createHash } from "node:crypto";

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
  entries: Record<
    string,
    {
      newKey: string;
      size: number;
      sourceSha256Verified: boolean;
      /**
       * sha256 of that key's entry in patches.json, taken over the 512 hex characters as written
       * (their ASCII bytes, not the 256 bytes they decode to). The new key is the hash of the
       * original with THIS patch applied, so an entry is good only for the patch it names:
       * assemble refuses a mismatch, and the hash stage recomputes one on resume.
       */
      patchSha256: string;
    }
  >;
}

/** The value a hashes entry carries for a patch: see {@link HashesFile}. */
export function patchDigest(patchHex: string): string {
  return createHash("sha256").update(patchHex, "ascii").digest("hex");
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
 * `zarr-plan.json` the same run wrote. Counts only.
 *
 * A proof is never vacuous: `found: "stores"` vouches for at least one store root, and the only
 * proof with no store is `found: "no-zarr"`, which says the prefix held no current object at all.
 */
export interface ZarrVerifiedFile {
  version: 1;
  dataset: string;
  verifiedAt: string;
  planSha256: string;
  zarrPlanSha256: string;
  found: "stores" | "no-zarr";
  /** Every store was clean after the run: `rewritten` had keys removed, `untouched` had none. */
  counts: { stores: number; rewritten: number; untouched: number };
}

/**
 * `git-verified.json`: written by `git-scrub verify` ONLY when every check passed, and removed at
 * the start of every verify run. It names the exact bytes it vouches for: the keymap, the git plan
 * and the S3 plan, by sha256. `delete-old` requires one in `fresh-clone` mode whose keymap is the
 * keymap it is using, because only a verify of a fresh clone looked at what was PUSHED.
 */
export interface GitVerifiedFile {
  version: 1;
  dataset: string;
  mode: "local" | "fresh-clone";
  verifiedAt: string;
  keymapSha256: string;
  gitPlanSha256: string;
  s3PlanSha256: string;
  /** The verify run's own counts (refs, commits, objects scanned, ...). */
  counts: Record<string, number>;
}

/**
 * `zarr-plan.json`: what the `zarr` stage found under the Zarr prefix and, after an execute, what
 * became of it. Counts, fixed words and a digest only: no S3 key, because a key is a path that may
 * be built from a file name, and nothing reads the keys back.
 */
export interface ZarrPlanFile {
  version: 1;
  dataset: string;
  bucket: string;
  /** sha256 of the exact bytes of plan.json this run was bound to. */
  planSha256: string;
  createdAt: string;
  /** False for a dry run, which writes nothing to S3. */
  executed: boolean;
  found: "stores" | "no-zarr";
  /** sha256 of the sorted keys the run examined, joined by newlines: names the set, stores none. */
  keysSha256: string;
  /** How many examined keys ended in each outcome (clean, needs-scrub, scrubbed, or why not). */
  outcomes: Record<string, number>;
  /** Members removed (or, in a dry run, that would be) across every store. */
  removedMembers: number;
  totals: {
    stores: number;
    clean: number;
    needScrub: number;
    scrubbed: number;
    unreadable: number;
    failed: number;
  };
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

const isString = (x: unknown): x is string => typeof x === "string";

/** A non-empty string: a dataset id, a bucket, a version id. */
const isName = (x: unknown): x is string => typeof x === "string" && x !== "";

/** An ISO 8601 date and time, as every stage writes them (`toISOString`, or to the second). */
function isIsoDate(x: unknown): x is string {
  return (
    typeof x === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.test(x) &&
    !Number.isNaN(Date.parse(x))
  );
}

/**
 * Read plan.json's text into a typed value, or refuse. Every field a later stage trusts is
 * checked here, and `totals` must agree with the keys it summarizes: a plan edited by hand to
 * hide an unreadable key (`unreadable: 0` over an unreadable entry) or to shrink the bytes to
 * hash is a plan this refuses, not one the stages act on.
 */
export function parsePlan(text: string): PlanFile {
  const x = JSON.parse(text) as unknown;
  const bad = (): never => {
    throw new ContractError("plan.json does not match the contract");
  };
  if (!isObject(x) || x.version !== 1 || !isName(x.dataset) || !Array.isArray(x.keys)) bad();
  const plan = x as Record<string, unknown>;
  if (plan.partial !== undefined && typeof plan.partial !== "boolean") bad();
  // Every S3 call of every later stage names this bucket.
  if (!isName(plan.bucket)) bad();
  if (plan.tags !== undefined && !(Array.isArray(plan.tags) && plan.tags.every(isString))) bad();

  const seen = new Set<string>();
  let needScrub = 0;
  let unreadable = 0;
  let bytesToHash = 0;
  for (const k of plan.keys as unknown[]) {
    if (!isObject(k) || !isString(k.oldKey)) {
      throw new ContractError("plan.json holds a key that is not a SHA256E annex key");
    }
    const annex = ANNEX_KEY.test(k.oldKey);
    if (!annex && !(k.status === "unreadable" && GIT_KEY.test(k.oldKey))) {
      throw new ContractError("plan.json holds a key that is not a SHA256E annex key");
    }
    if (k.status !== "read" && k.status !== "unreadable") bad();
    if (typeof k.needsScrub !== "boolean") bad();
    if (!isCount(k.size)) bad();
    if (annex && k.size !== parseKey(k.oldKey).size) bad();
    if (!Array.isArray(k.versionIds) || !k.versionIds.every(isString)) bad();
    if (!Array.isArray(k.reasons) || !k.reasons.every(isString)) bad();
    // A key that was not read cannot be said to need a scrub.
    if (k.needsScrub && k.status !== "read") bad();
    if (seen.has(k.oldKey)) bad();
    seen.add(k.oldKey);
    if (k.needsScrub) {
      needScrub += 1;
      bytesToHash += k.size as number;
    }
    if (k.status === "unreadable") unreadable += 1;
  }

  const t = plan.totals;
  if (
    !isObject(t) ||
    !isCount(t.keys) ||
    !isCount(t.needScrub) ||
    !isCount(t.bytesToHash) ||
    !isCount(t.unreadable) ||
    t.keys !== (plan.keys as unknown[]).length ||
    t.needScrub !== needScrub ||
    t.unreadable !== unreadable ||
    t.bytesToHash !== bytesToHash
  ) {
    bad();
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
    if (
      !ANNEX_KEY.test(oldKey) ||
      !isObject(e) ||
      typeof e.newKey !== "string" ||
      typeof e.patchSha256 !== "string" ||
      !SHA256_HEX.test(e.patchSha256)
    ) {
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

/**
 * Read assembled.json, or refuse. Every field a later stage acts on is checked: verify and
 * delete-old HEAD the new object AT `newVersionId`, so an entry without one would make them check
 * whatever version is current instead of the one that was assembled and verified.
 */
export function parseAssembled(text: string): AssembledFile {
  const x = JSON.parse(text) as unknown;
  if (
    !isObject(x) ||
    x.version !== 1 ||
    !isName(x.dataset) ||
    !isName(x.bucket) ||
    !isObject(x.entries)
  ) {
    throw new ContractError("assembled.json does not match the contract");
  }
  for (const [oldKey, e] of Object.entries(x.entries)) {
    if (
      !ANNEX_KEY.test(oldKey) ||
      !isObject(e) ||
      typeof e.newKey !== "string" ||
      !ANNEX_KEY.test(e.newKey) ||
      !isName(e.newVersionId) ||
      !isIsoDate(e.retainUntil) ||
      e.mode !== "GOVERNANCE"
    ) {
      throw new ContractError("assembled.json holds a bad entry");
    }
    const was = parseKey(oldKey);
    const now = parseKey(e.newKey);
    // As in hashes.json: the scrub keeps the size and the extension, and changes the content.
    if (was.size !== now.size || was.ext !== now.ext || was.sha256 === now.sha256) {
      throw new ContractError("assembled.json holds a bad entry");
    }
  }
  return x as unknown as AssembledFile;
}

export function parseVerified(text: string): VerifiedFile {
  const x = JSON.parse(text) as unknown;
  if (
    !isObject(x) ||
    x.version !== 1 ||
    !isName(x.dataset) ||
    !isIsoDate(x.verifiedAt) ||
    !isString(x.assembledSha256) ||
    !SHA256_HEX.test(x.assembledSha256) ||
    !isObject(x.counts) ||
    !isCount(x.counts.keys) ||
    !isCount(x.counts.headersChecked) ||
    !isCount(x.counts.rangesCompared)
  ) {
    throw new ContractError("verified.json does not match the contract");
  }
  return x as unknown as VerifiedFile;
}

export function parseZarrVerified(text: string): ZarrVerifiedFile {
  const x = JSON.parse(text) as unknown;
  if (
    !isObject(x) ||
    x.version !== 1 ||
    !isName(x.dataset) ||
    !isIsoDate(x.verifiedAt) ||
    typeof x.planSha256 !== "string" ||
    !SHA256_HEX.test(x.planSha256) ||
    typeof x.zarrPlanSha256 !== "string" ||
    !SHA256_HEX.test(x.zarrPlanSha256) ||
    (x.found !== "stores" && x.found !== "no-zarr") ||
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
  // Never vacuous: a proof about stores names at least one, and one about none says so.
  if ((x.found === "stores") !== c.stores > 0) {
    throw new ContractError("zarr-verified.json vouches for no store");
  }
  return x as unknown as ZarrVerifiedFile;
}

const GIT_VERIFIED_FIELDS = [
  "version",
  "dataset",
  "mode",
  "verifiedAt",
  "keymapSha256",
  "gitPlanSha256",
  "s3PlanSha256",
  "counts",
];

/** Read git-verified.json, or refuse: every field checked, and no field the contract does not name. */
export function parseGitVerified(text: string): GitVerifiedFile {
  const x = JSON.parse(text) as unknown;
  const bad = (): never => {
    throw new ContractError("git-verified.json does not match the contract");
  };
  if (!isObject(x)) return bad();
  const keys = Object.keys(x);
  if (keys.length !== GIT_VERIFIED_FIELDS.length || !GIT_VERIFIED_FIELDS.every((f) => f in x)) {
    bad();
  }
  if (
    x.version !== 1 ||
    !isName(x.dataset) ||
    (x.mode !== "local" && x.mode !== "fresh-clone") ||
    !isIsoDate(x.verifiedAt) ||
    !isString(x.keymapSha256) ||
    !SHA256_HEX.test(x.keymapSha256) ||
    !isString(x.gitPlanSha256) ||
    !SHA256_HEX.test(x.gitPlanSha256) ||
    !isString(x.s3PlanSha256) ||
    !SHA256_HEX.test(x.s3PlanSha256) ||
    !isObject(x.counts) ||
    !Object.values(x.counts).every(isCount)
  ) {
    bad();
  }
  return x as unknown as GitVerifiedFile;
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
