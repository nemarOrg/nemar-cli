/**
 * The re-pull's delta scrub (ADR 0111, decisions 2 and 9; ADR 0089's scrub, ADR 0091's dates):
 * the importer's own scrub, run on the delta paths only, before any copy and before the one commit.
 *
 * An object a copy writes is anonymously readable by key, so nothing unscrubbed may be copied into
 * NEMAR's bucket, and nothing unscrubbed may enter NEMAR's history. So the scrub runs here, in the
 * working clone, on exactly what the commit will add:
 *  - its scope is the delta paths (every path materialized or deleted, the NEMAR-owned edit
 *    included) and the provenance files, which the scrub annotates when a header changes (the
 *    lead's ruling recorded in the Phase 6b amendment: the caller puts both in the scope);
 *  - each annexed recording's header is read from the version of upstream's object the plan pinned,
 *    which is the version the copy will copy ({@link pinnedSources}); a key NEMAR already holds is
 *    not read again, because its bytes are already in NEMAR's bucket where the identifier screen
 *    reads them;
 *  - dates are set (it is not a re-import), on delta recordings only, so nothing already published
 *    is changed;
 *  - its ledger line is `repull-scrubbed`, at the row's creation time and under a fixed actor, so
 *    preparing twice writes the same line.
 * Then the git-held data NEMAR's policy annexes, and that the scrub did not take, is annexed and
 * uploaded with the same upload, as the import's annex-policy leg does for its own files.
 */

import {
  locationLogs,
  presentIn,
  readLocationLogsAt,
} from "../../../../scripts/scrub/git/git-lib.js";
import { runCommand } from "../../git-annex/run-command.js";
import { listAnnexedKeys } from "../../git-annex/transfer.js";
import { type UploadStrategy, normalizeUnannexedData } from "../../import-normalize.js";
import {
  ImportScrubRefused,
  type ImportScrubResult,
  RECORDING_PATH,
  type UpstreamReader,
  type UpstreamSource,
  assertCopiedRecordingsRead,
  describeError,
  scrubImportedTree,
} from "../../import-scrub.js";
import type { ImportManifestItem } from "../../s3-server-copy.js";
import type { PlanBody } from "../digest.js";
import { guardedGitRunner } from "../read-only.js";
import { copyItems, copySection, planPaths } from "./body.js";
import { ExecuteRefused } from "./verify-plan.js";

/** The ledger line's actor: fixed, so a re-preparation by another administrator writes the same line. */
export const REPULL_SCRUB_ACTOR = "nemar-repull";

/** The special remote a re-pull registers its uploads against (the one the plan checked). */
export const NEMAR_REMOTE_NAME = "nemar-s3";

/**
 * The keys the plan counted as held: annexed delta targets it neither copies nor lists as dead
 * (the plan judged them present at NEMAR), and every key NEMAR's `main` already names.
 */
export function heldKeys(body: PlanBody, oursKeys: ReadonlySet<string>): Set<string> {
  const copied = new Set(copyItems(body).map((i) => i.key));
  const dead = new Set(copySection(body).deadRecordings);
  const held = new Set(oursKeys);
  for (const r of planPaths(body)) {
    if (
      r.delta &&
      r.target.kind === "annex" &&
      !copied.has(r.target.key) &&
      !dead.has(r.target.key)
    ) {
      held.add(r.target.key);
    }
  }
  return held;
}

/**
 * Where the scrub reads each annexed recording: a key the plan copies is read at the version it
 * pinned (the bytes the copy will copy); a key the plan counted held, or one NEMAR's `main` already
 * names, is `"held"`; anything else has no source (`null`), which the scrub counts, and which the
 * synthesis then refuses, since such a key is neither held nor copied nor uploaded.
 */
export function pinnedSources(
  body: PlanBody,
  oursKeys: ReadonlySet<string>,
): (key: string) => UpstreamSource | "held" | null {
  const pins = new Map<string, UpstreamSource>();
  for (const item of copyItems(body)) {
    if (item.purpose === "copy" && item.pin) {
      pins.set(item.key, {
        kind: "pinned",
        bucket: item.pin.bucket,
        object: item.pin.object,
        versionId: item.pin.version,
      });
    }
  }
  const held = heldKeys(body, oursKeys);
  return (key) => pins.get(key) ?? (held.has(key) ? "held" : null);
}

/** The plan's copy items as the import's manifest entries (upstream origin), for the closing check. */
export function copyManifestItems(
  body: PlanBody,
  bucket: string,
  datasetId: string,
): ImportManifestItem[] {
  return copyItems(body)
    .filter((i) => i.purpose === "copy")
    .map((i) => ({
      key: i.key,
      sourceUrl: null,
      source: null,
      destUri: `s3://${bucket}/${datasetId}/objects/${i.key}`,
    }));
}

/**
 * Give the working clone's git-annex branch upstream's location log for each recording the plan
 * copies that NEMAR's branch has never recorded. The importer's clone carries upstream's logs, and
 * the scrub retires a key it replaces the way ADR 0085's annex-registry does: it retracts every
 * holder the log records and marks the key dead, and refuses a key with no log at all
 * (`old-key-unknown`). The dead mark is what lets the next plan explain the scrubbed recording.
 * What is recorded is only what upstream's own branch says (the planner's clone of it, read
 * through the read-only guard): the uuids it records present, nothing else.
 */
export async function adoptUpstreamLogs(
  work: string,
  upstreamBare: string,
  body: PlanBody,
): Promise<number> {
  const copied = new Set(
    copyItems(body)
      .filter((i) => i.purpose === "copy")
      .map((i) => i.key),
  );
  const keys = [
    ...new Set(
      planPaths(body)
        .filter(
          (r) =>
            r.delta &&
            r.target.kind === "annex" &&
            RECORDING_PATH.test(r.path) &&
            copied.has(r.target.key),
        )
        .map((r) => (r.target as { key: string }).key),
    ),
  ].sort();
  if (keys.length === 0) return 0;
  const ours = await locationLogs(work, keys);
  const fresh = keys.filter((_k, i) => (ours[i] ?? "") === "");
  if (fresh.length === 0) return 0;
  const theirs = await readLocationLogsAt(
    upstreamBare,
    "refs/heads/git-annex",
    fresh,
    guardedGitRunner(),
  );
  const lines = fresh.flatMap((k, i) => [...presentIn(theirs[i] ?? "")].map((u) => `${k} ${u} 1`));
  if (lines.length === 0) return 0;
  const r = await runCommand(["git", "annex", "setpresentkey", "--batch"], {
    cwd: work,
    stdin: `${lines.join("\n")}\n`,
  });
  if (r.exitCode !== 0) {
    throw new ExecuteRefused(
      "scrub-failed",
      "Upstream's location log could not be recorded in the working clone.",
    );
  }
  return lines.length;
}

/**
 * Scrub the delta, then annex and upload the git-held data the scrub did not take. Refuses with
 * {@link ExecuteRefused} (the scrub's own word as the code) for anything the scrub refuses.
 */
export async function scrubDelta(args: {
  work: string;
  datasetId: string;
  scope: Set<string>;
  body: PlanBody;
  oursKeys: ReadonlySet<string>;
  annexFromGit: Array<{ path: string; size: number }>;
  reader: UpstreamReader;
  upload: UploadStrategy;
  bucket: string;
  now: Date;
  actor?: string;
  maxBytes: number;
  /** The planner's clone of upstream, whose location logs the scrub's retirement starts from. */
  upstreamBare: string;
}): Promise<{ scrub: ImportScrubResult; uploaded: ImportManifestItem[] }> {
  await adoptUpstreamLogs(args.work, args.upstreamBare, args.body);
  let scrub: ImportScrubResult;
  try {
    scrub = await scrubImportedTree({
      datasetPath: args.work,
      nemarId: args.datasetId,
      // Not read: every key's source is named by `sourceOf`.
      keyUrlMap: new Map(),
      unannexedData: args.annexFromGit,
      // Not a re-import: ADR 0091's dates are set, on the delta recordings only.
      reimport: false,
      skipData: false,
      maxBytes: args.maxBytes,
      reader: args.reader,
      upload: args.upload,
      remoteName: NEMAR_REMOTE_NAME,
      bucket: args.bucket,
      now: args.now,
      actor: args.actor ?? REPULL_SCRUB_ACTOR,
      scope: args.scope,
      sourceOf: pinnedSources(args.body, args.oursKeys),
      ledgerAction: "repull-scrubbed",
    });
  } catch (err) {
    if (err instanceof ImportScrubRefused) throw new ExecuteRefused(err.code, err.message);
    throw err;
  }

  // The git-held data NEMAR's policy annexes, that the scrub did not annex itself.
  const rest = args.annexFromGit.filter((f) => !scrub.handledPaths.has(f.path));
  let normalized: Awaited<ReturnType<typeof normalizeUnannexedData>>;
  try {
    normalized = await normalizeUnannexedData({
      datasetPath: args.work,
      files: rest,
      remoteName: NEMAR_REMOTE_NAME,
      bucket: args.bucket,
      nemarId: args.datasetId,
      maxBytes: args.maxBytes,
      upload: args.upload,
    });
  } catch (err) {
    // Its messages name up to three paths and quote git-annex's stderr: never repeated here.
    throw new ExecuteRefused(
      "upload-failed",
      `${rest.length} git-held data file(s) could not be annexed or uploaded: ${describeError(err)}.`,
    );
  }

  // The closing check the import ends with: every recording the copy will bring from upstream had
  // its header read by this run.
  let tree: Map<string, string>;
  try {
    tree = await listAnnexedKeys(args.work);
  } catch (err) {
    throw new ExecuteRefused(
      "scrub-failed",
      `The annexed paths could not be listed: ${describeError(err)}.`,
    );
  }
  try {
    assertCopiedRecordingsRead(
      copyManifestItems(args.body, args.bucket, args.datasetId),
      tree,
      scrub.headerReadKeys,
    );
  } catch (err) {
    if (err instanceof ImportScrubRefused) throw new ExecuteRefused(err.code, err.message);
    throw err;
  }
  return { scrub, uploaded: [...scrub.items, ...normalized.items] };
}
