/**
 * The `drop-archives` stage of an in-place scrub: remove every copy of the dataset's archives.
 *
 * The archive under `<id>/archives/` is a zip of the dataset's files as they were, original
 * recordings and all, so it is a second home for exactly the bytes the scrub replaces, and it is
 * not an object the scrub swaps for a new key: nothing can be patched inside a zip. The remedy is
 * to delete it, every VERSION and every delete marker, and let the normal workflow build a fresh
 * archive from the scrubbed tree afterwards (a runbook step, not this stage's).
 *
 * Deletes are by version id and never use the governance bypass. Archives carry no lock, so a
 * refusal means something is locked that should not be: it is reported and the stage fails, and
 * the lock is a person's to look at, not this stage's to force. The last step is an authoritative
 * `ListObjectVersions` that must show nothing; only then is `archives-dropped.json` written.
 */

import path from "node:path";
import { parsePlan } from "../contract";
import {
  EXIT,
  countWords,
  deleteVersion,
  failureWord,
  formatWordCounts,
  listPrefixVersions,
  runPool,
} from "./s3-lib";
import { StageError } from "./s3-lib";
import {
  type CommonOptions,
  checkDataset,
  parseFile,
  readBytes,
  withCtx,
  writeJson,
} from "./s3-stages";

export interface DropArchivesOptions extends CommonOptions {
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
  const prefix = `${plan.dataset}/archives/`;

  return withCtx(o, plan.bucket, async (ctx) => {
    const found = await listPrefixVersions(ctx, prefix);
    const counts = {
      keys: new Set(found.map((e) => e.key)).size,
      versions: found.filter((e) => e.kind === "version").length,
      markers: found.filter((e) => e.kind === "marker").length,
    };
    o.log(
      `drop-archives: keys=${counts.keys} versions=${counts.versions} markers=${counts.markers}`,
    );
    if (!o.execute) {
      o.log(
        `drop-archives dry run: would delete versions=${counts.versions} markers=${counts.markers} across ${counts.keys} keys`,
      );
      return 0;
    }

    const errors: string[] = [];
    await runPool(found, o.concurrency, async (e) => {
      try {
        // By id, and never with the bypass: nothing here is locked, so a refusal is news.
        await deleteVersion(ctx, e.key, e.versionId, false);
      } catch (err) {
        errors.push(failureWord(err));
      }
    });

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
      dataset: plan.dataset,
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
