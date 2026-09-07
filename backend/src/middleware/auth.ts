/**
 * Authentication middleware
 *
 * Validates API keys from Authorization header and sets user context.
 *
 * The bearer-token path is the CLI's authentication mechanism and remains
 * unchanged. As of #572 the same middleware ALSO accepts the
 * `nemar_session` cookie issued by the passwordless flow (#569) so the
 * dashboard at app.nemar.org can call the user-scoped /datasets, /users
 * and /admin routes without a separate API token. Bearer wins when both
 * are present.
 */

import type { Context, Next } from "hono";
import {
  ACTIVE_ACCOUNT_STATUS_SQL_LIST,
  inactiveAccountBody,
  isActiveAccountStatus,
} from "../services/account-tier";
import { hashApiKey } from "../services/token";
import {
  COOKIE_NAME,
  hashCookieId,
  isAllowedOrigin,
  parseCookieHeader,
} from "../services/web-session";
import {
  type AuthUser,
  type Bindings,
  type Variables,
  hasRole,
  parseRole,
} from "../types/bindings";

type AuthContext = Context<{ Bindings: Bindings; Variables: Variables }>;

/**
 * The three things a `nemar_session` cookie can mean. A bare `null` used to
 * cover all of them, which made a signed-in user whose account is not active
 * indistinguishable from a browser carrying no cookie at all: `authMiddleware`
 * answered "Missing Authorization header", which is both untrue and
 * unactionable for someone looking at a dashboard they are signed into. The
 * `inactive` case now carries the status so the caller can say what to do
 * about it — the same answer the bearer path gives.
 *
 * `unresolved` is the genuinely anonymous case AND the degraded one (a D1
 * hiccup, an unreadable role): both mean "this request has no cookie identity
 * we can use", and neither is something to explain to the caller.
 */
type CookieAuthResult =
  | { kind: "user"; user: AuthUser }
  | { kind: "unresolved" }
  | { kind: "inactive"; status: string };

/**
 * Resolve a `nemar_session` cookie to a full AuthUser row.
 *
 * The `user` shape mirrors the bearer-token lookup so downstream routes can
 * `c.get("user")` without caring which auth path succeeded.
 *
 * `verified` is accepted as of ADR 0040 phase 2: it is the base tier, and
 * the dashboard's own routes (dataset list, /users/me) are part of it. What
 * a base-tier account still cannot do is upload — every real-upload entry
 * point routes through services/upload-gate.ts, which reads `service_access`
 * and never `status`, so widening this does not widen upload. `pending` is
 * still rejected, but LOUDLY (see CookieAuthResult): an unverified inbox has
 * proved nothing, and the caller is told to go verify it.
 */
async function resolveCookieUser(c: AuthContext): Promise<CookieAuthResult> {
  const cookieHeader = c.req.header("Cookie");
  const cookieIdRaw = parseCookieHeader(cookieHeader, COOKIE_NAME);
  if (!cookieIdRaw) return { kind: "unresolved" };

  // Wrap the D1 lookup in a try/catch so a transient backend failure
  // degrades to "no cookie auth" instead of bubbling a 500 through
  // `api.onError`. Without this, a brief D1 hiccup turns
  // `GET /datasets` into a 500 for every browser that happens to be
  // carrying a `nemar_session` cookie — even though the route has a
  // valid anonymous branch. Mirrors `webSessionMiddleware`.
  try {
    const cookieHash = await hashCookieId(cookieIdRaw);

    const row = await c.env.DB.prepare(
      `SELECT u.id, u.username, u.email, u.github_username, u.role, u.orcid, u.status
         FROM web_sessions ws
         JOIN users u ON u.id = ws.user_id
        WHERE ws.cookie_id_hash = ?
          AND ws.revoked_at IS NULL
          AND ws.expires_at > datetime('now')
          AND u.deleted_at IS NULL
        LIMIT 1`,
    )
      .bind(cookieHash)
      .first<{
        id: number;
        username: string | null;
        email: string;
        github_username: string | null;
        role: string | null;
        orcid: string | null;
        status: string;
      }>();
    if (!row) return { kind: "unresolved" };
    if (!isActiveAccountStatus(row.status)) return { kind: "inactive", status: row.status };

    const role = parseRole(row.role, row.username ?? row.email);
    if (role === null) return { kind: "unresolved" };

    return {
      kind: "user",
      user: {
        id: row.id,
        // Web-only signups (#569) may have NULL username / github_username
        // until admin onboarding lifts them to a full account. Routes
        // that only need `id` / `role` / `email` work as-is; routes that
        // strictly require a GitHub login (e.g. repo creation) will
        // fail naturally when they reach the GitHub API call.
        username: row.username ?? "",
        email: row.email,
        github_username: row.github_username ?? "",
        role,
        orcid: row.orcid || undefined,
      },
    };
  } catch (err) {
    console.error("[auth] resolveCookieUser: cookie lookup failed", err);
    return { kind: "unresolved" };
  }
}

/**
 * What an `Authorization` header resolved to.
 *
 * `absent` is "no header at all" and is the only outcome a caller may fall
 * through on: every other failure is a deliberate answer (a malformed header,
 * a dead key, an inactive account) that must reach the client verbatim rather
 * than being retried as anonymous.
 */
export type BearerAuthResult =
  | { kind: "absent" }
  | { kind: "refused"; response: Response }
  | { kind: "user"; user: AuthUser };

/**
 * Resolve `Authorization: Bearer <api_key>` to a full AuthUser.
 *
 * Extracted from `authMiddleware` for #1266 so the CLI-facing self-service
 * routes in auth-web.ts / auth-orcid.ts accept a token through the SAME
 * lookup the rest of the API uses — same key hashing, same revoked/expired
 * filter, same active-account rule, same `last_used_at` touch. A second copy
 * of this SELECT is how a route ends up honouring a token the middleware
 * would have refused.
 */
export async function resolveBearerUser(c: AuthContext): Promise<BearerAuthResult> {
  const authHeader = c.req.header("Authorization");
  if (!authHeader) return { kind: "absent" };

  if (!authHeader.startsWith("Bearer ")) {
    return {
      kind: "refused",
      response: c.json(
        { error: "Invalid Authorization header format. Use: Bearer <api_key>" },
        401,
      ),
    };
  }

  const apiKey = authHeader.substring(7);

  if (!apiKey || apiKey.length < 32) {
    return { kind: "refused", response: c.json({ error: "Invalid API key format" }, 401) };
  }

  // Hash the key for lookup
  const hashedKey = await hashApiKey(apiKey);

  // Find token and associated user
  const result = await c.env.DB.prepare(
    `
      SELECT
        u.id,
        u.username,
        u.email,
        u.github_username,
        u.role,
        u.orcid,
        u.status,
        t.id as token_id
      FROM tokens t
      JOIN users u ON t.user_id = u.id
      WHERE t.api_key_hash = ?
        AND t.revoked_at IS NULL
        AND (t.expires_at IS NULL OR t.expires_at > datetime('now'))
        AND u.deleted_at IS NULL
    `,
  )
    .bind(hashedKey)
    .first<{
      id: number;
      username: string;
      email: string;
      github_username: string;
      role: string | null;
      orcid: string | null;
      status: string;
      token_id: number;
    }>();

  if (!result) {
    return { kind: "refused", response: c.json({ error: "Invalid or expired API key" }, 401) };
  }

  // ADR 0040 phase 2: `verified` is the base tier and holds a usable API
  // key, so the token is accepted here and the upload gate — not this
  // middleware — is what a base-tier account runs into.
  if (!isActiveAccountStatus(result.status)) {
    return { kind: "refused", response: c.json(inactiveAccountBody(result.status), 403) };
  }

  // Validate role from DB
  const role = parseRole(result.role, result.username);
  if (role === null) {
    return {
      kind: "refused",
      response: c.json({ error: "Account configuration error. Contact an administrator." }, 500),
    };
  }

  // Update last_used_at for the token
  await c.env.DB.prepare("UPDATE tokens SET last_used_at = datetime('now') WHERE id = ?")
    .bind(result.token_id)
    .run();

  return {
    kind: "user",
    user: {
      id: result.id,
      username: result.username,
      email: result.email,
      github_username: result.github_username,
      role,
      orcid: result.orcid || undefined,
    },
  };
}

/**
 * Middleware to require authentication via either a bearer API token or
 * the web-dashboard `nemar_session` cookie (#572).
 *
 * Resolution order:
 *  1. `Authorization: Bearer <api_key>` — CLI path, unchanged.
 *  2. `Cookie: nemar_session=…` — dashboard path, added for #572.
 *  3. Neither resolves -> 401 with the same shape we returned before
 *     cookies existed.
 *
 * Sets `c.var.user` with the resolved AuthUser regardless of which path
 * matched, so route handlers don't need to branch.
 */
export async function authMiddleware(c: AuthContext, next: Next) {
  // -------------------------------------------------------------------
  // Path 1: Authorization: Bearer <api_key>
  // -------------------------------------------------------------------
  const bearer = await resolveBearerUser(c);
  if (bearer.kind === "refused") return bearer.response;
  if (bearer.kind === "user") {
    c.set("user", bearer.user);
    c.set("authMethod", "token");
    await next();
    return;
  }

  // -------------------------------------------------------------------
  // Path 2: nemar_session cookie (#572)
  // -------------------------------------------------------------------
  const cookieAuth = await resolveCookieUser(c);
  if (cookieAuth.kind === "user") {
    c.set("user", cookieAuth.user);
    c.set("authMethod", "cookie");
    await next();
    return;
  }
  // A real session for an account that cannot use the API yet. Falling
  // through to the 401 below would tell a signed-in browser it sent no
  // credentials at all; answer with the same 403 body the bearer path uses,
  // which names the step that unblocks them.
  if (cookieAuth.kind === "inactive") {
    return c.json(inactiveAccountBody(cookieAuth.status), 403);
  }

  // -------------------------------------------------------------------
  // Path 3: nothing — refuse with the original 401 shape so older
  // clients that pattern-match the error string keep working.
  // -------------------------------------------------------------------
  return c.json({ error: "Missing Authorization header" }, 401);
}

/**
 * The account acting on a self-service route, whichever credential it used.
 *
 * Only the three fields those routes actually need off the credential: the id
 * every write is scoped by, the current address the email change compares
 * against, and the current GitHub handle `githubHandleChanged` compares
 * against. Everything else is re-read from `users` inside the handler, which
 * is what lets ONE handler serve both credentials without caring which one
 * arrived (#1266).
 */
export interface ActingAccount {
  id: number;
  email: string;
  github_username: string | null;
  via: "cookie" | "token";
}

export type ActingAccountResolution =
  | { ok: true; actor: ActingAccount }
  | { ok: false; response: Response };

/**
 * Resolve the account acting on a route that accepts EITHER the CLI's bearer
 * token or the dashboard's `nemar_session` cookie (#1266, ADR 0044).
 *
 * Deliberately NOT `authMiddleware` mounted on these routes, for one reason
 * that only shows up on the cookie half: `authMiddleware`'s cookie path
 * refuses a `pending` account (403, ADR 0040), while `webSessionMiddleware`
 * admits it. An account that typed its address wrong at sign-up is `pending`
 * BECAUSE the address is wrong, and the email change is the one thing it must
 * still be able to do. So the cookie path keeps `webSessionMiddleware`'s
 * acceptance byte for byte, and the token path uses the shared
 * `resolveBearerUser` above — which, being the standard token rule, admits
 * only an active account. A `pending` CLI account has no token to present
 * anyway: the key is issued after verification.
 *
 * The Origin allow-list applies to the COOKIE path only, and that is the whole
 * point of it: a cookie rides along with any cross-site request the browser is
 * tricked into making, and a bearer token does not. Requiring an Origin header
 * a CLI has no reason to send would refuse every terminal.
 *
 * Bearer wins when both are present, matching `authMiddleware`.
 *
 * Requires `webSessionMiddleware` to have run for the cookie half.
 */
export async function resolveActingAccount(c: AuthContext): Promise<ActingAccountResolution> {
  const bearer = await resolveBearerUser(c);
  if (bearer.kind === "refused") return { ok: false, response: bearer.response };
  if (bearer.kind === "user") {
    c.set("user", bearer.user);
    c.set("authMethod", "token");
    return {
      ok: true,
      actor: {
        id: bearer.user.id,
        email: bearer.user.email,
        github_username: bearer.user.github_username || null,
        via: "token",
      },
    };
  }

  if (!isAllowedOrigin(c.req.header("Origin"))) {
    return { ok: false, response: c.json({ error: "Origin not allowed" }, 403) };
  }
  const webUser = c.var.webUser;
  if (!webUser) {
    return { ok: false, response: c.json({ error: "Authentication required" }, 401) };
  }
  c.set("authMethod", "cookie");
  return {
    ok: true,
    actor: {
      id: webUser.id,
      email: webUser.email,
      github_username: webUser.github_username,
      via: "cookie",
    },
  };
}

/**
 * Middleware to require admin role
 *
 * Must be used after authMiddleware
 */
export async function adminMiddleware(c: AuthContext, next: Next) {
  const user = c.get("user");

  if (!user) {
    return c.json({ error: "Authentication required" }, 401);
  }

  if (!hasRole(user.role, "admin")) {
    return c.json({ error: "Admin access required" }, 403);
  }

  await next();
}

/**
 * Middleware to require owner role
 *
 * Must be used after authMiddleware
 */
export async function ownerMiddleware(c: AuthContext, next: Next) {
  const user = c.get("user");

  if (!user) {
    return c.json({ error: "Authentication required" }, 401);
  }

  if (user.role !== "owner") {
    return c.json({ error: "Owner access required" }, 403);
  }

  await next();
}

/**
 * Optional auth middleware - sets user if authenticated, but doesn't require it.
 *
 * When an Authorization: Bearer header is provided but the token cannot be
 * resolved to an active user (revoked, expired, malformed, email not yet
 * verified, etc.), the middleware sets `authAttempted=true` so downstream
 * routes that require auth on a flag (e.g., `GET /datasets?mine=true`) can
 * return a token-specific 401 instead of a generic "Authentication required"
 * — which is indistinguishable from "no header sent" to a confused CLI user
 * who thinks they're logged in (see nemarOrg/nemar-cli#447).
 *
 * As of #572 this also resolves the `nemar_session` cookie when no
 * bearer header is present. A failing cookie does NOT trip
 * `authAttempted` — the cookie is opaque to the dashboard user and
 * there's no actionable error to surface; routes simply fall back to
 * their anonymous branch.
 */
export async function optionalAuthMiddleware(c: AuthContext, next: Next) {
  const authHeader = c.req.header("Authorization");

  // Case-sensitive: "bearer" (lowercase) is treated as no auth attempted.
  // The CLI always sends "Bearer" (capital B, src/lib/api.ts), so this is
  // not a practical concern, but proxies that lowercase headers will silently
  // degrade to unauthenticated rather than triggering the stale-token path.
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    // No bearer header — try the cookie before going anonymous. An inactive
    // cookie is treated exactly like no cookie here: this middleware never
    // refuses a request, so the route's anonymous branch is the right
    // outcome, and `authAttempted` stays reserved for bearer tokens (a
    // cookie is opaque to the dashboard user; there is nothing to surface).
    const cookieAuth = await resolveCookieUser(c);
    if (cookieAuth.kind === "user") {
      c.set("user", cookieAuth.user);
    }
    await next();
    return;
  }

  const apiKey = authHeader.substring(7);
  if (!apiKey || apiKey.length < 32) {
    // Malformed token — caller clearly intended to authenticate.
    c.set("authAttempted", true);
    await next();
    return;
  }

  c.set("authAttempted", true);

  const hashedKey = await hashApiKey(apiKey);

  const result = await c.env.DB.prepare(
    `
    SELECT
      u.id,
      u.username,
      u.email,
      u.github_username,
      u.role,
      u.orcid,
      u.status
    FROM tokens t
    JOIN users u ON t.user_id = u.id
    WHERE t.api_key_hash = ?
      AND t.revoked_at IS NULL
      AND u.status IN ${ACTIVE_ACCOUNT_STATUS_SQL_LIST}
      AND u.deleted_at IS NULL
  `,
  )
    .bind(hashedKey)
    .first<{
      id: number;
      username: string;
      email: string;
      github_username: string;
      role: string | null;
      orcid: string | null;
      status: string;
    }>();

  if (result) {
    const role = parseRole(result.role, result.username);
    if (role !== null) {
      c.set("user", {
        id: result.id,
        username: result.username,
        email: result.email,
        github_username: result.github_username,
        role,
        orcid: result.orcid || undefined,
      });
    }
  }

  await next();
}
