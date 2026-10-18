/**
 * Which datasets the pull-request review applies to, and so which repositories carry the ruleset
 * that requires it (ADR 0107).
 *
 * The Worker decides whether to review a pull request in SQL: `REVIEWABLE_DATASET_PREDICATE` in
 * `services/pr-review.ts`, asked of one dataset by `reviewableDataset`. The tooling that puts the
 * ruleset on repositories (the admin routes, publication, visibility, the drift report) reads many
 * rows at once and has to give the SAME answer without a query for each, so {@link isReviewableRow}
 * is that answer for a row in hand. Two statements of one rule can drift, which is why
 * `test/pr-review-eligibility.test.ts` runs both over every combination of the four columns and
 * fails when they disagree. A change to the rule is a change to both.
 *
 * Nothing here talks to GitHub. The types that name what to do about a repository live with the
 * ruleset (`services/github/branch-protection.ts`); this module only decides which one a dataset
 * calls for.
 */

import type { Bindings } from "../types/bindings.js";
import { RESERVED_FIXTURE_FLOOR, isReservedFixtureId } from "./datasetId.js";
import type { ReviewIntent } from "./github/branch-protection.js";

/** The four `datasets` columns the review's rule reads. */
export interface ReviewableRow {
  status: string | null;
  visibility: string | null;
  anonymous: number | null;
  first_published_at: string | null;
}

/**
 * The columns {@link ReviewableRow} is read from, for a `SELECT`. One list, so a query that feeds
 * {@link isReviewableRow} cannot leave one out.
 */
export const REVIEWABLE_ROW_COLUMNS = "status, visibility, anonymous, first_published_at";

/** The first condition a dataset fails, in this order. */
export type NotReviewableReason = "inactive" | "private" | "anonymous" | "unpublished";

/**
 * Why a dataset is not reviewed, or null when it is: a live (active), public, named (not
 * anonymous), first-published dataset is reviewed, and nothing else is. Written as the SQL reads:
 * `anonymous = 0` is not true of a NULL, so a missing value is not reviewable either.
 */
export function notReviewableReason(row: ReviewableRow): NotReviewableReason | null {
  if (row.status !== "active") return "inactive";
  if (row.visibility !== "public") return "private";
  if (row.anonymous !== 0) return "anonymous";
  if (row.first_published_at === null || row.first_published_at === undefined) return "unpublished";
  return null;
}

/** Whether the Worker reviews pull requests to this dataset: the row-in-hand form of the SQL rule. */
export function isReviewableRow(row: ReviewableRow): boolean {
  return notReviewableReason(row) === null;
}

/** Whether the review is switched on in this environment. Exactly "1", as the Worker reads it. */
export function isReviewEnabled(env: Pick<Bindings, "PR_REVIEW_ENABLED">): boolean {
  return env.PR_REVIEW_ENABLED === "1";
}

/**
 * The dataset ids the ruleset tooling never touches: the top 100 ids of the `nm` prefix
 * (nm099900 to nm099999), which the fixture rule reserves for standing test fixtures. They are the
 * end-to-end dataset (nm099999), the standing anonymous deposit (nm099998) and the fixtures that
 * follow downward from them. They are named by the band and not as a list, because a list would
 * have to be edited for each new fixture and a fixture left off it would be changed by a batch.
 *
 * The `xx` band is not excluded: its exemplar fleet (xx099900 and up) is the staging copy a
 * ruleset is first tried on, and it belongs to the staging Worker alone.
 */
export function isReviewRulesetFixture(datasetId: string): boolean {
  return datasetId.startsWith("nm") && isReservedFixtureId(datasetId);
}

/**
 * {@link isReviewRulesetFixture} as a condition on `dataset_id` for a `WHERE`: true for a row
 * OUTSIDE the band. `sql` has one placeholder, and `bind` is the value for it. It reads the same
 * floor the function does, so the two are one rule, and a test checks that they agree. The bound
 * value is a constant; nothing a caller sends reaches the SQL.
 */
export const OUTSIDE_FIXTURE_BAND = {
  sql: "NOT (substr(dataset_id, 1, 2) = 'nm' AND CAST(substr(dataset_id, 3) AS INTEGER) >= ?)",
  bind: RESERVED_FIXTURE_FLOOR,
} as const;

/**
 * What a dataset calls for, as the lifecycle code (publishing, a visibility change, `enforce`)
 * should ask of its repository: take the ruleset off a dataset that is not reviewed, put it on one
 * that is, and, while the review is off, leave a reviewed dataset's ruleset alone (`undefined`).
 * Requiring a check that nothing is posting would block every merge, so the requirement is never
 * put on while the review is off; lifting it never waits for anything.
 *
 * A standing test fixture ({@link isReviewRulesetFixture}) calls for nothing, whatever its row
 * says: the tooling does not touch its repository's rulesets in either direction.
 */
export function reviewIntentOf(
  datasetId: string,
  row: ReviewableRow,
  reviewEnabled: boolean,
): ReviewIntent | undefined {
  if (isReviewRulesetFixture(datasetId)) return undefined;
  if (!isReviewableRow(row)) return "remove";
  return reviewEnabled ? "require" : undefined;
}

/**
 * {@link reviewIntentOf} for a dataset, read from the catalog now. A dataset the catalog does not
 * hold has no answer (`undefined`: touch nothing), and a failed read throws for the caller to
 * handle, as the lifecycle code does for the rest of its repository work.
 */
export async function readReviewIntent(
  env: Pick<Bindings, "DB" | "PR_REVIEW_ENABLED">,
  datasetId: string,
): Promise<ReviewIntent | undefined> {
  const row = await env.DB.prepare(
    `SELECT ${REVIEWABLE_ROW_COLUMNS} FROM datasets WHERE dataset_id = ?`,
  )
    .bind(datasetId)
    .first<ReviewableRow>();
  return row ? reviewIntentOf(datasetId, row, isReviewEnabled(env)) : undefined;
}
