/**
 * Whether the dataset pull-request review is waived for a pull request at a head (ADR 0116): it is
 * the pull request of an open upstream re-pull record, at the head NEMAR's own tools recorded for
 * it.
 *
 * A re-pull's N.0.0 is upstream's snapshot, and upstream is its author and wins every conflict
 * (ADR 0111, decision 1); N.0.1 replays NEMAR's own corrections. The ADR 0107 review protects a
 * dataset from a contributor's change, so neither pull request has a contributor for it to judge.
 * The waiver is decided from NEMAR's record and from GitHub's own facts about the pull request,
 * never from a branch name or anything the pull request says: the record's pull request number,
 * its release branch and the head it recorded are written only by NEMAR's tools (an
 * administrator's `nemar admin repull` run, or the automatic path's own run), and the head moves
 * on the record only after `src/lib/repull/execute/head.ts` (`enrichmentOnlySince`, through
 * `acceptsHead`) has found that nothing but enrichment moved it. So the Worker, which cannot run
 * git, reuses that predicate's verdict by reading the record, and never decides "enrichment only"
 * a second time.
 *
 * A pull request is waived exactly when, in this order:
 *  - the record is of the same dataset;
 *  - the pull request is one of the record's two (N.0.0's by `pr_number`, N.0.1's by
 *    `patch_pr_number`);
 *  - the record is at a status in which that pull request is open and its head is the record's
 *    (`pr_open` or `gates_clear` for N.0.0, `patch_synthesized` or `patch_gates_clear` for N.0.1);
 *    any other status, terminal ones included, is not;
 *  - the pull request is from and into the dataset's own repository (a fork's is never waived);
 *  - its head branch, where the caller read it, is the record's release branch, and its base, where
 *    the caller read it, is `main`;
 *  - and its head is the head the record holds for it.
 * A caller passes what it read and nothing it did not: `headRef` and `baseRef` are null only where
 * nothing was read, which is the review's publisher asking first, on the stored row alone, whether
 * any record could waive it before it spends a read of GitHub on one; a waiver it publishes is
 * decided on GitHub's facts as well. A caller that read GitHub and found no branch passes the
 * empty string, which no record's branch is, so unknown is never a waiver.
 *
 * Pure: it reads nothing and writes nothing, so the Worker's review, its queue, its machine-clean
 * rule and the tests all ask the same function.
 */

import {
  PULL_REQUEST_COLUMNS,
  REPULL_PULL_REQUESTS,
  type RepullOrigin,
  type RepullPullRequest,
  type RepullRow,
  type RepullStatus,
  SHA_RE,
} from "./repull-state.js";

/** The statuses in which each of the record's pull requests is open at the head the record holds. */
export const WAIVER_STATUSES: Readonly<Record<RepullPullRequest, readonly RepullStatus[]>> = {
  n0: ["pr_open", "gates_clear"],
  n1: ["patch_synthesized", "patch_gates_clear"],
};

/** Every status in {@link WAIVER_STATUSES}, for a query that reads only the records that can waive. */
export const WAIVER_ANY_STATUS: readonly RepullStatus[] = [
  ...WAIVER_STATUSES.n0,
  ...WAIVER_STATUSES.n1,
];

/** The columns of a record the rule reads. */
export type WaiverRecord = Pick<
  RepullRow,
  | "id"
  | "dataset_id"
  | "status"
  | "origin"
  | "branch"
  | "pr_number"
  | "head_sha"
  | "patch_branch"
  | "patch_pr_number"
  | "patch_head_sha"
>;

/** What a caller knows of the pull request, from GitHub or from the stored review of it. */
export interface WaiverSubject {
  datasetId: string;
  prNumber: number;
  headSha: string;
  /** The head and base are the dataset's own repository (`nemarDatasets/<id>`), not a fork. */
  ownRepository: boolean;
  /**
   * The head branch GitHub names (the empty string when it names none), or null when this caller
   * did not read GitHub at all (see the module comment).
   */
  headRef: string | null;
  /** The base branch GitHub names, or null when this caller did not read GitHub at all. */
  baseRef: string | null;
}

/** Why a pull request is not waived, in the rule's order. Fixed words, safe to log. */
export const WAIVER_MISSES = [
  "other-dataset",
  "other-pull-request",
  "not-open",
  "fork",
  "other-branch",
  "other-base",
  "head-not-recorded",
] as const;
export type WaiverMiss = (typeof WAIVER_MISSES)[number];

export type WaiverVerdict =
  | { waived: true; repullId: number; pr: RepullPullRequest; origin: RepullOrigin }
  | { waived: false; why: WaiverMiss };

const miss = (why: WaiverMiss): WaiverVerdict => ({ waived: false, why });

/** The rule (see the module comment), for one record: the first condition that fails is the answer. */
export function repullReviewWaiver(record: WaiverRecord, s: WaiverSubject): WaiverVerdict {
  if (record.dataset_id !== s.datasetId) return miss("other-dataset");
  const pr =
    REPULL_PULL_REQUESTS.find((p) => record[PULL_REQUEST_COLUMNS[p].number] === s.prNumber) ?? null;
  if (pr === null) return miss("other-pull-request");
  const cols = PULL_REQUEST_COLUMNS[pr];
  if (!WAIVER_STATUSES[pr].includes(record.status)) return miss("not-open");
  if (s.ownRepository !== true) return miss("fork");
  const branch = record[cols.branch];
  if (s.headRef !== null && (typeof branch !== "string" || s.headRef !== branch)) {
    return miss("other-branch");
  }
  if (s.baseRef !== null && s.baseRef !== "main") return miss("other-base");
  const head = record[cols.head];
  if (typeof head !== "string" || !SHA_RE.test(head) || head !== s.headSha) {
    return miss("head-not-recorded");
  }
  return { waived: true, repullId: record.id, pr, origin: record.origin };
}

/**
 * The rule over every record a caller read for the dataset (at most one is open, migration 0105's
 * partial unique index): the waiver of the first record that waives, else the miss of the last one
 * read, or `other-pull-request` when there is none.
 */
export function repullReviewWaiverOf(
  records: readonly WaiverRecord[],
  s: WaiverSubject,
): WaiverVerdict {
  let last: WaiverVerdict = miss("other-pull-request");
  for (const record of records) {
    const verdict = repullReviewWaiver(record, s);
    if (verdict.waived) return verdict;
    last = verdict;
  }
  return last;
}
