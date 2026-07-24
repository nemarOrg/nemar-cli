/**
 * ORCID SSO routes (#832), mounted under the same `/auth` prefix as the
 * passwordless flow in auth-web.ts.
 *
 *   GET  /auth/orcid/start     - set state cookie, 302 to ORCID authorize
 *   GET  /auth/orcid/callback  - verify state, exchange code, then either
 *                                sign in / link / hand off to email collection
 *   POST /auth/orcid/finalize  - finish a brand-new ORCID signup with an email
 *   POST /auth/orcid/unlink    - (authed) remove the ORCID link
 *
 * Linking is initiated via `GET /auth/orcid/start?mode=link` and completed in
 * the same callback (the callback links to whichever user the session cookie
 * resolves to), so there is no separate `POST /auth/orcid/link` route in the
 * issue's sketch -- the callback covers it. Noted here so the divergence from
 * the issue's 4-route list is intentional, not an omission.
 *
 * Host/cookie model: these routes run on api.nemar.org but the browser reaches
 * them through the app.nemar.org same-origin proxy (like /auth/code/*), which
 * mirrors our Set-Cookie. Cookies therefore carry Domain=WEB_SESSION_COOKIE_DOMAIN
 * (app.nemar.org in prod) and the OAuth redirect_uri points at the app host.
 */

import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { webSessionMiddleware } from "../middleware/webSession";
import { constantTimeEqualHex } from "../services/auth-code";
import {
  type OauthMode,
  PENDING_COOKIE_NAME,
  STATE_COOKIE_NAME,
  buildAuthorizeUrl,
  decideLinkOutcome,
  decideVerifiedFlag,
  decodeState,
  encodeState,
  exchangeCodeForOrcid,
  fetchOrcidName,
  generateCsrf,
  getOrcidConfig,
  orcidPubBase,
  safeNextPath,
  signPending,
  verifyPending,
} from "../services/orcid-auth";
import {
  buildSessionCookie,
  isAllowedOrigin,
  issueSession,
  parseCookieHeader,
} from "../services/web-session";
import type { Bindings, Variables } from "../types/bindings";

export const authOrcidRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

const STATE_TTL_SECONDS = 10 * 60;
const PENDING_TTL_MS = 15 * 60 * 1000;

const emailSchema = z.object({
  email: z
    .string()
    .email()
    .max(320)
    .transform((e) => e.trim().toLowerCase()),
});

// Finalize a brand-new ORCID signup. Mirrors the CLI signup's required fields
// (#835): city/country are required for export-control screening, affiliation
// optional. Name comes from ORCID, never the form.
const finalizeSchema = z.object({
  email: z
    .string()
    .email()
    .max(320)
    .transform((e) => e.trim().toLowerCase()),
  affiliation: z.string().max(200).optional(),
  city: z.string().min(1, "City is required").max(120),
  country: z.string().min(1, "Country is required").max(120),
});

// ------------------------------- helpers -------------------------------

/** Authenticated app origin for OAuth redirects + post-login landings. Uses
 *  APP_BASE_URL, NOT FRONTEND_URL: the latter is the marketing apex
 *  (https://nemar.org), but the ORCID redirect_uri and the session/pending
 *  cookies are scoped to the app host (https://app.nemar.org). */
function appBase(env: Bindings): string {
  return (env.APP_BASE_URL?.trim() || "https://app.nemar.org").replace(/\/+$/, "");
}

function cookieDomain(env: Bindings): string | undefined {
  return env.WEB_SESSION_COOKIE_DOMAIN || undefined;
}

interface CookieOpts {
  domain?: string;
  maxAgeSeconds?: number;
}

function buildCookie(name: string, value: string, opts: CookieOpts = {}): string {
  const parts = [`${name}=${value}`, "HttpOnly", "Secure", "SameSite=Lax", "Path=/"];
  if (opts.domain) parts.push(`Domain=${opts.domain}`);
  if (typeof opts.maxAgeSeconds === "number") parts.push(`Max-Age=${opts.maxAgeSeconds}`);
  return parts.join("; ");
}

function clearCookie(name: string, domain: string | undefined): string {
  return buildCookie(name, "", { domain, maxAgeSeconds: 0 });
}

function redirect(location: string, cookies: string[] = []): Response {
  const headers = new Headers({ Location: location, "Cache-Control": "no-store" });
  for (const ck of cookies) headers.append("Set-Cookie", ck);
  return new Response(null, { status: 302, headers });
}

interface ActiveUser {
  id: number;
  email: string;
  role: string | null;
  status: string;
}

async function loadActiveUser(env: Bindings, userId: number): Promise<ActiveUser | null> {
  return env.DB.prepare(
    "SELECT id, email, role, status FROM users WHERE id = ? AND deleted_at IS NULL AND status != 'revoked' LIMIT 1",
  )
    .bind(userId)
    .first<ActiveUser>();
}

/** Insert the oauth_identities row and reconcile users.orcid/orcid_verified. */
async function linkIdentity(
  env: Bindings,
  userId: number,
  orcid: string,
  name: string | null,
): Promise<void> {
  const userRow = await env.DB.prepare("SELECT orcid FROM users WHERE id = ? LIMIT 1")
    .bind(userId)
    .first<{ orcid: string | null }>();
  const decision = decideVerifiedFlag(userRow?.orcid ?? null, orcid);
  if (decision.needsAdminReview) {
    console.warn(
      `[auth-orcid] verified iD ${orcid} differs from discovered users.orcid=${userRow?.orcid ?? "null"} for user ${userId}; keeping citation value, leaving orcid_verified=0 for admin review`,
    );
  }

  const reconcileUsers = decision.setUsersOrcid
    ? env.DB.prepare("UPDATE users SET orcid = ?, orcid_verified = ? WHERE id = ?").bind(
        decision.setUsersOrcid,
        decision.orcidVerified,
        userId,
      )
    : env.DB.prepare("UPDATE users SET orcid_verified = ? WHERE id = ?").bind(
        decision.orcidVerified,
        userId,
      );

  // One D1 batch == one implicit transaction, so the identity insert and the
  // users reconcile land together. Without it a mid-sequence failure could
  // leave an identity row with a stale users.orcid_verified (or vice versa).
  // A UNIQUE(provider, provider_subject) violation from a concurrent link
  // throws here; the caller's try/catch turns it into a clean failure.
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO oauth_identities (user_id, provider, provider_subject, provider_email, display_name, last_login_at)
       VALUES (?, 'orcid', ?, NULL, ?, datetime('now'))`,
    ).bind(userId, orcid, name),
    reconcileUsers,
  ]);
}

/** Run a best-effort promise after the response is sent, so an external ORCID
 *  fetch never adds latency to (or risks timing out) the auth response. Falls
 *  back to fire-and-forget if no ExecutionContext is available (e.g. tests). */
function afterResponse(
  c: { executionCtx?: { waitUntil(p: Promise<unknown>): void } },
  p: Promise<unknown>,
): void {
  try {
    c.executionCtx?.waitUntil(p);
  } catch {
    void p;
  }
}

async function touchIdentityLogin(env: Bindings, orcid: string): Promise<void> {
  await env.DB.prepare(
    "UPDATE oauth_identities SET last_login_at = datetime('now') WHERE provider = 'orcid' AND provider_subject = ?",
  )
    .bind(orcid)
    .run();
}

/** Dynamic name backfill (#835): ORCID is canonical, so on every ORCID
 *  login/link/signup we refresh given/family name from the public record.
 *  COALESCE keeps an existing value when ORCID hides the name (fetch -> null),
 *  so a privacy-restricted record never wipes a good name. Best-effort: a
 *  fetch/DB failure is logged, never blocks the sign-in. */
async function refreshUserName(env: Bindings, userId: number, orcid: string): Promise<void> {
  try {
    const { given, family } = await fetchOrcidName(orcid, orcidPubBase(env));
    if (!given && !family) return;
    await env.DB.prepare(
      "UPDATE users SET given_name = COALESCE(?, given_name), family_name = COALESCE(?, family_name) WHERE id = ?",
    )
      .bind(given, family, userId)
      .run();
  } catch (err) {
    console.warn(`[auth-orcid] name refresh failed for user ${userId} (${orcid})`, err);
  }
}

function clientIp(c: { req: { header: (k: string) => string | undefined } }): string | null {
  return (
    c.req.header("CF-Connecting-IP") ||
    c.req.header("X-Forwarded-For")?.split(",")[0]?.trim() ||
    null
  );
}

// ------------------------------- routes --------------------------------

authOrcidRoutes.get("/orcid/start", (c) => {
  const frontend = appBase(c.env);
  const url = new URL(c.req.url);
  const mode: OauthMode = url.searchParams.get("mode") === "link" ? "link" : "login";
  const next = safeNextPath(url.searchParams.get("next"));

  const config = getOrcidConfig(c.env);
  if (!config) {
    return redirect(`${frontend}/login?error=orcid_unavailable`);
  }

  const csrf = generateCsrf();
  const stateCookie = buildCookie(STATE_COOKIE_NAME, encodeState({ csrf, mode, next }), {
    domain: cookieDomain(c.env),
    maxAgeSeconds: STATE_TTL_SECONDS,
  });
  const authorizeUrl = buildAuthorizeUrl({
    config,
    redirectUri: `${frontend}/auth/orcid/callback`,
    state: csrf,
  });
  return redirect(authorizeUrl, [stateCookie]);
});

authOrcidRoutes.get("/orcid/callback", webSessionMiddleware, async (c) => {
  const frontend = appBase(c.env);
  const domain = cookieDomain(c.env);
  const clearState = clearCookie(STATE_COOKIE_NAME, domain);
  const url = new URL(c.req.url);

  const fail = (reason: string, next = "/login"): Response => {
    const sep = next.includes("?") ? "&" : "?";
    return redirect(`${frontend}${next}${sep}error=${reason}`, [clearState]);
  };

  if (url.searchParams.get("error")) return fail("orcid_denied");

  const state = decodeState(parseCookieHeader(c.req.header("Cookie"), STATE_COOKIE_NAME));
  const stateParam = url.searchParams.get("state");
  if (!state || !stateParam || !constantTimeEqualHex(stateParam, state.csrf)) {
    return fail("orcid_state");
  }
  const code = url.searchParams.get("code");
  if (!code) return fail("orcid_state");

  const config = getOrcidConfig(c.env);
  if (!config) return fail("orcid_unavailable");

  let token: { orcid: string; name: string | null };
  try {
    token = await exchangeCodeForOrcid(config, code, `${frontend}/auth/orcid/callback`);
  } catch (err) {
    console.error("[auth-orcid] token exchange failed", err);
    return fail("orcid_exchange");
  }
  const { orcid, name } = token;

  // Everything past the token exchange touches D1. Wrap it so a transient
  // failure clears the state cookie and returns an actionable redirect rather
  // than a bare Hono 500 that strands the user behind a stale state cookie for
  // the full 10-minute TTL.
  try {
    const ident = await c.env.DB.prepare(
      "SELECT user_id FROM oauth_identities WHERE provider = 'orcid' AND provider_subject = ? LIMIT 1",
    )
      .bind(orcid)
      .first<{ user_id: number }>();

    const webUser = c.var.webUser;

    // An already-authenticated session => link to that user (regardless of the
    // start mode, so a logged-in user can never accidentally spawn a duplicate
    // account). The default landing is the carried `next` (the onboarding gate
    // passes /welcome).
    if (webUser) {
      const outcome = decideLinkOutcome(ident?.user_id ?? null, webUser.id);
      if (outcome === "conflict") return fail("orcid_linked_other", state.next);
      if (outcome === "already_linked") {
        await touchIdentityLogin(c.env, orcid);
        afterResponse(c, refreshUserName(c.env, webUser.id, orcid));
        return redirect(`${frontend}${state.next}`, [clearState]);
      }
      // link_new: refuse a second, different ORCID on one account.
      const mine = await c.env.DB.prepare(
        "SELECT provider_subject FROM oauth_identities WHERE user_id = ? AND provider = 'orcid' LIMIT 1",
      )
        .bind(webUser.id)
        .first<{ provider_subject: string }>();
      if (mine && mine.provider_subject !== orcid) {
        return fail("orcid_already_have", state.next);
      }
      await linkIdentity(c.env, webUser.id, orcid, name);
      afterResponse(c, refreshUserName(c.env, webUser.id, orcid));
      return redirect(`${frontend}${state.next}`, [clearState]);
    }

    // No session: sign in the linked account, or hand a brand-new ORCID off to
    // email collection (ORCID returns no email; users.email is NOT NULL).
    if (ident) {
      const user = await loadActiveUser(c.env, ident.user_id);
      if (!user) return fail("orcid_account");
      const { cookieIdRaw, maxAgeSeconds } = await issueSession(
        c.env,
        user.id,
        false,
        c.req.header("User-Agent") ?? null,
        clientIp(c),
        "orcid",
      );
      await touchIdentityLogin(c.env, orcid);
      afterResponse(c, refreshUserName(c.env, user.id, orcid));
      const session = buildSessionCookie(cookieIdRaw, { domain, maxAgeSeconds });
      const next = state.next !== "/" ? state.next : "/dashboard";
      return redirect(`${frontend}${next}`, [clearState, session]);
    }

    if (!c.env.ENCRYPTION_KEY) {
      console.error("[auth-orcid] ENCRYPTION_KEY unset; cannot issue pending-signup token");
      return fail("orcid_unavailable");
    }
    const pending = await signPending(
      { orcid, name, exp: Date.now() + PENDING_TTL_MS },
      c.env.ENCRYPTION_KEY,
    );
    const pendingCookie = buildCookie(PENDING_COOKIE_NAME, pending, {
      domain,
      maxAgeSeconds: Math.floor(PENDING_TTL_MS / 1000),
    });
    // Hand off to the email-collection page. It lives under /auth (an app-host
    // route) so the Domain=app.nemar.org pending cookie is actually sent to it;
    // the public /signup page is not app-scoped. See website#128.
    return redirect(`${frontend}/auth/orcid/complete`, [clearState, pendingCookie]);
  } catch (err) {
    console.error("[auth-orcid] callback failed after token exchange", err);
    return fail("orcid_error");
  }
});

authOrcidRoutes.post("/orcid/finalize", zValidator("json", finalizeSchema), async (c) => {
  if (!isAllowedOrigin(c.req.header("Origin"))) {
    return c.json({ error: "Origin not allowed" }, 403);
  }
  if (!c.env.ENCRYPTION_KEY) {
    console.error("[auth-orcid] ENCRYPTION_KEY unset; cannot verify pending-signup token");
    return c.json({ error: "ORCID sign-up unavailable" }, 503);
  }

  const domain = cookieDomain(c.env);
  const clearPending = clearCookie(PENDING_COOKIE_NAME, domain);

  try {
    const pendingRaw = parseCookieHeader(c.req.header("Cookie"), PENDING_COOKIE_NAME);
    const pending = await verifyPending(pendingRaw, c.env.ENCRYPTION_KEY, Date.now());
    if (!pending) {
      c.header("Set-Cookie", clearPending);
      return c.json({ error: "orcid_pending_expired" }, 401);
    }

    const { email, affiliation, city, country } = c.req.valid("json");

    // Email collision: never auto-link onto an existing account (takeover
    // vector). Make the user sign in with their existing method, then link
    // ORCID from settings.
    const existing = await c.env.DB.prepare(
      "SELECT id FROM users WHERE email = ? AND deleted_at IS NULL LIMIT 1",
    )
      .bind(email)
      .first<{ id: number }>();
    if (existing) {
      return c.json({ error: "email_in_use" }, 409);
    }

    // Same ORCID may already back an account if the user double-submitted or
    // raced the form; UNIQUE(provider, provider_subject) is the backstop.
    const identExists = await c.env.DB.prepare(
      "SELECT user_id FROM oauth_identities WHERE provider = 'orcid' AND provider_subject = ? LIMIT 1",
    )
      .bind(pending.orcid)
      .first<{ user_id: number }>();
    if (identExists) {
      c.header("Set-Cookie", clearPending);
      return c.json({ error: "orcid_already_linked" }, 409);
    }

    // New web account: username/github_username/password_hash stay NULL
    // (allowed since 0026); name lives on the identity row.
    //
    // Tiered access (ADR 0010, #1013): ORCID sign-in auto-approves to BASE
    // access (status='approved') -- view/dashboard only. This is safe because
    // 'approved' no longer implies upload: uploading additionally requires
    // `service_access` (granted 0 here), so a base user cannot consume compute
    // until an admin grants service access after export-control review. The
    // email is collected, not verified -- ORCID proves the iD, not the inbox;
    // email_verified stays 0 (the account can still receive PIN codes).
    const insert = await c.env.DB.prepare(
      `INSERT INTO users (email, orcid, orcid_verified, status, email_verified, signup_source,
         affiliation, city, country, approved_at, service_access)
       VALUES (?, ?, 1, 'approved', 0, 'web', ?, ?, ?, datetime('now'), 0)`,
    )
      .bind(email, pending.orcid, affiliation || null, city, country)
      .run();
    const userId = insert.meta?.last_row_id;
    if (!userId) {
      console.error("[auth-orcid] finalize: user insert returned no row id");
      return c.json({ error: "Sign-up failed" }, 500);
    }

    // The identity insert is a separate statement (a D1 batch can't reuse the
    // just-inserted row id). If it fails -- e.g. a concurrent signup won the
    // UNIQUE(provider, provider_subject) race past the identExists check above
    // -- delete the orphan users row so we never strand an account that has an
    // email but no usable ORCID login.
    try {
      await c.env.DB.prepare(
        `INSERT INTO oauth_identities (user_id, provider, provider_subject, provider_email, display_name, last_login_at)
         VALUES (?, 'orcid', ?, NULL, ?, datetime('now'))`,
      )
        .bind(userId, pending.orcid, pending.name)
        .run();
    } catch (identErr) {
      console.error("[auth-orcid] finalize: identity insert failed; rolling back user", identErr);
      await c.env.DB.prepare("DELETE FROM users WHERE id = ?")
        .bind(userId)
        .run()
        .catch((delErr) =>
          console.error("[auth-orcid] finalize: failed to roll back orphan user", delErr),
        );
      c.header("Set-Cookie", clearPending);
      return c.json({ error: "orcid_already_linked" }, 409);
    }

    const { cookieIdRaw, maxAgeSeconds } = await issueSession(
      c.env,
      userId,
      false,
      c.req.header("User-Agent") ?? null,
      clientIp(c),
      "orcid",
    );
    c.header("Set-Cookie", clearPending);
    c.header("Set-Cookie", buildSessionCookie(cookieIdRaw, { domain, maxAgeSeconds }), {
      append: true,
    });
    // Canonical name from ORCID, after the response (best-effort; never blocks signup).
    afterResponse(c, refreshUserName(c.env, userId, pending.orcid));
    // status "active" mirrors userStatusForDashboard('approved') used by
    // /auth/me — the account has base access immediately (ADR 0010).
    return c.json({
      user: { id: userId, email, role: "member", status: "active" },
    });
  } catch (err) {
    console.error("[auth-orcid] finalize failed", err);
    c.header("Set-Cookie", clearPending);
    return c.json({ error: "Sign-up failed" }, 500);
  }
});

authOrcidRoutes.post("/orcid/unlink", webSessionMiddleware, async (c) => {
  if (!isAllowedOrigin(c.req.header("Origin"))) {
    return c.json({ error: "Origin not allowed" }, 403);
  }
  const webUser = c.var.webUser;
  if (!webUser) return c.json({ error: "Authentication required" }, 401);

  // Drop the verified link but keep users.orcid (the citation-facing value).
  // Email-code login still works, so removing the only OAuth identity never
  // locks the account out. The two writes go in one D1 batch so we never leave
  // orcid_verified=1 with the identity row already gone (or vice versa).
  try {
    await c.env.DB.batch([
      c.env.DB.prepare(
        "DELETE FROM oauth_identities WHERE user_id = ? AND provider = 'orcid'",
      ).bind(webUser.id),
      c.env.DB.prepare("UPDATE users SET orcid_verified = 0 WHERE id = ?").bind(webUser.id),
    ]);
  } catch (err) {
    console.error("[auth-orcid] unlink failed", err);
    return c.json({ error: "Unlink failed" }, 500);
  }
  return c.json({ ok: true });
});
