/**
 * Cross-origin hostname checks shared by the worker's two CORS allow-lists
 * (#1346).
 *
 * The api fork (`cors()` in index.ts) and the zarr fork (`allowedOrigin` in
 * routes/zarr-data.ts) deliberately differ in scope — the api fork also allows
 * `*.osc.earth` and sets `credentials: true`, the zarr fork stays as tight as it
 * can while still exposing the Range headers zarrita reads. What they must NOT
 * differ on is which of our own web surfaces count, because a surface allowed by
 * one and blocked by the other is a page that half works.
 *
 * Kept pure (no Hono context, no env) so the tables are unit-testable without
 * instantiating the worker, the same way `host-routing.ts` is.
 */

/**
 * Cloudflare Pages projects serving the NEMAR website. Each one answers on
 * `<project>.pages.dev` plus a subdomain per branch and per deployment.
 *
 * - `nemar-website` — production, deployed from the website repo's `main` by
 *   Cloudflare's GitHub integration. Its custom domains (nemar.org, www, ww2,
 *   app) are already covered by the `.nemar.org` rules at each call site; what
 *   is added here are the *preview* URLs for pull requests.
 * - `nemar-website-test` — the staging project behind test.nemar.org. Same
 *   reasoning: the custom domain is already allowed, its per-deployment URLs
 *   were not.
 */
export const WEBSITE_PAGES_HOSTS: readonly string[] = [
  "nemar-website.pages.dev",
  "nemar-website-test.pages.dev",
];

/**
 * True for a Pages hostname belonging to one of the website projects, including
 * its branch and per-deployment preview subdomains.
 *
 * **Why project-scoped and not `*.pages.dev`.** A bare `.pages.dev` suffix would
 * trust every Cloudflare customer, since anyone can create a project there.
 * Requiring the project label does not: only the account owning a project can
 * create hostnames beneath it, and both names above are ours. The trust boundary
 * is our own deploy pipeline — the same one test.nemar.org already sits behind.
 *
 * The `=== host || endsWith("." + host)` shape is what keeps suffix confusion
 * out: `evil-nemar-website.pages.dev` does not end with
 * `.nemar-website.pages.dev` (the character before the project label is `-`, not
 * `.`), and `nemar-website.pages.dev.evil.com` does not end with it either.
 * Pinned in `test/zarr-data-route.test.ts` alongside the same property for
 * `.nemar.org`.
 *
 * Expects the hostname alone, already lowercased by `URL` parsing at the call
 * sites — not a full origin.
 */
export function isWebsitePagesHost(hostname: string): boolean {
  return WEBSITE_PAGES_HOSTS.some((host) => hostname === host || hostname.endsWith(`.${host}`));
}

/**
 * True for a hostname that is the NEMAR website in some deployed or local form:
 * a `nemar.org` host, a Pages preview of either website project, or a developer's
 * loopback address.
 *
 * This is the common core of both allow-lists. Neither call site should add
 * a NEMAR web surface without adding it here.
 */
export function isNemarWebOrigin(hostname: string): boolean {
  if (hostname === "localhost" || hostname === "127.0.0.1") return true;
  if (hostname === "nemar.org" || hostname.endsWith(".nemar.org")) return true;
  return isWebsitePagesHost(hostname);
}
