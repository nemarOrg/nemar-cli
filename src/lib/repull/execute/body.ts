/**
 * The parts of a re-pull plan body that execution reads, typed (ADR 0111, epic #1046 phase 6).
 *
 * The body is `PlanBody` (canonical JSON) so the digest covers every byte of it; these readers
 * give execution one typed view of it, and refuse a body that does not have the shape the planner
 * writes, rather than reading a missing field as an empty one.
 */

import type { PlanBody } from "../digest.js";
import type { Target } from "../edits.js";
import {
  isCommitId,
  isNemarDatasetId,
  isNemarVersion,
  isOpenNeuroDatasetId,
  isOpenNeuroTag,
} from "../shapes.js";
import { ExecuteRefused } from "./verify-plan.js";

/** One path row of the plan, as `plan.ts` writes it (`pathJson`). */
export interface PlanPath {
  path: string;
  target: Target | { kind: "ours" };
  delta: boolean;
  deleted: boolean;
}

/** One key the plan reads from upstream: copied into the bucket, or un-annexed into git. */
export interface CopyItem {
  key: string;
  purpose: "copy" | "unannex";
  size: number | null;
  pin: { bucket: string; object: string; version: string } | null;
}

function shape(what: string): ExecuteRefused {
  return new ExecuteRefused("plan-schema", `The plan's ${what} does not have the planner's shape.`);
}

function record(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

export function planPaths(body: PlanBody): PlanPath[] {
  if (!Array.isArray(body.paths)) throw shape("path list");
  return body.paths.map((raw) => {
    const r = record(raw);
    const target = record(r?.target);
    if (
      !r ||
      typeof r.path !== "string" ||
      !target ||
      typeof target.kind !== "string" ||
      typeof r.delta !== "boolean" ||
      typeof r.deleted !== "boolean"
    ) {
      throw shape("path list");
    }
    return {
      path: r.path,
      target: target as unknown as PlanPath["target"],
      delta: r.delta,
      deleted: r.deleted,
    };
  });
}

export function copyItems(body: PlanBody): CopyItem[] {
  const copy = record(body.copy);
  if (!copy || !Array.isArray(copy.items)) throw shape("copy section");
  return copy.items.map((raw) => {
    const r = record(raw);
    const pin = record(r?.pin);
    if (
      !r ||
      typeof r.key !== "string" ||
      (r.purpose !== "copy" && r.purpose !== "unannex") ||
      (r.size !== null && typeof r.size !== "number")
    ) {
      throw shape("copy section");
    }
    const okPin =
      pin &&
      typeof pin.bucket === "string" &&
      typeof pin.object === "string" &&
      typeof pin.version === "string";
    if (r.pin !== null && !okPin) throw shape("copy section");
    return {
      key: r.key,
      purpose: r.purpose,
      size: r.size as number | null,
      pin: okPin
        ? {
            bucket: pin.bucket as string,
            object: pin.object as string,
            version: pin.version as string,
          }
        : null,
    };
  });
}

/** `copy.destination_prefix`, `copy.dead_recordings`. */
export function copySection(body: PlanBody): {
  destinationPrefix: string;
  deadRecordings: string[];
} {
  const copy = record(body.copy);
  if (
    !copy ||
    typeof copy.destination_prefix !== "string" ||
    !Array.isArray(copy.dead_recordings) ||
    !copy.dead_recordings.every((k) => typeof k === "string")
  ) {
    throw shape("copy section");
  }
  return {
    destinationPrefix: copy.destination_prefix,
    deadRecordings: copy.dead_recordings as string[],
  };
}

export interface PlanFacts {
  datasetId: string;
  ds: string;
  fromTag: string;
  toTag: string;
  toCommit: string;
  mainCommit: string;
  /** NEMAR's git-annex branch as the plan read it. */
  annexCommit: string;
  fromVersion: string;
  toVersion: string;
  patchVersion: string | null;
  planner: number;
  lineageRecordable: boolean;
  mergedDescription: string | null;
}

/**
 * A scalar the plan states that does not have the shape execution builds a URL, a ref or a branch
 * name from. It names the field and the shape, never the value: the plan file is text a person
 * could have edited, and its digest proves only that it is the file that was reviewed.
 */
function badShape(what: string, shape: string): ExecuteRefused {
  return new ExecuteRefused("plan-schema", `The plan's ${what} is not ${shape}.`);
}

/** The scalar facts of a plan body. */
export function planFacts(body: PlanBody): PlanFacts {
  const up = record(body.upstream);
  const nemar = record(body.nemar);
  const versions = record(body.versions);
  const lineage = record(body.lineage);
  const description = record(body.description);
  const s = (v: unknown) => (typeof v === "string" ? v : null);
  const facts = {
    datasetId: s(body.dataset),
    ds: s(up?.ds),
    fromTag: s(up?.from_tag),
    toTag: s(up?.to_tag),
    toCommit: s(up?.to_commit),
    mainCommit: s(nemar?.main_commit),
    annexCommit: s(nemar?.annex_commit),
    fromVersion: s(versions?.current),
    toVersion: s(versions?.n0),
  };
  for (const [k, v] of Object.entries(facts)) if (v === null) throw shape(k);
  if (typeof body.planner !== "number") throw shape("planner");
  // Each is checked where it is read, so no caller builds a clone URL, a ref, `release/v<N.0.0>` or
  // a staging key from a value that cannot be one.
  if (!isNemarDatasetId(facts.datasetId)) {
    throw badShape("dataset id", "a NEMAR dataset id (two lowercase letters and six digits)");
  }
  if (!isOpenNeuroDatasetId(facts.ds)) {
    throw badShape("upstream dataset id", "an OpenNeuro dataset id (ds and six digits)");
  }
  if (!isOpenNeuroTag(facts.fromTag)) {
    throw badShape("from tag", "an upstream snapshot tag");
  }
  if (!isOpenNeuroTag(facts.toTag)) {
    throw badShape("to tag", "an upstream snapshot tag");
  }
  if (!isNemarVersion(facts.fromVersion)) {
    throw badShape("current version", "a version of the form N.N.N");
  }
  if (!isNemarVersion(facts.toVersion)) {
    throw badShape("N.0.0 version", "a version of the form N.N.N");
  }
  const patchVersion = s(versions?.n1);
  if (patchVersion !== null && !isNemarVersion(patchVersion)) {
    throw badShape("N.0.1 version", "a version of the form N.N.N");
  }
  // The three commits become arguments of git (`fetch`, `checkout`, `commit-tree`, `ls-remote`), so
  // each must be a full id and cannot be taken for an option or a ref.
  const COMMIT = "a full commit id (40 lowercase hex digits)";
  if (!isCommitId(facts.toCommit)) throw badShape("upstream commit", COMMIT);
  if (!isCommitId(facts.mainCommit)) throw badShape("main commit", COMMIT);
  if (!isCommitId(facts.annexCommit)) throw badShape("git-annex commit", COMMIT);
  return {
    ...(facts as { [K in keyof typeof facts]: string }),
    patchVersion,
    planner: body.planner,
    lineageRecordable: lineage?.recordable === true,
    mergedDescription: s(description?.merged_json),
  };
}

/** The NEMAR-owned edits the plan lists (`.nemar/metadata.json`'s `IsIdenticalTo`). */
export function nemarOwnedEdits(
  body: PlanBody,
): Array<{ path: string; edit: string; status: string; from: string | null; to: string }> {
  if (!Array.isArray(body.nemar_owned_edits)) throw shape("NEMAR-owned edits");
  return body.nemar_owned_edits.map((raw) => {
    const r = record(raw);
    if (
      !r ||
      typeof r.path !== "string" ||
      typeof r.edit !== "string" ||
      typeof r.status !== "string" ||
      typeof r.to !== "string" ||
      (r.from !== null && typeof r.from !== "string")
    ) {
      throw shape("NEMAR-owned edits");
    }
    return {
      path: r.path,
      edit: r.edit,
      status: r.status,
      from: r.from as string | null,
      to: r.to,
    };
  });
}

/** The plan's counts, the numeric ones only. */
export function planCounts(body: PlanBody): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(record(body.counts) ?? {})) {
    if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) out[k] = v;
  }
  return out;
}
