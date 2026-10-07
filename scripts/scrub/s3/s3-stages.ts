/**
 * Five S3 stages of an in-place scrub: plan, assemble, verify, delete-old and canary. The zarr,
 * drop-archives, zarr-public and raw-verify stages live in `zarr-stage.ts`, `archives-stage.ts`,
 * `zarr-public.ts` and `raw-copies.ts`, and use the helpers exported here.
 *
 * Raw copies (objects under `<id>/objects/` stored by their path, not by an annex key; ADR 0085,
 * amendment of 2026-10-06) are recorded by the plan and deleted by delete-old, every version
 * before every marker, only behind `raw-verified.json` for the plan (`checkRawCopiesProof`), only
 * while every annex key a raw recording matched is still there (`raw-duplicate-missing`), and never
 * one the plan did not record (`checkRawCopiesInBucket`).
 *
 * Each stage reads the previous stage's JSON from a working directory (the contract in
 * `../contract.ts`) and refuses a file that does not match. Every stage is read-only unless it
 * is given `execute`. {@link deleteOldStage} is the only stage that deletes the old objects, and it
 * does so only behind the proofs of the earlier stages: two that name the exact bytes of
 * `assembled.json` they vouch for (`verified.json`, `new-hash-verified.json`), and the proof that a
 * fresh clone of the pushed repository verified (`git-verified.json`, which names the keymap and
 * the plan). `drop-archives` stands behind the same proofs, plus the Zarr stage's
 * (`checkScrubProofs`, `checkZarrProof`). Both evaluate every refusal before they stop
 * (`Refusals`), so one dry run lists them all.
 *
 * **Nothing printed or written here is a participant value.** Output is counts, annex keys, sizes,
 * version ids and fixed words. Header bytes are held in memory and compared, never logged.
 */

import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  EDF_HEADER_BYTES,
  type FindingKind,
  countByKind,
  scanEdfHeader,
} from "../../../shared/identifier-scan";
import {
  ScrubRefused,
  applyHeaderPatch,
  scrubEdfHeader,
  verifyScrub,
} from "../../../shared/identifier-scrub";
import {
  ANNEX_KEY,
  ANNEX_UUID_OBJECT,
  type AssembledFile,
  ContractError,
  type DeletedFile,
  GIT_KEY,
  type HashesFile,
  type KeymapFile,
  type PatchesFile,
  type PlanFile,
  type PlanKey,
  type RawCopy,
  type RawVerifiedFile,
  type VerifiedFile,
  type ZarrVerifiedFile,
  isEdfOrBdf,
  isRawCopyName,
  parseAssembled,
  parseGitVerified,
  parseHashes,
  parseKey,
  parseKeymap,
  parsePatches,
  parsePlan,
  parseRawVerified,
  parseVerified,
  parseZarrVerified,
  patchDigest,
  rawKindOf,
} from "../contract";
import {
  AwsCliError,
  type AwsConfig,
  DATASET_ID,
  EXIT,
  type HeadInfo,
  MIB,
  PLAN_READ_BYTES,
  type PrefixEntry,
  RETAIN_YEARS,
  type S3Ctx,
  StageError,
  TempArea,
  type VersionRef,
  abortMultipart,
  appendAll,
  bytesEqual,
  callsFor,
  completeMultipart,
  countWords,
  createAwsRunner,
  createMultipart,
  deleteVersion,
  deleteVersionBatch,
  deleteVersions,
  failureWord,
  formatWordCounts,
  fromHex,
  getRetention,
  hasCurrentKey,
  headObject,
  isoSeconds,
  listCurrentKeys,
  listKeyVersions,
  listOpenUploads,
  listPrefixVersions,
  objectKey,
  planAssembly,
  putObjectIfMatch,
  putObjectLocked,
  putObjectPlain,
  readRange,
  readWhole,
  readWholeWithMeta,
  retainUntilFrom,
  retentionOk,
  runPool,
  sampleRanges,
  sha256Hex,
  toHex,
  uploadPart,
  uploadPartCopy,
} from "./s3-lib";

export interface CommonOptions extends AwsConfig {
  log: (line: string) => void;
}

export async function withCtx<T>(
  o: CommonOptions,
  bucket: string,
  fn: (ctx: S3Ctx) => Promise<T>,
): Promise<T> {
  const tmp = await TempArea.create();
  try {
    return await fn({ aws: createAwsRunner(o), bucket, tmp });
  } finally {
    await tmp.dispose();
  }
}

// ---------------------------------------------------------------------------
// Working-directory files.
// ---------------------------------------------------------------------------

/** True for the error a read of a file that is not there throws; nothing else is "absent". */
function isNotFound(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

/**
 * A stage file's bytes. `<name>-missing` (refused) only when the file is not there; any other
 * read error (permissions, a directory, I/O) is `<name>-unreadable`, a failure, because a file
 * that is there and cannot be read is not a file that was never written.
 */
export async function readBytes(file: string, name: string): Promise<Buffer> {
  try {
    return await readFile(file);
  } catch (err) {
    if (isNotFound(err)) throw new StageError(`${name}-missing`, EXIT.refused);
    throw new StageError(`${name}-unreadable`, EXIT.failed);
  }
}

/** Parse a stage file's text with the contract's guard; the error is a fixed word. */
export function parseFile<T>(name: string, parse: (text: string) => T, text: string): T {
  try {
    return parse(text);
  } catch (err) {
    if (err instanceof ContractError) throw new StageError(`${name}-invalid`, EXIT.refused);
    throw new StageError(`${name}-unparseable`, EXIT.refused);
  }
}

async function loadFile<T>(dir: string, name: string, parse: (text: string) => T): Promise<T> {
  const bytes = await readBytes(path.join(dir, name), name);
  return parseFile(name, parse, bytes.toString("utf8"));
}

/**
 * Write a stage file atomically: a temp file in the same directory, then a rename, so a reader (or
 * a crash) sees the old file or the whole new one, never half of one. Owner-only.
 */
export async function writeJson(dir: string, name: string, value: unknown): Promise<void> {
  const final = path.join(dir, name);
  const tmp = path.join(dir, `.${name}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`);
  try {
    await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, final);
  } finally {
    await rm(tmp, { force: true });
  }
}

/** True when the file is there. Only ENOENT is "absent"; any other error is a failure. */
async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch (err) {
    if (isNotFound(err)) return false;
    throw new StageError(`${path.basename(file)}-unreadable`, EXIT.failed);
  }
}

export function checkDataset(dataset: string): void {
  if (!DATASET_ID.test(dataset)) throw new StageError("bad-dataset-id", EXIT.usage);
}

/**
 * patches.json must be the one written with this plan: the plan names its sha256. A patches.json
 * from another plan would build new objects whose keys the hashes do not describe.
 */
export function requirePatchesOfPlan(plan: PlanFile, patchesBytes: Buffer): void {
  if (!plan.patchesSha256 || plan.patchesSha256 !== sha256Hex(patchesBytes)) {
    throw new StageError("patches-stale", EXIT.refused);
  }
}

/**
 * Only a complete plan is acted on: one made over every manifest (`partial` is a `--tags` plan)
 * whose every key was read. An unreadable key is one nobody looked at, so a stage that went on
 * would vouch for, or delete around, an object the plan never checked. Every stage after `plan`
 * that reads plan.json asks this first, so the rule is one rule.
 */
export function requireCompletePlan(plan: PlanFile): void {
  if (plan.partial) throw new StageError("plan-partial", EXIT.refused);
  if (plan.totals.unreadable > 0 || plan.keys.some((k) => k.status !== "read")) {
    throw new StageError("plan-has-unreadable", EXIT.refused);
  }
}

/**
 * The refusals of a stage that evaluates every precondition before it refuses, so that one dry
 * run shows the whole list. A stage that stops at its first refusal hides the rest, and when the
 * first one can only be cleared by an irreversible step, the rest show only after it: `delete-old`
 * used to stop at `archives-not-dropped`, so whatever else was wrong appeared only after the
 * archives, which hold the original recordings, were gone.
 *
 * Each refusal is a fixed word and what triggered it (a count, a file name, a tag), in the order
 * the checks ran, which is fixed. A word that fires twice is one entry with both details. The stage
 * then prints one line per word and stops with every word joined by `+` (exit 3), which with one
 * refusal is the word alone, as before.
 */
export class Refusals {
  private readonly found = new Map<string, string[]>();

  add(word: string, detail?: string): void {
    const details = this.found.get(word) ?? [];
    if (detail !== undefined && !details.includes(detail)) details.push(detail);
    this.found.set(word, details);
  }

  /**
   * Run a check that refuses by throwing (exit 3), record its word, and go on. Anything else, a
   * failure (a file that is there and cannot be read), a usage error or an `aws` error, is not a
   * refusal and propagates.
   */
  async attempt<T>(check: () => T | Promise<T>, detail?: string): Promise<T | undefined> {
    try {
      return await check();
    } catch (err) {
      if (err instanceof StageError && err.exitCode === EXIT.refused) {
        this.add(err.word, detail);
        return undefined;
      }
      throw err;
    }
  }

  get any(): boolean {
    return this.found.size > 0;
  }

  /** One line per refusal, then stop with every word. Call it when `any` is true. */
  stop(stage: string, log: (line: string) => void): never {
    for (const [word, details] of this.found) {
      log(`${stage}: refused ${word}${details.length > 0 ? `: ${details.join("; ")}` : ""}`);
    }
    throw new StageError([...this.found.keys()].join("+") || "refused", EXIT.refused);
  }

  /** Stop when any refusal fired; otherwise nothing. */
  stopIfAny(stage: string, log: (line: string) => void): void {
    if (this.any) this.stop(stage, log);
  }
}

// ---------------------------------------------------------------------------
// plan
// ---------------------------------------------------------------------------

export interface PlanOptions extends CommonOptions {
  dataset: string;
  out: string;
  bucket: string;
  /** Manifest tags to plan over; discovered from `<id>/version/` when absent. */
  tags?: string[];
  concurrency: number;
}

const TAG = /^[A-Za-z0-9._+-]+$/;

/**
 * `<id>/version/` holds three kinds of file, all seen in the real bucket: the manifest
 * `<tag>.json`, and two siblings the enrichment jobs write, `<tag>-summary.json` and
 * `<tag>-records.json` (a JSON array, not a manifest). Anything else is refused rather than
 * skipped, because a manifest that is skipped is a set of keys that is never scrubbed.
 */
const MANIFEST_FILE = /^(v\d+\.\d+\.\d+)\.json$/;
const SIDECAR_FILE = /^v\d+\.\d+\.\d+-(summary|records)\.json$/;

/** Tags with a `<id>/version/<tag>.json` manifest. */
async function discoverTags(ctx: S3Ctx, dataset: string): Promise<string[]> {
  const prefix = `${dataset}/version/`;
  const keys = await listCurrentKeys(ctx, prefix);
  const tags: string[] = [];
  for (const k of keys) {
    const name = k.slice(prefix.length);
    const manifest = MANIFEST_FILE.exec(name);
    if (manifest) tags.push(manifest[1] as string);
    else if (!SIDECAR_FILE.test(name))
      throw new StageError("version-dir-unknown-file", EXIT.unreadable);
  }
  return tags.sort();
}

export { isEdfOrBdf };

interface ManifestKeys {
  keys: Set<string>;
  /** Keys of EDF and BDF files kept inline in git (`git:<blob sha>`): no S3 object to scrub. */
  gitInline: Set<string>;
  badKeys: number;
}

/** The distinct keys of the EDF and BDF files of one manifest, sorted into what they are. */
export function keysOfManifest(dataset: string, text: string): ManifestKeys {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new StageError("manifest-malformed", EXIT.unreadable);
  }
  const m = doc as { dataset_id?: unknown; files?: unknown };
  if (typeof m !== "object" || m === null || typeof m.files !== "object" || m.files === null) {
    throw new StageError("manifest-malformed", EXIT.unreadable);
  }
  if (m.dataset_id !== undefined && m.dataset_id !== dataset) {
    throw new StageError("manifest-wrong-dataset", EXIT.unreadable);
  }
  const keys = new Set<string>();
  const gitInline = new Set<string>();
  let badKeys = 0;
  for (const [filePath, entry] of Object.entries(m.files as Record<string, unknown>)) {
    if (!isEdfOrBdf(filePath)) continue;
    const key = (entry as { key?: unknown } | null)?.key;
    if (typeof key !== "string") throw new StageError("manifest-malformed", EXIT.unreadable);
    if (key.startsWith("git:")) {
      if (GIT_KEY.test(key)) gitInline.add(key);
      else badKeys += 1;
      continue;
    }
    try {
      parseKey(key);
      keys.add(key);
    } catch {
      badKeys += 1;
    }
  }
  return { keys, gitInline, badKeys };
}

/** What `<id>/objects/` holds, sorted into what the scrub does with each name. */
export interface ObjectsListing {
  /** The EDF and BDF annex keys, in any letter case. */
  recordings: Set<string>;
  /**
   * Names in the annex key space (`SHA256E-`) that do not parse as an annex key, and names no
   * call can carry (empty, a lone surrogate, or a control character, NUL and carriage return among
   * them: `isRawCopyName`). The plan stops on any (`objects-bad-key`); counted, never printed.
   */
  badKeys: string[];
  /** Every raw copy with every version and delete marker, sorted by name: the plan's `rawCopies`. */
  raw: RawCopy[];
}

/**
 * Sort one listing of every VERSION and DELETE MARKER under `<id>/objects/` (`ListObjectVersions`,
 * not only the current objects) into the three things a name there can be:
 *
 * - an annex key (`SHA256E-s<size>--<sha256><ext>`): an EDF or BDF one is a recording the plan
 *   reads, anything else is not the scrub's business;
 * - exactly {@link ANNEX_UUID_OBJECT}, the special remote's marker: ignored, and never deleted;
 * - any other name is a RAW copy (a file stored by its path, a zero-byte "folder" key ending in
 *   `/` included), recorded with every version (id and size) and every delete marker, in the
 *   listing's order, newest first. A name in the annex key space that does not parse is not one,
 *   nor is a name no call can carry (`isRawCopyName`): each is a bad key.
 *
 * A manifest names the files a version has; the listing finds the ones a manifest does not name (a
 * file dropped from a later version, an older tag nobody listed), and a recording whose current
 * entry is a delete marker still holds its bytes in a noncurrent version, locked.
 */
export function classifyObjects(dataset: string, entries: PrefixEntry[]): ObjectsListing {
  const prefix = `${dataset}/objects/`;
  const recordings = new Set<string>();
  const badKeys = new Set<string>();
  const raw = new Map<string, RawCopy>();
  for (const e of entries) {
    // A listing is a prefix match and returns only keys under it; anything else is a bad answer.
    if (!e.key.startsWith(prefix)) throw new AwsCliError("bad-output", "ListObjectVersions");
    const name = e.key.slice(prefix.length);
    if (name === ANNEX_UUID_OBJECT) continue;
    if (name.startsWith("SHA256E-")) {
      if (!ANNEX_KEY.test(name)) badKeys.add(name);
      else if (isEdfOrBdf(name)) recordings.add(name);
      continue;
    }
    if (!isRawCopyName(name)) {
      badKeys.add(name);
      continue;
    }
    let copy = raw.get(name);
    if (!copy) {
      copy = { name, kind: rawKindOf(name), versions: [], markers: [] };
      raw.set(name, copy);
    }
    if (e.kind === "marker") {
      copy.markers.push(e.versionId);
    } else {
      // A version the listing gives no size for cannot be checked against what raw-hash reads.
      if (e.size === undefined) throw new AwsCliError("bad-output", "ListObjectVersions");
      copy.versions.push({ id: e.versionId, size: e.size });
    }
  }
  const names = [...raw.keys()].sort();
  return {
    recordings,
    badKeys: [...badKeys].sort(),
    raw: names.map((n) => raw.get(n) as RawCopy),
  };
}

/** One listing of `<id>/objects/`, classified. */
async function listObjects(ctx: S3Ctx, dataset: string): Promise<ObjectsListing> {
  return classifyObjects(dataset, await listPrefixVersions(ctx, `${dataset}/objects/`));
}

/** The raw counts a plan line and the totals carry. */
export function rawCounts(raw: readonly RawCopy[]): {
  names: number;
  versions: number;
  markers: number;
} {
  return {
    names: raw.length,
    versions: raw.reduce((n, r) => n + r.versions.length, 0),
    markers: raw.reduce((n, r) => n + r.markers.length, 0),
  };
}

interface PlannedKey {
  entry: PlanKey;
  patchHex?: string;
}

async function planOneKey(ctx: S3Ctx, dataset: string, oldKey: string): Promise<PlannedKey> {
  const keySize = parseKey(oldKey).size;
  const unreadable = (reason: string, versionIds: string[] = []): PlannedKey => ({
    entry: {
      oldKey,
      size: keySize,
      needsScrub: false,
      versionIds,
      reasons: [reason],
      status: "unreadable",
    },
  });
  const obj = objectKey(dataset, oldKey);
  try {
    const listing = await listKeyVersions(ctx, obj);
    const versionIds = [...listing.versions, ...listing.markers].map((v) => v.versionId);
    let head = await headObject(ctx, obj);
    // No current object: masked by a delete marker (its bytes are in a noncurrent version), or
    // gone. The newest version is read by its id; S3 lists a key's versions newest first.
    let pinned: string | undefined;
    if (!head) {
      const newest = listing.versions[0];
      if (!newest) {
        return unreadable(
          listing.markers.length > 0 ? "markers-only" : "HeadObject:not-found",
          versionIds,
        );
      }
      pinned = newest.versionId;
      head = await headObject(ctx, obj, pinned);
      if (!head) return unreadable("HeadObject:not-found", versionIds);
    }
    if (head.size !== keySize) return unreadable("size-mismatch", versionIds);
    const bytes = await readRange(ctx, obj, 0, Math.min(PLAN_READ_BYTES, head.size) - 1, {
      ...(pinned ? { versionId: pinned } : { ifMatch: head.etag }),
    });
    let result: ReturnType<typeof scrubEdfHeader>;
    try {
      result = scrubEdfHeader(bytes);
    } catch (err) {
      if (err instanceof ScrubRefused) return unreadable(err.reason, versionIds);
      throw err;
    }
    const base = { oldKey, size: keySize, versionIds, status: "read" as const };
    if (!result.changed) return { entry: { ...base, needsScrub: false, reasons: [] } };
    // A masked recording that needs a scrub cannot be hashed or assembled from its current
    // object, because it has none: stop, so a person decides (remove the marker and plan again,
    // or delete its versions), rather than leave locked identifying bytes behind.
    if (pinned) return unreadable("masked-needs-scrub", versionIds);
    // The kinds the scrub removed: whatever the scanner finds in the old header that it no
    // longer finds in the new one. Derived from behavior, so it cannot drift from the scrub.
    const before = countByKind(scanEdfHeader(bytes.subarray(0, EDF_HEADER_BYTES)));
    const after = countByKind(scanEdfHeader(result.header));
    const gone = (Object.keys(before) as FindingKind[])
      .filter((k) => (before[k] ?? 0) > (after[k] ?? 0))
      .sort();
    const reasons = gone.length > 0 ? gone : result.fields.map((f) => `${f}-field-rewritten`);
    return {
      entry: { ...base, needsScrub: true, reasons },
      patchHex: toHex(result.header),
    };
  } catch (err) {
    return unreadable(failureWord(err));
  }
}

export async function planStage(o: PlanOptions): Promise<number> {
  checkDataset(o.dataset);
  if (o.tags?.some((t) => !TAG.test(t))) throw new StageError("bad-tag", EXIT.usage);
  await mkdir(o.out, { recursive: true, mode: 0o700 });
  // A re-plan would orphan an assembly that already exists.
  if (await exists(path.join(o.out, "assembled.json"))) {
    throw new StageError("assembled-exists", EXIT.refused);
  }

  return withCtx(o, o.bucket, async (ctx) => {
    const tags = o.tags ?? (await discoverTags(ctx, o.dataset));
    if (tags.length === 0) throw new StageError("no-manifests", EXIT.unreadable);

    const keys = new Set<string>();
    const gitInline = new Set<string>();
    let badKeys = 0;
    for (const tag of tags) {
      let bytes: Uint8Array;
      try {
        bytes = await readWhole(ctx, `${o.dataset}/version/${tag}.json`);
      } catch (err) {
        if (err instanceof AwsCliError && err.code === "not-found") {
          throw new StageError("manifest-missing", EXIT.unreadable);
        }
        throw new StageError("manifest-unreadable", EXIT.unreadable);
      }
      const found = keysOfManifest(o.dataset, Buffer.from(bytes).toString("utf8"));
      for (const k of found.keys) keys.add(k);
      for (const k of found.gitInline) gitInline.add(k);
      badKeys += found.badKeys;
    }
    // A key the contract cannot carry is an object the scrub cannot touch: stop, never skip.
    if (badKeys > 0) {
      o.log(`plan: ${badKeys} manifest entries have a key that is not a SHA256E annex key`);
      throw new StageError("manifest-bad-key", EXIT.unreadable);
    }
    // Then the objects themselves: whatever the manifests name, every recording that is in the
    // bucket is planned too, and every raw copy is recorded with every version and marker.
    const listed = await listObjects(ctx, o.dataset);
    if (listed.badKeys.length > 0) {
      o.log(
        `plan: ${listed.badKeys.length} objects under objects/ have a bad key: in the annex key space (SHA256E-) but not a SHA256E annex key, or a name no S3 call can carry (a control character)`,
      );
      throw new StageError("objects-bad-key", EXIT.unreadable);
    }
    for (const k of listed.recordings) keys.add(k);

    const sorted = [...keys].sort();
    const planned = await runPool(sorted, o.concurrency, (k) => planOneKey(ctx, o.dataset, k));
    const entries = planned.map((p) => (p as PlannedKey).entry);
    // A recording kept inline in git has no object to read, so the scrub of its header would have
    // to happen in the git history and the plan cannot vouch for it: it is recorded, unread.
    for (const k of [...gitInline].sort()) {
      entries.push({
        oldKey: k,
        size: 0,
        needsScrub: false,
        versionIds: [],
        reasons: ["git-inline-recording"],
        status: "unreadable",
      });
    }
    const patches: PatchesFile = {};
    for (const p of planned) {
      const pk = p as PlannedKey;
      if (pk.patchHex) patches[pk.entry.oldKey] = pk.patchHex;
    }
    const raw = rawCounts(listed.raw);
    const totals: PlanFile["totals"] = {
      keys: entries.length,
      needScrub: entries.filter((e) => e.needsScrub).length,
      bytesToHash: entries.filter((e) => e.needsScrub).reduce((n, e) => n + e.size, 0),
      unreadable: entries.filter((e) => e.status === "unreadable").length,
      // Only a plan that has raw copies carries their counts, so one without is the file it was.
      ...(raw.names > 0
        ? { rawCopyNames: raw.names, rawCopyVersions: raw.versions, rawCopyMarkers: raw.markers }
        : {}),
    };
    const plan: PlanFile = {
      version: 1,
      dataset: o.dataset,
      bucket: o.bucket,
      tags,
      ...(o.tags ? { partial: true } : {}),
      createdAt: new Date().toISOString(),
      keys: entries,
      ...(raw.names > 0 ? { rawCopies: listed.raw } : {}),
      totals,
    };
    // patches.json first, so the plan can name its exact bytes.
    await writeJson(o.out, "patches.json", patches);
    const patchesBytes = await readBytes(path.join(o.out, "patches.json"), "patches.json");
    plan.patchesSha256 = sha256Hex(patchesBytes);
    await writeJson(o.out, "plan.json", plan);

    // The raw counts are on the line whatever they are, so the screen from inside after the
    // deletion (runbook step 16) reads `rawCopies=0 versions=0 markers=0` rather than nothing.
    o.log(
      `plan: tags=${tags.length} keys=${totals.keys} needScrub=${totals.needScrub} bytesToHash=${totals.bytesToHash} unreadable=${totals.unreadable} rawCopies=${raw.names} versions=${raw.versions} markers=${raw.markers}`,
    );
    if (raw.names > 0) {
      const kinds = countWords(listed.raw.map((r) => r.kind));
      o.log(
        `plan: raw copies under objects/ by kind: recording=${kinds.recording ?? 0} other=${kinds.other ?? 0}; raw-hash and raw-verify must pass before delete-old (runbook step 5b)`,
      );
    }
    if (plan.partial) {
      o.log("plan: partial (--tags): assemble, verify and delete-old will refuse this plan");
    }
    if (totals.unreadable > 0) {
      const words = entries.filter((e) => e.status === "unreadable").flatMap((e) => e.reasons);
      o.log(`plan: unreadable by reason: ${formatWordCounts(countWords(words))}`);
      o.log("plan: incomplete; no later stage may run on this plan");
      return EXIT.unreadable;
    }
    return 0;
  });
}

// ---------------------------------------------------------------------------
// assemble
// ---------------------------------------------------------------------------

export interface AssembleOptions extends CommonOptions {
  dir: string;
  execute: boolean;
  concurrency: number;
  /** Largest `upload-part-copy` range; 4 GiB in production, smaller in tests. */
  maxCopyPart: number;
}

interface Work {
  oldKey: string;
  newKey: string;
  size: number;
  patch: Uint8Array;
}

interface AssembleInputs {
  plan: PlanFile;
  work: Work[];
}

/** Every precondition of an assembly, as refusals. Shared by the dry run and the real run. */
export async function loadAssembleInputs(dir: string): Promise<AssembleInputs> {
  const plan = await loadFile(dir, "plan.json", parsePlan);
  const hashes: HashesFile = await loadFile(dir, "hashes.json", parseHashes);
  const patchesBytes = await readBytes(path.join(dir, "patches.json"), "patches.json");
  const patches: PatchesFile = parseFile(
    "patches.json",
    parsePatches,
    patchesBytes.toString("utf8"),
  );

  requireCompletePlan(plan);
  requirePatchesOfPlan(plan, patchesBytes);
  if (hashes.dataset !== plan.dataset) throw new StageError("hashes-wrong-dataset", EXIT.refused);

  const needing = plan.keys.filter((k) => k.needsScrub);
  const oldKeys = new Set(plan.keys.map((k) => k.oldKey));
  const work: Work[] = [];
  const seenNew = new Set<string>();
  for (const k of needing) {
    const h = hashes.entries[k.oldKey];
    if (!h) throw new StageError("hashes-incomplete", EXIT.refused);
    if (h.sourceSha256Verified !== true) throw new StageError("source-not-verified", EXIT.refused);
    const hex = patches[k.oldKey];
    if (!hex) throw new StageError("patches-incomplete", EXIT.refused);
    // The new key is the hash of the original WITH this patch, so a hash computed for another
    // patch names bytes this assembly would not produce.
    if (h.patchSha256 !== patchDigest(hex)) throw new StageError("hashes-stale", EXIT.refused);
    const size = parseKey(k.oldKey).size;
    if (k.size !== size || h.size !== size) throw new StageError("size-mismatch", EXIT.refused);
    if (oldKeys.has(h.newKey)) throw new StageError("new-key-is-an-old-key", EXIT.refused);
    if (seenNew.has(h.newKey)) throw new StageError("duplicate-new-key", EXIT.refused);
    seenNew.add(h.newKey);
    work.push({ oldKey: k.oldKey, newKey: h.newKey, size, patch: fromHex(hex) });
  }
  work.sort((a, b) => a.oldKey.localeCompare(b.oldKey));
  return { plan, work };
}

interface AssembledEntry {
  newKey: string;
  newVersionId: string;
  retainUntil: string;
  mode: "GOVERNANCE";
}

type HowAssembled = "put" | "multipart" | "skipped";

/** An existing object at the new key is acceptable only if it is exactly what assembly makes. */
async function matchesExpected(
  ctx: S3Ctx,
  newObj: string,
  existing: HeadInfo,
  w: Work,
): Promise<boolean> {
  if (existing.size !== w.size || !existing.versionId) return false;
  if (!retentionOk(existing.lockMode, existing.retainUntil)) return false;
  const header = await readRange(ctx, newObj, 0, EDF_HEADER_BYTES - 1, {
    versionId: existing.versionId,
  });
  return bytesEqual(header, w.patch);
}

function patched(data: Uint8Array, patch: Uint8Array): Uint8Array {
  try {
    return applyHeaderPatch(data, patch);
  } catch {
    throw new StageError("patch-refused");
  }
}

async function assembleOne(
  ctx: S3Ctx,
  dataset: string,
  w: Work,
  maxCopyPart: number,
  log: (line: string) => void,
): Promise<{ entry: AssembledEntry; how: HowAssembled }> {
  const oldObj = objectKey(dataset, w.oldKey);
  const newObj = objectKey(dataset, w.newKey);
  const entryOf = (h: HeadInfo): AssembledEntry => {
    if (!h.versionId || !h.retainUntil) throw new StageError("new-object-unlocked");
    return {
      newKey: w.newKey,
      newVersionId: h.versionId,
      retainUntil: h.retainUntil,
      mode: "GOVERNANCE",
    };
  };

  const src = await headObject(ctx, oldObj);
  if (!src) throw new StageError("source-missing");
  if (src.size !== w.size) throw new StageError("source-size-mismatch");

  const existing = await headObject(ctx, newObj);
  if (existing) {
    if (await matchesExpected(ctx, newObj, existing, w)) {
      return { entry: entryOf(existing), how: "skipped" };
    }
    throw new StageError("new-key-conflict");
  }

  const layout = planAssembly(w.size, maxCopyPart);
  const meta = { contentType: src.contentType, sse: src.sse, kmsKeyId: src.kmsKeyId };
  const retainUntil = retainUntilFrom(new Date(), RETAIN_YEARS);

  if (layout.mode === "put") {
    const data = await readRange(ctx, oldObj, 0, w.size - 1, { ifMatch: src.etag });
    const body = ctx.tmp.file();
    try {
      await writeFile(body, patched(data, w.patch), { mode: 0o600 });
      await putObjectLocked(ctx, newObj, body, meta, retainUntil);
    } finally {
      await ctx.tmp.remove(body);
    }
  } else {
    let uploadId: string | undefined;
    try {
      uploadId = await createMultipart(ctx, newObj, meta, retainUntil).catch(async (err) => {
        // The create may have happened with its answer lost (a timeout, a dropped connection):
        // an upload created with the lock parameters, billed until aborted. Report it by key and
        // upload id (neither identifies anyone), never silently.
        const open = await listOpenUploads(ctx, newObj).catch(() => null);
        if (open === null) {
          log(
            `assemble: create-multipart-upload failed and the open uploads of ${w.newKey} could not be listed: check list-multipart-uploads`,
          );
        } else {
          for (const id of open)
            log(`assemble: open upload left by a failed create: key=${w.newKey} uploadId=${id}`);
        }
        throw new StageError(
          `${failureWord(err)}${open === null || open.length > 0 ? "+upload-may-be-open" : ""}`,
        );
      });
      const done: Array<{ ETag: string; PartNumber: number }> = [];
      for (const p of layout.parts) {
        if (p.kind === "upload") {
          const data = await readRange(ctx, oldObj, p.start, p.end, { ifMatch: src.etag });
          const body = ctx.tmp.file();
          try {
            await writeFile(body, patched(data, w.patch), { mode: 0o600 });
            done.push({
              ETag: await uploadPart(ctx, newObj, uploadId, p.number, body),
              PartNumber: p.number,
            });
          } finally {
            await ctx.tmp.remove(body);
          }
        } else {
          const etag = await uploadPartCopy(ctx, newObj, uploadId, p.number, {
            key: oldObj,
            etag: src.etag,
            start: p.start,
            end: p.end,
          });
          done.push({ ETag: etag, PartNumber: p.number });
        }
      }
      await completeMultipart(ctx, newObj, uploadId, done);
    } catch (err) {
      if (uploadId) {
        try {
          await abortMultipart(ctx, newObj, uploadId);
        } catch (abortErr) {
          log(
            `assemble: abort-failed key=${w.newKey} uploadId=${uploadId} (${failureWord(abortErr)})`,
          );
          throw new StageError(`${failureWord(err)}+abort-failed`);
        }
      }
      throw err;
    }
  }

  // The object must now exist at the right size with its lock; anything else is a failure.
  const made = await headObject(ctx, newObj);
  if (!made) throw new StageError("new-object-missing");
  if (made.size !== w.size) throw new StageError("new-size-mismatch");
  if (!retentionOk(made.lockMode, made.retainUntil)) throw new StageError("new-object-unlocked");
  return { entry: entryOf(made), how: layout.mode };
}

const fmt = (n: number) => n.toLocaleString("en-US");

export async function assembleStage(o: AssembleOptions): Promise<number> {
  const { plan, work } = await loadAssembleInputs(o.dir);

  if (!o.execute) {
    let uploaded = 0;
    let copied = 0;
    let puts = 0;
    let multiparts = 0;
    let parts = 0;
    const calls: Record<string, number> = {};
    for (const w of work) {
      const layout = planAssembly(w.size, o.maxCopyPart);
      uploaded += layout.uploadedBytes;
      copied += layout.copiedBytes;
      if (layout.mode === "put") puts += 1;
      else multiparts += 1;
      parts += layout.parts.length;
      for (const [op, n] of Object.entries(callsFor(layout))) calls[op] = (calls[op] ?? 0) + n;
    }
    o.log(`assemble dry run (no S3 calls made): dataset=${plan.dataset} bucket=${plan.bucket}`);
    o.log(
      `  objects: ${work.length} (single put ${puts}, multipart ${multiparts}, parts ${parts})`,
    );
    o.log(`  bytes uploaded: ${fmt(uploaded)}; bytes copied server side: ${fmt(copied)}`);
    o.log(`  S3 calls, at most: ${formatWordCounts(calls)}`);
    o.log("  nothing is deleted by this stage");
    return 0;
  }

  return withCtx(o, plan.bucket, async (ctx) => {
    const entries: Record<string, AssembledEntry> = {};
    const hows: HowAssembled[] = [];
    const failures: string[] = [];
    await runPool(
      work,
      o.concurrency,
      async (w) => {
        try {
          const r = await assembleOne(ctx, plan.dataset, w, o.maxCopyPart, o.log);
          entries[w.oldKey] = r.entry;
          hows.push(r.how);
        } catch (err) {
          failures.push(failureWord(err));
        }
      },
      // The first failure stops new work; in-flight objects finish, and a re-run resumes.
      () => failures.length > 0,
    );

    if (failures.length > 0) {
      o.log(
        `assemble: FAILED ${failures.length} of ${work.length} objects started (${formatWordCounts(countWords(failures))}); assembled=${hows.length}`,
      );
      o.log("assemble: assembled.json and keymap.json NOT written; a re-run resumes idempotently");
      return EXIT.failed;
    }

    const sortedEntries: Record<string, AssembledEntry> = {};
    const keymap: KeymapFile = {};
    for (const w of work) {
      sortedEntries[w.oldKey] = entries[w.oldKey] as AssembledEntry;
      keymap[w.oldKey] = w.newKey;
    }
    const assembled: AssembledFile = {
      version: 1,
      dataset: plan.dataset,
      bucket: plan.bucket,
      entries: sortedEntries,
    };
    await writeJson(o.dir, "assembled.json", assembled);
    await writeJson(o.dir, "keymap.json", keymap);
    const count = (h: HowAssembled) => hows.filter((x) => x === h).length;
    o.log(
      `assemble: objects=${work.length} put=${count("put")} multipart=${count("multipart")} skipped=${count("skipped")}`,
    );
    return 0;
  });
}

// ---------------------------------------------------------------------------
// verify
// ---------------------------------------------------------------------------

export interface VerifyOptions extends CommonOptions {
  dir: string;
  concurrency: number;
  /** Evenly spaced comparison windows per object (plus the final window). */
  samples: number;
}

interface VerifiedKey {
  words: string[];
  headersChecked: number;
  rangesCompared: number;
}

async function verifyOne(
  ctx: S3Ctx,
  dataset: string,
  oldKey: string,
  e: AssembledFile["entries"][string],
  patch: Uint8Array,
  samples: number,
): Promise<VerifiedKey> {
  const words: string[] = [];
  const result: VerifiedKey = { words, headersChecked: 0, rangesCompared: 0 };
  const size = parseKey(oldKey).size;
  const oldObj = objectKey(dataset, oldKey);
  const newObj = objectKey(dataset, e.newKey);
  const pinned = { versionId: e.newVersionId };
  try {
    const head = await headObject(ctx, newObj, e.newVersionId);
    if (!head) return { ...result, words: ["new-missing"] };
    // The version that was assembled must be what a reader gets: a newer version at the new key
    // was written by someone else after assembly, and it is what would be served.
    const current = await headObject(ctx, newObj);
    if (current?.versionId !== e.newVersionId) words.push("new-not-current");
    if (head.size !== size) words.push("new-size-mismatch");
    if (head.lockMode !== "GOVERNANCE") words.push("lock-missing");
    const ret = await getRetention(ctx, newObj, e.newVersionId);
    if (!ret) words.push("retention-missing");
    else if (!retentionOk(ret.mode, ret.retainUntil)) words.push("retention-short");
    if (head.size !== size) return { ...result, words };

    let oldHeader: Uint8Array;
    try {
      oldHeader = await readRange(ctx, oldObj, 0, EDF_HEADER_BYTES - 1);
    } catch (err) {
      return { ...result, words: [...words, `old-unreadable:${failureWord(err)}`] };
    }
    const newHeader = await readRange(ctx, newObj, 0, EDF_HEADER_BYTES - 1, pinned);
    result.headersChecked = 1;
    if (!bytesEqual(newHeader, patch)) words.push("header-not-patch");
    const verdict = verifyScrub(oldHeader, newHeader);
    if (!verdict.ok) for (const r of verdict.reasons) words.push(`scrub:${r}`);

    for (const [a, b] of sampleRanges(size, samples)) {
      const [was, now] = await Promise.all([
        readRange(ctx, oldObj, a, b),
        readRange(ctx, newObj, a, b, pinned),
      ]);
      result.rangesCompared += 1;
      if (!bytesEqual(was, now)) words.push("range-mismatch");
    }
  } catch (err) {
    words.push(failureWord(err));
  }
  return result;
}

export async function verifyStage(o: VerifyOptions): Promise<number> {
  const plan = await loadFile(o.dir, "plan.json", parsePlan);
  requireCompletePlan(plan);
  const assembledBytes = await readBytes(path.join(o.dir, "assembled.json"), "assembled.json");
  const assembled = parseFile("assembled.json", parseAssembled, assembledBytes.toString("utf8"));
  const patchesBytes = await readBytes(path.join(o.dir, "patches.json"), "patches.json");
  const patches = parseFile("patches.json", parsePatches, patchesBytes.toString("utf8"));
  const keymap = await loadFile(o.dir, "keymap.json", parseKeymap);
  requirePatchesOfPlan(plan, patchesBytes);

  if (assembled.dataset !== plan.dataset) {
    throw new StageError("assembled-wrong-dataset", EXIT.refused);
  }
  if (assembled.bucket !== plan.bucket) {
    throw new StageError("assembled-wrong-bucket", EXIT.refused);
  }
  const needing = plan.keys.filter((k) => k.needsScrub).map((k) => k.oldKey);
  const have = Object.keys(assembled.entries);
  if (needing.some((k) => !assembled.entries[k])) {
    throw new StageError("assembled-incomplete", EXIT.refused);
  }
  if (have.some((k) => !needing.includes(k))) {
    throw new StageError("assembled-has-unplanned-key", EXIT.refused);
  }
  for (const k of have) {
    if (keymap[k] !== (assembled.entries[k] as { newKey: string }).newKey) {
      throw new StageError("keymap-mismatch", EXIT.refused);
    }
    if (!patches[k]) throw new StageError("patches-incomplete", EXIT.refused);
  }
  if (Object.keys(keymap).length !== have.length) {
    throw new StageError("keymap-mismatch", EXIT.refused);
  }

  // A proof from an earlier pass must not outlive a pass that fails.
  const verifiedPath = path.join(o.dir, "verified.json");
  await rm(verifiedPath, { force: true });

  return withCtx(o, assembled.bucket, async (ctx) => {
    const sorted = [...have].sort();
    const out = await runPool(sorted, o.concurrency, (k) =>
      verifyOne(
        ctx,
        assembled.dataset,
        k,
        assembled.entries[k] as AssembledFile["entries"][string],
        fromHex(patches[k] as string),
        o.samples,
      ),
    );
    const results = out as VerifiedKey[];
    const words = results.flatMap((r) => r.words);
    const counts = {
      keys: sorted.length,
      headersChecked: results.reduce((n, r) => n + r.headersChecked, 0),
      rangesCompared: results.reduce((n, r) => n + r.rangesCompared, 0),
    };
    if (words.length > 0) {
      o.log(
        `verify: FAILED keys=${counts.keys} failures=${words.length} (${formatWordCounts(countWords(words))})`,
      );
      o.log("verify: verified.json NOT written");
      return EXIT.failed;
    }
    const proof: VerifiedFile = {
      version: 1,
      dataset: assembled.dataset,
      verifiedAt: new Date().toISOString(),
      assembledSha256: sha256Hex(assembledBytes),
      counts,
    };
    await writeJson(o.dir, "verified.json", proof);
    o.log(
      `verify: ok keys=${counts.keys} headersChecked=${counts.headersChecked} rangesCompared=${counts.rangesCompared}`,
    );
    return 0;
  });
}

// ---------------------------------------------------------------------------
// delete-old
// ---------------------------------------------------------------------------

export interface DeleteOptions extends CommonOptions {
  dir: string;
  execute: boolean;
  /** The dataset id, typed again by the operator; must equal the plan's. Required, dry run too. */
  confirmDataset: string;
  /**
   * Where an anonymous reader reaches the bucket, for the one request that proves the dataset is
   * private. No credentials are ever sent to it. Tests point it at a local server.
   */
  publicBase: string;
  /** Proof from the verify stage; a path, relative to `dir` unless absolute. */
  verifiedFile: string;
  /** Proof from the separate re-hash stage on another host. */
  hashVerifiedFile: string;
  /** `git-verified.json` from `git-scrub verify --fresh-clone`: the pushed history is clean. */
  gitVerifiedFile: string;
  /** Refuse when more versions than this would be deleted. Default: what the plan recorded. */
  maxDelete?: number;
  /** Refuse when more noncurrent versions than this would be pruned. */
  maxPrune: number;
  /** Prefixes under `<dataset>/` whose NONCURRENT versions and markers are also deleted. */
  prune: string[];
  concurrency: number;
}

/** `new-hash-verified.json`, written by the Python stage that re-hashes the new objects. */
export interface HashVerifiedFile {
  version: 1;
  dataset: string;
  assembledSha256: string;
  count: number;
}

export function parseHashVerified(text: string): HashVerifiedFile {
  const x = JSON.parse(text) as Record<string, unknown>;
  if (
    typeof x !== "object" ||
    x === null ||
    Array.isArray(x) ||
    x.version !== 1 ||
    typeof x.dataset !== "string" ||
    x.dataset === "" ||
    typeof x.assembledSha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(x.assembledSha256) ||
    typeof x.count !== "number" ||
    !Number.isSafeInteger(x.count) ||
    x.count < 0
  ) {
    throw new ContractError("new-hash-verified.json does not match the contract");
  }
  return x as unknown as HashVerifiedFile;
}

export type { DeletedFile } from "../contract";

interface KeyVersions {
  oldKey: string;
  obj: string;
  versions: string[];
  markers: string[];
  /** The size of each version (not of a marker), as the listing reported it. */
  sizes: Array<number | undefined>;
}

/**
 * The only prefixes a prune may name, as the directory under `<dataset>/`: the manifests, the
 * archives and the Zarr serving copy. An ALLOW-list on purpose. A deny-list ("anything but
 * `objects/`") lets `<dataset>/` itself through, which covers `objects/`, and `<dataset>//objects/`,
 * which S3 treats as a different key space from `objects/` but a reader may not.
 */
const PRUNE_DIRS = ["version", "archives", "zarr"] as const;

/** A prune prefix is exactly `<dataset>/version/`, `<dataset>/archives/` or `<dataset>/zarr/`. */
export function checkPrunePrefix(dataset: string, prefix: string): void {
  if (!PRUNE_DIRS.some((d) => prefix === `${dataset}/${d}/`)) {
    throw new StageError("bad-prune-prefix", EXIT.refused);
  }
}

async function listOldKeys(
  ctx: S3Ctx,
  dataset: string,
  oldKeys: string[],
  concurrency: number,
): Promise<KeyVersions[]> {
  const out = await runPool(oldKeys, concurrency, async (oldKey) => {
    const obj = objectKey(dataset, oldKey);
    const l = await listKeyVersions(ctx, obj);
    return {
      oldKey,
      obj,
      versions: l.versions.map((v) => v.versionId),
      markers: l.markers.map((v) => v.versionId),
      sizes: l.versions.map((v) => v.size),
    };
  });
  return out as KeyVersions[];
}

/** Where the proofs of the earlier stages are: relative to the working directory unless absolute. */
export interface ProofFiles {
  /** `verified.json`, from the verify stage (runbook step 5). */
  verifiedFile: string;
  /** `new-hash-verified.json`, from the re-hash of the new objects on the hash host (step 5). */
  hashVerifiedFile: string;
  /** `git-verified.json` from `git-scrub verify --fresh-clone` (step 14). */
  gitVerifiedFile: string;
}

/** The assembly the proofs vouch for, as `checkScrubProofs` read it. */
export interface ProvenAssembly {
  /** sha256 of the exact bytes of assembled.json. */
  sha: string;
  entries: Array<[string, AssembledFile["entries"][string]]>;
  /** The old keys, sorted. */
  oldKeys: string[];
  newKeys: Set<string>;
  /** The plan's keys by old key. */
  planned: Map<string, PlanKey>;
}

/**
 * Every proof in the working directory that the irreversible S3 steps stand on, each bound to this
 * plan the way the stage that wrote it binds it:
 *
 * - `assembled.json` names the plan's dataset and bucket, maps every old key to a different new
 *   key, and holds only keys the plan marked for a scrub;
 * - `verified.json` and `new-hash-verified.json` name the exact bytes of `assembled.json`, this
 *   dataset, and its number of entries;
 * - `git-verified.json` is a verify of a FRESH clone of what was pushed, for this dataset, made
 *   with this `keymap.json` and this `plan.json` (and with the `git-plan.json` in the working
 *   directory, when there is one), and that keymap is this assembly's, pair for pair.
 *
 * `drop-archives` (runbook step 15a) and `delete-old` (step 15b) both ask this, so the rule is one
 * rule. Every check runs and records its refusal; a check whose file could not be read or parsed
 * does not run, because that file's own refusal already stands. A file that is there and cannot be
 * read is a failure (exit 1), not a refusal, and stops at once. Returns the assembly when
 * `assembled.json` was read.
 */
export async function checkScrubProofs(
  dir: string,
  plan: PlanFile,
  planBytes: Buffer,
  files: ProofFiles,
  refusals: Refusals,
): Promise<ProvenAssembly | undefined> {
  const dataset = plan.dataset;
  const load = <T>(file: string, name: string, parse: (text: string) => T) =>
    refusals.attempt(async () => {
      const bytes = await readBytes(path.resolve(dir, file), name);
      return { bytes, value: parseFile(name, parse, bytes.toString("utf8")) };
    });

  const assembled = await load("assembled.json", "assembled.json", parseAssembled);
  if (assembled && assembled.value.dataset !== dataset) refusals.add("assembled-wrong-dataset");
  if (assembled && assembled.value.bucket !== plan.bucket) refusals.add("assembled-wrong-bucket");
  const sha = assembled ? sha256Hex(assembled.bytes) : undefined;
  const entries = assembled ? Object.entries(assembled.value.entries) : undefined;

  // Both S3 proofs must exist and vouch for these exact bytes.
  const verified = await load(files.verifiedFile, "verified.json", parseVerified);
  const hashVerified = await load(
    files.hashVerifiedFile,
    "new-hash-verified.json",
    parseHashVerified,
  );
  if (verified && sha !== undefined && verified.value.assembledSha256 !== sha) {
    refusals.add("verified-stale", "verified.json names other bytes than assembled.json");
  }
  if (hashVerified && sha !== undefined && hashVerified.value.assembledSha256 !== sha) {
    refusals.add(
      "new-hash-verified-stale",
      "new-hash-verified.json names other bytes than assembled.json",
    );
  }
  if (verified && verified.value.dataset !== dataset) {
    refusals.add("proof-wrong-dataset", path.basename(files.verifiedFile));
  }
  if (hashVerified && hashVerified.value.dataset !== dataset) {
    refusals.add("proof-wrong-dataset", path.basename(files.hashVerifiedFile));
  }
  if (
    entries &&
    ((verified && verified.value.counts.keys !== entries.length) ||
      (hashVerified && hashVerified.value.count !== entries.length))
  ) {
    refusals.add(
      "proof-count-mismatch",
      `assembled.json has ${entries.length} entries, verified.json ${verified?.value.counts.keys ?? "-"}, new-hash-verified.json ${hashVerified?.value.count ?? "-"}`,
    );
  }

  // The GitHub side: a verify of a FRESH clone of what was pushed, made with the keymap this
  // assembly wrote and the plan this run reads.
  const gitVerified = await load(files.gitVerifiedFile, "git-proof", parseGitVerified);
  const keymap = await load("keymap.json", "keymap.json", parseKeymap);
  if (gitVerified) {
    const git = gitVerified.value;
    if (git.dataset !== dataset) {
      refusals.add("proof-wrong-dataset", path.basename(files.gitVerifiedFile));
    }
    const stale: string[] = [];
    if (git.mode !== "fresh-clone") stale.push(`mode ${git.mode}, not fresh-clone`);
    if (keymap && git.keymapSha256 !== sha256Hex(keymap.bytes)) {
      stale.push("names another keymap.json");
    }
    if (git.s3PlanSha256 !== sha256Hex(planBytes)) stale.push("names another plan.json");
    // The git plan is not a file these stages need, so only one in the working directory (runbook
    // step 2 writes it there) is compared: a proof made with another git plan proved other edits.
    const gitPlanBytes = await readBytes(path.resolve(dir, "git-plan.json"), "git-plan.json").catch(
      (err: unknown) => {
        if (err instanceof StageError && err.word === "git-plan.json-missing") return undefined;
        throw err;
      },
    );
    if (gitPlanBytes && git.gitPlanSha256 !== sha256Hex(gitPlanBytes)) {
      stale.push("names another git-plan.json");
    }
    if (stale.length > 0) refusals.add("git-proof-stale", stale.join(", "));
  }

  if (sha === undefined || entries === undefined) return undefined;
  // Every old key has a different new key, and no old key is any new key.
  const oldKeys = entries.map(([k]) => k).sort();
  const newKeys = new Set(entries.map(([, e]) => e.newKey));
  if (newKeys.size !== entries.length) {
    refusals.add("duplicate-new-key", `${entries.length - newKeys.size} new keys repeated`);
  }
  const selfMapped = entries.filter(([k, e]) => e.newKey === k).length;
  if (selfMapped > 0) refusals.add("new-key-equals-old-key", `${selfMapped} entries`);
  const chained = oldKeys.filter((k) => newKeys.has(k)).length;
  if (chained > 0) refusals.add("old-key-is-a-new-key", `${chained} old keys`);
  const planned = new Map(plan.keys.map((k) => [k.oldKey, k]));
  const notPlanned = oldKeys.filter((k) => !planned.get(k)?.needsScrub).length;
  if (notPlanned > 0) {
    refusals.add(
      "assembled-not-in-plan",
      `${notPlanned} old keys the plan did not mark for a scrub`,
    );
  }
  // The keymap the git proof names is this assembly's: old key to new key, pair for pair.
  if (keymap) {
    const pairs = keymap.value;
    const differ = entries.filter(([k, e]) => pairs[k] !== e.newKey).length;
    if (Object.keys(pairs).length !== entries.length || differ > 0) {
      refusals.add(
        "keymap-mismatch",
        `keymap.json has ${Object.keys(pairs).length} pairs, assembled.json ${entries.length} entries, ${differ} differ`,
      );
    }
  }
  return { sha, entries, oldKeys, newKeys, planned };
}

/**
 * Every CURRENT manifest must already name only new keys: the manifests are regenerated after
 * the tags move (runbook step 12), and a manifest still naming an old key would serve a key that
 * is about to stop existing. Tags are discovered now, not taken from the plan, so a manifest
 * written since the plan is read too.
 *
 * And every EDF or BDF a manifest names must be one this scrub accounted for (`known`: a key the
 * plan read, or a new key it assembled). A recording that appeared since the plan, a recording
 * kept inline in git, or a key that is not an annex key is one nobody checked.
 *
 * Every manifest is read, and each refusal names the tag that triggered it. A delete refuses
 * where the plan stage would have stopped (an unknown file under `version/`, a malformed manifest).
 */
async function checkManifests(
  ctx: S3Ctx,
  dataset: string,
  oldKeys: Set<string>,
  known: Set<string>,
  refusals: Refusals,
): Promise<void> {
  let tags: string[];
  try {
    tags = await discoverTags(ctx, dataset);
  } catch (err) {
    if (!(err instanceof StageError)) throw err;
    refusals.add(err.word, "version/");
    return;
  }
  if (tags.length === 0) {
    refusals.add("no-manifests", "no current manifest under version/");
    return;
  }
  for (const tag of tags) {
    let bytes: Uint8Array;
    try {
      bytes = await readWhole(ctx, `${dataset}/version/${tag}.json`);
    } catch {
      refusals.add("manifest-unreadable", tag);
      continue;
    }
    let found: ManifestKeys;
    try {
      found = keysOfManifest(dataset, Buffer.from(bytes).toString("utf8"));
    } catch (err) {
      if (!(err instanceof StageError)) throw err;
      refusals.add(err.word, tag);
      continue;
    }
    const old = [...found.keys].filter((k) => oldKeys.has(k)).length;
    if (old > 0) refusals.add("manifest-names-old-key", `${tag} names ${old}`);
    const unplanned =
      found.badKeys + found.gitInline.size + [...found.keys].filter((k) => !known.has(k)).length;
    if (unplanned > 0) refusals.add("manifest-names-unplanned-key", `${tag} names ${unplanned}`);
  }
}

/**
 * Every EDF or BDF object under `<id>/objects/` (any letter case) must be one this scrub
 * accounted for: an annex key the plan read or the assembly made, or a raw recording the plan
 * recorded (whose versions {@link checkRawCopiesInBucket} checks). One that appeared after the
 * plan was never read, so its header was never checked, and deleting the old keys around it would
 * leave it as the dataset's only unchecked copy. A name in the annex key space that is no annex
 * key is counted here when it ends like a recording, and is `objects-bad-key` otherwise, where the
 * plan stage would have stopped.
 */
function checkUnplannedRecordings(
  listed: ObjectsListing,
  known: Set<string>,
  plannedRaw: ReadonlyMap<string, RawCopy>,
  refusals: Refusals,
): void {
  const badRecordings = listed.badKeys.filter(isEdfOrBdf).length;
  const unplanned =
    badRecordings +
    listed.raw.filter((r) => r.kind === "recording" && !plannedRaw.has(r.name)).length +
    [...listed.recordings].filter((k) => !known.has(k)).length;
  if (unplanned > 0) {
    refusals.add(
      "unplanned-recording",
      `${unplanned} recordings under objects/ are not in the plan or the assembly`,
    );
  }
  const badOther = listed.badKeys.length - badRecordings;
  if (badOther > 0) {
    refusals.add(
      "objects-bad-key",
      `${badOther} objects under objects/ have a bad key (not an annex key in the annex key space, or a control character)`,
    );
  }
}

/** What delete-old removes of the raw copies: every version first, then every delete marker. */
interface RawDeletion {
  versions: VersionRef[];
  markers: VersionRef[];
  /** Raw names with anything to delete. */
  names: number;
}

/**
 * The raw copies under `<id>/objects/` as the bucket holds them now, against what the plan
 * recorded. Only what the plan recorded may be deleted: the proof of `raw-verify` is about those
 * versions, by id and size, and a version written since is bytes nobody compared. So
 * `raw-copy-not-in-plan` counts every version or marker of a raw name the plan did not record (a
 * version whose size is not the one recorded included) and every entry of a raw name the plan did
 * not list at all, except a raw RECORDING the plan did not list, which is `unplanned-recording`
 * ({@link checkUnplannedRecordings}), so one object is never two refusals. Returns what may go.
 */
function checkRawCopiesInBucket(
  dataset: string,
  listed: ObjectsListing,
  plannedRaw: ReadonlyMap<string, RawCopy>,
  refusals: Refusals,
): RawDeletion {
  let notInPlan = 0;
  const out: RawDeletion = { versions: [], markers: [], names: 0 };
  for (const r of listed.raw) {
    const planned = plannedRaw.get(r.name);
    if (!planned) {
      if (r.kind !== "recording") notInPlan += r.versions.length + r.markers.length;
      continue;
    }
    const sizes = new Map(planned.versions.map((v) => [v.id, v.size]));
    const markers = new Set(planned.markers);
    const key = objectKey(dataset, r.name);
    let any = false;
    for (const v of r.versions) {
      if (sizes.get(v.id) !== v.size) {
        notInPlan += 1;
        continue;
      }
      out.versions.push({ key, versionId: v.id });
      any = true;
    }
    for (const m of r.markers) {
      if (!markers.has(m)) {
        notInPlan += 1;
        continue;
      }
      out.markers.push({ key, versionId: m });
      any = true;
    }
    if (any) out.names += 1;
  }
  if (notInPlan > 0) {
    refusals.add(
      "raw-copy-not-in-plan",
      `${notInPlan} versions or markers of raw copies under objects/ are not in the plan`,
    );
  }
  return out;
}

/**
 * A plan with raw copies deletes them only behind the proof of `raw-verify` for THIS plan
 * (`raw-verified.json`, which names the exact bytes of plan.json), with the plan's own counts of
 * raw names, versions and markers: every raw version was shown to duplicate an annex key of the plan
 * or a blob of the repository's history. Refuses `raw-copies-unverified`, with every reason it does
 * not hold. A proof that is there and cannot be read is a failure (exit 1), as for every file.
 *
 * It reads working files only, so it runs with the other proofs, before the bucket is read. It
 * returns the annex keys the raw recordings matched when the proof holds (none otherwise), for the
 * bucket check that each one survives (`raw-duplicate-missing`).
 */
export async function checkRawCopiesProof(
  dir: string,
  plan: PlanFile,
  planBytes: Buffer,
  refusals: Refusals,
): Promise<string[]> {
  const raw = plan.rawCopies ?? [];
  if (raw.length === 0) return [];
  const problems: string[] = [];
  let bytes: Buffer | undefined;
  try {
    bytes = await readFile(path.join(dir, "raw-verified.json"));
  } catch (err) {
    if (!isNotFound(err)) throw new StageError("raw-verified.json-unreadable", EXIT.failed);
    problems.push("raw-verified.json missing");
  }
  let proof: RawVerifiedFile | undefined;
  if (bytes) {
    try {
      proof = parseRawVerified(bytes.toString("utf8"));
    } catch {
      problems.push("raw-verified.json invalid");
    }
  }
  if (proof) {
    if (proof.dataset !== plan.dataset) problems.push("for another dataset");
    if (proof.planSha256 !== sha256Hex(planBytes)) problems.push("for another plan.json");
    const want = rawCounts(raw);
    const c = proof.counts;
    if (c.names !== want.names || c.versions !== want.versions || c.markers !== want.markers) {
      problems.push(
        `counts names=${c.names} versions=${c.versions} markers=${c.markers}, the plan has names=${want.names} versions=${want.versions} markers=${want.markers}`,
      );
    }
    const planKeys = new Set(plan.keys.map((k) => k.oldKey));
    const foreign = proof.matchedKeys.filter((k) => !planKeys.has(k)).length;
    if (foreign > 0) problems.push(`${foreign} matched keys are not keys of the plan`);
  }
  if (problems.length > 0) {
    refusals.add("raw-copies-unverified", problems.join(", "));
    return [];
  }
  return proof?.matchedKeys ?? [];
}

/**
 * The dataset's Zarr serving copy repeats header fields in every store root, so the `zarr` stage
 * must have run for THIS plan and left its proof (`zarr-verified.json`, which names the exact bytes
 * of plan.json and of the zarr-plan.json its run wrote), and a proof that the prefix held nothing
 * (`no-zarr`) is not a proof about Zarr objects that are current now (`zarrCurrent`). Refuses
 * `zarr-not-scrubbed`, with every reason it does not hold.
 *
 * `delete-old` asks only while a Zarr object is current; `drop-archives` always asks, because step
 * 10 runs for every dataset and proves `no-zarr` for one without a Zarr copy.
 */
export async function checkZarrProof(
  dir: string,
  dataset: string,
  planBytes: Buffer,
  zarrCurrent: boolean,
  refusals: Refusals,
): Promise<void> {
  const problems: string[] = [];
  let proof: ZarrVerifiedFile | undefined;
  try {
    proof = parseZarrVerified((await readFile(path.join(dir, "zarr-verified.json"))).toString());
  } catch (err) {
    problems.push(
      isNotFound(err) ? "zarr-verified.json missing" : "zarr-verified.json unreadable or invalid",
    );
  }
  if (proof) {
    if (proof.dataset !== dataset) problems.push("for another dataset");
    if (zarrCurrent && proof.found !== "stores") {
      problems.push("says no-zarr while Zarr objects are current");
    }
    if (proof.planSha256 !== sha256Hex(planBytes)) problems.push("for another plan.json");
    let zarrPlanBytes: Buffer | undefined;
    try {
      zarrPlanBytes = await readFile(path.join(dir, "zarr-plan.json"));
    } catch {
      problems.push("zarr-plan.json missing or unreadable");
    }
    if (zarrPlanBytes && proof.zarrPlanSha256 !== sha256Hex(zarrPlanBytes)) {
      problems.push("for another zarr-plan.json");
    }
  }
  if (problems.length > 0) refusals.add("zarr-not-scrubbed", problems.join(", "));
}

/** Where an anonymous reader reaches the production bucket. */
export const DEFAULT_PUBLIC_BASE = "https://nemar.s3.us-east-2.amazonaws.com";

/**
 * The one way a TEST points the anonymous requests at a loopback server: set to `1` only by
 * `test/scrub/s3/support.ts`. Production never sets it, so there `--public-base` must be the
 * bucket's own S3 endpoint.
 */
export const TEST_LOOPBACK_PUBLIC_BASE_ENV = "SCRUB_S3_TEST_LOOPBACK_PUBLIC_BASE";

/**
 * `--public-base` is where an anonymous request proves something (delete-old: the dataset is
 * private; zarr-public: the published copy is clean), so it must BE the bucket: https, and the
 * bucket's virtual-hosted endpoint (`https://<bucket>.s3[.<region>].amazonaws.com`) or its
 * path-style one (`https://s3[.<region>].amazonaws.com/<bucket>`). A typo, a proxy or any other
 * host that answers 403 to everything would otherwise satisfy the privacy gate.
 */
export function checkPublicBase(base: string, bucket: string): void {
  function bad(): never {
    throw new StageError("bad-public-base", EXIT.usage);
  }
  let u: URL;
  try {
    u = new URL(base);
  } catch {
    bad();
  }
  if (u.username !== "" || u.password !== "" || u.search !== "" || u.hash !== "") bad();
  const path = u.pathname.replace(/\/+$/, "");
  if (
    process.env[TEST_LOOPBACK_PUBLIC_BASE_ENV] === "1" &&
    u.protocol === "http:" &&
    u.hostname === "127.0.0.1" &&
    path === ""
  ) {
    return;
  }
  if (u.protocol !== "https:" || u.port !== "" || !/^[a-z0-9][a-z0-9.-]*$/.test(bucket)) bad();
  const region = "(?:[.-][a-z]{2}(?:-[a-z]+)+-\\d+)?";
  const escaped = bucket.replace(/\./g, "\\.");
  const virtualHosted = new RegExp(`^${escaped}\\.s3${region}\\.amazonaws\\.com$`);
  const pathStyle = new RegExp(`^s3${region}\\.amazonaws\\.com$`);
  if (virtualHosted.test(u.hostname) && path === "") return;
  if (pathStyle.test(u.hostname) && path === `/${bucket}`) return;
  bad();
}

/** The status of an anonymous HEAD, or null when there was none (network, timeout). */
async function anonymousHeadStatus(url: string, timeoutMs: number): Promise<number | null> {
  try {
    // No credentials, and a redirect is an answer, not something to follow: S3 sends 301 to a
    // caller using the wrong regional endpoint.
    const res = await fetch(url, {
      method: "HEAD",
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.status;
  } catch {
    return null;
  }
}

/**
 * The dataset must be private before its old bytes go, so there is no window in which an old key
 * is public while a new one is not yet served. The proof is an anonymous HEAD of an object that
 * EXISTS: this bucket denies anonymous listing, so a missing key answers 403 whether or not the
 * dataset is public, and only a key known to exist makes 403 mean private.
 *
 * The probe is one NEW object (current, as an anonymous reader would get it), and, while any
 * remains, one OLD object too. Probing the new keys is what lets a re-run finish after the old
 * keys are gone: a delete that stopped half way (a failed prune) would otherwise be stranded,
 * because there would be no old object left to ask about. Both probes are made, and each answer
 * other than 403 is a refusal: 200 is `dataset-is-public`, anything else (or no new object to ask
 * about) is `privacy-unproven`.
 */
async function checkPrivate(
  ctx: S3Ctx,
  o: DeleteOptions,
  dataset: string,
  oldKeys: string[],
  newKeys: string[],
  refusals: Refusals,
): Promise<void> {
  const firstPresent = async (keys: string[]): Promise<string | undefined> => {
    for (const k of keys) if (await headObject(ctx, objectKey(dataset, k))) return k;
    return undefined;
  };
  const askAnonymously = async (key: string, which: string): Promise<void> => {
    // Each segment encoded, as `zarr-public` does: S3 reads a bare `+` in a path as a space, so
    // the object would look missing, answer 403, and pass as private.
    const path = objectKey(dataset, key).split("/").map(encodeURIComponent).join("/");
    const url = `${o.publicBase.replace(/\/+$/, "")}/${path}`;
    const status = await anonymousHeadStatus(url, o.timeoutMs);
    if (status === 403) return;
    if (status === 200) refusals.add("dataset-is-public", `${which} answered 200`);
    else refusals.add("privacy-unproven", `${which} answered ${status ?? "nothing"}`);
  };
  const newProbe = await firstPresent([...newKeys].sort());
  if (newProbe === undefined) {
    refusals.add("privacy-unproven", "no new object is current to ask about");
  } else {
    await askAnonymously(newProbe, "a new object");
  }
  const oldProbe = await firstPresent(oldKeys);
  if (oldProbe !== undefined) await askAnonymously(oldProbe, "an old object");
}

/** Every version or marker under a prefix that is not a current version: its history. */
const historyOf = (entries: PrefixEntry[]): PrefixEntry[] =>
  entries.filter((e) => !(e.kind === "version" && e.isLatest));

/** The prefixes whose history must be gone before deleted.json may say the dataset is clean. */
const HISTORY_DIRS = ["archives", "version", "zarr"] as const;

/**
 * What remains under each history prefix: under `archives/` every version and marker (an archive
 * holds the original recordings, current or not), under `version/` and `zarr/` the history alone
 * (their current objects are the regenerated manifests and the scrubbed Zarr copy).
 */
async function historyRemaining(ctx: S3Ctx, dataset: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const d of HISTORY_DIRS) {
    const entries = await listPrefixVersions(ctx, `${dataset}/${d}/`);
    out[d] = (d === "archives" ? entries : historyOf(entries)).length;
  }
  return out;
}

const formatPrefixCounts = (counts: Record<string, number>) =>
  Object.entries(counts)
    .map(([d, n]) => `${d}=${n}`)
    .join(" ");

export async function deleteOldStage(o: DeleteOptions): Promise<number> {
  const planBytes = await readBytes(path.join(o.dir, "plan.json"), "plan.json");
  const plan = parseFile("plan.json", parsePlan, planBytes.toString("utf8"));
  // A proof from an earlier run must not outlive this one: it holds only once this run ends well.
  await rm(path.join(o.dir, "deleted.json"), { force: true });
  // Typed again by the operator, before anything else is read: a stage that deletes names its
  // target twice. Applies to the dry run too, so a wrong working directory shows up early.
  if (o.confirmDataset !== plan.dataset) {
    throw new StageError("confirm-dataset-mismatch", EXIT.refused);
  }
  checkDataset(plan.dataset);
  requireCompletePlan(plan);
  checkPublicBase(o.publicBase, plan.bucket);
  // The dataset and the bucket are the plan's, which the operator confirmed; every other file
  // must name the same ones, each compared on its own.
  const dataset = plan.dataset;
  const bucket = plan.bucket;

  // Every refusal is evaluated and reported together (see `Refusals`). The working files come
  // first: the proofs, the assembly and the flags.
  const refusals: Refusals = new Refusals();
  const proven = await checkScrubProofs(o.dir, plan, planBytes, o, refusals);
  const rawMatchedKeys = await checkRawCopiesProof(o.dir, plan, planBytes, refusals);
  for (const p of o.prune) {
    await refusals.attempt(
      () => checkPrunePrefix(dataset, p),
      "a --prune-noncurrent prefix is not <id>/version/, <id>/archives/ or <id>/zarr/",
    );
  }
  // Every check of the bucket below is about the keys these files name, so the bucket is read
  // only once they agree. Nothing that clears a refusal here is irreversible.
  if (refusals.any || proven === undefined) {
    o.log("delete-old: the bucket was not read; its checks run once the working files agree");
    refusals.stop("delete-old", o.log);
  }
  const { sha, entries, oldKeys, newKeys, planned } = proven;
  const prunePrefixes = [...new Set(o.prune)];
  /** Every recording key this scrub accounted for: what the plan read, and what it assembled. */
  const known = new Set([...planned.keys(), ...newKeys]);
  /** The raw copies the plan recorded, by name; none for a plan made without any. */
  const plannedRaw = new Map((plan.rawCopies ?? []).map((r) => [r.name, r]));
  const hasRaw = plannedRaw.size > 0;

  return withCtx(o, bucket, async (ctx) => {
    // What must be true of the dataset before an old key may go. All of it is read only, all of it
    // runs in the dry run, and every check runs whatever an earlier one found, so one dry run
    // shows every refusal before --execute is typed, and before the archives are dropped.

    // The replacement must still be there before anything it replaces is touched.
    const present = await runPool(entries, o.concurrency, async ([k, e]) => {
      const head = await headObject(ctx, objectKey(dataset, e.newKey), e.newVersionId);
      return head !== null && head.size === parseKey(k).size;
    });
    const gone = present.filter((ok) => ok !== true).length;
    if (gone > 0) {
      refusals.add(
        "new-object-missing",
        `${gone} of ${entries.length} new objects are not at the version assembly recorded`,
      );
    }
    await checkManifests(ctx, dataset, new Set(oldKeys), known, refusals);
    // One listing of objects/ (every version and marker) for the recordings and the raw copies.
    const objects = await listObjects(ctx, dataset);
    checkUnplannedRecordings(objects, known, plannedRaw, refusals);
    // An archive holds the original recordings, so ANY version or marker of one, current or not,
    // is a copy the delete would leave behind.
    const archives = await listPrefixVersions(ctx, `${dataset}/archives/`);
    if (archives.length > 0) {
      refusals.add(
        "archives-not-dropped",
        `versions and markers=${archives.length} under archives/`,
      );
    }
    if (await hasCurrentKey(ctx, `${dataset}/zarr/`)) {
      await checkZarrProof(o.dir, dataset, planBytes, true, refusals);
    }
    // A raw recording goes because an annex key holds its bytes: each key it matched that this run
    // does not replace must still be current at its size (a replaced one is `new-object-missing`'s).
    const replaced = new Set(oldKeys);
    const kept = rawMatchedKeys.filter((k) => !replaced.has(k));
    const keptPresent = await runPool(kept, o.concurrency, async (k) => {
      const head = await headObject(ctx, objectKey(dataset, k));
      return head !== null && head.size === parseKey(k).size;
    });
    const keptMissing = keptPresent.filter((ok) => ok !== true).length;
    if (keptMissing > 0) {
      refusals.add(
        "raw-duplicate-missing",
        `${keptMissing} of ${kept.length} annex keys the raw recordings duplicate are not current at their size`,
      );
    }
    await checkPrivate(ctx, o, dataset, oldKeys, [...newKeys], refusals);

    const listed = await listOldKeys(ctx, dataset, oldKeys, o.concurrency);
    // Every version of an old key must be the size its key declares. One that is not holds bytes
    // that are not the recording the plan read: what it is, nobody checked. The sizes come with
    // the listing.
    const wrongSize = listed.reduce(
      (n, l) => n + l.sizes.filter((size) => size !== parseKey(l.oldKey).size).length,
      0,
    );
    // Only what the plan recorded may be deleted: the plan read the header of each old key, and a
    // version written since is bytes nobody checked. No flag waives this.
    const unplanned = listed.reduce((n, l) => {
      const allowed = new Set((planned.get(l.oldKey) as PlanKey).versionIds);
      return n + [...l.versions, ...l.markers].filter((id) => !allowed.has(id)).length;
    }, 0);
    const totalVersions = listed.reduce((n, l) => n + l.versions.length, 0);
    const totalMarkers = listed.reduce((n, l) => n + l.markers.length, 0);
    if (wrongSize > 0) {
      refusals.add(
        "version-size-differs",
        `${wrongSize} versions of old keys are not the size their key declares`,
      );
    }
    if (unplanned > 0) {
      refusals.add(
        "version-not-in-plan",
        `${unplanned} versions or markers of old keys are not in the plan`,
      );
    }
    // The raw copies go in the same run, so the plan's count and the cap cover them too.
    const raw = checkRawCopiesInBucket(dataset, objects, plannedRaw, refusals);
    const rawRecorded = rawCounts([...plannedRaw.values()]);
    const recorded =
      oldKeys.reduce((n, k) => n + (planned.get(k) as PlanKey).versionIds.length, 0) +
      rawRecorded.versions +
      rawRecorded.markers;
    const deleting = totalVersions + totalMarkers + raw.versions.length + raw.markers.length;
    // A sanity cap below the plan's own count, never a way past it.
    const limit = Math.min(o.maxDelete ?? recorded, recorded);
    o.log(
      `delete-old: keys=${oldKeys.length} versions=${totalVersions} markers=${totalMarkers} planRecorded=${recorded} limit=${limit}`,
    );
    if (hasRaw) {
      o.log(
        `delete-old: raw copies names=${plannedRaw.size} versions=${raw.versions.length} markers=${raw.markers.length}`,
      );
    }
    if (deleting > limit) {
      refusals.add("over-max-delete", `versions+markers=${deleting} over limit=${limit}`);
    }

    // The history of the manifests and of the Zarr copy holds the old keys and the old metadata:
    // it goes in the same run, so the operator has to name each prefix that has any.
    const prunes: PrefixEntry[] = [];
    const unpruned: Record<string, number> = {};
    for (const d of ["version", "zarr"] as const) {
      const prefix = `${dataset}/${d}/`;
      const history = historyOf(await listPrefixVersions(ctx, prefix));
      if (prunePrefixes.includes(prefix)) appendAll(prunes, history);
      else if (history.length > 0) unpruned[d] = history.length;
    }
    const prunedVersions = prunes.filter((p) => p.kind === "version").length;
    const prunedMarkers = prunes.length - prunedVersions;
    if (prunePrefixes.length > 0) {
      o.log(`delete-old: prune noncurrent versions=${prunedVersions} markers=${prunedMarkers}`);
    }
    if (Object.keys(unpruned).length > 0) {
      refusals.add(
        "history-remains",
        `${formatPrefixCounts(unpruned)} not named by --prune-noncurrent`,
      );
    }
    if (prunes.length > o.maxPrune) {
      refusals.add(
        "over-max-prune",
        `noncurrent versions and markers=${prunes.length} over --max-prune ${o.maxPrune}`,
      );
    }
    refusals.stopIfAny("delete-old", o.log);

    if (!o.execute) {
      o.log(
        `delete-old dry run: would delete versions=${totalVersions} markers=${totalMarkers} across ${oldKeys.length} keys`,
      );
      if (hasRaw) {
        o.log(
          `delete-old dry run: would delete raw copies versions=${raw.versions.length} markers=${raw.markers.length} across ${raw.names} names`,
        );
      }
      return 0;
    }

    const errors: string[] = [];
    const removeAll = async (items: VersionRef[], bypass: boolean): Promise<void> => {
      appendAll(
        errors,
        await deleteVersions(ctx, items, bypass, o.concurrency, (p) =>
          o.log(`delete-old: deleted ${p.done - p.failed} of ${p.total} in this group`),
        ),
      );
    };
    await removeAll(
      listed.flatMap((l) =>
        [...l.versions, ...l.markers].map((versionId) => ({ key: l.obj, versionId })),
      ),
      true,
    );
    // The raw copies' versions, with the bypass: the raw text is locked like the recordings. Their
    // delete markers are NOT in these requests: they go last, below.
    await removeAll(raw.versions, true);
    // Pruning never bypasses the lock: a locked object is refused, not forced. Noncurrent entries
    // first; a delete marker that is the CURRENT entry of a key goes only once the key has no
    // version left under it, because removing it earlier would make an old version current again.
    await removeAll(
      prunes.filter((p) => !(p.kind === "marker" && p.isLatest)),
      false,
    );
    const latestMarkers = prunes.filter((p) => p.kind === "marker" && p.isLatest);
    if (latestMarkers.length > 0) {
      const stillVersioned = new Set<string>();
      for (const prefix of prunePrefixes) {
        for (const e of await listPrefixVersions(ctx, prefix)) {
          if (e.kind === "version") stillVersioned.add(e.key);
        }
      }
      await removeAll(
        latestMarkers.filter((m) => !stillVersioned.has(m.key)),
        false,
      );
    }
    // Last, the raw copies' delete markers, in requests of their own after every raw version's,
    // and only for a name with no version left: a raw recording is an ORIGINAL hidden by its
    // marker, so removing the marker while a version stays would make the original current again.
    // A marker is never locked, so no bypass is asked for.
    if (raw.markers.length > 0) {
      const stillVersioned = new Set(
        (await listPrefixVersions(ctx, `${dataset}/objects/`))
          .filter((e) => e.kind === "version")
          .map((e) => e.key),
      );
      await removeAll(
        raw.markers.filter((m) => !stillVersioned.has(m.key)),
        false,
      );
    }

    // The listing is the authority, not the answers to the deletes.
    const after = await listOldKeys(ctx, dataset, oldKeys, o.concurrency);
    const remaining = after.reduce((n, l) => n + l.versions.length + l.markers.length, 0);
    // Every raw name, planned or not: nothing under objects/ but annex keys and annex-uuid may be
    // left, whether or not the plan had raw copies (one written during the run is found here).
    const objectsAfter = await listObjects(ctx, dataset);
    const rawLeft = rawCounts(objectsAfter.raw);
    const rawRemaining = rawLeft.versions + rawLeft.markers + objectsAfter.badKeys.length;
    const history = await historyRemaining(ctx, dataset);
    const historyLeft = Object.values(history).reduce((n, c) => n + c, 0);
    if (errors.length > 0) {
      o.log(`delete-old: delete errors=${errors.length} (${formatWordCounts(countWords(errors))})`);
    }
    if (remaining > 0) {
      o.log(`delete-old: FAILED, versions and markers remain: oldKeys=${remaining}`);
    }
    if (rawRemaining > 0) {
      o.log(
        `delete-old: FAILED, versions and markers remain: rawCopies=${rawLeft.names} versions=${rawLeft.versions} markers=${rawLeft.markers} badKeys=${objectsAfter.badKeys.length}`,
      );
    }
    if (historyLeft > 0) {
      o.log(`delete-old: FAILED, history-remains ${formatPrefixCounts(history)}`);
    }
    if (remaining > 0 || rawRemaining > 0 || historyLeft > 0) {
      o.log("delete-old: deleted.json NOT written; a re-run resumes");
      if (remaining > 0 || rawRemaining > 0) return EXIT.remainder;
      throw new StageError("history-remains", EXIT.remainder);
    }
    const done: DeletedFile = {
      version: 1,
      dataset,
      deletedAt: new Date().toISOString(),
      assembledSha256: sha,
      counts: {
        keys: oldKeys.length,
        versions: totalVersions,
        markers: totalMarkers,
        prunedVersions,
        prunedMarkers,
        ...(hasRaw ? { rawVersions: raw.versions.length, rawMarkers: raw.markers.length } : {}),
      },
    };
    await writeJson(o.dir, "deleted.json", done);
    o.log(
      `delete-old: deleted versions=${totalVersions} markers=${totalMarkers}; zero versions and zero markers remain for ${oldKeys.length} keys, and no history under ${HISTORY_DIRS.join("/, ")}/`,
    );
    if (hasRaw) {
      o.log(
        `delete-old: deleted raw copies versions=${raw.versions.length} markers=${raw.markers.length}; zero versions and zero markers remain under the ${plannedRaw.size} raw names, and no object under objects/ but annex keys and ${ANNEX_UUID_OBJECT}`,
      );
    }
    return 0;
  });
}

// ---------------------------------------------------------------------------
// canary
// ---------------------------------------------------------------------------

export interface CanaryOptions extends CommonOptions {
  bucket: string;
  prefix: string;
  execute: boolean;
  /** Also prove the multipart path (a lock at create, an upload part and a server-side copy). */
  multipart: boolean;
  /** Also prove the batch delete (`DeleteObjects`): a lock in a 200, and the bypass. */
  batch: boolean;
}

/**
 * The canary writes a locked object and deletes it with the bypass, so where it may do that is
 * fixed, not typed: the end-to-end fixture's id (`nm099999`) or a DEV EPHEMERAL sandbox id
 * (`xx090000` to `xx098999`), and one directory below it. Never a live dataset, a standing
 * fixture (`nm099998`), a real user's production sandbox (`xx000001` to `xx089999`), the
 * permanent exemplar fleet (`xx0999NN`), or a deeper prefix.
 */
const CANARY_PREFIX = /^(nm099999|xx09[0-8]\d{3})\/canary-[A-Za-z0-9_-]+\/$/;

export function checkCanaryPrefix(prefix: string): void {
  if (!CANARY_PREFIX.test(prefix)) throw new StageError("prefix-not-canary", EXIT.refused);
}

/** Prove the lock holds without the bypass and gives way with it, then remove the object. */
async function proveAndDelete(ctx: S3Ctx, key: string, versionId: string, o: CommonOptions) {
  try {
    await deleteVersion(ctx, key, versionId, false);
    throw new StageError("lock-not-enforced");
  } catch (err) {
    if (err instanceof StageError) throw err;
    if (!(err instanceof AwsCliError) || err.code !== "access-denied") {
      throw new StageError(`unlocked-delete:${failureWord(err)}`);
    }
  }
  o.log("canary: a delete without the bypass was refused (the lock holds)");
  try {
    await deleteVersion(ctx, key, versionId, true);
  } catch (err) {
    if (err instanceof AwsCliError && err.code === "access-denied") {
      throw new StageError("bypass-denied");
    }
    throw err;
  }
  o.log("canary: a delete with the bypass succeeded");
}

/** The refusal a conditional request must meet: a fixed word, and anything else stops the canary. */
async function expectConditionRefused(word: string, attempt: () => Promise<unknown>) {
  try {
    await attempt();
  } catch (err) {
    if (err instanceof AwsCliError && err.code === "precondition-failed") return;
    throw new StageError(`${word}-unexpected:${failureWord(err)}`);
  }
  throw new StageError(`${word}-not-enforced`);
}

/**
 * Prove the two conditional requests the zarr stage relies on, on an unlocked object: a
 * get-object pinned to an ETag, and a put-object that replaces the object only if its ETag is
 * still the one read. With the right ETag both succeed; with a stale one both are refused with a
 * precondition failure (412, or 409 for a conflicting write). Then the object is removed by
 * version id WITHOUT the bypass, as the prune removes a noncurrent Zarr version.
 */
async function proveConditionalWrites(ctx: S3Ctx, key: string, body: string, o: CommonOptions) {
  const meta = { contentType: "application/json" };
  const ids: string[] = [];
  await writeFile(body, '{"canary":1}\n', { mode: 0o600 });
  ids.push(await putObjectPlain(ctx, key, body, meta));
  const read = await readWholeWithMeta(ctx, key);
  await readWholeWithMeta(ctx, key, read.etag);
  await writeFile(body, '{"canary":2}\n', { mode: 0o600 });
  try {
    ids.push(await putObjectIfMatch(ctx, key, body, meta, read.etag));
  } catch (err) {
    throw new StageError(`conditional-put-failed:${failureWord(err)}`);
  }
  o.log("canary: a put conditional on the current ETag succeeded");
  // read.etag is stale now: both conditional requests must be refused.
  await writeFile(body, '{"canary":3}\n', { mode: 0o600 });
  await expectConditionRefused("conditional-put", () =>
    putObjectIfMatch(ctx, key, body, meta, read.etag),
  );
  await expectConditionRefused("conditional-get", () => readWholeWithMeta(ctx, key, read.etag));
  o.log("canary: a put and a get conditional on a stale ETag were refused (precondition)");
  const now = await readWholeWithMeta(ctx, key);
  if (Buffer.from(now.bytes).toString("utf8") !== '{"canary":2}\n') {
    throw new StageError("conditional-put-content-wrong");
  }
  for (const id of ids) {
    try {
      await deleteVersion(ctx, key, id, false);
    } catch (err) {
      throw new StageError(`unlocked-delete-refused:${failureWord(err)}`);
    }
  }
  o.log("canary: the unlocked versions were deleted by id without the bypass");
}

/**
 * Prove what `DeleteObjects` does on the real bucket, which the stand-in only believes: it
 * answers 200 with the refused versions listed per item (a locked one without the bypass), it
 * removes the unlocked ones and a delete marker named by id in the same request, a key with
 * characters XML escapes survives the round trip, and the bypass removes the locked ones.
 */
async function proveBatchDelete(
  ctx: S3Ctx,
  prefix: string,
  body: string,
  retainUntil: string,
  o: CommonOptions,
) {
  await writeFile(body, "canary\n", { mode: 0o600 });
  const locked: VersionRef[] = [];
  for (const name of ["batch-locked-1.txt", "batch-locked-2.txt"]) {
    const key = `${prefix}${name}`;
    locked.push({ key, versionId: await putObjectLocked(ctx, key, body, {}, retainUntil) });
  }
  const specialKey = `${prefix}batch plain & <co>.txt`;
  const special = { key: specialKey, versionId: await putObjectPlain(ctx, specialKey, body, {}) };
  const markedKey = `${prefix}batch-marked.txt`;
  const marked = { key: markedKey, versionId: await putObjectPlain(ctx, markedKey, body, {}) };
  // A bare delete adds a delete marker, whose own version id the batch then names.
  await ctx.aws.api("delete-object", ["--bucket", ctx.bucket, "--key", markedKey]);
  const markerId = (await listKeyVersions(ctx, markedKey)).markers[0]?.versionId;
  if (!markerId) throw new StageError("batch-marker-missing");

  const refused = await deleteVersionBatch(
    ctx,
    [...locked, special, marked, { key: markedKey, versionId: markerId }],
    false,
  );
  if (refused.length === 0) throw new StageError("batch-lock-not-enforced");
  if (refused.length !== 2 || refused.some((w) => w !== "DeleteObjects:access-denied")) {
    throw new StageError(`batch-unexpected:${formatWordCounts(countWords(refused))}`);
  }
  const lockedIds = new Set(locked.map((l) => l.versionId));
  const stayed = await listPrefixVersions(ctx, `${prefix}batch`);
  if (stayed.length !== 2 || stayed.some((e) => !lockedIds.has(e.versionId))) {
    throw new StageError("batch-result-wrong");
  }
  o.log(
    "canary: a batch delete without the bypass removed 3 unlocked versions (one a delete marker, one with XML characters in its key) and refused the 2 locked ones",
  );

  const bypassed = await deleteVersionBatch(ctx, locked, true);
  if (bypassed.length > 0) {
    throw new StageError(
      bypassed.every((w) => w === "DeleteObjects:access-denied")
        ? "batch-bypass-denied"
        : `batch-unexpected:${formatWordCounts(countWords(bypassed))}`,
    );
  }
  if ((await listPrefixVersions(ctx, `${prefix}batch`)).length > 0) {
    throw new StageError("batch-result-wrong");
  }
  o.log("canary: a batch delete with the bypass removed the 2 locked versions");

  // Not a pass or fail: what a resend of an already deleted version answers, for the record. A
  // retry after a lost answer sends such versions again.
  const again = await deleteVersionBatch(ctx, [special], false);
  o.log(
    `canary: a batch naming an already deleted version answered ${again.length === 0 ? "deleted" : (again[0] as string)}`,
  );
}

export async function canaryStage(o: CanaryOptions): Promise<number> {
  checkCanaryPrefix(o.prefix);
  const steps = [
    `put ${o.prefix}probe.txt with GOVERNANCE retention for 1 day`,
    "delete that version WITHOUT the bypass (expect AccessDenied)",
    "delete that version WITH the bypass (expect success)",
    `put ${o.prefix}conditional.json unlocked, then get and put it conditional on its ETag (expect success)`,
    "put and get it conditional on the now stale ETag (expect PreconditionFailed)",
    "delete both versions by id WITHOUT the bypass (expect success)",
    "list the prefix (expect zero versions and zero delete markers)",
  ];
  if (o.multipart) {
    steps.push(
      `build ${o.prefix}multipart.bin from an upload part and a server-side copy, with the lock set at create`,
      "repeat the delete without and with the bypass on it and on its source",
    );
  }
  if (o.batch) {
    steps.push(
      `put two locked versions, an unlocked one under a key with XML characters, and an unlocked one that a delete marker then covers, under ${o.prefix}batch*`,
      "delete those four versions and the marker in ONE DeleteObjects request WITHOUT the bypass (expect the 3 unlocked gone, the 2 locked refused per item)",
      "delete the 2 locked in one DeleteObjects request WITH the bypass (expect success)",
      "name an already deleted version again (recorded, not judged)",
    );
  }
  if (!o.execute) {
    o.log(`canary dry run (no S3 calls made): bucket=${o.bucket} prefix=${o.prefix}`);
    steps.forEach((s, i) => o.log(`  ${i + 1}. ${s}`));
    return 0;
  }

  return withCtx(o, o.bucket, async (ctx) => {
    const retainUntil = isoSeconds(new Date(Date.now() + 24 * 3600 * 1000));
    const body = ctx.tmp.file();
    try {
      await writeFile(body, "canary\n", { mode: 0o600 });
      const key = `${o.prefix}probe.txt`;
      const versionId = await putObjectLocked(ctx, key, body, {}, retainUntil);
      o.log("canary: put a locked probe object");
      await proveAndDelete(ctx, key, versionId, o);
      await proveConditionalWrites(ctx, `${o.prefix}conditional.json`, body, o);

      if (o.multipart) {
        const sourceKey = `${o.prefix}multipart-source.bin`;
        await writeFile(body, Buffer.alloc(6 * MIB, 1), { mode: 0o600 });
        const sourceVersion = await putObjectLocked(ctx, sourceKey, body, {}, retainUntil);
        const source = await headObject(ctx, sourceKey, sourceVersion);
        if (!source) throw new StageError("multipart-source-missing");
        const mpKey = `${o.prefix}multipart.bin`;
        const uploadId = await createMultipart(ctx, mpKey, {}, retainUntil);
        try {
          const first = await uploadPart(ctx, mpKey, uploadId, 1, body);
          const second = await uploadPartCopy(ctx, mpKey, uploadId, 2, {
            key: sourceKey,
            etag: source.etag,
            start: 0,
            end: MIB - 1,
          });
          await completeMultipart(ctx, mpKey, uploadId, [
            { ETag: first, PartNumber: 1 },
            { ETag: second, PartNumber: 2 },
          ]);
        } catch (err) {
          try {
            await abortMultipart(ctx, mpKey, uploadId);
          } catch (abortErr) {
            o.log(
              `canary: abort-failed key=${mpKey} uploadId=${uploadId} (${failureWord(abortErr)})`,
            );
            throw new StageError(`${failureWord(err)}+abort-failed`);
          }
          throw err;
        }
        const made = await headObject(ctx, mpKey);
        if (!made || made.size !== 7 * MIB) throw new StageError("multipart-size-wrong");
        // The canary's lock is one day, so only the mode is checked here.
        if (made.lockMode !== "GOVERNANCE") throw new StageError("multipart-lock-missing");
        const mpVersion = made.versionId;
        if (!mpVersion) throw new StageError("multipart-no-version");
        o.log("canary: multipart object built with the lock set at create");
        await proveAndDelete(ctx, mpKey, mpVersion, o);
        await proveAndDelete(ctx, sourceKey, sourceVersion, o);
      }
      if (o.batch) await proveBatchDelete(ctx, o.prefix, body, retainUntil, o);
    } finally {
      await ctx.tmp.remove(body);
    }

    const left = await listPrefixVersions(ctx, o.prefix);
    if (left.length > 0) throw new StageError("canary-remainder", EXIT.remainder);
    o.log("canary: zero versions and zero delete markers remain under the prefix");
    return 0;
  });
}
