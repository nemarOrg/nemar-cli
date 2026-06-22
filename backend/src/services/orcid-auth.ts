/**
 * ORCID OAuth 2.0 SSO helpers (#832).
 *
 * ORCID is a confidential authorization-code client. The browser-facing
 * redirects are reached through the same same-origin proxy the passwordless
 * flow uses (so the session cookie stays host-scoped to app.nemar.org), and
 * the code->token exchange runs here in the Worker with ORCID_CLIENT_SECRET.
 *
 * Scope is `/authenticate` only: ORCID's token response carries `orcid` (the
 * iD) and `name` directly in the JSON body, so there is no id_token to verify
 * and no Member API call needed. The TLS server-to-server exchange with our
 * client_secret is the trust anchor; we read orcid + name and discard the
 * access token (ORCID tokens live ~20 years -- nothing worth storing).
 *
 * No PKCE: ORCID deliberately does not support it (orcid/ORCID-Source#5977).
 * CSRF is the `state` param compared against the `nemar_oauth_state` cookie in
 * the callback route.
 *
 * The security-critical decisions (link outcome, discovered-vs-verified iD
 * reconciliation) live as pure functions here so they are unit-tested
 * independently of the HTTP plumbing in routes/auth-orcid.ts.
 */

import type { Bindings } from "../types/bindings";
import { constantTimeEqualHex } from "./auth-code";

export const ORCID_SCOPE = "/authenticate";
export const STATE_COOKIE_NAME = "nemar_oauth_state";
/** Pending-signup cookie for a brand-new ORCID with no NEMAR account yet
 *  (carries the verified iD + name across the email-collection step). */
export const PENDING_COOKIE_NAME = "nemar_orcid_pending";

/** ORCID iD canonical form: 4 groups of 4 digits, last char may be X (checksum). */
const ORCID_ID_RE = /^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/;

export function isValidOrcidId(value: string | null | undefined): value is string {
  return typeof value === "string" && ORCID_ID_RE.test(value);
}

/** Accept a bare iD or a full `https://orcid.org/<id>` URI; return the bare
 *  iD, or null if no well-formed iD is present. */
export function normalizeOrcidId(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const m = raw.trim().match(/(\d{4}-\d{4}-\d{4}-\d{3}[\dX])$/);
  return m ? m[1] : null;
}

export interface OrcidConfig {
  /** No trailing slash, e.g. https://orcid.org or https://sandbox.orcid.org */
  base: string;
  clientId: string;
  clientSecret: string;
}

/** Read ORCID config from env. Returns null when the client credentials are
 *  unset so the route can degrade to a clear "unavailable" redirect rather
 *  than a 500. Base defaults to the sandbox outside production. */
export function getOrcidConfig(env: Bindings): OrcidConfig | null {
  const clientId = env.ORCID_CLIENT_ID;
  const clientSecret = env.ORCID_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  const base =
    env.ORCID_API_BASE?.trim() ||
    (env.ENVIRONMENT === "production" ? "https://orcid.org" : "https://sandbox.orcid.org");
  return { base: base.replace(/\/+$/, ""), clientId, clientSecret };
}

export interface BuildAuthorizeUrlOptions {
  config: Pick<OrcidConfig, "base" | "clientId">;
  redirectUri: string;
  state: string;
  scope?: string;
}

export function buildAuthorizeUrl(o: BuildAuthorizeUrlOptions): string {
  const u = new URL(`${o.config.base}/oauth/authorize`);
  u.searchParams.set("client_id", o.config.clientId);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", o.scope ?? ORCID_SCOPE);
  u.searchParams.set("redirect_uri", o.redirectUri);
  u.searchParams.set("state", o.state);
  return u.toString();
}

export interface OrcidTokenResult {
  /** Validated bare iD. */
  orcid: string;
  /** ORCID may withhold the name; null when absent/blank. */
  name: string | null;
}

/** Exchange an authorization code for the ORCID token response and pull out
 *  `orcid` + `name`. The access token is intentionally discarded. Network is
 *  reached via `config.base`, so tests point that at a local Bun.serve. */
export async function exchangeCodeForOrcid(
  config: OrcidConfig,
  code: string,
  redirectUri: string,
  fetchFn: typeof fetch = fetch,
): Promise<OrcidTokenResult> {
  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
  });
  const res = await fetchFn(`${config.base}/oauth/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
  });
  if (!res.ok) {
    throw new Error(
      `ORCID token exchange -> HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`,
    );
  }
  const json = (await res.json()) as { orcid?: unknown; name?: unknown };
  const orcid = normalizeOrcidId(typeof json.orcid === "string" ? json.orcid : null);
  if (!orcid) {
    throw new Error(
      `ORCID token response missing or invalid \`orcid\`: ${JSON.stringify(json).slice(0, 200)}`,
    );
  }
  const name = typeof json.name === "string" && json.name.trim() ? json.name.trim() : null;
  return { orcid, name };
}

// ---------------------------------------------------------------------
// state cookie (CSRF + carried mode/next, kept server-side via the cookie
// so neither is exposed or tamperable in the redirect URL)
// ---------------------------------------------------------------------

export type OauthMode = "login" | "link";

export interface OauthState {
  csrf: string;
  mode: OauthMode;
  /** Same-origin relative path to land on after the flow. */
  next: string;
}

function b64urlEncode(s: string): string {
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function b64urlDecode(s: string): string {
  const pad = (s + "===".slice((s.length + 3) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  return atob(pad);
}

export function encodeState(s: OauthState): string {
  return b64urlEncode(JSON.stringify(s));
}

export function decodeState(raw: string | null | undefined): OauthState | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(b64urlDecode(raw)) as Partial<OauthState>;
    if (typeof parsed.csrf !== "string" || parsed.csrf.length === 0) return null;
    const mode: OauthMode = parsed.mode === "link" ? "link" : "login";
    const next = safeNextPath(typeof parsed.next === "string" ? parsed.next : "/");
    return { csrf: parsed.csrf, mode, next };
  } catch {
    return null;
  }
}

/** 256 bits of URL-safe randomness for the CSRF token. */
export function generateCsrf(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return b64urlEncode(String.fromCharCode(...bytes));
}

/** Reject open-redirect targets: only same-origin absolute paths survive.
 *  `//evil.com`, backslashes, CR/LF, and anything not starting with `/`
 *  collapse to `/`. */
export function safeNextPath(raw: string | null | undefined): string {
  if (!raw || typeof raw !== "string") return "/";
  if (raw.includes("\\") || raw.includes("\n") || raw.includes("\r")) return "/";
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return "/";
  }
  if (!decoded.startsWith("/") || decoded.startsWith("//")) return "/";
  if (decoded.includes("\\") || decoded.includes("\n") || decoded.includes("\r")) return "/";
  return raw;
}

// ---------------------------------------------------------------------
// pure decision helpers (security-critical; unit-tested directly)
// ---------------------------------------------------------------------

export type LinkOutcome = "already_linked" | "conflict" | "link_new";

/** Decide what happens when an authenticated user finishes an ORCID flow.
 *   - no existing identity            -> link it ("link_new")
 *   - identity already on this user   -> idempotent ("already_linked")
 *   - identity on a different user    -> refuse ("conflict"); one ORCID can
 *                                        only back one NEMAR account.
 */
export function decideLinkOutcome(
  existingIdentityUserId: number | null,
  currentUserId: number,
): LinkOutcome {
  if (existingIdentityUserId === null) return "link_new";
  if (existingIdentityUserId === currentUserId) return "already_linked";
  return "conflict";
}

export interface VerifiedFlagDecision {
  /** New value for users.orcid, or null to leave it unchanged. */
  setUsersOrcid: string | null;
  /** New value for users.orcid_verified. */
  orcidVerified: 0 | 1;
  /** True when the verified iD disagrees with an existing discovered value;
   *  the route logs this for admin reconciliation. */
  needsAdminReview: boolean;
}

/** Reconcile a freshly OAuth-verified iD against the citation-facing
 *  `users.orcid` (which may hold a DOI-*discovered* iD from enrichment).
 *   - users.orcid empty           -> adopt the verified iD, mark verified
 *   - users.orcid == verified iD  -> mark verified (they agree)
 *   - users.orcid != verified iD  -> keep the citation value, do NOT mark
 *                                    verified, flag for admin review. The
 *                                    real verified iD still lives in
 *                                    oauth_identities.provider_subject.
 */
export function decideVerifiedFlag(
  existingUsersOrcid: string | null | undefined,
  verifiedOrcid: string,
): VerifiedFlagDecision {
  const current = normalizeOrcidId(existingUsersOrcid ?? null);
  if (!current) {
    return { setUsersOrcid: verifiedOrcid, orcidVerified: 1, needsAdminReview: false };
  }
  if (current === verifiedOrcid) {
    return { setUsersOrcid: null, orcidVerified: 1, needsAdminReview: false };
  }
  return { setUsersOrcid: null, orcidVerified: 0, needsAdminReview: true };
}

// ---------------------------------------------------------------------
// public-record name lookup (#835)
//
// ORCID is the canonical source for a researcher's name. The /authenticate
// token body only carries the full `name`, not the given/family split, so to
// store structured names we read the public record (no client creds needed).
// ---------------------------------------------------------------------

/** Public ORCID API host for reading a record. No auth required. Mirrors the
 *  sandbox/prod split of the OAuth base. */
export function orcidPubBase(env: Bindings): string {
  const base =
    env.ORCID_API_BASE?.trim() ||
    (env.ENVIRONMENT === "production" ? "https://orcid.org" : "https://sandbox.orcid.org");
  return base.includes("sandbox") ? "https://pub.sandbox.orcid.org" : "https://pub.orcid.org";
}

export interface OrcidName {
  given: string | null;
  family: string | null;
}

/** Read the public given/family name for an ORCID iD. Best-effort: returns
 *  nulls when the record hides its name; throws only on a transport/HTTP error
 *  so callers can log and continue without a name. `pubBase` lets tests point
 *  at a local Bun.serve. */
export async function fetchOrcidName(
  orcid: string,
  pubBase: string,
  fetchFn: typeof fetch = fetch,
): Promise<OrcidName> {
  const res = await fetchFn(`${pubBase}/v3.0/${orcid}/personal-details`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`ORCID personal-details ${orcid} -> HTTP ${res.status}`);
  }
  const json = (await res.json()) as {
    name?: {
      "given-names"?: { value?: unknown } | null;
      "family-name"?: { value?: unknown } | null;
    } | null;
  };
  const name = json.name ?? null;
  const pick = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
  return {
    given: name ? pick(name["given-names"]?.value) : null,
    family: name ? pick(name["family-name"]?.value) : null,
  };
}

// ---------------------------------------------------------------------
// pending-signup token (brand-new ORCID, no NEMAR account yet)
//
// ORCID gives us a verified iD + name but no email, and users.email is
// NOT NULL, so the account cannot be created until the user supplies an
// email. We carry the verified iD across that email-collection step in an
// HMAC-signed, short-lived cookie rather than a DB row: the signature
// (keyed with ENCRYPTION_KEY) makes the iD unforgeable, and there is no
// orphan row to clean up if the user abandons the form.
// ---------------------------------------------------------------------

export interface PendingOrcid {
  orcid: string;
  name: string | null;
  /** Epoch ms after which the token is rejected. */
  exp: number;
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  const arr = new Uint8Array(sig);
  let out = "";
  for (let i = 0; i < arr.length; i++) out += arr[i].toString(16).padStart(2, "0");
  return out;
}

export async function signPending(p: PendingOrcid, secret: string): Promise<string> {
  const payload = b64urlEncode(JSON.stringify(p));
  const sig = await hmacHex(secret, payload);
  return `${payload}.${sig}`;
}

export async function verifyPending(
  token: string | null | undefined,
  secret: string,
  nowMs: number,
): Promise<PendingOrcid | null> {
  if (!token) return null;
  const dot = token.indexOf(".");
  if (dot < 1) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = await hmacHex(secret, payload);
  if (!constantTimeEqualHex(sig, expected)) return null;
  try {
    const p = JSON.parse(b64urlDecode(payload)) as Partial<PendingOrcid>;
    if (!isValidOrcidId(p.orcid) || typeof p.exp !== "number") return null;
    if (nowMs > p.exp) return null;
    return { orcid: p.orcid, name: typeof p.name === "string" ? p.name : null, exp: p.exp };
  } catch {
    return null;
  }
}
