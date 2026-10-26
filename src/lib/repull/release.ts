/**
 * The release of a merged re-pull (ADR 0111, decisions 2, 4 and 8; epic #1046 phase 6), as
 * `resume` takes it on from `merged` (N.0.0) or `patch_merged` (N.0.1). Nothing here mints: the
 * existing release path tags the merge (the dataset repository's `run-pr-merge` pushes
 * `v<Version>` on `main`), the tag mints the version DOI, and the DOI's callback writes the version
 * row. This waits for both, then records the release through the Worker's verified route, which
 * reads the version row and the tag itself:
 *
 *   merged        the squash commit GitHub wrote on `main` is read back from origin: its message
 *   patch_merged  must end with both of the re-pull commit's trailers as git reads them
 *                 (`merge-trailers` otherwise, the record left where it is, loudly), because the
 *                 privacy ledger's fresh-clone proof reads them there; then wait (bounded) for
 *                 `refs/tags/v<version>` on NEMAR's origin and for the version row; for N.0.0 the
 *                 tagged tree is compared with the recorded synthesized tree outside `.nemar/**`
 *                 and `.github/**` (the caller's `tree_verified`, which the Worker records as the
 *                 administrator's assertion and which alone upgrades the version's lineage; N.0.1
 *                 carries NEMAR's corrections, so its tree is never upstream's and no lineage is
 *                 asked for); then the release, in whose batch the Worker re-arms the dataset's
 *                 sweep stamps;
 *   released      the objects N.0.0's copy and uploads wrote, and only those, locked under the
 *                 governance lock with the existing s3-lock route, named one by one (`objects`),
 *                 never the whole prefix: their keys come from the staging manifest the copy wrote,
 *                 whose digest must be the one recorded at `prepared`. The route counts a 403 as
 *                 locked only when it read the object's retention back. Only once every one of them
 *                 is locked is the count recorded (`released -> released`), and the Worker refuses a
 *                 count below what the record says the copy and uploads wrote. A lock that did not
 *                 complete records why and leaves the row `released` without the count; the next
 *                 run locks again (an object already locked stays locked). Then N.0.1, or the end
 *                 (`patch-turn.ts`). N.0.1 copies nothing, so its release locks nothing.
 *
 * A tag that names another commit, a version row that does not come within the bound, or a
 * comparison GitHub cannot make leaves the row where it is, with why recorded; this command never
 * mints, and the existing DOI tooling repairs a mint that failed.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AwsCliError,
  type AwsRunner,
  DEFAULT_TIMEOUT_MS,
  cliCredentialSource,
  createAwsRunner,
  failureWord,
} from "../../../scripts/scrub/s3/s3-lib.js";
import {
  PULL_REQUEST_COLUMNS,
  type RepullPullRequest,
  type RepullRow,
} from "../../../shared/repull-state.js";
import { lockS3Objects } from "../api/data.js";
import { getVersionHistory } from "../api/datasets.js";
import { ApiError } from "../api/errors.js";
import { recordRepullReleased, repullErrorCode, transitionRepull } from "../api/repull.js";
import { stagingManifestKey } from "./execute/copy.js";
import { MOVED_REF_FETCH_DEPTH } from "./execute/head.js";
import { type OriginScratch, fetchInto, originRefs } from "./execute/origin.js";
import { releaseRefOf } from "./execute/pull-request.js";
import { ExecuteRefused } from "./execute/verify-plan.js";
import { git } from "./execute/workdir.js";
import { nemarRemoteOf } from "./plan.js";
import {
  type ResumeContext,
  type Turn,
  apiRefused,
  recordStepError,
  refused,
  resumeErrorWords,
} from "./steps.js";
import { trailersProblem } from "./trailers.js";

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

/**
 * The squash commit GitHub wrote must end with the re-pull commit's two trailers as git reads
 * them: the gate checked the message it sent, and this checks the one GitHub committed (a host
 * that appends a paragraph, a `Co-authored-by:` line of its own, would push them out of the last
 * paragraph, and the privacy ledger's fresh-clone proof would then fail the dataset). A message
 * that does not is `merge-trailers`, recorded on the row, which stays `merged`: the version may
 * already be tagged and minted, and only an administrator can decide what follows. Unread is not
 * a pass.
 */
async function assertMergeTrailers(
  ctx: ResumeContext,
  scratch: OriginScratch,
  row: RepullRow,
  pr: RepullPullRequest,
): Promise<void> {
  const merge = row[PULL_REQUEST_COLUMNS[pr].mergeSha] as string;
  const fail = async (code: string, message: string) => {
    const failure = refused(code, message);
    await recordStepError(row, resumeErrorWords("release", failure), ctx.opts.out);
    return failure;
  };
  if (!(await fetchInto(scratch, merge, 1))) {
    throw await fail(
      "merge-unreadable",
      `The merge commit ${merge.slice(0, 12)} could not be fetched from NEMAR's repository, so its trailers were not read; nothing was recorded past merged.`,
    );
  }
  const raw = await git(scratch.dir, ["cat-file", "commit", merge], { ok: true });
  const split = raw.stdout.indexOf("\n\n");
  const problem =
    raw.exitCode !== 0 || split < 0
      ? "its message could not be read"
      : await trailersProblem(raw.stdout.slice(split + 2), row);
  if (problem) {
    throw await fail(
      "merge-trailers",
      `The merge commit ${merge.slice(0, 12)} on main does not end with the re-pull commit's two trailers (${problem}), so the privacy ledger's fresh-clone proof would not read it as the re-pull's commit. The record stays ${row.status}; an administrator decides what follows.`,
    );
  }
}

/** At `merged` or `patch_merged`: the tag and the version row, waited for, then the release recorded. */
export async function releaseTurn(
  ctx: ResumeContext,
  row: RepullRow,
  pr: RepullPullRequest,
): Promise<Turn> {
  const version = row[PULL_REQUEST_COLUMNS[pr].version] as string;
  const tag = `refs/tags/v${version}`;
  const scratch = await ctx.origin();
  await assertMergeTrailers(ctx, scratch, row, pr);
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

  // Lineage is N.0.0's alone: N.0.1 carries NEMAR's corrections, so its tree is not upstream's.
  const treeVerified =
    pr === "n0" ? await taggedTreeVerified(scratch, row, tagSha, ctx.opts.out) : false;
  let res: Awaited<ReturnType<typeof recordRepullReleased>>;
  try {
    res = await recordRepullReleased(row.id, {
      pr,
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
    `Re-pull #${row.id} is released: v${version} at ${tagSha.slice(0, 12)}${pr === "n1" ? "" : res.lineage_rows ? `, lineage recorded for v${version}` : treeVerified ? "" : ", lineage not recorded"}; the dataset's sweeps read it again.`,
  );
  return { kind: "next", row: res.repull };
}

/** NEMAR's bucket as origin's git-annex branch names it, and a runner with the ambient AWS credentials. */
export interface NemarBucket {
  scratch: OriginScratch;
  uuid: string;
  bucket: string;
  region: string;
  prefix: string;
  aws: AwsRunner;
}

/**
 * NEMAR's `nemar-s3` bucket, read from origin's git-annex branch (fetched into the scratch
 * repository as `refs/remotes/origin/heads/git-annex`), with a runner that uses the ambient AWS
 * credentials, as the copy did. Refuses when the branch cannot be fetched or names no single
 * `nemar-s3` bucket.
 */
export async function nemarBucket(
  ctx: Pick<ResumeContext, "datasetId" | "env" | "origin">,
): Promise<NemarBucket> {
  const scratch = await ctx.origin();
  if (!(await fetchInto(scratch, "refs/heads/git-annex", 1))) {
    throw refused("origin-unreadable", "NEMAR's git-annex branch could not be fetched.");
  }
  const log = await git(
    scratch.dir,
    ["cat-file", "blob", "refs/remotes/origin/heads/git-annex:remote.log"],
    { ok: true },
  );
  const remote = nemarRemoteOf(log.exitCode === 0 ? log.stdout : "", ctx.datasetId);
  const bucket = remote.record?.bucket;
  if (log.exitCode !== 0 || !remote.uuid || !bucket) {
    throw refused("no-nemar-s3", "NEMAR's remote.log names no single nemar-s3 bucket.");
  }
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(ctx.env)) if (v !== undefined) env[k] = v;
  const aws = createAwsRunner({
    region: remote.region,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    env,
    credentials: cliCredentialSource({ commandEnv: env }),
  });
  return { scratch, uuid: remote.uuid, bucket, region: remote.region, prefix: remote.prefix, aws };
}

/**
 * The staging manifest the copy wrote to `<id>/staging/repull-<to_tag>.json` before its first
 * copy, read from NEMAR's bucket, whose digest must be the one the record holds from `prepared`
 * (`manifest-mismatch`); `staging-unreadable` when it cannot be read or is not there. Its copied
 * keys and its uploaded keys, each once.
 */
export async function stagingKeys(
  ctx: Pick<ResumeContext, "datasetId" | "env" | "origin">,
  row: RepullRow,
  nemar?: NemarBucket,
): Promise<string[]> {
  const { scratch, bucket, aws } = nemar ?? (await nemarBucket(ctx));
  const file = join(scratch.dir, "staging-manifest.json");
  let read = false;
  for (const tag of new Set([row.to_tag, `v${row.to_tag}`])) {
    try {
      await aws.api("get-object", [
        "--bucket",
        bucket,
        "--key",
        stagingManifestKey(ctx.datasetId, tag),
        file,
      ]);
      read = true;
      break;
    } catch (err) {
      if (!(err instanceof AwsCliError)) throw err;
      if (err.code !== "not-found") {
        throw refused(
          "staging-unreadable",
          `The staging manifest of re-pull #${row.id} could not be read (${failureWord(err)}); the ambient AWS credentials read it, as the copy wrote it.`,
        );
      }
    }
  }
  if (!read) {
    throw refused(
      "staging-unreadable",
      `The staging manifest of re-pull #${row.id} is not in NEMAR's bucket, so which objects its copy wrote is not known.`,
    );
  }
  const bytes = readFileSync(file);
  if (`sha256:${createHash("sha256").update(bytes).digest("hex")}` !== row.manifest_digest) {
    throw refused(
      "manifest-mismatch",
      "The staging manifest in NEMAR's bucket is not the copy manifest recorded at prepared.",
    );
  }
  const manifest = JSON.parse(bytes.toString("utf8")) as {
    items?: Array<{ key?: unknown }>;
    local?: Array<{ key?: unknown }>;
  };
  const keys = [...(manifest.items ?? []), ...(manifest.local ?? [])].map((i) => i.key);
  if (!keys.every((k): k is string => typeof k === "string")) {
    throw refused("manifest-mismatch", "The staging manifest names an object without a key.");
  }
  return [...new Set(keys)].sort();
}

/**
 * At `released`: the lock and its count. Returns the record with the count recorded, for the turn
 * that makes N.0.1 or ends the record (`patch-turn.ts`).
 */
export async function lockTurn(ctx: ResumeContext, row: RepullRow): Promise<Turn> {
  if (typeof row.counts.locked === "number") return { kind: "next", row };
  const record = async (code: string, message: string) => {
    const failure = refused(code, message);
    await recordStepError(row, resumeErrorWords("lock", failure), ctx.opts.out);
    return failure;
  };
  let keys: string[];
  try {
    keys = await stagingKeys(ctx, row);
  } catch (err) {
    if (err instanceof ExecuteRefused) throw await record(err.code, err.message);
    throw err;
  }
  let locked: Awaited<ReturnType<typeof lockS3Objects>>;
  try {
    locked =
      keys.length > 0
        ? await lockS3Objects(ctx.datasetId, keys)
        : { locked: 0, failed: [], objects: [] };
  } catch (err) {
    throw await record(
      "lock-failed",
      `The objects of v${row.to_version} could not be locked (${err instanceof ApiError ? `HTTP ${err.statusCode}` : "no answer"}); run resume again.`,
    );
  }
  const confirmed = new Set(locked.objects.map((o) => o.key));
  const missing = keys.filter((k) => !confirmed.has(k)).length;
  if (locked.failed.length > 0 || missing > 0) {
    // Counts only: the failures name object keys, and a record never holds a key.
    throw await record(
      "lock-incomplete",
      `${missing} of the ${keys.length} object(s) N.0.0's copy and uploads wrote were not locked (${keys.length - missing} were); run resume again, which locks them again.`,
    );
  }
  let current: RepullRow;
  try {
    current = await transitionRepull(row.id, {
      from: "released",
      to: "released",
      fields: { counts: { locked: keys.length } },
    });
  } catch (err) {
    throw apiRefused(err, "The count of locked objects could not be recorded");
  }
  ctx.opts.out(
    `Locked the ${keys.length} object(s) N.0.0's copy and uploads wrote under the governance lock.`,
  );
  return { kind: "next", row: current };
}
