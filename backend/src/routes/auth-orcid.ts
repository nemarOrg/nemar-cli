/**
 * ORCID SSO routes (#832), mounted under the same `/auth` prefix as the
 * passwordless flow in auth-web.ts.
 *
 *   GET  /auth/orcid/start                - set state cookie, 302 to ORCID authorize
 *   POST /auth/orcid/cli-start            - (token or cookie) mint a signed
 *                                           link/relink intent
 *   GET  /auth/orcid/cli-handoff          - name the account, ask the person
 *   POST /auth/orcid/cli-handoff/continue - their answer: cookie, then ORCID
 *   GET  /auth/orcid/callback             - verify state, exchange code, then
 *                                           sign in / link / collect an email
 *   POST /auth/orcid/finalize             - finish a new ORCID signup
 *   POST /auth/orcid/unlink               - (token or cookie) remove the link
 *
 * CLI parity (#1266, ADR 0044): ORCID stays a browser flow, because a consent
 * screen cannot be shown in a terminal. What the CLI gets is `cli-start`,
 * which mints the SAME intent the website's POST /orcid/start mints — signed
 * this time, and carrying the account id, because the browser that finishes
 * the flow holds no NEMAR session for the callback to read.
 *
 * Three things bound what that signed intent can do, because it is a bearer
 * capability for its ten minutes (PR #1269 review): the handoff SHOWS the
 * person which account it names before they go to ORCID, a session for a
 * DIFFERENT account is refused rather than overridden at both the handoff and
 * the callback (`orcid_intent_account_mismatch`), and the intent is single-use
 * -- a row in `orcid_link_intents` (migration 0078) the callback consumes.
 * Unlink needs no browser at all and takes a bearer token directly.
 *
 * Linking is initiated via `GET /auth/orcid/start?mode=link` and completed in
 * the same callback (the callback links to whichever user the session cookie
 * resolves to), so there is no separate `POST /auth/orcid/link` route in the
 * issue's sketch -- the callback covers it. Noted here so the divergence from
 * the issue's 4-route list is intentional, not an omission.
 *
 * Re-linking (#913): Settings' confirm step submits a form POST to
 * `/auth/orcid/start?mode=relink` — POST is the ONLY entry that can mint
 * relink intent, because it carries an Origin header the route verifies and
 * requires a live session (the same gate as /orcid/unlink). A GET with
 * mode=relink quietly degrades to login: a bare cross-site link rides the
 * victim's ambient cookies, and an unauthenticated GET must never be able
 * to arm an identity swap. The callback then swaps the linked identity when
 * the finished iD is unclaimed; without relink mode a second, different iD
 * is refused (`orcid_already_have`), as before.
 *
 * Identity uniqueness (#1254, ADR 0043): an iD backs at most one LIVE account,
 * and "backs" means `users.orcid` OR an `oauth_identities` row -- not just the
 * identity table, which is all this file checked before. Finalize, link and
 * relink all consult `findOrcidHolder`; unlink now clears `users.orcid` too,
 * so an unlinked account stops claiming an iD it can no longer prove. The
 * refusal codes are `orcid_in_use`, `orcid_already_linked`, `orcid_linked_other`
 * and `email_in_use` (shared/contract/identity.ts).
 *
 * Host/cookie model: these routes run on api.nemar.org but the browser reaches
 * them through the app.nemar.org same-origin proxy (like /auth/code/*), which
 * mirrors our Set-Cookie. Cookies therefore carry Domain=WEB_SESSION_COOKIE_DOMAIN
 * (app.nemar.org in prod) and the OAuth redirect_uri points at the app host.
 */

import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import { auditLogStatement } from "../db/audit-log";
import { timingSafeEqual } from "../lib/constant-time";
import { escapeHtml } from "../lib/escape";
import { authMiddleware, resolveActingAccount } from "../middleware/auth";
import { webSessionMiddleware } from "../middleware/webSession";
import { maskEmail } from "../services/auth-code";
import { issueEmailVerificationCode } from "../services/email-verification";
import {
  emailFieldSchema,
  findEmailHolder,
  findOrcidHolder,
  identityRefusal,
  isOrcidIdentityUniqueViolation,
  isUniqueViolationOn,
  normalizeEmail,
  normalizeOrcid,
} from "../services/identity";
import {
  CLI_STATE_TTL_MS,
  type CliOauthState,
  type OauthMode,
  type OauthState,
  PENDING_COOKIE_NAME,
  RELINK_DELETE_IDENTITY_SQL,
  RELINK_INSERT_IDENTITY_SQL,
  RELINK_UPDATE_USER_SQL,
  STATE_COOKIE_NAME,
  buildAuthorizeUrl,
  decideLinkOutcome,
  decideSecondOrcidOutcome,
  decideVerifiedFlag,
  decodeState,
  encodeState,
  exchangeCodeForOrcid,
  fetchOrcidName,
  generateCsrf,
  getOrcidConfig,
  orcidPubBase,
  relinkParams,
  safeNextPath,
  signCliState,
  signPending,
  verifyCliState,
  verifyPending,
} from "../services/orcid-auth";
import { profileRefusal } from "../services/profile";
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
  email: emailFieldSchema,
});

// Finalize a brand-new ORCID signup. Mirrors the CLI signup's required fields
// (#835): city/country are required for export-control screening, affiliation
// optional. Name comes from ORCID, never the form.
const finalizeSchema = z.object({
  email: emailFieldSchema,
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
  //
  // A concurrent link that wins the race throws here -- on
  // UNIQUE(provider, provider_subject), or since 0077 on `users.orcid`. The
  // CALLER is what turns that into a typed refusal (`orcid_in_use`); this
  // function only guarantees the batch is atomic. It used to say the caller
  // produced "a clean typed failure", which was not true: the callback's
  // catch-all mapped it to the generic `orcid_error` redirect.
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

/**
 * Swap the linked ORCID identity for an explicit relink (#913). One D1 batch
 * == one implicit transaction: the identity swap, the users reconcile, and
 * the audit row land together. Statement semantics (DELETE+INSERT rather
 * than UPDATE, users.orcid overwritten) are documented on the SQL constants
 * in orcid-auth.ts, where the behavioral test exercises them.
 */
async function relinkIdentity(
  env: Bindings,
  userId: number,
  fromOrcid: string,
  toOrcid: string,
  name: string | null,
): Promise<void> {
  const params = relinkParams(userId, toOrcid, name);
  await env.DB.batch([
    env.DB.prepare(RELINK_DELETE_IDENTITY_SQL).bind(...params.deleteIdentity),
    env.DB.prepare(RELINK_INSERT_IDENTITY_SQL).bind(...params.insertIdentity),
    env.DB.prepare(RELINK_UPDATE_USER_SQL).bind(...params.updateUser),
    auditLogStatement(env.DB, {
      userId,
      action: "orcid_relinked",
      resourceType: "user",
      resourceId: String(userId),
      details: JSON.stringify({ from: fromOrcid, to: toOrcid }),
    }),
  ]);
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

/**
 * Whether a write failed because another account claimed the iD in the moment
 * between the check and the write.
 *
 * Both spellings count: `users.orcid` (0077's partial unique index) and
 * `oauth_identities.provider_subject` (0050's). They are two constraints over
 * the same fact, and which one fires depends only on which statement of the
 * batch got there first, so a caller that handled one and not the other would
 * return a typed refusal or a generic 500 at random.
 */
function claimedByAnother(err: unknown): boolean {
  return isUniqueViolationOn(err, "orcid") || isOrcidIdentityUniqueViolation(err);
}

function clientIp(c: { req: { header: (k: string) => string | undefined } }): string | null {
  return (
    c.req.header("CF-Connecting-IP") ||
    c.req.header("X-Forwarded-For")?.split(",")[0]?.trim() ||
    null
  );
}

// ------------------------------- routes --------------------------------

/** Shared start body: mint the CSRF state cookie, bounce to ORCID authorize. */
function startOrcidFlow(c: { env: Bindings }, mode: OauthMode, next: string): Response {
  const frontend = appBase(c.env);
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
}

authOrcidRoutes.get("/orcid/start", (c) => {
  const url = new URL(c.req.url);
  const rawMode = url.searchParams.get("mode");
  // A GET can be forged by a bare cross-site link riding the victim's
  // ambient cookies, so it may never mint relink intent (#913). mode=relink
  // here degrades to login: for an account that already has a linked iD the
  // callback then refuses with orcid_already_have — the pre-#913 behavior.
  const mode: OauthMode = rawMode === "link" ? "link" : "login";
  return startOrcidFlow(c, mode, safeNextPath(url.searchParams.get("next")));
});

/**
 * POST variant (#913) — the only entry that can mint mode=relink. The
 * Settings confirm step submits a real form here, so the browser attaches
 * an Origin header; the same-origin check plus the session requirement make
 * relink intent unforgeable by a link click (the /orcid/unlink gate).
 * Without them, a crafted GET link plus an ambient ORCID session could
 * silently swap which iD backs the account — see PR #1051's review.
 */
authOrcidRoutes.post("/orcid/start", webSessionMiddleware, (c) => {
  const frontend = appBase(c.env);
  if (!isAllowedOrigin(c.req.header("Origin"))) {
    return c.json({ error: "Origin not allowed" }, 403);
  }
  if (!c.var.webUser) {
    return redirect(`${frontend}/login?error=session_required`);
  }
  const url = new URL(c.req.url);
  const rawMode = url.searchParams.get("mode");
  const mode: OauthMode = rawMode === "link" || rawMode === "relink" ? rawMode : "login";
  return startOrcidFlow(c, mode, safeNextPath(url.searchParams.get("next")));
});

/** Where the browser lands once a CLI-initiated link finishes. */
const CLI_LINK_LANDING = "/settings";

/** One wording for the two ways this deployment can lack ORCID (no client
 *  credentials, no signing key). Neither is anything the caller can act on. */
const ORCID_UNAVAILABLE_MESSAGE = "ORCID linking is unavailable";

const cliStartSchema = z.object({
  mode: z.enum(["link", "relink"]).optional(),
});

/**
 * The account a CLI intent names, as the interstitial shows it.
 *
 * Read from the DATABASE by id, never from anything the browser sent: the
 * point of the page is to let a person recognise (or fail to recognise) the
 * account before they hand ORCID their consent.
 */
interface IntentAccount {
  id: number;
  username: string | null;
  email: string;
}

/**
 * Load the account for a CLI intent AND check the nonce is still usable
 * (migration 0078). Null when the intent is spent, expired, or names an
 * account that is gone or revoked.
 *
 * Deliberately does NOT consume: the interstitial and its confirm step both
 * need to know the intent is live, and burning it before the browser has even
 * reached ORCID would make a mistyped password a dead end.
 */
async function loadUsableIntent(
  env: Bindings,
  state: CliOauthState,
): Promise<IntentAccount | null> {
  const row = await env.DB.prepare(
    `SELECT u.id, u.username, u.email
       FROM orcid_link_intents i
       JOIN users u ON u.id = i.user_id
      WHERE i.nonce = ?
        AND i.user_id = ?
        AND i.consumed_at IS NULL
        AND i.expires_at > datetime('now')
        AND u.deleted_at IS NULL
        AND u.status != 'revoked'
      LIMIT 1`,
  )
    .bind(state.nonce, state.userId)
    .first<IntentAccount>();
  return row ?? null;
}

/**
 * Consume a CLI intent, returning false when somebody already did.
 *
 * The conditional UPDATE is the mutual-exclusion gate: two completions of the
 * same URL race here and exactly one sees `changes = 1`. Called once the
 * callback knows which account it is acting for and before it writes anything,
 * so a refusal downstream still burns the intent -- one browser completion per
 * intent, whatever its outcome. The cost is that a failed link means re-running
 * the CLI command, which is what the CLI already tells people to do.
 */
async function consumeIntent(env: Bindings, state: CliOauthState): Promise<boolean> {
  const res = await env.DB.prepare(
    `UPDATE orcid_link_intents SET consumed_at = datetime('now')
      WHERE nonce = ? AND user_id = ? AND consumed_at IS NULL
        AND expires_at > datetime('now')`,
  )
    .bind(state.nonce, state.userId)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

/**
 * Whether a signed-in browser is signed in as somebody OTHER than the account
 * the intent names.
 *
 * The rule this expresses is "refuse, never override" (PR #1269 review). An
 * earlier draft let the signed intent silently win over the session, which is
 * correct about WHOSE intent it is and wrong about what to do with the
 * disagreement: the person is looking at a page that says one account while
 * their browser says another, and guessing between them is how an
 * account-linking CSRF stays invisible. A browser with no session is the
 * ordinary CLI case and proceeds.
 */
function sessionDisagreesWithIntent(
  webUser: { id: number } | undefined,
  state: CliOauthState,
): boolean {
  return webUser !== undefined && webUser.id !== state.userId;
}

const INTENT_MISMATCH_MESSAGE =
  "This link was created for another NEMAR account; sign out or open it in a browser where you are not signed in.";

/** Minimal, styleless HTML shell. No script of any kind. */
function intentPage(title: string, bodyHtml: string, status: 200 | 403 | 410): Response {
  return new Response(
    `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; max-width: 560px; margin: 48px auto; padding: 0 20px;">
${bodyHtml}
</body>
</html>`,
    {
      status,
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
    },
  );
}

/** The typed refusal page both handoff steps and the callback speak. */
function intentMismatchPage(): Response {
  return intentPage(
    "Wrong NEMAR account",
    `  <h1 style="color: #dc2626;">This link is for a different account</h1>
  <p>${escapeHtml(INTENT_MISMATCH_MESSAGE)}</p>
  <p style="color: #666; font-size: 14px;">Nothing has been changed. (orcid_intent_account_mismatch)</p>`,
    403,
  );
}

/**
 * Mint an ORCID link intent for the CALLER'S account and hand back a URL to
 * open in a browser (#1266, ADR 0044).
 *
 * ORCID stays a browser flow — there is no way to show a consent screen in a
 * terminal, and no version of this should ask for an ORCID password. What the
 * CLI gets is the intent, signed and short-lived, in a URL the person opens
 * themselves; the link is then completed by the ordinary callback.
 *
 * ADR 0022 survives intact: relink intent is minted ONLY here, by an
 * authenticated POST. A bearer token is a credential the browser never sends
 * on its own, so a link click cannot arm an identity swap. A COOKIE caller
 * still has to clear the same-origin gate `POST /orcid/start` applies, for
 * exactly the reason that route applies it.
 */
authOrcidRoutes.post(
  "/orcid/cli-start",
  authMiddleware,
  zValidator("json", cliStartSchema),
  async (c) => {
    if (c.get("authMethod") === "cookie" && !isAllowedOrigin(c.req.header("Origin"))) {
      return c.json({ error: "Origin not allowed" }, 403);
    }
    const user = c.get("user");
    if (!c.env.ENCRYPTION_KEY) {
      console.error("[auth-orcid] ENCRYPTION_KEY unset; cannot mint a CLI ORCID state");
      return c.json(profileRefusal("orcid_unavailable", ORCID_UNAVAILABLE_MESSAGE), 503);
    }
    if (!getOrcidConfig(c.env)) {
      // Checked at MINT time, not after the browser is open: a missing ORCID
      // client turns into "this deployment cannot link ORCID" in the terminal
      // rather than a stray error page at the end of a flow.
      return c.json(profileRefusal("orcid_unavailable", ORCID_UNAVAILABLE_MESSAGE), 503);
    }

    const mode = c.req.valid("json").mode ?? "link";
    if (mode === "link") {
      // A plain `link` on an account that already has an iD would spend the
      // whole browser round trip only to be refused by the callback with
      // `orcid_already_have`. Answer now, and name the command that does what
      // they meant.
      const mine = await c.env.DB.prepare(
        "SELECT provider_subject FROM oauth_identities WHERE user_id = ? AND provider = 'orcid' LIMIT 1",
      )
        .bind(user.id)
        .first<{ provider_subject: string }>();
      if (mine) {
        return c.json(
          {
            ...profileRefusal(
              "orcid_already_have",
              `This account is already linked to ORCID iD ${mine.provider_subject}. Replace it with 'nemar auth profile orcid relink', or remove it with 'nemar auth profile orcid unlink'.`,
            ),
            orcid: mine.provider_subject,
          },
          409,
        );
      }
    }

    const csrf = generateCsrf();
    const nonce = generateCsrf();
    const expiresAtMs = Date.now() + CLI_STATE_TTL_MS;

    // Opportunistic prune, so the table cannot outgrow one TTL window and
    // needs no cron (migration 0078). Best-effort: a failed prune is not a
    // reason to refuse somebody their link.
    await c.env.DB.prepare("DELETE FROM orcid_link_intents WHERE expires_at < datetime('now')")
      .run()
      .catch((err) => console.error("[auth-orcid] failed to prune expired link intents", err));

    // The row is what makes the intent single-use. Written BEFORE the token is
    // handed out: an intent the callback cannot find is refused, so a failed
    // insert must not produce a URL that would then work.
    await c.env.DB.prepare(
      `INSERT INTO orcid_link_intents (nonce, user_id, mode, expires_at)
       VALUES (?, ?, ?, ?)`,
    )
      .bind(nonce, user.id, mode, new Date(expiresAtMs).toISOString())
      .run();

    const token = await signCliState(
      {
        csrf,
        mode,
        userId: user.id,
        nonce,
        next: CLI_LINK_LANDING,
        exp: expiresAtMs,
      },
      c.env.ENCRYPTION_KEY,
    );

    return c.json({
      // Our own handoff, not ORCID's authorize URL directly: the handoff is
      // what puts the signed state in a cookie, so a leaked URL is not by
      // itself enough to finish the link from a different browser.
      authorize_url: `${appBase(c.env)}/auth/orcid/cli-handoff?t=${encodeURIComponent(token)}`,
      expires_in: Math.floor(CLI_STATE_TTL_MS / 1000),
      mode,
    });
  },
);

/**
 * Resolve the `t=` parameter (or form field) both handoff steps take.
 *
 * Returns the token, the verified state and the account it names, or the page
 * to answer with. Shared so the confirm step re-runs EVERY check the
 * interstitial ran -- a page that has already been rendered proves nothing
 * about the moment the form is submitted.
 */
async function resolveHandoffIntent(
  c: Context<{ Bindings: Bindings; Variables: Variables }>,
  token: string | null,
): Promise<
  | { ok: true; token: string; state: CliOauthState; account: IntentAccount }
  | { ok: false; res: Response }
> {
  const frontend = appBase(c.env);
  if (!c.env.ENCRYPTION_KEY) {
    console.error("[auth-orcid] ENCRYPTION_KEY unset; cannot verify a CLI ORCID state");
    return { ok: false, res: redirect(`${frontend}/login?error=orcid_unavailable`) };
  }
  const state = await verifyCliState(token, c.env.ENCRYPTION_KEY, Date.now());
  // Expired, tampered with, or simply not one of ours. Either way there is no
  // account to act for, so there is nothing to do but say so.
  if (!token || !state) return { ok: false, res: redirect(`${frontend}/login?error=orcid_state`) };

  // Refuse, never override (PR #1269 review): a browser signed in as somebody
  // else is a disagreement, not a preference to resolve.
  if (sessionDisagreesWithIntent(c.var.webUser, state)) {
    return { ok: false, res: intentMismatchPage() };
  }

  const account = await loadUsableIntent(c.env, state);
  if (!account) {
    // Already completed, expired out of the table, or the account is gone.
    // One page for all three: a person who used this link a minute ago and a
    // person handed a stale one both need the same next step.
    return {
      ok: false,
      res: intentPage(
        "This link is no longer usable",
        `  <h1>This link has already been used</h1>
  <p>An ORCID link can be opened once. Run <code>nemar auth profile orcid link</code> again to get a fresh one.</p>
  <p style="color: #666; font-size: 14px;">Nothing has been changed. (orcid_intent_used)</p>`,
        410,
      ),
    };
  }
  return { ok: true, token, state, account };
}

/**
 * Show the person WHOSE account is about to be linked, and make them press a
 * button (#1266, ADR 0044; PR #1269 review item A1).
 *
 * This GET mints nothing and, since the review, no longer redirects anywhere
 * either. It renders one sentence naming the target account and a form that
 * POSTs back. That sentence is the whole defence against the attack the signed
 * state cannot stop on its own: a signed intent is a bearer capability for ten
 * minutes, so somebody could mint one for THEIR account and send the URL to a
 * victim, who would otherwise complete ORCID consent and find their iD -- the
 * identifier a DOI cites (ADR 0041), and one that ADR 0043 then refuses them
 * on their own account -- attached to a stranger's row, having seen nothing
 * but an ORCID page they expected to see.
 *
 * No script, and deliberately no auto-submit: a page that submits itself is
 * the redirect this replaced, with extra steps.
 */
authOrcidRoutes.get("/orcid/cli-handoff", webSessionMiddleware, async (c) => {
  const resolved = await resolveHandoffIntent(c, new URL(c.req.url).searchParams.get("t"));
  if (!resolved.ok) return resolved.res;
  const { token, state, account } = resolved;

  const who = account.username
    ? `${escapeHtml(account.username)} (${escapeHtml(maskEmail(account.email))})`
    : escapeHtml(maskEmail(account.email));
  const verb = state.mode === "relink" ? "Replace the ORCID iD on" : "Link your ORCID iD to";

  return intentPage(
    "Confirm your NEMAR account",
    `  <h1>${escapeHtml(verb)} this NEMAR account?</h1>
  <p style="font-size: 18px;"><strong>${who}</strong></p>
  <p>You started this from <code>nemar auth profile orcid ${escapeHtml(state.mode)}</code> in a terminal.
     Continuing takes you to ORCID to sign in; the iD you sign in with is attached to the account above.</p>
  <p style="background-color: #fef2f2; border-left: 4px solid #dc2626; padding: 12px 16px;">
    <strong>If this is not your account, close this tab.</strong>
    Do not continue with a link somebody else sent you: it would attach your ORCID iD to their NEMAR account.
  </p>
  <form method="POST" action="/auth/orcid/cli-handoff/continue">
    <input type="hidden" name="t" value="${escapeHtml(token)}">
    <button type="submit" style="font-size: 16px; padding: 10px 20px; background-color: #2563eb; color: #fff; border: 0; border-radius: 6px; cursor: pointer;">
      Continue to ORCID
    </button>
  </form>`,
    200,
  );
});

/**
 * The confirm step of the interstitial: set the state cookie and go to ORCID.
 *
 * Every check the GET ran is run again here, because the GET proves nothing
 * about this moment -- the intent may have been consumed in another tab, and
 * the session may have changed. The same-origin gate is what keeps this from
 * being the redirect it replaced: without it, a page anywhere could auto-POST
 * a crafted intent and the person would never see whose account it names.
 */
authOrcidRoutes.post("/orcid/cli-handoff/continue", webSessionMiddleware, async (c) => {
  if (!isAllowedOrigin(c.req.header("Origin"))) {
    return c.json({ error: "Origin not allowed" }, 403);
  }
  const form = await c.req.formData().catch(() => null);
  const submitted = form?.get("t");
  const resolved = await resolveHandoffIntent(
    c,
    typeof submitted === "string" && submitted.length > 0 ? submitted : null,
  );
  if (!resolved.ok) return resolved.res;
  const { token, state } = resolved;

  const frontend = appBase(c.env);
  const config = getOrcidConfig(c.env);
  if (!config) return redirect(`${frontend}/login?error=orcid_unavailable`);

  const stateCookie = buildCookie(STATE_COOKIE_NAME, token, {
    domain: cookieDomain(c.env),
    maxAgeSeconds: Math.floor(CLI_STATE_TTL_MS / 1000),
  });
  const authorizeUrl = buildAuthorizeUrl({
    config,
    redirectUri: `${frontend}/auth/orcid/callback`,
    state: state.csrf,
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

  // Two state shapes reach this cookie, and the SIGNED one is tried first
  // (#1266, ADR 0044). A CLI-minted state names the account it was minted for
  // inside an HMAC the browser cannot forge; the website's plain state cookie
  // names no account at all and never can, which is what keeps a forged
  // cookie from linking an iD to somebody else's row. Everything downstream —
  // the csrf compare, the mode, the landing path — reads the same three
  // fields either way.
  const stateCookieRaw = parseCookieHeader(c.req.header("Cookie"), STATE_COOKIE_NAME);
  const cliState = c.env.ENCRYPTION_KEY
    ? await verifyCliState(stateCookieRaw, c.env.ENCRYPTION_KEY, Date.now())
    : null;
  const state: OauthState | null = cliState
    ? { csrf: cliState.csrf, mode: cliState.mode, next: cliState.next }
    : decodeState(stateCookieRaw);
  const stateParam = url.searchParams.get("state");
  if (!state || !stateParam || !timingSafeEqual(stateParam, state.csrf)) {
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

    // WHICH account the finished iD attaches to.
    //
    // A CLI-minted state answers it on its own (#1266): the browser that
    // finishes the flow was opened from a terminal and carries no NEMAR
    // session, so the id inside the signed state is the only account in play.
    // `loadActiveUser` re-checks the row is still live and not revoked, since
    // the intent was minted up to ten minutes ago.
    //
    // A session for a DIFFERENT account is refused rather than overridden (PR
    // #1269 review). The handoff already refused it once; this is the same
    // rule at the other end, because the two steps are minutes apart and a
    // browser can sign in between them.
    let actingUserId: number | null = null;
    if (cliState) {
      if (sessionDisagreesWithIntent(c.var.webUser, cliState)) {
        return fail("orcid_intent_account_mismatch", state.next);
      }
      const cliUser = await loadActiveUser(c.env, cliState.userId);
      if (!cliUser) return fail("orcid_account", state.next);
      // Consume before anything is written: one browser completion per intent,
      // whatever its outcome. A replay of the same URL loses this race and is
      // refused here, with nothing linked.
      if (!(await consumeIntent(c.env, cliState))) {
        return fail("orcid_intent_used", state.next);
      }
      actingUserId = cliUser.id;
    } else if (c.var.webUser) {
      actingUserId = c.var.webUser.id;
    }

    // An already-authenticated session (or a CLI intent) => link to that user
    // (regardless of the start mode, so a logged-in user can never
    // accidentally spawn a duplicate account). The default landing is the
    // carried `next` (the onboarding gate passes /welcome).
    if (actingUserId !== null) {
      const outcome = decideLinkOutcome(ident?.user_id ?? null, actingUserId);
      if (outcome === "conflict") return fail("orcid_linked_other", state.next);
      if (outcome === "already_linked") {
        await touchIdentityLogin(c.env, orcid);
        afterResponse(c, refreshUserName(c.env, actingUserId, orcid));
        return redirect(`${frontend}${state.next}`, [clearState]);
      }
      // link_new says only that no oauth_identities row claims the iD. That
      // is not the same as unclaimed (#1254, ADR 0043): a row whose identity
      // row was removed while `users.orcid` stayed behind still holds the iD
      // for citation and for `nemar admin duplicates`, and linking over it is
      // how one person ends up backing two accounts (production rows 42/43).
      // Checked here rather than inside the relink branch so it covers both a
      // first link and an explicit relink -- both write `users.orcid`.
      const orcidHolder = await findOrcidHolder(c.env.DB, orcid, actingUserId);
      if (orcidHolder) return fail("orcid_in_use", state.next);

      // If this account already has a *different* iD, only an explicit relink
      // flow may swap it (#913); any other mode keeps the historical refusal.
      const mine = await c.env.DB.prepare(
        "SELECT provider_subject FROM oauth_identities WHERE user_id = ? AND provider = 'orcid' LIMIT 1",
      )
        .bind(actingUserId)
        .first<{ provider_subject: string }>();
      if (mine && mine.provider_subject !== orcid) {
        if (decideSecondOrcidOutcome(state.mode) === "refuse") {
          return fail("orcid_already_have", state.next);
        }
        try {
          await relinkIdentity(c.env, actingUserId, mine.provider_subject, orcid, name);
        } catch (err) {
          if (claimedByAnother(err)) return fail("orcid_in_use", state.next);
          throw err;
        }
        afterResponse(c, refreshUserName(c.env, actingUserId, orcid));
        return redirect(`${frontend}${state.next}`, [clearState]);
      }
      try {
        await linkIdentity(c.env, actingUserId, orcid, name);
      } catch (err) {
        if (claimedByAnother(err)) return fail("orcid_in_use", state.next);
        throw err;
      }
      afterResponse(c, refreshUserName(c.env, actingUserId, orcid));
      return redirect(`${frontend}${state.next}`, [clearState]);
    }

    // No session, but a relink intent in the state: the session that minted
    // it (POST /orcid/start) expired during the ORCID roundtrip. Refuse
    // loudly rather than degrading into sign-in/signup — silently signing
    // the browser into whichever account owns the finished iD would discard
    // the user's "fix MY account's link" intent (#913 review).
    if (state.mode === "relink") {
      return fail("orcid_relink_session");
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
    // Carry state.next so an authenticated user who started from Settings
    // lands back there with the error, not on /login while signed in.
    return fail("orcid_error", state.next);
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

    const { affiliation, city, country } = c.req.valid("json");
    // The Zod field already trims and lowercases; re-normalising here is what
    // makes the rule the SCHEMA's rather than this route's, so a future schema
    // change cannot quietly store a mixed-case address (ADR 0043).
    const email = normalizeEmail(c.req.valid("json").email);
    // Unreachable as a repair, and kept as a guarantee: `verifyPending`
    // already rejects a token whose iD is not in canonical form, so this
    // cannot fire for a cookie the callback minted. What it buys is that the
    // value this route STORES is canonical by construction rather than by
    // trusting an upstream check to stay where it is.
    const orcid = normalizeOrcid(pending.orcid);
    if (!orcid) {
      console.error(`[auth-orcid] finalize: pending token carried a malformed iD ${pending.orcid}`);
      c.header("Set-Cookie", clearPending);
      return c.json({ error: "orcid_pending_expired" }, 401);
    }

    // Email collision: never auto-link onto an existing account (takeover
    // vector). Make the user sign in with their existing method, then link
    // ORCID from settings. Case-insensitive since #1254: `Ada@Lab.org` and
    // `ada@lab.org` are one person, and storing both is one of the two ways
    // this catalog grew duplicate accounts.
    const emailHolder = await findEmailHolder(c.env.DB, email);
    if (emailHolder) {
      return c.json({ error: "email_in_use", ...identityRefusal("email_in_use") }, 409);
    }

    // The iD may already back an account through `users.orcid` even with no
    // oauth_identities row -- an unlink, or an identity insert whose rollback
    // did not run, leaves exactly that shape, and it is why production rows 42
    // and 43 both carry 0000-0002-1974-1293. Checking only the identity table
    // (all this route did before #1254) is what let the second sign-up
    // through. The two codes are kept apart because `orcid_already_linked` is
    // the pre-existing one the website already handles; they mean the same
    // thing to the person reading them and carry the same message.
    const orcidHolder = await findOrcidHolder(c.env.DB, orcid);
    if (orcidHolder) {
      const identExists = await c.env.DB.prepare(
        "SELECT user_id FROM oauth_identities WHERE provider = 'orcid' AND provider_subject = ? LIMIT 1",
      )
        .bind(orcid)
        .first<{ user_id: number }>();
      const code = identExists ? "orcid_already_linked" : "orcid_in_use";
      c.header("Set-Cookie", clearPending);
      return c.json({ error: code, ...identityRefusal(code) }, 409);
    }

    // New web account: username/github_username/password_hash stay NULL
    // (allowed since 0026); name lives on the identity row.
    //
    // ADR 0040: this lands at `pending`, and NOTHING here auto-approves.
    // ORCID proves the person; the email is collected, not verified, and the
    // base tier needs both — every notification, the sign-in code and the
    // upload-request thread go to that address. `email_verified` stays 0
    // until the code mailed below is redeemed, at which point the account
    // becomes `verified` (the base tier: browse, dashboard, settings). The
    // upload grant, `service_access`, has exactly one writer and it is admin
    // approval (phase 1) — never this route, which is why `approved_at` is
    // NULL rather than a sign-up timestamp.
    // A concurrent sign-up can claim either identifier between the checks
    // above and this INSERT, and 0077's partial unique indexes are what stop
    // the second row. Map that to the SAME typed refusal the checks return:
    // the loser of a race is in exactly the situation the pre-check describes,
    // and a generic 500 "Sign-up failed" tells them nothing and invites a
    // retry that will fail identically.
    let insert: D1Result;
    try {
      insert = await c.env.DB.prepare(
        `INSERT INTO users (email, orcid, orcid_verified, status, email_verified, signup_source,
           affiliation, city, country, approved_at, service_access)
         VALUES (?, ?, 1, 'pending', 0, 'web', ?, ?, ?, NULL, 0)`,
      )
        .bind(email, orcid, affiliation || null, city, country)
        .run();
    } catch (insertErr) {
      if (isUniqueViolationOn(insertErr, "email")) {
        c.header("Set-Cookie", clearPending);
        return c.json({ error: "email_in_use", ...identityRefusal("email_in_use") }, 409);
      }
      if (isUniqueViolationOn(insertErr, "orcid")) {
        c.header("Set-Cookie", clearPending);
        return c.json({ error: "orcid_in_use", ...identityRefusal("orcid_in_use") }, 409);
      }
      throw insertErr;
    }
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
        .bind(userId, orcid, pending.name)
        .run();
    } catch (identErr) {
      // The users row has already committed, so it MUST be removed either way
      // -- an account with an email and no usable ORCID login is a dead end
      // the user cannot fix. What differs is what we then tell them.
      await c.env.DB.prepare("DELETE FROM users WHERE id = ?")
        .bind(userId)
        .run()
        .catch((delErr) =>
          console.error("[auth-orcid] finalize: failed to roll back orphan user", delErr),
        );
      c.header("Set-Cookie", clearPending);

      // ONLY the identity UNIQUE means somebody else claimed the iD. Reporting
      // `orcid_already_linked` for any failure -- a D1 outage, a schema error
      // -- sends the user to go unlink an iD from an account that does not
      // exist, and hides the real fault behind a 409 nobody investigates.
      if (isOrcidIdentityUniqueViolation(identErr)) {
        console.error(
          `[auth-orcid] finalize: iD ${orcid} was claimed concurrently; rolled the user row back`,
        );
        return c.json(
          { error: "orcid_already_linked", ...identityRefusal("orcid_already_linked") },
          409,
        );
      }
      console.error(
        "[auth-orcid] finalize: identity insert failed for a NON-uniqueness reason; rolled the user row back",
        identErr,
      );
      return c.json({ error: "Sign-up failed" }, 500);
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
    afterResponse(c, refreshUserName(c.env, userId, orcid));

    // Mail the first verification code to the address just collected. The
    // account exists and is signed in either way: an undeliverable code
    // leaves a `pending` account that can ask for another from the dashboard
    // (POST /auth/email/verify/request), which is a far better outcome than
    // 500ing a sign-up whose user row and ORCID identity have already
    // committed. `code_sent` tells the website whether to say "we've sent you
    // a code" or offer the resend button immediately.
    const issued = await issueEmailVerificationCode(c.env, userId, email);
    if (!issued.ok) {
      console.error(`[auth-orcid] finalize: verification code not sent (${issued.error})`);
    }

    // status "pending" mirrors userStatusForDashboard('pending') used by
    // /auth/me: the dashboard renders its verify-your-email step from it
    // (ADR 0040). It becomes "active" once that code is redeemed.
    //
    // `code_sent` is false when the non-production fence skipped the send, not
    // just when one failed -- a dev sign-up that reports "check your inbox"
    // for mail that was deliberately never sent is the same dead end as one
    // that reports it for mail that bounced.
    const body: Record<string, unknown> = {
      user: { id: userId, email, role: "member", status: "pending" },
      code_sent: issued.ok && !issued.skipped,
    };
    if (issued.ok && issued.skipped) body.dev_skip = "not_allowlisted";
    if (issued.ok && issued.devCode) body.dev_code = issued.devCode;
    // Same belt-and-braces as the auth-web code routes: a misconfigured
    // ENVIRONMENT must turn a leak into a 500, not ship the code.
    if (c.env.ENVIRONMENT === "production" && "dev_code" in body) {
      console.error(
        "[auth-orcid] FATAL: dev_code present in production response — refusing to ship the response",
      );
      return c.json({ error: "Sign-up failed" }, 500);
    }
    return c.json(body);
  } catch (err) {
    console.error("[auth-orcid] finalize failed", err);
    c.header("Set-Cookie", clearPending);
    return c.json({ error: "Sign-up failed" }, 500);
  }
});

authOrcidRoutes.post("/orcid/unlink", webSessionMiddleware, async (c) => {
  // Cookie or bearer token (#1266, ADR 0044). Unlink is the one ORCID
  // operation with no browser step in it -- nothing to consent to, nothing to
  // redirect through -- so the CLI calls it directly. The same-origin gate
  // still applies to the cookie half; see `resolveActingAccount`.
  const resolved = await resolveActingAccount(c);
  if (!resolved.ok) return resolved.response;
  const actor = resolved.actor;

  // Drop the link COMPLETELY: the identity row, `orcid_verified`, AND
  // `users.orcid` (#1254, ADR 0043).
  //
  // Keeping `users.orcid` used to be the deliberate choice -- it is the
  // citation-facing value, and dropping it loses whatever a DOI-discovery pass
  // had attached to the account. That reasoning does not survive the shape it
  // produces: a row that still claims an iD it can no longer sign in with,
  // which is invisible to every check that looked at `oauth_identities`, and
  // which silently blocks (or, before this phase, silently duplicated) the
  // person's next sign-up. Production rows 42/43 are that shape.
  //
  // The citation value is RE-DERIVABLE and the identity is not: linking the iD
  // again refills `users.orcid` (`linkIdentity`), and so does the DOI
  // enrichment pass that discovered it in the first place. Losing a
  // re-derivable column beats keeping a claim on an identifier the account
  // cannot prove.
  //
  // Email-code login still works, so removing the only OAuth identity never
  // locks the account out. The writes go in one D1 batch so we never leave
  // orcid_verified=1 with the identity row already gone (or vice versa).
  try {
    await c.env.DB.batch([
      c.env.DB.prepare(
        "DELETE FROM oauth_identities WHERE user_id = ? AND provider = 'orcid'",
      ).bind(actor.id),
      c.env.DB.prepare("UPDATE users SET orcid = NULL, orcid_verified = 0 WHERE id = ?").bind(
        actor.id,
      ),
    ]);
  } catch (err) {
    console.error("[auth-orcid] unlink failed", err);
    return c.json({ error: "Unlink failed" }, 500);
  }
  return c.json({ ok: true });
});
