/**
 * Start the review of a pull request that is already open (ADR 0092, ADR 0093).
 *
 * The Worker reviews on events, and a pull request that was open before the review was switched
 * on produced none. An administrator asks for one by dataset and number. Nothing about the pull
 * request comes from the caller: the Worker reads it from GitHub with the datasets token, shapes it
 * as the `pull_request` delivery it would have been, and hands it to the one gate every delivery
 * goes through (`handlePullRequestEvent`). So the flag, the "public, named, first-published"
 * test, the per-commit dedupe and the contributor pause all apply exactly as they would to a
 * delivery, and so does the exemption: a pull request opened by an owner or administrator is not
 * reviewed and nothing is started for it (ADR 0107), unless a review has already touched its
 * current commit, which is then handled like anyone's. It gets one check, which the naming rule
 * decides, and the answer names which: `exempt_author` with a `skipped` check when the rule finds
 * nothing, `exempt_naming_waived` with a `skipped` check that says so when an administrator waived
 * the rule for this commit, `naming_rule` with a failed check when the title or the new dataset
 * name breaks it, and `naming_unchecked` with a check that needs a person when the dataset's name
 * could not be read (whatever the title says). One thing differs, and it is the administrator's choice made by name: a
 * commit whose review ended without a verdict (declined, errored, never reported) is started again,
 * and with `redo` so is one whose review has a result (a second run, which costs model calls). A
 * review that is running is never started again, a redo included: the answer is `review_running`.
 *
 * Nothing here approves, merges or comments on a pull request itself; the review's own check and
 * comment are published by the same code that publishes them for a delivery.
 *
 * A bot's pull request is not reviewed through the administrator's start either (`bot_author`).
 * The one bot pull request that is reviewed, the NEMAR App's automatic re-pull pull request, is
 * started by the Worker itself, from the re-pull record, through
 * {@link startRepullPullRequestReview} (ADR 0111 narrows ADR 0092's "not bots" for that class).
 */

import type { StartReviewResponse } from "../../../shared/contract/pr-review-admin.js";
import { sanitizeNote } from "../../../shared/pr-review.js";
import type { RepullRow } from "../../../shared/repull-state.js";
import { auditLogStatement } from "../db/audit-log.js";
import type { Bindings } from "../types/bindings.js";
import { getDatasetsTokenWithRefresher } from "./github-auth.js";
import {
  NEMAR_APP_BOT_LOGIN,
  NEMAR_APP_BOT_TYPE,
  NEMAR_APP_BOT_USER_ID,
} from "./github/branch-protection.js";
import { GITHUB_API, ORG_NAME, ghHeaders } from "./github/shared.js";
import { githubFetchWithRetry } from "./github/transport.js";
import { QueueError, environmentName, ownedHere } from "./pr-review-queue.js";
import {
  ExemptCheckNotPublished,
  type PrReviewResponse,
  handlePullRequestEvent,
  reviewableDataset,
} from "./pr-review.js";
import { autoRepullEnabled, isExactProduction } from "./repull-switches.js";

/** A GitHub login's shape; anything else is not echoed back. */
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const READ_TIMEOUT_MS = 10_000;
const MAX_THROTTLE_MS = 15_000;

/** A fetch that ran out of time rather than failing. */
function isTimeout(err: unknown): boolean {
  return err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
}

function said(err: unknown): string {
  return sanitizeNote(err instanceof Error ? err.message : String(err), 160) || "no reason given";
}

/**
 * GitHub's REST record of one pull request, or why there is none (a {@link QueueError}). Shared
 * with the naming rule's waiver, which acts on the same record.
 */
export async function readPullRequest(
  env: Bindings,
  datasetId: string,
  prNumber: number,
  /** What did not happen when GitHub cannot be read, for the administrator's sentence. */
  consequence = "nothing was started",
): Promise<Record<string, unknown>> {
  const where = `${datasetId}#${prNumber}`;
  let res: Response;
  try {
    const { token, refresh } = await getDatasetsTokenWithRefresher(env);
    res = await githubFetchWithRetry(
      `${GITHUB_API()}/repos/${ORG_NAME}/${datasetId}/pulls/${prNumber}`,
      { headers: ghHeaders(token), signal: AbortSignal.timeout(READ_TIMEOUT_MS) },
      {
        kind: "interactive",
        maxAttempts: 2,
        maxThrottleMs: MAX_THROTTLE_MS,
        refreshTokenOn401: refresh,
      },
    );
  } catch (err) {
    console.error(`[pr-review-start] ${where}: GitHub read failed (${said(err)})`);
    if (isTimeout(err)) {
      throw new QueueError(
        502,
        "github_timeout",
        `GitHub took too long to answer, so ${consequence}.`,
      );
    }
    throw new QueueError(502, "github_unavailable", `GitHub did not answer, so ${consequence}.`);
  }
  if (res.status === 404) {
    // GitHub also answers 404 for a repository the token cannot see, so the sentence says both.
    throw new QueueError(
      404,
      "no_such_pull_request",
      "GitHub has no such pull request (or the Worker's token cannot see the repository).",
    );
  }
  if (!res.ok) {
    const body = sanitizeNote(await res.text().catch(() => ""), 160);
    console.error(
      `[pr-review-start] ${where}: GitHub answered HTTP ${res.status}: ${body || "no body"}`,
    );
    if (
      res.status === 429 ||
      (res.status === 403 &&
        (/rate limit|abuse/i.test(body) || res.headers.get("x-ratelimit-remaining") === "0"))
    ) {
      throw new QueueError(
        503,
        "github_rate_limited",
        "GitHub is rate limiting the Worker. Try again in a minute or two.",
      );
    }
    if (res.status === 401 || res.status === 403) {
      throw new QueueError(
        502,
        "github_refused",
        `GitHub refused the read (HTTP ${res.status}), so ${consequence}.`,
      );
    }
    throw new QueueError(502, "github_unavailable", `GitHub did not answer, so ${consequence}.`);
  }
  const parsed = (await res.json().catch((err) => {
    console.error(`[pr-review-start] ${where}: GitHub's answer could not be read (${said(err)})`);
    return null;
  })) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new QueueError(502, "github_bad_response", "GitHub's answer could not be read.");
  }
  return parsed as Record<string, unknown>;
}

/**
 * Review `datasetId#prNumber` now. The answer is the gate's own: `dispatched`, or the fixed word for
 * why not. A pull request that cannot be reviewed (a draft, closed, not aimed at `main`, a bot's) is
 * an answer, not an error, and so is one whose author is an owner or administrator (`exempt_author`,
 * `exempt_naming_waived`, `naming_rule` or `naming_unchecked`, see the module comment); a dataset
 * this Worker does not own, a pull request GitHub does not have and a GitHub that does not answer
 * are errors.
 */
export async function startPullRequestReview(
  env: Bindings,
  adminUserId: number,
  datasetId: string,
  prNumber: number,
  options: { redo?: boolean } = {},
): Promise<StartReviewResponse> {
  const environment = environmentName(env);
  const redo = options.redo === true;
  // Echoed in every answer when asked for, so a CLI can tell a Worker that honored the flag from
  // one that predates it and ignored it.
  const echo = redo ? { redo: true as const } : {};
  if (!ownedHere(env, datasetId)) {
    throw new QueueError(
      404,
      "not_owned_here",
      "The other environment's Worker answers for that dataset.",
    );
  }
  if (env.PR_REVIEW_ENABLED !== "1") {
    return {
      environment,
      dispatched: false,
      reason: "pr_review_disabled",
      review_id: null,
      author_login: null,
      ...echo,
    };
  }

  // Before GitHub is asked anything, so a dataset that cannot be reviewed neither costs a read nor
  // echoes the author of a pull request in it.
  const reviewable = await reviewableDataset(env.DB, datasetId);
  if (reviewable !== "reviewable") {
    return {
      environment,
      dispatched: false,
      reason: reviewable === "unknown" ? "unknown_dataset" : "dataset_not_reviewable",
      review_id: null,
      author_login: null,
      ...echo,
    };
  }

  const pull = await readPullRequest(env, datasetId, prNumber);
  const base = pull.base as { repo?: unknown } | null | undefined;
  let result: Awaited<ReturnType<typeof handlePullRequestEvent>>;
  try {
    result = await handlePullRequestEvent(
      env,
      // The shape a `pull_request` delivery has: GitHub's own record of the pull request, and the
      // repository it targets. `synchronize` is only the delivery's name for "take it up".
      { action: "synchronize", pull_request: pull, repository: base?.repo },
      { adminStart: true, redo },
    );
  } catch (err) {
    // The author is exempt and GitHub would not take the check the naming rule decided on (skipped,
    // failed or needing a person): a sentence, not the generic failure, because retrying is exactly
    // what the administrator should do.
    if (err instanceof ExemptCheckNotPublished) {
      throw new QueueError(
        502,
        "github_unavailable",
        "GitHub would not take the check for this pull request, whose author is exempt from the review, so nothing was posted. Try again in a moment.",
      );
    }
    throw err;
  }

  const login = (pull.user as { login?: unknown } | null | undefined)?.login;
  const answer: StartReviewResponse = {
    environment,
    dispatched: result.dispatched,
    reason: result.reason,
    review_id: result.review_id ?? null,
    author_login: typeof login === "string" && LOGIN.test(login) ? login : null,
    ...echo,
  };
  // Only a start is a fact worth an audit row; a decision not to start changed nothing an
  // administrator did. And the row is best effort: a review that is already running must not be
  // reported as an error because its audit row could not be written.
  if (answer.dispatched) {
    const head = (pull.head as { sha?: unknown } | null | undefined)?.sha;
    try {
      await auditLogStatement(env.DB, {
        userId: adminUserId,
        action: "pr_review_started",
        resourceType: "pr_review",
        resourceId: `${datasetId}#${prNumber}`,
        details: JSON.stringify({
          head_sha: typeof head === "string" ? head : null,
          reason: answer.reason,
          review_id: answer.review_id,
          ...(redo ? { redo: true } : {}),
        }),
      }).run();
    } catch (err) {
      console.error(
        `[pr-review-start] ${datasetId}#${prNumber}: review ${answer.review_id} started, audit row not written (${said(err)})`,
      );
    }
  }
  return answer;
}

/** An automatic re-pull record's dataset: only an `on` mirror is re-pulled automatically. */
const ON_DATASET = /^on\d{6}$/;

/** The answer of a start that started nothing, in the review's own words. */
const notStarted = (reason: string): PrReviewResponse => ({ ok: true, dispatched: false, reason });

/**
 * Review the NEMAR App's automatic re-pull pull request: the Worker's own start, for the advance
 * tick of the automatic path (epic #1046 phase 7, #1913; ADR 0111, decision 7, which needs an
 * ADR 0107 review that passes before the Worker may merge one).
 *
 * Called by the advance tick (`upstream-repull-advance.ts`), and by nothing else.
 *
 * The App's pull request is a bot's, which the review's intake skips (ADR 0092: "not bots"). This
 * is the one way it is admitted, so it is narrow on purpose (ADR 0111 narrows ADR 0092 for this
 * class only). Its gates, in order, each with the answer it starts nothing with:
 *  - exact production (`not_production`) and the open switch (`auto_repull_off`), as every
 *    automatic job;
 *  - a dataset this Worker owns (`not_owned_here`); outside the dev Worker's own ids, which are
 *    never `on` mirrors, that is every dataset;
 *  - an automatic record of an `on` dataset (`not_automatic`), at `pr_open` with its branch, number
 *    and head recorded (`not_pr_open`);
 *  - the review switched on (`pr_review_disabled`) and a dataset the review may read: a live,
 *    named, published one (`unknown_dataset`, `dataset_not_reviewable`);
 *  - and on GitHub, the recorded pull request (`github_unreadable` when it cannot be read),
 *    authored by the App by login, numeric id and type (`not_app_author`), at the recorded head
 *    (`head_moved`).
 * The intake then admits it only from the recorded release branch and the dataset's own
 * repository; any other is the intake's `bot_author`.
 *
 * Nothing about the pull request comes from the caller: the Worker reads it from GitHub, shapes it
 * as the `pull_request` delivery it would have been, as an administrator's start does, and hands
 * it to the one gate every delivery goes through, so every other rule of the review applies
 * unchanged (the reviewable dataset, a block, the per-commit row, the edit cap). It is not an
 * administrator's start: a commit whose review ended without a verdict is not started again by
 * it, and a delivery GitHub sends for the App's pull request is still skipped. The App has no
 * NEMAR account, so it is never exempt.
 *
 * GitHub is not asked anything outside exact production, with the switch off, or for a record or
 * a dataset that cannot be reviewed. A start that dispatched writes an audit row with no user, as
 * the automatic path's other rows have; a row that could not be written is logged and does not
 * undo or block the review, so the answer says nothing about it, by design (the review's own row
 * is the record that matters). Mails nobody.
 */
export async function startRepullPullRequestReview(
  env: Bindings,
  row: RepullRow,
): Promise<PrReviewResponse> {
  if (!isExactProduction(env)) return notStarted("not_production");
  if (!autoRepullEnabled(env)) return notStarted("auto_repull_off");
  if (!ownedHere(env, row.dataset_id)) return notStarted("not_owned_here");
  if (row.origin !== "automatic" || !ON_DATASET.test(row.dataset_id)) {
    return notStarted("not_automatic");
  }
  if (
    row.status !== "pr_open" ||
    row.branch === null ||
    row.pr_number === null ||
    row.head_sha === null
  ) {
    return notStarted("not_pr_open");
  }
  if (env.PR_REVIEW_ENABLED !== "1") return notStarted("pr_review_disabled");
  const reviewable = await reviewableDataset(env.DB, row.dataset_id);
  if (reviewable !== "reviewable") {
    return notStarted(reviewable === "unknown" ? "unknown_dataset" : "dataset_not_reviewable");
  }

  const where = `${row.dataset_id}#${row.pr_number}`;
  let pull: Record<string, unknown>;
  try {
    pull = await readPullRequest(env, row.dataset_id, row.pr_number, "no review was started");
  } catch (err) {
    if (!(err instanceof QueueError)) throw err;
    console.warn(
      `[pr-review-start] ${where}: the re-pull's pull request was not read (${err.code})`,
    );
    return notStarted("github_unreadable");
  }
  const user = pull.user as { login?: unknown; id?: unknown; type?: unknown } | null | undefined;
  if (
    user?.login !== NEMAR_APP_BOT_LOGIN ||
    user.id !== NEMAR_APP_BOT_USER_ID ||
    user.type !== NEMAR_APP_BOT_TYPE
  ) {
    return notStarted("not_app_author");
  }
  const head = (pull.head as { sha?: unknown } | null | undefined)?.sha;
  if (head !== row.head_sha) return notStarted("head_moved");

  const base = pull.base as { repo?: unknown } | null | undefined;
  const result = await handlePullRequestEvent(
    env,
    // The shape a `pull_request` delivery has, as the administrator's start builds it.
    { action: "synchronize", pull_request: pull, repository: base?.repo },
    { admitRepullBot: { branch: row.branch } },
  );
  if (result.dispatched) {
    try {
      await auditLogStatement(env.DB, {
        userId: null,
        action: "pr_review_started",
        resourceType: "pr_review",
        resourceId: where,
        details: JSON.stringify({
          head_sha: row.head_sha,
          reason: result.reason,
          review_id: result.review_id ?? null,
          repull_id: row.id,
          automatic: true,
        }),
      }).run();
    } catch (err) {
      console.error(
        `[pr-review-start] ${where}: review ${result.review_id} started, audit row not written (${said(err)})`,
      );
    }
  }
  return result;
}
