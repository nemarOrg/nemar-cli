/**
 * Tree-batched commit tests (issue #407).
 *
 * Exercises `commitFilesAsTree`, `deployWorkflows`, and
 * `commitEnrichmentWithBidsignore` against a local Bun.serve fake GitHub so
 * call counts and request bodies are deterministic. The fake is a real HTTP
 * server, not a fetch-level mock; production code runs the same network path
 * it would against api.github.com.
 */

import { beforeAll, beforeEach, afterAll, describe, expect, test } from "bun:test";
import "./setup"; // ensures NEMAR_CONFIG_DIR isolation
import { type FakeGithubServer, json, startFakeGithub } from "./helpers/fetch-counter";

import {
  EnrichmentCommitError,
  type TreeFile,
  commitEnrichmentWithBidsignore,
  commitFilesAsTree,
  deployWorkflows,
  getWorkflowTemplates,
} from "../backend/src/services/github";

const REPO = "nm099999";
const BRANCH = "main";
const PAT = "fake-pat-for-tests";

// Initialize at module scope so values exist when `beforeAll` registers
// handlers whose KEYS embed these SHAs (the keys are evaluated once).
let fake: FakeGithubServer;
let baseCommitSha = "base000000000000000000000000000000000001";
const BASE_TREE_SHA = "base000000000000000000000000000000000002";
let baseTreeSha = BASE_TREE_SHA;
let nextCommitSha = "new0000000000000000000000000000000000001";
let nextTreeSha = "new0000000000000000000000000000000000002";
let refUpdateBehavior: "ok" | "conflict-then-ok" | "conflict-always" | "non-ff-422" = "ok";
let conflictAttemptsRemaining = 0;
let treeCreateBehavior: "ok" | "transient-then-ok" = "ok";
let treeCreateRemaining = 0;
let bidsignoreExists = false;
let bidsignoreContent = "";
let bidsignoreBlobReadable = true;
// Post-deploy workflow validation (issue #287): the listing handler reads
// these so individual tests can express "GitHub Actions parsed file X but
// not Y" without hand-rolling state.
let actionsWorkflowsResponse: { workflows: Array<{ path?: string; name?: string }> } = {
  workflows: [],
};
let actionsWorkflowsBehavior: "ok" | "server-error" = "ok";

function resetState() {
  fake.reset();
  baseCommitSha = "base000000000000000000000000000000000001";
  baseTreeSha = BASE_TREE_SHA;
  nextCommitSha = "new0000000000000000000000000000000000001";
  nextTreeSha = "new0000000000000000000000000000000000002";
  refUpdateBehavior = "ok";
  conflictAttemptsRemaining = 0;
  treeCreateBehavior = "ok";
  treeCreateRemaining = 0;
  bidsignoreExists = false;
  bidsignoreContent = "";
  bidsignoreBlobReadable = true;
  actionsWorkflowsResponse = { workflows: [] };
  actionsWorkflowsBehavior = "ok";
}

function setGithubApiOverride(url: string | undefined): void {
  if (url === undefined) {
    delete (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL;
  } else {
    (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL = url;
  }
}

beforeAll(() => {
  fake = startFakeGithub({
    [`GET /repos/nemarDatasets/${REPO}/branches/${BRANCH}`]: () =>
      json(200, {
        name: BRANCH,
        commit: {
          sha: baseCommitSha,
          commit: { tree: { sha: baseTreeSha } },
        },
      }),
    // Fake handler for a non-main branch (covers the "ensure non-main support" test).
    [`GET /repos/nemarDatasets/${REPO}/branches/master`]: () =>
      json(200, {
        name: "master",
        commit: {
          sha: baseCommitSha,
          commit: { tree: { sha: baseTreeSha } },
        },
      }),
    [`POST /repos/nemarDatasets/${REPO}/git/trees`]: () => {
      if (treeCreateBehavior === "transient-then-ok" && treeCreateRemaining > 0) {
        treeCreateRemaining--;
        return json(502, { message: "Bad Gateway" });
      }
      return json(201, { sha: nextTreeSha });
    },
    [`POST /repos/nemarDatasets/${REPO}/git/commits`]: () =>
      json(201, { sha: nextCommitSha }),
    [`PATCH /repos/nemarDatasets/${REPO}/git/refs/heads/${BRANCH}`]: () => {
      if (refUpdateBehavior === "conflict-always") {
        return json(422, { message: "Update is not a fast forward" });
      }
      if (refUpdateBehavior === "non-ff-422") {
        return json(422, { message: "Reference does not exist" });
      }
      if (refUpdateBehavior === "conflict-then-ok" && conflictAttemptsRemaining > 0) {
        conflictAttemptsRemaining--;
        baseCommitSha = `advanced${conflictAttemptsRemaining.toString().padStart(32, "0")}`;
        baseTreeSha = `advanced${conflictAttemptsRemaining.toString().padStart(32, "1")}`;
        return json(422, { message: "Update is not a fast forward" });
      }
      return json(200, { ref: `refs/heads/${BRANCH}`, object: { sha: nextCommitSha } });
    },
    [`PATCH /repos/nemarDatasets/${REPO}/git/refs/heads/master`]: () =>
      json(200, { ref: "refs/heads/master", object: { sha: nextCommitSha } }),
    [`GET /repos/nemarDatasets/${REPO}/git/ref/heads/${BRANCH}`]: () =>
      json(200, { ref: `refs/heads/${BRANCH}`, object: { sha: baseCommitSha } }),
    // commitEnrichmentWithBidsignore reads via getTreeAtRef -> commits + tree
    [`GET /repos/nemarDatasets/${REPO}/commits/${BRANCH}`]: () =>
      json(200, {
        sha: baseCommitSha,
        commit: { tree: { sha: baseTreeSha } },
      }),
    [`GET /repos/nemarDatasets/${REPO}/git/trees/${BASE_TREE_SHA}`]: () => {
      const entries = bidsignoreExists
        ? [{ path: ".bidsignore", mode: "100644", type: "blob", sha: "bidsblob01", size: bidsignoreContent.length }]
        : [];
      return json(200, { sha: baseTreeSha, tree: entries, truncated: false });
    },
    [`GET /repos/nemarDatasets/${REPO}/git/blobs/bidsblob01`]: () => {
      if (!bidsignoreBlobReadable) {
        return json(500, { message: "Server Error" });
      }
      const b64 = btoa(bidsignoreContent);
      return json(200, { sha: "bidsblob01", content: b64, encoding: "base64" });
    },
    // Single-file fallback (createOrUpdateFile)
    [`PUT /repos/nemarDatasets/${REPO}/contents/.bidsignore`]: () =>
      json(201, { content: { sha: "blob0001" }, commit: { sha: nextCommitSha } }),
    [`GET /repos/nemarDatasets/${REPO}/contents/.bidsignore`]: () =>
      json(404, { message: "Not Found" }),
    [`PUT /repos/nemarDatasets/${REPO}/contents/.nemar/metadata.json`]: () =>
      json(201, { content: { sha: "blob0002" }, commit: { sha: nextCommitSha } }),
    [`GET /repos/nemarDatasets/${REPO}/contents/.nemar/metadata.json`]: () =>
      json(404, { message: "Not Found" }),
    // Post-deploy workflow listing (issue #287): deployWorkflows calls this
    // after committing to verify GitHub Actions can parse each file. Tests
    // toggle `actionsWorkflowsResponse` to express the desired behavior.
    [`GET /repos/nemarDatasets/${REPO}/actions/workflows`]: () => {
      if (actionsWorkflowsBehavior === "server-error") {
        return json(500, { message: "Internal Server Error" });
      }
      return json(200, actionsWorkflowsResponse);
    },
  });
  setGithubApiOverride(fake.url);
});

afterAll(() => {
  fake.stop();
  setGithubApiOverride(undefined);
});

beforeEach(() => {
  resetState();
});

/** Find the most recent recorded call to a given METHOD + path and parse its JSON body. */
function lastBody<T = unknown>(method: string, path: string): T | undefined {
  const calls = fake.calls.filter((c) => c.method === method && c.path === path);
  const last = calls[calls.length - 1];
  if (!last?.body) return undefined;
  return JSON.parse(last.body) as T;
}

describe("commitFilesAsTree", () => {
  test("empty files array short-circuits via getMainBranchSha; no writes, one read", async () => {
    const result = await commitFilesAsTree(REPO, BRANCH, [], "noop", PAT);
    expect(result).toBe(baseCommitSha);
    expect(fake.calls.length).toBe(1);
    expect(
      fake.countByMethodPath[`GET /repos/nemarDatasets/${REPO}/git/ref/heads/${BRANCH}`],
    ).toBe(1);
  });

  test("single-file commit makes exactly 4 GitHub calls", async () => {
    const files: TreeFile[] = [{ path: "test.txt", content: "hello" }];
    const sha = await commitFilesAsTree(REPO, BRANCH, files, "test commit", PAT);
    expect(sha).toBe(nextCommitSha);
    expect(fake.calls.length).toBe(4);
    expect(fake.countByMethodPath[`GET /repos/nemarDatasets/${REPO}/branches/${BRANCH}`]).toBe(1);
    expect(fake.countByMethodPath[`POST /repos/nemarDatasets/${REPO}/git/trees`]).toBe(1);
    expect(fake.countByMethodPath[`POST /repos/nemarDatasets/${REPO}/git/commits`]).toBe(1);
    expect(
      fake.countByMethodPath[`PATCH /repos/nemarDatasets/${REPO}/git/refs/heads/${BRANCH}`],
    ).toBe(1);
  });

  test("six-file commit still makes exactly 4 calls, all files present in tree body", async () => {
    const files: TreeFile[] = Array.from({ length: 6 }, (_, i) => ({
      path: `.github/workflows/w${i}.yml`,
      content: `name: w${i}\non: push\njobs: {}\n`,
    }));
    await commitFilesAsTree(REPO, BRANCH, files, "Add 6 files", PAT);
    expect(fake.calls.length).toBe(4);
    const treeBody = lastBody<{ base_tree: string; tree: Array<{ path: string }> }>(
      "POST",
      `/repos/nemarDatasets/${REPO}/git/trees`,
    );
    expect(treeBody?.base_tree).toBe(baseTreeSha);
    expect(treeBody?.tree.map((t) => t.path).sort()).toEqual(files.map((f) => f.path).sort());
  });

  test("non-main branch is supported end-to-end", async () => {
    const files: TreeFile[] = [{ path: "a.txt", content: "a" }];
    const sha = await commitFilesAsTree(REPO, "master", files, "master commit", PAT);
    expect(sha).toBe(nextCommitSha);
    expect(fake.countByMethodPath[`GET /repos/nemarDatasets/${REPO}/branches/master`]).toBe(1);
    expect(
      fake.countByMethodPath[`PATCH /repos/nemarDatasets/${REPO}/git/refs/heads/master`],
    ).toBe(1);
  });

  test("ref-update fast-forward 422 retries with refetched base; second commit parents the new base", async () => {
    refUpdateBehavior = "conflict-then-ok";
    conflictAttemptsRemaining = 1;
    const files: TreeFile[] = [{ path: "a.txt", content: "a" }];
    const sha = await commitFilesAsTree(REPO, BRANCH, files, "retry test", PAT);
    expect(sha).toBe(nextCommitSha);
    expect(fake.calls.length).toBe(8);
    expect(fake.countByMethodPath[`GET /repos/nemarDatasets/${REPO}/branches/${BRANCH}`]).toBe(2);
    // The second commit must parent the advanced base, not the original.
    const commitBodies = fake.calls
      .filter((c) => c.method === "POST" && c.path === `/repos/nemarDatasets/${REPO}/git/commits`)
      .map((c) => JSON.parse(c.body!) as { parents: string[]; tree: string });
    expect(commitBodies).toHaveLength(2);
    expect(commitBodies[1].parents[0]).toMatch(/^advanced/);
    const treeBodies = fake.calls
      .filter((c) => c.method === "POST" && c.path === `/repos/nemarDatasets/${REPO}/git/trees`)
      .map((c) => JSON.parse(c.body!) as { base_tree: string });
    expect(treeBodies).toHaveLength(2);
    expect(treeBodies[1].base_tree).toMatch(/^advanced/);
  });

  test("fast-forward 422 exhausts retries after 3 attempts (12 calls) and throws", async () => {
    refUpdateBehavior = "conflict-always";
    const files: TreeFile[] = [{ path: "a.txt", content: "a" }];
    await expect(commitFilesAsTree(REPO, BRANCH, files, "fail test", PAT)).rejects.toThrow(
      /exhausted/,
    );
    expect(fake.calls.length).toBe(12);
  });

  test("non-fast-forward 422 (e.g. 'Reference does not exist') throws immediately, no retries", async () => {
    refUpdateBehavior = "non-ff-422";
    const files: TreeFile[] = [{ path: "a.txt", content: "a" }];
    await expect(commitFilesAsTree(REPO, BRANCH, files, "non-ff", PAT)).rejects.toThrow(
      /Reference does not exist/,
    );
    // Exactly one attempt: 4 calls.
    expect(fake.calls.length).toBe(4);
  });

  test("transient 502 on tree-creation is retried via githubFetchWithRetry", async () => {
    treeCreateBehavior = "transient-then-ok";
    treeCreateRemaining = 1;
    const files: TreeFile[] = [{ path: "a.txt", content: "a" }];
    const sha = await commitFilesAsTree(REPO, BRANCH, files, "transient", PAT);
    expect(sha).toBe(nextCommitSha);
    // 1 branch + 2 tree (502 then 201) + 1 commit + 1 ref = 5 calls.
    expect(fake.countByMethodPath[`POST /repos/nemarDatasets/${REPO}/git/trees`]).toBe(2);
    expect(fake.calls.length).toBe(5);
  }, 10_000 /* allow up to 10s for the built-in retry's 1s sleep */);

  describe("path validation (validateTreeFiles)", () => {
    test("empty path rejected before any network call", async () => {
      await expect(
        commitFilesAsTree(REPO, BRANCH, [{ path: "", content: "x" }], "bad", PAT),
      ).rejects.toThrow(/empty path/);
      expect(fake.calls.length).toBe(0);
    });

    test("absolute path rejected", async () => {
      await expect(
        commitFilesAsTree(REPO, BRANCH, [{ path: "/abs", content: "x" }], "bad", PAT),
      ).rejects.toThrow(/repo-relative/);
      expect(fake.calls.length).toBe(0);
    });

    test("trailing slash rejected", async () => {
      await expect(
        commitFilesAsTree(REPO, BRANCH, [{ path: "dir/", content: "x" }], "bad", PAT),
      ).rejects.toThrow(/not end with/);
      expect(fake.calls.length).toBe(0);
    });

    test("'..' segment rejected", async () => {
      await expect(
        commitFilesAsTree(REPO, BRANCH, [{ path: "../escape", content: "x" }], "bad", PAT),
      ).rejects.toThrow(/'\.\.' segment/);
      expect(fake.calls.length).toBe(0);
    });

    test("duplicate paths rejected", async () => {
      await expect(
        commitFilesAsTree(
          REPO,
          BRANCH,
          [
            { path: "a.txt", content: "1" },
            { path: "a.txt", content: "2" },
          ],
          "dup",
          PAT,
        ),
      ).rejects.toThrow(/duplicate path/);
      expect(fake.calls.length).toBe(0);
    });
  });
});

describe("deployWorkflows", () => {
  test("commits all workflow files in one tree-batched commit (4 calls)", async () => {
    // Disable post-deploy validation so we measure the commit path only.
    const result = await deployWorkflows(REPO, PAT, { validate: false });
    expect(result.success).toBe(true);
    expect(result.errors).toEqual([]);
    const expectedNames = getWorkflowTemplates().map((w) => w.path.split("/").pop()!);
    expect(result.deployed).toEqual(expectedNames);
    expect(fake.calls.length).toBe(4);

    // The tree body contains all workflow paths in one shot.
    const treeBody = lastBody<{ tree: Array<{ path: string }> }>(
      "POST",
      `/repos/nemarDatasets/${REPO}/git/trees`,
    );
    const submittedPaths = (treeBody?.tree ?? []).map((t) => t.path).sort();
    const expectedPaths = getWorkflowTemplates()
      .map((w) => w.path)
      .sort();
    expect(submittedPaths).toEqual(expectedPaths);
  });

  test("reports failure with a substantive error message", async () => {
    refUpdateBehavior = "conflict-always";
    const result = await deployWorkflows(REPO, PAT, { validate: false });
    expect(result.success).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(/ref|fast forward|exhausted/i);
    expect(result.deployed).toEqual([]);
  });

  test("post-deploy validation: missing workflows surface as validationErrors", async () => {
    // Fake GitHub Actions index returns only ONE of the deployed workflows.
    // The rest should land in validationErrors as "not listed" warnings.
    // success stays true because validation is best-effort (issue #287).
    const expected = getWorkflowTemplates().map((w) => w.path.split("/").pop()!);
    const listedWorkflowPath = `.github/workflows/${expected[0]}`;
    actionsWorkflowsResponse = {
      workflows: [{ path: listedWorkflowPath, name: "first" }],
    };

    const result = await deployWorkflows(REPO, PAT, { validateDelayMs: 0 });
    expect(result.success).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.deployed).toEqual(expected);
    expect(result.validationErrors).toBeDefined();
    // Every non-listed workflow filename should appear in the warning.
    const warning = (result.validationErrors ?? []).join(" ");
    for (const name of expected.slice(1)) {
      expect(warning).toContain(name);
    }
    expect(warning).not.toContain(expected[0]);
    // The validation call was made exactly once.
    expect(
      fake.countByMethodPath[`GET /repos/nemarDatasets/${REPO}/actions/workflows`],
    ).toBe(1);
  });

  test("post-deploy validation: all workflows present -> no validationErrors", async () => {
    const expected = getWorkflowTemplates().map((w) => w.path.split("/").pop()!);
    actionsWorkflowsResponse = {
      workflows: expected.map((name) => ({
        path: `.github/workflows/${name}`,
        name,
      })),
    };

    const result = await deployWorkflows(REPO, PAT, { validateDelayMs: 0 });
    expect(result.success).toBe(true);
    expect(result.validationErrors).toBeUndefined();
  });

  test("post-deploy validation: API error surfaces as best-effort warning", async () => {
    // A 500 from /actions/workflows should NOT fail the deploy. The error
    // text lands in validationErrors so admins can investigate.
    actionsWorkflowsBehavior = "server-error";

    const result = await deployWorkflows(REPO, PAT, { validateDelayMs: 0 });
    expect(result.success).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.validationErrors).toBeDefined();
    expect((result.validationErrors ?? []).join(" ")).toMatch(/500|validation/i);
  });
});

describe("commitEnrichmentWithBidsignore (admin + webhook enrichment path)", () => {
  const META_PATH = ".nemar/metadata.json";
  const META = JSON.stringify({ enriched: true });
  const ENTRIES = [".nemar/"];

  test("bidsignore missing entirely -> batched commit, .bidsignore added", async () => {
    bidsignoreExists = false;
    const result = await commitEnrichmentWithBidsignore(
      REPO,
      BRANCH,
      META_PATH,
      META,
      ENTRIES,
      "Update NEMAR metadata enrichment",
      PAT,
    );
    expect(result.commitMode).toBe("batched");
    expect(result.bidsignoreUpdated).toBe(true);
    expect(result.bidsignoreReadError).toBeUndefined();
    // The tree body should carry both files.
    const treeBody = lastBody<{ tree: Array<{ path: string; content: string }> }>(
      "POST",
      `/repos/nemarDatasets/${REPO}/git/trees`,
    );
    const paths = (treeBody?.tree ?? []).map((t) => t.path).sort();
    expect(paths).toEqual([".bidsignore", META_PATH].sort());
  });

  test("bidsignore exists but missing the entry -> batched commit, entry appended", async () => {
    bidsignoreExists = true;
    bidsignoreContent = "*.log\n";
    const result = await commitEnrichmentWithBidsignore(
      REPO,
      BRANCH,
      META_PATH,
      META,
      ENTRIES,
      "Update NEMAR metadata enrichment",
      PAT,
    );
    expect(result.commitMode).toBe("batched");
    const treeBody = lastBody<{ tree: Array<{ path: string; content: string }> }>(
      "POST",
      `/repos/nemarDatasets/${REPO}/git/trees`,
    );
    const bidsEntry = treeBody?.tree.find((t) => t.path === ".bidsignore");
    expect(bidsEntry?.content).toContain("*.log");
    expect(bidsEntry?.content).toContain(".nemar/");
  });

  test("bidsignore already contains the entry -> single-file fallback, no tree/commit calls", async () => {
    bidsignoreExists = true;
    bidsignoreContent = ".nemar/\n";
    const result = await commitEnrichmentWithBidsignore(
      REPO,
      BRANCH,
      META_PATH,
      META,
      ENTRIES,
      "Update NEMAR metadata enrichment",
      PAT,
    );
    expect(result.commitMode).toBe("single");
    expect(result.bidsignoreUpdated).toBe(false);
    // Critical: must NOT take the tree-batched path.
    expect(fake.countByMethodPath[`POST /repos/nemarDatasets/${REPO}/git/trees`]).toBe(undefined);
    expect(fake.countByMethodPath[`POST /repos/nemarDatasets/${REPO}/git/commits`]).toBe(undefined);
    // Must hit the Contents API instead.
    expect(
      fake.countByMethodPath[`PUT /repos/nemarDatasets/${REPO}/contents/${META_PATH}`],
    ).toBe(1);
  });

  test(".bidsignore read failure -> commits metadata alone, surfaces bidsignoreReadError", async () => {
    bidsignoreExists = true;
    bidsignoreBlobReadable = false; // blob fetch returns 500 -> retried 3x by githubFetchWithRetry -> throws
    const result = await commitEnrichmentWithBidsignore(
      REPO,
      BRANCH,
      META_PATH,
      META,
      ENTRIES,
      "Update NEMAR metadata enrichment",
      PAT,
    );
    expect(result.commitMode).toBe("single");
    expect(result.bidsignoreUpdated).toBe(false);
    expect(result.bidsignoreReadError).toBeDefined();
    expect(
      fake.countByMethodPath[`PUT /repos/nemarDatasets/${REPO}/contents/${META_PATH}`],
    ).toBe(1);
  }, 15_000);

  test("commit failure throws EnrichmentCommitError carrying commitMode='batched'", async () => {
    bidsignoreExists = false;
    refUpdateBehavior = "conflict-always";
    let caught: unknown;
    try {
      await commitEnrichmentWithBidsignore(
        REPO,
        BRANCH,
        META_PATH,
        META,
        ENTRIES,
        "Update NEMAR metadata enrichment",
        PAT,
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(EnrichmentCommitError);
    expect((caught as EnrichmentCommitError).commitMode).toBe("batched");
  });

  test("commit failure (single-file path) throws EnrichmentCommitError with commitMode='single'", async () => {
    bidsignoreExists = true;
    bidsignoreContent = ".nemar/\n"; // already includes entry -> single-file path
    // Make the Contents API PUT return 422 to force a single-file failure.
    // We do this by re-registering the handler at runtime via the fake's helpers.
    // Easier: use a second fake. Simpler still: temporarily flip a state knob.
    // For brevity here, use the existing 422-on-ref handler indirectly by
    // pointing at a path the fake doesn't serve PUT for.
    let caught: unknown;
    try {
      await commitEnrichmentWithBidsignore(
        REPO,
        BRANCH,
        "no-handler-for-this-path.txt",
        META,
        ENTRIES,
        "Update NEMAR metadata enrichment",
        PAT,
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(EnrichmentCommitError);
    expect((caught as EnrichmentCommitError).commitMode).toBe("single");
  });
});
