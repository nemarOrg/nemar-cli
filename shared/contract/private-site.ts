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
 * this file as TEXT, so every constant stays a plain literal
 * (`export const X = "..."` or an integer): a value built from an expression
 * is invisible to a text reader.
 *
 * The flow, and which party does what:
 *
 *   1. private site  - no session of its own, so 302 to the APP authorize path
 *   2. website (SSR) - proves an app session, POST /auth/private/grant
 *   3. website       - 302 to the private site's callback path with the code
 *   4. private site  - trades the code for a session, and sets its cookie
 *   5. private site  - resolves that session on every later request
 *
 * The code is one-time and short-lived because it travels in a URL, where it
 * lands in history, logs and any `Referer` a page later sends. The session
 * value it buys never travels in a URL at all.
 */

/** Seconds a one-time grant code stays claimable. Same reasoning as
 *  `DOCS_GRANT_TTL_SECONDS`: generous for one redirect hop, short enough that a
 *  code leaked from a URL is almost certainly already dead. */
export const PRIVATE_GRANT_TTL_SECONDS = 60;

/** Where the private site sends a visitor who has no session there. Path only,
 *  on the APP host; the website owns the page. */
export const PRIVATE_AUTHORIZE_PATH = "/auth/private/authorize";

/** Where the website sends the visitor back to, on the private site, carrying
 *  the one-time code. Under a double-underscore prefix so it cannot collide
 *  with a page route. */
export const PRIVATE_CALLBACK_PATH = "/__auth/callback";

/** `POST /auth/private/grant` refusals carrying an `error` code. A missing or
 *  foreign `Origin` is 403 `Origin not allowed`, and an inactive account is 403
 *  with the API's usual inactive-account body (`status` names why), neither of
 *  which uses this code. */
export type PrivateGrantRefusal = "unauthenticated";

/** What `POST /auth/private/grant` returns. */
export interface PrivateGrantResponse {
  readonly code: string;
  readonly expires_in: number;
}
