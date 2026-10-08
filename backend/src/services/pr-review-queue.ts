/**
 * The administrator's view of the pull-request review (ADR 0093, following ADR 0092): every open
 * pull request to `main` in `nemarDatasets`, joined with the Worker's own record of reviewing it,
 * and the controls over who gets reviewed.
 *
 * **Two sources, joined here and nowhere else.** GitHub knows which pull requests are open and what
 * their checks say; `pr_reviews` knows what the automated review concluded. Neither alone answers
 * "what is waiting for me". A pull request with no review row is `not_reviewed`, never an error:
 * the review is off in some environments, declines some contributors, and cannot have seen a pull
 * request opened a second ago.
 *
 * **A verdict belongs to the commit it read.** A pass on commit A says nothing about commit B, so a
 * review whose `head_sha` is not the pull request's current head is reported as `not_reviewed`
 * (with `review_current: false`), and what it concluded rides along as `stale_verdict`. Approving on
 * the strength of a verdict about different code is the mistake this one rule prevents.
 *
 * **One search, not one call per pull request.** The open pull requests, their head commits, the
 * fork they came from and their required checks arrive in a single paginated GraphQL search, so a
 * queue of 60 costs two requests rather than 130. That matters because the datasets token is shared
 * with publishing and every sweep, and GitHub's secondary rate limit answers bursts with a 403. The
 * pages are fetched one after another through the shared retry transport, which waits out a
 * `Retry-After`; a GraphQL budget that is spent is reported as a 503 rather than retried into.
 *
 * **Nothing here trusts a pull request's words.** Titles and branch names are author-controlled:
 * the title goes through `sanitizeNote`, a branch name is reduced to the characters a git ref
 * actually uses, the link is built from the dataset id and number and never taken from the
 * response, and the body is never read. The CLI strips control characters again before printing.
 *
 * **Overrides are keyed by GitHub's numeric id** (`pr_review_overrides.author_id`), because a login
 * can be renamed and then reused by someone else. A login is therefore resolved against GitHub
 * before an override is WRITTEN; the review history is only a fallback for READING a standing.
 */

import {
  type CheckState,
  type ClearOverrideResponse,
  type ContributorStanding,
  type LivePullRequest,
  type PrReviewDetail,
  QUEUE_VERDICTS,
  type QueueEntry,
  type QueueResponse,
  type QueueSkipped,
  type QueueVerdict,
  type ReviewHistoryItem,
  type ReviewRecord,
  type SetOverrideResponse,
} from "../../../shared/contract/pr-review-admin.js";
import {
  type AuthorOverride,
  DECLINE_REASONS,
  type DeclineReason,
  REJECTION_COUNT,
  REJECTION_PERCENT,
  RUN_ERRORS,
  type ReviewOutcome,
  type RunError,
  parsePrReviewReport,
  sanitizeNote,
  standingOf,
  verdictOf,
} from "../../../shared/pr-review.js";
import { auditLogStatement } from "../db/audit-log.js";
import type { Bindings } from "../types/bindings.js";
import { isDevOwnedDatasetId, isValidDatasetId } from "./datasetId.js";
import { isNonProductionEnv } from "./environment.js";
import { getDatasetsTokenWithRefresher } from "./github-auth.js";
import { deriveContexts } from "./github/branch-protection.js";
import { GITHUB_API, ORG_NAME, ghHeaders } from "./github/shared.js";
import { githubFetchWithRetry } from "./github/transport.js";
import { readAuthorOverride, readAuthorTally } from "./pr-review.js";

/** The GitHub search that defines "waiting for approval". */
export const OPEN_PR_SEARCH = `org:${ORG_NAME} is:pr is:open base:main`;

/** Pull requests per GraphQL page, and pages per call. GitHub's search returns at most 1000 results. */
const PAGE_SIZE = 50;
const MAX_PAGES = 20;
/** Check contexts read per pull request. More than this on one commit is reported as `unknown`. */
const CONTEXTS_PER_PR = 40;
/** The longest a Retry-After is waited out inside an admin request. */
const MAX_THROTTLE_MS = 15_000;
const LIVE_TIMEOUT_MS = 10_000;

const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

/** A failure the route turns into a status and a plain sentence. `code` is a fixed word. */
export class QueueError extends Error {
  constructor(
    readonly status: 400 | 404 | 422 | 502 | 503,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "QueueError";
  }
}

// ---------------------------------------------------------------------------------------------
// Plain text from author-controlled strings
// ---------------------------------------------------------------------------------------------

/** A git ref or login reduced to the characters it can legitimately contain. */
export function plainRef(input: unknown, max = 60): string {
  if (typeof input !== "string") return "";
  const s = input.normalize("NFKC").replace(/[^A-Za-z0-9._\-/]/g, "?");
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// ---------------------------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------------------------

export interface CheckContext {
  name: string;
  state: CheckState;
  /** ISO timestamp used to pick the newest run of a re-run check. */
  at: string;
}

const CHECK_FAIL = new Set([
  "FAILURE",
  "TIMED_OUT",
  "CANCELLED",
  "ACTION_REQUIRED",
  "STARTUP_FAILURE",
]);

/** Read one node of a commit's `statusCheckRollup.contexts`. Unrecognised shapes are dropped. */
export function readCheckContext(node: unknown): CheckContext | null {
  const n = rec(node);
  if (!n) return null;
  if (n.__typename === "CheckRun" && typeof n.name === "string") {
    const at = typeof n.startedAt === "string" ? n.startedAt : "";
    if (n.status !== "COMPLETED") return { name: n.name, state: "pending", at };
    if (n.conclusion === "SUCCESS") return { name: n.name, state: "pass", at };
    if (typeof n.conclusion === "string" && CHECK_FAIL.has(n.conclusion)) {
      return { name: n.name, state: "fail", at };
    }
    // NEUTRAL, SKIPPED and STALE count as passing for a required check on GitHub. Neither of
    // NEMAR's checks emits them, so seeing one means something else is posting under the name.
    return { name: n.name, state: "unknown", at };
  }
  if (n.__typename === "StatusContext" && typeof n.context === "string") {
    const at = typeof n.createdAt === "string" ? n.createdAt : "";
    if (n.state === "SUCCESS") return { name: n.context, state: "pass", at };
    if (n.state === "PENDING" || n.state === "EXPECTED") {
      return { name: n.context, state: "pending", at };
    }
    if (n.state === "FAILURE" || n.state === "ERROR") return { name: n.context, state: "fail", at };
    return { name: n.context, state: "unknown", at };
  }
  return null;
}

/**
 * The state of the check called one of `names`: the newest run wins (a re-run replaces the failure
 * before it). No such check is `missing` when the whole list was read, and `unknown` when the list
 * was cut short, because a check that might be on the next page is not known to be absent.
 */
export function checkStateOf(
  contexts: readonly CheckContext[],
  names: readonly string[],
  listComplete: boolean,
): CheckState {
  let best: CheckContext | null = null;
  for (const c of contexts) {
    if (!names.includes(c.name)) continue;
    if (!best || c.at >= best.at) best = c;
  }
  if (best) return best.state;
  return listComplete ? "missing" : "unknown";
}

// ---------------------------------------------------------------------------------------------
// The GitHub side
// ---------------------------------------------------------------------------------------------

export interface OpenPullRequest {
  datasetId: string;
  prNumber: number;
  title: string;
  draft: boolean;
  createdAt: string;
  updatedAt: string;
  headSha: string;
  fromFork: boolean;
  headLabel: string;
  authorLogin: string;
  authorId: number | null;
  bids: CheckState;
  version: CheckState;
}

export interface OpenPullRequests {
  prs: OpenPullRequest[];
  truncated: boolean;
  notADataset: number;
}

const OPEN_PRS_QUERY = `
query OpenDatasetPullRequests($q: String!, $after: String) {
  search(query: $q, type: ISSUE, first: ${PAGE_SIZE}, after: $after) {
    issueCount
    pageInfo { hasNextPage endCursor }
    nodes {
      __typename
      ... on PullRequest {
        number
        title
        isDraft
        createdAt
        updatedAt
        headRefName
        headRefOid
        isCrossRepository
        headRepositoryOwner { login }
        repository { name owner { login } }
        author { __typename login ... on User { databaseId } }
        commits(last: 1) {
          nodes {
            commit {
              statusCheckRollup {
                contexts(first: ${CONTEXTS_PER_PR}) {
                  pageInfo { hasNextPage }
                  nodes {
                    __typename
                    ... on CheckRun { name status conclusion startedAt }
                    ... on StatusContext { context state createdAt }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}`;

function rec(x: unknown): Record<string, unknown> | null {
  return typeof x === "object" && x !== null && !Array.isArray(x)
    ? (x as Record<string, unknown>)
    : null;
}

const SHA40 = /^[0-9a-f]{40}$/;

/** One search node, or null (with the reason it was not a dataset pull request). */
function readOpenPullRequest(
  node: unknown,
): { pr: OpenPullRequest } | { skip: "not_a_dataset" | "ignore" } {
  const n = rec(node);
  if (!n || n.__typename !== "PullRequest") return { skip: "ignore" };
  const repo = rec(n.repository);
  const owner = rec(repo?.owner);
  if (
    typeof repo?.name !== "string" ||
    !isValidDatasetId(repo.name) ||
    typeof owner?.login !== "string" ||
    owner.login.toLowerCase() !== ORG_NAME.toLowerCase()
  ) {
    return { skip: "not_a_dataset" };
  }
  const number = n.number;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number <= 0) {
    return { skip: "ignore" };
  }
  if (typeof n.headRefOid !== "string" || !SHA40.test(n.headRefOid)) return { skip: "ignore" };

  const author = rec(n.author);
  const authorLogin =
    typeof author?.login === "string" && LOGIN.test(author.login) ? author.login : "(unknown)";
  const databaseId = author?.databaseId;
  const authorId =
    author?.__typename === "User" &&
    typeof databaseId === "number" &&
    Number.isSafeInteger(databaseId) &&
    databaseId > 0
      ? databaseId
      : null;

  const fromFork = n.isCrossRepository === true;
  const forkOwner = rec(n.headRepositoryOwner)?.login;
  const branch = plainRef(n.headRefName) || "(unknown)";
  const headLabel = fromFork
    ? `${typeof forkOwner === "string" ? plainRef(forkOwner, 39) : "(deleted fork)"}:${branch}`
    : branch;

  const commitNodes = rec(n.commits)?.nodes;
  const commit = rec(rec(Array.isArray(commitNodes) ? commitNodes[0] : null)?.commit);
  const contexts = rec(rec(commit?.statusCheckRollup)?.contexts);
  const list: CheckContext[] = [];
  if (Array.isArray(contexts?.nodes)) {
    for (const c of contexts.nodes) {
      const parsed = readCheckContext(c);
      if (parsed) list.push(parsed);
    }
  }
  const complete = contexts !== null && rec(contexts.pageInfo)?.hasNextPage === false;
  // No rollup at all means no check has run on the commit, which is "missing", not "unknown".
  const readable = commit !== null && (commit.statusCheckRollup === null || complete);
  const [bidsCtx, versionCtx] = deriveContexts(repo.name);
  return {
    pr: {
      datasetId: repo.name,
      prNumber: number,
      title: sanitizeNote(n.title, 120),
      draft: n.isDraft === true,
      createdAt: typeof n.createdAt === "string" ? n.createdAt : "",
      updatedAt: typeof n.updatedAt === "string" ? n.updatedAt : "",
      headSha: n.headRefOid,
      fromFork,
      headLabel,
      authorLogin,
      authorId,
      // The names come from branch protection, the one place that knows which check a repository
      // is held to; the legacy repositories name their BIDS check differently.
      bids: checkStateOf(list, [bidsCtx.context], readable),
      version: checkStateOf(list, [versionCtx.context], readable),
    },
  };
}

/**
 * Every open pull request to `main` in the datasets organisation. Pages are read one after another
 * (never in parallel: GitHub's secondary limit is about bursts). A GraphQL `errors` array fails the
 * whole read even when `data` is present, because a partial queue that looks complete is worse than
 * none.
 */
export async function fetchOpenPullRequests(env: Bindings): Promise<OpenPullRequests> {
  let auth: { token: string; refresh: () => Promise<string> };
  try {
    auth = await getDatasetsTokenWithRefresher(env);
  } catch (err) {
    console.error(`[pr-queue] no GitHub token (${errMessage(err)})`);
    throw new QueueError(502, "github_unavailable", "NEMAR could not get a GitHub token.");
  }

  const seen = new Set<string>();
  const prs: OpenPullRequest[] = [];
  let notADataset = 0;
  let nodesSeen = 0;
  let issueCount = 0;
  let after: string | null = null;
  let more = false;

  for (let page = 0; page < MAX_PAGES; page++) {
    let res: Response;
    try {
      res = await githubFetchWithRetry(
        `${GITHUB_API()}/graphql`,
        {
          method: "POST",
          headers: { ...ghHeaders(auth.token), "Content-Type": "application/json" },
          body: JSON.stringify({ query: OPEN_PRS_QUERY, variables: { q: OPEN_PR_SEARCH, after } }),
        },
        {
          kind: "interactive",
          maxAttempts: 3,
          maxThrottleMs: MAX_THROTTLE_MS,
          // The transport's pre-flight throttle watches the REST `core` budget, which publishing
          // and every sweep spend and this search does not (GraphQL has its own). Gating the
          // queue on it would refuse a list GitHub would have answered. A secondary limit is
          // still waited out, and an exhausted GraphQL budget is reported below.
          lowRemainingThreshold: 0,
          refreshTokenOn401: auth.refresh,
        },
      );
    } catch (err) {
      console.error(`[pr-queue] GitHub unreachable (${errMessage(err)})`);
      throw new QueueError(502, "github_unavailable", "GitHub could not be reached.");
    }
    if (!res.ok) {
      console.error(`[pr-queue] GraphQL answered HTTP ${res.status}`);
      throw new QueueError(
        502,
        "github_refused",
        `GitHub refused the search (HTTP ${res.status}).`,
      );
    }
    const body = rec(await res.json().catch(() => null));
    const errors = body?.errors;
    if (Array.isArray(errors) && errors.length > 0) {
      const first = rec(errors[0]);
      const why = sanitizeNote(first?.message, 160) || "no reason given";
      console.error(`[pr-queue] GraphQL errors: ${why}`);
      if (first?.type === "RATE_LIMITED") {
        throw new QueueError(
          503,
          "github_rate_limited",
          `GitHub's rate limit for this search is spent (${why}). Try again later.`,
        );
      }
      throw new QueueError(
        502,
        "github_graphql_error",
        `GitHub could not answer the search: ${why}`,
      );
    }
    const search = rec(rec(body?.data)?.search);
    if (!search || !Array.isArray(search.nodes)) {
      throw new QueueError(
        502,
        "github_bad_response",
        "GitHub's search answered in an unexpected shape.",
      );
    }
    issueCount = typeof search.issueCount === "number" ? search.issueCount : issueCount;
    for (const node of search.nodes) {
      nodesSeen++;
      const read = readOpenPullRequest(node);
      if ("skip" in read) {
        if (read.skip === "not_a_dataset") notADataset++;
        continue;
      }
      const key = `${read.pr.datasetId}#${read.pr.prNumber}`;
      if (seen.has(key)) continue;
      seen.add(key);
      prs.push(read.pr);
    }
    const info = rec(search.pageInfo);
    more = info?.hasNextPage === true;
    after = typeof info?.endCursor === "string" ? info.endCursor : null;
    if (!more) break;
    if (after === null) break;
  }
  // `more` still true means the page limit stopped the read; `issueCount` above what was read means
  // GitHub's own 1000-result cap did.
  const truncated = more || issueCount > nodesSeen;
  return { prs, truncated, notADataset };
}

// ---------------------------------------------------------------------------------------------
// The review side
// ---------------------------------------------------------------------------------------------

export interface ReviewRow {
  id: number;
  dataset_id: string;
  pr_number: number;
  head_sha: string;
  author_id: number;
  author_login: string;
  from_fork: number;
  state: string;
  verdict: string | null;
  detail: string | null;
  created_at: string;
  decided_at: string | null;
}

const REVIEW_COLUMNS = `id, dataset_id, pr_number, head_sha, author_id, author_login, from_fork,
  state, verdict, detail, created_at, decided_at`;

const DECLINES: ReadonlySet<string> = new Set(DECLINE_REASONS);
const RUN_ERROR_SET: ReadonlySet<string> = new Set(RUN_ERRORS);

/** What a stored row means, in the queue's words, ignoring which commit it is about. */
export function meaningOf(row: Pick<ReviewRow, "state" | "verdict" | "detail">): {
  verdict: QueueVerdict;
  detail: QueueEntry["detail"];
} {
  switch (row.state) {
    case "dispatched":
      return { verdict: "in_progress", detail: null };
    case "reported":
      // The column is CHECK-constrained, and a reader still must not trust it: anything that is
      // not one of the three derived verdicts is a row nobody can stand behind.
      return row.verdict === "pass" || row.verdict === "fail" || row.verdict === "uncertain"
        ? { verdict: row.verdict, detail: null }
        : { verdict: "could_not_decide", detail: null };
    case "declined":
      return {
        verdict: "not_reviewed",
        detail: row.detail && DECLINES.has(row.detail) ? (row.detail as DeclineReason) : null,
      };
    case "errored":
      return {
        verdict: "could_not_decide",
        detail: row.detail && RUN_ERROR_SET.has(row.detail) ? (row.detail as RunError) : null,
      };
    case "unreported":
      return { verdict: "could_not_decide", detail: "unreported" };
    default:
      return { verdict: "could_not_decide", detail: null };
  }
}

export interface Classified {
  verdict: QueueVerdict;
  detail: QueueEntry["detail"];
  reviewed_sha: string | null;
  review_current: boolean | null;
  stale_verdict: QueueVerdict | null;
}

/** The verdict for a pull request now at `headSha`, given its latest stored review (or none). */
export function classify(row: ReviewRow | null, headSha: string | null): Classified {
  if (!row) {
    return {
      verdict: "not_reviewed",
      detail: null,
      reviewed_sha: null,
      review_current: null,
      stale_verdict: null,
    };
  }
  const meant = meaningOf(row);
  if (headSha !== null && row.head_sha !== headSha) {
    return {
      verdict: "not_reviewed",
      detail: null,
      reviewed_sha: row.head_sha,
      review_current: false,
      stale_verdict: meant.verdict,
    };
  }
  return {
    ...meant,
    reviewed_sha: row.head_sha,
    review_current: headSha === null ? null : true,
    stale_verdict: null,
  };
}

/** The latest review row of every pull request, without the (large) stored report. */
async function latestReviews(db: D1Database): Promise<Map<string, ReviewRow>> {
  const { results } = await db
    .prepare(
      `SELECT ${REVIEW_COLUMNS} FROM pr_reviews
        WHERE id IN (SELECT MAX(id) FROM pr_reviews GROUP BY dataset_id, pr_number)`,
    )
    .all<ReviewRow>();
  const out = new Map<string, ReviewRow>();
  for (const r of results) out.set(`${r.dataset_id}#${r.pr_number}`, r);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Ordering and filtering
// ---------------------------------------------------------------------------------------------

/**
 * Verdicts an administrator can act on: approve a pass, or review by hand what the automation
 * could not or did not decide. A fail is the author's to fix and an in-progress review is waiting
 * on the machine, so neither is yours yet.
 */
const NEEDS_YOU: ReadonlySet<QueueVerdict> = new Set([
  "pass",
  "uncertain",
  "could_not_decide",
  "not_reviewed",
]);

export function needsYou(e: Pick<QueueEntry, "verdict" | "draft">): boolean {
  return !e.draft && NEEDS_YOU.has(e.verdict);
}

/** Lower sorts first: ready to approve, then the ones needing a closer look, then the rest. */
const VERDICT_RANK: Record<QueueVerdict, number> = {
  pass: 0,
  uncertain: 1,
  could_not_decide: 2,
  not_reviewed: 3,
  in_progress: 4,
  fail: 5,
};

function checkRank(e: Pick<QueueEntry, "bids" | "version">): number {
  if (e.bids === "fail" || e.version === "fail") return 2;
  if (e.bids === "pass" && e.version === "pass") return 0;
  return 1;
}

/**
 * Order the queue so what an administrator can act on comes first: drafts last, then by verdict,
 * then pull requests whose required checks already pass, then the one that has waited longest.
 */
export function sortQueue<T extends QueueEntry>(entries: readonly T[]): T[] {
  return [...entries].sort(
    (a, b) =>
      Number(a.draft) - Number(b.draft) ||
      VERDICT_RANK[a.verdict] - VERDICT_RANK[b.verdict] ||
      checkRank(a) - checkRank(b) ||
      a.created_at.localeCompare(b.created_at) ||
      a.dataset_id.localeCompare(b.dataset_id) ||
      a.pr_number - b.pr_number,
  );
}

export interface QueueFilters {
  verdicts: QueueVerdict[];
  dataset: string | null;
  author: string | null;
  needs_me: boolean;
}

export function filterQueue<T extends QueueEntry>(entries: readonly T[], f: QueueFilters): T[] {
  const author = f.author?.toLowerCase() ?? null;
  return entries.filter(
    (e) =>
      (f.verdicts.length === 0 || f.verdicts.includes(e.verdict)) &&
      (f.dataset === null || e.dataset_id === f.dataset) &&
      (author === null || e.author_login.toLowerCase() === author) &&
      (!f.needs_me || e.needs_you),
  );
}

/** Parse the `verdict` query value (comma separated). A word outside the vocabulary is an error. */
export function parseVerdictFilter(raw: string | undefined): QueueVerdict[] {
  if (raw === undefined || raw.trim() === "") return [];
  const out: QueueVerdict[] = [];
  for (const part of raw.split(",")) {
    const word = part.trim().toLowerCase().replaceAll("-", "_");
    if (!(QUEUE_VERDICTS as readonly string[]).includes(word)) {
      throw new QueueError(
        400,
        "bad_verdict",
        `"${sanitizeNote(part, 30)}" is not a verdict. Use: ${QUEUE_VERDICTS.join(", ")}.`,
      );
    }
    if (!out.includes(word as QueueVerdict)) out.push(word as QueueVerdict);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// The queue
// ---------------------------------------------------------------------------------------------

export function environmentName(env: Bindings): QueueResponse["environment"] {
  return isNonProductionEnv(env) ? "non-production" : "production";
}

/**
 * Whether this Worker answers for a dataset. The production Worker leaves dev-owned repositories
 * to the dev Worker and the dev Worker answers only for the ones it owns, exactly as the webhook
 * fence decides who reviews them: the `nemarDatasets` organisation is shared, the D1 databases are
 * not, so the other environment's pull requests would all read "not reviewed" here.
 */
export function ownedHere(env: Bindings, datasetId: string): boolean {
  return isNonProductionEnv(env) ? isDevOwnedDatasetId(datasetId) : !isDevOwnedDatasetId(datasetId);
}

export async function buildQueue(env: Bindings, filters: QueueFilters): Promise<QueueResponse> {
  const open = await fetchOpenPullRequests(env);
  const reviews = await latestReviews(env.DB);
  const skipped: QueueSkipped = { not_a_dataset: open.notADataset, not_owned_here: 0 };

  const all: QueueEntry[] = [];
  for (const pr of open.prs) {
    if (!ownedHere(env, pr.datasetId)) {
      skipped.not_owned_here++;
      continue;
    }
    const row = reviews.get(`${pr.datasetId}#${pr.prNumber}`) ?? null;
    const entry: QueueEntry = {
      dataset_id: pr.datasetId,
      pr_number: pr.prNumber,
      url: pullUrl(pr.datasetId, pr.prNumber),
      title: pr.title,
      author_login: pr.authorLogin,
      author_id: pr.authorId,
      from_fork: pr.fromFork,
      head_label: pr.headLabel,
      head_sha: pr.headSha,
      draft: pr.draft,
      created_at: pr.createdAt,
      updated_at: pr.updatedAt,
      ...classify(row, pr.headSha),
      bids: pr.bids,
      version: pr.version,
      needs_you: false,
    };
    entry.needs_you = needsYou(entry);
    all.push(entry);
  }
  return {
    environment: environmentName(env),
    review_enabled: env.PR_REVIEW_ENABLED === "1",
    entries: sortQueue(filterQueue(all, filters)),
    total_open: all.length,
    truncated: open.truncated,
    skipped,
    filters,
  };
}

export function pullUrl(datasetId: string, prNumber: number): string {
  return `https://github.com/${ORG_NAME}/${datasetId}/pull/${prNumber}`;
}

// ---------------------------------------------------------------------------------------------
// One pull request
// ---------------------------------------------------------------------------------------------

/** What GitHub says about one pull request now. Null when it could not be read; never throws. */
export async function fetchLivePullRequest(
  env: Bindings,
  datasetId: string,
  prNumber: number,
): Promise<{ pr: LivePullRequest | null; missing: boolean }> {
  try {
    const { token, refresh } = await getDatasetsTokenWithRefresher(env);
    const res = await githubFetchWithRetry(
      `${GITHUB_API()}/repos/${ORG_NAME}/${datasetId}/pulls/${prNumber}`,
      { headers: ghHeaders(token), signal: AbortSignal.timeout(LIVE_TIMEOUT_MS) },
      {
        kind: "interactive",
        maxAttempts: 2,
        maxThrottleMs: MAX_THROTTLE_MS,
        refreshTokenOn401: refresh,
      },
    );
    if (res.status === 404) return { pr: null, missing: true };
    if (!res.ok) return { pr: null, missing: false };
    const p = rec(await res.json().catch(() => null));
    const head = rec(p?.head);
    const base = rec(p?.base);
    const user = rec(p?.user);
    if (!p || typeof head?.sha !== "string" || !SHA40.test(head.sha)) {
      return { pr: null, missing: false };
    }
    const headRepo = rec(head.repo);
    const fromFork =
      typeof headRepo?.full_name !== "string" ||
      headRepo.full_name.toLowerCase() !== `${ORG_NAME}/${datasetId}`.toLowerCase();
    const forkOwner = rec(headRepo?.owner)?.login;
    const branch = plainRef(head.ref) || "(unknown)";
    return {
      missing: false,
      pr: {
        state: p.state === "open" ? "open" : "closed",
        merged: p.merged === true,
        draft: p.draft === true,
        head_sha: head.sha,
        base_ref: plainRef(base?.ref),
        url: pullUrl(datasetId, prNumber),
        title: sanitizeNote(p.title, 120),
        author_login:
          typeof user?.login === "string" && LOGIN.test(user.login) ? user.login : "(unknown)",
        author_id:
          typeof user?.id === "number" && Number.isSafeInteger(user.id) && user.id > 0
            ? user.id
            : null,
        from_fork: fromFork,
        head_label: fromFork
          ? `${typeof forkOwner === "string" ? plainRef(forkOwner, 39) : "(deleted fork)"}:${branch}`
          : branch,
      },
    };
  } catch (err) {
    console.error(`[pr-queue] ${datasetId}#${prNumber}: live read failed (${errMessage(err)})`);
    return { pr: null, missing: false };
  }
}

/** Re-validate a stored report on the way out; a row that no longer parses is not trusted. */
export function outcomeOf(
  row: Pick<ReviewRow, "state" | "detail"> & { report: string | null },
): ReviewOutcome | null {
  switch (row.state) {
    case "dispatched":
      return null;
    case "unreported":
      return { kind: "unreported" };
    case "declined":
      return row.detail && DECLINES.has(row.detail)
        ? { kind: "declined", reason: row.detail as DeclineReason }
        : { kind: "error", error: "report_invalid" };
    case "errored":
      return row.detail && RUN_ERROR_SET.has(row.detail)
        ? { kind: "error", error: row.detail as RunError }
        : { kind: "error", error: "report_invalid" };
    case "reported":
      try {
        return { kind: "reported", report: parsePrReviewReport(JSON.parse(row.report ?? "null")) };
      } catch {
        return { kind: "error", error: "report_invalid" };
      }
    default:
      return { kind: "error", error: "report_invalid" };
  }
}

export async function readPrReviewDetail(
  env: Bindings,
  datasetId: string,
  prNumber: number,
): Promise<PrReviewDetail> {
  if (!ownedHere(env, datasetId)) {
    throw new QueueError(
      404,
      "not_owned_here",
      `${datasetId} belongs to the ${isNonProductionEnv(env) ? "production" : "dev"} Worker, which holds its reviews. Ask that environment.`,
    );
  }
  const db = env.DB;
  const { results } = await db
    .prepare(
      `SELECT ${REVIEW_COLUMNS}, report FROM pr_reviews
        WHERE dataset_id = ? AND pr_number = ? ORDER BY id DESC LIMIT 20`,
    )
    .bind(datasetId, prNumber)
    .all<ReviewRow & { report: string | null }>();

  const live = await fetchLivePullRequest(env, datasetId, prNumber);
  const latest = results[0] ?? null;
  if (!latest && live.pr === null) {
    if (live.missing) {
      throw new QueueError(
        404,
        "no_such_pull_request",
        `${datasetId} has no pull request #${prNumber}.`,
      );
    }
    // Nothing stored and GitHub could not be read: that is not "not reviewed", it is "do not know".
    throw new QueueError(
      502,
      "github_unavailable",
      `There is no stored review of ${datasetId}#${prNumber} and GitHub could not be read to check the pull request.`,
    );
  }

  // The verdict an approval would lean on is re-derived from the stored report, not read from the
  // column: a row that no longer parses is "could not decide", whatever its column says.
  const outcome = latest ? outcomeOf(latest) : null;
  let meant = latest ? meaningOf(latest) : null;
  if (latest && meant && latest.state === "reported") {
    meant =
      outcome?.kind === "reported"
        ? { verdict: verdictOf(outcome.report), detail: null }
        : { verdict: "could_not_decide", detail: null };
  }
  const review: ReviewRecord | null =
    latest && meant
      ? {
          id: latest.id,
          head_sha: latest.head_sha,
          verdict: meant.verdict,
          detail: meant.detail,
          author_login: plainRef(latest.author_login, 39),
          author_id: latest.author_id,
          from_fork: latest.from_fork === 1,
          created_at: latest.created_at,
          decided_at: latest.decided_at,
          outcome,
        }
      : null;
  const effective = classify(
    latest && meant ? { ...latest, state: latest.state, verdict: meant.verdict } : null,
    live.pr?.head_sha ?? null,
  );
  const history: ReviewHistoryItem[] = results.map((r) => ({
    id: r.id,
    head_sha: r.head_sha,
    state: r.state as ReviewHistoryItem["state"],
    verdict: meaningOf(r).verdict,
    created_at: r.created_at,
    decided_at: r.decided_at,
  }));

  const authorId = latest?.author_id ?? live.pr?.author_id ?? null;
  const authorLogin = latest?.author_login ?? live.pr?.author_login ?? null;
  const author =
    authorId !== null && authorLogin !== null
      ? await standingFor(db, plainRef(authorLogin, 39), authorId, "history")
      : null;

  return {
    environment: environmentName(env),
    review_enabled: env.PR_REVIEW_ENABLED === "1",
    dataset_id: datasetId,
    pr_number: prNumber,
    verdict: effective.verdict,
    detail: effective.detail,
    review,
    history,
    live: live.pr,
    review_current: review && live.pr ? review.head_sha === live.pr.head_sha : null,
    author,
  };
}

// ---------------------------------------------------------------------------------------------
// Contributors: standing and overrides
// ---------------------------------------------------------------------------------------------

const RECENT_SQL = `
  WITH latest AS (
    SELECT dataset_id, pr_number, head_sha, verdict, decided_at, id,
           ROW_NUMBER() OVER (PARTITION BY dataset_id, pr_number ORDER BY id DESC) AS rn
      FROM pr_reviews
     WHERE author_id = ? AND state = 'reported' AND verdict IN ('pass', 'fail')
  )
  SELECT dataset_id, pr_number, head_sha, verdict, decided_at
    FROM latest WHERE rn = 1 ORDER BY id DESC LIMIT 10`;

/** The tally, override and standing of one contributor, as the review gate would see them now. */
export async function standingFor(
  db: D1Database,
  login: string,
  authorId: number,
  resolvedFrom: ContributorStanding["resolved_from"],
): Promise<ContributorStanding> {
  const tally = await readAuthorTally(db, authorId);
  const row = await db
    .prepare(
      `SELECT o.mode AS mode, o.reason AS reason, o.set_at AS set_at,
              COALESCE(u.username, 'account-' || u.id) AS set_by
         FROM pr_review_overrides o LEFT JOIN users u ON u.id = o.set_by
        WHERE o.author_id = ?`,
    )
    .bind(authorId)
    .first<{ mode: string; reason: string | null; set_at: string; set_by: string | null }>();
  const mode: AuthorOverride = row?.mode === "allow" || row?.mode === "block" ? row.mode : null;
  const recent = await db.prepare(RECENT_SQL).bind(authorId).all<{
    dataset_id: string;
    pr_number: number;
    head_sha: string;
    verdict: "pass" | "fail";
    decided_at: string | null;
  }>();
  return {
    login,
    author_id: authorId,
    tally,
    override:
      row && mode
        ? {
            mode,
            reason: row.reason ? sanitizeNote(row.reason, 200) : null,
            set_at: row.set_at,
            set_by: row.set_by ? plainRef(row.set_by, 60) : null,
          }
        : null,
    standing: standingOf(tally, mode),
    thresholds: { rejected_more_than: REJECTION_COUNT, percent_more_than: REJECTION_PERCENT },
    recent: recent.results,
    resolved_from: resolvedFrom,
  };
}

export function parseLogin(raw: string): string {
  if (!LOGIN.test(raw)) {
    throw new QueueError(400, "bad_login", "That is not a GitHub login.");
  }
  return raw;
}

interface ResolvedAuthor {
  id: number;
  login: string;
  from: ContributorStanding["resolved_from"];
}

/** The numeric id and canonical login GitHub holds for a login now, or a reason it cannot say. */
async function resolveAtGitHub(
  env: Bindings,
  login: string,
): Promise<ResolvedAuthor | { missing: true } | { failed: true }> {
  try {
    const { token, refresh } = await getDatasetsTokenWithRefresher(env);
    const res = await githubFetchWithRetry(
      `${GITHUB_API()}/users/${encodeURIComponent(login)}`,
      { headers: ghHeaders(token), signal: AbortSignal.timeout(LIVE_TIMEOUT_MS) },
      {
        kind: "interactive",
        maxAttempts: 2,
        maxThrottleMs: MAX_THROTTLE_MS,
        refreshTokenOn401: refresh,
      },
    );
    if (res.status === 404) return { missing: true };
    if (!res.ok) return { failed: true };
    const u = rec(await res.json().catch(() => null));
    if (
      typeof u?.id !== "number" ||
      !Number.isSafeInteger(u.id) ||
      u.id <= 0 ||
      typeof u.login !== "string" ||
      !LOGIN.test(u.login)
    ) {
      return { failed: true };
    }
    if (u.type !== "User") {
      throw new QueueError(
        422,
        "not_a_user",
        `${u.login} is a GitHub ${sanitizeNote(u.type, 20) || "account"}, not a person. Reviews are counted per person.`,
      );
    }
    return { id: u.id, login: u.login, from: "github" };
  } catch (err) {
    if (err instanceof QueueError) throw err;
    console.error(`[pr-queue] user lookup failed (${errMessage(err)})`);
    return { failed: true };
  }
}

/** A login the Worker already knows from an override or a review, for when GitHub cannot say. */
async function resolveInHistory(
  db: D1Database,
  login: string,
  prefer: "override" | "review",
): Promise<ResolvedAuthor | null> {
  const row = await db
    .prepare(
      `SELECT author_id, author_login FROM (
         SELECT author_id, author_login, ${prefer === "override" ? 1 : 2} AS pri, set_at AS ts
           FROM pr_review_overrides WHERE lower(author_login) = lower(?)
         UNION ALL
         SELECT author_id, author_login, ${prefer === "override" ? 2 : 1} AS pri, created_at AS ts
           FROM pr_reviews WHERE lower(author_login) = lower(?)
       ) ORDER BY pri, ts DESC LIMIT 1`,
    )
    .bind(login, login)
    .first<{ author_id: number; author_login: string }>();
  return row ? { id: row.author_id, login: plainRef(row.author_login, 39), from: "history" } : null;
}

/**
 * `reading`: GitHub first, then the history (a closed or renamed account still has one).
 * `writing`: GitHub only. An override binds to an id, and an id inferred from a stored login could
 * belong to someone else after a rename.
 * `clearing`: the override's own stored login first, so a row for an account GitHub no longer has
 * can still be removed, then GitHub.
 */
export async function resolveAuthor(
  env: Bindings,
  loginRaw: string,
  purpose: "reading" | "writing" | "clearing",
): Promise<ResolvedAuthor> {
  const login = parseLogin(loginRaw);
  if (purpose === "clearing") {
    const own = await env.DB.prepare(
      "SELECT author_id, author_login FROM pr_review_overrides WHERE lower(author_login) = lower(?)",
    )
      .bind(login)
      .first<{ author_id: number; author_login: string }>();
    if (own) return { id: own.author_id, login: plainRef(own.author_login, 39), from: "history" };
  }
  const at = await resolveAtGitHub(env, login);
  if ("id" in at) return at;
  if (purpose !== "writing") {
    const known = await resolveInHistory(
      env.DB,
      login,
      purpose === "reading" ? "review" : "override",
    );
    if (known) return known;
  }
  if ("missing" in at) {
    throw new QueueError(404, "no_such_user", `GitHub has no user called ${login}.`);
  }
  throw new QueueError(
    502,
    "github_unavailable",
    purpose === "writing"
      ? `GitHub could not confirm ${login}, and a decision about a contributor is only recorded against an id GitHub confirms. Try again.`
      : `GitHub could not be asked about ${login}, and the Worker has no record of them.`,
  );
}

export async function readContributor(env: Bindings, login: string): Promise<ContributorStanding> {
  const who = await resolveAuthor(env, login, "reading");
  return standingFor(env.DB, who.login, who.id, who.from);
}

export async function setOverride(
  env: Bindings,
  adminUserId: number,
  login: string,
  mode: "allow" | "block",
  reasonRaw: string | undefined,
): Promise<SetOverrideResponse> {
  const who = await resolveAuthor(env, login, "writing");
  const previous = await readAuthorOverride(env.DB, who.id);
  const reason = sanitizeNote(reasonRaw, 200) || null;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO pr_review_overrides (author_id, author_login, mode, reason, set_by)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (author_id) DO UPDATE SET
           author_login = excluded.author_login, mode = excluded.mode, reason = excluded.reason,
           set_by = excluded.set_by, set_at = datetime('now')`,
    ).bind(who.id, who.login, mode, reason, adminUserId),
    auditLogStatement(env.DB, {
      userId: adminUserId,
      action: "pr_review_override_set",
      resourceType: "pr_review_author",
      resourceId: String(who.id),
      details: JSON.stringify({ login: who.login, mode, previous, reason }),
    }),
  ]);
  return {
    environment: environmentName(env),
    previous,
    standing: await standingFor(env.DB, who.login, who.id, who.from),
  };
}

export async function clearOverride(
  env: Bindings,
  adminUserId: number,
  login: string,
): Promise<ClearOverrideResponse> {
  const who = await resolveAuthor(env, login, "clearing");
  const previous = await readAuthorOverride(env.DB, who.id);
  if (previous !== null) {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM pr_review_overrides WHERE author_id = ?").bind(who.id),
      auditLogStatement(env.DB, {
        userId: adminUserId,
        action: "pr_review_override_clear",
        resourceType: "pr_review_author",
        resourceId: String(who.id),
        details: JSON.stringify({ login: who.login, removed: previous }),
      }),
    ]);
  }
  return {
    environment: environmentName(env),
    removed: previous,
    standing: await standingFor(env.DB, who.login, who.id, who.from),
  };
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message.slice(0, 160) : "unknown";
}
