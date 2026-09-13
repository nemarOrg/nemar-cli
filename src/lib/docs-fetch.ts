/**
 * Retrieve documentation pages from `docs.nemar.org`, including the gated
 * `/admin/*` ones, without a browser (epic #1336 phase 3, issue #1341).
 *
 * WHY THIS EXISTS. ADR 0057 made the docs URL the retrieval surface and took
 * repository access out of the contract; ADR 0059 then made the repository
 * private, so a checkout is not a fallback for anyone who lacks access. That
 * leaves one way for an admin, or an agent acting for one, to read an
 * operations runbook: fetch it. Phase 2 gave every page a `.md` mirror so what
 * comes back is parseable rather than Starlight's HTML.
 *
 * WHAT KEEPS THE KEY OUT OF THE DOCS EDGE. The API key authenticates exactly
 * one request, to `api.nemar.org`, which trades it for a fifteen-minute
 * docs-scoped value. Only that value is sent onward, and only as a `Cookie`
 * header. The gate reads the credential from `Cookie` and cannot tell no
 * browser was involved, so nothing in `nemarOrg/docs` needed a change to accept
 * this -- checked against the deployed Function rather than assumed, because
 * issue #1341 asserted the opposite (that the Function accepts the
 * `X-Docs-Session` header from a client; it does not, that header is what the
 * Function itself presents to `verify`).
 *
 * ONE MINT SERVES MANY PAGES, which is why {@link fetchDocsPages} takes a list
 * rather than a path. `/auth/docs/cli-session` sits in the strict per-IP
 * rate-limit bucket (10/min), so a page-at-a-time loop would spend that budget
 * on credentials rather than reading; a reading session should cost one mint.
 */

import { DOCS_SESSION_COOKIE_NAME } from "../../shared/contract/docs-auth.js";
import { mintDocsSession } from "./api/auth.js";

/** Where the documentation is served. Overridable for tests and for a staging
 *  host; the default is the only value any user should need. */
export const DEFAULT_DOCS_URL = "https://docs.nemar.org";

export function getDocsUrl(): string {
  return process.env.NEMAR_DOCS_URL || DEFAULT_DOCS_URL;
}

/** How long one page fetch may take before it is abandoned.
 *
 *  Without this a hung docs host spins the spinner forever, which for the
 *  intended caller -- a script or an agent -- means a command that never
 *  returns rather than one that fails. Generous enough that a cold edge and a
 *  large page are fine; the mirrors are text and the largest is well under a
 *  megabyte. */
export const DOCS_FETCH_TIMEOUT_MS = 20_000;

/**
 * Turn what someone typed into the path of a markdown mirror.
 *
 * Accepts `admin/operations/zarr-serving`, `/admin/operations/zarr-serving/`,
 * `admin/operations/zarr-serving.md`, and a full `https://docs.nemar.org/...`
 * URL, because all four are things a person or an agent will paste. A trailing
 * slash is dropped before the extension is added: `build.format` is
 * `'directory'` on this site, so the HTML spelling of every page ends in one,
 * and `.../zarr-serving/.md` is not a page.
 *
 * An extension that is already there is left alone rather than replaced, so
 * `llms.txt` and `sitemap.xml` remain reachable through the same command.
 * Anything else gets `.md`, which is the only spelling this command can
 * usefully print.
 */
export function toMirrorPath(input: string): string {
  let path = input.trim();
  if (/^https?:\/\//i.test(path)) {
    // Take only the path, so pasting a browser URL works. A URL for some other
    // host is a mistake worth refusing rather than silently re-pointing at
    // docs.nemar.org: the caller asked for a specific page somewhere else.
    const url = new URL(path);
    const docsHost = new URL(getDocsUrl()).hostname;
    if (url.hostname.toLowerCase() !== docsHost.toLowerCase()) {
      throw new Error(`Not a ${docsHost} URL: ${input}`);
    }
    path = url.pathname;
  }
  if (!path.startsWith("/")) path = `/${path}`;
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  // The site root's mirror is `/index.md`; `entry.id` for the root entry is
  // literally `index`, so there is no special case on the serving side either.
  if (path === "" || path === "/") return "/index.md";
  const lastSegment = path.slice(path.lastIndexOf("/") + 1);
  return lastSegment.includes(".") ? path : `${path}.md`;
}

/** One page's outcome. `body` is present only on {@link DocsPageResult.ok}. */
export interface DocsPageResult {
  path: string;
  ok: boolean;
  body?: string;
  /** Why it failed, already phrased for a person. */
  error?: string;
}

/**
 * How the gate answers, translated.
 *
 * The three refusals are distinct and each means something different, so
 * collapsing them into "failed" would hide the one piece of information the
 * caller can act on:
 *
 * - 302 to the authorize path: the session was absent or dead. For this command
 *   that means the mint did not take, or fifteen minutes elapsed mid-run.
 * - 404: either the page does not exist, or it exists under the gate and this
 *   account is not an admin. The gate answers a non-admin with 404 on purpose
 *   (see `routes/auth-docs.ts`), so these two genuinely cannot be told apart
 *   from out here, and saying so is better than guessing.
 * - 503: the gate could not reach the API to check. Not a verdict about the
 *   account, and worth retrying.
 */
function describeRefusal(status: number, location: string | null): string {
  if (status === 302 || status === 301 || status === 307 || status === 308) {
    if (location?.includes("/auth/docs/authorize")) {
      return "the documentation session was refused (it may have expired mid-run); try again";
    }
    return `redirected to ${location ?? "an unknown location"}`;
  }
  if (status === 404) {
    return "not found, or it is a gated page and this account is not an admin";
  }
  if (status === 503) {
    return "the documentation gate could not reach the API; try again shortly";
  }
  return `unexpected status ${status}`;
}

/**
 * Fetch one or more documentation pages as Markdown, minting a single docs
 * session for the whole set.
 *
 * Never throws for a per-page failure: each path gets its own result, so one
 * bad path in a list of ten does not lose the other nine. A failure to MINT
 * does throw, because without a session there is nothing to report per page.
 *
 * `redirect: "manual"` is load-bearing. The gate's refusal IS a redirect, and
 * following it would fetch the website's sign-in page and hand back a 200 full
 * of HTML that looks like a successful read.
 */
export async function fetchDocsPages(inputs: readonly string[]): Promise<DocsPageResult[]> {
  // PARSE BEFORE MINTING. An earlier version minted first, so a call whose
  // paths were all malformed still spent a credential from the strict per-IP
  // bucket to discover that it had nothing to fetch.
  const parsed = inputs.map((input) => {
    try {
      return { input, path: toMirrorPath(input) };
    } catch (error) {
      return { input, error: (error as Error).message };
    }
  });
  if (!parsed.some((entry) => entry.path)) {
    return parsed.map((entry) => ({
      path: entry.input,
      ok: false,
      error: entry.error ?? "not a usable documentation path",
    }));
  }

  const session = await mintDocsSession();
  // `request()` casts rather than validating (see `mintDocsSession`), so check
  // the one field everything below depends on instead of sending `undefined` as
  // a cookie and reading the gate's refusal as an authorization problem.
  if (typeof session?.session !== "string" || session.session.length === 0) {
    throw new Error("The API returned no documentation session value.");
  }

  const base = getDocsUrl().replace(/\/$/, "");
  const cookie = `${DOCS_SESSION_COOKIE_NAME}=${session.session}`;
  const results: DocsPageResult[] = [];

  for (const entry of parsed) {
    if (!entry.path) {
      results.push({ path: entry.input, ok: false, error: entry.error ?? "unusable path" });
      continue;
    }
    const path = entry.path;

    try {
      const response = await fetch(`${base}${path}`, {
        redirect: "manual",
        signal: AbortSignal.timeout(DOCS_FETCH_TIMEOUT_MS),
        headers: {
          Cookie: cookie,
          // Identifies the caller to the docs edge's own logs. It does reach
          // `/auth/docs/verify`, which the Pages Function forwards it to, but
          // it is NOT what lands in `web_sessions.user_agent`: that column is
          // written once, at mint time, from the User-Agent of the request to
          // `/auth/docs/cli-session`, and the API client sets none. An earlier
          // version of this comment claimed otherwise.
          "User-Agent": "nemar-cli",
        },
      });
      if (response.status === 200) {
        results.push({ path, ok: true, body: await response.text() });
        continue;
      }
      results.push({
        path,
        ok: false,
        error: describeRefusal(response.status, response.headers.get("Location")),
      });
    } catch (error) {
      // `AbortSignal.timeout` rejects with a TimeoutError, which reads as
      // "The operation timed out" and says nothing about which page or how
      // long. Name both, since the caller may be a script with no other view.
      const name = (error as Error).name;
      results.push({
        path,
        ok: false,
        error:
          name === "TimeoutError"
            ? `no response within ${DOCS_FETCH_TIMEOUT_MS / 1000}s`
            : (error as Error).message,
      });
    }
  }

  return results;
}
