/**
 * The `drop-archives` stage of an in-place scrub: remove every copy of the dataset's archives.
 *
 * The archive under `<id>/archives/` is a zip of the dataset's files as they were, original
 * recordings and all, so it is a second home for exactly the bytes the scrub replaces, and it is
 * not an object the scrub swaps for a new key: nothing can be patched inside a zip. The remedy is
 * to delete it, every VERSION and every delete marker, and let the normal workflow build a fresh
 * archive from the scrubbed tree afterwards (runbook step 16, not this stage's). The drop itself is
 * runbook step 15a, and it cannot be undone, so the stage checks for itself that the scrub has been
 * verified everywhere before it deletes anything: the proofs of the S3 objects (`verified.json`,
 * `new-hash-verified.json`), of the pushed history (`git-verified.json` from a fresh clone) and of
 * the Zarr copy (`zarr-verified.json`) must all be in the working directory, parse, and name this
 * plan, by the same rule `delete-old` applies (`checkScrubProofs`, `checkZarrProof`). Every missing
 * or stale proof is reported, in the dry run too, beside what the run would delete.
 *
 * Deletes are by version id and never use the governance bypass. Archives carry no lock, so a
 * refusal means something is locked that should not be: it is reported and the stage fails, and
 * the lock is a person's to look at, not this stage's to force. The last step is an authoritative
 * `ListObjectVersions` that must show nothing; only then is `archives-dropped.json` written.
 */

import { rm } from "node:fs/promises";
import path from "node:path";
import { parsePlan } from "../contract";
import {
  EXIT,
  countWords,
  deleteVersions,
  formatWordCounts,
  hasCurrentKey,
  listPrefixVersions,
} from "./s3-lib";
import { StageError } from "./s3-lib";
import {
  type CommonOptions,
  type ProofFiles,
  Refusals,
  checkDataset,
  checkScrubProofs,
  checkZarrProof,
  parseFile,
  readBytes,
  requireCompletePlan,
  withCtx,
  writeJson,
} from "./s3-stages";

export interface DropArchivesOptions extends CommonOptions, ProofFiles {
  dir: string;
  /** The dataset id, typed again by the operator; must equal the plan's. Required, dry run too. */
  confirmDataset: string;
  execute: boolean;
  concurrency: number;
}

/** `archives-dropped.json`: counts only, written only after the final listing showed zero. */
export interface ArchivesDroppedFile {
  version: 1;
  dataset: string;
  droppedAt: string;
  counts: { keys: number; versions: number; markers: number };
}

export async function dropArchivesStage(o: DropArchivesOptions): Promise<number> {
  const planBytes = await readBytes(path.join(o.dir, "plan.json"), "plan.json");
  const plan = parseFile("plan.json", parsePlan, planBytes.toString("utf8"));
  if (o.confirmDataset !== plan.dataset) {
    throw new StageError("confirm-dataset-mismatch", EXIT.refused);
  }
  checkDataset(plan.dataset);
  requireCompletePlan(plan);
  const dataset = plan.dataset;
  const prefix = `${dataset}/archives/`;
  // A proof from an earlier run must not outlive this one: it holds only once this run ends well.
  await rm(path.join(o.dir, "archives-dropped.json"), { force: true });

  // The originals go only once the scrub is proven for this plan: every proof is evaluated, and
  // every one that is missing or stale is reported together.
  const refusals: Refusals = new Refusals();
  await checkScrubProofs(o.dir, plan, planBytes, o, refusals);

  return withCtx(o, plan.bucket, async (ctx) => {
    const zarrCurrent = await hasCurrentKey(ctx, `${dataset}/zarr/`);
    await checkZarrProof(o.dir, dataset, planBytes, zarrCurrent, refusals);

    const found = await listPrefixVersions(ctx, prefix);
    const counts = {
      keys: new Set(found.map((e) => e.key)).size,
      versions: found.filter((e) => e.kind === "version").length,
      markers: found.filter((e) => e.kind === "marker").length,
    };
    o.log(
      `drop-archives: keys=${counts.keys} versions=${counts.versions} markers=${counts.markers}`,
    );
    // The dry run says what it would delete even when it refuses, so the operator sees both.
    if (!o.execute) {
      o.log(
        `drop-archives dry run: would delete versions=${counts.versions} markers=${counts.markers} across ${counts.keys} keys`,
      );
    }
    refusals.stopIfAny("drop-archives", o.log);
    if (!o.execute) return 0;

    // By id, and never with the bypass: nothing here is locked, so a refusal is news.
    const errors = await deleteVersions(ctx, found, false, o.concurrency);

    // The listing is the authority, not the answers to the deletes.
    const left = await listPrefixVersions(ctx, prefix);
    if (errors.length > 0) {
      o.log(
        `drop-archives: delete errors=${errors.length} (${formatWordCounts(countWords(errors))})`,
      );
    }
    if (left.length > 0) {
      o.log(`drop-archives: FAILED, versions and markers remain: ${left.length}`);
      o.log("drop-archives: archives-dropped.json NOT written");
      return EXIT.remainder;
    }
    const done: ArchivesDroppedFile = {
      version: 1,
      dataset,
      droppedAt: new Date().toISOString(),
      counts,
    };
    await writeJson(o.dir, "archives-dropped.json", done);
    o.log(
      `drop-archives: deleted versions=${counts.versions} markers=${counts.markers}; zero versions and zero markers remain under the archive prefix`,
    );
    return 0;
  });
}
