/**
 * Shared GitHub HTTP transport: githubFetchWithRetry (retry/backoff,
 * rate-limit tracking, one-shot 401 App-token refresh) plus its private
 * helpers and the rate-limit state it maintains.
 *
 * Moved verbatim from services/github.ts (#906, epic #902); the only
 * intentional changes are import paths and the expanded
 * isolate-scoping note on rateLimitState.
 */

import { HttpError } from "../retry";

// ============================================================================
// Rate limit instrumentation
// ============================================================================

interface RateLimitSnapshot {
  resource: string;
  remaining: number;
  resetEpoch: number;
  limit?: number;
}

// Most recent rate-limit snapshot per resource bucket. Explicitly
// ISOLATE-SCOPED module state: each Workers isolate has its own Map, it is
// not shared across isolates or durable across requests, and it resets when
// the isolate recycles. Isolates relearn from the first response after a
// cold start, which is fine: the cache is a soft throttle hint, not a
// correctness constraint.
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
