/**
 * GitHub API service
 *
 * Handles GitHub operations: validating usernames, managing collaborators,
 * creating/deleting repositories, and applying branch protection.
 */

import { HttpError } from "./retry";

// NEMAR_GITHUB_API_URL is a test-only override that points at a local
// Bun.serve fake. Stored on globalThis because the Workers runtime has no
// `process.env`; read at call time so test helpers can install the override
// after the module has loaded.
function GITHUB_API(): string {
  const override = (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL;
  return override ?? "https://api.github.com";
}
// Dataset repos (nm000XXX) live in nemarDatasets org; tooling repos live in nemarOrg
const ORG_NAME = "nemarDatasets";

/** Identity used for all backend-initiated commits and tags on dataset repos. */
const NEMAR_COMMITTER = { name: "nemarAdmin", email: "nemarAdmin@osc.earth" };

// ============================================================================
// Rate limit instrumentation
// ============================================================================

interface RateLimitSnapshot {
  resource: string;
  remaining: number;
  resetEpoch: number;
  limit?: number;
}

// Most recent rate-limit snapshot per resource bucket. Workers isolates relearn
// from the first response after a cold start, which is fine: the cache is a
// hint, not a correctness constraint.
const rateLimitState: Map<string, RateLimitSnapshot> = new Map();

export function __resetRateLimitStateForTests(): void {
  rateLimitState.clear();
}

export function __seedRateLimitStateForTests(snapshot: RateLimitSnapshot): void {
  rateLimitState.set(snapshot.resource, snapshot);
}

function parseRateLimitHeaders(res: Response): RateLimitSnapshot | null {
  const remainingRaw = res.headers.get("X-RateLimit-Remaining");
  const resetRaw = res.headers.get("X-RateLimit-Reset");
  if (remainingRaw === null || resetRaw === null) return null;
  const remaining = Number.parseInt(remainingRaw, 10);
  const resetEpoch = Number.parseInt(resetRaw, 10);
  if (!Number.isFinite(remaining) || !Number.isFinite(resetEpoch)) return null;
  const resource = res.headers.get("X-RateLimit-Resource") ?? "core";
  const limitRaw = res.headers.get("X-RateLimit-Limit");
  const limitParsed = limitRaw === null ? Number.NaN : Number.parseInt(limitRaw, 10);
  return {
    resource,
    remaining,
    resetEpoch,
    limit: Number.isFinite(limitParsed) ? limitParsed : undefined,
  };
}

function parseRetryAfter(headerValue: string | null): number | null {
  if (headerValue === null) return null;
  const trimmed = headerValue.trim();
  if (trimmed === "") return null;
  // Integer seconds form. Re-stringify to reject mixed inputs like "10abc".
  const asInt = Number.parseInt(trimmed, 10);
  if (Number.isFinite(asInt) && String(asInt) === trimmed) {
    return Math.max(0, asInt * 1000);
  }
  const asDate = Date.parse(trimmed);
  if (!Number.isNaN(asDate)) {
    return Math.max(0, asDate - Date.now());
  }
  return null;
}

function isSecondaryRateLimit(status: number, bodySnippet: string): boolean {
  if (status !== 403) return false;
  return /secondary rate limit/i.test(bodySnippet);
}

interface RateLimitLogFields {
  method: string;
  path: string;
  status: number;
  attempt: number;
  maxAttempts: number;
  snapshot: RateLimitSnapshot | null;
  retryAfterMs: number | null;
  secondary: boolean;
}

function emitRateLimitLog(fields: RateLimitLogFields): void {
  const line: Record<string, unknown> = {
    tag: "github-rl",
    method: fields.method,
    path: fields.path,
    status: fields.status,
    attempt: fields.attempt,
    maxAttempts: fields.maxAttempts,
  };
  if (fields.snapshot) {
    line.resource = fields.snapshot.resource;
    line.remaining = fields.snapshot.remaining;
    line.resetEpoch = fields.snapshot.resetEpoch;
    if (fields.snapshot.limit !== undefined) line.limit = fields.snapshot.limit;
  }
  if (fields.retryAfterMs !== null) line.retryAfterMs = fields.retryAfterMs;
  if (fields.secondary) line.secondary = true;
  console.log(JSON.stringify(line));
}

async function defaultSleep(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch with retry for transient failures, with GitHub rate-limit awareness.
 *
 * Retries on:
 *   - Network/transport errors (fetch throws)
 *   - HTTP 5xx and 429
 *   - HTTP 403 carrying a "secondary rate limit" body
 *   - HTTP 404 (only when retryOn404=true): GitHub may briefly 404 a freshly
 *     created/changed resource (repo flip, branch/tag write, ruleset endpoint)
 *     while caches catch up. Caller opts in only where 404 is never legitimate.
 *
 * Does NOT retry on other 4xx: those are validation/auth errors that won't
 * change on retry.
 *
 * On exhausted retries with a still-transient HTTP response, returns the
 * final response (`response.ok === false`); the caller decides what to do
 * based on `response.status`. Only thrown errors (network failure or
 * pre-flight interactive throttle) propagate as exceptions.
 *
 * Rate-limit behavior:
 *   - Honors `Retry-After` for the wait between retries, capped by
 *     `maxThrottleMs`. Falls back to `delayMs` only when the response
 *     carried no `Retry-After`.
 *   - Inspects `X-RateLimit-Remaining`/`Reset`/`Resource` on every response
 *     and caches the most recent snapshot per bucket. On the next call, if
 *     `remaining < lowRemainingThreshold` and the bucket hasn't reset yet:
 *       - `kind: "background"` (default): sleep min(timeUntilReset, maxThrottleMs).
 *       - `kind: "interactive"`: throw HttpError(503) with a clear message.
 *   - Emits one JSON line per request tagged `"github-rl"` for Cloudflare Logs.
 */
export async function githubFetchWithRetry(
  url: string,
  init: RequestInit,
  options?: {
    maxAttempts?: number;
    delayMs?: number;
    retryOn404?: boolean;
    kind?: "background" | "interactive";
    lowRemainingThreshold?: number;
    maxThrottleMs?: number;
    sleepFn?: (ms: number) => Promise<void>;
  },
): Promise<Response> {
  const maxAttempts = options?.maxAttempts ?? 3;
  const delayMs = options?.delayMs ?? 1_000;
  const retryOn404 = options?.retryOn404 ?? false;
  const kind = options?.kind ?? "background";
  const lowRemainingThreshold = options?.lowRemainingThreshold ?? 50;
  const maxThrottleMs = options?.maxThrottleMs ?? 60_000;
  const sleep = options?.sleepFn ?? defaultSleep;

  let parsedPath = url;
  try {
    parsedPath = new URL(url).pathname;
  } catch {
    // keep raw url for log; non-fatal
  }
  const method = init.method ?? "GET";

  // Pre-flight throttle on the "core" bucket (the only one we exercise in
  // bursty workloads). We can't know the target bucket before the first
  // response, so this is best-effort against a stale snapshot.
  const cached = rateLimitState.get("core");
  if (cached && cached.remaining < lowRemainingThreshold) {
    const msUntilReset = cached.resetEpoch * 1000 - Date.now();
    if (msUntilReset > 0) {
      const secondsUntilReset = Math.ceil(msUntilReset / 1000);
      if (kind === "interactive") {
        throw new HttpError(
          `GitHub rate limit nearly exhausted (remaining=${cached.remaining}); retry in ${secondsUntilReset}s`,
          503,
        );
      }
      const sleepMs = Math.min(msUntilReset, maxThrottleMs);
      if (sleepMs < msUntilReset) {
        console.warn(
          `[github] pre-flight throttle: reset in ${secondsUntilReset}s exceeds cap ${maxThrottleMs}ms; sleeping ${sleepMs}ms then proceeding`,
        );
      } else {
        console.warn(
          `[github] pre-flight throttle: remaining=${cached.remaining} < ${lowRemainingThreshold}; sleeping ${sleepMs}ms until bucket resets`,
        );
      }
      await sleep(sleepMs);
    }
  }

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await fetch(url, init);

      const snapshot = parseRateLimitHeaders(response);
      if (snapshot) {
        // Monotonic write: a delayed older response shouldn't overwrite a
        // fresher snapshot from a concurrent in-flight request.
        const existing = rateLimitState.get(snapshot.resource);
        if (!existing || snapshot.resetEpoch >= existing.resetEpoch) {
          rateLimitState.set(snapshot.resource, snapshot);
        }
      }

      const retryAfterMs = parseRetryAfter(response.headers.get("Retry-After"));

      let secondary = false;
      if (response.status === 403) {
        let bodySnippet = "";
        let bodyReadFailed = false;
        try {
          bodySnippet = await response.clone().text();
        } catch {
          bodyReadFailed = true;
        }
        // Fail safe: if we can't read the body on a 403, assume secondary
        // rate limit and retry. Treating it as a terminal auth 403 here
        // would burn the secondary cool-down window and surface a
        // misleading "permission denied" upstream. Retrying is the
        // cheaper mistake.
        secondary = bodyReadFailed || isSecondaryRateLimit(response.status, bodySnippet);
        if (bodyReadFailed) {
          console.warn(
            `[github] ${method} ${parsedPath} 403 body unreadable; treating as secondary rate limit (fail-safe)`,
          );
        }
      }

      emitRateLimitLog({
        method,
        path: parsedPath,
        status: response.status,
        attempt,
        maxAttempts,
        snapshot,
        retryAfterMs,
        secondary,
      });

      const transient =
        response.status >= 500 ||
        response.status === 429 ||
        secondary ||
        (retryOn404 && response.status === 404);

      if (transient && attempt < maxAttempts) {
        const waitMs = retryAfterMs !== null ? Math.min(retryAfterMs, maxThrottleMs) : delayMs;
        console.warn(
          `[github] ${method} ${parsedPath} attempt ${attempt} -> HTTP ${response.status}${secondary ? " (secondary rate limit)" : ""}, retrying in ${waitMs}ms`,
        );
        await sleep(waitMs);
        continue;
      }
      return response;
    } catch (err) {
      lastError = err;
      if (attempt < maxAttempts) {
        console.warn(
          `[github] ${method} ${parsedPath} attempt ${attempt} threw (${err instanceof Error ? err.message : String(err)}), retrying in ${delayMs}ms`,
        );
        await sleep(delayMs);
        continue;
      }
      throw err;
    }
  }
  throw lastError ?? new Error("githubFetchWithRetry: exhausted attempts");
}

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
 * Add a user as collaborator to a repository
 */
export async function addCollaborator(
  repo: string,
  username: string,
  permission: "pull" | "push" | "maintain" | "admin",
  pat: string,
): Promise<boolean> {
  const response = await fetch(
    `${GITHUB_API()}/repos/${ORG_NAME}/${repo}/collaborators/${username}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${pat}`,
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "NEMAR-API",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ permission }),
    },
  );

  return response.ok || response.status === 204;
}

/**
 * Remove a user as collaborator from a repository
 */
export async function removeCollaborator(
  repo: string,
  username: string,
  pat: string,
): Promise<boolean> {
  const response = await fetch(
    `${GITHUB_API()}/repos/${ORG_NAME}/${repo}/collaborators/${username}`,
    {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${pat}`,
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "NEMAR-API",
      },
    },
  );

  return response.ok || response.status === 204;
}

/**
 * Add user as collaborator to ALL org repositories
 */
export async function addCollaboratorToAllRepos(
  username: string,
  pat: string,
): Promise<{ count: number; errors: string[] }> {
  const repos = await listOrgRepos(pat);
  const errors: string[] = [];
  let count = 0;

  for (const repo of repos) {
    // Skip special repos
    if (repo.name === ".github") continue;

    const success = await addCollaborator(repo.name, username, "push", pat);
    if (success) {
      count++;
    } else {
      errors.push(repo.name);
    }
  }

  return { count, errors };
}

/**
 * Remove user as collaborator from ALL org repositories
 */
export async function removeCollaboratorFromAllRepos(
  username: string,
  pat: string,
): Promise<{ count: number; errors: string[] }> {
  const repos = await listOrgRepos(pat);
  const errors: string[] = [];
  let count = 0;

  for (const repo of repos) {
    const success = await removeCollaborator(repo.name, username, pat);
    if (success) {
      count++;
    } else {
      errors.push(repo.name);
    }
  }

  return { count, errors };
}

/**
 * Create a new repository in the org
 */
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
      description,
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
 * Apply branch protection rules to main branch
 *
 * Configuration:
 * - Owner can self-merge (no external approval required)
 * - BIDS validation and version check must pass
 * - Admins can bypass if needed
 * - No force pushes or deletions
 */
export async function applyBranchProtection(repo: string, pat: string): Promise<boolean> {
  const response = await fetch(
    `${GITHUB_API()}/repos/${ORG_NAME}/${repo}/branches/main/protection`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${pat}`,
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "NEMAR-API",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        required_pull_request_reviews: {
          required_approving_review_count: 0, // Owner can self-merge
          dismiss_stale_reviews: true,
        },
        enforce_admins: false, // Admins can bypass if needed
        required_status_checks: {
          strict: true,
          contexts: ["bids-validation", "version-check"],
        },
        restrictions: null,
        allow_force_pushes: false,
        allow_deletions: false,
      }),
    },
  );

  return response.ok;
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
 * Create or update a file in a repository
 */
export async function createOrUpdateFile(
  repo: string,
  path: string,
  content: string,
  message: string,
  pat: string,
): Promise<void> {
  // First, try to get the file to see if it exists (need SHA for update)
  let sha: string | undefined;
  let getResponse: Response;
  try {
    getResponse = await fetch(`${GITHUB_API()}/repos/${ORG_NAME}/${repo}/contents/${path}`, {
      headers: {
        Authorization: `Bearer ${pat}`,
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "NEMAR-API",
      },
    });
  } catch (err) {
    throw new Error(
      `Network error checking ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (getResponse.ok) {
    const existing = await getResponse.json<{ sha: string }>();
    sha = existing.sha;
  } else if (getResponse.status !== 404) {
    const body = await getResponse.text().catch(() => "");
    throw new Error(`GitHub API error ${getResponse.status} checking ${path}: ${body}`);
  }

  // Create or update the file
  let response: Response;
  try {
    response = await fetch(`${GITHUB_API()}/repos/${ORG_NAME}/${repo}/contents/${path}`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${pat}`,
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "NEMAR-API",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message,
        content: btoa(
          Array.from(new TextEncoder().encode(content), (b) => String.fromCharCode(b)).join(""),
        ),
        ...(sha ? { sha } : {}),
        committer: NEMAR_COMMITTER,
        author: NEMAR_COMMITTER,
      }),
    });
  } catch (err) {
    throw new Error(
      `Network error committing ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!response.ok && response.status !== 201) {
    const body = await response.text().catch(() => "");
    throw new Error(`GitHub API error ${response.status} committing ${path}: ${body}`);
  }
}

/**
 * Delete a file from a repository via the GitHub Contents API.
 */
export async function deleteRepoFile(
  repo: string,
  path: string,
  sha: string,
  message: string,
  pat: string,
): Promise<void> {
  const response = await fetch(`${GITHUB_API()}/repos/${ORG_NAME}/${repo}/contents/${path}`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${pat}`,
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "NEMAR-API",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      message,
      sha,
      committer: NEMAR_COMMITTER,
      author: NEMAR_COMMITTER,
    }),
  });

  if (response.status === 404) return; // already deleted; treat as success
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`GitHub API error ${response.status} deleting ${path}: ${body}`);
  }
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
    const payload: { description: string; homepage?: string } = { description };
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

interface WorkflowRun {
  id: number;
  status: string;
  conclusion: string | null;
  created_at: string;
  html_url: string;
}

/**
 * Check if a workflow file exists in a repository.
 * Returns true if file exists, false if 404, throws on other errors.
 */
export async function checkWorkflowExists(
  repo: string,
  workflowPath: string,
  pat: string,
): Promise<boolean> {
  let response: Response;
  try {
    response = await fetch(`${GITHUB_API()}/repos/${ORG_NAME}/${repo}/contents/${workflowPath}`, {
      headers: {
        Authorization: `Bearer ${pat}`,
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "NEMAR-API",
      },
    });
  } catch (fetchError) {
    const msg = fetchError instanceof Error ? fetchError.message : String(fetchError);
    throw new Error(`Network error checking workflow: ${msg}`);
  }

  if (response.ok) return true;
  if (response.status === 404) return false;
  throw new Error(`GitHub API error (${response.status}) checking workflow: ${workflowPath}`);
}

/**
 * Get the latest workflow runs for a specific workflow file.
 * Throws on API errors; returns empty array only when no runs exist.
 */
export async function getWorkflowRuns(
  repo: string,
  workflowFile: string,
  pat: string,
): Promise<WorkflowRun[]> {
  let response: Response;
  try {
    response = await fetch(
      `${GITHUB_API()}/repos/${ORG_NAME}/${repo}/actions/workflows/${workflowFile}/runs?per_page=5`,
      {
        headers: {
          Authorization: `Bearer ${pat}`,
          Accept: "application/vnd.github.v3+json",
          "User-Agent": "NEMAR-API",
        },
      },
    );
  } catch (fetchError) {
    const msg = fetchError instanceof Error ? fetchError.message : String(fetchError);
    throw new Error(`Network error fetching workflow runs: ${msg}`);
  }

  if (!response.ok) {
    throw new Error(`GitHub API error (${response.status}) fetching runs for ${workflowFile}`);
  }

  const data = await response.json<{ workflow_runs: WorkflowRun[] }>();
  return data.workflow_runs ?? [];
}

/**
 * Deploy GitHub Actions workflow files to a dataset repository
 */
export function getWorkflowTemplates(): Array<{ path: string; content: string }> {
  // BIDS Validation workflow
  const bidsValidation = `name: BIDS Validation

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
  workflow_dispatch:

jobs:
  validate:
    name: bids-validation
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Setup Deno
        uses: denoland/setup-deno@v2
        with:
          deno-version: v2.x

      - name: Run BIDS validator
        run: |
          mkdir -p .nemar
          grep -qxF '.nemar/' .bidsignore 2>/dev/null || echo '.nemar/' >> .bidsignore
          deno run -A jsr:@bids/validator . --json > .nemar/validation.json || true
          cat .nemar/validation.json

      - name: Collect git-annex pointer files
        run: |
          # Find symlinks (annex pointers in locked repos)
          find . -type l -not -path './.git/*' -printf '/%P\\n' > /tmp/annex-files.txt 2>/dev/null || true
          # Find small files with annex pointer content (unlocked repos)
          find . -type f -not -path './.git/*' -size -1k -exec grep -l '^/annex/objects/' {} + 2>/dev/null | sed 's|^\\./|/|' >> /tmp/annex-files.txt || true
          sort -u /tmp/annex-files.txt -o /tmp/annex-files.txt
          ANNEX_COUNT=$(wc -l < /tmp/annex-files.txt | tr -d ' ')
          if [ "$ANNEX_COUNT" -gt 0 ]; then
            echo "Found $ANNEX_COUNT git-annex pointer file(s) (errors from these will be filtered)"
          fi

      - name: Check validation result
        run: |
          if [ ! -f .nemar/validation.json ] || ! jq empty .nemar/validation.json 2>/dev/null; then
            echo "::error::BIDS validator failed to produce valid output"
            exit 1
          fi

          # Convert annex file list to JSON array for jq filtering
          if [ -s /tmp/annex-files.txt ]; then
            jq -R -s 'split("\\n") | map(select(length > 0))' /tmp/annex-files.txt > /tmp/annex-files.json
          else
            echo '[]' > /tmp/annex-files.json
          fi

          # Filter out errors from git-annex pointer files
          REAL_ERRORS=$(jq --slurpfile annexed /tmp/annex-files.json \
            '[.issues.issues[] | select(.severity == "error") | select(.location as $loc | ($annexed[0] | index($loc)) | not)] | length' \
            .nemar/validation.json)
          ANNEX_ERRORS=$(jq --slurpfile annexed /tmp/annex-files.json \
            '[.issues.issues[] | select(.severity == "error") | select(.location as $loc | ($annexed[0] | index($loc)) | . != null)] | length' \
            .nemar/validation.json)

          if [ "$ANNEX_ERRORS" -gt 0 ]; then
            echo "::notice::Skipped $ANNEX_ERRORS error(s) from git-annex pointer files (not real data)"
          fi

          if [ "$REAL_ERRORS" -gt 0 ]; then
            echo "::error::BIDS validation found $REAL_ERRORS error(s)"
            jq --slurpfile annexed /tmp/annex-files.json \
              '[.issues.issues[] | select(.severity == "error") | select(.location as $loc | ($annexed[0] | index($loc)) | not)][]' \
              .nemar/validation.json
            exit 1
          fi
          WARNINGS=$(jq '[.issues.issues[] | select(.severity == "warning")] | length' .nemar/validation.json)
          echo "BIDS validation passed ($WARNINGS warning(s), $ANNEX_ERRORS annex pointer error(s) skipped)"
`;

  // Version Check workflow
  const versionCheck = `name: Version Check

on:
  pull_request:
    branches: [main]

jobs:
  check-version:
    name: version-check
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Check version bump
        run: |
          # Get version from PR branch
          PR_VERSION=$(jq -r '.Version // "0.0.0"' dataset_description.json)

          # Get version from main branch
          git fetch origin main
          git checkout origin/main -- dataset_description.json 2>/dev/null || echo '{}' > dataset_description.json
          MAIN_VERSION=$(jq -r '.Version // "0.0.0"' dataset_description.json)

          # Restore PR version
          git checkout HEAD -- dataset_description.json

          echo "Main version: $MAIN_VERSION"
          echo "PR version: $PR_VERSION"

          if [ "$PR_VERSION" == "$MAIN_VERSION" ]; then
            echo "::error::Version not bumped. Update 'Version' field in dataset_description.json"
            exit 1
          fi

          echo "Version check passed: $MAIN_VERSION -> $PR_VERSION"
`;

  // PR Merge Handler workflow
  const prMerge = `name: PR Merge Handler

on:
  pull_request_target:
    types: [closed]
    branches: [main]

permissions:
  contents: write

jobs:
  create-release:
    name: Create Release
    if: github.event.pull_request.merged == true
    runs-on: ubuntu-latest
    outputs:
      version: \${{ steps.version.outputs.version }}
      release_created: \${{ steps.create_release.outputs.created }}
    steps:
      - uses: actions/checkout@v4

      - name: Get version
        id: version
        run: |
          VERSION=$(jq -r '.Version // "1.0.0"' dataset_description.json)
          echo "version=$VERSION" >> $GITHUB_OUTPUT
          echo "Version: $VERSION"

      - name: Check if tag exists
        id: check_tag
        run: |
          if git rev-parse "v\${{ steps.version.outputs.version }}" >/dev/null 2>&1; then
            echo "exists=true" >> $GITHUB_OUTPUT
          else
            echo "exists=false" >> $GITHUB_OUTPUT
          fi

      - name: Create tag and release
        id: create_release
        if: steps.check_tag.outputs.exists == 'false'
        env:
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          PR_NUMBER: \${{ github.event.pull_request.number }}
        run: |
          git config user.name "GitHub Actions"
          git config user.email "actions@github.com"
          VERSION="\${{ steps.version.outputs.version }}"
          git tag -a "v$VERSION" -m "Release v$VERSION"
          git push origin "v$VERSION"
          gh release create "v$VERSION" --title "v$VERSION" \\
            --notes "Release v$VERSION from PR #\${PR_NUMBER}"
          echo "created=true" >> $GITHUB_OUTPUT

  cleanup-staging:
    name: Cleanup Staging (runs on merge or close)
    if: always()
    runs-on: ubuntu-latest
    steps:
      - name: Remove staging data for this PR/branch
        env:
          AWS_ACCESS_KEY_ID: \${{ secrets.AWS_ACCESS_KEY_ID }}
          AWS_SECRET_ACCESS_KEY: \${{ secrets.AWS_SECRET_ACCESS_KEY }}
          DATASET_ID: \${{ github.event.repository.name }}
          BRANCH: \${{ github.event.pull_request.head.ref }}
          PR_NUMBER: \${{ github.event.pull_request.number }}
        run: |
          # Clean up branch-based staging
          aws s3 rm --recursive "s3://nemar/staging/\${DATASET_ID}/\${BRANCH}/" 2>/dev/null || true
          # Clean up legacy PR-number-based staging
          aws s3 rm --recursive "s3://nemar/staging/pr-\${PR_NUMBER}/" 2>/dev/null || true
`;

  // Generate Archive workflow (triggered via repository_dispatch)
  // Streams files directly from S3 into a zip and uploads via multipart,
  // so disk usage is constant regardless of dataset size.
  const generateArchive = `name: Generate Archive

on:
  repository_dispatch:
    types: [generate-archive]

jobs:
  archive:
    name: Generate Dataset Archive
    runs-on: ubuntu-latest
    env:
      DATASET_ID: \${{ github.event.client_payload.dataset_id }}
      VERSION: \${{ github.event.client_payload.version }}
    steps:
      - name: Validate inputs
        run: |
          if [ -z "\$DATASET_ID" ]; then
            echo "::error::Missing dataset_id in client_payload"
            exit 1
          fi
          if [ -z "\$VERSION" ]; then
            echo "::error::Missing version in client_payload"
            exit 1
          fi

      - uses: actions/checkout@v4
        with:
          ref: v\${{ github.event.client_payload.version }}

      - uses: actions/setup-node@v4
        with:
          node-version: "20"

      - name: Install streaming dependencies
        run: |
          mkdir -p /tmp/archive-deps
          cd /tmp/archive-deps
          npm init -y > /dev/null
          npm install --no-save archiver @aws-sdk/client-s3 @aws-sdk/lib-storage

      - name: Write archive script
        run: |
          cat > /tmp/stream-archive.js << 'ARCHIVE_SCRIPT'
          var fs = require("fs");
          var path = require("path");
          var S3Client = require("@aws-sdk/client-s3").S3Client;
          var Upload = require("@aws-sdk/lib-storage").Upload;
          var archiver = require("archiver");
          var PassThrough = require("stream").PassThrough;
          var https = require("https");
          var http = require("http");

          var DATASET_ID = process.env.DATASET_ID;
          var VERSION = process.env.VERSION;
          var BUCKET = "nemar";
          var REGION = process.env.AWS_DEFAULT_REGION || "us-east-2";
          var S3_BASE = "https://" + BUCKET + ".s3." + REGION + ".amazonaws.com";

          function resolveAnnexKey(filePath) {
            try {
              var stat = fs.lstatSync(filePath);
              if (stat.isSymbolicLink()) {
                var target = fs.readlinkSync(filePath);
                var m = target.match(/([^\\/]+)\\/\\1$/);
                if (m) return m[1];
                var m2 = target.match(/\\/annex\\/objects\\/(.+)$/);
                if (m2) return m2[1];
              } else if (stat.isFile() && stat.size < 500 && stat.size > 20) {
                var content = fs.readFileSync(filePath, "utf8").trim();
                var m3 = content.match(/^\\/annex\\/objects\\/(.+)$/);
                if (m3) return m3[1];
              }
            } catch (e) {
              console.warn("  resolveAnnexKey failed for " + filePath + ": " + e.message);
            }
            return null;
          }

          function fetchUrl(url) {
            return new Promise(function (resolve, reject) {
              var mod = url.indexOf("https") === 0 ? https : http;
              mod
                .get(url, function (res) {
                  if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    fetchUrl(res.headers.location).then(resolve).catch(reject);
                    return;
                  }
                  if (res.statusCode !== 200) {
                    res.resume();
                    reject(new Error("HTTP " + res.statusCode + " for " + url));
                    return;
                  }
                  resolve(res);
                })
                .on("error", reject);
            });
          }

          function walkDir(dir, base) {
            base = base || "";
            var result = [];
            var entries = fs.readdirSync(dir, { withFileTypes: true });
            for (var i = 0; i < entries.length; i++) {
              var entry = entries[i];
              if (entry.name === ".git" || entry.name === ".github" || entry.name === "node_modules") continue;
              var rel = base ? base + "/" + entry.name : entry.name;
              var full = path.join(dir, entry.name);
              if (entry.isDirectory()) {
                result = result.concat(walkDir(full, rel));
              } else {
                result.push({ rel: rel, full: full });
              }
            }
            return result;
          }

          async function main() {
            console.log("Streaming archive for " + DATASET_ID + " v" + VERSION);

            var archive = archiver("zip", { zlib: { level: 1 } });
            var passThrough = new PassThrough();
            archive.pipe(passThrough);

            archive.on("warning", function (err) {
              console.warn("Archive warning:", err.message);
            });
            archive.on("error", function (err) {
              console.error("Archive error:", err.message);
              process.exitCode = 1;
            });
            passThrough.on("error", function (err) {
              console.error("Stream error:", err.message);
              process.exitCode = 1;
            });

            var s3 = new S3Client({ region: REGION });
            var s3Key = DATASET_ID + "/archives/v" + VERSION + ".zip";

            var upload = new Upload({
              client: s3,
              params: {
                Bucket: BUCKET,
                Key: s3Key,
                Body: passThrough,
                ContentType: "application/zip",
              },
              queueSize: 4,
              partSize: 100 * 1024 * 1024,
            });

            var uploadDone = upload.done().catch(function (err) {
              console.error("S3 Upload error:", err.message);
              process.exitCode = 1;
              throw err;
            });

            var files = walkDir(".");
            console.log("Found " + files.length + " files");

            var annexed = 0;
            var regular = 0;
            var skipped = 0;

            for (var i = 0; i < files.length; i++) {
              var rel = files[i].rel;
              var full = files[i].full;
              var annexKey = resolveAnnexKey(full);

              try {
                var entryDone = new Promise(function (resolve, reject) {
                  archive.once("entry", resolve);
                  archive.once("error", reject);
                });
                if (annexKey) {
                  var url = S3_BASE + "/" + DATASET_ID + "/objects/" + encodeURIComponent(annexKey);
                  var stream = await fetchUrl(url);
                  archive.append(stream, { name: rel });
                } else {
                  archive.append(fs.createReadStream(full), { name: rel });
                }
                await entryDone;
                if (annexKey) annexed++;
                else regular++;
              } catch (err) {
                skipped++;
                if (skipped <= 10) {
                  console.warn("  Skipping " + rel + ": " + err.message);
                } else if (skipped === 11) {
                  console.warn("  (suppressing further skip warnings)");
                }
              }

              if ((annexed + regular + skipped) % 100 === 0) {
                console.log("  Progress: " + (annexed + regular + skipped) + "/" + files.length);
              }
            }

            await archive.finalize();
            await uploadDone;

            console.log("Archive complete: " + annexed + " annexed + " + regular + " regular + " + skipped + " skipped");
            console.log("Uploaded to s3://" + BUCKET + "/" + s3Key);
            if (skipped > 0) {
              console.warn("WARNING: " + skipped + " annexed files were not found in S3");
            }
          }

          process.on("unhandledRejection", function (err) {
            console.error("Unhandled rejection:", err);
            process.exitCode = 1;
          });

          main().catch(function (err) {
            console.error("Fatal:", err);
            process.exitCode = 1;
          });
          ARCHIVE_SCRIPT

      - name: Stream archive to S3
        env:
          AWS_ACCESS_KEY_ID: \${{ secrets.AWS_ACCESS_KEY_ID }}
          AWS_SECRET_ACCESS_KEY: \${{ secrets.AWS_SECRET_ACCESS_KEY }}
          AWS_DEFAULT_REGION: us-east-2
          NODE_PATH: /tmp/archive-deps/node_modules
        run: node /tmp/stream-archive.js
`;

  // LLM Metadata Enrichment workflow.
  //
  // The Action sends \`client_commits: true\` in the webhook payload. When the
  // Worker honors the flag (current backend), it returns the metadata commit
  // payload in the response and the Action commits with its own GITHUB_TOKEN,
  // off the shared admin PAT. When the flag is ignored (older backend), the
  // Worker commits itself; the Action notices the absence of \`client_commits\`
  // in the response and skips local commit, falling through to the
  // worker-side behavior.
  const llmEnrichment = `name: LLM Metadata Enrichment

on:
  push:
    branches: [main]
    paths:
      - 'README.md'
      - 'dataset_description.json'
  workflow_dispatch:

permissions:
  contents: write

jobs:
  enrich:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout repository
        uses: actions/checkout@v4
        with:
          fetch-depth: 1
          token: \${{ secrets.GITHUB_TOKEN }}

      - name: Trigger enrichment and commit locally if asked
        env:
          NEMAR_WEBHOOK_TOKEN: \${{ secrets.NEMAR_WEBHOOK_TOKEN }}
        run: |
          REPO_NAME="\${{ github.event.repository.name }}"

          # Skip if webhook token not configured
          if [ -z "$NEMAR_WEBHOOK_TOKEN" ]; then
            echo "NEMAR_WEBHOOK_TOKEN not configured, skipping LLM enrichment"
            exit 0
          fi

          # Force re-enrichment on manual workflow_dispatch
          FORCE="false"
          if [ "\${{ github.event_name }}" = "workflow_dispatch" ]; then
            FORCE="true"
          fi

          echo "Triggering LLM enrichment for $REPO_NAME (force=$FORCE)"

          # Capture full response (no trailing-newline stripping) so jq can
          # parse the body. The Worker returns 200 even when commit_error
          # is populated; non-2xx is reserved for hard failures.
          BODY_FILE=$(mktemp)
          HTTP_CODE=$(curl -sS -o "$BODY_FILE" -w "%{http_code}" -X POST \\
            "https://api.nemar.org/webhooks/llm-enrich" \\
            -H "Content-Type: application/json" \\
            -H "X-Webhook-Token: $NEMAR_WEBHOOK_TOKEN" \\
            -d "{\\"dataset_id\\": \\"$REPO_NAME\\", \\"force\\": $FORCE, \\"client_commits\\": true}")

          echo "HTTP $HTTP_CODE"
          cat "$BODY_FILE"
          echo

          if [ "$HTTP_CODE" -ge 400 ]; then
            echo "::warning::LLM enrichment failed (HTTP $HTTP_CODE) - this is non-blocking"
            rm -f "$BODY_FILE"
            exit 0
          fi

          # If the Worker honored client_commits, apply the returned payload.
          # Older Workers ignore the flag and have already committed themselves;
          # in that case client_commits will be missing/false and we no-op.
          CLIENT_COMMITS=$(jq -r '.client_commits // false' "$BODY_FILE")
          if [ "$CLIENT_COMMITS" != "true" ]; then
            echo "Worker committed metadata server-side; nothing to write locally."
            rm -f "$BODY_FILE"
            exit 0
          fi

          METADATA_PATH=$(jq -r '.metadata_path' "$BODY_FILE")
          COMMIT_MESSAGE=$(jq -r '.commit_message' "$BODY_FILE")

          if [ -z "$METADATA_PATH" ] || [ "$METADATA_PATH" = "null" ]; then
            echo "::warning::client_commits=true but no metadata_path; skipping local commit"
            rm -f "$BODY_FILE"
            exit 0
          fi

          mkdir -p "$(dirname "$METADATA_PATH")"
          jq -r '.metadata_content' "$BODY_FILE" > "$METADATA_PATH"

          # Ensure each requested bidsignore entry is present exactly once.
          touch .bidsignore
          while IFS= read -r entry; do
            [ -z "$entry" ] && continue
            grep -qxF "$entry" .bidsignore || echo "$entry" >> .bidsignore
          done < <(jq -r '.bidsignore_entries[]?' "$BODY_FILE")

          rm -f "$BODY_FILE"

          git config user.name "nemar-bot"
          git config user.email "actions@github.com"
          git add "$METADATA_PATH" .bidsignore

          if git diff --cached --quiet; then
            echo "Metadata already up-to-date; nothing to commit."
            exit 0
          fi

          git commit -m "$COMMIT_MESSAGE [skip ci]"
          # Pull-rebase guards against a concurrent push from a parallel run.
          git pull --rebase origin main || {
            echo "::warning::rebase failed; leaving the local commit unpushed"
            exit 0
          }
          git push origin HEAD:main || {
            echo "::warning::push rejected; the Worker fallback will catch the next push"
            exit 0
          }
          echo "Action-side metadata commit applied."
`;

  // Version DOI workflow: publishes a DOI then triggers archive generation.
  // Fires on any v* tag push (from pr-merge create-release, manual tags, or admin tags).
  const versionDoi = `name: Version DOI

on:
  push:
    tags: ['v*']

permissions:
  contents: write

jobs:
  publish-doi:
    name: Publish Version DOI
    runs-on: ubuntu-latest
    steps:
      - name: Create release if missing
        env:
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
        run: |
          TAG="\${{ github.ref_name }}"
          # Create release if it doesn't already exist (e.g., manual tag push)
          gh release view "$TAG" --repo "\${{ github.repository }}" > /dev/null 2>&1 || \\
            gh release create "$TAG" --repo "\${{ github.repository }}" \\
              --title "$TAG" --notes "Release $TAG"

      - name: Publish version DOI
        env:
          NEMAR_WEBHOOK_TOKEN: \${{ secrets.NEMAR_WEBHOOK_TOKEN }}
        run: |
          DATASET_ID="\${{ github.event.repository.name }}"
          TAG="\${{ github.ref_name }}"
          VERSION="\${TAG#v}"
          RELEASE_URL="https://github.com/\${{ github.repository }}/releases/tag/$TAG"

          echo "Publishing DOI for $DATASET_ID version $VERSION"

          if [ -z "$NEMAR_WEBHOOK_TOKEN" ]; then
            echo "NEMAR_WEBHOOK_TOKEN not configured, skipping DOI publish"
            exit 0
          fi

          RESPONSE=$(curl -s -w "\\n%{http_code}" -X POST \\
            "https://api.nemar.org/webhooks/publish-version-doi" \\
            -H "Content-Type: application/json" \\
            -H "X-Webhook-Token: $NEMAR_WEBHOOK_TOKEN" \\
            -d "{
              \\"dataset_id\\": \\"$DATASET_ID\\",
              \\"version\\": \\"$VERSION\\",
              \\"release_url\\": \\"$RELEASE_URL\\"
            }")

          HTTP_CODE=$(echo "$RESPONSE" | tail -1)
          BODY=$(echo "$RESPONSE" | head -n -1)

          echo "Response: $BODY"

          if [ "$HTTP_CODE" -ge 400 ]; then
            if echo "$BODY" | jq -e '.skipped == true' > /dev/null 2>&1; then
              echo "Skipped: No concept DOI exists for this dataset"
              exit 0
            fi
            echo "::error::Failed to publish DOI (HTTP $HTTP_CODE)"
            exit 1
          fi

          DOI=$(echo "$BODY" | jq -r '.version_doi // empty')
          if [ -n "$DOI" ]; then
            echo "Version DOI published: $DOI"
          fi

  trigger-archive:
    name: Trigger Archive Generation
    needs: publish-doi
    runs-on: ubuntu-latest
    steps:
      - name: Dispatch archive generation
        env:
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
        run: |
          DATASET_ID="\${{ github.event.repository.name }}"
          TAG="\${{ github.ref_name }}"
          VERSION="\${TAG#v}"

          echo "Triggering archive generation for $DATASET_ID v$VERSION"

          gh api "repos/\${{ github.repository }}/dispatches" \\
            -f event_type=generate-archive \\
            -f "client_payload[dataset_id]=$DATASET_ID" \\
            -f "client_payload[version]=$VERSION"
`;

  return [
    { path: ".github/workflows/bids-validation.yml", content: bidsValidation },
    { path: ".github/workflows/version-check.yml", content: versionCheck },
    { path: ".github/workflows/pr-merge.yml", content: prMerge },
    { path: ".github/workflows/generate-archive.yml", content: generateArchive },
    { path: ".github/workflows/llm-enrichment.yml", content: llmEnrichment },
    { path: ".github/workflows/version-doi.yml", content: versionDoi },
  ];
}

/**
 * Deploy every CI workflow template to a dataset repo in a single
 * tree-batched commit. All-or-nothing: on failure, `deployed` is empty
 * (no partial deployment, unlike the prior per-file loop that could
 * half-succeed). Callers MUST check `success` — this function never throws.
 */
export async function deployWorkflows(
  repo: string,
  pat: string,
): Promise<{ success: boolean; errors: string[]; deployed: string[] }> {
  const workflows = getWorkflowTemplates();
  const files: TreeFile[] = workflows.map((w) => ({ path: w.path, content: w.content }));
  const deployedNames = workflows.map((w) => {
    const parts = w.path.split("/");
    return parts[parts.length - 1] ?? w.path;
  });

  try {
    await commitFilesAsTree(repo, "main", files, "Add CI workflows", pat);
    return { success: true, errors: [], deployed: deployedNames };
  } catch (err) {
    return {
      success: false,
      errors: [err instanceof Error ? err.message : String(err)],
      deployed: [],
    };
  }
}

/**
 * List the file paths currently present under `.github/workflows` on the repo's
 * given branch. Returns paths relative to the repo root (e.g.
 * `.github/workflows/bids-validation.yml`). A 404 on the directory itself
 * (workflows folder not yet created) is treated as "empty", not an error.
 *
 * Includes both regular files and symlinks: a symlinked workflow is still
 * a deployed workflow from GitHub Actions' perspective, and silently
 * misclassifying it as missing would cause us to overwrite it.
 */
async function listDeployedWorkflowPaths(
  repo: string,
  branch: string,
  pat: string,
): Promise<Set<string>> {
  const response = await githubFetchWithRetry(
    `${GITHUB_API()}/repos/${ORG_NAME}/${repo}/contents/.github/workflows?ref=${encodeURIComponent(branch)}`,
    {
      headers: {
        Authorization: `Bearer ${pat}`,
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "NEMAR-API",
      },
    },
  );

  if (response.status === 404) return new Set();
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new HttpError(
      `Failed to list workflows for ${repo}@${branch}: HTTP ${response.status}: ${body.slice(0, 300)}`,
      response.status,
      body.slice(0, 300),
    );
  }
  const entries = (await response.json()) as Array<{ path: string; type: string }>;
  return new Set(
    entries.filter((e) => e.type === "file" || e.type === "symlink").map((e) => e.path),
  );
}

export interface EnsureWorkflowsResult {
  alreadyPresent: string[];
  deployed: string[];
  errors: string[];
  /** True iff we could not list the workflows directory; callers should
      not interpret `alreadyPresent: []` as "no workflows deployed" in
      that case. */
  listFailed: boolean;
}

/**
 * Idempotent presence check: list the workflow directory once, deploy only the
 * templates that are missing in a single tree commit. Never throws; failures
 * are aggregated in `errors`. Steady-state cost when everything is already
 * present is one REST call (the directory listing).
 */
export async function ensureWorkflowsDeployed(
  repo: string,
  branch: string,
  pat: string,
): Promise<EnsureWorkflowsResult> {
  const workflows = getWorkflowTemplates();
  const nameOf = (path: string): string => {
    const parts = path.split("/");
    return parts[parts.length - 1] ?? path;
  };

  let present: Set<string>;
  try {
    present = await listDeployedWorkflowPaths(repo, branch, pat);
  } catch (err) {
    return {
      alreadyPresent: [],
      deployed: [],
      errors: [err instanceof Error ? err.message : String(err)],
      listFailed: true,
    };
  }

  const missing = workflows.filter((w) => !present.has(w.path));
  if (missing.length === 0) {
    return {
      alreadyPresent: workflows.map((w) => nameOf(w.path)),
      deployed: [],
      errors: [],
      listFailed: false,
    };
  }

  try {
    await commitFilesAsTree(
      repo,
      branch,
      missing.map((w) => ({ path: w.path, content: w.content })),
      missing.length === workflows.length ? "Add CI workflows" : "Add missing CI workflows",
      pat,
    );
    return {
      alreadyPresent: workflows.filter((w) => present.has(w.path)).map((w) => nameOf(w.path)),
      deployed: missing.map((w) => nameOf(w.path)),
      errors: [],
      listFailed: false,
    };
  } catch (err) {
    return {
      alreadyPresent: workflows.filter((w) => present.has(w.path)).map((w) => nameOf(w.path)),
      deployed: [],
      errors: [err instanceof Error ? err.message : String(err)],
      listFailed: false,
    };
  }
}

/**
 * Normalize text before comparing template content vs. deployed content.
 * GitHub's Contents API returns the file's exact bytes; if a workflow
 * was ever round-tripped through tooling that adds a UTF-8 BOM,
 * normalizes CRLF, or drops the trailing newline, a naive byte compare
 * would loop forever rewriting the same file. We strip:
 *
 *   - UTF-8 BOM (﻿)
 *   - CR before LF and bare CR
 *   - trailing whitespace (so a missing final newline doesn't drift)
 */
function normalizeForCompare(s: string): string {
  return s.replace(/^﻿/, "").replace(/\r\n?/g, "\n").replace(/\s+$/, "");
}

export interface SyncWorkflowsResult {
  checked: string[];
  /** Templates whose deployed content drifted from the source. */
  changed: string[];
  /** Templates that were missing from the deployed workflows directory. */
  added: string[];
  errors: string[];
  /** True iff a tree commit was made. Distinguishes "nothing to do" from
      "we tried to commit but it failed" (both leave `errors` populated
      via different paths). */
  committed: boolean;
  /** True iff the workflow directory listing failed. */
  listFailed: boolean;
}

/**
 * Compare every workflow template against what is currently deployed and
 * commit, in one tree, only the files whose content drifted. Files that
 * are missing entirely are written as part of the same commit. Never
 * throws; per-file read errors land in `errors` and the file is treated
 * as unchanged so we don't risk clobbering a hand-edited workflow on a
 * read failure.
 *
 * On commit failure the intended `changed` and `added` lists are preserved
 * (so callers can see what *would* have synced) and `committed` is false.
 */
export async function syncWorkflowTemplates(
  repo: string,
  branch: string,
  pat: string,
): Promise<SyncWorkflowsResult> {
  const workflows = getWorkflowTemplates();
  const nameOf = (path: string): string => {
    const parts = path.split("/");
    return parts[parts.length - 1] ?? path;
  };
  const checked = workflows.map((w) => nameOf(w.path));

  let present: Set<string>;
  try {
    present = await listDeployedWorkflowPaths(repo, branch, pat);
  } catch (err) {
    return {
      checked,
      changed: [],
      added: [],
      errors: [err instanceof Error ? err.message : String(err)],
      committed: false,
      listFailed: true,
    };
  }

  const errors: string[] = [];
  const filesToWrite: TreeFile[] = [];
  const changed: string[] = [];
  const added: string[] = [];

  for (const template of workflows) {
    if (!present.has(template.path)) {
      filesToWrite.push({ path: template.path, content: template.content });
      added.push(nameOf(template.path));
      continue;
    }
    let deployedContent: string | null;
    try {
      deployedContent = await getFileContent(repo, template.path, pat, branch);
    } catch (err) {
      errors.push(
        `${template.path}: read failed (${err instanceof Error ? err.message : String(err)})`,
      );
      continue;
    }
    if (deployedContent === null) {
      // Listing said file exists but content fetch returned null — race or
      // permissions. Skip rather than risk a clobbering write.
      errors.push(`${template.path}: present in listing but content unavailable`);
      continue;
    }
    if (normalizeForCompare(deployedContent) !== normalizeForCompare(template.content)) {
      filesToWrite.push({ path: template.path, content: template.content });
      changed.push(nameOf(template.path));
    }
  }

  if (filesToWrite.length === 0) {
    return { checked, changed, added, errors, committed: false, listFailed: false };
  }

  try {
    await commitFilesAsTree(
      repo,
      branch,
      filesToWrite,
      added.length > 0 && changed.length > 0
        ? "Sync CI workflows (add missing, update drifted)"
        : added.length > 0
          ? "Add missing CI workflows"
          : "Update CI workflows to current templates",
      pat,
    );
    return { checked, changed, added, errors, committed: true, listFailed: false };
  } catch (err) {
    errors.push(`commit failed: ${err instanceof Error ? err.message : String(err)}`);
    return { checked, changed, added, errors, committed: false, listFailed: false };
  }
}

/**
 * Trigger archive generation via repository_dispatch event.
 * Sends dataset_id and version in the client_payload. The generate-archive
 * workflow checks out the version tag, retrieves git-annex data, creates a zip,
 * and uploads to S3 at {datasetId}/archives/v{version}.zip.
 */
export async function triggerArchiveGeneration(
  repo: string,
  datasetId: string,
  version: string,
  pat: string,
  options?: { public?: boolean },
): Promise<void> {
  const response = await fetch(`${GITHUB_API()}/repos/${ORG_NAME}/${repo}/dispatches`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${pat}`,
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "NEMAR-API",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      event_type: "generate-archive",
      client_payload: {
        dataset_id: datasetId,
        version,
        public: options?.public ?? false,
      },
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to trigger archive generation: HTTP ${response.status} - ${error}`);
  }
}

// ============================================================================
// Git Tree and Blob API (for manifest generation)
// ============================================================================

export interface TreeEntry {
  path: string;
  mode: string;
  type: "blob" | "tree";
  sha: string;
  size?: number;
}

/**
 * Get the recursive git tree at a given ref (tag, branch, or commit SHA).
 * Returns all entries (blobs and trees) in the repository at that ref.
 */
export async function getTreeAtRef(repo: string, ref: string, pat: string): Promise<TreeEntry[]> {
  // First resolve the ref to a commit SHA. retryOn404: callers that pass a
  // ref they just created (a tag we wrote, "main" right after a merge) will
  // see GitHub briefly 404 the new ref while caches catch up; we retry those.
  const refResponse = await githubFetchWithRetry(
    `${GITHUB_API()}/repos/${ORG_NAME}/${repo}/commits/${ref}`,
    {
      headers: {
        Authorization: `Bearer ${pat}`,
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "NEMAR-API",
      },
    },
    { retryOn404: true },
  );

  if (!refResponse.ok) {
    throw new HttpError(
      `Failed to resolve ref '${ref}': HTTP ${refResponse.status}`,
      refResponse.status,
    );
  }

  const commit = await refResponse.json<{ sha: string; commit: { tree: { sha: string } } }>();
  const treeSha = commit.commit.tree.sha;

  // Get the tree recursively
  const treeResponse = await githubFetchWithRetry(
    `${GITHUB_API()}/repos/${ORG_NAME}/${repo}/git/trees/${treeSha}?recursive=1`,
    {
      headers: {
        Authorization: `Bearer ${pat}`,
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "NEMAR-API",
      },
    },
  );

  if (!treeResponse.ok) {
    throw new HttpError(`Failed to get tree: HTTP ${treeResponse.status}`, treeResponse.status);
  }

  const tree = await treeResponse.json<{ tree: TreeEntry[]; truncated: boolean }>();
  if (tree.truncated) {
    console.warn(`[manifest] Tree for ${repo}@${ref} was truncated (very large repo)`);
  }

  return tree.tree.filter((entry) => entry.type === "blob");
}

/**
 * Get the content of a blob by SHA. Returns the decoded text content.
 * Uses the blob API to get base64-encoded content.
 */
export async function getBlobContent(repo: string, blobSha: string, pat: string): Promise<string> {
  // retryOn404: blob SHA came from a tree we just resolved, so 404 indicates
  // propagation lag, not a missing object.
  const response = await githubFetchWithRetry(
    `${GITHUB_API()}/repos/${ORG_NAME}/${repo}/git/blobs/${blobSha}`,
    {
      headers: {
        Authorization: `Bearer ${pat}`,
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "NEMAR-API",
      },
    },
    { retryOn404: true },
  );

  if (!response.ok) {
    throw new HttpError(`Failed to get blob ${blobSha}: HTTP ${response.status}`, response.status);
  }

  const blob = await response.json<{ content: string; encoding: string }>();
  if (blob.encoding === "base64") {
    const binary = atob(blob.content.replace(/\n/g, ""));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new TextDecoder().decode(bytes);
  }
  return blob.content;
}

/**
 * Get the text content of a file from a repo via the Contents API.
 * Returns null if the file does not exist.
 */
export async function getFileContent(
  repo: string,
  filePath: string,
  pat: string,
  ref = "main",
): Promise<string | null> {
  // No retryOn404 here: 404 is a valid "file not present" signal returned as null.
  const response = await githubFetchWithRetry(
    `${GITHUB_API()}/repos/${ORG_NAME}/${repo}/contents/${filePath}?ref=${ref}`,
    {
      headers: {
        Authorization: `Bearer ${pat}`,
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "NEMAR-API",
      },
    },
  );

  if (response.status === 404) return null;
  if (!response.ok) {
    throw new HttpError(
      `Failed to get ${filePath} from ${repo}: HTTP ${response.status}`,
      response.status,
    );
  }

  const data = await response.json<{ content: string; encoding: string }>();
  if (!data.content) {
    throw new Error(`No content field in GitHub response for ${filePath} in ${repo}`);
  }
  if (data.encoding === "base64") {
    const binary = atob(data.content.replace(/\n/g, ""));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new TextDecoder().decode(bytes);
  }
  return data.content;
}

// ============================================================================
// Tag Protection
// ============================================================================

/**
 * Apply tag protection rules to prevent deletion of version tags.
 * Protects tags matching the pattern "v*" (semver version tags).
 */
/**
 * Apply tag protection. Throws `HttpError` on terminal failure so the caller's
 * step-level retry can classify the error and operators see status + body in
 * the surfaced message. 422 is treated as success (rule already exists).
 */
export async function applyTagProtection(repo: string, pat: string): Promise<void> {
  // retryOn404: rulesets endpoint can briefly 404 right after a repo
  // visibility flip while GitHub propagates ACLs.
  const response = await githubFetchWithRetry(
    `${GITHUB_API()}/repos/${ORG_NAME}/${repo}/rulesets`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${pat}`,
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "NEMAR-API",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "Protect version tags",
        target: "tag",
        enforcement: "active",
        conditions: {
          ref_name: {
            include: ["refs/tags/v*"],
            exclude: [],
          },
        },
        rules: [{ type: "deletion" }, { type: "update" }],
      }),
    },
    { retryOn404: true },
  );

  // 2xx success or 422 (ruleset already exists) both count as applied.
  if (response.ok || response.status === 422) return;

  const body = await response.text().catch(() => "<failed to read body>");
  const snippet = body.slice(0, 300);
  throw new HttpError(
    `Tag protection failed for ${repo}: HTTP ${response.status}: ${snippet}`,
    response.status,
    snippet,
  );
}

/**
 * Get the latest commit SHA on a branch.
 *
 * @param repo Repository name (e.g., "nm000123")
 * @param branch Branch name (e.g., "main")
 * @param pat GitHub PAT
 * @returns 40-character commit SHA
 * @throws {Error} If the branch ref cannot be resolved
 */
export async function getMainBranchSha(repo: string, branch: string, pat: string): Promise<string> {
  // retryOn404: caller knows the branch exists (e.g., we just committed to it),
  // so 404 indicates GitHub hasn't propagated the ref yet.
  const response = await githubFetchWithRetry(
    `${GITHUB_API()}/repos/${ORG_NAME}/${repo}/git/ref/heads/${branch}`,
    {
      headers: {
        Authorization: `Bearer ${pat}`,
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "NEMAR-API",
      },
    },
    { retryOn404: true },
  );

  if (!response.ok) {
    const error = await response.text().catch(() => "<failed to read body>");
    throw new HttpError(
      `Failed to get ${branch} branch ref: HTTP ${response.status}: ${error.slice(0, 300)}`,
      response.status,
      error.slice(0, 300),
    );
  }

  const refData = (await response.json()) as { object: { sha: string } };
  if (!refData.object?.sha) {
    throw new Error(`Unexpected response format for ${branch} branch ref`);
  }
  return refData.object.sha;
}

/** Input to `commitFilesAsTree`. `content` must be UTF-8 text; binary is not supported. */
export interface TreeFile {
  path: string;
  content: string;
  mode?: "100644" | "100755";
}

/**
 * Validate `files` against the constraints GitHub enforces on tree entries.
 * Catches problems locally so they fail fast instead of being retried 3 times
 * through `commitFilesAsTree`'s ref-conflict loop.
 */
function validateTreeFiles(files: TreeFile[]): void {
  const seen = new Set<string>();
  for (const f of files) {
    if (!f.path) {
      throw new Error("commitFilesAsTree: empty path");
    }
    if (f.path.startsWith("/")) {
      throw new Error(`commitFilesAsTree: path must be repo-relative, got '${f.path}'`);
    }
    if (f.path.endsWith("/")) {
      throw new Error(`commitFilesAsTree: path must not end with '/', got '${f.path}'`);
    }
    if (f.path.includes("\0")) {
      throw new Error("commitFilesAsTree: path contains NUL byte");
    }
    if (f.path.split("/").some((seg) => seg === "..")) {
      throw new Error(`commitFilesAsTree: path contains '..' segment, got '${f.path}'`);
    }
    if (seen.has(f.path)) {
      throw new Error(`commitFilesAsTree: duplicate path '${f.path}'`);
    }
    seen.add(f.path);
  }
}

/**
 * Detect GitHub's fast-forward conflict 422. The endpoint returns 422 for
 * several distinct reasons (bad SHA, missing ref, signed-commit policy, etc.)
 * and only the fast-forward case is safe to retry. Match the documented
 * English message rather than the raw status code.
 */
function isFastForwardConflict422(bodyText: string): boolean {
  let parsed: { message?: string } | null = null;
  try {
    parsed = JSON.parse(bodyText) as { message?: string };
  } catch {
    // Fall through to substring match.
  }
  const msg = parsed?.message ?? bodyText;
  return /not a fast forward/i.test(msg);
}

/**
 * Commit one or more files to a branch in a single Git Data API transaction.
 *
 * Cost (happy path): 4 REST calls regardless of how many files are written —
 * `createOrUpdateFile()` costs 2 per file, so this strictly wins for N >= 3
 * and ties at N = 2. For N = 1 prefer `createOrUpdateFile()`.
 *
 * Concurrency: if the branch advances between resolving the base and the
 * ref PATCH, GitHub returns 422 "Update is not a fast forward". We make up to
 * 3 attempts (2 retries), refetching the base each time. Non-fast-forward
 * 422s (bad branch, signed-commit policy, missing ref) are surfaced
 * immediately — they will never succeed on retry.
 *
 * @returns SHA of the new commit. For an empty `files` array, returns the
 *   current branch head SHA without making any write calls.
 */
export async function commitFilesAsTree(
  repo: string,
  branch: string,
  files: TreeFile[],
  message: string,
  pat: string,
): Promise<string> {
  const authHeaders = {
    Authorization: `Bearer ${pat}`,
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "NEMAR-API",
  };
  const jsonHeaders = { ...authHeaders, "Content-Type": "application/json" };

  if (files.length === 0) {
    return getMainBranchSha(repo, branch, pat);
  }

  validateTreeFiles(files);

  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const branchResp = await githubFetchWithRetry(
      `${GITHUB_API()}/repos/${ORG_NAME}/${repo}/branches/${branch}`,
      { headers: authHeaders },
      { retryOn404: true },
    );
    if (!branchResp.ok) {
      const body = await branchResp.text().catch(() => "");
      throw new HttpError(
        `Failed to resolve branch '${branch}': HTTP ${branchResp.status}: ${body.slice(0, 1024)}`,
        branchResp.status,
        body.slice(0, 1024),
      );
    }
    const branchData = (await branchResp.json()) as {
      commit: { sha: string; commit: { tree: { sha: string } } };
    };
    const baseCommitSha = branchData.commit.sha;
    const baseTreeSha = branchData.commit.commit.tree.sha;

    const treeResp = await githubFetchWithRetry(
      `${GITHUB_API()}/repos/${ORG_NAME}/${repo}/git/trees`,
      {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({
          base_tree: baseTreeSha,
          tree: files.map((f) => ({
            path: f.path,
            mode: f.mode ?? "100644",
            type: "blob",
            content: f.content,
          })),
        }),
      },
    );
    if (!treeResp.ok) {
      const body = await treeResp.text().catch(() => "");
      throw new HttpError(
        `Failed to create tree on ${repo}@${branch}: HTTP ${treeResp.status}: ${body.slice(0, 1024)}`,
        treeResp.status,
        body.slice(0, 1024),
      );
    }
    const { sha: newTreeSha } = (await treeResp.json()) as { sha: string };

    const isoDate = new Date().toISOString();
    const commitResp = await githubFetchWithRetry(
      `${GITHUB_API()}/repos/${ORG_NAME}/${repo}/git/commits`,
      {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({
          message,
          tree: newTreeSha,
          parents: [baseCommitSha],
          author: { ...NEMAR_COMMITTER, date: isoDate },
          committer: { ...NEMAR_COMMITTER, date: isoDate },
        }),
      },
    );
    if (!commitResp.ok) {
      const body = await commitResp.text().catch(() => "");
      throw new HttpError(
        `Failed to create commit on ${repo}@${branch}: HTTP ${commitResp.status}: ${body.slice(0, 1024)}`,
        commitResp.status,
        body.slice(0, 1024),
      );
    }
    const { sha: newCommitSha } = (await commitResp.json()) as { sha: string };

    const refResp = await githubFetchWithRetry(
      `${GITHUB_API()}/repos/${ORG_NAME}/${repo}/git/refs/heads/${branch}`,
      {
        method: "PATCH",
        headers: jsonHeaders,
        body: JSON.stringify({ sha: newCommitSha }),
      },
    );
    if (refResp.ok) return newCommitSha;

    const body = await refResp.text().catch(() => "");
    // 422 with a non-fast-forward message means the branch advanced; refetch
    // and retry. Other 422 causes (bad ref, signed-commit policy, missing
    // ref) never succeed on retry — surface them immediately.
    if (refResp.status === 422 && isFastForwardConflict422(body) && attempt < maxAttempts) {
      console.warn(
        `[github] commitFilesAsTree fast-forward conflict on ${repo}@${branch} (attempt ${attempt}/${maxAttempts}): ${body.slice(0, 200)}`,
      );
      continue;
    }
    const note =
      refResp.status === 422 && isFastForwardConflict422(body)
        ? ` (exhausted ${maxAttempts} attempts)`
        : "";
    throw new HttpError(
      `Failed to update ref ${branch} on ${repo}: HTTP ${refResp.status}${note}: ${body.slice(0, 1024)}`,
      refResp.status,
      body.slice(0, 1024),
    );
  }

  // Unreachable: the for loop either returns, continues, or throws.
  throw new Error(`commitFilesAsTree: unreachable end-of-function for ${repo}@${branch}`);
}

export interface EnrichmentCommitResult {
  /** "batched" when metadata + .bidsignore were committed together; "single" when only metadata was committed. */
  commitMode: "batched" | "single";
  /** True when .bidsignore was modified in the commit. */
  bidsignoreUpdated: boolean;
  /** Set when reading existing .bidsignore failed; metadata was still committed alone. */
  bidsignoreReadError?: string;
}

/**
 * Thrown by `commitEnrichmentWithBidsignore` on commit failure. Carries the
 * `commitMode` that was attempted so callers can decide whether the failure
 * affected both files (batched) or only metadata (single).
 */
export class EnrichmentCommitError extends Error {
  readonly commitMode: "batched" | "single";
  readonly bidsignoreReadError?: string;
  constructor(
    message: string,
    commitMode: "batched" | "single",
    bidsignoreReadError: string | undefined,
    cause?: unknown,
  ) {
    super(message);
    this.name = "EnrichmentCommitError";
    this.commitMode = commitMode;
    this.bidsignoreReadError = bidsignoreReadError;
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}

/**
 * Commit a NEMAR enrichment metadata file plus a `.bidsignore` update (when
 * needed) using whichever path is cheapest:
 *
 *   - both files dirty -> `commitFilesAsTree` (one atomic commit, 4 calls)
 *   - only metadata dirty -> `createOrUpdateFile` (single-file Contents API, 2 calls)
 *
 * If reading the existing `.bidsignore` fails, commits metadata alone and
 * returns the read error in `bidsignoreReadError`. Throws
 * `EnrichmentCommitError` on commit failure, with `commitMode` set so callers
 * can tell which path was attempted.
 */
export async function commitEnrichmentWithBidsignore(
  repo: string,
  branch: string,
  metadataPath: string,
  metadataContent: string,
  bidsignoreEntriesToIgnore: string[],
  message: string,
  pat: string,
): Promise<EnrichmentCommitResult> {
  let bidsignoreUpdated = false;
  let bidsignoreContent = "";
  let bidsignoreReadError: string | undefined;
  try {
    const tree = await getTreeAtRef(repo, branch, pat);
    const bidsignoreFile = tree.find((f) => f.path === ".bidsignore");
    if (bidsignoreFile) {
      bidsignoreContent = await getBlobContent(repo, bidsignoreFile.sha, pat);
    }
    for (const entry of bidsignoreEntriesToIgnore) {
      if (!bidsignoreContent.includes(entry)) {
        bidsignoreContent = bidsignoreContent
          ? `${bidsignoreContent.trimEnd()}\n${entry}\n`
          : `${entry}\n`;
        bidsignoreUpdated = true;
      }
    }
  } catch (readErr) {
    bidsignoreReadError = readErr instanceof Error ? readErr.message : String(readErr);
    bidsignoreUpdated = false;
  }

  const commitMode: "batched" | "single" = bidsignoreUpdated ? "batched" : "single";
  try {
    if (commitMode === "batched") {
      await commitFilesAsTree(
        repo,
        branch,
        [
          { path: metadataPath, content: metadataContent },
          { path: ".bidsignore", content: bidsignoreContent },
        ],
        message,
        pat,
      );
    } else {
      await createOrUpdateFile(repo, metadataPath, metadataContent, message, pat);
    }
  } catch (commitErr) {
    const detail = commitErr instanceof Error ? commitErr.message : String(commitErr);
    throw new EnrichmentCommitError(detail, commitMode, bidsignoreReadError, commitErr);
  }
  return { commitMode, bidsignoreUpdated, bidsignoreReadError };
}

/**
 * Create a git tag on a repository.
 *
 * @param repo Repository name (e.g., "nm000123")
 * @param tag Tag name (e.g., "v1.0.0")
 * @param sha Commit SHA to tag
 * @param message Tag message/annotation
 * @param pat GitHub PAT
 * @returns Tag SHA if successful
 * @throws {Error} If tag object or reference creation fails
 */
export async function createTag(
  repo: string,
  tag: string,
  sha: string,
  message: string,
  pat: string,
): Promise<string> {
  // First, create an annotated tag object
  const tagResponse = await fetch(`${GITHUB_API()}/repos/${ORG_NAME}/${repo}/git/tags`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${pat}`,
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "NEMAR-API",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      tag,
      message,
      object: sha,
      type: "commit",
      tagger: { ...NEMAR_COMMITTER, date: new Date().toISOString() },
    }),
  });

  if (!tagResponse.ok) {
    const error = await tagResponse.text();
    throw new Error(`Failed to create tag object: ${error}`);
  }

  const tagData = (await tagResponse.json()) as { sha: string };

  // Then, create a reference to the tag
  const refResponse = await fetch(`${GITHUB_API()}/repos/${ORG_NAME}/${repo}/git/refs`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${pat}`,
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "NEMAR-API",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      ref: `refs/tags/${tag}`,
      sha: tagData.sha,
    }),
  });

  if (!refResponse.ok) {
    // 422 means the tag reference already exists; treat as success for idempotent re-runs
    if (refResponse.status === 422) {
      return tagData.sha;
    }
    const error = await refResponse.text();
    throw new Error(`Failed to create tag reference: ${error}`);
  }

  return tagData.sha;
}

/**
 * Create a GitHub release from a tag.
 *
 * @param repo Repository name (e.g., "nm000123")
 * @param tag Tag name (e.g., "v1.0.0")
 * @param name Release name (e.g., "Dataset v1.0.0")
 * @param body Release notes/description
 * @param pat GitHub PAT
 * @returns Release ID if successful
 * @throws {Error} If release creation fails (except for already-existing releases)
 */
export async function createRelease(
  repo: string,
  tag: string,
  name: string,
  body: string,
  pat: string,
): Promise<number> {
  const response = await fetch(`${GITHUB_API()}/repos/${ORG_NAME}/${repo}/releases`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${pat}`,
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "NEMAR-API",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      tag_name: tag,
      name,
      body,
      draft: false,
      prerelease: false,
    }),
  });

  if (!response.ok) {
    // 422 means release already exists for this tag; fetch the existing one
    if (response.status === 422) {
      const existing = await fetch(
        `${GITHUB_API()}/repos/${ORG_NAME}/${repo}/releases/tags/${tag}`,
        {
          headers: {
            Authorization: `Bearer ${pat}`,
            Accept: "application/vnd.github.v3+json",
            "User-Agent": "NEMAR-API",
          },
        },
      );
      if (existing.ok) {
        const existingData = (await existing.json()) as { id: number };
        return existingData.id;
      }
    }
    const error = await response.text();
    throw new Error(`Failed to create release: ${error}`);
  }

  const releaseData = (await response.json()) as { id: number };
  return releaseData.id;
}

/**
 * Download a repository source archive (zipball) at a given git ref.
 * Uses the repository archive endpoint, not the releases API.
 *
 * @param repo Repository name (e.g., "nm000123")
 * @param ref Git ref to archive (tag, branch, or SHA; e.g., "v1.0.0")
 * @param pat GitHub PAT
 * @returns ArrayBuffer containing the zip file
 * @throws {Error} If download fails or archive exceeds 100MB
 */
export async function downloadReleaseArchive(
  repo: string,
  ref: string,
  pat: string,
): Promise<ArrayBuffer> {
  const response = await fetch(`${GITHUB_API()}/repos/${ORG_NAME}/${repo}/zipball/${ref}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${pat}`,
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "NEMAR-API",
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to download archive for ${ref}: ${error}`);
  }

  // Validate content-type to catch HTML error pages returned with 200
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("text/html")) {
    throw new Error(`Expected zip archive but received HTML response for ${ref}`);
  }

  // Guard against exceeding CF Worker memory limits (128MB)
  const contentLength = response.headers.get("content-length");
  if (contentLength && Number.parseInt(contentLength, 10) > 100 * 1024 * 1024) {
    throw new Error(
      `Archive for ${ref} exceeds 100MB (${contentLength} bytes); too large for Worker environment`,
    );
  }

  return response.arrayBuffer();
}
