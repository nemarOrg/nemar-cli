/**
 * The upstream re-pull's review waiver, as the Worker reads it (ADR 0116): the open re-pull records
 * of a dataset that could waive a pull request, read from `upstream_repulls` (migration 0105) and
 * judged by the one rule in `shared/repull-review-waiver.ts`.
 *
 * Every reader of the review asks here, so the review's intake, its publisher, the administrator's
 * queue and detail view, and the machine-clean facts cannot disagree about which pull request is
 * waived: the rule is pure and the records are read again on every call, never kept, so a record
 * that moves on (a head recorded, a merge, an abandonment) is seen by the next read.
 *
 * A database failure throws, like every read of the review's intake and of the queue; the one
 * caller for which not knowing must not stop the work, the review's publisher, catches it and
 * treats the pull request as not waived, which keeps the review's own answer: unknown is never a
 * waiver (ADR 0053).
 */

import {
  WAIVER_ANY_STATUS,
  type WaiverRecord,
  type WaiverSubject,
  type WaiverVerdict,
  repullReviewWaiverOf,
} from "../../../shared/repull-review-waiver.js";

const quoted = WAIVER_ANY_STATUS.map((s) => `'${s}'`).join(", ");

const WAIVER_COLUMNS =
  "id, dataset_id, status, origin, branch, pr_number, head_sha, patch_branch, patch_pr_number, patch_head_sha";

/**
 * The records that could waive one pull request: of that dataset, naming it as N.0.0's or N.0.1's,
 * at a status in which a pull request can be waived. Binds: the dataset, the number, the number.
 */
export const REPULL_WAIVER_RECORDS_SQL = `SELECT ${WAIVER_COLUMNS} FROM upstream_repulls
  WHERE dataset_id = ? AND (pr_number = ? OR patch_pr_number = ?) AND status IN (${quoted})`;

/** The records of many datasets that could waive any of their pull requests, for a list. */
const WAIVER_RECORDS_OF_SQL = (n: number) => `SELECT ${WAIVER_COLUMNS} FROM upstream_repulls
  WHERE status IN (${quoted}) AND dataset_id IN (${Array.from({ length: n }, () => "?").join(",")})`;

/** Datasets per `IN` list, well under D1's bound on parameters. */
const IN_CHUNK = 50;

/** The records that could waive pull request `prNumber` of `datasetId`. Throws on a database failure. */
export async function readPullRequestWaiverRecords(
  db: D1Database,
  datasetId: string,
  prNumber: number,
): Promise<WaiverRecord[]> {
  const { results } = await db
    .prepare(REPULL_WAIVER_RECORDS_SQL)
    .bind(datasetId, prNumber, prNumber)
    .all<WaiverRecord>();
  return results ?? [];
}

/** Whether the review is waived for `s`, from the records read now. Throws on a database failure. */
export async function readRepullWaiver(db: D1Database, s: WaiverSubject): Promise<WaiverVerdict> {
  return repullReviewWaiverOf(await readPullRequestWaiverRecords(db, s.datasetId, s.prNumber), s);
}

/**
 * The records that could waive a pull request, by dataset, for every dataset in `datasetIds`, so a
 * list of many pull requests reads them in a few statements. Throws on a database failure.
 */
export async function readWaiverRecords(
  db: D1Database,
  datasetIds: readonly string[],
): Promise<Map<string, WaiverRecord[]>> {
  const out = new Map<string, WaiverRecord[]>();
  for (let i = 0; i < datasetIds.length; i += IN_CHUNK) {
    const chunk = datasetIds.slice(i, i + IN_CHUNK);
    const { results } = await db
      .prepare(WAIVER_RECORDS_OF_SQL(chunk.length))
      .bind(...chunk)
      .all<WaiverRecord>();
    for (const r of results ?? []) {
      const list = out.get(r.dataset_id) ?? [];
      list.push(r);
      out.set(r.dataset_id, list);
    }
  }
  return out;
}
