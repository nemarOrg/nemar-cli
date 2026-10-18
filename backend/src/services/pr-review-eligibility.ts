/**
 * Which datasets the pull-request review applies to, and so which repositories carry the ruleset
 * that requires it (ADR 0107).
 *
 * The Worker decides whether to review a pull request in SQL: `REVIEWABLE_DATASET_PREDICATE` in
 * `services/pr-review.ts`, asked of one dataset by `reviewableDataset`. The tooling that puts the
 * ruleset on repositories (the admin routes, publication, visibility, the drift report) reads many
 * rows at once and has to give the SAME answer without a query for each, so {@link isReviewableRow}
 * is that answer for a row in hand. Two statements of one rule can drift, which is why
 * `backend/test/pr-review-eligibility.test.ts` runs both over every combination of the four columns and
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
 * Whether the automatic paths (publishing a dataset, a visibility change, the enforce routes) may
 * put the review ruleset ON a repository. Exactly "1"; unset is off. It gates the requirement and
 * nothing else: taking the ruleset off a repository whose dataset is not reviewed is never held
 * back by it ({@link automaticReviewIntent}), because a dataset made private while the switch is
 * off would otherwise keep a ruleset that nothing can satisfy.
 *
 * It is a switch of its own, apart from {@link isReviewEnabled}, because the review runs from the
 * day the Worker is deployed and the requirement is the owner's step: the owner turns this on when
 * the fleet step of the rollout starts, after the canary and the calibration gate, and it is never
 * on before. The explicit tools (the review-ruleset routes and `nemar admin fleet require-review`)
 * do not read it.
 */
export function isAutoRequireEnabled(env: Pick<Bindings, "PR_REVIEW_AUTO_REQUIRE">): boolean {
  return env.PR_REVIEW_AUTO_REQUIRE === "1";
}

/**
 * Whether the requirement may be put on by anything that acts on its own, or measured against by
 * the drift report: the review itself is on (so something posts the check) AND the owner's switch
 * is on. The one definition of "the requirement is the target", so the paths that write and the
 * report that reads cannot disagree about it.
 */
export function isRequirementTarget(
  env: Pick<Bindings, "PR_REVIEW_ENABLED" | "PR_REVIEW_AUTO_REQUIRE">,
): boolean {
  return isReviewEnabled(env) && isAutoRequireEnabled(env);
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
 * What a dataset's row calls for: take the ruleset off a dataset that is not reviewed, put it on
 * one that is, and, while `requirementOn` is false, leave a reviewed dataset's ruleset alone
 * (`undefined`). Requiring a check that nothing is posting would block every merge, so the
 * requirement is never put on while it is not the target ({@link isRequirementTarget}); lifting it
 * never waits for anything.
 *
 * This is the row's answer and nothing more. The drift report asks it directly, with
 * {@link isRequirementTarget} as `requirementOn`. The paths that WRITE on their own, publishing, a
 * visibility change and `enforce`, ask {@link automaticReviewIntent}, which passes the same.
 *
 * A standing test fixture ({@link isReviewRulesetFixture}) calls for nothing, whatever its row
 * says: the tooling does not touch its repository's rulesets in either direction.
 */
export function reviewIntentOf(
  datasetId: string,
  row: ReviewableRow,
  requirementOn: boolean,
): ReviewIntent | undefined {
  if (isReviewRulesetFixture(datasetId)) return undefined;
  if (!isReviewableRow(row)) return "remove";
  return requirementOn ? "require" : undefined;
}

/**
 * What the AUTOMATIC paths ask of a repository, which are publishing a dataset, a visibility change
 * and the enforce routes: {@link reviewIntentOf} with the requirement on only while
 * {@link isRequirementTarget}. So the switch gates the ADDITION and nothing else. Until the owner
 * has started the fleet step a reviewed dataset gets `undefined` (its ruleset is left exactly as it
 * is, and the caller makes no ruleset call for it), but a dataset that is not reviewed still gets
 * `remove`: a dataset made private while the switch is off must not keep a ruleset that nothing
 * will satisfy. This is the one place the owner's switch is read for a path that writes, so a path
 * that asks here cannot require the review before the owner has started the fleet step.
 */
export function automaticReviewIntent(
  env: Pick<Bindings, "PR_REVIEW_ENABLED" | "PR_REVIEW_AUTO_REQUIRE">,
  datasetId: string,
  row: ReviewableRow,
): ReviewIntent | undefined {
  return reviewIntentOf(datasetId, row, isRequirementTarget(env));
}

/**
 * {@link automaticReviewIntent} for a dataset, read from the catalog now. A dataset the catalog
 * does not hold has no answer (`undefined`: touch nothing), and neither has one whose row could not
 * be read. The read is made while the lifecycle code is bringing a repository to its spec, with the
 * branch ruleset and the collaborators still to do, so a failure is logged and leaves the review
 * ruleset as it is instead of costing the rest of that work. The drift report shows a repository
 * left out of step. The row is read whether or not the switch is on, because a dataset that is not
 * reviewed has its ruleset taken off either way, and so that the decision stays in the one
 * function.
 */
export async function readReviewIntent(
  env: Pick<Bindings, "DB" | "PR_REVIEW_ENABLED" | "PR_REVIEW_AUTO_REQUIRE">,
  datasetId: string,
): Promise<ReviewIntent | undefined> {
  try {
    const row = await env.DB.prepare(
      `SELECT ${REVIEWABLE_ROW_COLUMNS} FROM datasets WHERE dataset_id = ?`,
    )
      .bind(datasetId)
      .first<ReviewableRow>();
    return row ? automaticReviewIntent(env, datasetId, row) : undefined;
  } catch (e) {
    console.error(
      `[review-ruleset] could not read ${datasetId} to decide its review ruleset; leaving it as it is:`,
      e,
    );
    return undefined;
  }
}
