/**
 * The step at `released`, once N.0.0's objects are locked (ADR 0111, decisions 1 and 3; epic #1046
 * phase 6): N.0.1 is made, or the record ends.
 *
 *  - No correction and no conflict in the plan: `released -> complete`.
 *  - Conflicts the plan lists wait for an administrator's decision before anything is made, because
 *    N.0.1's content is fixed once its pull request is open: `--take-ours <path>` (or
 *    `--take-ours dataset_description.json#<Key>`) resolves one to NEMAR's side, and
 *    `--keep-upstream` leaves every one not named on upstream's side (ADR 0111: a conflict stays out
 *    of N.0.1 until an administrator resolves it). Naming some and not the others still waits,
 *    unless `--keep-upstream` is given too: a conflict is left upstream's only by a decision.
 *  - Otherwise N.0.1 is made from the reviewed plan (`patch.ts`), which must be the record's (its
 *    digest), on NEMAR's `main` as the N.0.0 merge left it (moved by enrichment only, else
 *    `main-moved`); every annexed key it replays must be NEMAR's, in the bucket and at `nemar-s3`;
 *    `release/v<N.0.1>` is pushed through the write guard (or found, when an earlier run pushed it),
 *    its pull request opened with the administrator's token, and the record goes to
 *    `patch_synthesized`. With nothing to replay (no correction, every conflict left upstream's), the
 *    record completes.
 *
 * It asks before it pushes (`--yes` answers): N.0.1's merge mints a second version DOI.
 */

import { AwsCliError, failureWord } from "../../../scripts/scrub/s3/s3-lib.js";
import { repullPatchTrailerLine, repullTrailerLines } from "../../../shared/repull-squash.js";
import { type RepullRow, patchVersionOf } from "../../../shared/repull-state.js";
import { getApiUrl } from "../api/client.js";
import { transitionRepull } from "../api/repull.js";
import { defaultPlanPath } from "./digest.js";
import { listPrefixSizes } from "./execute/copy.js";
import { MOVED_REF_FETCH_DEPTH } from "./execute/head.js";
import { fetchInto, originRefs } from "./execute/origin.js";
import {
  acceptsHead,
  checkMain,
  openRelease,
  pushRelease,
  releaseRefOf,
} from "./execute/pull-request.js";
import { ExecuteRefused, readReviewedPlan } from "./execute/verify-plan.js";
import {
  type PatchSelection,
  assertPatchLedger,
  assertReplayedKeys,
  findPatchCommit,
  hasReplay,
  patchCommit,
  patchSelection,
} from "./patch.js";
import { nemarBucket } from "./release.js";
import { openNeuroGraphqlUrl } from "./sources.js";
import {
  type ResumeContext,
  type Turn,
  apiRefused,
  recordStepError,
  refused,
  resumeErrorWords,
} from "./steps.js";

/** End the record: `released -> complete`. */
async function complete(ctx: ResumeContext, row: RepullRow, why: string): Promise<Turn> {
  let done: RepullRow;
  try {
    done = await transitionRepull(row.id, { from: "released", to: "complete" });
  } catch (err) {
    throw apiRefused(err, "The record could not be completed");
  }
  ctx.opts.out(`Re-pull #${row.id} of ${ctx.datasetId} is complete${why}.`);
  return { kind: "done", result: { row: done, outcome: "complete" } };
}

/** The reviewed plan the record was made from, proved: its digest must be the record's. */
async function recordPlan(ctx: ResumeContext, row: RepullRow) {
  const path =
    ctx.opts.plan ?? defaultPlanPath(ctx.configDir, ctx.datasetId, row.to_tag, row.plan_digest);
  const { file, body } = readReviewedPlan(path, {
    environment: getApiUrl(),
    env: ctx.env,
    openNeuroGraphqlUrl: openNeuroGraphqlUrl(ctx.env),
  });
  if (file.digest !== row.plan_digest) {
    throw new ExecuteRefused(
      "plan-not-the-record",
      `The plan file is not the plan re-pull #${row.id} was made from (its digest differs); pass the reviewed plan with --plan <file>.`,
    );
  }
  return body;
}

/** The body of N.0.1's pull request: counts, never a path or a key. */
export function patchBody(row: RepullRow, s: PatchSelection, version: string): string {
  return [
    `NEMAR's corrections of re-pull #${row.id} (upstream ${row.upstream_ds} ${row.from_tag} to ${row.to_tag}), replayed onto v${row.to_version} as v${version} of ${row.dataset_id} (ADR 0111).`,
    "",
    `v${row.to_version} is upstream's snapshot ${row.upstream_ds}@${row.to_tag} with NEMAR's standard edits; this pull request puts back NEMAR's own side of what the plan listed as a correction, and of each conflict an administrator resolved to NEMAR's side. Nothing is scrubbed and nothing is copied: every replayed byte is in a version NEMAR already published.`,
    "",
    `- Re-pull record: #${row.id}`,
    `- Plan digest: ${row.plan_digest}`,
    `- Corrections the plan listed: ${s.corrections}; conflicts resolved to NEMAR's side: ${s.resolutions}`,
    `- Paths replayed: ${s.paths.length}; description keys replayed: ${s.keys.length}`,
    "- Version DOIs this pull request mints when merged: 1",
    "",
    `\`nemar admin repull resume ${row.dataset_id}\` takes this pull request through the identifier screen and the gates, and \`nemar admin repull merge ${row.dataset_id}\` (or \`nemar admin pr-reviews\`, through the same gate) squash-merges it under the daily merge cap; a merge mints a version DOI that cannot be withdrawn.`,
    "",
    "The squash commit message must end with the re-pull's trailers, as its last paragraph; the merge path writes that message itself and refuses one that does not:",
    "",
    "```",
    ...repullTrailerLines(row),
    repullPatchTrailerLine(s.corrections),
    "```",
    "",
    "Do not merge this from GitHub's page.",
  ].join("\n");
}

/** At `released`, the lock recorded: N.0.1, an administrator's decision, or the end. */
export async function patchTurn(ctx: ResumeContext, row: RepullRow): Promise<Turn> {
  const corrections = row.counts.corrections;
  const conflicts = row.counts.conflicts;
  const takeOurs = ctx.opts.takeOurs ?? [];
  if (typeof corrections !== "number" || typeof conflicts !== "number") {
    // Unknown is never zero: a record that does not say is not completed.
    ctx.opts.out(
      `Re-pull #${row.id}'s record does not say how many corrections and conflicts its plan has, so it is not completed; it stays released.`,
    );
    return { kind: "done", result: { row, outcome: "released" } };
  }
  if (corrections === 0 && conflicts === 0 && takeOurs.length === 0) {
    return complete(ctx, row, "");
  }
  if (conflicts > 0 && takeOurs.length === 0 && !ctx.opts.keepUpstream) {
    return {
      kind: "done",
      result: {
        row,
        outcome: "waiting",
        waitingFor: `an administrator's decision on the ${conflicts} conflict(s) the plan lists, before N.0.1 is made: resolve one to NEMAR's side with --take-ours <path> (or --take-ours dataset_description.json#<Key>), or leave every one on upstream's side with --keep-upstream (the reviewed plan file names them, under conflicts and description.keys)`,
      },
    };
  }

  const version = patchVersionOf(row.to_version) as string;
  try {
    const body = await recordPlan(ctx, row);
    assertPatchLedger(body);
    const selection = patchSelection(body, takeOurs);
    if (selection.corrections !== corrections) {
      throw new ExecuteRefused(
        "patch-plan-mismatch",
        `The plan lists ${selection.corrections} correction(s) and re-pull #${row.id} records ${corrections}; they are the same plan only when they agree.`,
      );
    }
    if (selection.unresolved > 0 && !ctx.opts.keepUpstream) {
      return {
        kind: "done",
        result: {
          row,
          outcome: "waiting",
          waitingFor: `an administrator's decision on the ${selection.unresolved} conflict(s) the plan lists that no --take-ours names, before N.0.1 is made: name each to take NEMAR's side, or add --keep-upstream to leave them on upstream's side`,
        },
      };
    }
    if (!hasReplay(selection)) {
      return complete(
        ctx,
        row,
        ": the plan has no correction, and every conflict stays on upstream's side",
      );
    }
    return await makePatch(ctx, row, selection, version);
  } catch (err) {
    // A fact about the record or its plan is recorded on it; a problem of this run (the file it was
    // given, a resolution it named, a declined confirmation) is not, and writes nothing.
    if (err instanceof ExecuteRefused && !RUN_PROBLEMS.has(err.code)) {
      err.resumable = true;
      await recordStepError(row, resumeErrorWords("patch", err), ctx.opts.out);
    }
    throw err;
  }
}

/** Refusals that are about this run, not the record: nothing is recorded for them (exit 1). */
const RUN_PROBLEMS = new Set([
  "take-ours-invalid",
  "declined",
  "plan-unreadable",
  "plan-schema",
  "plan-environment",
  "plan-sources",
  "planner-version",
  "plan-tampered",
  "plan-not-the-record",
]);

async function makePatch(
  ctx: ResumeContext,
  row: RepullRow,
  selection: PatchSelection,
  version: string,
): Promise<Turn> {
  const nemar = await nemarBucket(ctx);
  const { scratch } = nemar;
  if (nemar.prefix !== `${ctx.datasetId}/objects/`) {
    throw new ExecuteRefused(
      "destination-prefix",
      `NEMAR's nemar-s3 is not at ${ctx.datasetId}/objects/, where the keys N.0.1 replays are read.`,
    );
  }
  // `main`: the N.0.0 merge, or an enrichment-shaped descendant of it.
  const main = await checkMain({
    work: scratch.dir,
    baseSha: row.merge_sha as string,
    env: scratch.env,
  });
  const ref = releaseRefOf(version);
  const existing = (await originRefs(scratch, [ref])).get(ref);
  let commit: string;
  let parent: string;
  let keys: string[];
  if (existing) {
    // A branch an earlier run pushed: it must hold the very commit this makes for its own parent.
    if (!(await fetchInto(scratch, ref, MOVED_REF_FETCH_DEPTH))) {
      throw refused("origin-unreadable", `release/v${version} could not be fetched.`);
    }
    const found = await findPatchCommit({ dir: scratch.dir, row, head: existing });
    const made = found
      ? await patchCommit({ scratch, row, selection, parent: found.parent })
      : null;
    if (!found || !made || made.sha !== found.commit) {
      throw new ExecuteRefused(
        "branch-foreign",
        `release/v${version} exists on NEMAR's repository and is not this re-pull's N.0.1 commit with these resolutions; run resume with the resolutions the earlier run was given, or decline N.0.1 with nemar admin repull abandon ${ctx.datasetId}.`,
      );
    }
    commit = found.commit;
    parent = found.parent;
    keys = made.keys;
  } else {
    const made = await patchCommit({ scratch, row, selection, parent: main });
    commit = made.sha;
    parent = main;
    keys = made.keys;
  }

  // The keys it replays are NEMAR's: in the bucket at their size, at nemar-s3, not dead.
  let listing: Map<string, number>;
  try {
    listing =
      keys.length > 0 ? await listPrefixSizes(nemar.aws, nemar.bucket, nemar.prefix) : new Map();
  } catch (err) {
    if (!(err instanceof AwsCliError)) throw err;
    throw new ExecuteRefused(
      "s3-failed",
      `NEMAR's bucket could not be listed for the keys N.0.1 replays (${failureWord(err)}); the ambient AWS credentials list it.`,
    );
  }
  await assertReplayedKeys({
    dir: scratch.dir,
    annexRef: "refs/remotes/origin/heads/git-annex",
    keys,
    nemarUuid: nemar.uuid,
    listing,
  });

  if (
    !existing &&
    ctx.opts.confirm &&
    !(await ctx.opts.confirm(
      `Make v${version} of ${ctx.datasetId}: replay ${selection.paths.length} path(s) and ${selection.keys.length} description key(s) onto main (${selection.corrections} correction(s), ${selection.resolutions} conflict(s) resolved to NEMAR's side, ${selection.unresolved} left on upstream's side), push release/v${version} and open its pull request? Its merge will mint one more version DOI, which cannot be withdrawn.`,
    ))
  ) {
    throw new ExecuteRefused("declined", "Not confirmed; nothing was pushed.");
  }
  const branch = await pushRelease({
    work: scratch.dir,
    synthSha: commit,
    version,
    push: { versions: [version] },
    env: scratch.env,
  });
  ctx.opts.out(
    branch.pushed
      ? `Pushed release/v${version} (${commit.slice(0, 12)}).`
      : `release/v${version} is already this re-pull's N.0.1 commit${branch.head === commit ? "" : " (moved by enrichment)"}.`,
  );
  const pr = await openRelease({
    token: ctx.token,
    base: ctx.base,
    datasetId: ctx.datasetId,
    version,
    body: patchBody(row, selection, version),
    acceptHead: (sha) =>
      acceptsHead({ work: scratch.dir, from: commit, head: sha, ref, env: scratch.env }),
  });
  let next: RepullRow;
  try {
    next = await transitionRepull(row.id, {
      from: "released",
      to: "patch_synthesized",
      fields: {
        patch_version: version,
        patch_branch: `release/v${version}`,
        patch_pr_number: pr.number,
        patch_head_sha: pr.head,
        patch_base_sha: parent,
        counts: { resolutions: selection.resolutions },
      },
    });
  } catch (err) {
    throw apiRefused(err, "N.0.1's pull request could not be recorded");
  }
  ctx.opts.out(
    `${pr.reused ? "Found" : "Opened"} N.0.1's pull request #${pr.number} of release/v${version} (${selection.resolutions} conflict(s) resolved to NEMAR's side, ${selection.unresolved} left on upstream's side); re-pull #${row.id} is patch_synthesized. Resume never merges.`,
  );
  return { kind: "next", row: next };
}
