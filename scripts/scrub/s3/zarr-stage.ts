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
 * What it does NOT do: it touches no other Zarr object (not a chunk, not an array's or a nested
 * group's metadata, not an index), it never overwrites a store root someone else changed since
 * it was read (the write is conditional on the ETag that was read), and it never prints, logs or
 * writes a value from a store. Output is counts and fixed words; `zarr-plan.json` adds the S3
 * keys, in the private working directory.
 *
 * Zarr objects carry no Object Lock, so a rewrite makes a new version and leaves the old one
 * (identifiers and all) as a noncurrent version. `delete-old --prune-noncurrent <id>/zarr/` is
 * the step that removes it, and that stage will not run while Zarr objects are current unless
 * the proof this stage writes (`zarr-verified.json`) exists for the plan.
 */

import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { type ZarrPlanFile, type ZarrVerifiedFile, parsePlan } from "../contract";
import {
  AwsCliError,
  EXIT,
  type S3Ctx,
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
  zarrIdentifierCount,
} from "./zarr-json";

export interface ZarrOptions extends CommonOptions {
  dir: string;
  execute: boolean;
  concurrency: number;
}

interface StoreResult {
  key: string;
  outcome: string;
  removed: number;
}

/** Outcomes that mean the store is, or would be after a rewrite, free of identifier keys. */
const OK = new Set(["clean", "needs-scrub", "scrubbed"]);
/** Stores the stage cannot read or cannot clean: the plan is incomplete, nothing can be proven. */
const UNREADABLE = new Set([
  "zarr-json-malformed",
  "zarr-json-too-large",
  "identifier-outside-attributes",
  "zarr-v2-metadata",
]);

/**
 * Zarr v2 keeps its metadata in `.zattrs`, `.zgroup` and `.zmetadata`. The pipeline writes v3,
 * so one of these is a layout this stage does not read, and "no identifier keys found" would
 * mean nothing. It is counted, not skipped.
 */
const V2_METADATA = /\/\.(zattrs|zgroup|zmetadata)$/;

async function scrubStore(ctx: S3Ctx, key: string, execute: boolean): Promise<StoreResult> {
  const result = (outcome: string, removed = 0): StoreResult => ({ key, outcome, removed });
  try {
    const head = await headObject(ctx, key);
    // Listed a moment ago and gone now: not something to call clean.
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
    return result("scrubbed", edit.removed);
  } catch (err) {
    return result(failureWord(err));
  }
}

export async function zarrStage(o: ZarrOptions): Promise<number> {
  const planBytes = await readBytes(path.join(o.dir, "plan.json"), "plan.json");
  const plan = parseFile("plan.json", parsePlan, planBytes.toString("utf8"));
  checkDataset(plan.dataset);
  // A proof from an earlier run must not outlive this one: it holds only once this run ends well.
  await rm(path.join(o.dir, "zarr-verified.json"), { force: true });

  return withCtx(o, plan.bucket, async (ctx) => {
    const listed = await listCurrentKeys(ctx, `${plan.dataset}/zarr/`);
    const roots = listed.filter((k) => STORE_ROOT.test(k)).sort();
    const v2 = listed.filter((k) => V2_METADATA.test(k)).sort();

    const scrubbed = await runPool(roots, o.concurrency, (k) => scrubStore(ctx, k, o.execute));
    const results: StoreResult[] = [
      ...(scrubbed as StoreResult[]),
      ...v2.map((key) => ({ key, outcome: "zarr-v2-metadata", removed: 0 })),
    ];

    const count = (pred: (r: StoreResult) => boolean) => results.filter(pred).length;
    const totals: ZarrPlanFile["totals"] = {
      stores: roots.length,
      clean: count((r) => r.outcome === "clean"),
      needScrub: count((r) => r.outcome === "needs-scrub"),
      scrubbed: count((r) => r.outcome === "scrubbed"),
      unreadable: count((r) => UNREADABLE.has(r.outcome)),
      failed: count((r) => !OK.has(r.outcome) && !UNREADABLE.has(r.outcome)),
    };
    const zarrPlan: ZarrPlanFile = {
      version: 1,
      dataset: plan.dataset,
      bucket: plan.bucket,
      planSha256: sha256Hex(planBytes),
      createdAt: new Date().toISOString(),
      executed: o.execute,
      stores: results,
      totals,
    };
    await writeJson(o.dir, "zarr-plan.json", zarrPlan);

    const notOk = results.filter((r) => !OK.has(r.outcome)).map((r) => r.outcome);
    o.log(
      o.execute
        ? `zarr: stores=${totals.stores} clean=${totals.clean} scrubbed=${totals.scrubbed} unreadable=${totals.unreadable} failed=${totals.failed}`
        : `zarr dry run (nothing written to S3): stores=${totals.stores} clean=${totals.clean} needScrub=${totals.needScrub} unreadable=${totals.unreadable} failed=${totals.failed}`,
    );
    if (notOk.length > 0)
      o.log(`zarr: not clean, by reason: ${formatWordCounts(countWords(notOk))}`);

    if (totals.failed > 0) {
      if (o.execute) o.log("zarr: zarr-verified.json NOT written; a re-run reads each store again");
      return EXIT.failed;
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
      counts: { stores: totals.stores, rewritten: totals.scrubbed, untouched: totals.clean },
    };
    await writeJson(o.dir, "zarr-verified.json", proof);
    o.log(`zarr: ok; every one of ${totals.stores} store roots is clean`);
    return 0;
  });
}
