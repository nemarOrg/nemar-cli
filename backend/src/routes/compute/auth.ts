/**
 * The credential rule of the `/compute` read routes (epic #2021 phase D2, #2023; ADR 0119, the addendum
 * of this phase). One resolver, two guards, and a `ComputeCredential` on the context:
 *
 *   { kind: "user", userId, via: "key" | "cookie" | "oidc", scopes? }   a person
 *   { kind: "client", clientId }                                          a partner's machine client
 *
 * `computePersonCredential` guards `/compute/me*`. A CLI key (bearer) or the session cookie resolves
 * through `authMiddleware`, exactly as every other signed-in route does. An OpenID Connect access token
 * (`nmo_` bearer) resolves through `oidcBearer([compute.read])`, Epic B's one middleware that lets such a
 * token authenticate a request, so the token, its client, its grant and the account against the client's
 * sign-in rule are all read live at the call. A token that names no account (client credentials) is
 * `forbidden_credential` here: it is not a person.
 *
 * `computeStatsCredential` guards `/compute/stats`, which a partner's CLIENT reads for aggregates: only
 * a live client credentials access token carrying `compute.stats`. A CLI key is `forbidden_credential`
 * (a key carries a person's full authority and no scopes, and this route is not a person's), a session
 * cookie is no credential, and a person's access token is `forbidden_credential` BEFORE its scope is
 * judged (so it never learns "add compute.stats": a person cannot hold it).
 *
 * What it does NOT change: every other route of the Worker keeps refusing an OpenID Connect token by its
 * `nmo_` prefix (`resolveApiKeyUser`), and `test/oidc-token-allowlist.test.ts` lists exactly the eight
 * paths of `COMPUTE_OIDC_ROUTES` as the ones that may accept one: the four `GET /me*` reads, `GET /stats`,
 * and the partner's three routes (`POST /holds`, `POST /jobs/:id/report`, `DELETE /holds/:id`). The audience
 * is not checked on the five read routes: a client chooses its audience when the owner registers it, and the
 * scope and the live account rule are the gates. The three partner WRITE routes do check it
 * (`audienceNamesThisApi`, answered `wrong_audience`), because a reservation moves money.
 *
 * Refusals are `{ error: <sentence>, code: <word> }` (`COMPUTE_USER_ERROR_STATUS`), with the RFC 6750
 * `WWW-Authenticate` header on a bearer refusal and `Cache-Control: no-store`.
 */

import type { Context, MiddlewareHandler } from "hono";
import {
  COMPUTE_PARTNER_ERROR_STATUS,
  COMPUTE_PARTNER_SENTENCES,
  COMPUTE_RESERVE_SCOPE,
} from "../../../../shared/contract/compute-partner.js";
import {
  COMPUTE_READ_SCOPE,
  COMPUTE_STATS_SCOPE,
  COMPUTE_USER_ERROR_STATUS,
  COMPUTE_USER_SENTENCES,
} from "../../../../shared/contract/compute-user.js";
import { OIDC_ACCESS_TOKEN_PREFIX } from "../../../../shared/oidc.js";
import { authMiddleware } from "../../middleware/auth.js";
import { oidcBearer } from "../../middleware/oidc-bearer.js";
import { lookupToken } from "../../services/oidc-tokens.js";
import type {
  Bindings,
  ComputeCredential,
  OidcTokenContext,
  Variables,
} from "../../types/bindings.js";

export type { ComputeCredential } from "../../types/bindings.js";

type Env = { Bindings: Bindings; Variables: Variables };

/** The two `oidcBearer` instances, exported so a test can pin their scopes by reference. */
export const PERSON_OIDC = oidcBearer([COMPUTE_READ_SCOPE]);
export const STATS_OIDC = oidcBearer([COMPUTE_STATS_SCOPE]);
/** The partner's three routes (phase D4, #2025): reserve, report and release. */
export const RESERVE_OIDC = oidcBearer([COMPUTE_RESERVE_SCOPE]);

/** Every path under `/compute` that may accept an OpenID Connect access token, and the scope it needs. */
export const COMPUTE_OIDC_ROUTES = {
  "GET /me": COMPUTE_READ_SCOPE,
  "GET /me/usage": COMPUTE_READ_SCOPE,
  "GET /me/jobs": COMPUTE_READ_SCOPE,
  "GET /me/jobs/:id": COMPUTE_READ_SCOPE,
  "GET /stats": COMPUTE_STATS_SCOPE,
  // The partner contract (phase D4, #2025): a person's token minted for the partner, WRITE routes.
  "POST /holds": COMPUTE_RESERVE_SCOPE,
  "POST /jobs/:id/report": COMPUTE_RESERVE_SCOPE,
  "DELETE /holds/:id": COMPUTE_RESERVE_SCOPE,
} as const;

const NO_STORE = { "Cache-Control": "no-store", Pragma: "no-cache" } as const;

type CredentialRefusal = Exclude<
  keyof typeof COMPUTE_USER_SENTENCES,
  "invalid_range" | "invalid_group" | "invalid_state" | "invalid_limit" | "invalid_cursor"
>;

function refuse(c: Context<Env>, code: CredentialRefusal, headers: Record<string, string> = {}) {
  return c.json(
    { error: COMPUTE_USER_SENTENCES[code], code },
    COMPUTE_USER_ERROR_STATUS[code] as 401 | 403,
    { ...NO_STORE, ...headers },
  );
}

/** The value of an `Authorization: Bearer` header, or null (the scheme is matched without regard to case). */
function bearerValue(header: string | undefined): string | null {
  if (header === undefined) return null;
  const match = /^bearer +([A-Za-z0-9._~+/-]+=*)$/i.exec(header.trim());
  return match ? (match[1] as string) : null;
}

/** True for an OpenID Connect token of any kind (`nmo_`): never a CLI key, whose prefix is `nm_`. */
function isOidcValue(value: string | null): boolean {
  return value?.startsWith("nmo_") === true;
}

/**
 * Run `oidcBearer` and translate its refusal into this router's body. On success the live token is
 * handed to `accept`, which says what credential it makes, or null when the token is of the wrong kind
 * for the route.
 */
async function viaOidc(
  c: Context<Env>,
  next: () => Promise<void>,
  bearer: MiddlewareHandler<Env>,
  accept: (token: OidcTokenContext) => ComputeCredential | "wrong_audience" | null,
  /**
   * Asked when a live token lacks the scope: a route may name a more specific refusal than
   * `insufficient_scope` for a token of the wrong KIND (a response, or null to keep the scope refusal).
   */
  wrongKind?: () => Promise<Response | null>,
): Promise<Response | undefined> {
  let reached = false;
  const refused = await bearer(c, async () => {
    reached = true;
  });
  if (!reached) {
    // `oidcBearer` answered: 401 for anything that is not a live access token, 403 for a live token
    // without the scope. Keep its RFC 6750 challenge, give the body this router's two fields.
    const status = (refused as Response | undefined)?.status === 403 ? 403 : 401;
    if (status === 403 && wrongKind) {
      const kind = await wrongKind();
      if (kind) return kind;
    }
    const challenge =
      (refused as Response | undefined)?.headers.get("WWW-Authenticate") ?? "Bearer";
    return refuse(c, status === 403 ? "insufficient_scope" : "invalid_token", {
      "WWW-Authenticate": challenge,
    });
  }
  const token = c.get("oidcToken");
  const credential = token ? accept(token) : null;
  if (credential === "wrong_audience") return refusePartner(c, "wrong_audience");
  if (credential === null) return refuse(c, "forbidden_credential");
  c.set("computeCredential", credential);
  await next();
  return undefined;
}

/** `/compute/me*`: a person, by a key, the session cookie or a `compute.read` access token. */
export const computePersonCredential: MiddlewareHandler<Env> = async (c, next) => {
  if (isOidcValue(bearerValue(c.req.header("Authorization")))) {
    return viaOidc(c, next, PERSON_OIDC, (token) =>
      token.user === null
        ? null
        : { kind: "user", userId: token.user.id, via: "oidc", scopes: token.scopes },
    );
  }
  return authMiddleware(c, async () => {
    const user = c.get("user");
    c.set("computeCredential", {
      kind: "user",
      userId: user.id,
      via: c.get("authMethod") === "cookie" ? "cookie" : "key",
    });
    await next();
  });
};

/** `/compute/stats`: a partner's client, by a live client credentials token carrying `compute.stats`. */
export const computeStatsCredential: MiddlewareHandler<Env> = async (c, next) => {
  const header = c.req.header("Authorization");
  if (header === undefined)
    return refuse(c, "missing_credential", { "WWW-Authenticate": "Bearer" });
  const value = bearerValue(header);
  if (value === null) {
    return refuse(c, "invalid_token", { "WWW-Authenticate": 'Bearer error="invalid_token"' });
  }
  // A bearer value that is not an OpenID Connect token is a CLI key (or nothing): refused for its KIND,
  // before any lookup, so a valid key and an invalid one are answered the same.
  if (!isOidcValue(value)) return refuse(c, "forbidden_credential");
  // A person's token never reaches this route, with the scope or without it. Without it, `oidcBearer`
  // would say `insufficient_scope`, which hints that adding the scope would help (a person cannot hold
  // it); so a live person's access token that lacks the scope is told its KIND is wrong instead. One
  // that somehow carries the scope is refused by the account test below.
  return viaOidc(
    c,
    next,
    STATS_OIDC,
    (token) => (token.user === null ? { kind: "client", clientId: token.client.clientId } : null),
    async () => {
      const row = await lookupToken(c.env.DB, value);
      return row && row.kind === "access" && row.active === 1 && row.user !== null
        ? refuse(c, "forbidden_credential")
        : null;
    },
  );
};

// --- The partner's routes (phase D4, #2025) --------------------------------------------------------

/** A refusal in the partner's own table (it holds `wrong_audience`, which a person's read routes never say). */
function refusePartner(
  c: Context<Env>,
  code: keyof typeof COMPUTE_PARTNER_ERROR_STATUS,
  headers: Record<string, string> = {},
) {
  return c.json(
    { error: COMPUTE_PARTNER_SENTENCES[code], code },
    COMPUTE_PARTNER_ERROR_STATUS[code] as 401 | 403,
    { ...NO_STORE, ...headers },
  );
}

/** Whether the request carries a session cookie, under either name (host-prefixed or not). */
function carriesSessionCookie(header: string | undefined): boolean {
  return header !== undefined && /(?:^|;\s*)(?:__Host-)?nemar_session=/.test(header);
}

/**
 * Whether an access token's audience names the NEMAR API: an address on the same origin as this Worker's
 * own issuer (`API_BASE_URL`). The audience is chosen by the owner when the client is registered, never by
 * the client, so this refuses a client registered for another resource server (a token minted for that
 * resource must not reserve compute here) and fails closed when the Worker has no issuer. The READ routes
 * deliberately do not check it (ADR 0119, the addendum of phase D2, item 4); the WRITE routes do, because
 * a reservation moves money and the scope names are shared by every resource server that may ever serve
 * them (the addendum of phase D4).
 */
export function audienceNamesThisApi(audience: string, apiBaseUrl: string | undefined): boolean {
  if (typeof apiBaseUrl !== "string" || apiBaseUrl === "") return false;
  try {
    return new URL(audience).origin === new URL(apiBaseUrl).origin;
  } catch {
    return false;
  }
}

/**
 * The partner routes accept ONE credential: an OpenID Connect access token for a PERSON (an authorization
 * code token) carrying `compute.reserve`, through Epic B's `oidcBearer`. A CLI key and the session cookie
 * are `forbidden_credential` without a lookup (so a valid key and an invalid one are answered alike); no
 * credential at all is `missing_credential`; a token that is not live is `invalid_token`; one without the
 * scope is `insufficient_scope`; a client credentials token names no person and is `forbidden_credential`;
 * a token whose audience does not name this API is `wrong_audience`. A disabled client, a revoked grant and
 * an account that no longer passes its client's sign-in rule are refused by `oidcBearer` itself, at every
 * call. The person is `c.get("computeCredential")`, the client is `c.get("oidcToken").client`.
 */
export const computePartnerCredential: MiddlewareHandler<Env> = async (c, next) => {
  const header = c.req.header("Authorization");
  if (header === undefined) {
    return carriesSessionCookie(c.req.header("Cookie"))
      ? refusePartner(c, "forbidden_credential")
      : refusePartner(c, "missing_credential", { "WWW-Authenticate": "Bearer" });
  }
  const value = bearerValue(header);
  if (value === null) {
    return refusePartner(c, "invalid_token", {
      "WWW-Authenticate": 'Bearer error="invalid_token"',
    });
  }
  if (!isOidcValue(value)) return refusePartner(c, "forbidden_credential");
  return viaOidc(c, next, RESERVE_OIDC, (token) =>
    token.user === null
      ? null
      : audienceNamesThisApi(token.audience, c.env.API_BASE_URL)
        ? { kind: "user", userId: token.user.id, via: "oidc", scopes: token.scopes }
        : "wrong_audience",
  );
};
