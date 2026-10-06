/**
 * The `raw-verify` stage of an in-place scrub: prove that every RAW copy under `<id>/objects/` is a
 * duplicate of content NEMAR keeps elsewhere, before `delete-old` deletes it (ADR 0085, amendment
 * of 2026-10-06 on raw copies; runbook step 5b).
 *
 * A raw copy is an object stored by its path instead of an annex key (`PlanFile.rawCopies`). The
 * maintainer's decision of 2026-10-06 is "Delete the raw copies after verifying they match", so
 * each raw VERSION must match, by what its kind can be compared with:
 *
 * - a raw recording (`.edf`, `.bdf`) is byte for byte an annex key of the plan: its sha256 is the
 *   sha256 a key of `plan.keys` names, and its size is that key's size. An annex key names its
 *   bytes (git-annex stores content under the sha256 and size of the content), and that is what
 *   this rests on: the plan read a clean key's header and size, not its whole body, and only a key
 *   that needs a scrub was read whole (`compute`). The proof records the keys it matched
 *   (`matchedKeys`), and `delete-old` requires each one it does not replace to be current at its
 *   size, so the bytes survive the deletion as that key (or, scrubbed, as its replacement, which
 *   `verify` proved);
 * - any other raw file is a blob of the dataset repository's history from before the rewrite: its
 *   git blob id is in the list the operator took from the clone at step 0 (`git-blobs.txt`). That
 *   history holds the text as it was, so the raw copy holds nothing the repository did not.
 *
 * The digests come from `hash_stage.py raw-hash` (`raw-hashes.json`, bound to plan.json by its
 * sha256). This stage reads no S3 object and calls no `aws`. It writes `raw-verified.json` only
 * when every raw version matches, and removes an earlier one first; otherwise it prints fixed words
 * with counts and puts the unmatched NAMES, which are file paths, in `raw-unmatched.json` (0600),
 * never on the terminal.
 */

import { rm } from "node:fs/promises";
import path from "node:path";
import {
  type PlanFile,
  type RawHashEntry,
  type RawVerifiedFile,
  parseKey,
  parsePlan,
  parseRawHashes,
} from "../contract";
import { EXIT, StageError, countWords, formatWordCounts, sha256Hex } from "./s3-lib";
import {
  checkDataset,
  parseFile,
  rawCounts,
  readBytes,
  requireCompletePlan,
  writeJson,
} from "./s3-stages";

export interface RawVerifyOptions {
  dir: string;
  /** The git blob list: one 40-hex blob id per line. Relative to `dir` unless absolute. */
  gitBlobsFile: string;
  log: (line: string) => void;
}

/** The ways one raw version can fail to be proven, in the order they are reported. */
export const RAW_VERIFY_REASONS = [
  "raw-hash-missing",
  "raw-size-differs",
  "raw-recording-unmatched",
  "raw-other-unmatched",
  "raw-hash-not-in-plan",
] as const;
type Reason = (typeof RAW_VERIFY_REASONS)[number];

const BLOB_ID = /^[0-9a-f]{40}$/;

/**
 * The git blob list, or refuse: one lowercase 40-hex SHA-1 per line, a final newline allowed, no
 * blank line and nothing else, and at least one blob (an empty list is a command that failed, not
 * a repository without files). A list of SHA-256 ids (64 hex) is refused: raw-hash computes SHA-1
 * blob ids, which is what the datasets' repositories use.
 */
export function parseGitBlobs(text: string): Set<string> {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.length === 0 || !lines.every((l) => BLOB_ID.test(l))) {
    throw new StageError("git-blobs-invalid", EXIT.refused);
  }
  return new Set(lines);
}

const digestAt = (sha256: string, size: number) => `${sha256} ${size}`;

/** sha256 and size -> the plan's annex keys that carry them (scrubbed or clean). */
function annexDigests(plan: PlanFile): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const k of plan.keys) {
    if (k.oldKey.startsWith("git:")) continue;
    const { sha256, size } = parseKey(k.oldKey);
    const at = digestAt(sha256, size);
    out.set(at, [...(out.get(at) ?? []), k.oldKey]);
  }
  return out;
}

export async function rawVerifyStage(o: RawVerifyOptions): Promise<number> {
  const planBytes = await readBytes(path.join(o.dir, "plan.json"), "plan.json");
  const plan = parseFile("plan.json", parsePlan, planBytes.toString("utf8"));
  checkDataset(plan.dataset);
  requireCompletePlan(plan);
  // A proof, and a list of names, from an earlier run must not outlive this one.
  await rm(path.join(o.dir, "raw-verified.json"), { force: true });
  await rm(path.join(o.dir, "raw-unmatched.json"), { force: true });

  const raw = plan.rawCopies ?? [];
  const want = rawCounts(raw);
  if (raw.length === 0) {
    // Nothing to prove, and a proof is never vacuous: delete-old asks for none for this plan.
    o.log("raw-verify: the plan has no raw copies; nothing to verify, no proof written");
    return 0;
  }

  const planSha = sha256Hex(planBytes);
  const hashesBytes = await readBytes(path.join(o.dir, "raw-hashes.json"), "raw-hashes.json");
  const hashes = parseFile("raw-hashes.json", parseRawHashes, hashesBytes.toString("utf8"));
  if (hashes.dataset !== plan.dataset) {
    throw new StageError("raw-hashes-wrong-dataset", EXIT.refused);
  }
  // Made for another plan.json: its versions are not the ones this plan records.
  if (hashes.planSha256 !== planSha) throw new StageError("raw-hashes-stale", EXIT.refused);
  const blobsBytes = await readBytes(path.resolve(o.dir, o.gitBlobsFile), "git-blobs");
  const blobs = parseGitBlobs(blobsBytes.toString("utf8"));

  const byVersion = new Map<string, RawHashEntry>();
  for (const e of hashes.entries) byVersion.set(JSON.stringify([e.name, e.versionId]), e);
  const digests = annexDigests(plan);

  const unmatched = new Map<Reason, Array<{ name: string; versionId: string }>>();
  const fail = (reason: Reason, name: string, versionId: string) => {
    const list = unmatched.get(reason) ?? [];
    list.push({ name, versionId });
    unmatched.set(reason, list);
  };
  let matchedRecordings = 0;
  let matchedOther = 0;
  const matchedKeys = new Set<string>();
  const planned = new Set<string>();
  for (const r of raw) {
    for (const v of r.versions) {
      const at = JSON.stringify([r.name, v.id]);
      planned.add(at);
      const e = byVersion.get(at);
      if (e === undefined) {
        fail("raw-hash-missing", r.name, v.id);
      } else if ("failure" in e || e.size !== v.size) {
        // raw-hash read a byte count other than the plan's size, or the entry says another size.
        fail("raw-size-differs", r.name, v.id);
      } else if (r.kind === "recording") {
        const keys = digests.get(digestAt(e.sha256, v.size));
        if (keys === undefined) {
          fail("raw-recording-unmatched", r.name, v.id);
        } else {
          matchedRecordings += 1;
          for (const k of keys) matchedKeys.add(k);
        }
      } else if (blobs.has(e.gitBlobSha1)) {
        matchedOther += 1;
      } else {
        fail("raw-other-unmatched", r.name, v.id);
      }
    }
  }
  // An entry for a version the plan does not record: raw-hash writes none, so the file is not its.
  for (const e of hashes.entries) {
    if (!planned.has(JSON.stringify([e.name, e.versionId]))) {
      fail("raw-hash-not-in-plan", e.name, e.versionId);
    }
  }

  const failed = RAW_VERIFY_REASONS.flatMap((reason) =>
    (unmatched.get(reason) ?? []).map(() => reason),
  );
  if (failed.length > 0) {
    // Names are file paths, so they go to a private file for a person, never to the terminal.
    await writeJson(o.dir, "raw-unmatched.json", {
      version: 1,
      dataset: plan.dataset,
      planSha256: planSha,
      unmatched: Object.fromEntries(
        RAW_VERIFY_REASONS.filter((reason) => unmatched.has(reason)).map((reason) => [
          reason,
          unmatched.get(reason),
        ]),
      ),
    });
    o.log(
      `raw-verify: FAILED names=${want.names} versions=${want.versions} markers=${want.markers} matchedRecordings=${matchedRecordings} matchedOther=${matchedOther} (${formatWordCounts(countWords(failed))})`,
    );
    o.log(
      "raw-verify: raw-verified.json NOT written; the versions that did not match are in raw-unmatched.json",
    );
    return EXIT.failed;
  }

  const proof: RawVerifiedFile = {
    version: 1,
    dataset: plan.dataset,
    verifiedAt: new Date().toISOString(),
    planSha256: planSha,
    rawHashesSha256: sha256Hex(hashesBytes),
    gitBlobsSha256: sha256Hex(blobsBytes),
    matchedKeys: [...matchedKeys].sort(),
    counts: { ...want, matchedRecordings, matchedOther },
  };
  await writeJson(o.dir, "raw-verified.json", proof);
  o.log(
    `raw-verify: ok names=${want.names} versions=${want.versions} markers=${want.markers} matchedRecordings=${matchedRecordings} matchedOther=${matchedOther}`,
  );
  return 0;
}
