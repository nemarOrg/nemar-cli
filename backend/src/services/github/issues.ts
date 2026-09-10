/**
 * GitHub Issues API: list-by-label (for dedup lookup and for the triage sweep),
 * create, comment, close, and label replacement.
 *
 * First consumer is the import-failure auto-filer (services/import-failure-issue.ts,
 * epic #967 follow-up), which files issues on the central `nemarDatasets/.github`
 * repo. Deliberately uses the issues-by-label LIST endpoint rather than the
 * Search API for dedup lookups: Search has its own rate-limit bucket and lags
 * behind writes (eventual consistency), and the import-failure label's volume
 * is small enough that paging the label listing is cheap and immediately
 * consistent.
 *
 * The endpoint returns pull requests as well as issues -- every PR is an issue
 * to this API -- but only if they carry the requested label, which none of the
 * labels here is ever applied to a PR. `listOpenIssuesByLabel` is therefore not
 * filtered on `pull_request`; a caller using a label a human also puts on PRs
 * would need to.
 *
 * `closeIssue`/`setIssueLabels` arrived with epic #1306 phase 2, which gave the
 * tracker a way to drain: before them nothing could close an issue or retire a
 * stale cause label, so issues accumulated and none was ever closed (ADR 0052
 * records the count and the date it was measured).
 */

import { GITHUB_API, ghHeaders } from "./shared";
import { githubFetchWithRetry } from "./transport";

export interface GitHubIssue {
  number: number;
  html_url: string;
  state: string;
  title: string;
  /** Present on list/get responses. Optional because callers that only need the
   *  number or title must not be forced to care, and because a hand-built
   *  fixture should not have to invent one. */
  labels?: { name: string }[];
}

/** The label names on an issue, tolerating a response that omitted them. */
export function issueLabelNames(issue: GitHubIssue): string[] {
  return (issue.labels ?? []).map((l) => l.name);
}

/**
 * Every OPEN issue in `repo` carrying `label`, paged.
 *
 * This module's only listing primitive -- `services/enrich-dataset.ts` has its
 * own uncapped inline `fetch` for the `metadata` label, so the page cap below is
 * not a property of issue listing in general. A `findOpenIssueByTitle` used to
 * sit beside this one, stopping early at a title match; epic #1306 phase 2
 * removed it, because every caller now needs the whole set anyway (to count it
 * and decide the filing mode) and a title match over the returned array is one
 * line.
 *
 * Pagination is capped, so a backlog of open labelled issues cannot turn a
 * lookup into an unbounded scan -- each page is a GitHub subrequest. 20 pages x
 * 100 = 2000 open issues of one label, far beyond any realistic backlog.
 * Hitting the cap THROWS rather than reporting what it has: a truncated listing
 * would undercount, which could wrongly release the rollup mode or miss an
 * existing issue and duplicate it. Refusing to answer is the honest failure.
 */
export async function listOpenIssuesByLabel(
  repo: string,
  label: string,
  pat: string,
): Promise<GitHubIssue[]> {
  const MAX_PAGES = 20;
  const all: GitHubIssue[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const response = await githubFetchWithRetry(
      `${GITHUB_API()}/repos/${repo}/issues?state=open&labels=${encodeURIComponent(label)}&per_page=100&page=${page}`,
      { headers: ghHeaders(pat) },
    );
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to list issues on ${repo}: HTTP ${response.status} - ${error}`);
    }
    const issues = await response.json<GitHubIssue[]>();
    all.push(...issues);
    if (issues.length < 100) return all;
  }
  throw new Error(
    `Listing ${label} issues on ${repo} exceeded ${MAX_PAGES} pages; refusing to report a truncated set`,
  );
}

/**
 * Close an issue. Idempotent on GitHub's side: closing a closed issue is a no-op
 * 200.
 *
 * That is a property of THIS call, not of a caller's whole sequence --
 * `addIssueComment` is not idempotent, so a caller that pairs the two has to
 * order them so a retry cannot duplicate the comment. `applyOneIssue` in
 * services/import-issue-sweep.ts closes first for exactly that reason.
 */
export async function closeIssue(repo: string, issueNumber: number, pat: string): Promise<void> {
  const response = await githubFetchWithRetry(
    `${GITHUB_API()}/repos/${repo}/issues/${issueNumber}`,
    {
      method: "PATCH",
      headers: { ...ghHeaders(pat), "Content-Type": "application/json" },
      body: JSON.stringify({ state: "closed" }),
    },
  );
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to close ${repo}#${issueNumber}: HTTP ${response.status} - ${error}`);
  }
}

/**
 * Rewrite an issue's title and/or body in place.
 *
 * Arrived with epic #1306 phase 3 (#1311), for the ONE standing coverage issue
 * whose numbers change every run. A comment per run would be the unbounded
 * accrual this epic exists to stop, so the current state lives in the body and is
 * overwritten there; comments are reserved for transitions.
 *
 * Only the fields actually supplied are sent, so this cannot blank a body by
 * omission. An empty patch throws rather than spending a request that changes
 * nothing -- it would mean the caller's own diffing is broken.
 */
export async function updateIssue(
  repo: string,
  issueNumber: number,
  fields: { title?: string; body?: string },
  pat: string,
): Promise<void> {
  const payload: { title?: string; body?: string } = {};
  if (fields.title !== undefined) payload.title = fields.title;
  if (fields.body !== undefined) payload.body = fields.body;
  if (Object.keys(payload).length === 0) {
    throw new Error(`updateIssue called for ${repo}#${issueNumber} with no fields to change`);
  }

  const response = await githubFetchWithRetry(
    `${GITHUB_API()}/repos/${repo}/issues/${issueNumber}`,
    {
      method: "PATCH",
      headers: { ...ghHeaders(pat), "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
  );
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to update ${repo}#${issueNumber}: HTTP ${response.status} - ${error}`);
  }
}

/**
 * REPLACE an issue's labels with `labels`.
 *
 * A full replace, not an add: the caller decides the whole set, because
 * relabelling means retiring the old cause label as well as applying the new
 * one. Callers must therefore include every label they intend to keep --
 * `computeLabelUpdate` in services/import-issue-accrual.ts is what builds that
 * set, preserving labels it does not own.
 */
export async function setIssueLabels(
  repo: string,
  issueNumber: number,
  labels: string[],
  pat: string,
): Promise<void> {
  const response = await githubFetchWithRetry(
    `${GITHUB_API()}/repos/${repo}/issues/${issueNumber}/labels`,
    {
      method: "PUT",
      headers: { ...ghHeaders(pat), "Content-Type": "application/json" },
      body: JSON.stringify({ labels }),
    },
  );
  if (!response.ok) {
    const error = await response.text();
    throw new Error(
      `Failed to set labels on ${repo}#${issueNumber}: HTTP ${response.status} - ${error}`,
    );
  }
}

/** Create an issue on `repo` with `labels`. */
export async function createIssue(
  repo: string,
  title: string,
  body: string,
  labels: string[],
  pat: string,
): Promise<GitHubIssue> {
  const response = await githubFetchWithRetry(`${GITHUB_API()}/repos/${repo}/issues`, {
    method: "POST",
    headers: { ...ghHeaders(pat), "Content-Type": "application/json" },
    body: JSON.stringify({ title, body, labels }),
  });
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to create issue on ${repo}: HTTP ${response.status} - ${error}`);
  }
  return response.json();
}

/** Add a comment to an existing issue. */
export async function addIssueComment(
  repo: string,
  issueNumber: number,
  body: string,
  pat: string,
): Promise<void> {
  const response = await githubFetchWithRetry(
    `${GITHUB_API()}/repos/${repo}/issues/${issueNumber}/comments`,
    {
      method: "POST",
      headers: { ...ghHeaders(pat), "Content-Type": "application/json" },
      body: JSON.stringify({ body }),
    },
  );
  if (!response.ok) {
    const error = await response.text();
    throw new Error(
      `Failed to comment on ${repo}#${issueNumber}: HTTP ${response.status} - ${error}`,
    );
  }
}
