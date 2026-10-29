/**
 * `nemar admin repull resume <id> --accept-merge-trailers "<reason>"`: the acceptance of a re-pull's
 * squash merge made without its trailers (epic #1046; ADR 0111, the amendment of 2026-10-29; issue
 * #1996), as the release step takes it on from `merged` or `patch_merged` (`release.ts`).
 *
 * The merge gate writes the squash message so that its last paragraph is the re-pull commit's
 * trailers, which the privacy ledger's fresh-clone proof (ADR 0085) reads; a merge made with
 * GitHub's own button carries GitHub's message instead, and the release refuses it
 * (`merge-trailers`). Rewriting `main` is no repair, so an administrator may accept the merge, on
 * evidence and never on the reason alone. Before anything is sent this reads, with the
 * administrator's own token and from NEMAR's origin, in this order; the first that does not hold
 * refuses with its word and nothing is written, not even the step's error:
 *  - the record an administrator opened (`accept-automatic`: the automatic path's merges are the
 *    Worker's, sent with the trailers);
 *  - its pull request on GitHub: merged, from the record's release branch into `main` of the
 *    dataset's own repository, with the record's merge commit (`merge-mismatch`, `pr-foreign`), at
 *    the recorded head or an enrichment-shaped descendant of it (`merge-head-foreign`);
 *  - the merge commit: one parent (`merge-not-squash`), the record's base or an enrichment-shaped
 *    descendant of it (`merge-parent-foreign`);
 *  - its tree, the record's commit outside `.nemar/**` and `.github/**` (`merge-tree-mismatch`),
 *    the comparison the release makes for the tag (`tagTreeVersus`); N.0.1 needs its gated head
 *    (`tree-anchor-missing`);
 *  - what it did to the privacy ledger: nothing, or scrub lines appended (`merge-ledger-foreign`).
 * Then the Worker reads all of it again with its own credential, checks that the record is this
 * administrator's, records the acceptance with the reason, and, when the merge appended a
 * `repull-scrubbed` line beside other files, appends the one ledger line that names it to `main`.
 * This reads that line back from origin before the release goes on. A later run finds the
 * acceptance recorded and goes on without the flag.
 */

import { NEMAR_DATASETS_ORG, isOwnDatasetRepo } from "../../../shared/nemar-app.js";
import {
  LEDGER_REPO_PATH,
  acceptedMergesOf,
  ledgerChange,
  ledgerLines,
} from "../../../shared/repull-merge-acceptance.js";
import {
  PULL_REQUEST_COLUMNS,
  type RepullPullRequest,
  type RepullRow,
} from "../../../shared/repull-state.js";
import {
  type RepullAcceptanceEvidence,
  type RepullMergeAcceptance,
  acceptRepullMergeTrailers,
  repullErrorCode,
} from "../api/repull.js";
import { fetchPullRequest } from "../pr-review-approve.js";
import { MOVED_REF_FETCH_DEPTH, enrichmentOnlySince } from "./execute/head.js";
import { type OriginScratch, fetchInto } from "./execute/origin.js";
import { releaseRefOf } from "./execute/pull-request.js";
import { ExecuteRefused } from "./execute/verify-plan.js";
import { git } from "./execute/workdir.js";
import { tagTreeVersus } from "./release.js";
import { type ResumeContext, apiRefused, refused } from "./steps.js";

/** A refusal on the evidence: nothing was written, and running again will not change it (exit 1). */
function denied(code: string, message: string): ExecuteRefused {
  return new ExecuteRefused(code, `${message} Nothing was accepted or written.`);
}

const short = (sha: string) => sha.slice(0, 12);

/** The ledger's text at `rev` in the scratch repository, or null when it has none there. */
async function ledgerAt(scratch: OriginScratch, rev: string): Promise<string | null> {
  const r = await git(scratch.dir, ["cat-file", "blob", `${rev}:${LEDGER_REPO_PATH}`], {
    ok: true,
  });
  return r.exitCode === 0 ? r.stdout : null;
}

/** The commit's parents, or null when it cannot be read. */
async function parentsOf(scratch: OriginScratch, sha: string): Promise<string[] | null> {
  const r = await git(scratch.dir, ["rev-list", "--parents", "-n", "1", sha], { ok: true });
  if (r.exitCode !== 0) return null;
  return r.stdout.trim().split(" ").slice(1);
}

/** `from` and `to` fetched deep enough for `enrichmentOnlySince` to read the commits between. */
async function fetchSpan(scratch: OriginScratch, to: string, refs: string[]): Promise<boolean> {
  for (const what of [to, ...refs]) {
    if (await fetchInto(scratch, what, MOVED_REF_FETCH_DEPTH + 1)) {
      const has = await git(scratch.dir, ["cat-file", "-e", `${to}^{commit}`], { ok: true });
      if (has.exitCode === 0) return true;
    }
  }
  return false;
}

/** What this run verified, said back before and after the Worker's own reading. */
interface Verified {
  number: number;
  branch: string;
  mergedHead: string;
  headMoved: boolean;
  parent: string;
  parentMoved: boolean;
  anchor: string;
  ledger: "untouched" | "scrub-lines" | "repull-scrub-lines";
  attestationExpected: boolean;
}

/** The evidence, read here before anything is sent (see the module comment). */
async function verifyLocally(
  ctx: ResumeContext,
  scratch: OriginScratch,
  row: RepullRow,
  pr: RepullPullRequest,
): Promise<Verified> {
  const c = PULL_REQUEST_COLUMNS[pr];
  const merge = row[c.mergeSha] as string;
  const number = row[c.number] as number;
  const branch = row[c.branch] as string;
  if (row.origin !== "administrator") {
    throw denied(
      "accept-automatic",
      `Re-pull #${row.id} was opened by the automatic path, whose merges the Worker sends with the trailers; its merge is not accepted without them.`,
    );
  }
  const live = await fetchPullRequest(ctx.token, ctx.datasetId, number, ctx.base);
  if (!live.ok) {
    throw refused(
      "github-unreadable",
      `Pull request #${number} could not be read on GitHub (${live.reason}); nothing was accepted.`,
    );
  }
  const p = live.value;
  if (
    p.baseRef !== "main" ||
    p.headRef !== branch ||
    !isOwnDatasetRepo(p.headRepo, row.dataset_id) ||
    !isOwnDatasetRepo(p.baseRepo, row.dataset_id)
  ) {
    throw denied(
      "pr-foreign",
      `Pull request #${number} is not ${branch} into main of ${NEMAR_DATASETS_ORG}/${row.dataset_id} itself.`,
    );
  }
  if (p.state !== "merged" || p.mergeCommitSha !== merge) {
    throw denied(
      "merge-mismatch",
      p.state === "merged"
        ? `GitHub says pull request #${number} merged as ${p.mergeCommitSha ? short(p.mergeCommitSha) : "no commit it names"}, not the recorded ${short(merge)}.`
        : `GitHub says pull request #${number} is not merged.`,
    );
  }

  // The merge commit and enough of what is beneath it, from origin.
  if (!(await fetchSpan(scratch, merge, ["refs/heads/main"]))) {
    throw refused(
      "merge-unreadable",
      `The merge commit ${short(merge)} could not be fetched from NEMAR's repository; nothing was accepted.`,
    );
  }
  const parents = await parentsOf(scratch, merge);
  if (parents === null) {
    throw refused("merge-unreadable", `The merge commit ${short(merge)} could not be read.`);
  }
  if (parents.length !== 1) {
    throw denied(
      "merge-not-squash",
      `The merge commit ${short(merge)} has ${parents.length} parents; a squash merge has one.`,
    );
  }
  const parent = parents[0] as string;
  const base = (pr === "n0" ? row.base_sha : row.patch_base_sha) as string;
  if (parent !== base) {
    const verdict = await enrichmentOnlySince(scratch.dir, base, parent);
    if (!verdict.ok) {
      if (verdict.code === "unreadable") {
        throw refused(
          "main-unreadable",
          `Whether the merge commit's parent ${short(parent)} moved from the record's base ${short(base)} by enrichment only could not be read; nothing was accepted.`,
        );
      }
      throw denied(
        "merge-parent-foreign",
        `The merge commit's parent ${short(parent)} is not the record's base ${short(base)} or a commit enrichment moved it to.`,
      );
    }
  }

  // The head it merged: the recorded one, or an enrichment-shaped descendant of it.
  const recordedHead = row[c.head] as string;
  if (p.headSha !== recordedHead) {
    const fetched = await fetchSpan(scratch, p.headSha, [
      releaseRefOf(row[c.version] as string),
      `refs/pull/${number}/head`,
    ]);
    const verdict = fetched
      ? await enrichmentOnlySince(scratch.dir, recordedHead, p.headSha)
      : ({ ok: false, code: "unreadable" } as const);
    if (!verdict.ok) {
      if (verdict.code === "unreadable") {
        throw refused(
          "branch-unreadable",
          `Whether the merged head ${short(p.headSha)} is the recorded head ${short(recordedHead)} moved by enrichment could not be read; nothing was accepted.`,
        );
      }
      throw denied(
        "merge-head-foreign",
        `Pull request #${number} merged at ${short(p.headSha)}, which is not the recorded head ${short(recordedHead)} or a commit enrichment moved it to.`,
      );
    }
  }

  // The tree, outside NEMAR's own paths: the release's comparison, made on the merge commit.
  const anchor = (pr === "n0" ? row.synth_sha : row.patch_gates_sha) as string | null;
  if (anchor === null) {
    throw denied(
      "tree-anchor-missing",
      `Re-pull #${row.id} records no gated head of its N.0.1 pull request, so the merged tree has nothing to be compared with.`,
    );
  }
  const tree = await tagTreeVersus(scratch, row, merge, pr);
  if (tree !== "same") {
    if (tree === "differs") {
      throw denied(
        "merge-tree-mismatch",
        `The merge commit's tree is not the re-pull's ${pr === "n0" ? "commit" : "gated N.0.1 head"} ${short(anchor)} outside .nemar/ and .github/.`,
      );
    }
    throw refused(
      "origin-unreadable",
      `The merge commit or the re-pull's commit could not be read from NEMAR's repository, so the trees were not compared; nothing was accepted.`,
    );
  }

  // The privacy ledger: what the merge did to it, as the fresh-clone proof will read it.
  const change = ledgerChange(await ledgerAt(scratch, parent), await ledgerAt(scratch, merge));
  if (change.kind === "other") {
    throw denied(
      "merge-ledger-foreign",
      "The merge commit changes the privacy ledger other than by appending a scrub's lines, which the fresh-clone proof refuses whatever is accepted.",
    );
  }
  let attestationExpected = false;
  if (change.kind === "scrub-append" && change.repull) {
    const changed = await git(
      scratch.dir,
      ["diff-tree", "-r", "--name-only", "-z", parent, merge],
      {
        ok: true,
      },
    );
    if (changed.exitCode !== 0) {
      throw refused("merge-unreadable", `The changes of ${short(merge)} could not be read.`);
    }
    attestationExpected = changed.stdout
      .split("\0")
      .filter(Boolean)
      .some((path) => path !== LEDGER_REPO_PATH);
  }
  return {
    number,
    branch,
    mergedHead: p.headSha,
    headMoved: p.headSha !== recordedHead,
    parent,
    parentMoved: parent !== base,
    anchor,
    ledger:
      change.kind === "none"
        ? "untouched"
        : change.kind === "scrub-append" && change.repull
          ? "repull-scrub-lines"
          : "scrub-lines",
    attestationExpected,
  };
}

/** The lines that say what was verified, in the words the administrator reads. */
function verifiedLines(row: RepullRow, pr: RepullPullRequest, v: Verified): string[] {
  const c = PULL_REQUEST_COLUMNS[pr];
  const recordedHead = row[c.head] as string;
  const base = (pr === "n0" ? row.base_sha : row.patch_base_sha) as string;
  return [
    "Verified before it was accepted (by this run, with your GitHub token and NEMAR's repository, then by the Worker with its own):",
    `  - it is GitHub's squash merge of pull request #${v.number} (${v.branch} into main of ${NEMAR_DATASETS_ORG}/${row.dataset_id}), merged at ${short(v.mergedHead)}, ${v.headMoved ? `which enrichment moved the recorded head ${short(recordedHead)} to` : "the recorded head"};`,
    `  - its one parent ${short(v.parent)} is ${v.parentMoved ? `the record's base ${short(base)} moved by enrichment only` : "the record's base"};`,
    `  - its tree is the re-pull's ${pr === "n0" ? "commit" : "gated N.0.1 head"} ${short(v.anchor)} outside .nemar/ and .github/;`,
    `  - ${
      v.ledger === "untouched"
        ? "it does not touch the privacy ledger"
        : v.ledger === "scrub-lines"
          ? "it appends only a scrub's lines to the privacy ledger"
          : "it appends the delta scrub's repull-scrubbed line to the privacy ledger and edits no line before it"
    };`,
    "  - the re-pull is one an administrator opened, and the Worker checked that it is yours.",
  ];
}

/** The acceptance's ledger line, read back from `main` on NEMAR's origin. */
async function assertLineOnMain(
  scratch: OriginScratch,
  merge: string,
  line: string,
): Promise<void> {
  if (!(await fetchInto(scratch, "refs/heads/main", 1))) {
    throw refused(
      "origin-unreadable",
      "NEMAR's main could not be fetched to read the acceptance's ledger line back; run resume again.",
    );
  }
  const text = await ledgerAt(scratch, "refs/remotes/origin/heads/main");
  if (
    text === null ||
    !acceptedMergesOf(text).includes(merge) ||
    !ledgerLines(text).includes(line)
  ) {
    throw refused(
      "attestation-unseen",
      `The Worker answered that the ledger line naming ${short(merge)} is on main, and NEMAR's repository does not show it yet; run resume again.`,
    );
  }
}

/** What the acceptance said, in a line or two. */
function acceptedLines(
  row: RepullRow,
  merge: string,
  acceptance: RepullMergeAcceptance,
  line: string | null,
): string[] {
  const out = [`Accepted on your reason: ${acceptance.reason}`];
  out.push(
    line === null
      ? `NEMAR recorded the acceptance on re-pull #${row.id}. The merge appends no repull-scrubbed line beside other files, so the privacy ledger's fresh-clone proof needs no line for it, and none was written.`
      : `NEMAR recorded the acceptance on re-pull #${row.id} and appended to ${LEDGER_REPO_PATH} on main the line that names ${short(merge)}${acceptance.attestation_sha ? ` (commit ${short(acceptance.attestation_sha)})` : ""}, so the privacy ledger's fresh-clone proof reads the merge as the re-pull's own.`,
  );
  return out;
}

/**
 * The merge commit carries no trailers as git reads them (`problem`): go on when an acceptance is
 * recorded, accept it now when the administrator gave a reason, and otherwise refuse. Returns
 * normally only when the release may go on.
 */
export async function acceptOrRefuseMerge(
  ctx: ResumeContext,
  scratch: OriginScratch,
  row: RepullRow,
  pr: RepullPullRequest,
  problem: string,
  refuseUnaccepted: (message: string) => Promise<ExecuteRefused>,
): Promise<void> {
  const merge = row[PULL_REQUEST_COLUMNS[pr].mergeSha] as string;
  const out = ctx.opts.out;

  // An acceptance recorded by an earlier run: the Worker replays it, writing its line if needed.
  let replay: Awaited<ReturnType<typeof acceptRepullMergeTrailers>> | null = null;
  try {
    replay = await acceptRepullMergeTrailers(row.id, { pr, merge_sha: merge });
  } catch (err) {
    if (repullErrorCode(err) !== "merge-trailers-not-accepted") {
      throw apiRefused(err, "Whether the merge was accepted could not be read");
    }
  }
  if (replay) {
    if (replay.attestation_line !== null) {
      await assertLineOnMain(scratch, merge, replay.attestation_line);
    }
    out(
      `The merge commit ${short(merge)} on main carries no trailers (${problem}); administrator #${replay.acceptance.accepted_by} accepted it at ${replay.acceptance.accepted_at}: ${replay.acceptance.reason}${replay.attestation_line ? ". Its ledger line is on main." : ""}`,
    );
    if (ctx.opts.acceptMergeTrailers) {
      out("It was accepted once already; --accept-merge-trailers changes nothing now.");
    }
    return;
  }

  const reason = ctx.opts.acceptMergeTrailers;
  if (!reason) {
    throw await refuseUnaccepted(
      `The merge commit ${short(merge)} on main does not end with the re-pull commit's two trailers (${problem}), so the privacy ledger's fresh-clone proof would not read it as the re-pull's commit. The record stays ${row.status}. If it was merged outside NEMAR's gate (GitHub's merge button, say), read what it holds, then run nemar admin repull resume ${ctx.datasetId} --accept-merge-trailers "<reason>", which accepts it only once it is shown to be this re-pull's own squash merge.`,
    );
  }

  out(
    `The merge commit ${short(merge)} on main does not end with the re-pull commit's two trailers (${problem}).`,
  );
  const verified = await verifyLocally(ctx, scratch, row, pr);
  let answer: Awaited<ReturnType<typeof acceptRepullMergeTrailers>>;
  try {
    answer = await acceptRepullMergeTrailers(row.id, { pr, merge_sha: merge, reason });
  } catch (err) {
    const code = repullErrorCode(err);
    const failure = apiRefused(err, "The Worker did not accept the merge");
    // A refusal on the evidence is final; an unread GitHub, or a line not yet written, is not.
    if (code !== undefined && !["github-unreadable", "attestation-unwritten"].includes(code)) {
      failure.resumable = false;
    }
    throw failure;
  }
  for (const line of verifiedLines(row, pr, verified)) out(line);
  const evidence: RepullAcceptanceEvidence | null = answer.evidence;
  if (evidence && evidence.merged_head !== verified.mergedHead) {
    out(
      `The Worker read the merged head as ${short(evidence.merged_head)}, where this run read ${short(verified.mergedHead)}.`,
    );
  }
  if ((answer.attestation_line !== null) !== verified.attestationExpected) {
    out(
      answer.attestation_line !== null
        ? "The Worker found that the proof needs a ledger line for this merge, which this run did not; its reading is the one recorded."
        : "This run expected the proof to need a ledger line for this merge, and the Worker did not; its reading is the one recorded.",
    );
  }
  if (answer.attestation_line !== null) {
    await assertLineOnMain(scratch, merge, answer.attestation_line);
  }
  for (const line of acceptedLines(row, merge, answer.acceptance, answer.attestation_line)) {
    out(line);
  }
}
