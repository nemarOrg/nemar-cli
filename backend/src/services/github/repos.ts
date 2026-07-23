/**
 * Repository lifecycle: create/delete, visibility, description, default and
 * main branch management, auto-merge, org repo listing, username validation.
 *
 * Moved verbatim from services/github.ts (#906, epic #902); the only
 * intentional changes are import paths.
 */

import { GITHUB_API, ORG_NAME, ghHeaders } from "./shared";
import { githubFetchWithRetry } from "./transport";

interface GitHubUser {
  id: number;
  login: string;
  name: string | null;
}

export interface GitHubRepo {
  id: number;
  name: string;
  full_name: string;
  html_url: string;
  clone_url: string;
  ssh_url: string;
}

/**
 * Validate that a GitHub username exists
 */
export async function validateGitHubUsername(
  username: string,
  pat: string,
): Promise<GitHubUser | null> {
  const response = await fetch(`${GITHUB_API()}/users/${username}`, {
    headers: {
      Authorization: `Bearer ${pat}`,
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "NEMAR-API",
    },
  });

  if (!response.ok) {
    return null;
  }

  return response.json();
}

/**
 * List all repositories in the nemarDatasets org
 */
export async function listOrgRepos(pat: string): Promise<GitHubRepo[]> {
  const repos: GitHubRepo[] = [];
  let page = 1;

  while (true) {
    const response = await fetch(
      `${GITHUB_API()}/orgs/${ORG_NAME}/repos?per_page=100&page=${page}`,
      {
        headers: {
          Authorization: `Bearer ${pat}`,
          Accept: "application/vnd.github.v3+json",
          "User-Agent": "NEMAR-API",
        },
      },
    );

    if (!response.ok) {
      throw new Error(`Failed to list repos: ${response.status}`);
    }

    const pageRepos = await response.json<GitHubRepo[]>();
    if (pageRepos.length === 0) break;

    repos.push(...pageRepos);
    page++;
  }

  return repos;
}

/**
 * GitHub rejects a repo `description` containing control characters with a 422
 * ("description control characters are not allowed") -- some OpenNeuro dataset
 * descriptions carry stray newlines/tabs/control bytes, which crashed the
 * onboard import at repo-create (e.g. ds005815). A repo description is a
 * single-line cosmetic field, so collapse all control chars (incl. tab/newline)
 * to spaces, squeeze runs, trim, and cap at GitHub's ~350-char limit. This is
 * the GitHub-side label only; the dataset's real description is untouched.
 */
export function sanitizeRepoDescription(description: string): string {
  const cleaned = description
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control chars is the point
    .replace(/[\u0000-\u001F\u007F]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length > 350 ? `${cleaned.slice(0, 349)}…` : cleaned;
}

export async function createRepository(
  name: string,
  description: string,
  isPrivate: boolean,
  pat: string,
): Promise<GitHubRepo> {
  const response = await fetch(`${GITHUB_API()}/orgs/${ORG_NAME}/repos`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${pat}`,
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "NEMAR-API",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name,
      description: sanitizeRepoDescription(description),
      private: isPrivate,
      auto_init: false, // We push the first commit from CLI
      has_issues: true,
      has_projects: false,
      has_wiki: false,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to create repo: ${error}`);
  }

  return response.json();
}

/**
 * Delete a repository from the nemarDatasets organization.
 * Idempotent: returns true if the repo was deleted or did not exist.
 * Requires a PAT with `delete_repo` scope.
 */
export async function deleteRepository(repo: string, pat: string): Promise<boolean> {
  if (!repo || repo.includes("/") || repo.includes("..")) {
    throw new Error(`Invalid repository name: "${repo}"`);
  }

  const response = await fetch(`${GITHUB_API()}/repos/${ORG_NAME}/${repo}`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${pat}`,
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "NEMAR-API",
    },
  });

  // 204 = deleted, 404 = already gone (both are success)
  if (response.status === 204 || response.status === 404) {
    return true;
  }

  const error = await response.text();
  throw new Error(`Failed to delete repo ${repo}: HTTP ${response.status} - ${error}`);
}

/**
 * Ensure a dataset repo's default branch is "main".
 *
 * Checks the repo's default branch via the GitHub API. If it is not "main",
 * renames it using the branch rename endpoint. This handles repos created
 * with DataLad (adjusted/master(unlocked)) or older git defaults (master).
 *
 * Safe to call multiple times (no-op if already "main").
 */
export async function ensureMainBranch(
  repo: string,
  pat: string,
): Promise<{ renamed: boolean; previousBranch?: string }> {
  const repoResponse = await fetch(`${GITHUB_API()}/repos/${ORG_NAME}/${repo}`, {
    headers: {
      Authorization: `Bearer ${pat}`,
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "NEMAR-API",
    },
  });

  if (!repoResponse.ok) {
    const body = await repoResponse.text().catch(() => "");
    throw new Error(`Failed to fetch repo info for ${repo}: ${repoResponse.status} ${body}`);
  }

  const repoData = (await repoResponse.json()) as { default_branch: string };
  const defaultBranch = repoData.default_branch;

  if (defaultBranch === "main") {
    return { renamed: false };
  }

  console.log(`Renaming default branch "${defaultBranch}" to "main" for ${repo}`);

  const renameResponse = await fetch(
    `${GITHUB_API()}/repos/${ORG_NAME}/${repo}/branches/${encodeURIComponent(defaultBranch)}/rename`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${pat}`,
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "NEMAR-API",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ new_name: "main" }),
    },
  );

  if (!renameResponse.ok) {
    const errorBody = await renameResponse.text();
    throw new Error(
      `Failed to rename branch "${defaultBranch}" to "main" for ${repo}: ${renameResponse.status} ${errorBody}`,
    );
  }

  return { renamed: true, previousBranch: defaultBranch };
}

/**
 * Enable auto-merge for a repository
 */
export async function enableAutoMerge(repo: string, pat: string): Promise<boolean> {
  const response = await fetch(`${GITHUB_API()}/repos/${ORG_NAME}/${repo}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${pat}`,
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "NEMAR-API",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      allow_auto_merge: true,
    }),
  });

  return response.ok;
}

/**
 * Set repository visibility (public or private)
 */
export async function setRepoVisibility(
  repo: string,
  isPrivate: boolean,
  pat: string,
): Promise<{ ok: boolean; status: number; error?: string }> {
  let response: Response;
  try {
    response = await fetch(`${GITHUB_API()}/repos/${ORG_NAME}/${repo}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${pat}`,
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "NEMAR-API",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ private: isPrivate }),
    });
  } catch (fetchError) {
    const msg = fetchError instanceof Error ? fetchError.message : String(fetchError);
    return { ok: false, status: 0, error: `Network error: ${msg}` };
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    return { ok: false, status: response.status, error: body || `HTTP ${response.status}` };
  }
  return { ok: true, status: response.status };
}

export async function setRepoDescription(
  repo: string,
  description: string,
  pat: string,
  homepage?: string,
): Promise<{ ok: boolean; status: number; error?: string }> {
  let response: Response;
  try {
    // Sanitize for the same 422 createRepository guards against: callers pass a
    // BIDS Name / dataset name that can carry control chars (enrich-dataset,
    // publish-approval), which GitHub rejects on PATCH too.
    const payload: { description: string; homepage?: string } = {
      description: sanitizeRepoDescription(description),
    };
    if (homepage !== undefined) payload.homepage = homepage;
    response = await fetch(`${GITHUB_API()}/repos/${ORG_NAME}/${repo}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${pat}`,
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "NEMAR-API",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
  } catch (fetchError) {
    const msg = fetchError instanceof Error ? fetchError.message : String(fetchError);
    return { ok: false, status: 0, error: `Network error: ${msg}` };
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    return { ok: false, status: response.status, error: body || `HTTP ${response.status}` };
  }
  return { ok: true, status: response.status };
}

/** A repo's default branch (defaults to "main" if it can't be read). */
export async function getRepoDefaultBranch(repo: string, pat: string): Promise<string> {
  const r = await githubFetchWithRetry(
    `${GITHUB_API()}/repos/${ORG_NAME}/${repo}`,
    { headers: ghHeaders(pat) },
    { retryOn404: true },
  );
  if (!r.ok) return "main";
  const info = (await r.json()) as { default_branch?: string };
  return info.default_branch || "main";
}
