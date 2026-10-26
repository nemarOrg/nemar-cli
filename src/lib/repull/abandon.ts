/**
 * Ending an open re-pull by hand (ADR 0111: an abandon before N.0.0 merges closes its pull request
 * and deletes its branch, after it declines N.0.1; epic #1046 phase 6): `nemar admin repull
 * abandon <id>`, and the supersede `nemar admin repull execute --supersede` makes of an open record
 * before it creates the newer one.
 *
 *   before N.0.0 merges     (`planned` to `gates_clear`): its pull request is closed and its
 *                           release branch deleted, when they exist and are this re-pull's; the
 *                           objects its copy and uploads wrote that `main`'s current tree does not
 *                           name are reported, in objects and bytes, and never deleted (the
 *                           staging manifest that lists them is kept); the record ends `abandoned`
 *                           (or `superseded`). A new attempt at the tag is then allowed.
 *   between merge and release (`merged`): refused (`wait-for-release`). N.0.0's merge minted a DOI,
 *                           so its release (the tag, lineage, the sweep stamps and the lock) is
 *                           recorded first, by `resume`; abandoning it here would skip them.
 *   after N.0.0's release   (`released`, `patch_synthesized`, `patch_gates_clear`): only N.0.1's
 *                           pull request and branch are closed and deleted, when they exist, and
 *                           the record ends `patch_declined`; N.0.0 stays released, and its
 *                           corrections remain corrections in the next plan. A `released` record
 *                           whose lock is not recorded is refused (`lock-unrecorded`): resume
 *                           locks N.0.0's objects first, and declining N.0.1 never skips that.
 *   once N.0.1 merged       (`patch_merged`, `patch_released`): refused (`wait-for-release`).
 *
 * A merged record is never ended this way, for N.0.0's pull request and N.0.1's alike: before
 * anything is closed, every pull request GitHub lists of the release branch, and the recorded one
 * read by its number whatever the list says, is read on GitHub, and one that merged refuses
 * (`pull-request-merged`; `resume` records it). So does a claim to merge that is held
 * (`merge-claim-held`; `resume` resolves it from GitHub), which the Worker refuses as well. Nothing
 * is closed or deleted before the record is known to be endable, and a pull request found merged
 * after its close is not ended either.
 *
 * Only the release branch of this re-pull is deleted, through the write guard and leased on the
 * head that was judged to be the re-pull's, so a push that lands after the judgment is never
 * deleted unseen; it is judged the re-pull's when its head is the record's commit or an
 * enrichment-shaped descendant of it (for N.0.1, when it holds this record's N.0.1 commit beneath
 * enrichment). Any other head, or one that cannot be read, is left and said. The working
 * directory, which holds the delta's unscrubbed originals, and the checkpoint are removed. Giving
 * up stays possible on a dataset that became anonymous or withdrawn: the Worker does not hold an
 * edge that ends a record to the dataset fences. Nothing here mails anyone.
 *
 * Refusals follow one convention: `stop` before anything is written (the command's exit 1), and
 * `refused` (resumable, exit 3: run abandon again) once a step may have closed or deleted
 * something.
 */

import { dirname, join } from "node:path";
import { isKeyPresentAtDeclaredSize } from "../../../shared/annex-key.js";
import {
  BEFORE_MERGE,
  PATCH_OPEN,
  type RepullRow,
  type RepullStatus,
} from "../../../shared/repull-state.js";
import { ApiError } from "../api/errors.js";
import { listRepulls, repullErrorCode, transitionRepull } from "../api/repull.js";
import { getConfigDir } from "../config.js";
import {
  adminGitHubToken,
  closePullRequest,
  fetchPullRequest,
  githubApiBase,
} from "../pr-review-approve.js";
import { annexKeyOfEntry } from "./edits.js";
import { listPrefixSizes } from "./execute/copy.js";
import { MOVED_REF_FETCH_DEPTH } from "./execute/head.js";
import { type OriginScratch, fetchInto, openOriginScratch, originRefs } from "./execute/origin.js";
import { acceptsHead, releaseRefOf } from "./execute/pull-request.js";
import { guardedPush, pushCauseWords } from "./execute/push.js";
import { treeOf } from "./execute/resynthesize.js";
import { ExecuteRefused } from "./execute/verify-plan.js";
import {
  acquireLock,
  git,
  privateDir,
  removeTree,
  withIsolatedGit,
  workPaths,
} from "./execute/workdir.js";
import { findPatchCommit } from "./patch.js";
import { listPulls, pullListWhy } from "./pulls.js";
import { nemarBucket, stagingKeys } from "./release.js";
import { readBlobs } from "./sources.js";
import type { Env } from "./sources.js";
import { refused } from "./steps.js";

/** A refusal before anything was closed, deleted or recorded (the command's exit 1). */
function stop(code: string, message: string): ExecuteRefused {
  return new ExecuteRefused(code, message);
}

/** The statuses at which this re-pull may have pushed its N.0.0 release branch. */
export const BRANCH_PUSHED: readonly RepullStatus[] = ["registered", "pr_open", "gates_clear"];

/**
 * Objects an ended attempt wrote that `main`'s current tree does not name: reported, never deleted
 * (ADR 0111: nothing of a version's objects is deleted, and an abandon reports the orphans).
 */
export interface Orphans {
  objects: number;
  bytes: number;
}

/** What ending a record found and did, in counts and fixed words. */
export interface EndReport {
  /** Pull requests closed, by number. */
  closed: number[];
  /** Whether the release branch was deleted, kept (why), or absent. */
  branch: "deleted" | "absent" | "kept-foreign" | "kept-unreadable";
  /** Null when the orphans could not be read: unknown, never zero. */
  orphans: Orphans | null;
  /** Why the orphans are null, when they are. */
  orphansUnknown?: string;
}

export interface EndContext {
  datasetId: string;
  token: string;
  base: string;
  env: Env;
  configDir: string;
  out: (line: string) => void;
  origin(): Promise<OriginScratch>;
}

/** A pull request of the release branch, as GitHub reads it now. */
interface BranchPull {
  number: number;
  state: "open" | "closed" | "merged";
  headSha: string;
}

/**
 * Every pull request GitHub lists of `branch` in the dataset's own repository, and the `recorded`
 * one whatever the list says (a pull request the head filter misses is still the record's), each
 * read by its number, since the list does not say whether one merged. Unreadable refuses: whether
 * one merged must be known.
 */
async function pullsOfBranch(
  ctx: EndContext,
  branch: string,
  recorded: number | null,
): Promise<BranchPull[]> {
  const listed = await listPulls({
    token: ctx.token,
    base: ctx.base,
    datasetId: ctx.datasetId,
    state: "all",
    head: branch,
  });
  if (!listed.ok) {
    throw stop(
      "github-unreadable",
      `GitHub's pull requests of ${branch} could not be read whole (${pullListWhy(listed)}), so whether one merged is not known; nothing was closed.`,
    );
  }
  const numbers = new Set(listed.pulls.filter((p) => p.headRef === branch).map((p) => p.number));
  if (recorded !== null) numbers.add(recorded);
  const out: BranchPull[] = [];
  for (const n of [...numbers].sort((a, b) => a - b)) {
    const read = await fetchPullRequest(ctx.token, ctx.datasetId, n, ctx.base);
    if (!read.ok) {
      throw stop(
        "github-unreadable",
        `Pull request #${n} could not be read on GitHub (${read.reason}); nothing was closed.`,
      );
    }
    out.push({ number: n, state: read.value.state, headSha: read.value.headSha });
  }
  return out;
}

function mergedRefusal(ctx: EndContext, n: number, afterWrite = false): ExecuteRefused {
  return (afterWrite ? refused : stop)(
    "pull-request-merged",
    `GitHub says pull request #${n} merged, so this re-pull is not ended: nemar admin repull resume ${ctx.datasetId} records the merge (a merge minted a DOI, and its release is recorded, not abandoned).`,
  );
}

/** Every annex key `commit`'s tree names: its symlinks, and its pointer files (one line, small). */
async function annexKeysOfTree(dir: string, commit: string): Promise<Set<string>> {
  const entries = (await treeOf(dir, commit)).filter(
    (e) => e.mode === "120000" || e.mode === "100644" || e.mode === "100755",
  );
  const sizes = new Map<string, number>();
  if (entries.length > 0) {
    const checked = await git(dir, ["cat-file", "--batch-check"], {
      stdin: `${entries.map((e) => e.oid).join("\n")}\n`,
      code: "origin-unreadable",
      step: "cat-file",
    });
    for (const line of checked.stdout.split("\n")) {
      const [oid, type, size] = line.split(" ");
      if (oid && type === "blob" && size) sizes.set(oid, Number(size));
    }
  }
  const wanted = entries.filter(
    (e) => e.mode === "120000" || (sizes.get(e.oid) ?? Number.POSITIVE_INFINITY) <= 1024,
  );
  const blobs = await readBlobs(
    dir,
    wanted.map((e) => e.oid),
  );
  const keys = new Set<string>();
  for (const e of wanted) {
    const bytes = blobs.get(e.oid);
    const key = bytes ? annexKeyOfEntry(e.mode, bytes) : null;
    if (key) keys.add(key);
  }
  return keys;
}

/**
 * The objects N.0.0's copy and uploads wrote (the staging manifest's keys) that NEMAR's bucket
 * holds and `main`'s current tree does not name, in objects and bytes. Null, with why, when they
 * cannot be read: a record ended before the copy wrote its manifest has no list of what
 * preparation uploaded, and without the ambient AWS credentials nothing can be listed.
 */
async function orphansOf(
  ctx: EndContext,
  row: RepullRow,
): Promise<{ orphans: Orphans | null; why?: string }> {
  if (row.status === "planned" || row.manifest_digest === null) {
    return {
      orphans: null,
      why: "the record has no copy manifest yet, so what preparation may have uploaded is not listed",
    };
  }
  try {
    const nemar = await nemarBucket(ctx);
    const keys = await stagingKeys(ctx, row, nemar);
    const scratch = nemar.scratch;
    if (!(await fetchInto(scratch, "refs/heads/main", 1))) {
      return { orphans: null, why: "NEMAR's main could not be fetched" };
    }
    const named = await annexKeysOfTree(scratch.dir, "refs/remotes/origin/heads/main");
    const listing = await listPrefixSizes(nemar.aws, nemar.bucket, nemar.prefix);
    let objects = 0;
    let bytes = 0;
    for (const key of keys) {
      if (named.has(key) || !isKeyPresentAtDeclaredSize(key, listing)) continue;
      objects++;
      bytes += listing.get(key) ?? 0;
    }
    return { orphans: { objects, bytes } };
  } catch (err) {
    if (err instanceof ExecuteRefused && err.code === "staging-unreadable") {
      return {
        orphans: null,
        why: "the staging manifest the copy writes is not readable (it is written before the first copy)",
      };
    }
    return {
      orphans: null,
      why: `they could not be read (${err instanceof ExecuteRefused ? err.code : err instanceof Error ? err.name : "error"})`,
    };
  }
}

/**
 * Delete `release/v<version>` through the write guard, leased on `head`, the head judged to be this
 * re-pull's: a branch that moved since is not deleted (`branch-moved`).
 */
async function deleteBranch(scratch: OriginScratch, version: string, head: string): Promise<void> {
  const ref = releaseRefOf(version);
  const pushed = await guardedPush(
    scratch.dir,
    ["--delete", ref],
    { versions: [version] },
    scratch.env,
    [`--force-with-lease=${ref}:${head}`],
  );
  if (pushed.outcome === "rejected") {
    throw refused(
      "branch-moved",
      `release/v${version} moved since it was judged this re-pull's, so it was not deleted and the record was not ended. Run abandon again.`,
    );
  }
  if (pushed.outcome !== "pushed" && pushed.outcome !== "up-to-date") {
    throw refused(
      "push-failed",
      `release/v${version} could not be deleted (${pushCauseWords(pushed.cause)}); the record was not ended. Run abandon again.`,
    );
  }
}

/** What ending a record will do, read before anything is written. */
interface EndPlan {
  version: string;
  /** Open pull requests of this re-pull to close. */
  close: number[];
  /** The release branch's head when it is this re-pull's and is deleted; null when it is not. */
  deleteHead: string | null;
  branch: EndReport["branch"];
}

/**
 * N.0.0's pull request and branch, judged (before anything is written), at the statuses at which
 * this re-pull may have pushed its branch (`registered`, `pr_open`, `gates_clear`): a merged pull
 * request of the branch refuses; an open one is this re-pull's when the record names it, or when its
 * head is the record's commit or an enrichment-shaped descendant of it.
 */
async function surveyN0(ctx: EndContext, row: RepullRow): Promise<EndPlan> {
  const version = row.to_version;
  if (row.merge_claim_sha !== null) {
    throw stop(
      "merge-claim-held",
      `A claim to merge re-pull #${row.id}'s pull request is held, so it may have merged: run nemar admin repull resume ${ctx.datasetId}, which reads GitHub and records the merge or expires the claim, then abandon again.`,
    );
  }
  const plan: EndPlan = { version, close: [], deleteHead: null, branch: "absent" };
  if (!BRANCH_PUSHED.includes(row.status)) return plan;
  const branch = `release/v${version}`;
  const scratch = await ctx.origin();
  const ours = async (sha: string) =>
    sha === row.head_sha ||
    (row.synth_sha !== null &&
      (await acceptsHead({
        work: scratch.dir,
        from: row.synth_sha,
        head: sha,
        ref: releaseRefOf(version),
        env: scratch.env,
      })) === "ok");
  for (const p of await pullsOfBranch(ctx, branch, row.pr_number)) {
    if (p.state === "merged") throw mergedRefusal(ctx, p.number);
    if (p.state === "open" && (p.number === row.pr_number || (await ours(p.headSha)))) {
      plan.close.push(p.number);
    }
  }
  const head = (await originRefs(scratch, [releaseRefOf(version)])).get(releaseRefOf(version));
  if (head) {
    const verdict = await acceptsHeadOrUnreadable(
      scratch,
      row.synth_sha,
      head,
      version,
      row.head_sha,
    );
    plan.branch =
      verdict === "ok" ? "deleted" : verdict === "unreadable" ? "kept-unreadable" : "kept-foreign";
    if (verdict === "ok") plan.deleteHead = head;
  }
  return plan;
}

async function acceptsHeadOrUnreadable(
  scratch: OriginScratch,
  from: string | null,
  head: string,
  version: string,
  recorded: string | null,
): Promise<"ok" | "foreign" | "unreadable"> {
  if (head === recorded || head === from) return "ok";
  if (from === null) return "foreign";
  return acceptsHead({
    work: scratch.dir,
    from,
    head,
    ref: releaseRefOf(version),
    env: scratch.env,
  });
}

/**
 * N.0.1's pull request and branch, judged as {@link surveyN0} judges N.0.0's: a held claim and a
 * merged pull request refuse with the same words; the branch is this record's when it holds this
 * record's N.0.1 commit beneath enrichment, and kept (`kept-unreadable`) when that cannot be read.
 */
async function surveyN1(ctx: EndContext, row: RepullRow): Promise<EndPlan> {
  const version = row.patch_version ?? `${row.to_version.split(".")[0]}.0.1`;
  if (row.patch_merge_claim_sha !== null) {
    throw stop(
      "merge-claim-held",
      `A claim to merge re-pull #${row.id}'s N.0.1 pull request is held, so it may have merged: run nemar admin repull resume ${ctx.datasetId}, which reads GitHub and records the merge or expires the claim, then abandon again.`,
    );
  }
  const branch = `release/v${version}`;
  const ref = releaseRefOf(version);
  const scratch = await ctx.origin();
  const head = (await originRefs(scratch, [ref])).get(ref);
  let verdict: "ok" | "foreign" | "unreadable" | null = null;
  if (head) {
    if (head === row.patch_head_sha) {
      verdict = "ok";
    } else if (
      !(await fetchInto(scratch, ref, MOVED_REF_FETCH_DEPTH)) ||
      !(await fetchInto(scratch, row.merge_sha as string, MOVED_REF_FETCH_DEPTH))
    ) {
      verdict = "unreadable";
    } else {
      verdict = (await findPatchCommit({ dir: scratch.dir, row, head })) ? "ok" : "foreign";
    }
  }
  const plan: EndPlan = {
    version,
    close: [],
    deleteHead: head && verdict === "ok" ? head : null,
    branch:
      verdict === null
        ? "absent"
        : verdict === "ok"
          ? "deleted"
          : verdict === "unreadable"
            ? "kept-unreadable"
            : "kept-foreign",
  };
  for (const p of await pullsOfBranch(ctx, branch, row.patch_pr_number)) {
    if (p.state === "merged") throw mergedRefusal(ctx, p.number);
    const ours = p.number === row.patch_pr_number || (verdict === "ok" && p.headSha === head);
    if (p.state === "open" && ours) plan.close.push(p.number);
  }
  return plan;
}

/** Close the pull requests, delete the branch, then end the record; a merge found in between stops. */
async function act(
  ctx: EndContext,
  row: RepullRow,
  plan: EndPlan,
  to: "abandoned" | "superseded" | "patch_declined",
  orphans: Orphans | null,
): Promise<RepullRow> {
  for (const n of plan.close) {
    const closed = await closePullRequest(ctx.token, ctx.datasetId, n, ctx.base);
    // Read again whatever the answer: a merge that landed first is never ended.
    const after = await fetchPullRequest(ctx.token, ctx.datasetId, n, ctx.base);
    if (after.ok && after.value.state === "merged") throw mergedRefusal(ctx, n, true);
    if (!after.ok || after.value.state !== "closed") {
      throw refused(
        "github-failed",
        `Pull request #${n} could not be closed (${closed.ok ? "it is not closed" : closed.reason}); the record was not ended. Run abandon again.`,
      );
    }
    ctx.out(`Closed pull request #${n}.`);
  }
  if (plan.deleteHead !== null) {
    await deleteBranch(await ctx.origin(), plan.version, plan.deleteHead);
    ctx.out(`Deleted release/v${plan.version}.`);
  }
  try {
    return await transitionRepull(row.id, {
      from: row.status,
      to,
      fields: orphans
        ? { counts: { orphan_objects: orphans.objects, orphan_bytes: orphans.bytes } }
        : {},
    });
  } catch (err) {
    const code =
      repullErrorCode(err) ?? (err instanceof ApiError ? "record-refused" : "github-failed");
    throw refused(
      code,
      `The record could not be ended: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** What a caller asks before anything is written: a yes ends the record. */
export type Confirm = (question: string) => Promise<boolean>;

/**
 * End `row` before N.0.0 merged: `abandoned`, or `superseded` for a newer tag's plan. Reads
 * everything first, asks (`confirm`), then closes, deletes and records.
 */
export async function endBeforeMerge(
  ctx: EndContext,
  row: RepullRow,
  to: "abandoned" | "superseded",
  confirm?: Confirm,
  opts: { branchMustGo?: boolean } = {},
): Promise<{ row: RepullRow; report: EndReport }> {
  if (!BEFORE_MERGE.includes(row.status)) {
    throw stop("bad-transition", `Re-pull #${row.id} is ${row.status}, not before its merge.`);
  }
  const plan = await surveyN0(ctx, row);
  if (opts.branchMustGo && (plan.branch === "kept-foreign" || plan.branch === "kept-unreadable")) {
    // The record that follows pushes the same branch name; one that cannot go would stop it later.
    throw stop(
      "branch-foreign",
      `release/v${plan.version} ${plan.branch === "kept-foreign" ? `holds a commit that is not re-pull #${row.id}'s or enrichment's` : "could not be read"}, so it is not deleted, and the new record would push the same branch: nothing was closed or recorded. Check what the branch holds and remove it, then execute again.`,
    );
  }
  const { orphans, why } = await orphansOf(ctx, row);
  const what = [
    plan.close.length > 0
      ? `close pull request ${plan.close.map((n) => `#${n}`).join(", ")}`
      : null,
    plan.deleteHead ? `delete release/v${plan.version}` : null,
    `end re-pull #${row.id} ${to}`,
  ].filter(Boolean);
  const kept = orphans
    ? `${orphans.objects} object(s), ${orphans.bytes} byte(s), that its copy and uploads wrote stay in NEMAR's bucket, unlocked, and are not deleted`
    : `what its copy and uploads wrote stays in NEMAR's bucket, not deleted (not counted: ${why})`;
  if (confirm && !(await confirm(`${what.join(", ")}? The ${kept}.`))) {
    throw stop("declined", "Not confirmed; nothing was closed, deleted or recorded.");
  }
  const ended = await act(ctx, row, plan, to, orphans);
  removeWorkdirs(ctx, row);
  return {
    row: ended,
    report: {
      closed: plan.close,
      branch: plan.branch,
      orphans,
      ...(orphans ? {} : { orphansUnknown: why }),
    },
  };
}

/** Decline N.0.1 of a released N.0.0: `patch_declined`. */
async function declinePatch(
  ctx: EndContext,
  row: RepullRow,
  confirm?: Confirm,
): Promise<{ row: RepullRow; report: EndReport }> {
  // Declining N.0.1 never skips N.0.0's lock: its objects are a released version's.
  if (row.status === "released" && typeof row.counts.locked !== "number") {
    throw stop(
      "lock-unrecorded",
      `Re-pull #${row.id} records no count of locked objects: run nemar admin repull resume ${ctx.datasetId}, which locks what N.0.0's copy and uploads wrote, then abandon again to decline N.0.1.`,
    );
  }
  const plan = await surveyN1(ctx, row);
  const what = [
    plan.close.length > 0
      ? `close N.0.1's pull request ${plan.close.map((n) => `#${n}`).join(", ")}`
      : null,
    plan.deleteHead ? `delete release/v${plan.version}` : null,
    `end re-pull #${row.id} patch_declined`,
  ].filter(Boolean);
  if (
    confirm &&
    !(await confirm(
      `${what.join(", ")}? v${row.to_version} stays released; its corrections remain corrections in the next plan.`,
    ))
  ) {
    throw stop("declined", "Not confirmed; nothing was closed, deleted or recorded.");
  }
  const ended = await act(ctx, row, plan, "patch_declined", null);
  removeWorkdirs(ctx, row);
  return { row: ended, report: { closed: plan.close, branch: plan.branch, orphans: null } };
}

/** The working directory (the delta's unscrubbed originals) and the checkpoint of an ended record. */
function removeWorkdirs(ctx: EndContext, row: RepullRow): void {
  const paths = workPaths(ctx.configDir, ctx.datasetId, row.plan_digest);
  for (const path of [paths.root, paths.bundle]) {
    try {
      removeTree(path);
    } catch {
      ctx.out(
        `${path} could not be removed; remove it by hand (it may hold unscrubbed originals).`,
      );
    }
  }
}

export interface AbandonOptions {
  datasetId: string;
  confirm?: Confirm;
  env?: Env;
  out: (line: string) => void;
}

export interface AbandonResult {
  row: RepullRow | null;
  outcome: "abandoned" | "patch_declined" | "nothing";
  report?: EndReport;
}

/** `nemar admin repull abandon <id>`. See the module comment. */
export async function abandonRepull(opts: AbandonOptions): Promise<AbandonResult> {
  return withIsolatedGit(() => abandon(opts));
}

async function abandon(opts: AbandonOptions): Promise<AbandonResult> {
  const env = opts.env ?? process.env;
  const base = githubApiBase(env);
  const token = await adminGitHubToken(env);
  if (!token.ok) {
    throw stop(
      "no-github-token",
      `No GitHub token (${token.reason}): abandon reads and closes the pull request with the administrator's own (GH_TOKEN, or gh auth login).`,
    );
  }
  let open: RepullRow | null;
  try {
    open =
      (await listRepulls({ dataset: opts.datasetId, open: true, limit: 1 })).repulls[0] ?? null;
  } catch (err) {
    throw stop(
      repullErrorCode(err) ?? "record-refused",
      `The NEMAR API could not list the re-pulls: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!open) {
    const latest = (await listRepulls({ dataset: opts.datasetId, limit: 1 })).repulls[0] ?? null;
    return { row: latest, outcome: "nothing" };
  }
  if (
    open.status === "merged" ||
    open.status === "patch_merged" ||
    open.status === "patch_released"
  ) {
    throw stop(
      "wait-for-release",
      `Re-pull #${open.id} is ${open.status}: its merge minted a DOI, so its release is recorded first (nemar admin repull resume ${opts.datasetId}); a merged pull request is never abandoned.${open.status === "merged" ? " Once N.0.0 is released, abandon declines N.0.1." : ""}`,
    );
  }
  const configDir = getConfigDir();
  const paths = workPaths(configDir, opts.datasetId, open.plan_digest);
  privateDir(dirname(paths.lock), join(configDir, "repull"));
  // One run on a record at a time: no resume or execute pushes while it is ended.
  const unlock = acquireLock(paths.lock);
  let scratch: OriginScratch | null = null;
  const ctx: EndContext = {
    datasetId: opts.datasetId,
    token: token.token,
    base,
    env,
    configDir,
    out: opts.out,
    origin: async () => {
      scratch ??= await openOriginScratch({
        configDir,
        datasetId: opts.datasetId,
        digest: open.plan_digest,
        purpose: "resume",
        env,
        token: token.token,
      });
      return scratch;
    },
  };
  try {
    if (BEFORE_MERGE.includes(open.status)) {
      const ended = await endBeforeMerge(ctx, open, "abandoned", opts.confirm);
      return { row: ended.row, outcome: "abandoned", report: ended.report };
    }
    if (PATCH_OPEN.includes(open.status)) {
      const ended = await declinePatch(ctx, open, opts.confirm);
      return { row: ended.row, outcome: "patch_declined", report: ended.report };
    }
    throw stop(
      "bad-transition",
      `Re-pull #${open.id} is ${open.status}, which abandon does not end.`,
    );
  } finally {
    (scratch as OriginScratch | null)?.close();
    unlock();
  }
}
