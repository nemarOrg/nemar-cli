/**
 * Contract for the private site (`private.nemar.org`), the host that serves
 * NEMAR's access-controlled features (ADR 0079).
 *
 * The private site needs a session on its own host, and the app session
 * cookie is scoped to `app.nemar.org` on purpose, so it gets one the way the
 * docs host does (`docs-auth.ts`, ADR 0056): a one-time code minted from a
 * live app session and traded, once, for a credential of its own.
 *
 * Three parties share the literals below and none of them can import each
 * other's code: this backend, the website's authorize page
 * (`nemarOrg/website`), and the private site's own Worker. The other two read
 * this file as TEXT, so each exported constant is written as one quoted string
 * or one integer on its own line: a value built from an expression is
 * invisible to a text reader. `backend/test/private-site-contract.test.ts`
 * reads it the same way and pins the set.
 *
 * The flow, and which party does what:
 *
 *   1. private site  - no session of its own: generate a `state`, set it in a
 *                      host-only cookie, 302 to the APP authorize path with it
 *   2. website (SSR) - proves an app session, POST /auth/private/grant with it
 *   3. website       - 302 to the private site's callback path with the code
 *   4. private site  - trades the code AND its cookie's `state` for a session,
 *                      and sets its session cookie
 *   5. private site  - resolves that session on every later request
 *
 * THE STATE BINDS THE BROWSER THAT STARTS A SIGN-IN TO THE ONE THAT FINISHES
 * IT. The private site is a write surface, so login CSRF (an attacker
 * completing their own grant in a victim's browser, then receiving the
 * victim's uploads) is a real harm there, which is why this handoff carries a
 * `state` the docs gate does not. The mint refuses unless the same value comes
 * back (ADR 0079). The private site MUST:
 *   - generate at least 256 bits of random `state` per sign-in;
 *   - keep it in a `__Host-` cookie: HttpOnly, Secure, SameSite=Lax, and a
 *     short Max-Age (minutes, not hours);
 *   - send it to the authorize page as the `PRIVATE_AUTHORIZE_STATE_PARAM`
 *     query parameter, which the website forwards to the grant unchanged;
 *   - present its cookie's value, never the one in the callback URL, at
 *     exchange.
 *
 * The code is one-time and short-lived because it travels in a URL, where it
 * lands in history, logs and any `Referer` a page later sends. The session
 * value it buys never travels in a URL at all.
 *
 * STEPS 4 AND 5 ARE NOT HTTP ROUTES. The private site's Worker reaches this API
 * through a service binding to the `NemarApiRpc` entrypoint (ADR 0078), so
 * the exchange, the per-request check and sign-out are methods on
 * {@link NemarApiRpcContract}, and the public API gains one route, the grant.
 * The rules every method keeps are ADR 0078's; the two that shape a caller:
 *
 *   - Expected refusals come back as `{ ok: false, error }`; unexpected faults
 *     throw. A caller treats anything other than `ok: true` as a refusal and
 *     fails closed, including a thrown call.
 *   - This contract changes ADDITIVELY ONLY: new optional fields, new methods,
 *     and new `error` literals. The private site deploys independently, so a
 *     removed or renamed field breaks a caller nobody here redeploys; a changed
 *     meaning is a new method. Because an `error` literal may be added, a
 *     caller MUST handle an error it does not recognise by failing closed, and
 *     MUST NOT switch over the errors exhaustively without a default.
 *   - The private site is operated by NEMAR, in the same Cloudflare account.
 *     It MUST NOT log, persist or forward an API key a visitor presents to it;
 *     `resolvePrincipal` is the only thing it may do with one.
 */

/** The entrypoint a caller's service binding names (`entrypoint = ...`). */
export const NEMAR_API_RPC_ENTRYPOINT = "NemarApiRpc";

/** Seconds a one-time grant code stays claimable. Same reasoning as
 *  `DOCS_GRANT_TTL_SECONDS`: generous for one redirect hop, short enough that a
 *  code leaked from a URL is almost certainly already dead. */
export const PRIVATE_GRANT_TTL_SECONDS = 60;

/** Seconds a private-site session lasts: eight hours, spelled as a literal
 *  for the text readers. Never remember-me; re-proving identity tomorrow costs
 *  one redirect through a browser that is already signed in. */
export const PRIVATE_SESSION_TTL_SECONDS = 28800;

/** Where the private site sends a visitor who has no session there. Path only,
 *  on the APP host; the website owns the page. */
export const PRIVATE_AUTHORIZE_PATH = "/auth/private/authorize";

/** The query parameter the private site puts its `state` in on the authorize
 *  URL, and the website reads it from. */
export const PRIVATE_AUTHORIZE_STATE_PARAM = "state";

/** Where the website sends the visitor back to, on the private site, carrying
 *  the one-time code. Under a double-underscore prefix so it cannot collide
 *  with a page route. */
export const PRIVATE_CALLBACK_PATH = "/__auth/callback";

/** `POST /auth/private/grant` refusals carrying an `error` code:
 *  `unauthenticated` (401, no live app session) and `invalid_request` (400, a
 *  missing or malformed `state`). A missing or foreign `Origin` is 403
 *  `Origin not allowed`, and an inactive account is 403 with the API's usual
 *  inactive-account body (`status` names why), neither of which uses this
 *  code. */
export type PrivateGrantRefusal = "unauthenticated" | "invalid_request";

/** The JSON body of `POST /auth/private/grant`. `state` is 32 to 256
 *  characters of the base64url alphabet (`A-Z a-z 0-9 - _`). */
export interface PrivateGrantRequest {
  readonly state: string;
}

/** What `POST /auth/private/grant` returns. */
export interface PrivateGrantResponse {
  readonly code: string;
  readonly expires_in: number;
}

// --------------------------------------------------------------------------
// The service-binding entrypoint (ADR 0078)
// --------------------------------------------------------------------------

/** An account's role, read live on every call. */
export type PrincipalRole = "member" | "admin" | "owner";

/** A principal is only ever returned for an account that may authenticate, so
 *  its status is one of the two active ones (ADR 0040). */
export type PrincipalStatus = "verified" | "approved";

/** What the account is (ADR 0048). */
export type PrincipalAccountKind = "person" | "service" | "test";

/**
 * The account behind a credential, as this API sees it at the moment of the
 * call. Nothing here is cached by this API, so a caller that reads it on every
 * request sees a revocation, a status change or a new role at the next one.
 *
 * A caller MUST NOT cache or persist a Principal, or anything derived from it,
 * across requests. A demotion or a status change reaches the private site only
 * through the next `resolvePrincipal`, so a cached copy is a way to keep acting
 * on a role or status the account no longer has.
 *
 * `email` is personal data. A caller shows it to the account itself and to
 * nobody else.
 */
export interface Principal {
  readonly userId: number;
  /** `null` until one is assigned; a brand-new account may not have one. */
  readonly username: string | null;
  /** The ORCID iD on the account. `orcidVerified` is true only when it is the
   *  iD the account signs in with. */
  readonly orcid: string | null;
  readonly orcidVerified: boolean;
  readonly givenName: string | null;
  readonly familyName: string | null;
  readonly email: string;
  readonly emailVerified: boolean;
  readonly role: PrincipalRole;
  readonly status: PrincipalStatus;
  readonly accountKind: PrincipalAccountKind;
}

/**
 * A credential to resolve. `session` is a private-site session value, the one
 * `exchangePrivateGrant` returned; an app or docs session value is refused.
 * `api_key` is a NEMAR API key, checked by the same lookup the HTTP API uses.
 * No key is ever traded for a private-site session today. If a trade like
 * `POST /auth/docs/cli-session` is added, the routes that revoke a key must end
 * the private scope too (ADR 0079).
 */
export type PrincipalCredential =
  | { readonly kind: "session"; readonly value: string }
  | { readonly kind: "api_key"; readonly value: string };

/**
 * Why a credential did not resolve.
 *   - `invalid_credential`: not a live credential of that kind (unknown,
 *     revoked, expired, the wrong scope, or its account revoked or deleted),
 *     for both kinds alike.
 *   - `inactive_account`: a live credential whose account is not active YET
 *     (`pending`: its email is unverified). Never a revoked account.
 *   - `unresolved_account`: the account's stored record cannot be expressed as
 *     a principal (an unrecognised role). An operator problem, not the caller's,
 *     and a value, never a throw.
 *   - `unavailable`: this API is in full maintenance mode and answers no reads.
 *     Says nothing about the credential; the caller fails closed and may retry
 *     later.
 */
export type PrincipalRefusal =
  | "invalid_credential"
  | "inactive_account"
  | "unresolved_account"
  | "unavailable";

export type ResolvePrincipalResult =
  | { readonly ok: true; readonly principal: Principal }
  | { readonly ok: false; readonly error: PrincipalRefusal };

/**
 * Trade a one-time grant code for a private-site session.
 *
 * `userAgent` and `clientIp` describe the visitor as the private site saw
 * them; they are recorded for diagnostics only (the address hashed, never
 * stored as sent) and decide nothing. A `userAgent` longer than 512 characters
 * is truncated, and a `clientIp` longer than 64, or not a string, is dropped.
 */
export interface ExchangePrivateGrantRequest {
  readonly code: string;
  /** The value of the private site's own `state` cookie for this browser. */
  readonly state: string;
  readonly userAgent: string | null;
  readonly clientIp: string | null;
}

/**
 * `invalid_grant` is one answer for a code that never existed, one already
 * spent, one expired, one presented with a missing or different `state` (the
 * grant is then NOT consumed), and one whose account stopped qualifying since
 * the grant:
 * splitting them would tell a caller holding a stolen code which dead end it
 * is. `unavailable` is this API in maintenance mode (`read-only` or `full`),
 * refusing writes.
 *
 * This is the one method that can THROW after a refusal is no longer
 * possible: once the grant is spent, a session that does not resolve (an
 * unrecognised role, or a change in the instant between) is a fault. The
 * grant is consumed and the session row exists, but its value is never
 * returned, so nobody holds it.
 */
export type ExchangePrivateGrantResult =
  | {
      readonly ok: true;
      /** The session value. Returned exactly once; the caller sets it as its
       *  own host-only cookie and never logs it. */
      readonly session: string;
      readonly maxAgeSeconds: number;
      readonly principal: Principal;
    }
  | { readonly ok: false; readonly error: "invalid_grant" | "unavailable" };

export interface RevokePrivateSessionRequest {
  /** The private-site session value to end. */
  readonly value: string;
}

/** `ok: true` means NO LIVE PRIVATE-SITE SESSION HOLDS THIS VALUE now, not
 *  that a row was ended: an unknown, already-revoked or non-private value is
 *  also `ok: true`, and changes nothing. `unavailable` is maintenance mode
 *  refusing writes, and the session is still live. */
export type RevokePrivateSessionResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: "unavailable" };

/**
 * The methods `NemarApiRpc` exposes. A caller types its binding with this
 * interface; the class in this repository implements it, so the two cannot
 * disagree about a method's shape.
 */
export interface NemarApiRpcContract {
  resolvePrincipal(credential: PrincipalCredential): Promise<ResolvePrincipalResult>;
  exchangePrivateGrant(request: ExchangePrivateGrantRequest): Promise<ExchangePrivateGrantResult>;
  revokePrivateSession(request: RevokePrivateSessionRequest): Promise<RevokePrivateSessionResult>;
}
