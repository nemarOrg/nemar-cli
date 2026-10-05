/**
 * The five S3 stages of an in-place scrub: plan, assemble, verify, delete-old and canary.
 *
 * Each stage reads the previous stage's JSON from a working directory (the contract in
 * `../contract.ts`) and refuses a file that does not match. Every stage is read-only unless it
 * is given `execute`. The only stage that deletes is {@link deleteOldStage}, and it does so only
 * behind two proofs that name the exact bytes of `assembled.json` they vouch for.
 *
 * **Nothing printed or written here is a participant value.** Output is counts, annex keys, sizes,
 * version ids and fixed words. Header bytes are held in memory and compared, never logged.
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
  type AssembledFile,
  ContractError,
  GIT_KEY,
  type HashesFile,
  type KeymapFile,
  type PatchesFile,
  type PlanFile,
  type PlanKey,
  type VerifiedFile,
  parseAssembled,
  parseHashes,
  parseKey,
  parseKeymap,
  parsePatches,
  parsePlan,
  parseVerified,
  parseZarrVerified,
  patchDigest,
} from "../contract";
import {
  AwsCliError,
  type AwsConfig,
  DATASET_ID,
  EXIT,
  type HeadInfo,
  MIB,
  PLAN_READ_BYTES,
  RETAIN_YEARS,
  type S3Ctx,
  StageError,
  TempArea,
  abortMultipart,
  bytesEqual,
  callsFor,
  completeMultipart,
  countWords,
  createAwsRunner,
  createMultipart,
  deleteVersion,
  failureWord,
  formatWordCounts,
  fromHex,
  getRetention,
  hasCurrentKey,
  headObject,
  isoSeconds,
  listCurrentKeys,
  listKeyVersions,
  listPrefixVersions,
  objectKey,
  planAssembly,
  putObjectLocked,
  readRange,
  readWhole,
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

export async function readBytes(file: string, name: string): Promise<Buffer> {
  try {
    return await readFile(file);
  } catch {
    throw new StageError(`${name}-missing`, EXIT.refused);
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

export async function writeJson(dir: string, name: string, value: unknown): Promise<void> {
  await writeFile(path.join(dir, name), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

async function exists(file: string): Promise<boolean> {
  try {
    await readFile(file);
    return true;
  } catch {
    return false;
  }
}

export function checkDataset(dataset: string): void {
  if (!DATASET_ID.test(dataset)) throw new StageError("bad-dataset-id", EXIT.usage);
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

/** True for a path the scrub reads: an EDF or BDF file, in any letter case. */
export function isEdfOrBdf(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return lower.endsWith(".edf") || lower.endsWith(".bdf");
}

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

/**
 * Every EDF or BDF object under `<id>/objects/`, in any letter case, from a paginated listing of
 * the objects themselves. A manifest names the files a version has; the listing finds the ones a
 * manifest does not name (a file dropped from a later version, an older tag nobody listed), which
 * hold the same bytes. `bad` counts names that look like a recording and are not annex keys.
 */
async function listObjectRecordings(
  ctx: S3Ctx,
  dataset: string,
): Promise<{ keys: Set<string>; bad: number }> {
  const prefix = `${dataset}/objects/`;
  const keys = new Set<string>();
  let bad = 0;
  for (const full of await listCurrentKeys(ctx, prefix)) {
    const name = full.slice(prefix.length);
    if (!isEdfOrBdf(name)) continue;
    try {
      parseKey(name);
      keys.add(name);
    } catch {
      bad += 1;
    }
  }
  return { keys, bad };
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
    const head = await headObject(ctx, obj);
    if (!head) return unreadable("HeadObject:not-found");
    const listing = await listKeyVersions(ctx, obj);
    const versionIds = [...listing.versions, ...listing.markers].map((v) => v.versionId);
    if (head.size !== keySize) return unreadable("size-mismatch", versionIds);
    const bytes = await readRange(ctx, obj, 0, Math.min(PLAN_READ_BYTES, head.size) - 1, {
      ifMatch: head.etag,
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
    // bucket is planned too.
    const listed = await listObjectRecordings(ctx, o.dataset);
    if (listed.bad > 0) {
      o.log(`plan: ${listed.bad} objects look like recordings but are not SHA256E annex keys`);
      throw new StageError("objects-bad-key", EXIT.unreadable);
    }
    for (const k of listed.keys) keys.add(k);

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
    const totals = {
      keys: entries.length,
      needScrub: entries.filter((e) => e.needsScrub).length,
      bytesToHash: entries.filter((e) => e.needsScrub).reduce((n, e) => n + e.size, 0),
      unreadable: entries.filter((e) => e.status === "unreadable").length,
    };
    const plan: PlanFile = {
      version: 1,
      dataset: o.dataset,
      bucket: o.bucket,
      tags,
      ...(o.tags ? { partial: true } : {}),
      createdAt: new Date().toISOString(),
      keys: entries,
      totals,
    };
    await writeJson(o.out, "plan.json", plan);
    await writeJson(o.out, "patches.json", patches);

    o.log(
      `plan: tags=${tags.length} keys=${totals.keys} needScrub=${totals.needScrub} bytesToHash=${totals.bytesToHash} unreadable=${totals.unreadable}`,
    );
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
  const patches: PatchesFile = await loadFile(dir, "patches.json", parsePatches);

  if (plan.partial) throw new StageError("plan-partial", EXIT.refused);
  if (plan.totals.unreadable > 0 || plan.keys.some((k) => k.status !== "read")) {
    throw new StageError("plan-has-unreadable", EXIT.refused);
  }
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
      uploadId = await createMultipart(ctx, newObj, meta, retainUntil);
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
        } catch {
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
          const r = await assembleOne(ctx, plan.dataset, w, o.maxCopyPart);
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
    if (head.size !== size) words.push("new-size-mismatch");
    if (head.lockMode !== "GOVERNANCE") words.push("lock-missing");
    const ret = await getRetention(ctx, newObj, e.newVersionId);
    if (!ret) words.push("retention-missing");
    else if (!retentionOk(ret.mode, ret.retainUntil)) words.push("retention-short");
    if (head.size !== size) return { ...result, words };

    const oldHeader = await readRange(ctx, oldObj, 0, EDF_HEADER_BYTES - 1).catch(() => null);
    if (!oldHeader) return { ...result, words: [...words, "old-unreadable"] };
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
  if (plan.partial) throw new StageError("plan-partial", EXIT.refused);
  const assembledBytes = await readBytes(path.join(o.dir, "assembled.json"), "assembled.json");
  const assembled = parseFile("assembled.json", parseAssembled, assembledBytes.toString("utf8"));
  const patches = await loadFile(o.dir, "patches.json", parsePatches);
  const keymap = await loadFile(o.dir, "keymap.json", parseKeymap);

  if (assembled.dataset !== plan.dataset || assembled.bucket !== plan.bucket) {
    throw new StageError("assembled-wrong-dataset", EXIT.refused);
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
    x.version !== 1 ||
    typeof x.dataset !== "string" ||
    typeof x.assembledSha256 !== "string" ||
    typeof x.count !== "number"
  ) {
    throw new ContractError("new-hash-verified.json does not match the contract");
  }
  return x as unknown as HashVerifiedFile;
}

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
  };
}

interface KeyVersions {
  oldKey: string;
  obj: string;
  versions: string[];
  markers: string[];
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
    };
  });
  return out as KeyVersions[];
}

/** A stage that reads manifests for a delete refuses where the plan stage would have stopped. */
function asRefusal(err: unknown): never {
  if (err instanceof StageError) throw new StageError(err.word, EXIT.refused);
  throw err;
}

/**
 * Every CURRENT manifest must already name only new keys: the manifests are regenerated after
 * the tags move (runbook step 9), and a manifest still naming an old key would serve a key that
 * is about to stop existing. Tags are discovered now, not taken from the plan, so a manifest
 * written since the plan is read too.
 */
async function refuseManifestNamingOldKey(
  ctx: S3Ctx,
  dataset: string,
  oldKeys: Set<string>,
): Promise<void> {
  let tags: string[];
  try {
    tags = await discoverTags(ctx, dataset);
  } catch (err) {
    return asRefusal(err);
  }
  if (tags.length === 0) throw new StageError("no-manifests", EXIT.refused);
  for (const tag of tags) {
    let bytes: Uint8Array;
    try {
      bytes = await readWhole(ctx, `${dataset}/version/${tag}.json`);
    } catch {
      throw new StageError("manifest-unreadable", EXIT.refused);
    }
    let found: ManifestKeys;
    try {
      found = keysOfManifest(dataset, Buffer.from(bytes).toString("utf8"));
    } catch (err) {
      return asRefusal(err);
    }
    for (const k of found.keys) {
      if (oldKeys.has(k)) throw new StageError("manifest-names-old-key", EXIT.refused);
    }
  }
}

/**
 * The dataset's Zarr serving copy repeats header fields in every store root, so while any Zarr
 * object is current the `zarr` stage must have run for THIS plan and left a proof behind.
 */
async function requireZarrVerified(dir: string, dataset: string, planBytes: Buffer): Promise<void> {
  const refuse = () => new StageError("zarr-not-scrubbed", EXIT.refused);
  let verified: ReturnType<typeof parseZarrVerified>;
  let zarrPlanBytes: Buffer;
  try {
    verified = parseZarrVerified((await readFile(path.join(dir, "zarr-verified.json"))).toString());
    zarrPlanBytes = await readFile(path.join(dir, "zarr-plan.json"));
  } catch {
    throw refuse();
  }
  if (
    verified.dataset !== dataset ||
    verified.planSha256 !== sha256Hex(planBytes) ||
    verified.zarrPlanSha256 !== sha256Hex(zarrPlanBytes)
  ) {
    throw refuse();
  }
}

/** Where an anonymous reader reaches the production bucket. */
export const DEFAULT_PUBLIC_BASE = "https://nemar.s3.us-east-2.amazonaws.com";

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
 * is public while a new one is not yet served. The proof is one anonymous HEAD of one old object
 * that EXISTS: this bucket denies anonymous listing, so a missing key answers 403 whether or not
 * the dataset is public, and only a key known to exist makes 403 mean private.
 */
async function requirePrivate(
  ctx: S3Ctx,
  o: DeleteOptions,
  dataset: string,
  oldKeys: string[],
): Promise<void> {
  let probe: string | undefined;
  for (const k of oldKeys) {
    if (await headObject(ctx, objectKey(dataset, k))) {
      probe = k;
      break;
    }
  }
  if (probe === undefined) throw new StageError("privacy-unproven", EXIT.refused);
  const url = `${o.publicBase.replace(/\/+$/, "")}/${objectKey(dataset, probe)}`;
  const status = await anonymousHeadStatus(url, o.timeoutMs);
  if (status === 403) return;
  if (status === 200) throw new StageError("dataset-is-public", EXIT.refused);
  throw new StageError("privacy-unproven", EXIT.refused);
}

export async function deleteOldStage(o: DeleteOptions): Promise<number> {
  const planBytes = await readBytes(path.join(o.dir, "plan.json"), "plan.json");
  const plan = parseFile("plan.json", parsePlan, planBytes.toString("utf8"));
  // Typed again by the operator, before anything else is read: a stage that deletes names its
  // target twice. Applies to the dry run too, so a wrong working directory shows up early.
  if (o.confirmDataset !== plan.dataset) {
    throw new StageError("confirm-dataset-mismatch", EXIT.refused);
  }
  if (plan.partial) throw new StageError("plan-partial", EXIT.refused);
  const assembledBytes = await readBytes(path.join(o.dir, "assembled.json"), "assembled.json");
  const assembled = parseFile("assembled.json", parseAssembled, assembledBytes.toString("utf8"));
  const sha = sha256Hex(assembledBytes);
  const entries = Object.entries(assembled.entries);
  const dataset = assembled.dataset;

  // Both proofs must exist and vouch for these exact bytes.
  const verified = parseFile(
    "verified.json",
    parseVerified,
    (await readBytes(path.resolve(o.dir, o.verifiedFile), "verified.json")).toString("utf8"),
  );
  const hashVerified = parseFile(
    "new-hash-verified.json",
    parseHashVerified,
    (await readBytes(path.resolve(o.dir, o.hashVerifiedFile), "new-hash-verified.json")).toString(
      "utf8",
    ),
  );
  if (verified.assembledSha256 !== sha) throw new StageError("verified-stale", EXIT.refused);
  if (hashVerified.assembledSha256 !== sha) {
    throw new StageError("new-hash-verified-stale", EXIT.refused);
  }
  if (verified.dataset !== dataset || hashVerified.dataset !== dataset) {
    throw new StageError("proof-wrong-dataset", EXIT.refused);
  }
  if (plan.dataset !== dataset || plan.bucket !== assembled.bucket) {
    throw new StageError("assembled-wrong-dataset", EXIT.refused);
  }
  if (verified.counts.keys !== entries.length || hashVerified.count !== entries.length) {
    throw new StageError("proof-count-mismatch", EXIT.refused);
  }

  // Every old key has a different new key, and no old key is any new key.
  const oldKeys = entries.map(([k]) => k).sort();
  const newKeys = new Set(entries.map(([, e]) => e.newKey));
  if (newKeys.size !== entries.length) throw new StageError("duplicate-new-key", EXIT.refused);
  for (const [k, e] of entries) {
    if (e.newKey === k) throw new StageError("new-key-equals-old-key", EXIT.refused);
  }
  if (oldKeys.some((k) => newKeys.has(k)))
    throw new StageError("old-key-is-a-new-key", EXIT.refused);
  const planned = new Map(plan.keys.map((k) => [k.oldKey, k]));
  if (oldKeys.some((k) => !planned.get(k)?.needsScrub)) {
    throw new StageError("assembled-not-in-plan", EXIT.refused);
  }
  for (const p of o.prune) checkPrunePrefix(dataset, p);

  return withCtx(o, assembled.bucket, async (ctx) => {
    // The replacement must still be there before anything it replaces is touched.
    const missing = await runPool(entries, o.concurrency, async ([k, e]) => {
      const head = await headObject(ctx, objectKey(dataset, e.newKey), e.newVersionId);
      return head !== null && head.size === parseKey(k).size;
    });
    if (missing.some((ok) => ok !== true)) throw new StageError("new-object-missing", EXIT.refused);

    // What must be true of the rest of the dataset before an old key may go. All of it is read
    // only, and all of it runs in the dry run, so a refusal is seen before --execute is typed.
    await refuseManifestNamingOldKey(ctx, dataset, new Set(oldKeys));
    if (await hasCurrentKey(ctx, `${dataset}/archives/`)) {
      throw new StageError("archives-not-dropped", EXIT.refused);
    }
    if (await hasCurrentKey(ctx, `${dataset}/zarr/`)) {
      await requireZarrVerified(o.dir, dataset, planBytes);
    }
    await requirePrivate(ctx, o, dataset, oldKeys);

    const listed = await listOldKeys(ctx, dataset, oldKeys, o.concurrency);
    const totalVersions = listed.reduce((n, l) => n + l.versions.length, 0);
    const totalMarkers = listed.reduce((n, l) => n + l.markers.length, 0);
    const recorded = oldKeys.reduce((n, k) => n + (planned.get(k) as PlanKey).versionIds.length, 0);
    const limit = o.maxDelete ?? recorded;
    o.log(
      `delete-old: keys=${oldKeys.length} versions=${totalVersions} markers=${totalMarkers} planRecorded=${recorded} limit=${limit}`,
    );
    if (totalVersions + totalMarkers > limit) {
      throw new StageError("over-max-delete", EXIT.refused);
    }

    // Noncurrent versions and markers under the prune prefixes; never a current entry.
    const prunes: Array<{ key: string; versionId: string; kind: "version" | "marker" }> = [];
    for (const prefix of o.prune) {
      for (const e of await listPrefixVersions(ctx, prefix)) {
        if (!e.isLatest) prunes.push({ key: e.key, versionId: e.versionId, kind: e.kind });
      }
    }
    const prunedVersions = prunes.filter((p) => p.kind === "version").length;
    const prunedMarkers = prunes.length - prunedVersions;
    if (o.prune.length > 0) {
      o.log(`delete-old: prune noncurrent versions=${prunedVersions} markers=${prunedMarkers}`);
    }
    if (prunes.length > o.maxPrune) throw new StageError("over-max-prune", EXIT.refused);

    if (!o.execute) {
      o.log(
        `delete-old dry run: would delete versions=${totalVersions} markers=${totalMarkers} across ${oldKeys.length} keys`,
      );
      return 0;
    }

    const errors: string[] = [];
    const removeAll = async (
      items: Array<{ key: string; versionId: string }>,
      bypass: boolean,
    ): Promise<void> => {
      await runPool(items, o.concurrency, async (it) => {
        try {
          await deleteVersion(ctx, it.key, it.versionId, bypass);
        } catch (err) {
          errors.push(failureWord(err));
        }
      });
    };
    await removeAll(
      listed.flatMap((l) =>
        [...l.versions, ...l.markers].map((versionId) => ({ key: l.obj, versionId })),
      ),
      true,
    );
    // Pruning never bypasses the lock: a locked object is refused, not forced.
    await removeAll(prunes, false);

    // The listing is the authority, not the answers to the deletes.
    const after = await listOldKeys(ctx, dataset, oldKeys, o.concurrency);
    const remaining = after.reduce((n, l) => n + l.versions.length + l.markers.length, 0);
    let prunesRemaining = 0;
    for (const prefix of o.prune) {
      prunesRemaining += (await listPrefixVersions(ctx, prefix)).filter((e) => !e.isLatest).length;
    }
    if (errors.length > 0) {
      o.log(`delete-old: delete errors=${errors.length} (${formatWordCounts(countWords(errors))})`);
    }
    if (remaining > 0 || prunesRemaining > 0) {
      o.log(
        `delete-old: FAILED, versions and markers remain: oldKeys=${remaining} pruned=${prunesRemaining}`,
      );
      o.log("delete-old: deleted.json NOT written");
      return EXIT.remainder;
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
      },
    };
    await writeJson(o.dir, "deleted.json", done);
    o.log(
      `delete-old: deleted versions=${totalVersions} markers=${totalMarkers}; zero versions and zero markers remain for ${oldKeys.length} keys`,
    );
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
}

/**
 * The canary writes a locked object and deletes it with the bypass, so where it may do that is
 * fixed, not typed: the end-to-end fixture's id (`nm099999`) or an `xx0NNNNN` sandbox id, and one
 * directory below it. A live dataset's id, a standing fixture's (`nm099998`) and any deeper
 * prefix never match.
 */
const CANARY_PREFIX = /^(nm099999|xx0\d{5})\/canary-[A-Za-z0-9_-]+\/$/;

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

export async function canaryStage(o: CanaryOptions): Promise<number> {
  checkCanaryPrefix(o.prefix);
  const steps = [
    `put ${o.prefix}probe.txt with GOVERNANCE retention for 1 day`,
    "delete that version WITHOUT the bypass (expect AccessDenied)",
    "delete that version WITH the bypass (expect success)",
    "list the prefix (expect zero versions and zero delete markers)",
  ];
  if (o.multipart) {
    steps.push(
      `build ${o.prefix}multipart.bin from an upload part and a server-side copy, with the lock set at create`,
      "repeat the delete without and with the bypass on it and on its source",
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
          await abortMultipart(ctx, mpKey, uploadId).catch(() => undefined);
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
    } finally {
      await ctx.tmp.remove(body);
    }

    const left = await listPrefixVersions(ctx, o.prefix);
    if (left.length > 0) throw new StageError("canary-remainder", EXIT.remainder);
    o.log("canary: zero versions and zero delete markers remain under the prefix");
    return 0;
  });
}
