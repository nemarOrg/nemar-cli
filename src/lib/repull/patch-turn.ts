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
 * The iEEG geometry pipeline's files (ADR 0111, the amendment of 2026-11-19; `pipeline-run.ts`) are
 * neither corrections nor conflicts: a mirror that has any (the record's `pipeline_owned` count)
 * gets N.0.1 even with no correction, made of the pipeline run again on the new `main`, and no N.0.1
 * is made when that run changes nothing and nothing else is replayed. A run that fails leaves the
 * previous pipeline files out, is recorded on the record, and holds nothing else back.
 *
 * It asks before it pushes (`--yes` answers): N.0.1's merge mints a second version DOI.
 */

import { AwsCliError, failureWord } from "../../../scripts/scrub/s3/s3-lib.js";
import { repullPatchTrailerLine, repullTrailerLines } from "../../../shared/repull-squash.js";
import { type RepullRow, patchVersionOf } from "../../../shared/repull-state.js";
import { getApiUrl } from "../api/client.js";
import { transitionRepull } from "../api/repull.js";
import { type PlanBody, defaultPlanPath } from "./digest.js";
import { listPrefixSizes } from "./execute/copy.js";
import { MOVED_REF_FETCH_DEPTH } from "./execute/head.js";
import { type OriginScratch, fetchInto, originRefs } from "./execute/origin.js";
import {
  acceptsHead,
  checkMain,
  openRelease,
  pushRelease,
  releaseRefOf,
} from "./execute/pull-request.js";
import { blobAt } from "./execute/resynthesize.js";
import { ExecuteRefused, readReviewedPlan } from "./execute/verify-plan.js";
import { git, hasCommit } from "./execute/workdir.js";
import {
  type PatchSelection,
  assertPatchLedger,
  assertReplayedKeys,
  findPatchCommit,
  hasReplay,
  patchCommit,
  patchSelection,
} from "./patch.js";
import { OWNERSHIP_PATH, isPipelineOutputPath } from "./pipeline-owned.js";
import {
  type PipelineFiles,
  type Regeneration,
  isEmptyRegeneration,
  regenerate,
} from "./pipeline-run.js";
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
async function complete(
  ctx: ResumeContext,
  row: RepullRow,
  why: string,
  counts?: Record<string, number>,
): Promise<Turn> {
  let done: RepullRow;
  try {
    done = await transitionRepull(row.id, {
      from: "released",
      to: "complete",
      ...(counts ? { fields: { counts } } : {}),
    });
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
export function patchBody(
  row: RepullRow,
  s: PatchSelection,
  version: string,
  pipeline: Regeneration | null = null,
): string {
  return [
    `NEMAR's corrections of re-pull #${row.id} (upstream ${row.upstream_ds} ${row.from_tag} to ${row.to_tag}), replayed onto v${row.to_version} as v${version} of ${row.dataset_id} (ADR 0111).`,
    "",
    `v${row.to_version} is upstream's snapshot ${row.upstream_ds}@${row.to_tag} with NEMAR's standard edits; this pull request puts back NEMAR's own side of what the plan listed as a correction, and of each conflict an administrator resolved to NEMAR's side. Nothing is scrubbed and nothing is copied: every replayed byte is in a version NEMAR already published.`,
    "",
    `- Re-pull record: #${row.id}`,
    `- Plan digest: ${row.plan_digest}`,
    `- Corrections the plan listed: ${s.corrections}; conflicts resolved to NEMAR's side: ${s.resolutions}`,
    `- Paths replayed: ${s.paths.length}; description keys replayed: ${s.keys.length}`,
    ...(pipeline === null
      ? []
      : [
          pipeline.ok
            ? `- iEEG geometry pipeline files regenerated from the new snapshot: ${pipeline.files.write.size} written, ${pipeline.files.remove.length} removed, ${pipeline.files.kept} kept as they are`
            : `- iEEG geometry pipeline files: the regeneration failed (${pipeline.code}), so this pull request carries none of the previous pipeline files`,
        ]),
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
  // A record that does not say has no pipeline-owned path: it was planned before the count existed,
  // and such a plan read a pipeline file as a correction.
  const pipelineOwned = row.counts.pipeline_owned ?? 0;
  const takeOurs = ctx.opts.takeOurs ?? [];
  if (typeof corrections !== "number" || typeof conflicts !== "number") {
    // Unknown is never zero: a record that does not say is not completed.
    // The record stays open and blocks the dataset's next re-pull, so the way out is named:
    // abandon ends a released record as patch_declined, with v<N.0.0> still released.
    ctx.opts.out(
      `Re-pull #${row.id}'s record does not say how many corrections and conflicts its plan has, so it is not completed; it stays released, and it blocks ${row.dataset_id}'s next re-pull until it is ended. nemar admin repull abandon ${row.dataset_id} ends it as patch_declined (v${row.to_version} stays released and N.0.1 is not made).`,
    );
    return { kind: "done", result: { row, outcome: "released" } };
  }
  if (corrections === 0 && conflicts === 0 && takeOurs.length === 0 && pipelineOwned === 0) {
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
    if (pipelineOwned !== planPipelineOwned(body)) {
      throw new ExecuteRefused(
        "patch-plan-mismatch",
        `The plan lists ${planPipelineOwned(body)} pipeline-owned path(s) and re-pull #${row.id} records ${pipelineOwned}; they are the same plan only when they agree.`,
      );
    }
    if (!hasReplay(selection) && pipelineOwned === 0) {
      return complete(
        ctx,
        row,
        ": the plan has no correction, and every conflict stays on upstream's side",
      );
    }
    return await makePatch(ctx, row, selection, version, {
      owned: pipelineOwnedPaths(body),
      upstreamWins: pipelineUpstreamWins(body),
      unowned: pipelineStrings(body, "unowned"),
      edited: pipelineStrings(body, "edited"),
    });
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

function planPipelineOwned(body: PlanBody): number {
  const n = (body.counts as unknown as { pipeline_owned?: unknown } | null)?.pipeline_owned;
  return typeof n === "number" ? n : 0;
}

function pipelineSection(body: PlanBody): Array<{ path: string; upstream_wins: boolean }> {
  const section = (body as unknown as { pipeline_owned?: { paths?: unknown } }).pipeline_owned;
  const rows = section?.paths;
  if (rows === undefined) return [];
  if (
    !Array.isArray(rows) ||
    !rows.every(
      (r) =>
        r &&
        typeof r === "object" &&
        typeof r.path === "string" &&
        typeof r.upstream_wins === "boolean",
    )
  ) {
    throw new ExecuteRefused(
      "plan-schema",
      "The plan's pipeline-owned section does not have the planner's shape.",
    );
  }
  return rows as Array<{ path: string; upstream_wins: boolean }>;
}

const pipelineOwnedPaths = (body: PlanBody) => new Set(pipelineSection(body).map((r) => r.path));
const pipelineUpstreamWins = (body: PlanBody) =>
  new Set(
    pipelineSection(body)
      .filter((r) => r.upstream_wins)
      .map((r) => r.path),
  );

/** A list of paths of the plan's pipeline-owned section (`unowned`, `edited`); none in an older plan. */
function pipelineStrings(body: PlanBody, key: "unowned" | "edited"): Set<string> {
  const v = (body as unknown as { pipeline_owned?: Record<string, unknown> }).pipeline_owned?.[key];
  if (v === undefined) return new Set();
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) {
    throw new ExecuteRefused(
      "plan-schema",
      "The plan's pipeline-owned section does not have the planner's shape.",
    );
  }
  return new Set(v as string[]);
}

/** Refusals that are about this run, not the record: nothing is recorded for them (exit 1). */
const RUN_PROBLEMS = new Set([
  "pipeline-regeneration-failed",
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

/**
 * A failure to run (the process could not start, timed out, or its clone or network failed) is
 * retried, at most {@link PIPELINE_ATTEMPTS} times, counted on the record; every other failure is a
 * check the bridge applied to what the run produced (version, report, outputs, undeclared writes),
 * which no retry mends, so it settles at once. A failure settles the same way after its last
 * attempt: N.0.1 goes on without the previous pipeline files and `pipeline_failed` is counted.
 */
const RETRYABLE_FAILURES = new Set([
  "pipeline-run-failed",
  "pipeline-unavailable",
  "pipeline-snapshot",
]);
export const PIPELINE_ATTEMPTS = 3;

/** Whether N.0.1's pushed commit changed a path of the pipeline's shape beside its parent. */
async function patchHoldsPipelineFiles(
  dir: string,
  commit: string,
  parent: string,
): Promise<boolean> {
  const r = await git(dir, ["diff", "--name-only", "-z", parent, commit], { ok: true });
  return r.stdout.split("\0").some((p) => p === OWNERSHIP_PATH || isPipelineOutputPath(p));
}

/** What `makePatch` needs of the plan to regenerate the pipeline's files. */
interface PipelineArgs {
  owned: ReadonlySet<string>;
  upstreamWins: ReadonlySet<string>;
  /** Listed paths that are not owned: the pipeline is handed a record without them. */
  unowned: ReadonlySet<string>;
  /** Hand-edited pipeline files N.0.1 replays: the pipeline finds them as NEMAR had them. */
  edited: ReadonlySet<string>;
}

/** Run the pipeline on `parent`, the new `main`; a failure is a value, never a throw. */
async function regenerateOn(
  ctx: ResumeContext,
  scratch: OriginScratch,
  row: RepullRow,
  parent: string,
  args: PipelineArgs,
): Promise<Regeneration> {
  if (!(await hasCommit(scratch.dir, parent)) && !(await fetchInto(scratch, parent, 1))) {
    throw refused(
      "origin-unreadable",
      "The new main could not be fetched from NEMAR's repository.",
    );
  }
  // The hand-edited files N.0.1 replays, as NEMAR's main held them at the base.
  const preserve = new Map<string, string>();
  if (args.edited.size > 0 && !(await hasCommit(scratch.dir, row.base_sha))) {
    await fetchInto(scratch, row.base_sha, 1);
  }
  for (const path of args.edited) {
    const text = await blobAt(scratch.dir, row.base_sha, path);
    if (text !== null) preserve.set(path, text);
  }
  return regenerate({
    unowned: args.unowned,
    preserve,
    datasetId: ctx.datasetId,
    version: row.to_version,
    commit: parent,
    repo: scratch.dir,
    owned: args.owned,
    upstreamWins: args.upstreamWins,
    env: ctx.env,
  });
}

async function makePatch(
  ctx: ResumeContext,
  row: RepullRow,
  selection: PatchSelection,
  version: string,
  pipelineArgs: PipelineArgs,
): Promise<Turn> {
  const nemar = await nemarBucket(ctx);
  const { scratch } = nemar;
  if (nemar.prefix !== `${ctx.datasetId}/objects/`) {
    throw new ExecuteRefused(
      "destination-prefix",
      `NEMAR's nemar-s3 is not at ${ctx.datasetId}/objects/, where the keys N.0.1 replays are read.`,
    );
  }
  // `main`: the N.0.0 merge, or an enrichment-shaped descendant of it, NEMAR's acceptance of that
  // merge included when it was made without its trailers.
  const main = await checkMain({
    work: scratch.dir,
    baseSha: row.merge_sha as string,
    env: scratch.env,
    acceptances: true,
  });
  const ref = releaseRefOf(version);
  const existing = (await originRefs(scratch, [ref])).get(ref);
  const branchForeign = () =>
    new ExecuteRefused(
      "branch-foreign",
      `release/v${version} exists on NEMAR's repository and is not this re-pull's N.0.1 commit with these resolutions${pipelineArgs.owned.size > 0 ? " and this regeneration of the iEEG geometry pipeline's files" : ""}; run resume with the resolutions the earlier run was given, or decline N.0.1 with nemar admin repull abandon ${ctx.datasetId}.`,
    );
  const unavailableOnResume = () =>
    refused(
      "pipeline-unavailable-on-resume",
      `release/v${version} was pushed with iEEG geometry pipeline files that this run did not reproduce (or with other resolutions); resume again with the resolutions the earlier run was given, where the pipeline runs as it did then (its pinned environment), or decline N.0.1 with nemar admin repull abandon ${ctx.datasetId}.`,
    );
  let found: { commit: string; parent: string } | null = null;
  if (existing) {
    // A branch an earlier run pushed: it must hold the very commit this makes for its own parent.
    if (!(await fetchInto(scratch, ref, MOVED_REF_FETCH_DEPTH))) {
      throw refused("origin-unreadable", `release/v${version} could not be fetched.`);
    }
    found = await findPatchCommit({ dir: scratch.dir, row, head: existing });
    if (!found) throw branchForeign();
  }
  const parent = found ? found.parent : main;
  // The pipeline's files, regenerated on the new `main`: the same bytes every time for the same
  // snapshot and pipeline version. The commit N.0.1 pushes (recorded as `patch_head_sha`, its tree
  // holding every regenerated byte) is the digest a later resume compares against, so a resume has
  // to run where the pipeline reproduces the output (the workflow's pinned Linux environment).
  const pipeline =
    pipelineArgs.owned.size > 0
      ? await regenerateOn(ctx, scratch, row, parent, pipelineArgs)
      : null;
  const files: PipelineFiles | undefined =
    pipeline?.ok && !isEmptyRegeneration(pipeline.files) ? pipeline.files : undefined;
  // A version or a report that is not the pinned one is the CLI's and the package's disagreement,
  // which no retry mends: N.0.1 goes on without the previous pipeline files, and the count says so.
  // Any other failure (the run, the clone, the network) may be only this machine: nothing is pushed
  // and the record stays `released`, so the next tick runs it again.
  const attempts = (row.counts.pipeline_attempts ?? 0) + 1;
  if (
    pipeline &&
    !pipeline.ok &&
    RETRYABLE_FAILURES.has(pipeline.code) &&
    attempts < PIPELINE_ATTEMPTS
  ) {
    const words = `[patch:pipeline-regeneration-failed] The iEEG geometry pipeline could not be run (${pipeline.code}), attempt ${attempts} of ${PIPELINE_ATTEMPTS}; N.0.1 is not made yet, resume again where the pipeline runs.`;
    try {
      await transitionRepull(row.id, {
        from: "released",
        to: "released",
        fields: { counts: { pipeline_attempts: attempts } },
        error: words,
      });
    } catch (err) {
      throw apiRefused(err, "The pipeline attempt could not be recorded");
    }
    throw refused(
      "pipeline-regeneration-failed",
      words.slice("[patch:pipeline-regeneration-failed] ".length),
    );
  }
  if (found && pipelineArgs.owned.size > 0 && (pipeline === null || !pipeline.ok || !files)) {
    // The branch holds an N.0.1 made with pipeline files this run cannot reproduce.
    const pushedHasFiles = await patchHoldsPipelineFiles(scratch.dir, found.commit, parent);
    if (pushedHasFiles) throw unavailableOnResume();
  }
  // A failure that settles is counted, with the attempts that led to it when it was retried.
  const settleCounts: Record<string, number> | undefined =
    pipeline && !pipeline.ok
      ? {
          pipeline_failed: 1,
          ...(RETRYABLE_FAILURES.has(pipeline.code) ? { pipeline_attempts: attempts } : {}),
        }
      : undefined;
  if (pipeline && !pipeline.ok) {
    await recordStepError(
      row,
      `[patch:${pipeline.code}] ${pipeline.message} N.0.1 carries none of the previous iEEG geometry pipeline files.`,
      ctx.opts.out,
    );
    ctx.opts.out(
      `The iEEG geometry pipeline's files were not regenerated (${pipeline.code}); N.0.1 carries none of the previous ones.`,
    );
  } else if (files) {
    ctx.opts.out(
      `Regenerated the iEEG geometry pipeline's files: ${files.write.size} written, ${files.remove.length} removed.`,
    );
  }
  if (!found && !hasReplay(selection) && files === undefined) {
    return complete(
      ctx,
      row,
      pipeline && !pipeline.ok
        ? ": nothing else is replayed, and the pipeline's files were not regenerated"
        : ": nothing is replayed, and the pipeline's files are as the new snapshot leaves them",
      settleCounts,
    );
  }
  const made = await patchCommit({ scratch, row, selection, parent, pipeline: files });
  if (found && made.sha !== found.commit) {
    throw pipelineArgs.owned.size > 0 ? unavailableOnResume() : branchForeign();
  }
  const commit = found ? found.commit : made.sha;
  const keys = made.keys;

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
      `Make v${version} of ${ctx.datasetId}: replay ${selection.paths.length} path(s) and ${selection.keys.length} description key(s) onto main (${selection.corrections} correction(s), ${selection.resolutions} conflict(s) resolved to NEMAR's side, ${selection.unresolved} left on upstream's side${files ? `; ${files.write.size} iEEG geometry pipeline file(s) written, ${files.remove.length} removed` : ""}), push release/v${version} and open its pull request? Its merge will mint one more version DOI, which cannot be withdrawn.`,
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
    body: patchBody(row, selection, version, pipeline),
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
        counts: {
          resolutions: selection.resolutions,
          ...(settleCounts ?? {}),
        },
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
