/**
 * What the rig logs about every authorization response, and the check the workflow runs on it (epic
 * #2014 phase #2020).
 *
 * WHY. The expected-failures entries match a module by test name, condition and block, not by the
 * error NEMAR answered. A module stopped by `CheckIfAuthorizationEndpointError` is recorded as the
 * approved PKCE deviation (decision 3a), but the same condition is raised by ANY error from the
 * authorization endpoint. So the rig logs, for each authorization response, the error code (if any)
 * and whether the request carried a `code_challenge`, and a workflow step fails the run unless:
 *
 *  1. every error code is one the approved deviations and the two REVIEW modules produce
 *     ({@link ALLOWED_AUTHORIZATION_ERRORS}); and
 *  2. no `invalid_request` answered a request that DID carry a `code_challenge` (that would be a
 *     different refusal, wearing the PKCE deviation's name).
 *
 * The line holds a kind, an error code and a yes/no. It never holds a value: no state, code, challenge,
 * token or address.
 */

/**
 * The error codes an authorization response may carry in the conformance run, and why each is there:
 *
 *  - `invalid_request`: a request with no `code_challenge` (decision 3a: PKCE is mandatory), which is
 *    what 26 of the 35 Basic modules send, and the `oidcc-response-type-missing` module's request with
 *    no response type, which the suite expects to be refused;
 *  - `request_not_supported`: the unsigned request object module, which the suite skips on exactly this
 *    answer (decision 4);
 *  - `page:invalid_redirect_uri`: the error page (not a redirect) for an address the client did not
 *    register, which the two REVIEW modules expect.
 */
export const ALLOWED_AUTHORIZATION_ERRORS = [
  "invalid_request",
  "request_not_supported",
  "page:invalid_redirect_uri",
] as const;

export type AuthorizationKind =
  | "redirect"
  | "error_page"
  | "login"
  | "reauth"
  | "rule_refused"
  | "consent"
  | "check_failed";

/** One log line: `[rig] authz kind=<kind> error=<code|none> pkce=<yes|no>`. */
export function authorizationLogLine(
  kind: AuthorizationKind,
  error: string | null,
  carriedChallenge: boolean,
): string {
  return `[rig] authz kind=${kind} error=${error ?? "none"} pkce=${carriedChallenge ? "yes" : "no"}`;
}

/** Whether an authorization request string carries a `code_challenge` (its value is never read out). */
export function carriesChallenge(request: string): boolean {
  return new URLSearchParams(request.replace(/^\?/, "")).has("code_challenge");
}

export interface AuthorizationLogReport {
  /** How many authorization responses the log records. */
  responses: number;
  /** Responses by error code (`none` for a response with no error). */
  byError: Record<string, number>;
  /** One sentence per response that breaks a rule above. */
  violations: string[];
}

const LINE = /^\[rig\] authz kind=(\S+) error=(\S+) pkce=(yes|no)$/;

/** Read the rig's log and report what the check needs. */
export function checkAuthorizationLog(log: string): AuthorizationLogReport {
  const report: AuthorizationLogReport = { responses: 0, byError: {}, violations: [] };
  const allowed = new Set<string>(ALLOWED_AUTHORIZATION_ERRORS);
  for (const raw of log.split("\n")) {
    const match = LINE.exec(raw.trim());
    if (!match) continue;
    const [, kind, error, pkce] = match as unknown as [string, string, string, string];
    report.responses += 1;
    report.byError[error] = (report.byError[error] ?? 0) + 1;
    if (error !== "none" && !allowed.has(error)) {
      report.violations.push(
        `an authorization response (${kind}) carried the error ${error}, which no approved deviation produces`,
      );
    }
    if (error === "invalid_request" && pkce === "yes") {
      report.violations.push(
        "invalid_request answered a request that carried a code_challenge, so it is not the PKCE deviation",
      );
    }
  }
  if (report.responses === 0) {
    report.violations.push(
      "the log records no authorization response, so there is nothing to check",
    );
  }
  return report;
}
