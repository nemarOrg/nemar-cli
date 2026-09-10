/**
 * The API's 404 body, in ONE place, because two copies of it were already
 * disagreeing.
 *
 * `api.notFound(...)` in index.ts is NOT what an unrouted request to
 * api.nemar.org receives. Hono's `route()` copies a sub-app's routes and not
 * its notFound handler, and the worker's entry point is `app` (which mounts
 * `api` at `/` and `/nemar`), so `api`'s own handler fires only where a request
 * re-enters `api.fetch` directly -- the data.nemar.org fork. Everything else
 * got Hono's plain-text `404 Not Found` default. Two hostnames therefore
 * answered the same unrouted path with different content types, and nobody
 * noticed because nothing compared them.
 *
 * That stopped being cosmetic when `POST /auth/docs/grant` started answering
 * 404 instead of 403 for a signed-in non-admin (mirroring `adminGate` on the
 * website). Its hand-built JSON body was trivially distinguishable from the
 * plain-text body a genuinely unrouted path returned, so the disguise
 * announced itself. Registering this on BOTH apps and calling it from that
 * route is what keeps them identical; a transcription in a test does not,
 * which is how the first version passed review.
 */

import type { Context } from "hono";
import type { Bindings, Variables } from "../types/bindings";

/** The shape every 404 in this worker returns. Exported for tests, which must
 *  compare against the real handler rather than re-typing the body. */
export function notFoundBody(method: string, path: string) {
  return { error: "Not Found", message: `Route ${method} ${path} not found` };
}

/** The notFound handler for `api` and `app` alike, and the response any route
 *  that wants to look unrouted must return. */
export function notFoundResponse(
  c: Context<{ Bindings: Bindings; Variables: Variables }>,
): Response {
  return c.json(notFoundBody(c.req.method, c.req.path), 404);
}
