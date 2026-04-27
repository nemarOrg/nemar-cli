/**
 * Retry helpers for transient and propagation failures.
 *
 * Used by the admin publish pipeline (step-level retry) and the github service
 * (per-fetch retry). Centralized here so the classifier `isRetryable` is the
 * single source of truth for what counts as transient.
 */

/**
 * Plain Error subclass that carries an HTTP `status`. Throw this from
 * service-layer fetch wrappers so `isRetryable` can classify by status code
 * rather than by string-matching the message body.
 */
export class HttpError extends Error {
  readonly status: number;
  readonly bodySnippet: string | undefined;

  constructor(message: string, status: number, bodySnippet?: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.bodySnippet = bodySnippet;
  }
}

/**
 * Decide whether an error represents a transient failure worth retrying.
 *
 * Classification, in order:
 *   1. `HttpError` → retry on 5xx and 429.
 *   2. Plain Error whose `.status` field is a number → same rule.
 *   3. Plain Error whose message looks like a network failure → retry.
 *   4. Plain Error whose message contains an explicit HTTP/status prefix
 *      followed by a 5xx/429 code → retry. Covers GitHub-style ("HTTP 503")
 *      and EZID-style ("EZID HTTP error (503 ...)") error messages thrown by
 *      legacy code paths that have not yet been migrated to `HttpError`.
 *
 * Anything else is treated as a non-retryable terminal error (validation,
 * auth, not-found, parse error, etc.).
 */
export function isRetryable(error: unknown): boolean {
  if (error instanceof HttpError) {
    return isRetryableStatus(error.status);
  }
  if (error instanceof Error) {
    // Numeric .status takes precedence over the message-string fallback. If
    // the caller went to the trouble of tagging a status, trust it: a 4xx with
    // a body that happens to mention "HTTP 500" must NOT retry.
    const status = (error as Error & { status?: unknown }).status;
    if (typeof status === "number") {
      return isRetryableStatus(status);
    }
    const msg = error.message.toLowerCase();
    if (
      msg.includes("timeout") ||
      msg.includes("network") ||
      msg.includes("econnreset") ||
      msg.includes("fetch failed") ||
      msg.includes("connection")
    ) {
      return true;
    }
    // Match either GitHub-style "HTTP 503" or EZID-style "HTTP error (503 ...)".
    // The HTTP/status prefix avoids matching dataset IDs like "nm000500".
    if (/(?:http|status)[\s(]*(?:error\s*\()?\s*(5\d\d|429)\b/i.test(msg)) {
      return true;
    }
  }
  return false;
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

export interface WithRetryOptions {
  maxAttempts?: number;
  delayMs?: number;
  isRetryable?: (error: unknown) => boolean;
}

/**
 * Retry `fn` up to `maxAttempts` times when the thrown error is classified as
 * transient. Returns the final result and the number of attempts made (1 on
 * first-try success). Re-throws the last error if all attempts fail.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  stepName: string,
  options?: WithRetryOptions,
): Promise<{ result: T; attempts: number }> {
  const maxAttempts = options?.maxAttempts ?? 3;
  const delayMs = options?.delayMs ?? 1_000;
  const classify = options?.isRetryable ?? isRetryable;

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await fn();
      return { result, attempts: attempt };
    } catch (err) {
      lastError = err;
      if (attempt < maxAttempts && classify(err)) {
        console.log(
          `[retry] ${stepName} attempt ${attempt} failed (retryable), retrying in ${delayMs}ms: ${err instanceof Error ? err.message : String(err)}`,
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      } else {
        break;
      }
    }
  }
  throw lastError;
}
