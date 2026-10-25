/**
 * Whether a branch moved only by what NEMAR's enrichment writes (ADR 0111, decision 2; epic #1046
 * phase 6). Enrichment runs on every push to `main` and to `release/*` and commits back to the same
 * ref, in three shapes: `.nemar/` files and the `.nemar/` line in `.bidsignore` (the enrichment
 * workflow, `run-enrichment.yml` in `nemarDatasets/.github`, and the backend's `enrich-dataset.ts`
 * that commits them), and a placeholder `participants.tsv` for a tree that has none (the backend's
 * `ensureParticipantsTsv`, in `participants-tsv.ts`, whose rule is `shared/standard-edits/
 * participants.ts`). The workflow's own `.bidsignore` edit is not guaranteed byte-identical to
 * `withBidsignoreEntry`; a mismatch is read as a foreign commit, which fails safe (the re-pull
 * stops and an administrator looks). A head that moved by those commits and nothing else is still
 * the re-pull's; any other commit is not.
 *
 * Every commit from `from` to `to` must be a single-parent commit whose changes are each one of:
 *  - a regular file added or changed under `.nemar/`, other than the privacy ledger
 *    (`.nemar/corrections.jsonl`), whose new line would change what the plan refuses;
 *  - `.bidsignore` changed to exactly what `withBidsignoreEntry` makes of it with `.nemar/`;
 *  - a root `participants.tsv` added that is, byte for byte, the placeholder of that commit's
 *    subjects (`buildPlaceholderParticipantsTsv(enumerateBidsSubjects(tree))`).
 * The commits must already be in the working clone (the caller fetches the ref).
 */

import {
  NEMAR_BIDSIGNORE_ENTRY,
  withBidsignoreEntry,
} from "../../../../shared/standard-edits/bidsignore.js";
import {
  buildPlaceholderParticipantsTsv,
  enumerateBidsSubjects,
} from "../../../../shared/standard-edits/participants.js";
import { git } from "./workdir.js";

export type HeadVerdict =
  | { ok: true; head: string; commits: number }
  | { ok: false; code: "head-foreign" | "unreadable"; detail: string };

/** What a caller learns of a head: accepted, someone else's, or not readable from this clone. */
export type HeadCheck = "ok" | "foreign" | "unreadable";

/** More commits than enrichment ever makes between two of our own writes is not enrichment. */
export const ENRICHMENT_MAX_COMMITS = 20;

/** The depth a fetch of a moved ref needs for {@link enrichmentOnlySince} to reach `from`. */
export const MOVED_REF_FETCH_DEPTH = ENRICHMENT_MAX_COMMITS + 2;

const LEDGER = ".nemar/corrections.jsonl";

interface Change {
  srcMode: string;
  dstMode: string;
  srcOid: string;
  dstOid: string;
  status: string;
  path: string;
}

/** `git diff-tree -r -z --raw` of one commit against its parent. */
async function changesOf(work: string, parent: string, commit: string): Promise<Change[] | null> {
  const r = await git(work, ["diff-tree", "-r", "-z", "--no-commit-id", "--raw", parent, commit], {
    ok: true,
  });
  if (r.exitCode !== 0) return null;
  const fields = r.stdout.split("\0");
  const out: Change[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const m = /^:([0-7]{6}) ([0-7]{6}) ([0-9a-f]{40}) ([0-9a-f]{40}) ([A-Z])\d*$/.exec(
      fields[i] as string,
    );
    if (!m) return null;
    out.push({
      srcMode: m[1] as string,
      dstMode: m[2] as string,
      srcOid: m[3] as string,
      dstOid: m[4] as string,
      status: m[5] as string,
      path: fields[i + 1] as string,
    });
  }
  return out;
}

async function blob(work: string, oid: string): Promise<string | null> {
  const r = await git(work, ["cat-file", "blob", oid], { ok: true });
  return r.exitCode === 0 ? r.stdout : null;
}

/** Whether one change is one of the three shapes enrichment writes. */
async function isEnrichment(work: string, commit: string, c: Change): Promise<boolean> {
  const regular = c.dstMode === "100644";
  if (c.path.startsWith(".nemar/") && c.path !== LEDGER) {
    return regular && (c.status === "A" || c.status === "M");
  }
  if (c.path === ".bidsignore") {
    if (!regular || (c.status !== "A" && c.status !== "M")) return false;
    const before = c.status === "A" ? "" : await blob(work, c.srcOid);
    const after = await blob(work, c.dstOid);
    if (before === null || after === null) return false;
    const want = withBidsignoreEntry(before, NEMAR_BIDSIGNORE_ENTRY);
    return want.changed && after === want.content;
  }
  if (c.path === "participants.tsv") {
    if (!regular || c.status !== "A") return false;
    const listed = await git(work, ["ls-tree", "-r", "-z", "--name-only", commit], { ok: true });
    if (listed.exitCode !== 0) return false;
    const subjects = enumerateBidsSubjects(
      listed.stdout
        .split("\0")
        .filter(Boolean)
        .map((path) => ({ path })),
    );
    if (subjects.length === 0) return false;
    return (await blob(work, c.dstOid)) === buildPlaceholderParticipantsTsv(subjects);
  }
  return false;
}

/**
 * Ok when `to` is `from`, or descends from it by enrichment-shaped commits only (see the module
 * comment); `head-foreign` when it does not; `unreadable` when the clone cannot tell.
 */
export async function enrichmentOnlySince(
  work: string,
  from: string,
  to: string,
): Promise<HeadVerdict> {
  if (from === to) return { ok: true, head: to, commits: 0 };
  const ancestor = await git(work, ["merge-base", "--is-ancestor", from, to], { ok: true });
  if (ancestor.exitCode === 1) {
    return { ok: false, code: "head-foreign", detail: "not a descendant of the recorded commit" };
  }
  if (ancestor.exitCode !== 0) {
    return { ok: false, code: "unreadable", detail: "the commits are not in the working clone" };
  }
  const listed = await git(work, ["rev-list", "--reverse", "--parents", `${from}..${to}`], {
    ok: true,
  });
  if (listed.exitCode !== 0) {
    return { ok: false, code: "unreadable", detail: "the commits could not be listed" };
  }
  const commits = listed.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split(" "));
  if (commits.length > ENRICHMENT_MAX_COMMITS) {
    return { ok: false, code: "head-foreign", detail: `${commits.length} commits` };
  }
  for (const [commit, ...parents] of commits) {
    if (parents.length !== 1) {
      return { ok: false, code: "head-foreign", detail: "a merge commit" };
    }
    const changes = await changesOf(work, parents[0] as string, commit as string);
    if (changes === null) {
      return { ok: false, code: "unreadable", detail: "a commit's changes could not be read" };
    }
    for (const c of changes) {
      if (!(await isEnrichment(work, commit as string, c))) {
        return {
          ok: false,
          code: "head-foreign",
          detail: "a commit changes a path enrichment does not write",
        };
      }
    }
  }
  return { ok: true, head: to, commits: commits.length };
}
