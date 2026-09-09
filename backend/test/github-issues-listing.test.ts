/**
 * `listOpenIssuesByLabel`'s paging and its page cap (epic #1306 phase 2).
 *
 * Driven through a local `Bun.serve()` GitHub via the `NEMAR_GITHUB_API_URL`
 * override, the same boundary six other backend suites already use. So the real
 * `githubFetchWithRetry`, the real URL construction, the real pagination loop and
 * the real error paths all run; only the far end of the socket is local.
 *
 * Worth its own file because phase 2 CHANGED a failure mode. The deleted
 * `findOpenIssueByTitle` warned and returned null at the cap; this throws. That
 * flip has teeth in both call paths -- the filer would file NOTHING rather than
 * one duplicate, and the sweep and route become a 500 -- and it was the one part
 * of the swap with no coverage at all.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { listOpenIssuesByLabel } from "../src/services/github/issues";
import { __resetRateLimitStateForTests } from "../src/services/github/transport";

const REPO = "nemarDatasets/.github";
const LABEL = "import-failure";

/** How many full pages the fake serves before returning a short one. `Infinity`
 *  means every page is full, which is how the cap is reached. */
let fullPages = 0;
/** Set to a status to make every request fail with it. */
let failWith: number | null = null;
let requestedPages: number[] = [];
let requestedUrls: string[] = [];

const server = Bun.serve({
  port: 0,
  fetch(req) {
    const url = new URL(req.url);
    requestedUrls.push(url.pathname + url.search);
    if (failWith !== null) {
      return new Response("boom", { status: failWith });
    }
    const page = Number(url.searchParams.get("page") ?? "1");
    requestedPages.push(page);
    // A full page is 100 issues; anything less ends the walk.
    const size = page <= fullPages ? 100 : 3;
    const issues = Array.from({ length: size }, (_, i) => ({
      number: (page - 1) * 100 + i + 1,
      html_url: `https://example/${page}/${i}`,
      state: "open",
      title: `Import failure: on${String(page).padStart(6, "0")} (ds000001)`,
      labels: [{ name: LABEL }],
    }));
    return new Response(JSON.stringify(issues), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  },
});

beforeAll(() => {
  (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL =
    `http://localhost:${server.port}`;
});

afterAll(() => {
  (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL = undefined;
  server.stop(true);
});

beforeEach(() => {
  fullPages = 0;
  failWith = null;
  requestedPages = [];
  requestedUrls = [];
  __resetRateLimitStateForTests();
});

describe("listOpenIssuesByLabel", () => {
  test("a single short page ends the walk", async () => {
    const issues = await listOpenIssuesByLabel(REPO, LABEL, "pat");
    expect(issues).toHaveLength(3);
    expect(requestedPages).toEqual([1]);
  });

  test("full pages are followed until a short one arrives", async () => {
    fullPages = 2;
    const issues = await listOpenIssuesByLabel(REPO, LABEL, "pat");
    // 100 + 100 + 3
    expect(issues).toHaveLength(203);
    expect(requestedPages).toEqual([1, 2, 3]);
  });

  test("the label is sent url-encoded, and only open issues are asked for", async () => {
    await listOpenIssuesByLabel(REPO, "needs triage/urgent", "pat");
    expect(requestedUrls[0]).toContain("state=open");
    expect(requestedUrls[0]).toContain("labels=needs%20triage%2Furgent");
    expect(requestedUrls[0]).toContain("per_page=100");
  });

  /**
   * The behaviour change, asserted rather than assumed. A truncated listing would
   * undercount, and both callers make a decision from the COUNT: the filer would
   * miss an existing issue and open a duplicate, or wrongly release the rollup
   * mode. Refusing to answer is the honest failure.
   */
  test("exhausting the page cap throws instead of returning a truncated set", async () => {
    fullPages = Number.POSITIVE_INFINITY;
    await expect(listOpenIssuesByLabel(REPO, LABEL, "pat")).rejects.toThrow(
      /exceeded 20 pages; refusing to report a truncated set/,
    );
    // Exactly the cap, not one more: the walk is bounded.
    expect(requestedPages).toHaveLength(20);
  });

  test("a non-2xx throws carrying the repo and the status", async () => {
    failWith = 404;
    await expect(listOpenIssuesByLabel(REPO, LABEL, "pat")).rejects.toThrow(
      /Failed to list issues on nemarDatasets\/\.github: HTTP 404/,
    );
  });
});
