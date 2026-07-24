/**
 * Web-dashboard session helpers (#569).
 *
 * The dashboard authenticates via an opaque HttpOnly session cookie.
 * The CLI continues to use bearer API tokens — these helpers exist
 * only for the four `/auth/code/*`, `/auth/logout`, `/auth/me`
 * endpoints in `routes/auth-web.ts` and the middleware in
 * `middleware/webSession.ts`.
 *
 * Cookie value is 256 bits of random base64url. Only the SHA-256 hash
 * of that value lives in D1, so an exfiltrated DB cannot forge
 * cookies (256-bit preimage). The hashing is unkeyed because the
 * value's entropy is already infeasible to brute. The hashing for
 * auth codes IS keyed (HMAC-SHA256) because 6-digit codes have only
 * ~20 bits of entropy and an unkeyed at-rest hash could be
 * brute-forced offline.
 */

import { type Bindings, type UserRole, parseRole } from "../types/bindings";

export const COOKIE_NAME = "nemar_session";

/** Server-side cap on non-remember-me sessions. Browser drops session
 *  cookies on close already; the cap keeps the DB row from outliving
 *  any reasonable session and bounds the cleanup-table size. */
const NON_REMEMBER_TTL_MS = 24 * 60 * 60 * 1000;
const REMEMBER_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Sliding-window refresh: only extend the expiry when the remaining
 *  lifetime drops below this threshold. Avoids a Set-Cookie storm on
 *  every dashboard request — most calls just bump last_used_at. */
const SLIDING_REFRESH_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;

/** Origin allow-list for cookie-issuing/mutating routes.
 *
 *  Narrower than the CORS callback in `index.ts` on purpose: the
 *  CORS layer's `*.osc.earth` allowance was for the legacy api.osc.earth
 *  buffer; the web dashboard only lives on nemar.org / app.nemar.org,
 *  so accepting cookies via osc.earth domains is just attack surface
 *  with no real consumer. Localhost is allowed without a port check
 *  because dev tools commonly bind to ephemeral ports. */
export function isAllowedOrigin(origin: string | null | undefined): boolean {
  if (!origin) return false;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  const h = url.hostname.toLowerCase();
  if (h === "localhost" || h === "127.0.0.1") return true;
  if (h === "nemar.org" || h.endsWith(".nemar.org")) return true;
  return false;
}

/** 256 random bits, URL-safe base64 (43 chars, no padding). */
export function generateCookieId(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

/** Unkeyed SHA-256 hex of the cookie value, for DB storage. */
export async function hashCookieId(cookieIdRaw: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(cookieIdRaw));
  const arr = new Uint8Array(digest);
  let out = "";
  for (let i = 0; i < arr.length; i++) out += arr[i].toString(16).padStart(2, "0");
  return out;
}

/** Best-effort SHA-256 of an IP for privacy-preserving storage. Returns
 *  null on empty input; callers should record null then. */
export async function hashIp(ip: string | null | undefined): Promise<string | null> {
  if (!ip) return null;
  return hashCookieId(ip);
}

/** Parse a single named cookie out of a request's `Cookie` header.
 *  Returns null if the header is missing or doesn't contain the name.
 *  Matches the strict comma-and-semicolon syntax of RFC 6265 enough
 *  for our purposes; we never set multi-value cookies. */
export function parseCookieHeader(header: string | null | undefined, name: string): string | null {
  if (!header) return null;
  const parts = header.split(";");
  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    if (k === name) return part.slice(eq + 1).trim();
  }
  return null;
}

interface CookieOptions {
  domain?: string; // Empty/undefined → host-only (no Domain attribute)
  maxAgeSeconds?: number; // Undefined → session cookie (no Max-Age)
}

/** Build the Set-Cookie value for a freshly issued session.
 *  Flags: HttpOnly, Secure, SameSite=Lax, Path=/. */
export function buildSessionCookie(value: string, opts: CookieOptions = {}): string {
  const parts = [`${COOKIE_NAME}=${value}`, "HttpOnly", "Secure", "SameSite=Lax", "Path=/"];
  if (opts.domain) parts.push(`Domain=${opts.domain}`);
  if (typeof opts.maxAgeSeconds === "number") parts.push(`Max-Age=${opts.maxAgeSeconds}`);
  return parts.join("; ");
}

/** Build the Set-Cookie value that clears the cookie on logout.
 *  Must match the Domain/Path of the original cookie or browsers won't
 *  evict the right entry. */
export function buildClearedSessionCookie(domain: string | undefined): string {
  return buildSessionCookie("", { domain, maxAgeSeconds: 0 });
}

export interface WebSessionRow {
  id: number;
  user_id: number;
  /** Boolean here, even though D1 stores 0/1 — the conversion happens
   *  at the read boundary in `findSessionByCookieId` so consumers
   *  never have to remember the SQLite convention. */
  remember: boolean;
  expires_at: string; // ISO-ish
  last_used_at: string;
}

export interface WebSessionUser {
  id: number;
  email: string;
  /** Validated via `parseRole` at the DB boundary so downstream
   *  comparisons against the `UserRole` union are type-safe. `null`
   *  means the role column held an unrecognised value; treat as no
   *  role rather than guess. */
  role: UserRole | null;
  status: string;
  /** Profile fields surfaced on /auth/me for the website Settings page
   *  (#910). All nullable in D1 (migrations 0051/0052); `null` here means
   *  the column is unset, and the website renders its fallback state. */
  given_name: string | null;
  family_name: string | null;
  orcid: string | null;
  /** Boolean here, even though D1 stores 0/1 — converted at the read
   *  boundary like `WebSessionRow.remember`. */
  orcid_verified: boolean;
  github_username: string | null;
  city: string | null;
  country: string | null;
  affiliation: string | null;
  /** Tiered access (ADR 0010, #1013): true once an admin grants service
   *  access (upload + compute). Base-access accounts are false. Converted
   *  from the 0/1 D1 column at the read boundary like `orcid_verified`. */
  service_access: boolean;
}

/** Look up an active session by cookie value, returning the joined
 *  user row. Returns null if the cookie doesn't match, is revoked,
 *  or has expired. Touches last_used_at as a side effect. */
export async function findSessionByCookieId(
  env: Bindings,
  cookieIdRaw: string,
): Promise<{ session: WebSessionRow; user: WebSessionUser } | null> {
  if (!cookieIdRaw) return null;
  const cookieHash = await hashCookieId(cookieIdRaw);
  // `u.status != 'revoked'` retires sessions for users an admin
  // revoked after the cookie was issued. Without it, a stale cookie
  // resolves to a valid login until the cookie expires or /auth/logout
  // lands.
  const row = await env.DB.prepare(
    `SELECT ws.id, ws.user_id, ws.remember, ws.expires_at, ws.last_used_at,
            u.email, u.role, u.status,
            u.given_name, u.family_name, u.orcid, u.orcid_verified,
            u.github_username, u.city, u.country, u.affiliation, u.service_access
       FROM web_sessions ws
       JOIN users u ON u.id = ws.user_id
      WHERE ws.cookie_id_hash = ?
        AND ws.revoked_at IS NULL
        AND ws.expires_at > datetime('now')
        AND u.status != 'revoked'
        AND u.deleted_at IS NULL
      LIMIT 1`,
  )
    .bind(cookieHash)
    .first<{
      id: number;
      user_id: number;
      remember: number;
      expires_at: string;
      last_used_at: string;
      email: string;
      role: string | null;
      status: string;
      given_name: string | null;
      family_name: string | null;
      orcid: string | null;
      // NOT NULL DEFAULT 0 in D1 (0050), so plain number.
      orcid_verified: number;
      github_username: string | null;
      city: string | null;
      country: string | null;
      affiliation: string | null;
      // NOT NULL DEFAULT 0 in D1 (0062), so plain number.
      service_access: number;
    }>();
  if (!row) return null;

  // Bump last_used_at on every hit. This is fire-and-forget — we don't
  // want to fail the request on a slow D1 write, and a stale
  // last_used_at is harmless for now (no SLA on it).
  env.DB.prepare(`UPDATE web_sessions SET last_used_at = datetime('now') WHERE id = ?`)
    .bind(row.id)
    .run()
    .catch((err) => console.error("[web-session] failed to bump last_used_at", err));

  return {
    session: {
      id: row.id,
      user_id: row.user_id,
      remember: row.remember === 1,
      expires_at: row.expires_at,
      last_used_at: row.last_used_at,
    },
    user: {
      id: row.user_id,
      email: row.email,
      role: parseRole(row.role, row.email),
      status: row.status,
      given_name: row.given_name,
      family_name: row.family_name,
      orcid: row.orcid,
      orcid_verified: row.orcid_verified === 1,
      github_username: row.github_username,
      city: row.city,
      country: row.country,
      affiliation: row.affiliation,
      service_access: row.service_access === 1,
    },
  };
}

/** How a session was established. Stored on `web_sessions.auth_method`
 *  (0050) so /auth/me and admin tooling can distinguish the flows. */
export type AuthMethod = "email_code" | "orcid";

/** Insert a new web_sessions row and return the row id + cookie
 *  options for the response. `cookieIdRaw` is returned to the caller
 *  so it can be set as the Set-Cookie value. */
export async function issueSession(
  env: Bindings,
  userId: number,
  remember: boolean,
  userAgent: string | null,
  ip: string | null,
  authMethod: AuthMethod = "email_code",
): Promise<{ cookieIdRaw: string; maxAgeSeconds: number | undefined; expiresAt: string }> {
  const cookieIdRaw = generateCookieId();
  const cookieIdHash = await hashCookieId(cookieIdRaw);
  const ttlMs = remember ? REMEMBER_TTL_MS : NON_REMEMBER_TTL_MS;
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();
  const ipHash = await hashIp(ip);

  await env.DB.prepare(
    `INSERT INTO web_sessions (
       user_id, cookie_id_hash, remember, expires_at, user_agent, ip_hash, auth_method
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(userId, cookieIdHash, remember ? 1 : 0, expiresAt, userAgent, ipHash, authMethod)
    .run();

  return {
    cookieIdRaw,
    // Browser-session cookies (no Max-Age) for non-remember; explicit
    // Max-Age for remember-me so reloads survive a browser restart.
    maxAgeSeconds: remember ? Math.floor(ttlMs / 1000) : undefined,
    expiresAt,
  };
}

/** Mark the row backing this cookie as revoked. Idempotent. */
export async function revokeSession(env: Bindings, cookieIdRaw: string | null): Promise<void> {
  if (!cookieIdRaw) return;
  const cookieHash = await hashCookieId(cookieIdRaw);
  await env.DB.prepare(
    `UPDATE web_sessions SET revoked_at = datetime('now')
      WHERE cookie_id_hash = ? AND revoked_at IS NULL`,
  )
    .bind(cookieHash)
    .run();
}

/** If a remember-me session is in the final ${SLIDING_REFRESH_THRESHOLD_MS}
 *  of its lifetime, extend it by REMEMBER_TTL_MS. Returns the new
 *  expires_at (and a fresh Max-Age the route can put in Set-Cookie),
 *  or null if no refresh was needed.
 */
export async function maybeSlideExpiry(
  env: Bindings,
  session: WebSessionRow,
): Promise<{ expiresAt: string; maxAgeSeconds: number } | null> {
  if (!session.remember) return null;
  const remaining = new Date(session.expires_at).getTime() - Date.now();
  if (remaining > SLIDING_REFRESH_THRESHOLD_MS) return null;
  const newExpiresAt = new Date(Date.now() + REMEMBER_TTL_MS).toISOString();
  await env.DB.prepare("UPDATE web_sessions SET expires_at = ? WHERE id = ?")
    .bind(newExpiresAt, session.id)
    .run();
  return { expiresAt: newExpiresAt, maxAgeSeconds: Math.floor(REMEMBER_TTL_MS / 1000) };
}
