/**
 * Docs admin gate routes (epic #1336 phase 0, issue #1338), mounted under the
 * same `/auth` prefix as the other auth families.
 *
 *   POST /auth/docs/grant    - website (session): mint a one-time code
 *   POST /auth/docs/exchange - docs Pages Function: trade it for a cookie
 *   GET  /auth/docs/verify   - docs Pages Function: check that cookie
 *
 * WHY THIS EXISTS. `docs.nemar.org/admin/*` answered 200 to anyone. The
 * Cloudflare Access app the docs repo described covers that Pages project's
 * PREVIEW deployments only, never production. The gate is now this: NEMAR's own
 * ORCID-backed session, so `users.role` remains the single source of truth for
 * who is an admin rather than an allowlist maintained in a second place.
 *
 * WHY A HANDOFF RATHER THAN A SHARED COOKIE. The web session cookie is scoped
 * `Domain=app.nemar.org` deliberately, so it never attaches to
 * `data.nemar.org` byte-range fetches or `api.nemar.org` search. A cookie
 * scoped to one host cannot authenticate another, and widening it to
 * `.nemar.org` would undo the reason for the scope. So the docs host gets a
 * credential of its own, obtained once through a code that dies in sixty
 * seconds.
 *
 * `grant` is the only route here that a browser reaches, and only via the
 * website's server-side render. `exchange` and `verify` are server-to-server
 * calls from a Cloudflare Pages Function, which is why neither reads a cookie:
 * `exchange` takes the code in a body and `verify` takes the session value in a
 * header. Nothing in this file sets a cookie, because nothing in this file can:
 * only a response from the docs host itself can set a cookie for that host.
 */

import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import {
  DOCS_ADMIN_ROLES,
  DOCS_AUTH_MESSAGES,
  DOCS_GRANT_TTL_SECONDS,
  DOCS_SESSION_HEADER,
  DOCS_SESSION_TTL_SECONDS,
  type DocsExchangeResponse,
  type DocsGrantResponse,
  type DocsVerifyResponse,
} from "../../../shared/contract/docs-auth.js";
import { webSessionMiddleware } from "../middleware/webSession";
import {
  DOCS_GRANT_INSERT_SQL,
  DOCS_GRANT_PRUNE_SQL,
  DOCS_MINT_CONSUME_SQL,
  DOCS_MINT_INSERT_SQL,
  generateGrantCode,
  hashGrantCode,
} from "../services/docs-auth";
import {
  clientIp,
  findSessionByCookieId,
  generateCookieId,
  hashCookieId,
  hashIp,
  isAllowedOrigin,
} from "../services/web-session";
import type { Bindings, Variables } from "../types/bindings";

export const authDocsRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

/** Every response here carries a credential or a refusal about one, so none of
 *  it may sit in a shared cache. */
const NO_STORE = { "Cache-Control": "no-store" } as const;

function isDocsAdmin(role: string | null | undefined): boolean {
  return !!role && (DOCS_ADMIN_ROLES as readonly string[]).includes(role);
}

/**
 * Mint a one-time code for the caller's own account.
 *
 * Reached only by the website's authorize page, server-side, forwarding the
 * visitor's session cookie. A signed-in non-admin gets 404 rather than 403,
 * mirroring `adminGate` on the website: someone who does not already know the
 * operations documentation exists should not learn it from a status code.
 */
authDocsRoutes.post("/docs/grant", webSessionMiddleware, async (c) => {
  // Origin first, before authentication, exactly as `/auth/logout` and every
  // other cookie-authenticated mutation in this tree does. `isAllowedOrigin`
  // refuses a MISSING Origin too, which is deliberate and worth knowing when
  // writing the caller: a server-side fetch sends no Origin of its own, so the
  // website's authorize page has to pin one (it uses its own request origin, so
  // staging's test.nemar.org passes the *.nemar.org rule rather than being
  // hardcoded). Without this check the route would be a cross-site POST that
  // mints a code using someone's ambient cookie.
  if (!isAllowedOrigin(c.req.header("Origin"))) {
    return c.json({ error: "Origin not allowed" }, 403, NO_STORE);
  }

  const user = c.var.webUser;
  const session = c.var.webSession;
  if (!user || !session) {
    return c.json(
      { error: "unauthenticated", message: DOCS_AUTH_MESSAGES.unauthenticated },
      401,
      NO_STORE,
    );
  }
  if (!isDocsAdmin(user.role)) {
    // Byte-identical to what `api.notFound` builds for an unrouted path, headers
    // included. A distinct body or a stray `Cache-Control` would tell a signed-in
    // non-admin that this route exists, which is the single inference answering
    // 404 instead of 403 was chosen to prevent.
    return c.json(
      { error: "Not Found", message: `Route ${c.req.method} ${c.req.path} not found` },
      404,
    );
  }

  const code = generateGrantCode();
  const codeHash = await hashGrantCode(code);

  // The prune rides along on the same batch rather than getting its own round
  // trip. It is opportunistic housekeeping, so it must never be the reason this
  // route fails: if it were separate and threw, an admin would be locked out by
  // a cleanup problem.
  const results = await c.env.DB.batch([
    c.env.DB.prepare(DOCS_GRANT_PRUNE_SQL),
    c.env.DB.prepare(DOCS_GRANT_INSERT_SQL).bind(codeHash, DOCS_GRANT_TTL_SECONDS, session.id),
  ]);

  // Zero rows means the app session stopped being live between the middleware's
  // lookup and this write. Rare, and the honest answer is the same one a
  // missing cookie gets.
  if ((results[1]?.meta?.changes ?? 0) === 0) {
    return c.json(
      { error: "unauthenticated", message: DOCS_AUTH_MESSAGES.unauthenticated },
      401,
      NO_STORE,
    );
  }

  const body: DocsGrantResponse = { code, expires_in: DOCS_GRANT_TTL_SECONDS };
  return c.json(body, 200, NO_STORE);
});

/**
 * Trade a one-time code for a docs session value.
 *
 * Unauthenticated by design: whoever holds the code is the only party that can
 * spend it, and it lives sixty seconds. The mint re-checks role and account
 * status inside the inserting statement, so this route's own job is small --
 * hash the code, run the batch, and report whether anything was created.
 */
authDocsRoutes.post(
  "/docs/exchange",
  zValidator("json", z.object({ code: z.string().min(1).max(256) })),
  async (c) => {
    const { code } = c.req.valid("json");
    const codeHash = await hashGrantCode(code);
    const cookieIdRaw = generateCookieId();
    const cookieIdHash = await hashCookieId(cookieIdRaw);

    // These two describe the docs edge that called us, NOT the person's
    // browser: a Pages Function's own fetch is what Cloudflare reports here.
    // Recorded anyway, and labelled, because a diagnostic field that says where
    // the request really came from beats one populated from a client-supplied
    // header we would have to trust. The Function does forward the visitor's
    // User-Agent, which is client-supplied wherever it is read.
    const userAgent = c.req.header("User-Agent") ?? null;
    const ipHash = await hashIp(clientIp(c));

    const results = await c.env.DB.batch([
      c.env.DB.prepare(DOCS_MINT_INSERT_SQL).bind(
        cookieIdHash,
        DOCS_SESSION_TTL_SECONDS,
        userAgent,
        ipHash,
        codeHash,
      ),
      c.env.DB.prepare(DOCS_MINT_CONSUME_SQL).bind(codeHash, cookieIdHash),
    ]);

    if ((results[0]?.meta?.changes ?? 0) === 0) {
      // One answer for a code that never existed, one already spent, and one
      // whose account is no longer an admin. Splitting them would tell a caller
      // holding a stolen code which kind of dead end it is.
      return c.json(
        { error: "invalid_grant", message: DOCS_AUTH_MESSAGES.invalid_grant },
        400,
        NO_STORE,
      );
    }

    // Read the session back through the same function every later request uses,
    // so the username in this response cannot disagree with what `verify` will
    // report for the very same cookie.
    const found = await findSessionByCookieId(c.env, cookieIdRaw, "docs");
    const responseBody: DocsExchangeResponse = {
      session: cookieIdRaw,
      max_age_seconds: DOCS_SESSION_TTL_SECONDS,
      username: found?.user.username ?? null,
    };
    return c.json(responseBody, 200, NO_STORE);
  },
);

/**
 * Check a docs session value. Called by the Pages Function on every gated
 * request.
 *
 * Deliberately re-reads role on each call rather than trusting the session's
 * existence: revoking an admin has to take effect on the next page view, not
 * eight hours later. `findSessionByCookieId` already refuses a revoked session,
 * an expired one, a revoked account and a deleted one, and passing `"docs"`
 * makes it refuse an APP cookie presented here -- the privilege crossing this
 * gate would otherwise have opened, since both scopes live in one table.
 */
authDocsRoutes.get("/docs/verify", async (c) => {
  const presented = c.req.header(DOCS_SESSION_HEADER);
  if (!presented) {
    return c.json(
      { ok: false, error: "invalid_session", message: DOCS_AUTH_MESSAGES.invalid_session },
      401,
      NO_STORE,
    );
  }

  const found = await findSessionByCookieId(c.env, presented, "docs");
  if (!found) {
    return c.json(
      { ok: false, error: "invalid_session", message: DOCS_AUTH_MESSAGES.invalid_session },
      401,
      NO_STORE,
    );
  }
  if (!isDocsAdmin(found.user.role)) {
    return c.json(
      { ok: false, error: "not_authorized", message: DOCS_AUTH_MESSAGES.not_authorized },
      403,
      NO_STORE,
    );
  }

  const body: DocsVerifyResponse = {
    ok: true,
    username: found.user.username ?? null,
    role: found.user.role as string,
  };
  return c.json(body, 200, NO_STORE);
});
