/**
 * `oidcBearer(scopes)`: the ONE way a route accepts an OpenID Connect access token (epic #2014 phase
 * #2018; ADR 0119 rules 4 and 14).
 *
 * An access token is accepted only by the routes that serve its scopes, and every other route refuses
 * it (`resolveApiKeyUser` answers `oidc_token` for an `nmo_` bearer). This middleware is the
 * acceptance: a route that serves a scope names it here, and nothing else in the Worker reads an
 * access token. Today that is `/oauth/userinfo` (`openid`); the compute routes that serve
 * `compute.*` are the compute epics', and `test/oidc-token-allowlist.test.ts` fails when this
 * middleware appears on a route it does not list.
 *
 * WHAT IT CHECKS, READ LIVE AT EVERY CALL (`TOKEN_LOOKUP_SQL`): the token is an `nmo_at_` access
 * token NEMAR issued, not revoked and not expired, its client is active, and, for a token that names
 * an account, its grant is live and the account passes its client's sign-in rule NOW (status,
 * deletion, kind, ORCID proof), never what the token row or the moment of issue said. A CLI key, a
 * refresh token or a client secret is not an access token.
 *
 * WHAT IT ANSWERS (RFC 6750 section 3), always `no-store`:
 *   - no `Authorization` header: 401, `WWW-Authenticate: Bearer` (no error code, section 3.1);
 *   - anything that is not a live access token: 401, `WWW-Authenticate: Bearer error="invalid_token"`;
 *   - a live token without every scope the route needs: 403,
 *     `WWW-Authenticate: Bearer error="insufficient_scope", scope="<the scopes>"`.
 * On success `c.var.oidcToken` holds the client, the account (with its claim columns, from the same
 * read), the scopes and the audience. The audience is the route's to check if it serves only one.
 */

import type { Context, MiddlewareHandler } from "hono";
import { OIDC_ACCESS_TOKEN_PREFIX } from "../../../shared/oidc.js";
import { lookupToken } from "../services/oidc-tokens.js";
import type { Bindings, Variables } from "../types/bindings.js";

type Env = { Bindings: Bindings; Variables: Variables };

const NO_STORE = { "Cache-Control": "no-store", Pragma: "no-cache" } as const;

/** Every middleware `oidcBearer` has made, so a route table can be checked for it by reference. */
const made = new WeakSet<object>();

/** True for a handler that `oidcBearer` made. */
export function isOidcBearerMiddleware(handler: unknown): boolean {
  return typeof handler === "function" && made.has(handler);
}

function refuse(
  c: Context<Env>,
  status: 401 | 403,
  challenge: string,
  error: string,
  description: string,
): Response {
  return c.json({ error, error_description: description }, status, {
    ...NO_STORE,
    "WWW-Authenticate": challenge,
  });
}

/** The token of an `Authorization: Bearer` header (scheme matched without regard to case). */
function bearerToken(header: string): string | null {
  const match = /^bearer +([A-Za-z0-9._~+/-]+=*)$/i.exec(header.trim());
  return match ? (match[1] as string) : null;
}

/** Accept a live OpenID Connect access token carrying every scope in `requiredScopes`. */
export function oidcBearer(requiredScopes: readonly string[]): MiddlewareHandler<Env> {
  const required = [...requiredScopes];
  const middleware: MiddlewareHandler<Env> = async (c, next) => {
    const header = c.req.header("Authorization");
    if (!header) {
      return refuse(c, 401, "Bearer", "invalid_token", "An access token is required.");
    }
    const token = bearerToken(header);
    const invalid = () =>
      refuse(
        c,
        401,
        'Bearer error="invalid_token"',
        "invalid_token",
        "The access token is not valid.",
      );
    if (token === null || !token.startsWith(OIDC_ACCESS_TOKEN_PREFIX)) return invalid();
    const row = await lookupToken(c.env.DB, token);
    if (!row || row.kind !== "access" || row.active !== 1) return invalid();
    const scopes = JSON.parse(row.scopes) as string[];
    if (!required.every((s) => scopes.includes(s))) {
      return refuse(
        c,
        403,
        `Bearer error="insufficient_scope", scope="${required.join(" ")}"`,
        "insufficient_scope",
        "The access token does not carry the scope this route needs.",
      );
    }
    c.set("oidcToken", {
      tokenId: row.id,
      client: { id: row.client_row_id, clientId: row.client_public_id },
      user:
        row.user_id === null
          ? null
          : {
              id: row.user_id,
              oidc_subject: row.oidc_subject,
              given_name: row.given_name,
              family_name: row.family_name,
              email: row.email,
              email_verified: row.email_verified,
              orcid: row.orcid,
              orcid_proven: row.orcid_proven,
              account_kind: row.account_kind,
              status: row.status,
              service_access: row.service_access,
            },
      scopes,
      audience: row.audience,
    });
    await next();
  };
  made.add(middleware);
  return middleware;
}
