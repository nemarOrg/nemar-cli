/**
 * branchExists: the availability-report writer asks it before committing, so
 * that the Contents API never creates `main` on an empty dataset repository
 * (nm000358, 2026-10-07: the report became an unrelated root commit on `main`
 * while the upload was still running, and every push of the upload was then
 * rejected as non-fast-forward).
 *
 * A local server stands in for api.github.com through the NEMAR_GITHUB_API_URL
 * override the other GitHub-facing suites use.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { branchExists, getMainBranchSha } from "../src/services/github/contents";

let server: ReturnType<typeof Bun.serve>;
const seen: string[] = [];

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      seen.push(url.pathname);
      if (url.pathname === "/repos/nemarDatasets/nm000360/git/ref/heads/main") {
        return Response.json({ ref: "refs/heads/main", object: { sha: "a".repeat(40) } });
      }
      if (url.pathname === "/repos/nemarDatasets/nm000358/git/ref/heads/main") {
        // What GitHub answers for a repository with no commits at all.
        return Response.json({ message: "Git Repository is empty." }, { status: 409 });
      }
      if (url.pathname === "/repos/nemarDatasets/nm000361/git/ref/heads/main") {
        return Response.json({ message: "Not Found" }, { status: 404 });
      }
      // nm000362 has release/1.0 and a branch whose segments need escaping; the
      // two forms below are the ONLY paths that name them, so a request that
      // encodes the slash (`release%2F1.0`) or leaves a space raw reads as
      // "no such ref", exactly as GitHub answers it.
      if (
        url.pathname === "/repos/nemarDatasets/nm000362/git/ref/heads/release/1.0" ||
        url.pathname === "/repos/nemarDatasets/nm000362/git/ref/heads/feature/a%20b%23c"
      ) {
        return Response.json({ ref: "refs/heads/x", object: { sha: "b".repeat(40) } });
      }
      if (url.pathname.startsWith("/repos/nemarDatasets/nm000362/")) {
        return Response.json({ message: "Not Found" }, { status: 404 });
      }
      return Response.json({ message: "boom" }, { status: 500 });
    },
  });
  (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL =
    `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL = undefined;
  server.stop(true);
});

describe("branchExists", () => {
  test("an existing branch is true", async () => {
    expect(await branchExists("nm000360", "main", "pat")).toBe(true);
  });

  test("a missing branch (404) is false, without retrying", async () => {
    seen.length = 0;
    expect(await branchExists("nm000361", "main", "pat")).toBe(false);
    expect(seen).toEqual(["/repos/nemarDatasets/nm000361/git/ref/heads/main"]);
  });

  test("an empty repository (409 'Git Repository is empty') is false, without retrying", async () => {
    seen.length = 0;
    expect(await branchExists("nm000358", "main", "pat")).toBe(false);
    expect(seen).toEqual(["/repos/nemarDatasets/nm000358/git/ref/heads/main"]);
  });

  // `encodeURIComponent(branch)` as ONE component sent `release%2F1.0`, which
  // names no ref, so every slash-containing branch read as absent.
  test("a branch containing a slash keeps the slash in the ref path", async () => {
    seen.length = 0;
    expect(await branchExists("nm000362", "release/1.0", "pat")).toBe(true);
    expect(seen).toEqual(["/repos/nemarDatasets/nm000362/git/ref/heads/release/1.0"]);
  });

  test("a segment with URL-significant characters is still escaped", async () => {
    expect(await branchExists("nm000362", "feature/a b#c", "pat")).toBe(true);
  });

  test("a slash-containing branch that does not exist is false", async () => {
    expect(await branchExists("nm000362", "release/2.0", "pat")).toBe(false);
  });

  test("any other failure throws instead of guessing", async () => {
    await expect(branchExists("nm000999", "main", "pat")).rejects.toThrow("HTTP 500");
  });
});

// getMainBranchSha shares branchExists' request, so the same URL rules hold
// for it; it differs only in retrying a 404 and in throwing instead of
// answering "no".
describe("getMainBranchSha (shares branchExists' ref request)", () => {
  test("resolves the sha of an existing branch", async () => {
    expect(await getMainBranchSha("nm000360", "main", "pat")).toBe("a".repeat(40));
  });

  test("resolves a slash-containing branch", async () => {
    seen.length = 0;
    expect(await getMainBranchSha("nm000362", "release/1.0", "pat")).toBe("b".repeat(40));
    expect(seen).toEqual(["/repos/nemarDatasets/nm000362/git/ref/heads/release/1.0"]);
  });

  test("an empty repository (409) throws the HTTP error instead of answering", async () => {
    await expect(getMainBranchSha("nm000358", "main", "pat")).rejects.toThrow(
      "Failed to get main branch ref: HTTP 409",
    );
  });
});
