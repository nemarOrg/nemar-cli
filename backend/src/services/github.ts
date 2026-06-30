/**
 * GitHub API service
 *
 * Handles GitHub operations: validating usernames, managing collaborators,
 * creating/deleting repositories, and applying branch protection.
 */

import validatorPin from "../../../validator-version.json" with { type: "json" };
import {
  classifyElectrodeSystem,
  parseChannelsTsv,
  parseEegChannelCount,
  resolveNChannels,
} from "./channel-montage";
import { BIDS_DATATYPES } from "./datacite";
import { eventsJsonHasHed, eventsTsvHasHed, parseHedVersion } from "./hed";
import { HttpError } from "./retry";

const VALIDATOR_VERSION = validatorPin.version;

// NEMAR_GITHUB_API_URL is a test-only override that points at a local
// Bun.serve fake. Stored on globalThis because the Workers runtime has no
// `process.env`; read at call time so test helpers can install the override
// after the module has loaded.
function GITHUB_API(): string {
  const override = (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL;
  return override ?? "https://api.github.com";
}
// Dataset repos (nm000XXX) live in nemarDatasets org; tooling repos live in nemarOrg
export const ORG_NAME = "nemarDatasets";

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
    /** Optional bearer-token refresher. Called exactly once after a 401
     *  response; the returned token replaces the Authorization header on
     *  the retry. Use this when the bearer is a GitHub App installation
     *  token: a stale cache, key rotation, or a momentary upstream auth
     *  blip can produce a one-off 401 that a fresh mint clears. The
     *  refresher should invalidate any token cache itself; a 401 on the
     *  retry is treated as terminal. Issue #596. */
    refreshTokenOn401?: () => Promise<string>;
  },
): Promise<Response> {
  const maxAttempts = options?.maxAttempts ?? 3;
  const delayMs = options?.delayMs ?? 1_000;
  const retryOn404 = options?.retryOn404 ?? false;
  const kind = options?.kind ?? "background";
  const lowRemainingThreshold = options?.lowRemainingThreshold ?? 50;
  const maxThrottleMs = options?.maxThrottleMs ?? 60_000;
  const sleep = options?.sleepFn ?? defaultSleep;
  const refreshTokenOn401 = options?.refreshTokenOn401;
  // Tracks whether the 401-refresh path has been exercised; we permit
  // exactly one fresh-mint retry per call regardless of `maxAttempts`.
  let authRefreshUsed = false;
  // Mutable copy of init so the 401 path can rewrite Authorization
  // without reassigning the function parameter (biome
  // lint/style/noParameterAssign).
  let currentInit: RequestInit = init;

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
      const response = await fetch(url, currentInit);

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

      // One-shot token refresh on 401 when caller wires a refresher.
      // Sits before the generic transient retry path because 401 isn't
      // otherwise retried — we want a single fresh-mint attempt and then
      // for a persistent 401 to bubble up as a real auth failure.
      //
      // The refresh-on-401 path gets its own guaranteed retry slot,
      // independent of `maxAttempts`. Without this guarantee a 401 on
      // the final attempt (e.g. attempt 3 after two 404-propagation
      // retries on `retryOn404: true` callers) would refresh + continue,
      // exit the loop, and fall through to the `throw lastError` path
      // with `lastError === undefined` — leaking an opaque "exhausted
      // attempts" error to the caller instead of returning a clean 401
      // / refreshed-200. Code-review #597 fix.
      if (response.status === 401 && refreshTokenOn401 && !authRefreshUsed) {
        authRefreshUsed = true;
        let freshToken: string;
        try {
          freshToken = await refreshTokenOn401();
        } catch (err) {
          console.warn(
            `[github] ${method} ${parsedPath} 401 refresh failed: ${err instanceof Error ? err.message : String(err)}; returning the original 401`,
          );
          return response;
        }
        // Rebuild headers with the new bearer. Preserve every other header
        // the caller set (Accept, User-Agent, Content-Type, X-GitHub-Api-
        // Version, etc.) so retry semantics stay identical apart from auth.
        const refreshedHeaders = new Headers(currentInit.headers);
        refreshedHeaders.set("Authorization", `Bearer ${freshToken}`);
        currentInit = { ...currentInit, headers: refreshedHeaders };
        console.warn(
          `[github] ${method} ${parsedPath} attempt ${attempt} -> HTTP 401, refreshed App token and retrying immediately`,
        );
        if (attempt >= maxAttempts) {
          // Issue the refreshed request inline so it definitely gets a
          // chance to run; without this `continue` would hit the loop
          // boundary and bypass the retry entirely.
          try {
            const refreshedResponse = await fetch(url, currentInit);
            const refreshedSnapshot = parseRateLimitHeaders(refreshedResponse);
            if (refreshedSnapshot) {
              const existing = rateLimitState.get(refreshedSnapshot.resource);
              if (!existing || refreshedSnapshot.resetEpoch >= existing.resetEpoch) {
                rateLimitState.set(refreshedSnapshot.resource, refreshedSnapshot);
              }
            }
            emitRateLimitLog({
              method,
              path: parsedPath,
              status: refreshedResponse.status,
              attempt: attempt + 1,
              maxAttempts,
              snapshot: refreshedSnapshot,
              retryAfterMs: null,
              secondary: false,
            });
            return refreshedResponse;
          } catch (err) {
            lastError = err;
            throw err;
          }
        }
        continue;
      }

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

  if (response.ok || response.status === 204) return true;
  // GitHub 422s when the target already holds a HIGHER permission via org
  // membership (an org owner/admin cannot be assigned the lower `maintain`/
  // `push`): "Cannot assign <user> permission of <role>". The post-condition
  // ("user has at least `permission`") is already satisfied, so treat it as a
  // benign no-op rather than a failure. The reconcile normally excludes org
  // admins up front (see listOrgAdmins); this guards the path where that
  // lookup failed.
  if (response.status === 422) {
    const body = await response.text().catch(() => "");
    if (/Cannot assign .+ permission of/i.test(body)) return true;
  }
  return false;
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
 * Create or update a file in a repository.
 *
 * The optional `branch` argument is passed through to the Contents API
 * via the `branch` field on the GET and PUT calls so this function commits
 * to the requested ref instead of the repo default branch. Without it, a
 * caller like `commitEnrichmentWithBidsignore` that only touches one file
 * would silently land its commit on `main` regardless of the branch it
 * was invoked for.
 */
/**
 * Detect a GitHub Contents-API stale-SHA conflict on an update PUT. When the
 * `sha` we sent no longer matches the current blob (a concurrent write landed
 * first), GitHub returns 409; some paths surface it as 422 with a
 * sha/"does not match"/"fast forward" message. Either is safe to retry by
 * refetching the SHA. Pure; match the message, not just the status.
 */
export function isContentsApiShaConflict(status: number, bodyText: string): boolean {
  if (status === 409) return true;
  if (status !== 422) return false;
  let parsed: { message?: string } | null = null;
  try {
    parsed = JSON.parse(bodyText) as { message?: string };
  } catch {
    // Fall through to substring match.
  }
  const msg = parsed?.message ?? bodyText;
  // Match the known stale-SHA 422 phrases, NOT a bare "sha" (which appears in
  // unrelated 422s, e.g. "Invalid sha for author"). The 409 arm already covers
  // the blob-sha conflict unambiguously.
  return /does not match|not a fast forward/i.test(msg);
}

export async function createOrUpdateFile(
  repo: string,
  path: string,
  content: string,
  message: string,
  pat: string,
  branch?: string,
): Promise<void> {
  const branchQuery = branch ? `?ref=${encodeURIComponent(branch)}` : "";
  const encoded = btoa(
    Array.from(new TextEncoder().encode(content), (b) => String.fromCharCode(b)).join(""),
  );

  // Retry on a stale-SHA conflict: a concurrent writer (e.g. another enrichment
  // run, #755) can advance the blob between our GET-sha and PUT. Refetch the
  // current SHA and re-PUT -- last-writer-wins, no non-fast-forward failure.
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // Get the current blob SHA (needed to update; absent => create).
    let sha: string | undefined;
    let getResponse: Response;
    try {
      getResponse = await fetch(
        `${GITHUB_API()}/repos/${ORG_NAME}/${repo}/contents/${path}${branchQuery}`,
        {
          headers: {
            Authorization: `Bearer ${pat}`,
            Accept: "application/vnd.github.v3+json",
            "User-Agent": "NEMAR-API",
          },
        },
      );
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

    // Create or update the file.
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
          content: encoded,
          ...(sha ? { sha } : {}),
          ...(branch ? { branch } : {}),
          committer: NEMAR_COMMITTER,
          author: NEMAR_COMMITTER,
        }),
      });
    } catch (err) {
      throw new Error(
        `Network error committing ${path}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (response.ok || response.status === 201) return;

    const body = await response.text().catch(() => "");
    if (isContentsApiShaConflict(response.status, body) && attempt < maxAttempts) {
      console.warn(
        `[github] createOrUpdateFile sha conflict on ${repo}/${path}@${branch ?? "default"} (attempt ${attempt}/${maxAttempts}); refetching`,
      );
      continue;
    }
    throw new Error(`GitHub API error ${response.status} committing ${path}: ${body}`);
  }
  // Unreachable: every iteration returns, continues, or throws (mirrors
  // commitFilesAsTree). Guards against a future refactor silently returning void.
  throw new Error(`createOrUpdateFile: unreachable end-of-function for ${repo}/${path}`);
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
 * Bash for the `version-check` workflow's core assertion (epic #713, phase #718):
 * the PR's `Version` must be valid semver `X.Y.Z` AND a strict increment over
 * `main`'s version. Reads `$PR_VERSION` and `$MAIN_VERSION` from the env (the
 * workflow extracts them with jq); exits 1 with a `::error::` on a bad/equal/
 * downgraded version. A non-semver `$MAIN_VERSION` (e.g. a first version, where
 * main has no `Version` field) is treated as `0.0.0`. Exported so the exact
 * script is run in tests (`backend/test/version-check.test.ts`).
 *
 * Pure field comparison (no `sort -V`) so it is portable across the GitHub
 * ubuntu runner and local test shells.
 */
export const VERSION_COMPARE_SNIPPET = `if ! [[ "$PR_VERSION" =~ ^[0-9]{1,9}\\.[0-9]{1,9}\\.[0-9]{1,9}$ ]]; then
  echo "::error::Version '$PR_VERSION' in dataset_description.json is not valid semver (expected X.Y.Z). Use 'nemar dataset release' to set it."
  exit 1
fi
MAIN_SEMVER="$MAIN_VERSION"
[[ "$MAIN_SEMVER" =~ ^[0-9]{1,9}\\.[0-9]{1,9}\\.[0-9]{1,9}$ ]] || MAIN_SEMVER="0.0.0"
IFS=. read -r PMAJ PMIN PPAT <<< "$PR_VERSION"
IFS=. read -r MMAJ MMIN MPAT <<< "$MAIN_SEMVER"
GT=0
if [ "$PMAJ" -gt "$MMAJ" ]; then GT=1
elif [ "$PMAJ" -eq "$MMAJ" ] && [ "$PMIN" -gt "$MMIN" ]; then GT=1
elif [ "$PMAJ" -eq "$MMAJ" ] && [ "$PMIN" -eq "$MMIN" ] && [ "$PPAT" -gt "$MPAT" ]; then GT=1
fi
if [ "$GT" -ne 1 ]; then
  echo "::error::Version must be a strict increment over the main version $MAIN_SEMVER (got '$PR_VERSION'). Use 'nemar dataset release' to bump."
  exit 1
fi
echo "Version check passed: $MAIN_SEMVER -> $PR_VERSION"`;

/**
 * Deploy GitHub Actions workflow files to a dataset repository
 */
export function getWorkflowTemplates(): Array<{ path: string; content: string }> {
  // BIDS Validation workflow
  // BIDS Validation shim — Phase 4 of epic #601 (sub-issue #610).
  //
  // GitHub's `pull_request` events fire only on the repo where the PR lives,
  // so we can't relocate the validator workflow directly like Phases 1-3.
  // This shim fires `repository_dispatch[run-bids-validation]` at
  // `nemarDatasets/.github`, where `run-bids-validation.yml` runs the actual
  // deno validator and posts the result back as a `check-run` on this
  // dataset repo's PR. The shim itself does ~5 seconds of work (mint token
  // + dispatch) and shows up as a quick green check on the PR alongside the
  // central workflow's check-run.
  const bidsValidation = `name: BIDS Validation

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
  workflow_dispatch:

jobs:
  dispatch:
    name: Dispatch central BIDS validation
    runs-on: ubuntu-latest
    timeout-minutes: 2
    permissions: {}
    steps:
      - name: Mint App token scoped to .github
        id: app-token
        uses: actions/create-github-app-token@v1
        with:
          app-id: \${{ secrets.NEMAR_APP_ID }}
          private-key: \${{ secrets.NEMAR_APP_PRIVATE_KEY }}
          owner: nemarDatasets
          # The dispatch target is the .github repo; the token needs
          # actions:write on .github. The central workflow mints a
          # separate per-dataset token internally for the checkout step.
          repositories: .github

      - name: Dispatch run-bids-validation
        env:
          GH_TOKEN: \${{ steps.app-token.outputs.token }}
        run: |
          set -euo pipefail
          DATASET_ID="\${{ github.event.repository.name }}"
          # On pull_request events the head is the PR's head; on push
          # events it's the pushed commit. Fall back so both shapes work.
          HEAD_SHA="\${{ github.event.pull_request.head.sha || github.sha }}"
          REF="\${{ github.event.pull_request.head.ref || github.ref_name }}"
          PR_NUMBER="\${{ github.event.pull_request.number || '' }}"
          echo "Dispatching run-bids-validation for $DATASET_ID @ $HEAD_SHA (ref=$REF, PR=$PR_NUMBER)"
          gh api "repos/nemarDatasets/.github/dispatches" \\
            -f event_type=run-bids-validation \\
            -f "client_payload[dataset_id]=$DATASET_ID" \\
            -f "client_payload[ref]=$REF" \\
            -f "client_payload[head_sha]=$HEAD_SHA" \\
            -f "client_payload[pr_number]=$PR_NUMBER" \\
            -f "client_payload[validator_version]=${VALIDATOR_VERSION}"
`;

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
          # PR-branch version
          PR_VERSION=$(jq -r '.Version // "0.0.0"' dataset_description.json)

          # main-branch version
          git fetch origin main
          git checkout origin/main -- dataset_description.json 2>/dev/null || echo '{}' > dataset_description.json
          MAIN_VERSION=$(jq -r '.Version // "0.0.0"' dataset_description.json)
          git checkout HEAD -- dataset_description.json

          echo "Main version: $MAIN_VERSION"
          echo "PR version: $PR_VERSION"

          # Require valid semver X.Y.Z that strictly increments over main.
${VERSION_COMPARE_SNIPPET.split("\n")
  .map((l) => `          ${l}`)
  .join("\n")}
`;

  // PR Merge Handler workflow
  // PR Merge shim — Phase 4 of epic #601 (sub-issue #610).
  //
  // `pull_request_target: closed` events fire only on the dataset repo
  // where the PR lives. The `create-release` half of the legacy
  // pr-merge.yml is now a thin dispatch to `nemarDatasets/.github` which
  // does the tag + release cutting via `run-pr-merge.yml`. The
  // `cleanup-staging` job stays inline here because it's AWS-only and
  // centralizing it would just add a network hop without consolidating
  // logic.
  const prMerge = `name: PR Merge Handler

on:
  pull_request_target:
    types: [closed]
    branches: [main]

jobs:
  dispatch-release:
    name: Dispatch central release creation
    if: github.event.pull_request.merged == true
    runs-on: ubuntu-latest
    timeout-minutes: 2
    permissions: {}
    steps:
      - name: Mint App token scoped to .github
        id: app-token
        uses: actions/create-github-app-token@v1
        with:
          app-id: \${{ secrets.NEMAR_APP_ID }}
          private-key: \${{ secrets.NEMAR_APP_PRIVATE_KEY }}
          owner: nemarDatasets
          repositories: .github

      - name: Dispatch run-pr-merge
        env:
          GH_TOKEN: \${{ steps.app-token.outputs.token }}
        run: |
          set -euo pipefail
          DATASET_ID="\${{ github.event.repository.name }}"
          PR_NUMBER="\${{ github.event.pull_request.number }}"
          echo "Dispatching run-pr-merge for $DATASET_ID (PR #$PR_NUMBER)"
          gh api "repos/nemarDatasets/.github/dispatches" \\
            -f event_type=run-pr-merge \\
            -f "client_payload[dataset_id]=$DATASET_ID" \\
            -f "client_payload[pr_number]=$PR_NUMBER"

  cleanup-staging:
    name: Cleanup Staging (runs on merge or close)
    if: always()
    runs-on: ubuntu-latest
    timeout-minutes: 5
    permissions: {}
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

  // generate-archive.yml relocated to nemarDatasets/.github/.github/workflows/run-generate-archive.yml
  // and triggered via repository_dispatch from the Worker (`triggerArchiveGeneration` above
  // now targets `nemarDatasets/.github` rather than the dataset repo). Phase 3 of epic #601 /
  // sub-issue #608. Existing dataset repos are cleaned via scripts/strip-per-repo-workflow.ts
  // --workflow generate-archive.yml.

  // llm-enrichment.yml relocated to nemarDatasets/.github/.github/workflows/run-enrichment.yml
  // and triggered via repository_dispatch from POST /webhooks/github. Phase 1 of
  // epic #601 / sub-issue #602. Existing dataset repos are cleaned by
  // scripts/strip-per-repo-llm-enrichment.ts.
  // version-doi.yml relocated to nemarDatasets/.github/.github/workflows/run-version-doi.yml
  // and triggered via repository_dispatch from POST /webhooks/github on tag pushes.
  // Phase 2 of epic #601 / sub-issue #606. Existing dataset repos are cleaned via
  // scripts/strip-per-repo-workflow.ts --workflow .github/workflows/version-doi.yml.

  return [
    { path: ".github/workflows/bids-validation.yml", content: bidsValidation },
    { path: ".github/workflows/version-check.yml", content: versionCheck },
    { path: ".github/workflows/pr-merge.yml", content: prMerge },
  ];
}

/**
 * Validate that workflow files we just deployed are actually parseable by
 * GitHub Actions. Calls `GET /repos/{org}/{repo}/actions/workflows`; GitHub
 * only lists workflow YAML files it could parse, so any file we deployed
 * that's missing from the list is silently broken.
 *
 * Best-effort: returns `{ valid: [], missing: [...], errors: [...] }` and
 * never throws. Pagination is not implemented — `per_page=100` covers the 6
 * NEMAR workflows comfortably; extend here if `getWorkflowTemplates()` grows
 * past 100 files.
 *
 * `expectedFilenames` are basenames (e.g. `bids-validation.yml`).
 */
async function validateWorkflowsParseable(
  repo: string,
  expectedFilenames: string[],
  pat: string,
): Promise<{ valid: string[]; missing: string[]; errors: string[] }> {
  try {
    // per_page=100 covers page 1 only (no pagination). NEMAR currently
    // deploys 6 workflow templates; page 1 is always sufficient. Add
    // pagination here if getWorkflowTemplates() ever grows past 100 files.
    const response = await githubFetchWithRetry(
      `${GITHUB_API()}/repos/${ORG_NAME}/${repo}/actions/workflows?per_page=100`,
      {
        headers: {
          Authorization: `Bearer ${pat}`,
          Accept: "application/vnd.github.v3+json",
          "User-Agent": "NEMAR-API",
        },
      },
    );
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      // Note: a 429 here is handled by githubFetchWithRetry for up to 3
      // retries. If all retries are exhausted, !response.ok is true and the
      // status (429) lands in the error message below. The deploy itself has
      // already succeeded at this point, so we surface this as a warning.
      return {
        valid: [],
        missing: [],
        errors: [
          `Workflow validation: GitHub API ${response.status} listing workflows: ${body.slice(0, 200)}`,
        ],
      };
    }
    const data = (await response.json()) as {
      workflows?: Array<{ path?: string; name?: string }>;
    };
    const listed = new Set<string>();
    for (const w of data.workflows ?? []) {
      if (typeof w.path === "string") {
        const parts = w.path.split("/");
        const basename = parts[parts.length - 1];
        if (basename) listed.add(basename);
      }
    }
    // A workflow with state: "disabled_manually" is still listed here.
    // Presence means GitHub Actions can parse the file; disabled state is
    // irrelevant to parseability and is intentionally not checked.
    const valid: string[] = [];
    const missing: string[] = [];
    for (const name of expectedFilenames) {
      if (listed.has(name)) valid.push(name);
      else missing.push(name);
    }
    return { valid, missing, errors: [] };
  } catch (err) {
    return {
      valid: [],
      missing: [],
      errors: [`Workflow validation: ${err instanceof Error ? err.message : String(err)}`],
    };
  }
}

/**
 * Deploy every CI workflow template to a dataset repo in a single
 * tree-batched commit. All-or-nothing: on failure, `deployed` is empty
 * (no partial deployment, unlike the prior per-file loop that could
 * half-succeed). Callers MUST check `success` — this function never throws.
 *
 * Post-deploy parseability validation lives in `validateDeployedWorkflows()`
 * and is driven by the CLI after this call returns (issue #472). Keeping the
 * sleep + listing retry out of the Worker preserves the request wall-clock
 * budget; the CLI polls on the user's machine instead.
 */
export async function deployWorkflows(
  repo: string,
  pat: string,
): Promise<{
  success: boolean;
  errors: string[];
  deployed: string[];
}> {
  const workflows = getWorkflowTemplates();
  const files: TreeFile[] = workflows.map((w) => ({ path: w.path, content: w.content }));
  const deployedNames = workflows.map((w) => {
    const parts = w.path.split("/");
    return parts[parts.length - 1] ?? w.path;
  });

  try {
    await commitFilesAsTree(repo, "main", files, "Add CI workflows", pat);
  } catch (err) {
    return {
      success: false,
      errors: [err instanceof Error ? err.message : String(err)],
      deployed: [],
    };
  }

  return { success: true, errors: [], deployed: deployedNames };
}

/**
 * One-shot parseability probe for the workflows `deployWorkflows()` writes.
 * Returns the listing diff against `getWorkflowTemplates()` so callers can
 * surface which (if any) deployed files GitHub Actions failed to parse.
 *
 * No outer sleeps or backoff retries — the CLI orchestrates wait timing and
 * the missing-workflow retry on the user's machine (the whole point of
 * issue #472 was getting that out of the Worker). Transport-level retries
 * for 5xx responses are still handled internally by `githubFetchWithRetry`
 * (up to 3 attempts), so a sustained 500 here surfaces in `errors` after
 * the internal retries have been exhausted.
 *
 * Best-effort: never throws; transport / API errors land in `errors`.
 */
export async function validateDeployedWorkflows(
  repo: string,
  pat: string,
): Promise<{ valid: string[]; missing: string[]; errors: string[] }> {
  const expectedNames = getWorkflowTemplates().map((w) => {
    const parts = w.path.split("/");
    return parts[parts.length - 1] ?? w.path;
  });
  return validateWorkflowsParseable(repo, expectedNames, pat);
}

/**
 * List the file paths currently present under `.github/workflows` on the repo's
 * given branch. Returns paths relative to the repo root (e.g.
 * `.github/workflows/bids-validation.yml`). A 404 on the directory itself
 * (workflows folder not yet created) is treated as "empty", not an error.
 *
 * ONLY regular files count as "present". Symlinks are deliberately treated
 * as MISSING: in older DataLad-style repos a workflow YAML may be annexed,
 * which GitHub returns as `type: "symlink"`. GitHub Actions cannot read /
 * execute symlinked workflows, so a symlinked file looks deployed in the
 * Contents API but is actually broken. We want
 * `ensureWorkflowsDeployed` / `syncWorkflowTemplates` to overwrite it with
 * a real file blob instead of skipping it.
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
  return new Set(entries.filter((e) => e.type === "file").map((e) => e.path));
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
 *
 * Phase 3 of centralization epic #601 (sub-issue #608): the workflow now
 * lives at `nemarDatasets/.github/.github/workflows/run-generate-archive.yml`
 * and dispatches use the central repo, NOT the dataset repo. The legacy
 * `repo` parameter is preserved in the signature for callsite stability
 * (CLI + admin endpoints pass the dataset repo name); it's no longer used
 * to address the dispatch target, only logged for traceability.
 *
 * client_payload shape stays compatible: `dataset_id`, `version`, `public`.
 * The central workflow mints a per-repo App token scoped to `dataset_id`
 * and checks out the dataset repo at `v$VERSION`.
 */
export async function triggerArchiveGeneration(
  repo: string,
  datasetId: string,
  version: string,
  pat: string,
  options?: { public?: boolean },
): Promise<void> {
  // Sanity check the legacy parameter so callsites that still pass the
  // dataset's own repo name don't drift from the dataset_id payload.
  if (repo !== datasetId) {
    console.warn(
      `[generate-archive] repo (${repo}) and datasetId (${datasetId}) differ; dispatching with dataset_id=${datasetId}`,
    );
  }
  const response = await fetch(`${GITHUB_API()}/repos/${CENTRAL_WORKFLOW_REPO}/dispatches`, {
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

/**
 * Trigger Zarr serving-copy generation via repository_dispatch (epic #684).
 *
 * Sibling to `triggerArchiveGeneration`: dispatches `generate-zarr` on the
 * central `nemarDatasets/.github` repo (NOT the dataset repo). The central
 * `run-generate-zarr.yml` workflow mints a per-repo App token, checks out the
 * dataset repo at `ref` (with full history), diffs HEAD against the
 * last-converted commit recorded in `s3://nemar/<id>/zarr/index.json`, converts
 * only the changed recordings with biosigIO, writes the per-recording stores to
 * `s3://nemar/<id>/zarr/...` (latest-only), and POSTs back to
 * `/webhooks/zarr-ready`.
 *
 * `ref` is a branch name (`main`) or a commit SHA. `full=true` forces a
 * whole-tree conversion (first conversion / backfill / recovery), bypassing the
 * incremental diff. The client_payload deliberately carries no file list -- the
 * workflow self-diffs, which avoids the repository_dispatch payload-size cap on
 * large datasets and self-heals a missed dispatch on the next push.
 */
export async function triggerZarrGeneration(
  datasetId: string,
  ref: string,
  pat: string,
  options?: { full?: boolean },
): Promise<void> {
  const response = await fetch(`${GITHUB_API()}/repos/${CENTRAL_WORKFLOW_REPO}/dispatches`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${pat}`,
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "NEMAR-API",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      event_type: "generate-zarr",
      client_payload: {
        dataset_id: datasetId,
        ref,
        full: options?.full ?? false,
      },
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to trigger zarr generation: HTTP ${response.status} - ${error}`);
  }
}

/** Central tooling repo where the manifest workflow lives. Targeted by
 *  `triggerManifestGeneration` regardless of the dataset's own repo.
 *  Relocated from `nemarOrg/nemar-cli` to `nemarDatasets/.github` (#564)
 *  so Actions minutes bill against the dataset org's Team plan rather
 *  than the constrained Free-plan tooling org. */
export const CENTRAL_WORKFLOW_REPO = "nemarDatasets/.github";

/**
 * Trigger central manifest generation via repository_dispatch on
 * `nemarDatasets/.github` (NOT the individual dataset repo). The workflow
 * checks out the dataset repo's version tag, walks the tree, builds the
 * manifest + summary, uploads both to S3, and then POSTs back to
 * `callback_url`.
 *
 * Mirrors `triggerArchiveGeneration` style for error handling. The `pat`
 * must be an App-installation token (or PAT fallback) authorized on the
 * nemarDatasets org -- use `getDatasetsToken()`.
 *
 * `options.skipCanary` (default false) is the dispatch-path twin of the
 * inline `generateManifest()` `skipGitBackedVerification` option: when
 * the dataset repo is private, raw.githubusercontent.com cannot serve
 * an unauthenticated HEAD, so Stream A's Python workflow disables its
 * git-backed canary verification when this flag is set.
 */
export async function triggerManifestGeneration(
  datasetId: string,
  version: string,
  doi: string | null,
  conceptDoi: string | null,
  callbackToken: string,
  callbackUrl: string,
  pat: string,
  options?: { skipCanary?: boolean; skipCallback?: boolean },
): Promise<void> {
  const response = await fetch(`${GITHUB_API()}/repos/${CENTRAL_WORKFLOW_REPO}/dispatches`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${pat}`,
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "NEMAR-API",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      event_type: "generate-manifest",
      client_payload: {
        dataset_id: datasetId,
        version,
        doi,
        concept_doi: conceptDoi,
        callback_token: callbackToken,
        callback_url: callbackUrl,
        skip_canary: options?.skipCanary ?? false,
        // skip_callback=true is for manual backfill — the Worker has no
        // in-flight manifest_jobs row to validate against, so the workflow
        // skips its POST to /webhooks/manifest-ready. The workflow still
        // writes manifest.json + summary.json to S3 normally.
        skip_callback: options?.skipCallback ?? false,
      },
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to trigger manifest generation: HTTP ${response.status} - ${error}`);
  }
}

/**
 * Trigger the central version-DOI workflow on `nemarDatasets/.github` via
 * `repository_dispatch[run-version-doi]`. The workflow mints a per-repo App
 * token scoped to `datasetId`, checks out that repo at the tag, refreshes
 * enrichment, POSTs to `/webhooks/publish-version-doi`, and dispatches
 * generate-archive against the target dataset repo. No callback handshake —
 * `/webhooks/publish-version-doi` itself is the round-trip that updates D1
 * (and is idempotent on the version-DOI ledger so a duplicate dispatch
 * during the Phase 2 cutover window is safe).
 *
 * Mirrors `triggerEnrichmentRun` and `triggerManifestGeneration`. The `pat`
 * must carry write access on `nemarDatasets/.github`'s dispatch endpoint —
 * use `getDatasetsToken()`. Phase 2 of epic #601 (sub-issue #606).
 */
export async function triggerVersionDoiRun(
  datasetId: string,
  tag: string,
  pat: string,
): Promise<void> {
  const response = await fetch(`${GITHUB_API()}/repos/${CENTRAL_WORKFLOW_REPO}/dispatches`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${pat}`,
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "NEMAR-API",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      event_type: "run-version-doi",
      client_payload: {
        dataset_id: datasetId,
        tag,
      },
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to trigger version-doi run: HTTP ${response.status} - ${error}`);
  }
}

/**
 * Trigger the central LLM-enrichment workflow on `nemarDatasets/.github` via
 * `repository_dispatch[run-enrichment]`. The workflow mints a per-repo App
 * token scoped to `datasetId`, checks out that repo at `ref`, POSTs to
 * `/webhooks/llm-enrich`, and commits the returned `.nemar/metadata.json`
 * back to the dataset repo. No callback handshake — the workflow's POST to
 * `/webhooks/llm-enrich` IS the round-trip that updates D1.
 *
 * Wraps the same dispatch shape as `triggerManifestGeneration`; differs only
 * in the event_type and the (much simpler) client_payload. The `pat` must
 * carry write access on `nemarDatasets/.github`'s dispatch endpoint — use
 * `getDatasetsToken()`.
 *
 * Phase 1 of epic #601 (sub-issue #602). The legacy per-repo
 * `llm-enrichment.yml` is removed in the same PR; existing dataset repos are
 * stripped via `scripts/strip-per-repo-llm-enrichment.ts` as the final
 * cutover step.
 */
export async function triggerEnrichmentRun(
  datasetId: string,
  ref: string,
  force: boolean,
  pat: string,
): Promise<void> {
  const response = await fetch(`${GITHUB_API()}/repos/${CENTRAL_WORKFLOW_REPO}/dispatches`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${pat}`,
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "NEMAR-API",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      event_type: "run-enrichment",
      client_payload: {
        dataset_id: datasetId,
        ref,
        force,
      },
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to trigger enrichment run: HTTP ${response.status} - ${error}`);
  }
}

/**
 * Dispatch the `onboard-openneuro` workflow on `nemarDatasets/.github` to import
 * one or more OpenNeuro datasets (epic #775). Same repository_dispatch shape as
 * `triggerEnrichmentRun`; the workflow's parse-ids reads
 * `client_payload.openneuro_ids`. `pat` must carry dispatch write on
 * `nemarDatasets/.github` -- use `getDatasetsToken()`. `fetchImpl` defaults to
 * the global fetch (injectable for tests).
 */
export async function triggerOpenNeuroOnboard(
  openneuroIds: string,
  pat: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const response = await fetchImpl(`${GITHUB_API()}/repos/${CENTRAL_WORKFLOW_REPO}/dispatches`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${pat}`,
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "NEMAR-API",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      event_type: "onboard-openneuro",
      client_payload: { openneuro_ids: openneuroIds },
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to trigger OpenNeuro onboard: HTTP ${response.status} - ${error}`);
  }
}

/**
 * Pure builder for the `run-bids-validation` repository_dispatch payload sent to
 * `nemarDatasets/.github`. Mirrors the per-repo shim's dispatch
 * (`getWorkflowTemplates`) so a manual re-validation produces the same central
 * check-run. Extracted as a pure function so the shape is unit-testable without
 * a network call. `pr_number` is empty for branch-level (non-PR) revalidation.
 */
export function buildBidsValidationDispatch(
  datasetId: string,
  headSha: string,
  ref = "main",
): { event_type: string; client_payload: Record<string, string> } {
  return {
    event_type: "run-bids-validation",
    client_payload: {
      dataset_id: datasetId,
      ref,
      head_sha: headSha,
      pr_number: "",
      validator_version: VALIDATOR_VERSION,
    },
  };
}

/**
 * Trigger central BIDS validation on a dataset's branch HEAD by dispatching
 * `run-bids-validation` at `nemarDatasets/.github` (same path the per-repo shim
 * takes). Used by the `revalidate` admin flow to re-post a `Run BIDS Validation`
 * check-run on `main` HEAD when the shim is already deployed (so `ci/sync` is a
 * no-op). `pat` must carry dispatch access on the central repo -- use
 * `getDatasetsToken()`. Mirrors `triggerEnrichmentRun`'s error handling.
 */
export async function triggerBidsValidation(
  datasetId: string,
  headSha: string,
  pat: string,
  ref = "main",
): Promise<void> {
  const response = await fetch(`${GITHUB_API()}/repos/${CENTRAL_WORKFLOW_REPO}/dispatches`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${pat}`,
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "NEMAR-API",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(buildBidsValidationDispatch(datasetId, headSha, ref)),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to trigger BIDS validation: HTTP ${response.status} - ${error}`);
  }
}

/**
 * Trigger the publication pre-screen workflow on `nemarDatasets/.github` via
 * `repository_dispatch[run-prescreen]` (issue #666). The workflow mints a
 * per-repo App token, checks out the dataset metadata, runs `claude -p` to
 * judge README / dataset_description / declared-data completeness, opens a
 * GitHub issue on the dataset repo when it blocks, and POSTs a verdict to
 * `callbackUrl` (/webhooks/prescreen-result) carrying `callbackToken`.
 *
 * Mirrors `triggerEnrichmentRun`'s dispatch shape. `pat` must carry write
 * access on the central repo's dispatch endpoint -- use `getDatasetsToken()`.
 */
export async function triggerPrescreenRun(
  datasetId: string,
  ref: string,
  requestId: number,
  callbackToken: string,
  callbackUrl: string,
  pat: string,
): Promise<void> {
  const response = await fetch(`${GITHUB_API()}/repos/${CENTRAL_WORKFLOW_REPO}/dispatches`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${pat}`,
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "NEMAR-API",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      event_type: "run-prescreen",
      client_payload: {
        dataset_id: datasetId,
        ref,
        request_id: requestId,
        callback_token: callbackToken,
        callback_url: callbackUrl,
      },
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to trigger prescreen run: HTTP ${response.status} - ${error}`);
  }
}

// ============================================================================
// Manifest callback HMAC tokens
// ============================================================================
//
// The Worker signs a one-shot HMAC-SHA256 token over {dataset_id, version,
// nonce} with `MANIFEST_CALLBACK_SECRET` and includes it in the dispatch
// `client_payload.callback_token`. The central workflow echoes it back in
// the `X-Webhook-Token` header on `/webhooks/manifest-ready`. The Worker
// re-derives the expected signature and rejects any mismatch with
// constant-time compare.
//
// Single-use is enforced by the `manifest_jobs` row (UNIQUE on
// (dataset_id, version, nonce) + status flip), not by the HMAC itself.
// The HMAC just proves the central workflow saw the dispatch payload.

export interface ManifestCallbackPayload {
  datasetId: string;
  version: string;
  nonce: string;
}

/** Canonical payload encoding -- pinned so signer and verifier agree. */
function encodeManifestCallbackPayload(payload: ManifestCallbackPayload): string {
  return `${payload.datasetId}\n${payload.version}\n${payload.nonce}`;
}

function toHex(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let out = "";
  for (let i = 0; i < view.length; i++) {
    out += view[i].toString(16).padStart(2, "0");
  }
  return out;
}

/**
 * Sign a manifest callback payload with HMAC-SHA256.
 * Returns a hex-encoded digest. Uses Workers' built-in `crypto.subtle`.
 */
export async function signManifestCallbackToken(
  payload: ManifestCallbackPayload,
  secret: string,
): Promise<string> {
  if (!secret) {
    throw new Error("signManifestCallbackToken: secret is required");
  }
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(encodeManifestCallbackPayload(payload)),
  );
  return toHex(signature);
}

/**
 * Constant-time byte-array compare. Cloudflare Workers exposes
 * `crypto.subtle.timingSafeEqual`; standard runtimes (Bun/Node test
 * harness) don't, so we fall back to a manual XOR-accumulate that runs
 * in time proportional to the (equal) length but doesn't short-circuit
 * on a mismatched byte. Both branches reject length mismatches up
 * front to keep the invariant simple.
 */
function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  const subtle = (crypto as { subtle: { timingSafeEqual?: typeof crypto.subtle.timingSafeEqual } })
    .subtle;
  if (typeof subtle.timingSafeEqual === "function") {
    return subtle.timingSafeEqual(a, b);
  }
  let diff = 0;
  for (let i = 0; i < a.byteLength; i++) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

/**
 * Verify a manifest callback token against a claimed payload.
 * Constant-time compare via `crypto.subtle.timingSafeEqual` (Workers)
 * or a portable XOR-accumulate (other runtimes) to defeat timing
 * oracles. Returns true iff the digest matches.
 */
export async function verifyManifestCallbackToken(
  token: string,
  payload: ManifestCallbackPayload,
  secret: string,
): Promise<boolean> {
  if (!token || !secret) return false;
  // Crypto failures here mean MANIFEST_CALLBACK_SECRET is malformed; surface
  // as 500 (via Hono's default error handler) not 401, so operators can
  // distinguish "broken secret on worker" from "wrong token from caller".
  const expected = await signManifestCallbackToken(payload, secret);
  const encoder = new TextEncoder();
  return constantTimeEqual(encoder.encode(token), encoder.encode(expected));
}

// ============================================================================
// Pre-screen callback HMAC tokens (issue #666)
// ============================================================================
//
// Same one-shot HMAC handshake as the manifest callback above, signed over
// {dataset_id, request_id, nonce}. The Worker stores the nonce on the
// publication_requests row at dispatch time and puts the token in the
// dispatch client_payload; the workflow echoes it back in X-Webhook-Token.
// Single-use is enforced by the row's prescreen_status='pending' -> done
// flip, not the HMAC itself.

export interface PrescreenCallbackPayload {
  datasetId: string;
  requestId: number;
  nonce: string;
}

/** Canonical payload encoding -- pinned so signer and verifier agree. */
function encodePrescreenCallbackPayload(payload: PrescreenCallbackPayload): string {
  return `${payload.datasetId}\n${payload.requestId}\n${payload.nonce}`;
}

/** Sign a pre-screen callback payload with HMAC-SHA256 (hex digest). */
export async function signPrescreenCallbackToken(
  payload: PrescreenCallbackPayload,
  secret: string,
): Promise<string> {
  if (!secret) {
    throw new Error("signPrescreenCallbackToken: secret is required");
  }
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(encodePrescreenCallbackPayload(payload)),
  );
  return toHex(signature);
}

/** Verify a pre-screen callback token (constant-time). */
export async function verifyPrescreenCallbackToken(
  token: string,
  payload: PrescreenCallbackPayload,
  secret: string,
): Promise<boolean> {
  if (!token || !secret) return false;
  const expected = await signPrescreenCallbackToken(payload, secret);
  const encoder = new TextEncoder();
  return constantTimeEqual(encoder.encode(token), encoder.encode(expected));
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
 *
 * `refreshTokenOn401` (optional): when set, a one-off 401 from GitHub
 * triggers a fresh-mint of the bearer token before the call is retried
 * exactly once. Wire from `getDatasetsTokenWithRefresher` to make this
 * call self-heal across stale App-installation-token caches. Issue #596.
 */
export async function getTreeAtRef(
  repo: string,
  ref: string,
  pat: string,
  refreshTokenOn401?: () => Promise<string>,
): Promise<TreeEntry[]> {
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
    { retryOn404: true, refreshTokenOn401 },
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
    { refreshTokenOn401 },
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

/** Max `sub-*` subjects sampled by getBidsTreeStats (bounds API calls). */
const MAX_SUBJECTS_FOR_MODALITY = 25;

/**
 * Evenly sample up to `max` items, always including the first and last. Used to
 * bound the per-subject tree fetches in getBidsTreeStats while still spreading
 * the sample across the subject list (so a modality/task present only in later
 * subjects is more likely to be seen than first-N sampling would).
 */
export function sampleEvenly<T>(items: T[], max: number): T[] {
  if (items.length <= max) return items;
  const out: T[] = [];
  const step = (items.length - 1) / (max - 1);
  for (let i = 0; i < max; i++) out.push(items[Math.round(i * step)]);
  return out;
}

/**
 * Datatypes found in ONE subject's subtree, where paths are RELATIVE to the
 * subject directory: a datatype dir sits directly under the subject
 * (`eeg/...`) or under a session (`ses-01/eeg/...`). Pure; unit-tested.
 */
export function modalitiesFromSubjectSubtree(relPaths: string[]): string[] {
  const found = new Set<string>();
  for (const p of relPaths) {
    const parts = p.split("/");
    if (BIDS_DATATYPES.has(parts[0])) {
      found.add(parts[0]);
    } else if (parts.length >= 2 && parts[0].startsWith("ses-") && BIDS_DATATYPES.has(parts[1])) {
      found.add(parts[1]);
    }
  }
  return [...found];
}

/**
 * BIDS task labels found in a subject's subtree filenames, matching
 * `extractTasks`'s `_task-<label>` regex in bids-tree.ts (kept in sync).
 * Pure; unit-tested.
 */
export function tasksFromSubjectSubtree(relPaths: string[]): string[] {
  const found = new Set<string>();
  for (const p of relPaths) {
    const m = p.match(/_task-([^_./]+)/);
    if (m) found.add(m[1]);
  }
  return [...found];
}

/** Truncation-immune BIDS metadata derived from the raw subject tree. */
export interface BidsTreeStats {
  /** Sorted raw datatype dirs (modalities). Sampled across subjects. */
  modalities: string[];
  /** COMPLETE count of root-level `sub-*` dirs (not sampled). */
  subjectCount: number;
  /** Sorted task labels. Sampled across subjects (union with tree paths upstream). */
  tasks: string[];
  /** Representative EEG channel count from an exemplar recording (#858).
   *  Undefined when no EEG `*_channels.tsv` / `*_eeg.json` was sampled. */
  nChannels?: number;
  /** Scalp montage class from the exemplar's channel labels (#858). */
  electrodeSystem?: string;
  /** Whether this ref carries HED annotations: HEDVersion declared AND >=1 real
   *  HED key in an events sidecar (#869). Undefined when the probe couldn't run
   *  (no dataset_description.json) OR any fetch/parse failure inside probeHed ->
   *  column stays NULL (vs false -> 0 = checked, no HED). */
  hasHed?: boolean;
  /** The `HEDVersion` string (array form comma-joined), or undefined (#869). */
  hedVersion?: string;
}

/**
 * Truncation-immune BIDS stats (#820, #827). GitHub caps the recursive git tree
 * (~100k entries / 7MB) and a large `derivatives/` tree (which sorts before the
 * raw subject dirs) can fill the whole response, so `getTreeAtRef` silently
 * drops every raw `sub-<id>/<datatype>/` path -- on006110 came back `anat,func`
 * (from fmriprep derivatives) with `eeg` missing AND subject_count NULL. This
 * walks ONLY the raw BIDS structure: the root tree (non-recursive) gives the
 * COMPLETE `sub-*` list (subjectCount), then a bounded, evenly-spread sample of
 * those subjects' subtrees (each small, never truncated, since derivatives live
 * outside the subject dirs) gives modalities + tasks. Returns zeros/[] for a
 * non-BIDS layout (no root `sub-*`) so callers fall back to the path-list
 * detectors. All-or-nothing on subtree fetch failure (a partial sample would
 * silently under-report and then override the path-list result).
 */
export async function getBidsTreeStats(
  repo: string,
  ref: string,
  pat: string,
  refreshTokenOn401?: () => Promise<string>,
): Promise<BidsTreeStats> {
  const ghHeaders = {
    Authorization: `Bearer ${pat}`,
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "NEMAR-API",
  };
  const refResponse = await githubFetchWithRetry(
    `${GITHUB_API()}/repos/${ORG_NAME}/${repo}/commits/${ref}`,
    { headers: ghHeaders },
    { retryOn404: true, refreshTokenOn401 },
  );
  if (!refResponse.ok) {
    throw new HttpError(
      `Failed to resolve ref '${ref}': HTTP ${refResponse.status}`,
      refResponse.status,
    );
  }
  const commit = await refResponse.json<{ commit: { tree: { sha: string } } }>();
  const rootSha = commit.commit.tree.sha;

  // Root tree, NON-recursive: cheap, never truncated, lists every top-level dir.
  const rootResponse = await githubFetchWithRetry(
    `${GITHUB_API()}/repos/${ORG_NAME}/${repo}/git/trees/${rootSha}`,
    { headers: ghHeaders },
    { refreshTokenOn401 },
  );
  if (!rootResponse.ok) {
    throw new HttpError(
      `Failed to get root tree: HTTP ${rootResponse.status}`,
      rootResponse.status,
    );
  }
  const root = await rootResponse.json<{ tree: TreeEntry[] }>();
  // HED probe inputs from the root tree (#869): dataset_description.json
  // (HEDVersion) and the first root-level inherited `*_events.json` -- many HED
  // datasets annotate once at the top level rather than per subject.
  const descEntry = root.tree.find(
    (e) => e.type === "blob" && e.path === "dataset_description.json",
  );
  const rootEventsJson = root.tree.find(
    (e) => e.type === "blob" && /^[^/]*_events\.json$/.test(e.path),
  );
  const subjectDirs = root.tree.filter((e) => e.type === "tree" && e.path.startsWith("sub-"));
  if (subjectDirs.length === 0) return { modalities: [], subjectCount: 0, tasks: [] };

  const mods = new Set<string>();
  const tasks = new Set<string>();
  // First EEG sidecars seen across the sampled subjects -> one exemplar probe for
  // channel count + montage (#858). Captured as blob entries; fetched after the
  // loop so the probe never adds latency to the modality/task walk.
  let exemplarChannelsTsv: TreeEntry | undefined;
  let exemplarEegJson: TreeEntry | undefined;
  // Subject-level events sidecars for HED detection (#869). Not eeg-scoped: HED
  // can annotate any datatype's events. First of each across sampled subjects.
  let exemplarEventsJson: TreeEntry | undefined;
  let exemplarEventsTsv: TreeEntry | undefined;
  for (const subj of sampleEvenly(subjectDirs, MAX_SUBJECTS_FOR_MODALITY)) {
    const subResponse = await githubFetchWithRetry(
      `${GITHUB_API()}/repos/${ORG_NAME}/${repo}/git/trees/${subj.sha}?recursive=1`,
      { headers: ghHeaders },
      { refreshTokenOn401 },
    );
    // All-or-nothing: a sampled subtree that still fails after retries makes the
    // result UNTRUSTWORTHY (a partial set would silently under-report and then
    // override the path-list detector). Throw so the caller falls back.
    if (!subResponse.ok) {
      throw new HttpError(
        `Failed to read subtree for ${repo} ${subj.path}: HTTP ${subResponse.status}`,
        subResponse.status,
      );
    }
    const sub = await subResponse.json<{ tree: TreeEntry[] }>();
    const paths = sub.tree.map((e) => e.path);
    for (const m of modalitiesFromSubjectSubtree(paths)) mods.add(m);
    for (const t of tasksFromSubjectSubtree(paths)) tasks.add(t);
    // Subtree paths are relative to the subject dir, so an EEG sidecar sits at
    // `eeg/...` or `ses-*/eeg/...`. Keep the first of each.
    for (const e of sub.tree) {
      if (e.type !== "blob") continue;
      if (!exemplarChannelsTsv && /(^|\/)eeg\/[^/]*_channels\.tsv$/.test(e.path)) {
        exemplarChannelsTsv = e;
      } else if (!exemplarEegJson && /(^|\/)eeg\/[^/]*_eeg\.json$/.test(e.path)) {
        exemplarEegJson = e;
      } else if (!exemplarEventsJson && /(^|\/)[^/]*_events\.json$/.test(e.path)) {
        exemplarEventsJson = e;
      } else if (!exemplarEventsTsv && /(^|\/)[^/]*_events\.tsv$/.test(e.path)) {
        exemplarEventsTsv = e;
      }
    }
  }

  const { nChannels, electrodeSystem } = await probeChannelMontage(
    repo,
    exemplarChannelsTsv,
    exemplarEegJson,
    pat,
    refreshTokenOn401,
  );
  const { hasHed, hedVersion } = await probeHed(
    repo,
    descEntry,
    [rootEventsJson, exemplarEventsJson],
    exemplarEventsTsv,
    pat,
    refreshTokenOn401,
  );

  return {
    modalities: [...mods].sort(),
    subjectCount: subjectDirs.length,
    tasks: [...tasks].sort(),
    nChannels,
    electrodeSystem,
    hasHed,
    hedVersion,
  };
}

/**
 * Best-effort channel-count + montage probe for getBidsTreeStats (#858). Fetches
 * the exemplar EEG `*_channels.tsv` (+ `*_eeg.json` sidecar) blobs and runs the
 * pure classifiers. Channel data is secondary to the modality/subject walk, so
 * any failure (annex pointer, fetch error, parse miss) returns empty rather than
 * throwing -- the caller leaves the columns NULL.
 */
async function probeChannelMontage(
  repo: string,
  channelsTsv: TreeEntry | undefined,
  eegJson: TreeEntry | undefined,
  pat: string,
  refreshTokenOn401?: () => Promise<string>,
): Promise<{ nChannels?: number; electrodeSystem?: string }> {
  if (!channelsTsv && !eegJson) return {};
  try {
    let tsv: ReturnType<typeof parseChannelsTsv> = null;
    let sidecar: number | null = null;
    if (channelsTsv) {
      tsv = parseChannelsTsv(await getBlobContent(repo, channelsTsv.sha, pat, refreshTokenOn401));
    }
    if (eegJson) {
      sidecar = parseEegChannelCount(
        await getBlobContent(repo, eegJson.sha, pat, refreshTokenOn401),
      );
    }
    const n = resolveNChannels(sidecar, tsv);
    const sys = tsv ? classifyElectrodeSystem(tsv.labels) : null;
    return { nChannels: n ?? undefined, electrodeSystem: sys ?? undefined };
  } catch (err) {
    console.warn(
      `[getBidsTreeStats] channel/montage probe failed for ${repo}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return {};
  }
}

/**
 * Best-effort HED probe for getBidsTreeStats (#869). Reads `HEDVersion` from
 * dataset_description.json and scans candidate events sidecars for a real HED
 * annotation; `hasHed` is true only when BOTH hold (migration 0056 rule). Like
 * probeChannelMontage this is secondary data -- any failure returns empty so the
 * columns stay NULL. Returns empty (not `hasHed:false`) when there's no
 * dataset_description.json to read, since "checked, no HED" can't be asserted.
 */
async function probeHed(
  repo: string,
  descEntry: TreeEntry | undefined,
  eventsJson: Array<TreeEntry | undefined>,
  eventsTsv: TreeEntry | undefined,
  pat: string,
  refreshTokenOn401?: () => Promise<string>,
): Promise<{ hasHed?: boolean; hedVersion?: string }> {
  if (!descEntry) return {};
  try {
    const desc = JSON.parse(await getBlobContent(repo, descEntry.sha, pat, refreshTokenOn401));
    const hedVersion = parseHedVersion(desc);
    // No HEDVersion declared -> definitively not a HED dataset (checked => 0); no
    // need to fetch the events blobs.
    if (hedVersion == null) return { hasHed: false };
    let annotation = false;
    for (const entry of eventsJson) {
      if (!entry) continue;
      if (eventsJsonHasHed(await getBlobContent(repo, entry.sha, pat, refreshTokenOn401))) {
        annotation = true;
        break;
      }
    }
    if (!annotation && eventsTsv) {
      annotation = eventsTsvHasHed(
        await getBlobContent(repo, eventsTsv.sha, pat, refreshTokenOn401),
      );
    }
    return { hasHed: annotation, hedVersion };
  } catch (err) {
    console.warn(
      `[getBidsTreeStats] HED probe failed for ${repo}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return {};
  }
}

/**
 * Get the content of a blob by SHA. Returns the decoded text content.
 * Uses the blob API to get base64-encoded content.
 *
 * `refreshTokenOn401` mirrors `getTreeAtRef`'s parameter — wire it from
 * `getDatasetsTokenWithRefresher` so the call self-heals from a one-off
 * stale-App-token 401. Issue #596.
 */
export async function getBlobContent(
  repo: string,
  blobSha: string,
  pat: string,
  refreshTokenOn401?: () => Promise<string>,
): Promise<string> {
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
    { retryOn404: true, refreshTokenOn401 },
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
 * NEMAR GitHub App id (`nemar-publish-bot`). Required status checks are pinned
 * to this integration so only a check-run posted by the App satisfies them
 * (spoof-resistant), and the App is a ruleset bypass actor so its automation
 * (enrichment commit-to-main, version-DOI / pr-merge `v*` tag pushes) is not
 * blocked by the PR rule that gates humans. Epic #713.
 */
export const NEMAR_APP_ID = 3679074;

/** Ruleset name for dataset-repo branch protection (the idempotent upsert key). */
export const BRANCH_RULESET_NAME = "NEMAR branch protection";

/**
 * Dataset repos created before the centralized-BIDS migration (#601) that still
 * run the OLD inline `bids-validation.yml`, whose check-run is literally named
 * `bids-validation`. Everything else is on the central shim that posts
 * `Run BIDS Validation`.
 */
const LEGACY_INLINE_BIDS_REPOS = new Set(["nm000103", "nm000105", "nm000106", "nm000107"]);

/**
 * A required status check. `integration_id` pins the check to a specific
 * GitHub App so only that App's check-run satisfies it (spoof-resistant); omit
 * it to accept the check from any source.
 */
export interface RequiredCheck {
  context: string;
  integration_id?: number;
}

/**
 * Required status checks for a dataset repo's branch protection (published model
 * = BIDS green + version bump). Two checks:
 *  - BIDS: central-flow repos require `Run BIDS Validation`, posted cross-repo by
 *    the NEMAR App, so it is pinned to the App. The four legacy-inline repos still
 *    emit `bids-validation` from github-actions (not the App), so it is unpinned.
 *  - `version-check`: emitted by github-actions in the dataset repo; unpinned.
 */
export function deriveContexts(repo: string): RequiredCheck[] {
  const bids: RequiredCheck = LEGACY_INLINE_BIDS_REPOS.has(repo)
    ? { context: "bids-validation" }
    : { context: "Run BIDS Validation", integration_id: NEMAR_APP_ID };
  return [bids, { context: "version-check" }];
}

export interface BranchRulesetPayload {
  name: string;
  target: "branch";
  enforcement: "active";
  conditions: { ref_name: { include: string[]; exclude: string[] } };
  bypass_actors: Array<{ actor_id: number; actor_type: string; bypass_mode: string }>;
  rules: Array<Record<string, unknown>>;
}

/**
 * Build the branch-ruleset payload. Pure (no network) so it is unit-testable.
 *
 * - `~DEFAULT_BRANCH` tracks the repo's default branch (robust to main/master).
 * - PR rule with 0 required reviews: a solo author self-merges once checks are
 *   green (GitHub forbids self-approval, so requiring >=1 review would deadlock
 *   single-author datasets).
 * - Required checks carry per-check `integration_id` pinning (see `deriveContexts`);
 *   `strict` off by default (a detached cross-repo App check-run is never
 *   re-triggered by GitHub's up-to-date logic, so `strict:true` would deadlock);
 *   `do_not_enforce_on_create` so a brand-new repo's first push is not blocked
 *   before any check has reported.
 * - `bypass_actors`: the NEMAR App (commit-to-main + tag pushes) and org admins
 *   (break-glass).
 */
export function buildBranchRulesetPayload(opts: {
  checks: RequiredCheck[];
  strict?: boolean;
}): BranchRulesetPayload {
  return {
    name: BRANCH_RULESET_NAME,
    target: "branch",
    enforcement: "active",
    conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
    bypass_actors: [
      { actor_id: NEMAR_APP_ID, actor_type: "Integration", bypass_mode: "always" },
      { actor_id: 1, actor_type: "OrganizationAdmin", bypass_mode: "always" },
    ],
    rules: [
      {
        type: "pull_request",
        parameters: {
          required_approving_review_count: 0,
          dismiss_stale_reviews_on_push: true,
          require_code_owner_review: false,
          require_last_push_approval: false,
          required_review_thread_resolution: false,
        },
      },
      {
        type: "required_status_checks",
        parameters: {
          strict_required_status_checks_policy: opts.strict ?? false,
          do_not_enforce_on_create: true,
          required_status_checks: opts.checks.map((c) =>
            c.integration_id === undefined
              ? { context: c.context }
              : { context: c.context, integration_id: c.integration_id },
          ),
        },
      },
      { type: "non_fast_forward" },
      { type: "deletion" },
    ],
  };
}

/**
 * Idempotently apply the NEMAR branch ruleset to a dataset repo's default
 * branch. GET-first so the create-vs-update decision is unambiguous (POST-then-
 * treat-422 would conflate a name collision with a payload validation error):
 * list the repo's own rulesets (`includes_parents=false`, so an org-inherited
 * ruleset of the same name can't be mistaken for this one), PUT to converge if
 * one named `BRANCH_RULESET_NAME` exists, otherwise POST to create. A 422 on
 * either write is therefore a genuine validation error and is surfaced verbatim.
 * `dryRun` returns the payload without any network call.
 *
 * Worst case ~2 sequential calls plus `githubFetchWithRetry` backoff on a fresh
 * visibility flip (the rulesets endpoint can transiently 404 while ACLs
 * propagate, same as `applyTagProtection`).
 *
 * NOTE (Phase 2, #713): this primitive is intentionally not yet wired into any
 * lifecycle hook. Phase 3 (#717) calls it from make-public (green-gated) and
 * removes it at make-private.
 */
export async function ensureBranchRuleset(
  repo: string,
  pat: string,
  opts: { checks: RequiredCheck[]; strict?: boolean; dryRun?: boolean },
): Promise<{ action: "created" | "updated" | "dryRun"; payload: BranchRulesetPayload }> {
  const payload = buildBranchRulesetPayload({ checks: opts.checks, strict: opts.strict });
  if (opts.dryRun) {
    return { action: "dryRun", payload };
  }

  const headers = {
    Authorization: `Bearer ${pat}`,
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "NEMAR-API",
    "Content-Type": "application/json",
  };
  const rulesetsUrl = `${GITHUB_API()}/repos/${ORG_NAME}/${repo}/rulesets`;

  // List the repo's OWN rulesets only (exclude org/enterprise-inherited ones, so
  // a same-named inherited ruleset is never PUT by mistake).
  const listResp = await githubFetchWithRetry(
    `${rulesetsUrl}?includes_parents=false`,
    { method: "GET", headers },
    { retryOn404: true },
  );
  if (!listResp.ok) {
    const body = await listResp.text().catch(() => "<failed to read body>");
    throw new HttpError(
      `Branch ruleset list failed for ${repo}: HTTP ${listResp.status}: ${body.slice(0, 300)}`,
      listResp.status,
      body.slice(0, 300),
    );
  }
  const rulesets = (await listResp.json()) as Array<{ id: number; name: string }>;
  const existing = rulesets.find((r) => r.name === BRANCH_RULESET_NAME);

  const write = await githubFetchWithRetry(
    existing ? `${rulesetsUrl}/${existing.id}` : rulesetsUrl,
    { method: existing ? "PUT" : "POST", headers, body: JSON.stringify(payload) },
    { retryOn404: true },
  );
  if (write.ok) {
    return { action: existing ? "updated" : "created", payload };
  }

  const body = await write.text().catch(() => "<failed to read body>");
  throw new HttpError(
    `Branch ruleset ${existing ? "update" : "create"} failed for ${repo}: HTTP ${write.status}: ${body.slice(0, 300)}`,
    write.status,
    body.slice(0, 300),
  );
}

// ===========================================================================
// Repo-to-spec enforcement (epic #713, phase #717)
// ===========================================================================

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function ghHeaders(pat: string): Record<string, string> {
  return {
    Authorization: `Bearer ${pat}`,
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "NEMAR-API",
  };
}

/** GitHub collaborator role ranks, low to high. */
const ROLE_RANK: Record<string, number> = {
  pull: 1,
  read: 1,
  triage: 2,
  push: 3,
  write: 3,
  maintain: 4,
  admin: 5,
};
function roleRank(role: string): number {
  return ROLE_RANK[role] ?? 1;
}

export interface DirectCollaborator {
  login: string;
  role_name: string;
}

export interface CollaboratorActions {
  toAdd: Array<{ login: string; role: "push" | "maintain" }>;
  toPromote: Array<{ login: string; role: "push" | "maintain" }>;
  toRemove: string[];
}

/**
 * Pure diff of a repo's CURRENT direct collaborators against the desired set
 * derived from the D1 ledger: owner -> maintain, approved writers -> push.
 *
 * - Owner always retained (never removed/demoted).
 * - Writers promoted to push only if currently below push; never demoted (a
 *   collaborator who already has maintain keeps it).
 * - Any other direct grant (a stray read, a manual non-ledger add) is removed,
 *   unless its login is in `skipLogins`. On a public repo this includes the
 *   meaningless direct `read` grants.
 *
 * Comparison is case-insensitive on login; the original-case login is used for
 * the removal list so the GitHub API call matches.
 */
export function computeCollaboratorActions(opts: {
  current: DirectCollaborator[];
  visibility: "public" | "private";
  ownerLogin: string | null;
  approvedWriters: string[];
  skipLogins?: string[];
  /**
   * Lowercased logins of nemarDatasets org owners/admins. They already hold
   * admin on every repo via org membership, so we never grant, promote, or
   * strip a direct collaborator entry for them: GitHub 422s any attempt to
   * assign them a permission LOWER than admin ("Cannot assign X permission of
   * maintain"), and the grant would be redundant anyway.
   */
  orgAdmins?: string[];
}): CollaboratorActions {
  const ownerLogin = opts.ownerLogin ? opts.ownerLogin.toLowerCase() : null;
  const skip = new Set((opts.skipLogins ?? []).map((s) => s.toLowerCase()));
  const orgAdmins = new Set((opts.orgAdmins ?? []).map((s) => s.toLowerCase()));

  // Keyed by lowercased login for case-insensitive matching, but carrying the
  // ORIGINAL-case login so grants/output use the canonical GitHub username.
  // Org owners/admins are excluded outright: they already have admin via org
  // membership, so a collaborator grant is both redundant and rejected by
  // GitHub with a 422.
  const desired = new Map<string, { login: string; role: "push" | "maintain" }>();
  if (opts.ownerLogin && ownerLogin && !orgAdmins.has(ownerLogin))
    desired.set(ownerLogin, { login: opts.ownerLogin, role: "maintain" });
  for (const w of opts.approvedWriters) {
    const l = w.toLowerCase();
    if (l && l !== ownerLogin && !orgAdmins.has(l)) desired.set(l, { login: w, role: "push" });
  }

  const currentByLogin = new Map(opts.current.map((c) => [c.login.toLowerCase(), c]));
  const toAdd: CollaboratorActions["toAdd"] = [];
  const toPromote: CollaboratorActions["toPromote"] = [];
  for (const [key, { login, role }] of desired) {
    const cur = currentByLogin.get(key);
    if (!cur) {
      toAdd.push({ login, role });
    } else if (roleRank(cur.role_name) < roleRank(role)) {
      toPromote.push({ login, role });
    }
  }

  const toRemove: string[] = [];
  for (const c of opts.current) {
    const login = c.login.toLowerCase();
    if (desired.has(login) || skip.has(login) || login === ownerLogin || orgAdmins.has(login))
      continue;
    toRemove.push(c.login);
  }

  return { toAdd, toPromote, toRemove };
}

/**
 * List a repo's DIRECT collaborators (affiliation=direct). Never uses the
 * `/collaborators/{user}/permission` endpoint, which returns a baseline `read`
 * for ANY user on a public repo and would make every reconcile a false diff.
 */
export async function listDirectCollaborators(
  repo: string,
  pat: string,
): Promise<DirectCollaborator[]> {
  const out: DirectCollaborator[] = [];
  const headers = ghHeaders(pat);
  let page = 1;
  while (true) {
    const r = await githubFetchWithRetry(
      `${GITHUB_API()}/repos/${ORG_NAME}/${repo}/collaborators?affiliation=direct&per_page=100&page=${page}`,
      { headers },
      { retryOn404: true },
    );
    if (!r.ok) {
      const b = await r.text().catch(() => "<failed to read body>");
      throw new HttpError(
        `List collaborators failed for ${repo}: HTTP ${r.status}: ${b.slice(0, 200)}`,
        r.status,
        b.slice(0, 200),
      );
    }
    const items = (await r.json()) as Array<{ login: string; role_name?: string }>;
    if (items.length === 0) break;
    out.push(...items.map((c) => ({ login: c.login, role_name: c.role_name ?? "read" })));
    if (items.length < 100) break;
    page++;
  }
  return out;
}

/**
 * List the lowercased logins of nemarDatasets org Owners. GitHub's members API
 * spells the Owner role `role=admin` (the historical name), and Owners are
 * exactly the accounts that inherit `admin` on every repo in the org. The
 * collaborator reconcile uses this to avoid pointlessly (and unsuccessfully)
 * trying to grant them a direct collaborator role — GitHub 422s any attempt to
 * assign a permission lower than the admin they already hold. Best-effort: a
 * single page covers the handful of NEMAR org Owners; callers treat a throw as
 * "unknown" and lean on `addCollaborator`'s benign-422 handling instead.
 */
export async function listOrgAdmins(pat: string): Promise<Set<string>> {
  const out = new Set<string>();
  const headers = ghHeaders(pat);
  let page = 1;
  while (true) {
    const r = await githubFetchWithRetry(
      `${GITHUB_API()}/orgs/${ORG_NAME}/members?role=admin&per_page=100&page=${page}`,
      { headers },
    );
    if (!r.ok) {
      const b = await r.text().catch(() => "<failed to read body>");
      throw new HttpError(
        `List org admins failed for ${ORG_NAME}: HTTP ${r.status}: ${b.slice(0, 200)}`,
        r.status,
        b.slice(0, 200),
      );
    }
    const items = (await r.json()) as Array<{ login: string }>;
    if (items.length === 0) break;
    for (const m of items) out.add(m.login.toLowerCase());
    if (items.length < 100) break;
    page++;
  }
  return out;
}

export interface CollaboratorReconcileResult {
  added: string[];
  promoted: string[];
  removed: string[];
  errors: string[];
}

/**
 * Reconcile a repo's direct collaborators to the ledger-derived desired set.
 * Never throws; collects per-action errors. See `computeCollaboratorActions`.
 */
export async function reconcileCollaborators(
  opts: {
    repo: string;
    visibility: "public" | "private";
    ownerLogin: string | null;
    approvedWriters: string[];
    skipLogins?: string[];
  },
  pat: string,
): Promise<CollaboratorReconcileResult> {
  const result: CollaboratorReconcileResult = { added: [], promoted: [], removed: [], errors: [] };
  let current: DirectCollaborator[];
  try {
    current = await listDirectCollaborators(opts.repo, pat);
  } catch (e) {
    result.errors.push(`list: ${errText(e)}`);
    return result;
  }
  // Org owners/admins already hold admin via org membership; never try to add
  // them as collaborators. Best-effort — on failure we fall back to
  // addCollaborator's benign-422 handling.
  let orgAdmins: string[] = [];
  try {
    orgAdmins = [...(await listOrgAdmins(pat))];
  } catch (e) {
    console.error(`[reconcile] listOrgAdmins failed for ${opts.repo}: ${errText(e)}`);
  }
  const actions = computeCollaboratorActions({
    current,
    visibility: opts.visibility,
    ownerLogin: opts.ownerLogin,
    approvedWriters: opts.approvedWriters,
    skipLogins: opts.skipLogins,
    orgAdmins,
  });

  for (const a of actions.toAdd) {
    try {
      (await addCollaborator(opts.repo, a.login, a.role, pat))
        ? result.added.push(a.login)
        : result.errors.push(`add ${a.login}`);
    } catch (e) {
      result.errors.push(`add ${a.login}: ${errText(e)}`);
    }
  }
  for (const a of actions.toPromote) {
    try {
      (await addCollaborator(opts.repo, a.login, a.role, pat))
        ? result.promoted.push(a.login)
        : result.errors.push(`promote ${a.login}`);
    } catch (e) {
      result.errors.push(`promote ${a.login}: ${errText(e)}`);
    }
  }
  for (const login of actions.toRemove) {
    try {
      (await removeCollaborator(opts.repo, login, pat))
        ? result.removed.push(login)
        : result.errors.push(`remove ${login}`);
    } catch (e) {
      result.errors.push(`remove ${login}: ${errText(e)}`);
    }
  }
  if (result.errors.length > 0) {
    console.error(`[reconcile-collaborators] ${opts.repo}: ${result.errors.join("; ")}`);
  }
  return result;
}

/** Delete the NEMAR branch ruleset if present (un-publish). No-op if absent. */
export async function removeBranchRuleset(repo: string, pat: string): Promise<boolean> {
  const headers = ghHeaders(pat);
  const rulesetsUrl = `${GITHUB_API()}/repos/${ORG_NAME}/${repo}/rulesets`;
  const list = await githubFetchWithRetry(
    `${rulesetsUrl}?includes_parents=false`,
    { method: "GET", headers },
    { retryOn404: true },
  );
  if (!list.ok) {
    if (list.status === 404) return false;
    const b = await list.text().catch(() => "<failed to read body>");
    throw new HttpError(
      `Branch ruleset list failed for ${repo}: HTTP ${list.status}: ${b.slice(0, 200)}`,
      list.status,
      b.slice(0, 200),
    );
  }
  const rulesets = (await list.json()) as Array<{ id: number; name: string }>;
  const existing = rulesets.find((r) => r.name === BRANCH_RULESET_NAME);
  if (!existing) return false;
  const del = await githubFetchWithRetry(
    `${rulesetsUrl}/${existing.id}`,
    { method: "DELETE", headers },
    { retryOn404: true },
  );
  if (del.ok || del.status === 404) return true;
  const b = await del.text().catch(() => "<failed to read body>");
  throw new HttpError(
    `Branch ruleset delete failed for ${repo}: HTTP ${del.status}: ${b.slice(0, 200)}`,
    del.status,
    b.slice(0, 200),
  );
}

/**
 * Read the NEMAR branch ruleset on a repo (for drift reporting): whether it is
 * present and which required status-check contexts it enforces. Returns
 * `{ present:false, contexts:[] }` when absent. Read-only.
 */
export async function getBranchRulesetInfo(
  repo: string,
  pat: string,
): Promise<{ present: boolean; contexts: string[] }> {
  const headers = ghHeaders(pat);
  const rulesetsUrl = `${GITHUB_API()}/repos/${ORG_NAME}/${repo}/rulesets`;
  const list = await githubFetchWithRetry(
    `${rulesetsUrl}?includes_parents=false`,
    { method: "GET", headers },
    { retryOn404: true },
  );
  if (!list.ok) return { present: false, contexts: [] };
  const rulesets = (await list.json()) as Array<{ id: number; name: string }>;
  const existing = rulesets.find((r) => r.name === BRANCH_RULESET_NAME);
  if (!existing) return { present: false, contexts: [] };

  // Fetch the full ruleset to read its required_status_checks contexts.
  const detail = await githubFetchWithRetry(
    `${rulesetsUrl}/${existing.id}`,
    { method: "GET", headers },
    { retryOn404: true },
  );
  if (!detail.ok) {
    // Ruleset exists but its detail couldn't be read; throw so the drift
    // gatherer's per-call .catch absorbs it (a transient error must not surface
    // as an empty-contexts CONTEXT_NAME_MISMATCH).
    const b = await detail.text().catch(() => "<failed to read body>");
    throw new HttpError(
      `Branch ruleset detail fetch failed for ${repo}: HTTP ${detail.status}: ${b.slice(0, 200)}`,
      detail.status,
      b.slice(0, 200),
    );
  }
  const d = (await detail.json()) as {
    rules?: Array<{
      type: string;
      parameters?: { required_status_checks?: Array<{ context: string }> };
    }>;
  };
  const rule = (d.rules ?? []).find((r) => r.type === "required_status_checks");
  const contexts = (rule?.parameters?.required_status_checks ?? []).map((c) => c.context);
  return { present: true, contexts };
}

/** List a repo's `.github/workflows` filenames (drift reporting). [] if none. */
export async function listRepoWorkflows(repo: string, pat: string): Promise<string[]> {
  const r = await githubFetchWithRetry(
    `${GITHUB_API()}/repos/${ORG_NAME}/${repo}/contents/.github/workflows`,
    { headers: ghHeaders(pat) },
    { retryOn404: true },
  );
  if (!r.ok) return [];
  const items = (await r.json()) as Array<{ name?: string; type?: string }>;
  return items.filter((i) => i.type === "file" && i.name).map((i) => i.name as string);
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

/**
 * Pure green-gate predicate: is the required check satisfied on a commit, given
 * its check-runs and legacy commit statuses? Green = a matching check-run
 * (by name, and by App `integration_id` when the required check is pinned) with
 * conclusion success/neutral/skipped, or a matching commit status with
 * state=success. Missing or failing => not green.
 */
export function isRequiredCheckGreen(
  required: RequiredCheck,
  checkRuns: Array<{ name: string; conclusion: string | null; app_id?: number | null }>,
  statuses: Array<{ context: string; state: string }>,
): boolean {
  const green = new Set(["success", "neutral", "skipped"]);
  const matched = checkRuns.some(
    (cr) =>
      cr.name === required.context &&
      (required.integration_id === undefined || cr.app_id === required.integration_id) &&
      cr.conclusion !== null &&
      green.has(cr.conclusion),
  );
  if (matched) return true;
  return statuses.some((s) => s.context === required.context && s.state === "success");
}

/**
 * Green-gate: is the required BIDS check green on a repo's default-branch HEAD?
 * Used to skip applying protection to a repo whose latest validation is red or
 * missing (so we never brick PRs). Reads check-runs + the legacy combined
 * status. Returns a tri-state so callers can distinguish a genuinely red/missing
 * check from a transient GitHub fetch failure (both fail-closed, but the latter
 * is logged and surfaced as `fetch_error` so it can be retried, not mistaken for
 * a broken BIDS pipeline).
 */
export async function checkRunGreenOnDefaultHead(
  repo: string,
  branch: string,
  required: RequiredCheck,
  pat: string,
): Promise<{ green: boolean; reason: "green" | "red" | "fetch_error" }> {
  const headers = ghHeaders(pat);
  let checkRuns: Array<{ name: string; conclusion: string | null; app_id?: number | null }> = [];
  try {
    const r = await githubFetchWithRetry(
      `${GITHUB_API()}/repos/${ORG_NAME}/${repo}/commits/${branch}/check-runs?per_page=100`,
      { headers },
      { retryOn404: true },
    );
    if (!r.ok) {
      console.error(
        `[green-gate] check-runs fetch for ${repo}@${branch} returned HTTP ${r.status}; treating as not-green (fetch_error)`,
      );
      return { green: false, reason: "fetch_error" };
    }
    const d = (await r.json()) as {
      check_runs?: Array<{ name: string; conclusion: string | null; app?: { id?: number } }>;
    };
    checkRuns = (d.check_runs ?? []).map((c) => ({
      name: c.name,
      conclusion: c.conclusion,
      app_id: c.app?.id ?? null,
    }));
  } catch (e) {
    console.error(
      `[green-gate] check-runs fetch failed for ${repo}@${branch} (treating as not-green):`,
      e,
    );
    return { green: false, reason: "fetch_error" };
  }
  let statuses: Array<{ context: string; state: string }> = [];
  try {
    const r = await githubFetchWithRetry(
      `${GITHUB_API()}/repos/${ORG_NAME}/${repo}/commits/${branch}/status`,
      { headers },
      { retryOn404: true },
    );
    if (r.ok) {
      const d = (await r.json()) as { statuses?: Array<{ context: string; state: string }> };
      statuses = d.statuses ?? [];
    }
  } catch (e) {
    console.error(
      `[green-gate] combined-status fetch failed for ${repo}@${branch} (continuing on check-runs only):`,
      e,
    );
  }
  const green = isRequiredCheckGreen(required, checkRuns, statuses);
  return { green, reason: green ? "green" : "red" };
}

type StepStatus = "ok" | "skipped" | "failed";
export interface RepoSpecResult {
  repo: string;
  visibility: "public" | "private";
  defaultBranch: string;
  steps: Record<string, { status: StepStatus; detail?: string }>;
  reconcile?: CollaboratorReconcileResult;
}

/**
 * The single idempotent enforcement point: bring a dataset repo to its target
 * spec for the given publish state. PUBLIC = locked main (branch + tag ruleset,
 * green-gated) + workflows + collaborator reconcile; PRIVATE = open push (NO
 * branch ruleset) + workflows + reconcile. Each step records a structured
 * status; no cross-step rollback. `dryRun` computes the plan without mutating.
 *
 * D1-free by design: the caller resolves `collaborators.ownerLogin` (from
 * `datasets.owner_user_id`) and `approvedWriters` (from `dataset_collaborators`)
 * and passes them in.
 */
export async function ensureRepoToSpec(
  repo: string,
  pat: string,
  opts: {
    visibility: "public" | "private";
    collaborators?: { ownerLogin: string | null; approvedWriters: string[]; skipLogins?: string[] };
    dryRun?: boolean;
  },
): Promise<RepoSpecResult> {
  const steps: RepoSpecResult["steps"] = {};
  const isPublic = opts.visibility === "public";
  const bidsCheck = deriveContexts(repo)[0];

  // 1. Capture the default branch.
  let defaultBranch = "main";
  try {
    const r = await githubFetchWithRetry(
      `${GITHUB_API()}/repos/${ORG_NAME}/${repo}`,
      { headers: ghHeaders(pat) },
      { retryOn404: true },
    );
    if (r.ok) {
      const info = (await r.json()) as { default_branch?: string };
      defaultBranch = info.default_branch || "main";
    } else {
      console.error(
        `[repo-spec] repo info fetch for ${repo} returned HTTP ${r.status}; defaulting branch to 'main'`,
      );
    }
  } catch (e) {
    console.error(
      `[repo-spec] repo info fetch failed for ${repo}, defaulting branch to 'main':`,
      e,
    );
  }

  if (opts.dryRun) {
    steps.plan = { status: "ok", detail: `${opts.visibility}, default=${defaultBranch}` };
    if (isPublic) {
      const g = await checkRunGreenOnDefaultHead(repo, defaultBranch, bidsCheck, pat);
      steps.branch_ruleset = g.green
        ? { status: "ok", detail: "would apply" }
        : {
            status: "skipped",
            detail: g.reason === "fetch_error" ? "FETCH_ERROR" : "RED_REQUIRED_CHECK",
          };
    } else {
      steps.branch_ruleset = { status: "skipped", detail: "private: no ruleset" };
    }
    if (opts.collaborators) {
      let current: DirectCollaborator[];
      try {
        current = await listDirectCollaborators(repo, pat);
      } catch (e) {
        // Cannot read the ledger -> the plan would be wrong; stop here.
        steps.collaborators = { status: "failed", detail: errText(e) };
        return { repo, visibility: opts.visibility, defaultBranch, steps };
      }
      let orgAdmins: string[] = [];
      try {
        orgAdmins = [...(await listOrgAdmins(pat))];
      } catch (e) {
        console.error(`[repo-spec] listOrgAdmins failed for ${repo} (dry-run): ${errText(e)}`);
      }
      const a = computeCollaboratorActions({
        current,
        visibility: opts.visibility,
        ownerLogin: opts.collaborators.ownerLogin,
        approvedWriters: opts.collaborators.approvedWriters,
        skipLogins: opts.collaborators.skipLogins,
        orgAdmins,
      });
      steps.collaborators = {
        status: "ok",
        detail: `+${a.toAdd.length} ^${a.toPromote.length} -${a.toRemove.length}`,
      };
    }
    return { repo, visibility: opts.visibility, defaultBranch, steps };
  }

  // 2. Default branch must be main.
  try {
    const r = await ensureMainBranch(repo, pat);
    steps.main_branch = {
      status: "ok",
      detail: r.renamed ? `renamed from ${r.previousBranch}` : "main",
    };
    if (r.renamed) defaultBranch = "main";
  } catch (e) {
    steps.main_branch = { status: "failed", detail: errText(e) };
  }

  // 3. Workflows must be deployed before protection can require their checks.
  let workflowsOk = true;
  try {
    const wr = await ensureWorkflowsDeployed(repo, "main", pat);
    if (wr.errors.length > 0) {
      workflowsOk = false;
      steps.workflows = { status: "failed", detail: wr.errors.join("; ") };
    } else {
      steps.workflows = {
        status: "ok",
        detail: `deployed ${wr.deployed.length}, present ${wr.alreadyPresent.length}`,
      };
    }
  } catch (e) {
    workflowsOk = false;
    steps.workflows = { status: "failed", detail: errText(e) };
  }

  // 4. Auto-merge (so green PRs land without manual button-press).
  try {
    await enableAutoMerge(repo, pat);
    steps.auto_merge = { status: "ok" };
  } catch (e) {
    steps.auto_merge = { status: "failed", detail: errText(e) };
  }

  // 5. Branch protection — PUBLIC only, green-gated; PRIVATE removes any ruleset.
  if (isPublic) {
    if (!workflowsOk) {
      steps.branch_ruleset = { status: "skipped", detail: "workflows not deployed" };
    } else {
      const g = await checkRunGreenOnDefaultHead(repo, defaultBranch, bidsCheck, pat);
      if (!g.green) {
        steps.branch_ruleset = {
          status: "skipped",
          detail: g.reason === "fetch_error" ? "FETCH_ERROR" : "RED_REQUIRED_CHECK",
        };
      } else {
        try {
          await ensureBranchRuleset(repo, pat, { checks: deriveContexts(repo), strict: false });
          steps.branch_ruleset = { status: "ok" };
        } catch (e) {
          steps.branch_ruleset = { status: "failed", detail: errText(e) };
        }
        try {
          await applyTagProtection(repo, pat);
          steps.tag_ruleset = { status: "ok" };
        } catch (e) {
          steps.tag_ruleset = { status: "failed", detail: errText(e) };
        }
      }
    }
  } else {
    try {
      const removed = await removeBranchRuleset(repo, pat);
      steps.branch_ruleset = {
        status: "ok",
        detail: removed ? "removed (private)" : "none (private)",
      };
    } catch (e) {
      steps.branch_ruleset = { status: "failed", detail: errText(e) };
    }
  }

  // 6. Collaborators (when the caller resolved the ledger).
  let reconcile: CollaboratorReconcileResult | undefined;
  if (opts.collaborators) {
    reconcile = await reconcileCollaborators(
      {
        repo,
        visibility: opts.visibility,
        ownerLogin: opts.collaborators.ownerLogin,
        approvedWriters: opts.collaborators.approvedWriters,
        skipLogins: opts.collaborators.skipLogins,
      },
      pat,
    );
    steps.collaborators = {
      status: reconcile.errors.length ? "failed" : "ok",
      detail: `+${reconcile.added.length} ^${reconcile.promoted.length} -${reconcile.removed.length}${reconcile.errors.length ? ` errors:${reconcile.errors.length}` : ""}`,
    };
  }

  return { repo, visibility: opts.visibility, defaultBranch, steps, reconcile };
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
  /**
   * Optional additional files to commit in the same tree write. Used by the
   * enrichment pipeline to land an auto-generated participants.tsv alongside
   * .nemar/metadata.json when the dataset shipped without one (see
   * `ensureParticipantsTsv` in participants-tsv.ts). When non-empty, forces
   * a batched tree commit even if .bidsignore didn't change so all files land
   * in one commit.
   */
  additionalFiles: ReadonlyArray<{ path: string; content: string }> = [],
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

  // Batched mode covers .bidsignore changes AND any additional files the
  // caller requested. Single-file mode is reserved for the metadata-only case.
  const commitMode: "batched" | "single" =
    bidsignoreUpdated || additionalFiles.length > 0 ? "batched" : "single";
  try {
    if (commitMode === "batched") {
      const treeFiles: Array<{ path: string; content: string }> = [
        { path: metadataPath, content: metadataContent },
      ];
      if (bidsignoreUpdated) {
        treeFiles.push({ path: ".bidsignore", content: bidsignoreContent });
      }
      for (const f of additionalFiles) {
        treeFiles.push({ path: f.path, content: f.content });
      }
      // Guard against duplicate paths in the tree write. GitHub's tree API
      // accepts duplicates but the behavior is last-wins, which silently
      // discards earlier contents. Throwing instead of silently winning
      // prevents a future caller from accidentally clobbering metadataPath
      // or .bidsignore via additionalFiles.
      const seen = new Set<string>();
      for (const f of treeFiles) {
        if (seen.has(f.path)) {
          throw new EnrichmentCommitError(
            `duplicate path '${f.path}' in commit tree`,
            commitMode,
            bidsignoreReadError,
            null,
          );
        }
        seen.add(f.path);
      }
      await commitFilesAsTree(repo, branch, treeFiles, message, pat);
    } else {
      // Pass `branch` so a release/* or other non-main caller doesn't have
      // its single-file commit silently land on the default branch.
      await createOrUpdateFile(repo, metadataPath, metadataContent, message, pat, branch);
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
