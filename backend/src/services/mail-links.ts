/**
 * Signed unsubscribe links for community mail (epic #2260 phase 2, ADR 0132).
 *
 * A link is one path segment, `v1.<user id>.<category>.<broadcast id>.<signature>`, where
 *
 *   signature = base64url(HMAC-SHA256(MAIL_LINK_SECRET,
 *     "mail-unsubscribe\nv1\n<user id>\n<category>\n<broadcast id>\n<lowercased, trimmed address>"))
 *
 * The first line is a domain tag no other token kind uses (the pattern of `services/compute-tokens.ts`),
 * so a signature minted here answers for no other purpose and no other token answers here. The ADDRESS
 * is inside the signature and never in the URL: a link names whom it unsubscribes by id, and proves it
 * was minted for the address the account holds NOW. Changing the address, or deleting the account (the
 * tombstone masks the address), therefore ends every link sent to the old one with no extra code.
 *
 * WHAT A VALID LINK CAN DO is one thing: turn off the category it names (or, from the page's second
 * button, all three community categories). It cannot turn anything on, read another preference or show
 * more than a masked address. That is why it needs no session. It is NOT a credential: it is minted from
 * a server secret and an address, authenticates no request and opens no session, so it is not one of the
 * callers counted in `services/docs-auth.ts` or `services/private-auth.ts`, and a key revocation, a role
 * demotion or a sign-out deliberately leave it working (unsubscribing is always the person's right).
 *
 * A RECALL HAS NO LINK. The category set here is the three a person may turn off; the signer refuses
 * `recall` and the parser answers null for it, so no token for a recall exists to be verified.
 *
 * There is NO clock in a link (owner decision D5, 2026-11-20): it works while the account is live, the
 * address is unchanged and the broadcast row exists. Rotating the secret ends every link in every mailbox
 * at once, which is what `MAIL_LINK_SECRET_PREVIOUS` is for: during a rotation the old value keeps old
 * links verifying until the owner removes it.
 *
 * THE SECRET MUST BE SET, FOR BOTH SIDES. With `MAIL_LINK_SECRET` unset (or shorter than
 * {@link MIN_MAIL_LINK_SECRET_LENGTH}) the public routes refuse with 503, and a categorized send (a later
 * phase) must call {@link requireMailLinkSecret} before it queues anything and refuse the same way: a
 * message is never sent without the link that lets its reader stop receiving it, and never with a link the
 * routes could not honor.
 *
 * WHAT IS AND IS NOT KEPT OUT OF LOGS. Nothing here logs a token or an address, and the Worker's own logs
 * (`middleware/access-log.ts`, the rate limiter's lines) replace the token segment of the URL. That is the
 * whole claim: Cloudflare's own invocation logs (`wrangler-sccn.toml` observability, 100% sampling) record
 * the full request URL, token included, and this code cannot change that. App logs are redacted;
 * Cloudflare invocation logs keep the URL; a leaked token can only turn one category off (or, from the
 * page's second button, the three community categories) for one person, who can turn it back on in
 * settings. A recall has no link, so nothing in a log can silence one.
 */

import {
  type CommunityMailCategory,
  isCommunityMailCategory,
} from "../../../shared/contract/mail-categories.js";
import { timingSafeEqual } from "../lib/constant-time.js";
import type { Bindings } from "../types/bindings";

/** The first line of every unsubscribe message. Never shared with another token kind. */
export const MAIL_UNSUBSCRIBE_DOMAIN = "mail-unsubscribe";

/** The token's version segment, and the second line of the signed message. */
export const MAIL_LINK_VERSION = "v1";

/** A shorter secret is treated as unset: `openssl rand -hex 32` gives 64 characters. */
export const MIN_MAIL_LINK_SECRET_LENGTH = 32;

/** What a link is bound to, besides the address. */
export interface MailLinkClaims {
  userId: number;
  category: CommunityMailCategory;
  broadcastId: number;
}

/** The unsigned part of a parsed token, with the signature it carried. */
export interface ParsedMailLink {
  claims: MailLinkClaims;
  signature: string;
}

/** Thrown when a categorized send (or a signer) is asked to work without a usable secret. */
export class MailLinkSecretUnsetError extends Error {
  readonly code = "mail_link_secret_unset";
  constructor() {
    super("MAIL_LINK_SECRET is not set (or is too short); community mail cannot carry a link");
    this.name = "MailLinkSecretUnsetError";
  }
}

const usable = (value: string | undefined): string | null => {
  const trimmed = (value ?? "").trim();
  return trimmed.length >= MIN_MAIL_LINK_SECRET_LENGTH ? trimmed : null;
};

/**
 * The secrets a link may verify under, current first: `MAIL_LINK_SECRET`, then
 * `MAIL_LINK_SECRET_PREVIOUS` when set. Empty when the current secret is unset or too short, because
 * a previous secret alone is not a configuration (a rotation that dropped the new value would
 * otherwise keep minting nothing and verifying old links, silently).
 */
export function mailLinkSecrets(
  env: Pick<Bindings, "MAIL_LINK_SECRET" | "MAIL_LINK_SECRET_PREVIOUS">,
): string[] {
  const current = usable(env.MAIL_LINK_SECRET);
  if (!current) return [];
  const previous = usable(env.MAIL_LINK_SECRET_PREVIOUS);
  return previous && previous !== current ? [current, previous] : [current];
}

/** Log a configuration problem at most once per hour per isolate and kind. No secret material. */
const REPORT_WINDOW_MS = 60 * 60 * 1000;
const lastReported = new Map<string, number>();

function reportOnce(kind: string, message: string): void {
  const now = Date.now();
  const last = lastReported.get(kind);
  if (last !== undefined && now - last < REPORT_WINDOW_MS) return;
  lastReported.set(kind, now);
  console.error(message);
}

/** Forget what was reported, for tests. */
export function __resetMailLinkReportsForTests(): void {
  lastReported.clear();
}

/**
 * Say, in the Worker's log, what a person would otherwise only find out from a 503: the current secret is
 * unset or too short (every unsubscribe route refuses and no categorized send can go out), or the
 * previous secret is set but unusable (old links silently stop working). The message names the binding and
 * the rule, never a value or its length. Called by the routes and by every sender before it queues.
 */
export function reportMailLinkConfiguration(
  env: Pick<Bindings, "MAIL_LINK_SECRET" | "MAIL_LINK_SECRET_PREVIOUS">,
): void {
  if (!usable(env.MAIL_LINK_SECRET)) {
    reportOnce(
      "current",
      `[mail-links] MAIL_LINK_SECRET is unset or shorter than ${MIN_MAIL_LINK_SECRET_LENGTH} characters: unsubscribe links answer 503 and community mail cannot be sent`,
    );
  }
  const previous = (env.MAIL_LINK_SECRET_PREVIOUS ?? "").trim();
  if (previous !== "" && !usable(env.MAIL_LINK_SECRET_PREVIOUS)) {
    reportOnce(
      "previous",
      `[mail-links] MAIL_LINK_SECRET_PREVIOUS is set but shorter than ${MIN_MAIL_LINK_SECRET_LENGTH} characters and is ignored: links signed under it no longer verify`,
    );
  }
}

/**
 * The secret a link is SIGNED under, or a refusal. Called by every sender of community mail before it
 * queues a message (a later phase of the epic); the public routes answer 503 for the same condition.
 */
export function requireMailLinkSecret(
  env: Pick<Bindings, "MAIL_LINK_SECRET" | "MAIL_LINK_SECRET_PREVIOUS">,
): string {
  reportMailLinkConfiguration(env);
  const [current] = mailLinkSecrets(env);
  if (!current) throw new MailLinkSecretUnsetError();
  return current;
}

const SIGNATURE_RE = /^[A-Za-z0-9_-]{43}$/;
const TOKEN_RE = /^v1\.(\d{1,12})\.([a-z]{1,16})\.(\d{1,12})\.([A-Za-z0-9_-]{43})$/;

/** The address as it is signed: trimmed and lowercased. */
export const normalizeLinkAddress = (address: string): string => address.trim().toLowerCase();

function toBase64Url(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let binary = "";
  for (let i = 0; i < view.length; i++) binary += String.fromCharCode(view[i] as number);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The canonical, domain-tagged message, pinned so signer and verifier agree. */
export function encodeMailLinkPayload(claims: MailLinkClaims, address: string): string {
  return [
    MAIL_UNSUBSCRIBE_DOMAIN,
    MAIL_LINK_VERSION,
    String(claims.userId),
    claims.category,
    String(claims.broadcastId),
    normalizeLinkAddress(address),
  ].join("\n");
}

async function sign(claims: MailLinkClaims, address: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(encodeMailLinkPayload(claims, address)),
  );
  return toBase64Url(mac);
}

const isId = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n > 0;

/**
 * The token for one message to one account: `v1.<user id>.<category>.<broadcast id>.<signature>`.
 * Refuses a recall (or any category but the three), a bad id, an address with a line break (the
 * message is line-delimited), and a missing secret.
 */
export async function signMailLinkToken(
  claims: MailLinkClaims,
  address: string,
  secret: string,
): Promise<string> {
  if (!secret) throw new MailLinkSecretUnsetError();
  if (!isCommunityMailCategory(claims.category)) {
    throw new Error("signMailLinkToken: only a category a person may turn off has a link");
  }
  if (!isId(claims.userId) || !isId(claims.broadcastId)) {
    throw new Error("signMailLinkToken: ids must be positive integers");
  }
  if (/[\r\n]/.test(address) || normalizeLinkAddress(address) === "") {
    throw new Error("signMailLinkToken: the address is empty or holds a line break");
  }
  const signature = await sign(claims, address, secret);
  return `${MAIL_LINK_VERSION}.${claims.userId}.${claims.category}.${claims.broadcastId}.${signature}`;
}

/**
 * Parse a token strictly. Null for anything that is not exactly the format, including a recall and
 * any category outside the three (a regexp alone would accept `recall`, so the category is checked
 * against the table too), and for ids that overflow a safe integer.
 */
export function parseMailLinkToken(token: string): ParsedMailLink | null {
  if (typeof token !== "string" || token.length > 160) return null;
  const match = TOKEN_RE.exec(token);
  if (!match) return null;
  const [, rawUser, category, rawBroadcast, signature] = match;
  if (!isCommunityMailCategory(category) || !SIGNATURE_RE.test(signature as string)) return null;
  const userId = Number(rawUser);
  const broadcastId = Number(rawBroadcast);
  if (!isId(userId) || !isId(broadcastId)) return null;
  return { claims: { userId, category, broadcastId }, signature: signature as string };
}

/**
 * Whether `parsed` was signed for `address` under any of `secrets` (constant-time per comparison).
 * False when there is no secret, so an unconfigured Worker verifies nothing.
 */
export async function verifyMailLinkSignature(
  parsed: ParsedMailLink,
  address: string,
  secrets: readonly string[],
): Promise<boolean> {
  if (secrets.length === 0 || /[\r\n]/.test(address)) return false;
  for (const secret of secrets) {
    const expected = await sign(parsed.claims, address, secret);
    if (timingSafeEqual(parsed.signature, expected)) return true;
  }
  return false;
}

/** The full URL of a link, the one string used in the `List-Unsubscribe` header and the footer. */
export function mailUnsubscribeUrl(apiBaseUrl: string, token: string): string {
  return `${apiBaseUrl.replace(/\/+$/, "")}/mail/unsubscribe/${token}`;
}

/** `a***@example.org`: enough for a person to recognize the address, not to recover it. */
export function maskAddress(address: string): string {
  const at = address.lastIndexOf("@");
  if (at < 1) return "***";
  return `${address.slice(0, 1)}***${address.slice(at)}`;
}

/** What a verified link resolves to: the claims and the live account they were signed for. */
export interface ResolvedMailLink {
  claims: MailLinkClaims;
  user: { id: number; username: string | null; email: string; emailPreferences: string | null };
}

/** The answer of {@link resolveMailLink}: a refusal never says which check failed. */
export type MailLinkResolution =
  | { status: "ok"; link: ResolvedMailLink }
  | { status: "invalid" }
  | { status: "unconfigured" };

/**
 * Everything a route needs to act on a link, in the one order that makes every failure look alike:
 * a missing secret is its own answer (`unconfigured`, the route's 503); then the token is parsed, the
 * account read (`id = ? AND deleted_at IS NULL`) and the broadcast row read (`id = ? AND category = ?`),
 * and the signature is recomputed with the account's CURRENT address under the current secret and then
 * the previous one. A token that parses but names no live account still pays for one HMAC (over a
 * placeholder address) so the answer does not time a lookup. Parse failure, unknown or deleted account,
 * unknown broadcast, a category the broadcast was not sent under, a changed address, a wrong or rotated
 * secret and a tampered field are all `invalid`.
 */
export async function resolveMailLink(
  db: D1Database,
  env: Pick<Bindings, "MAIL_LINK_SECRET" | "MAIL_LINK_SECRET_PREVIOUS">,
  token: string,
): Promise<MailLinkResolution> {
  reportMailLinkConfiguration(env);
  const secrets = mailLinkSecrets(env);
  if (secrets.length === 0) return { status: "unconfigured" };
  const parsed = parseMailLinkToken(token);
  if (!parsed) return { status: "invalid" };
  const { claims } = parsed;

  const user = await db
    .prepare(
      "SELECT id, username, email, email_preferences FROM users WHERE id = ? AND deleted_at IS NULL",
    )
    .bind(claims.userId)
    .first<{
      id: number;
      username: string | null;
      email: string;
      email_preferences: string | null;
    }>();
  const broadcast = await db
    .prepare("SELECT 1 AS present FROM broadcast_emails WHERE id = ? AND category = ?")
    .bind(claims.broadcastId, claims.category)
    .first<{ present: number }>();

  const signed = await verifyMailLinkSignature(parsed, user?.email ?? "-", secrets);
  if (!user || !broadcast || !signed) return { status: "invalid" };
  return {
    status: "ok",
    link: {
      claims,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        emailPreferences: user.email_preferences,
      },
    },
  };
}
