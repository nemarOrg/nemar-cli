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
  /**
   * sha256 of the exact bytes of the patches.json written beside this plan. Every stage that
   * uses a patch (hash, assemble, verify) refuses a patches.json whose bytes are not these
   * (`patches-stale`), so a patches.json from another plan is never applied. Absent only in a plan
   * no patch is read with (the git stage's fixtures).
   */
  patchesSha256?: string;
  keys: PlanKey[];
  /**
   * Every RAW copy under `<dataset>/objects/`: an object whose name is not an annex key and not
   * {@link ANNEX_UUID_OBJECT}, with every version and every delete marker it had when the plan was
   * made, sorted by name (see {@link RawCopy}). Absent when there is none, so a plan of a dataset
   * without raw copies is the file it always was. Names are file paths, so a plan that has them is
   * private like `git-plan.json`.
   */
  rawCopies?: RawCopy[];
  /** Counts only, for the report. The three `rawCopy*` counts are there exactly when `rawCopies` is. */
  totals: {
    keys: number;
    needScrub: number;
    bytesToHash: number;
    unreadable: number;
    rawCopyNames?: number;
    rawCopyVersions?: number;
    rawCopyMarkers?: number;
  };
}

/**
 * The one standard object under `<dataset>/objects/` that is not an annex key: the S3 special
 * remote's marker (36 bytes, the remote's uuid). It is neither a raw copy nor a recording, it stays,
 * and every stage ignores it by this exact name.
 */
export const ANNEX_UUID_OBJECT = "annex-uuid";

/** True for a path the scrub reads: an EDF or BDF file, in any letter case. */
export function isEdfOrBdf(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return lower.endsWith(".edf") || lower.endsWith(".bdf");
}

/**
 * A raw copy: an object under `<dataset>/objects/` stored by its PATH, not by an annex key (a
 * legacy import uploaded a whole BIDS tree that way into nm000112 and nm000114, AppleDouble `._*`
 * files included). A raw recording is an original, header and all; a raw text file holds the
 * values the git rewrite blanks. Every raw copy is deleted at step 15b, but only once each of its
 * versions is proven to duplicate content NEMAR keeps elsewhere (`raw-verify`, ADR 0085).
 *
 * `kind` is "recording" exactly when the name ends `.edf` or `.bdf` in any letter case
 * ({@link isEdfOrBdf}). `versions` are every version with its size and `markers` every delete
 * marker, as the plan's listing found them.
 */
export interface RawCopy {
  name: string;
  kind: "recording" | "other";
  versions: Array<{ id: string; size: number }>;
  markers: string[];
}

/** The kind a raw name has; the plan writes it and every reader checks it. */
export function rawKindOf(name: string): RawCopy["kind"] {
  return isEdfOrBdf(name) ? "recording" : "other";
}

/**
 * True when a name holds a control character (U+0000 to U+001F, U+007F to U+009F) or U+FFFE or
 * U+FFFF. XML 1.0 cannot carry most of them, and a carriage return it reads back as a line feed,
 * so a `DeleteObjects` body cannot name such a key: it would stay behind every run, and the
 * final listing would stop each one with exit 5. As `has_control_character` in hash_stage.py.
 */
export function hasControlCharacter(name: string): boolean {
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i);
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0xfffe || c === 0xffff) return true;
  }
  return false;
}

/**
 * True for a name under `<dataset>/objects/` that is a raw copy: not the special remote's marker,
 * not in the annex key space (`SHA256E-`; one there that does not parse is refused, not a raw
 * copy), not empty, with no lone surrogate (no shell or S3 call can carry one; an S3 key is
 * UTF-8), and with no control character ({@link hasControlCharacter}; NUL among them). A name that
 * fails is a bad key, which stops the plan (`objects-bad-key`).
 */
export function isRawCopyName(name: string): boolean {
  return (
    name !== "" &&
    name !== ANNEX_UUID_OBJECT &&
    !name.startsWith("SHA256E-") &&
    !hasControlCharacter(name) &&
    !/\p{Cs}/u.test(name)
  );
}

/**
 * `raw-hashes.json`: written on the hash host by `hash_stage.py raw-hash`, one entry per raw
 * VERSION of the plan it names (`planSha256`, the sha256 of plan.json's exact bytes), sorted by
 * name and then version id. A hashed entry carries the sha256 of the version's bytes and its git
 * blob id (the SHA-1 of `blob <size>\0` and the bytes, with the plan's size); a version whose byte
 * count was not the plan's size carries the fixed word `size-differs` and no digest.
 */
export interface RawHashesFile {
  version: 1;
  dataset: string;
  planSha256: string;
  entries: RawHashEntry[];
}

export type RawHashEntry =
  | { name: string; versionId: string; size: number; sha256: string; gitBlobSha1: string }
  | { name: string; versionId: string; failure: "size-differs" };

/**
 * `raw-verified.json`: written by `s3-scrub raw-verify` ONLY when every raw version of the plan it
 * names is proven to duplicate content NEMAR keeps: a raw recording is byte for byte an annex key
 * of the plan (its sha256 and size), and any other raw file is a blob of the repository's history
 * from before the rewrite. It names the exact bytes it was made from: plan.json, raw-hashes.json and
 * the git blob list. Counts, and the annex keys the raw recordings matched (content hashes, never a
 * name or a value). `delete-old` refuses a plan with raw copies without it.
 */
export interface RawVerifiedFile {
  version: 1;
  dataset: string;
  verifiedAt: string;
  planSha256: string;
  rawHashesSha256: string;
  gitBlobsSha256: string;
  /**
   * Every annex key of the plan whose sha256 and size a raw recording version has, sorted and
   * unique; empty exactly when no raw recording was matched. `delete-old` requires each one it
   * does not replace to be current at its size, because the raw recording goes on the strength of
   * that key keeping its bytes.
   */
  matchedKeys: string[];
  counts: {
    names: number;
    versions: number;
    markers: number;
    matchedRecordings: number;
    matchedOther: number;
  };
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

/**
 * `deleted.json`: written by delete-old ONLY after an authoritative listing showed zero versions
 * and zero markers for every old key and no history under archives/, version/ or zarr/. It is the
 * proof the ledger's `old-versions-deleted` line takes its counts from.
 */
export interface DeletedFile {
  version: 1;
  dataset: string;
  deletedAt: string;
  assembledSha256: string;
  counts: {
    keys: number;
    versions: number;
    markers: number;
    prunedVersions: number;
    prunedMarkers: number;
    /** The raw copies' versions and markers deleted, both there exactly when the plan had raw copies. */
    rawVersions?: number;
    rawMarkers?: number;
  };
}

const DELETED_COUNTS = ["keys", "versions", "markers", "prunedVersions", "prunedMarkers"];
const DELETED_RAW_COUNTS = ["rawVersions", "rawMarkers"];

/** Read deleted.json, or refuse: exactly the contract's fields, counts that are counts. */
export function parseDeleted(text: string): DeletedFile {
  const x = JSON.parse(text) as unknown;
  const bad = (): never => {
    throw new ContractError("deleted.json does not match the contract");
  };
  if (!isObject(x)) return bad();
  const fields = ["version", "dataset", "deletedAt", "assembledSha256", "counts"];
  if (Object.keys(x).length !== fields.length || !fields.every((f) => f in x)) bad();
  if (
    x.version !== 1 ||
    !isName(x.dataset) ||
    !isIsoDate(x.deletedAt) ||
    !isString(x.assembledSha256) ||
    !SHA256_HEX.test(x.assembledSha256) ||
    !isObject(x.counts)
  ) {
    bad();
  }
  const c = x.counts as Record<string, unknown>;
  // The raw counts come as a pair or not at all: a plan with raw copies deletes both kinds. With
  // either one present both are expected, so half the pair fails the count check below.
  const raw = DELETED_RAW_COUNTS.some((f) => f in c);
  const expected = raw ? [...DELETED_COUNTS, ...DELETED_RAW_COUNTS] : DELETED_COUNTS;
  if (Object.keys(c).length !== expected.length || !expected.every((f) => isCount(c[f]))) {
    bad();
  }
  return x as unknown as DeletedFile;
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
  /**
   * The store roots the run proved, as paths under `<id>/zarr/` (`sub-01/eeg/x.zarr`, the
   * spelling `index.json` uses), sorted. `zarr-public` checks the union of these and the index's
   * stores, so a store the index forgot is still checked. Paths can be built from file names, so
   * this file is private like the rest of the working directory.
   */
  stores: string[];
  /** The member names the operator accepted with `--allow-member` (canonical), sorted. */
  allowedMembers: string[];
  /**
   * `stores` store roots; `docs` zarr.json documents read (roots and every array or group inside a
   * store), every one clean after the run: `rewritten` had members removed, `untouched` had none.
   */
  counts: { stores: number; docs: number; rewritten: number; untouched: number };
}

/**
 * `git-verified.json`: written by `git-scrub verify` ONLY when every check passed, and removed at
 * the start of every verify run. It names the exact bytes it vouches for: the keymap, the git plan
 * and the S3 plan, by sha256. `drop-archives` and `delete-old` require one in `fresh-clone` mode
 * whose keymap is the keymap they are using, because only a verify of a fresh clone looked at what
 * was PUSHED.
 */
export interface GitVerifiedFile {
  version: 1;
  dataset: string;
  mode: "local" | "fresh-clone";
  verifiedAt: string;
  keymapSha256: string;
  gitPlanSha256: string;
  s3PlanSha256: string;
  /**
   * The verify run's own counts (refs, commits, objects scanned, ...). Since the provenance
   * exception (ADR 0085), a proof also counts the upstream checksums it let stand:
   * `provenanceHashesKept` (distinct old hashes) and `provenanceBlobsKept`. A proof written before
   * has neither and still parses: that verify allowed no old hash anywhere, a stricter check, so
   * what it vouches for still holds.
   */
  counts: Record<string, number>;
  /**
   * The tag names the operator accepted with `--allow-tag` (a fresh-clone verify only), sorted by
   * code unit and without duplicates, each a version tag the git plan accepts. Present only when
   * there was at least one: a proof without it is still a proof, and says no tag was allowed. The
   * allowance is for the NAME check only; the tag's tree was scanned like every other ref's.
   */
  allowedTags?: string[];
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
    /** zarr.json documents examined: store roots and the arrays and groups inside stores. */
    docs: number;
    clean: number;
    needScrub: number;
    scrubbed: number;
    unreadable: number;
    /** Documents whose recording metadata holds a member no list names. */
    unknownMembers: number;
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
  /**
   * Inline JSON paths the plan builder could not read in some commit (over its size limit, or not
   * UTF-8 JSON), present only when a person accepted them (`--allow-skipped-json`): their keys
   * were not scanned, so nothing in this plan blanks them.
   */
  skippedJson?: { oversize: string[]; unparseable: string[] };
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

/**
 * A version tag the ledger, the change log, the git plan and `--allow-tag` take: `vX.Y.Z` with an
 * optional pre-release. Declared here so the proof's parser needs nothing from the ledger module,
 * which re-exports it.
 */
export const VERSION_TAG = /^v\d+\.\d+\.\d+(-[A-Za-z0-9.]+)?$/;

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
  if (
    plan.patchesSha256 !== undefined &&
    !(isString(plan.patchesSha256) && SHA256_HEX.test(plan.patchesSha256))
  ) {
    bad();
  }

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
  const rawTotals = ["rawCopyNames", "rawCopyVersions", "rawCopyMarkers"] as const;
  const tt = t as Record<string, unknown>;
  if (plan.rawCopies === undefined) {
    // No raw copies, no raw counts: the plan is the file a plan without them always was.
    if (rawTotals.some((f) => f in tt)) bad();
  } else {
    const raw = checkRawCopies(plan.rawCopies);
    if (
      tt.rawCopyNames !== raw.names ||
      tt.rawCopyVersions !== raw.versions ||
      tt.rawCopyMarkers !== raw.markers
    ) {
      bad();
    }
  }
  return x as unknown as PlanFile;
}

const RAW_COPY_FIELDS = ["name", "kind", "versions", "markers"];

/**
 * The `rawCopies` of a plan, or refuse: exactly the contract's members in each entry (anything
 * else is not what the plan stage writes), a raw name the plan stage would list (never
 * `annex-uuid`, never in the annex key space), the kind its name gives, at least one version or
 * marker, version ids and marker ids that are names and never repeat within a name, sizes that are
 * counts, and entries strictly sorted by name, so no name appears twice. Returns the counts the
 * totals must carry.
 */
function checkRawCopies(raw: unknown): { names: number; versions: number; markers: number } {
  const bad = (): never => {
    throw new ContractError("plan.json holds a raw copy that does not match the contract");
  };
  if (!Array.isArray(raw)) return bad();
  let versions = 0;
  let markers = 0;
  let previous: string | undefined;
  for (const r of raw as unknown[]) {
    if (!isObject(r)) return bad();
    if (Object.keys(r).length !== RAW_COPY_FIELDS.length || !RAW_COPY_FIELDS.every((f) => f in r)) {
      bad();
    }
    if (!isString(r.name) || !isRawCopyName(r.name)) return bad();
    if (r.kind !== rawKindOf(r.name)) bad();
    if (previous !== undefined && !(previous < r.name)) bad();
    previous = r.name;
    if (!Array.isArray(r.versions) || !Array.isArray(r.markers)) return bad();
    if (r.versions.length + r.markers.length === 0) bad();
    const ids = new Set<string>();
    for (const v of r.versions as unknown[]) {
      if (!isObject(v) || Object.keys(v).length !== 2 || !isName(v.id) || !isCount(v.size)) {
        return bad();
      }
      if (ids.has(v.id)) bad();
      ids.add(v.id);
    }
    for (const m of r.markers as unknown[]) {
      if (!isName(m) || ids.has(m)) return bad();
      ids.add(m);
    }
    versions += r.versions.length;
    markers += r.markers.length;
  }
  return { names: raw.length, versions, markers };
}

const RAW_HASHES_FIELDS = ["version", "dataset", "planSha256", "entries"];
const RAW_HASH_DIGEST_FIELDS = ["name", "versionId", "size", "sha256", "gitBlobSha1"];
const RAW_HASH_FAILURE_FIELDS = ["name", "versionId", "failure"];
const SHA1_HEX = /^[0-9a-f]{40}$/;

/**
 * Read raw-hashes.json, or refuse: exactly the contract's fields, each entry either a digest (a
 * size that is a count, a sha256, a git blob id) or the one failure word, and no name and version
 * id twice. The writer sorts the entries; the order is not checked here, because Python and
 * JavaScript order strings differently outside the Basic Multilingual Plane.
 */
export function parseRawHashes(text: string): RawHashesFile {
  const x = JSON.parse(text) as unknown;
  const bad = (): never => {
    throw new ContractError("raw-hashes.json does not match the contract");
  };
  if (!isObject(x)) return bad();
  if (
    Object.keys(x).length !== RAW_HASHES_FIELDS.length ||
    !RAW_HASHES_FIELDS.every((f) => f in x) ||
    x.version !== 1 ||
    !isName(x.dataset) ||
    !isString(x.planSha256) ||
    !SHA256_HEX.test(x.planSha256) ||
    !Array.isArray(x.entries)
  ) {
    return bad();
  }
  const seen = new Set<string>();
  for (const e of x.entries as unknown[]) {
    if (!isObject(e) || !isString(e.name) || !isRawCopyName(e.name) || !isName(e.versionId)) {
      return bad();
    }
    const fields = "failure" in e ? RAW_HASH_FAILURE_FIELDS : RAW_HASH_DIGEST_FIELDS;
    if (Object.keys(e).length !== fields.length || !fields.every((f) => f in e)) bad();
    if ("failure" in e) {
      if (e.failure !== "size-differs") bad();
    } else if (
      !isCount(e.size) ||
      !isString(e.sha256) ||
      !SHA256_HEX.test(e.sha256) ||
      !isString(e.gitBlobSha1) ||
      !SHA1_HEX.test(e.gitBlobSha1)
    ) {
      bad();
    }
    const at = JSON.stringify([e.name, e.versionId]);
    if (seen.has(at)) bad();
    seen.add(at);
  }
  return x as unknown as RawHashesFile;
}

const RAW_VERIFIED_FIELDS = [
  "version",
  "dataset",
  "verifiedAt",
  "planSha256",
  "rawHashesSha256",
  "gitBlobsSha256",
  "matchedKeys",
  "counts",
];
const RAW_VERIFIED_COUNTS = ["names", "versions", "markers", "matchedRecordings", "matchedOther"];

/**
 * Read raw-verified.json, or refuse: exactly the contract's fields, three sha256 bindings, matched
 * keys that are annex keys, strictly sorted (so none twice), and present exactly when a raw
 * recording was matched, counts that are counts, every version matched one way or the other, and
 * never vacuous (it vouches for at least one raw name).
 */
export function parseRawVerified(text: string): RawVerifiedFile {
  const x = JSON.parse(text) as unknown;
  const bad = (): never => {
    throw new ContractError("raw-verified.json does not match the contract");
  };
  if (!isObject(x)) return bad();
  if (
    Object.keys(x).length !== RAW_VERIFIED_FIELDS.length ||
    !RAW_VERIFIED_FIELDS.every((f) => f in x) ||
    x.version !== 1 ||
    !isName(x.dataset) ||
    !isIsoDate(x.verifiedAt) ||
    ![x.planSha256, x.rawHashesSha256, x.gitBlobsSha256].every(
      (s) => isString(s) && SHA256_HEX.test(s),
    ) ||
    !isObject(x.counts)
  ) {
    return bad();
  }
  const c = x.counts as Record<string, unknown>;
  if (
    Object.keys(c).length !== RAW_VERIFIED_COUNTS.length ||
    !RAW_VERIFIED_COUNTS.every((f) => isCount(c[f]))
  ) {
    return bad();
  }
  const n = c as RawVerifiedFile["counts"];
  if (n.matchedRecordings + n.matchedOther !== n.versions || n.names === 0) bad();
  const keys = x.matchedKeys;
  if (!Array.isArray(keys) || (keys.length === 0) !== (n.matchedRecordings === 0)) return bad();
  let previous: string | undefined;
  for (const k of keys as unknown[]) {
    if (!isString(k) || !ANNEX_KEY.test(k)) return bad();
    if (previous !== undefined && !(previous < k)) bad();
    previous = k;
  }
  return x as unknown as RawVerifiedFile;
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
    !isObject(x.counts) ||
    !Array.isArray(x.stores) ||
    !x.stores.every(isStorePath) ||
    new Set(x.stores).size !== x.stores.length ||
    !Array.isArray(x.allowedMembers) ||
    !x.allowedMembers.every((m) => typeof m === "string" && /^[a-z0-9]+$/.test(m))
  ) {
    throw new ContractError("zarr-verified.json does not match the contract");
  }
  const c = x.counts;
  if (
    !isCount(c.stores) ||
    !isCount(c.docs) ||
    !isCount(c.rewritten) ||
    !isCount(c.untouched) ||
    c.rewritten + c.untouched !== c.docs ||
    c.docs < c.stores ||
    x.stores.length !== c.stores
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

/**
 * Read git-verified.json, or refuse: every field checked, and no field the contract does not name.
 * `allowedTags` is the one optional field, and when present (in a `fresh-clone` proof only, the one
 * mode `--allow-tag` exists in) it is a non-empty, sorted, duplicate-free list of version tags.
 */
export function parseGitVerified(text: string): GitVerifiedFile {
  const x = JSON.parse(text) as unknown;
  const bad = (): never => {
    throw new ContractError("git-verified.json does not match the contract");
  };
  if (!isObject(x)) return bad();
  const keys = Object.keys(x);
  const hasAllowed = "allowedTags" in x;
  if (
    keys.length !== GIT_VERIFIED_FIELDS.length + (hasAllowed ? 1 : 0) ||
    !GIT_VERIFIED_FIELDS.every((f) => f in x)
  ) {
    bad();
  }
  if (hasAllowed) {
    const tags = x.allowedTags;
    if (
      x.mode !== "fresh-clone" ||
      !Array.isArray(tags) ||
      tags.length === 0 ||
      !tags.every((t) => typeof t === "string" && VERSION_TAG.test(t)) ||
      tags.some((t, i) => i > 0 && (tags[i - 1] as string) >= (t as string))
    ) {
      bad();
    }
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

/** A store path as `index.json` names it: relative, no empty or dot segment, ending `.zarr`. */
export function isStorePath(p: unknown): p is string {
  if (typeof p !== "string" || !p.endsWith(".zarr")) return false;
  return p.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");
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
