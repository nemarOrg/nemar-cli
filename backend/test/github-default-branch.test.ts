/**
 * Which branch a dataset repository's content is written to, and how a repository
 * pointed at the wrong branch is repaired (#1386).
 *
 * Both halves of this were wrong in a way that only showed up on sixteen
 * repositories whose `default_branch` is `git-annex`: writes with no branch went
 * wherever GitHub pointed (while reads went to `main`), and the repair renamed the
 * default branch, which is the right fix only when `main` does not exist.
 *
 * Driven against a local Bun.serve stand-in for the GitHub API -- the same
 * `NEMAR_GITHUB_API_URL` override the other GitHub-facing suites use -- which
 * records every request so the assertions are about what was actually sent.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createOrUpdateFile } from "../src/services/github/contents";
import { ensureMainBranch } from "../src/services/github/repos";

interface RecordedRequest {
  method: string;
  path: string;
  query: string;
  body: Record<string, unknown> | null;
}

let server: ReturnType<typeof Bun.serve>;
const seen: RecordedRequest[] = [];

/** What the stand-in should say about the repository under test. */
const repoState = {
  defaultBranch: "main",
  /** Branches that exist; anything else 404s. */
  branches: new Set<string>(["main"]),
  /** Refs for which the contents API reports an existing blob (to update). */
  blobs: new Map<string, string>(),
};

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const path = url.pathname;
      let body: Record<string, unknown> | null = null;
      if (request.method !== "GET") {
        body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
      }
      seen.push({ method: request.method, path, query: url.search, body });

      const repoPath = "/repos/nemarDatasets/ds";
      if (path === repoPath && request.method === "GET") {
        return Response.json({ default_branch: repoState.defaultBranch });
      }
      if (path === repoPath && request.method === "PATCH") {
        repoState.defaultBranch = String(body?.default_branch ?? "");
        return Response.json({ default_branch: repoState.defaultBranch });
      }
      if (path.startsWith(`${repoPath}/branches/`) && path.endsWith("/rename")) {
        return Response.json({ name: "main" });
      }
      if (path.startsWith(`${repoPath}/branches/`) && request.method === "GET") {
        const branch = decodeURIComponent(path.slice(`${repoPath}/branches/`.length));
        return repoState.branches.has(branch)
          ? Response.json({ name: branch })
          : new Response('{"message":"Branch not found"}', { status: 404 });
      }
      if (path.startsWith(`${repoPath}/contents/`)) {
        if (request.method === "GET") {
          const ref = url.searchParams.get("ref") ?? "";
          const sha = repoState.blobs.get(ref);
          return sha
            ? Response.json({ sha })
            : new Response('{"message":"Not Found"}', { status: 404 });
        }
        return Response.json({ content: { sha: "written" } });
      }
      return new Response('{"message":"unexpected"}', { status: 500 });
    },
  });
  (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL =
    `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL = undefined;
  server.stop(true);
});

afterEach(() => {
  seen.length = 0;
  repoState.defaultBranch = "main";
  repoState.branches = new Set(["main"]);
  repoState.blobs = new Map();
});

describe("createOrUpdateFile", () => {
  test("writes to main when the caller names no branch", async () => {
    // The Contents API writes to the repository's DEFAULT branch when the request
    // carries no `branch`, and sixteen dataset repositories point at `git-annex`.
    // The publication orchestrator's DOI writes had no branch and landed there,
    // while `getFileContent` read `main`: fourteen public datasets still advertise
    // OpenNeuro's DOI on main because of exactly this (#1386).
    repoState.defaultBranch = "git-annex";
    await createOrUpdateFile("ds", "dataset_description.json", "{}", "msg", "pat");

    const get = seen.find((r) => r.method === "GET" && r.path.includes("/contents/"));
    const put = seen.find((r) => r.method === "PUT");
    expect(get?.query).toBe("?ref=main");
    expect(put?.body?.branch).toBe("main");
  });

  test("the sha it sends comes from the branch it writes to", async () => {
    // The precise #1386 mechanism, and the one the other tests only guard
    // indirectly: a blob that exists on `git-annex` and not on `main`. Reading the
    // sha from one ref and PUTting it against another is how a write either
    // clobbers the wrong branch or fails with a stale-sha conflict. The GET must
    // ask `main`, find nothing, and the PUT must carry no sha at all.
    repoState.defaultBranch = "git-annex";
    repoState.branches = new Set(["main", "git-annex"]);
    repoState.blobs.set("git-annex", "sha-on-the-annex-branch");

    await createOrUpdateFile("ds", "dataset_description.json", "{}", "msg", "pat");

    const get = seen.find((r) => r.method === "GET" && r.path.includes("/contents/"));
    const put = seen.find((r) => r.method === "PUT");
    expect(get?.query).toBe("?ref=main");
    expect(put?.body?.branch).toBe("main");
    expect(put?.body?.sha).toBeUndefined();
  });

  test("an existing blob on the target branch is updated with its own sha", async () => {
    repoState.blobs.set("main", "sha-on-main");

    await createOrUpdateFile("ds", "dataset_description.json", "{}", "msg", "pat");

    const put = seen.find((r) => r.method === "PUT");
    expect(put?.body?.sha).toBe("sha-on-main");
    expect(put?.body?.branch).toBe("main");
  });

  test("an explicitly named branch is still honored", async () => {
    await createOrUpdateFile("ds", "x.json", "{}", "msg", "pat", "release/1.0.0");
    const put = seen.find((r) => r.method === "PUT");
    expect(put?.body?.branch).toBe("release/1.0.0");
  });
});

describe("ensureMainBranch", () => {
  test("does nothing when the default branch is already main", async () => {
    const result = await ensureMainBranch("ds", "pat");
    expect(result).toEqual({ changed: false });
    expect(seen.filter((r) => r.method !== "GET")).toEqual([]);
  });

  test("repoints, and does NOT rename, when main already exists", async () => {
    // This is the sixteen-repository case. A rename here would try to turn
    // git-annex's own log branch into `main` while a real `main` is sitting there.
    repoState.defaultBranch = "git-annex";
    repoState.branches = new Set(["main", "git-annex"]);

    const result = await ensureMainBranch("ds", "pat");

    // `repointed`, not `renamed`: this branch moves a pointer, and the audit trail
    // consumers print this verbatim.
    expect(result).toEqual({ changed: true, action: "repointed", previousBranch: "git-annex" });
    expect(seen.some((r) => r.path.endsWith("/rename"))).toBe(false);
    const patch = seen.find((r) => r.method === "PATCH");
    expect(patch?.body?.default_branch).toBe("main");
    expect(repoState.defaultBranch).toBe("main");
  });

  test("renames when main is the branch that is missing", async () => {
    // The original case this function was written for: a repo whose dataset branch
    // is called master (or DataLad's adjusted/master(unlocked)). Renaming is right
    // there, and must survive the fix for the other case.
    repoState.defaultBranch = "master";
    repoState.branches = new Set(["master"]);

    const result = await ensureMainBranch("ds", "pat");

    expect(result).toEqual({ changed: true, action: "renamed", previousBranch: "master" });
    expect(seen.some((r) => r.path.endsWith("/branches/master/rename"))).toBe(true);
    expect(seen.some((r) => r.method === "PATCH")).toBe(false);
  });

  test("refuses to rename when it cannot tell whether main exists", async () => {
    // A 500 on the branch lookup is not "main is absent". Guessing wrong here
    // renames a branch that should not be renamed, so it stops instead.
    repoState.defaultBranch = "git-annex";
    repoState.branches = new Set(); // any lookup 404s...
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const href = typeof input === "string" ? input : input.toString();
      // ...except the main lookup, which fails in a way that means "unknown".
      if (href.endsWith("/branches/main")) return new Response("boom", { status: 500 });
      return realFetch(input, init);
    }) as typeof fetch;

    try {
      await expect(ensureMainBranch("ds", "pat")).rejects.toThrow(/Refusing to rename/);
      expect(seen.some((r) => r.path.endsWith("/rename"))).toBe(false);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
