/**
 * The release of a merged re-pull (ADR 0111, decisions 2, 4 and 8; epic #1046 phase 6), as
 * `resume` takes it on from `merged`. Nothing here mints: the existing release path tags the
 * merge (the dataset repository's `run-pr-merge` pushes `v<Version>` on `main`), the tag mints the
 * version DOI, and the DOI's callback writes the version row. This waits for both, then records the
 * release through the Worker's verified route, which reads the version row and the tag itself:
 *
 *   merged    wait (bounded) for `refs/tags/v<N.0.0>` on NEMAR's origin and for the version row;
 *             the tagged tree is compared with the recorded synthesized tree outside `.nemar/**`
 *             and `.github/**` (the caller's `tree_verified`, which the Worker records as the
 *             administrator's assertion and which alone upgrades the version's lineage); then
 *             `merged -> released`, in whose batch the Worker re-arms the dataset's sweep stamps;
 *   released  N.0.0's objects locked under the governance lock with the existing s3-lock route
 *             (idempotent: run again, an object already locked stays locked), and only once every
 *             object was locked is the count recorded (`released -> released`). A lock that did
 *             not complete records why and leaves the row `released` without the count, which the
 *             Worker requires before the row goes on; the next run locks again. Then
 *             `released -> complete` when the plan had no corrections (its stated count is 0), or
 *             a stop: N.0.1 is a later slice's.
 *
 * A tag that names another commit, a version row that does not come within the bound, or a
 * comparison GitHub cannot make leaves the row `merged`, with why recorded; this command never
 * mints, and the existing DOI tooling repairs a mint that failed.
 */

import type { RepullRow } from "../../../shared/repull-state.js";
import { applyS3Lock } from "../api/data.js";
import { getVersionHistory } from "../api/datasets.js";
import { ApiError } from "../api/errors.js";
import { recordRepullReleased, repullErrorCode, transitionRepull } from "../api/repull.js";
import { MOVED_REF_FETCH_DEPTH } from "./execute/head.js";
import { type OriginScratch, fetchInto, originRefs } from "./execute/origin.js";
import { releaseRefOf } from "./execute/pull-request.js";
import { ExecuteRefused } from "./execute/verify-plan.js";
import { git } from "./execute/workdir.js";
import {
  type ResumeContext,
  type Turn,
  apiRefused,
  recordStepError,
  refused,
  resumeErrorWords,
} from "./steps.js";

/** The entries of a tree outside NEMAR's own paths, `mode oid path` each, sorted. */
async function outsideNemar(dir: string, commit: string): Promise<string | null> {
  const r = await git(dir, ["ls-tree", "-r", "-z", "--full-tree", commit], { ok: true });
  if (r.exitCode !== 0) return null;
  return r.stdout
    .split("\0")
    .filter(Boolean)
    .map((e) => /^(\d{6}) [a-z]+ ([0-9a-f]{40})\t(.+)$/s.exec(e))
    .filter((m): m is RegExpExecArray => m !== null)
    .filter(
      (m) => !(m[3] as string).startsWith(".nemar/") && !(m[3] as string).startsWith(".github/"),
    )
    .map((m) => `${m[1]} ${m[2]} ${m[3]}`)
    .sort()
    .join("\n");
}

/**
 * Whether the tagged tree is the synthesized one outside `.nemar/**` and `.github/**`, read from
 * origin: the tag's commit and the recorded commit (by id, else from the release branch or the
 * pull request's own ref). Unknown (a commit that could not be fetched) is false: lineage is never
 * recorded on a guess.
 */
export async function taggedTreeVerified(
  scratch: OriginScratch,
  row: RepullRow,
  tagSha: string,
  out: (line: string) => void,
): Promise<boolean> {
  const synth = row.synth_sha as string;
  if (!(await fetchInto(scratch, tagSha, 1))) {
    out(
      "The tagged commit could not be fetched, so its tree is not verified (lineage is not recorded).",
    );
    return false;
  }
  const have = async () =>
    (await git(scratch.dir, ["cat-file", "-e", `${synth}^{commit}`], { ok: true })).exitCode === 0;
  if (!(await have())) {
    for (const ref of [synth, releaseRefOf(row.to_version), `refs/pull/${row.pr_number}/head`]) {
      if ((await fetchInto(scratch, ref, MOVED_REF_FETCH_DEPTH)) && (await have())) break;
    }
  }
  if (!(await have())) {
    out(
      "The re-pull's commit could not be fetched, so the tagged tree is not verified (lineage is not recorded).",
    );
    return false;
  }
  const tagged = await outsideNemar(scratch.dir, tagSha);
  const synthesized = await outsideNemar(scratch.dir, synth);
  if (tagged === null || synthesized === null || tagged !== synthesized) {
    out(
      "The tagged tree is not the re-pull's commit outside .nemar/ and .github/, so lineage is not recorded for it.",
    );
    return false;
  }
  return true;
}

/** Whether the dataset's version rows hold `version` (either spelling). */
async function versionRowExists(datasetId: string, version: string): Promise<boolean> {
  const history = await getVersionHistory(datasetId);
  return history.versions.some((v) => v.version === version || v.version === `v${version}`);
}

/** At `merged`: the tag and the version row, waited for, then the release recorded. */
export async function releaseTurn(ctx: ResumeContext, row: RepullRow): Promise<Turn> {
  const version = row.to_version;
  const tag = `refs/tags/v${version}`;
  const scratch = await ctx.origin();
  let tagSha: string | undefined;
  try {
    tagSha = (await originRefs(scratch, [tag])).get(tag);
  } catch (err) {
    if (err instanceof ExecuteRefused) err.resumable = true;
    throw err;
  }
  if (!tagSha) {
    return { kind: "wait", row, waitingFor: `the tag v${version} on NEMAR's repository` };
  }
  let minted: boolean;
  try {
    minted = await versionRowExists(ctx.datasetId, version);
  } catch (err) {
    throw apiRefused(err, "The dataset's versions could not be read");
  }
  if (!minted) return { kind: "wait", row, waitingFor: `the version row of v${version} (its DOI)` };

  const treeVerified = await taggedTreeVerified(scratch, row, tagSha, ctx.opts.out);
  let res: Awaited<ReturnType<typeof recordRepullReleased>>;
  try {
    res = await recordRepullReleased(row.id, {
      pr: "n0",
      tag_sha: tagSha,
      tree_verified: treeVerified,
    });
  } catch (err) {
    const code = repullErrorCode(err);
    // The version row the Worker reads is the one with a DOI: one without it yet is still to come.
    if (code === "not-released") {
      return { kind: "wait", row, waitingFor: `the DOI of v${version}` };
    }
    const failure = refused(
      code ?? "release-failed",
      `The release of v${version} could not be recorded: ${err instanceof Error ? err.message : String(err)}`,
    );
    if (err instanceof ApiError) {
      await recordStepError(row, resumeErrorWords("release", failure), ctx.opts.out);
    }
    throw failure;
  }
  ctx.opts.out(
    `Re-pull #${row.id} is released: v${version} at ${tagSha.slice(0, 12)}${res.lineage_rows ? `, lineage recorded for v${version}` : treeVerified ? "" : ", lineage not recorded"}; the dataset's sweeps read it again.`,
  );
  return { kind: "next", row: res.repull };
}

/** At `released`: the lock, its count, then `complete` (or a stop: N.0.1 is not built). */
export async function lockTurn(ctx: ResumeContext, row: RepullRow): Promise<Turn> {
  let current = row;
  if (typeof current.counts.locked !== "number") {
    let locked: Awaited<ReturnType<typeof applyS3Lock>>;
    try {
      locked = await applyS3Lock(ctx.datasetId);
    } catch (err) {
      const failure = refused(
        "lock-failed",
        `The objects of v${row.to_version} could not be locked (${err instanceof ApiError ? `HTTP ${err.statusCode}` : "no answer"}); run resume again.`,
      );
      await recordStepError(row, resumeErrorWords("lock", failure), ctx.opts.out);
      throw failure;
    }
    if (locked.failed.length > 0) {
      // Counts only: the failures name object keys, and a record never holds a key.
      const failure = refused(
        "lock-incomplete",
        `${locked.failed.length} object(s) of ${ctx.datasetId} were not locked (${locked.locked} were); run resume again, which locks them again.`,
      );
      await recordStepError(row, resumeErrorWords("lock", failure), ctx.opts.out);
      throw failure;
    }
    try {
      current = await transitionRepull(row.id, {
        from: "released",
        to: "released",
        fields: { counts: { locked: locked.locked } },
      });
    } catch (err) {
      throw apiRefused(err, "The count of locked objects could not be recorded");
    }
    ctx.opts.out(
      `Locked ${locked.locked} object(s) of ${ctx.datasetId} under the governance lock.`,
    );
  }
  const corrections = current.counts.corrections;
  if (corrections !== 0) {
    ctx.opts.out(
      typeof corrections === "number"
        ? `Re-pull #${row.id} has ${corrections} correction(s) for N.0.1, which is not built yet; it stays released.`
        : `Re-pull #${row.id}'s record does not say how many corrections it has, so it is not completed; it stays released.`,
    );
    return { kind: "done", result: { row: current, outcome: "released" } };
  }
  let done: RepullRow;
  try {
    done = await transitionRepull(row.id, { from: "released", to: "complete" });
  } catch (err) {
    throw apiRefused(err, "The record could not be completed");
  }
  ctx.opts.out(`Re-pull #${row.id} of ${ctx.datasetId} is complete.`);
  return { kind: "done", result: { row: done, outcome: "complete" } };
}
