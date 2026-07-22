/**
 * GitHub Issues API: list-by-label (used for dedup lookup), create, comment.
 *
 * First consumer is the import-failure auto-filer (services/import-failure-issue.ts,
 * epic #967 follow-up), which files issues on the central `nemarDatasets/.github`
 * repo. Deliberately uses the issues-by-label LIST endpoint rather than the
 * Search API for dedup lookups: Search has its own rate-limit bucket and lags
 * behind writes (eventual consistency), and the import-failure label's volume
 * is small enough that paging the label listing is cheap and immediately
 * consistent.
 */

import { GITHUB_API, ghHeaders } from "./shared";
import { githubFetchWithRetry } from "./transport";

export interface GitHubIssue {
  number: number;
  html_url: string;
  state: string;
  title: string;
}

/**
 * Find an OPEN issue in `repo` carrying `label` whose title exactly matches
 * `title`. Pages through the label listing (state=open) until a match is
 * found or the listing is exhausted. Returns null on no match.
 */
export async function findOpenIssueByTitle(
  repo: string,
  label: string,
  title: string,
  pat: string,
): Promise<GitHubIssue | null> {
  let page = 1;
  while (true) {
    const response = await githubFetchWithRetry(
      `${GITHUB_API()}/repos/${repo}/issues?state=open&labels=${encodeURIComponent(label)}&per_page=100&page=${page}`,
      { headers: ghHeaders(pat) },
    );
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to list issues on ${repo}: HTTP ${response.status} - ${error}`);
    }
    const issues = await response.json<GitHubIssue[]>();
    const match = issues.find((issue) => issue.title === title);
    if (match) return match;
    if (issues.length < 100) return null; // last page
    page++;
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
