/**
 * `listOpenIssuesByLabel`'s paging and its page cap (epic #1306 phase 2).
 *
 * Driven through a local `Bun.serve()` GitHub via the `NEMAR_GITHUB_API_URL`
 * override, the same boundary six other backend suites already use. So the real
 * `githubFetchWithRetry`, the real URL construction, the real pagination loop and
 * the real error paths all run; only the far end of the socket is local.
 *
 * Phase 3 (#1311) added `updateIssue` here for the same reason: it is the one
 * primitive that can blank a production issue body, and every sweep test injects
 * it, so without these cases its PATCH shape and its empty-patch refusal never
 * execute at all.
 *
 * Worth its own file because phase 2 CHANGED a failure mode. The deleted
 * `findOpenIssueByTitle` warned and returned null at the cap; this throws. That
 * flip has teeth in both call paths -- the filer would file NOTHING rather than
 * one duplicate, and the sweep and route become a 500 -- and it was the one part
 * of the swap with no coverage at all.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { listOpenIssuesByLabel, updateIssue } from "../src/services/github/issues";
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
let requestedBodies: string[] = [];
let requestedMethods: string[] = [];

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    requestedUrls.push(url.pathname + url.search);
    requestedMethods.push(req.method);
    if (req.method === "PATCH") {
      requestedBodies.push(await req.text());
      if (failWith !== null) return new Response("boom", { status: failWith });
      return Response.json({ number: 1, html_url: "u", state: "open", title: "t" });
    }
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
  requestedBodies = [];
  requestedMethods = [];
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

describe("updateIssue", () => {
  test("a body-only patch sends only the body", async () => {
    await updateIssue(REPO, 700, { body: "new body" }, "pat");
    expect(requestedMethods).toEqual(["PATCH"]);
    expect(requestedUrls[0]).toBe("/repos/nemarDatasets/.github/issues/700");
    expect(JSON.parse(requestedBodies[0] ?? "{}")).toEqual({ body: "new body" });
  });

  test("a title-only patch does not blank the body by omission", async () => {
    // The whole point of building the payload from present fields: a caller that
    // only wants to retitle must not silently erase the body.
    await updateIssue(REPO, 700, { title: "new title" }, "pat");
    const sent = JSON.parse(requestedBodies[0] ?? "{}");
    expect(sent).toEqual({ title: "new title" });
    expect("body" in sent).toBe(false);
  });

  test("both fields are sent when both are given", async () => {
    await updateIssue(REPO, 700, { title: "t", body: "b" }, "pat");
    expect(JSON.parse(requestedBodies[0] ?? "{}")).toEqual({ title: "t", body: "b" });
  });

  test("an empty patch throws without spending a request", async () => {
    // An empty patch means the caller's own diffing is broken; answering it with a
    // no-op request would hide that.
    await expect(updateIssue(REPO, 700, {}, "pat")).rejects.toThrow(/no fields to change/);
    expect(requestedMethods).toEqual([]);
  });

  test("an explicitly undefined field is treated as absent, not as null", async () => {
    await updateIssue(REPO, 700, { title: undefined, body: "b" }, "pat");
    expect(JSON.parse(requestedBodies[0] ?? "{}")).toEqual({ body: "b" });
  });

  test("a non-2xx throws carrying the repo, the number and the status", async () => {
    failWith = 422;
    await expect(updateIssue(REPO, 700, { body: "b" }, "pat")).rejects.toThrow(
      /Failed to update nemarDatasets\/\.github#700: HTTP 422/,
    );
  });
});
