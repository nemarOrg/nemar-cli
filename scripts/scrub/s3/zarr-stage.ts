/**
 * The `zarr` stage of an in-place scrub: remove the identifier keys the serving copy repeats.
 *
 * Every Zarr store root, `<id>/zarr/<path>/<name>.zarr/zarr.json`, carries the recording's
 * header fields in `attributes.recording_metadata` (a patient code, a birth date, a technician,
 * ...), copied from the EDF or BDF header. Scrubbing the recording leaves them in the Zarr copy,
 * which is a second public home for the same identifiers. This stage reads each store root, cuts
 * the keys the scanner calls identifiers and every mirrored EDF identification field out of its
 * `attributes` (`zarr-json.ts`, one rule), writes it back, and reads it again to prove the result
 * is clean by the same rule.
 *
 * Every `zarr.json` inside a store is read too (an array's or a nested group's metadata), cleaned
 * by the same rule and re-read, up to `--max-zarr-json` documents (default
 * {@link DEFAULT_MAX_ZARR_JSON}; more is refused before anything is read, `too-many-zarr-json`). A
 * document's recording metadata may hold only members some list names ({@link
 * unknownRecordingMembers}): any other name refuses the run (`unknown-recording-member`), and the
 * names, never the values, go to `zarr-unknown-members.json` (0600) for a person to look at and
 * accept with `--allow-member NAME`, which `zarr-verified.json` records.
 *
 * What it does NOT do: it touches no other Zarr object (not a chunk, not an index), it never
 * overwrites a document someone else changed since it was read (the write is conditional on the
 * ETag that was read), and it never prints, logs or writes a value from a store. Output is counts
 * and fixed words; `zarr-plan.json` holds counts and a digest of the keys it examined, never a
 * key; `zarr-verified.json` names the store roots it proved, for `zarr-public`.
 *
 * Zarr objects carry no Object Lock, so a rewrite makes a new version and leaves the old one
 * (identifiers and all) as a noncurrent version. `delete-old --prune-noncurrent <id>/zarr/` is
 * the step that removes it, and that stage will not run while Zarr objects are current unless
 * the proof this stage writes (`zarr-verified.json`) exists for the plan.
 */

import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { canonical } from "../../../shared/identifier-scan";
import { type ZarrPlanFile, type ZarrVerifiedFile, parsePlan } from "../contract";
import {
  AwsCliError,
  EXIT,
  type S3Ctx,
  StageError,
  countWords,
  failureWord,
  formatWordCounts,
  headObject,
  listCurrentKeys,
  putObjectIfMatch,
  readWholeWithMeta,
  runPool,
  sha256Hex,
} from "./s3-lib";
import {
  type CommonOptions,
  checkDataset,
  parseFile,
  readBytes,
  requireCompletePlan,
  withCtx,
  writeJson,
} from "./s3-stages";
import {
  MAX_ZARR_JSON_BYTES,
  type Removal,
  STORE_ROOT,
  ZarrJsonError,
  parseZarrJsonBytes,
  removeIdentifierKeys,
  unknownRecordingMembers,
  zarrIdentifierCount,
} from "./zarr-json";

/** The most `zarr.json` documents one run reads: more is refused, never sampled. */
export const DEFAULT_MAX_ZARR_JSON = 20_000;

export interface ZarrOptions extends CommonOptions {
  dir: string;
  execute: boolean;
  concurrency: number;
  /** Recording-metadata member names the operator accepts (any spelling; kept canonical). */
  allowMembers: string[];
  /** Refuse a prefix with more zarr.json documents than this (`too-many-zarr-json`). */
  maxDocs: number;
}

interface StoreResult {
  key: string;
  outcome: string;
  removed: number;
  /** Recording-metadata member names no list accounts for (names only). */
  unknown?: string[];
}

/** Outcomes that mean the store is, or would be after a rewrite, free of identifier keys. */
const OK = new Set(["clean", "needs-scrub", "scrubbed"]);
/** Stores the stage cannot read or cannot clean: the plan is incomplete, nothing can be proven. */
const UNREADABLE = new Set([
  "zarr-json-malformed",
  "zarr-json-bom",
  "zarr-json-too-large",
  "identifier-outside-attributes",
  "zarr-v2-metadata",
  "zarr-json-outside-store",
  "store-root-missing",
  "no-store-root",
]);

/**
 * Zarr v2 keeps its metadata in `.zattrs`, `.zgroup` and `.zmetadata`. The pipeline writes v3,
 * so one of these is a layout this stage does not read, and "no identifier keys found" would
 * mean nothing. It is counted, not skipped.
 */
const V2_METADATA = /\/\.(zattrs|zgroup|zmetadata)$/;
/** A `zarr.json` below a store root: an array's or a nested group's, which this stage leaves. */
const INSIDE_STORE = /\.zarr\/.+\/zarr\.json$/;
/** The store a key belongs to: the path up to the first `.zarr` directory. */
const STORE_DIR = /^(.*?\.zarr)\//;

export interface ZarrLayout {
  /** `no-zarr` only when the prefix holds no current object at all. */
  found: "stores" | "no-zarr";
  roots: string[];
  /** Every zarr.json inside a store: an array's or a nested group's metadata. */
  nested: string[];
  /** Keys that say the stage cannot vouch for the prefix, each with the fixed word why. */
  unreadable: StoreResult[];
}

/**
 * Where the store roots of a listing of `<id>/zarr/` are, and what in it this stage cannot
 * account for. A proof must not be vacuous: a prefix with objects and no store root, a
 * `zarr.json` that is neither a store root nor inside a store, and a store with no root are all
 * unreadable, because "no identifier key found" would then be said about nothing.
 */
export function zarrLayout(prefix: string, listed: string[]): ZarrLayout {
  if (listed.length === 0) return { found: "no-zarr", roots: [], nested: [], unreadable: [] };
  const keys = new Set(listed);
  const roots = listed.filter((k) => STORE_ROOT.test(k)).sort();
  const unreadable: StoreResult[] = [];
  const add = (key: string, outcome: string) => unreadable.push({ key, outcome, removed: 0 });
  const stores = new Set<string>();
  for (const k of [...listed].sort()) {
    if (V2_METADATA.test(k)) add(k, "zarr-v2-metadata");
    if (k.endsWith("/zarr.json") && !STORE_ROOT.test(k) && !INSIDE_STORE.test(k)) {
      add(k, "zarr-json-outside-store");
    }
    const dir = STORE_DIR.exec(k)?.[1];
    if (dir !== undefined) stores.add(dir);
  }
  for (const dir of [...stores].sort()) {
    if (!keys.has(`${dir}/zarr.json`)) add(dir, "store-root-missing");
  }
  if (roots.length === 0) add(prefix, "no-store-root");
  const nested = listed.filter((k) => INSIDE_STORE.test(k)).sort();
  return { found: "stores", roots, nested, unreadable };
}

async function scrubStore(
  ctx: S3Ctx,
  key: string,
  execute: boolean,
  allowed: ReadonlySet<string>,
): Promise<StoreResult> {
  const result = (outcome: string, removed = 0): StoreResult => ({ key, outcome, removed });
  try {
    const head = await headObject(ctx, key);
    // Listed a moment ago and gone now: not something to call clean, and not proven.
    if (!head) return result("HeadObject:not-found");
    if (head.size > MAX_ZARR_JSON_BYTES) return result("zarr-json-too-large");
    // One read, pinned to the ETag the HEAD saw, so the bytes and the ETag are one version.
    const whole = await readWholeWithMeta(ctx, key, head.etag);
    let text: string;
    let doc: unknown;
    try {
      ({ text, doc } = parseZarrJsonBytes(whole.bytes));
    } catch (err) {
      if (err instanceof ZarrJsonError) return result(err.word);
      throw err;
    }
    // A member nobody listed may hold header text: refused before anything is written.
    const unknown = unknownRecordingMembers(doc, allowed);
    if (unknown.length > 0)
      return { key, outcome: "unknown-recording-member", removed: 0, unknown };
    if (zarrIdentifierCount(doc) === 0) return result("clean");

    let edit: Removal;
    let after: unknown;
    try {
      edit = removeIdentifierKeys(text);
      after = JSON.parse(edit.text);
    } catch (err) {
      if (err instanceof ZarrJsonError || err instanceof SyntaxError) {
        return result("zarr-json-malformed");
      }
      throw err;
    }
    // The edit only reaches `attributes`. A key the scanner flags anywhere else is left, and the
    // store cannot be called clean.
    if (zarrIdentifierCount(after) > 0) return result("identifier-outside-attributes");
    if (!execute) return result("needs-scrub", edit.removed);

    const body = ctx.tmp.file();
    try {
      await writeFile(body, edit.text, { mode: 0o600 });
      await putObjectIfMatch(
        ctx,
        key,
        body,
        {
          contentType: whole.contentType,
          sse: whole.sse,
          kmsKeyId: whole.kmsKeyId,
          cacheControl: whole.cacheControl,
        },
        whole.etag,
      );
    } catch (err) {
      // Someone wrote the key since it was read: their version stands, and a re-run reads it.
      if (err instanceof AwsCliError && err.code === "precondition-failed") {
        return result("changed-concurrently");
      }
      throw err;
    } finally {
      await ctx.tmp.remove(body);
    }

    // What is there now, read again, must be clean.
    const back = await readWholeWithMeta(ctx, key);
    let reread: unknown;
    try {
      reread = parseZarrJsonBytes(back.bytes).doc;
    } catch {
      return result("verify-failed");
    }
    if (zarrIdentifierCount(reread) > 0) return result("verify-failed");
    if (unknownRecordingMembers(reread, allowed).length > 0) return result("verify-failed");
    return result("scrubbed", edit.removed);
  } catch (err) {
    return result(failureWord(err));
  }
}

export async function zarrStage(o: ZarrOptions): Promise<number> {
  const planBytes = await readBytes(path.join(o.dir, "plan.json"), "plan.json");
  const plan = parseFile("plan.json", parsePlan, planBytes.toString("utf8"));
  checkDataset(plan.dataset);
  requireCompletePlan(plan);
  // A proof from an earlier run must not outlive this one: it holds only once this run ends well.
  await rm(path.join(o.dir, "zarr-verified.json"), { force: true });

  const allowed = new Set(o.allowMembers.map(canonical));
  if ([...allowed].some((m) => !/^[a-z0-9]+$/.test(m))) {
    throw new StageError("bad-allow-member", EXIT.usage);
  }
  for (const f of ["zarr-unknown-members.json"]) await rm(path.join(o.dir, f), { force: true });

  return withCtx(o, plan.bucket, async (ctx) => {
    const prefix = `${plan.dataset}/zarr/`;
    const layout = zarrLayout(prefix, await listCurrentKeys(ctx, prefix));
    const docs = [...layout.roots, ...layout.nested];
    if (docs.length > o.maxDocs) {
      o.log(`zarr: ${docs.length} zarr.json documents, more than --max-zarr-json ${o.maxDocs}`);
      throw new StageError("too-many-zarr-json", EXIT.refused);
    }

    const scrubbed = await runPool(docs, o.concurrency, (k) =>
      scrubStore(ctx, k, o.execute, allowed),
    );
    const results: StoreResult[] = [...(scrubbed as StoreResult[]), ...layout.unreadable];

    const count = (pred: (r: StoreResult) => boolean) => results.filter(pred).length;
    const unknownDocs = results.filter((r) => r.outcome === "unknown-recording-member");
    const totals: ZarrPlanFile["totals"] = {
      stores: layout.roots.length,
      docs: docs.length,
      clean: count((r) => r.outcome === "clean"),
      needScrub: count((r) => r.outcome === "needs-scrub"),
      scrubbed: count((r) => r.outcome === "scrubbed"),
      unreadable: count((r) => UNREADABLE.has(r.outcome)),
      unknownMembers: unknownDocs.length,
      failed: count(
        (r) =>
          !OK.has(r.outcome) &&
          !UNREADABLE.has(r.outcome) &&
          r.outcome !== "unknown-recording-member",
      ),
    };
    // Counts and one digest, never a key: a key is a path that may be built from a file name.
    const zarrPlan: ZarrPlanFile = {
      version: 1,
      dataset: plan.dataset,
      bucket: plan.bucket,
      planSha256: sha256Hex(planBytes),
      createdAt: new Date().toISOString(),
      executed: o.execute,
      found: layout.found,
      keysSha256: sha256Hex(
        new TextEncoder().encode(
          results
            .map((r) => r.key)
            .sort()
            .join("\n"),
        ),
      ),
      outcomes: countWords(results.map((r) => r.outcome)),
      removedMembers: results.reduce((n, r) => n + r.removed, 0),
      totals,
    };
    await writeJson(o.dir, "zarr-plan.json", zarrPlan);

    const notOk = results.filter((r) => !OK.has(r.outcome)).map((r) => r.outcome);
    o.log(
      o.execute
        ? `zarr: stores=${totals.stores} docs=${totals.docs} clean=${totals.clean} scrubbed=${totals.scrubbed} unreadable=${totals.unreadable} unknownMembers=${totals.unknownMembers} failed=${totals.failed}`
        : `zarr dry run (nothing written to S3): stores=${totals.stores} docs=${totals.docs} clean=${totals.clean} needScrub=${totals.needScrub} unreadable=${totals.unreadable} unknownMembers=${totals.unknownMembers} failed=${totals.failed}`,
    );
    if (notOk.length > 0)
      o.log(`zarr: not clean, by reason: ${formatWordCounts(countWords(notOk))}`);

    if (totals.failed > 0) {
      if (o.execute) o.log("zarr: zarr-verified.json NOT written; a re-run reads each store again");
      return EXIT.failed;
    }
    if (unknownDocs.length > 0) {
      // Names, never values, for a person to look at: which, and in how many documents.
      const counts: Record<string, number> = {};
      for (const r of unknownDocs)
        for (const n of new Set(r.unknown)) counts[n] = (counts[n] ?? 0) + 1;
      const names = Object.keys(counts).sort();
      await writeJson(o.dir, "zarr-unknown-members.json", {
        version: 1,
        dataset: plan.dataset,
        names,
        documents: Object.fromEntries(names.map((n) => [n, counts[n]])),
      });
      o.log(
        `zarr: unknown-recording-member in ${unknownDocs.length} document(s), ${names.length} distinct name(s); the names are in zarr-unknown-members.json`,
      );
      o.log("zarr: nothing is proven; after a look, name each with --allow-member and run again");
      throw new StageError("unknown-recording-member", EXIT.refused);
    }
    if (totals.unreadable > 0) {
      o.log("zarr: incomplete; some store could not be read or cleaned, nothing is proven");
      return EXIT.unreadable;
    }
    if (!o.execute) return 0;

    const zarrPlanBytes = await readBytes(path.join(o.dir, "zarr-plan.json"), "zarr-plan.json");
    const proof: ZarrVerifiedFile = {
      version: 1,
      dataset: plan.dataset,
      verifiedAt: new Date().toISOString(),
      planSha256: sha256Hex(planBytes),
      zarrPlanSha256: sha256Hex(zarrPlanBytes),
      found: layout.found,
      // As index.json spells them: the path under <id>/zarr/ of each store root's directory.
      stores: layout.roots.map((k) => k.slice(prefix.length, -"/zarr.json".length)).sort(),
      allowedMembers: [...allowed].sort(),
      counts: {
        stores: totals.stores,
        docs: totals.docs,
        rewritten: totals.scrubbed,
        untouched: totals.clean,
      },
    };
    await writeJson(o.dir, "zarr-verified.json", proof);
    o.log(
      layout.found === "no-zarr"
        ? "zarr: ok; the dataset has no Zarr copy (no current object under the prefix)"
        : `zarr: ok; every one of ${totals.stores} store roots and ${totals.docs} zarr.json documents is clean`,
    );
    return 0;
  });
}
