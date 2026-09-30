/**
 * The private site's session handoff (ADR 0079), mounted under the same
 * `/auth` prefix as the other auth families.
 *
 *   POST /auth/private/grant - website (session): mint a one-time code
 *
 * That is the whole HTTP surface, and deliberately so. The private site
 * (`private.nemar.org`) hosts access-controlled features and needs a session
 * on its own host; the app cookie is scoped to `app.nemar.org` and never
 * reaches it, so the private site gets a credential of its own through a
 * sixty-second code, exactly as the docs host does (`routes/auth-docs.ts`,
 * ADR 0056). Unlike the docs host, the private site's Worker reaches this API
 * through a service binding, so trading the code for a session, resolving
 * that session and signing it out are methods on the `NemarApiRpc` entrypoint
 * (ADR 0078), not routes anyone on the internet can call.
 *
 * `grant` is reached only by the website's authorize page, server-side,
 * forwarding the visitor's session cookie. There is no role gate: every
 * account that can use the API may hold a private-site session, and what it
 * may do there is decided by the private site from the account it is told
 * about.
 */

import { Hono } from "hono";
import {
  PRIVATE_GRANT_TTL_SECONDS,
  type PrivateGrantRefusal,
  type PrivateGrantResponse,
} from "../../../shared/contract/private-site.js";
import { webSessionMiddleware } from "../middleware/webSession";
import { inactiveAccountBody, isActiveAccountStatus } from "../services/account-tier";
import { generateGrantCode, hashGrantCode } from "../services/docs-auth";
import {
  PRIVATE_GRANT_INSERT_SQL,
  PRIVATE_GRANT_PRUNE_SQL,
  grantState,
} from "../services/private-auth";
import { isAllowedOrigin } from "../services/web-session";
import type { Bindings, Variables } from "../types/bindings";

export const authPrivateRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

/** Every response here carries a credential or a refusal about one, so none of
 *  it may sit in a shared cache. */
const NO_STORE = { "Cache-Control": "no-store" } as const;

/** `satisfies` ties the code to the contract's refusal union, so the two
 *  cannot drift apart. */
const UNAUTHENTICATED = {
  error: "unauthenticated",
  message: "Sign in to nemar.org first, then open the link again.",
} as const satisfies { error: PrivateGrantRefusal; message: string };

const INVALID_REQUEST = {
  error: "invalid_request",
  message: "The sign-in link is incomplete. Open the page on the private site again.",
} as const satisfies { error: PrivateGrantRefusal; message: string };

/**
 * Mint a one-time code for the caller's own account, bound to the `state` the
 * private site gave the browser (JSON body `{ state }`, forwarded by the
 * website). Only the state's hash is stored.
 */
authPrivateRoutes.post("/private/grant", webSessionMiddleware, async (c) => {
  // Origin first, before authentication, as `/auth/docs/grant` and every other
  // cookie-authenticated mutation here does. A MISSING Origin is refused too:
  // the website's server-side fetch sends none of its own, so its authorize
  // page pins one. Without this check the route is a cross-site POST that
  // mints a code from someone's ambient cookie.
  if (!isAllowedOrigin(c.req.header("Origin"))) {
    return c.json({ error: "Origin not allowed" }, 403, NO_STORE);
  }

  const user = c.var.webUser;
  const session = c.var.webSession;
  if (!user || !session) {
    return c.json(UNAUTHENTICATED, 401, NO_STORE);
  }
  // `webSessionMiddleware` admits a `pending` account (it has to reach
  // Settings to fix the address that made it pending), so the account rule is
  // applied here. The mint re-applies it, but refusing now tells the website
  // which page to show instead of letting it redirect to a code that can never
  // be spent.
  if (!isActiveAccountStatus(user.status)) {
    return c.json(inactiveAccountBody(user.status), 403, NO_STORE);
  }

  // After authentication, so an anonymous caller learns nothing from a 400.
  const body = (await c.req.json().catch(() => null)) as { state?: unknown } | null;
  const state = grantState(body?.state);
  if (state === null) {
    return c.json(INVALID_REQUEST, 400, NO_STORE);
  }

  const code = generateGrantCode();
  const codeHash = await hashGrantCode(code);

  // The prune rides the same batch to save a round trip. It shares the
  // insert's transaction, so a failed prune fails the grant too; it is one
  // indexed DELETE, and the caller can simply ask again.
  const results = await c.env.DB.batch([
    c.env.DB.prepare(PRIVATE_GRANT_PRUNE_SQL),
    c.env.DB.prepare(PRIVATE_GRANT_INSERT_SQL).bind(
      codeHash,
      await hashGrantCode(state),
      PRIVATE_GRANT_TTL_SECONDS,
      session.id,
    ),
  ]);

  // Zero rows means the app session stopped being live between the
  // middleware's lookup and this write. The honest answer is the one a
  // missing cookie gets.
  if ((results[1]?.meta?.changes ?? 0) === 0) {
    return c.json(UNAUTHENTICATED, 401, NO_STORE);
  }

  const granted: PrivateGrantResponse = { code, expires_in: PRIVATE_GRANT_TTL_SECONDS };
  return c.json(granted, 200, NO_STORE);
});
