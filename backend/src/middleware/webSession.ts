/**
 * Web-session middleware (#569).
 *
 * Reads the `nemar_session` cookie, looks up the row, and exposes the
 * joined user (and the raw cookie value) on the Hono context so the
 * route handler can build the response without re-parsing the cookie.
 *
 * Intentionally optional: routes that need it (`/auth/logout`,
 * `/auth/me`) mount this middleware explicitly. We never enforce
 * cookie auth globally because the rest of the API runs on bearer
 * API tokens — mixing would create double-auth ambiguity, and the
 * web flow does not gate any non-web endpoint.
 */

import type { Context, Next } from "hono";
import { COOKIE_NAME, findSessionByCookieId, parseCookieHeader } from "../services/web-session";
import type { Bindings, Variables } from "../types/bindings";

type WebSessionContext = Context<{ Bindings: Bindings; Variables: Variables }>;

/**
 * Hydrates `c.var.webUser` and `c.var.webSessionCookieId` when a valid
 * cookie is present. Never short-circuits: routes inspect the
 * variables and decide whether to require auth. `/auth/me` returns
 * `{ user: null }` for a missing cookie; `/auth/logout` is idempotent
 * and returns 200 either way.
 */
export async function webSessionMiddleware(c: WebSessionContext, next: Next) {
  const cookieHeader = c.req.header("Cookie");
  const cookieIdRaw = parseCookieHeader(cookieHeader, COOKIE_NAME);
  if (!cookieIdRaw) {
    await next();
    return;
  }
  c.set("webSessionCookieId", cookieIdRaw);

  try {
    const found = await findSessionByCookieId(c.env, cookieIdRaw);
    if (found) {
      c.set("webUser", found.user);
      c.set("webSession", found.session);
    }
  } catch (err) {
    // Cookie lookup failures are non-fatal: the route treats the user
    // as unauthenticated. Log so persistent DB errors surface in logs.
    console.error("[web-session-mw] lookup failed", err);
  }

  await next();
}
