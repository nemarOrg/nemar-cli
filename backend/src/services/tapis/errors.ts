/**
 * What a call to Tapis can fail with (epic #2005 phase A4, #2009; ADR 0118).
 *
 * One class, six fixed kinds. The KIND is what a caller branches on; the message is a fixed sentence
 * that names the kind, the call and the status, and NEVER holds anything a response, a request or a
 * credential carried: a Tapis error body can echo the request (a validation error names the value it
 * refused, and the launch specification, which holds a job's token, is an environment value), and a
 * log line or a stored `failure_detail` must not hold a token. So no body is read into a message,
 * and `bodySnippet` of the wrapped `HttpError` is never set.
 *
 *   unconfigured      the Worker has no (or an unusable) Tapis configuration; nothing was sent
 *   unauthorized      Tapis refused the credential: 401 (after the one refresh) and 403
 *   not_found         404
 *   rejected          another 4xx: Tapis understood the request and said no (400, 409, ...)
 *   unavailable       a timeout, a network failure, 429 or 5xx: it may work later, and says nothing
 *                     about whether the call took effect
 *   invalid_response  Tapis answered something that is not what its specification says (not JSON, a
 *                     body that fails its schema, one over the size bound): never partly trusted
 *
 * `cause` is an `HttpError` for an HTTP status, so `isRetryable` classifies it as the rest of the
 * Worker does (5xx and 429), and a plain `Error` whose message says `timeout` or `network` for a
 * transport failure, which `isRetryable` also recognises.
 */

import { HttpError, isRetryable } from "../retry";

export const TAPIS_ERROR_KINDS = [
  "unconfigured",
  "unauthorized",
  "not_found",
  "rejected",
  "unavailable",
  "invalid_response",
] as const;

export type TapisErrorKind = (typeof TAPIS_ERROR_KINDS)[number];

export class TapisError extends Error {
  readonly kind: TapisErrorKind;
  /** The HTTP status Tapis answered with, or null when there was none (a timeout, no connection). */
  readonly status: number | null;
  override readonly cause: HttpError | Error | undefined;

  constructor(
    kind: TapisErrorKind,
    what: string,
    options: { status?: number | null; cause?: HttpError | Error } = {},
  ) {
    super(
      options.status === undefined || options.status === null
        ? `Tapis ${what}: ${kind}`
        : `Tapis ${what}: ${kind} (HTTP ${options.status})`,
    );
    this.name = "TapisError";
    this.kind = kind;
    this.status = options.status ?? null;
    this.cause = options.cause;
  }

  /** Whether a retry may help, by the Worker's one classifier (`isRetryable`). */
  get retryable(): boolean {
    return this.cause !== undefined && isRetryable(this.cause);
  }
}

/** The error for an HTTP status that was not a success. Never reads the body. */
export function errorForStatus(status: number, what: string): TapisError {
  const cause = new HttpError(`Tapis ${what} answered HTTP ${status}`, status);
  const kind: TapisErrorKind =
    status === 401 || status === 403
      ? "unauthorized"
      : status === 404
        ? "not_found"
        : status === 429 || status >= 500
          ? "unavailable"
          : "rejected";
  return new TapisError(kind, what, { status, cause });
}

/** A transport failure: no answer came. `retryable`, because the message names a timeout or the network. */
export function transportError(what: string, timedOut: boolean): TapisError {
  return new TapisError("unavailable", what, {
    cause: new Error(timedOut ? `Tapis ${what} timeout` : `Tapis ${what} network error`),
  });
}

/** An answer that is not what Tapis's specification says. Not retryable. */
export function invalidResponse(what: string, status: number | null): TapisError {
  return new TapisError("invalid_response", what, { status });
}
