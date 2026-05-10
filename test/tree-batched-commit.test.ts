/**
 * Tree-batched commit tests (issue #407).
 *
 * Exercises `commitFilesAsTree` and `deployWorkflows` against a local
 * Bun.serve fake GitHub so call counts and request shapes are deterministic.
 *
 * The fake is a real HTTP server, not a fetch-level mock; production code
 * runs the same network path it would against api.github.com.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import "./setup"; // ensures NEMAR_CONFIG_DIR isolation
import { type FakeGithubServer, json, startFakeGithub } from "./helpers/fetch-counter";

import {
  type TreeFile,
  commitFilesAsTree,
  deployWorkflows,
  getWorkflowTemplates,
} from "../backend/src/services/github";

const REPO = "nm099999";
const BRANCH = "main";
const PAT = "fake-pat-for-tests";

let fake: FakeGithubServer;
let baseCommitSha: string;
let baseTreeSha: string;
let nextCommitSha: string;
let nextTreeSha: string;
let refUpdateBehavior: "ok" | "conflict-then-ok" | "conflict-always";
let conflictAttemptsRemaining: number;

/** Reset the fake's state for a clean per-test scenario. */
function resetState() {
  fake.reset();
  baseCommitSha = "base000000000000000000000000000000000001";
  baseTreeSha = "base000000000000000000000000000000000002";
  nextCommitSha = "new0000000000000000000000000000000000001";
  nextTreeSha = "new0000000000000000000000000000000000002";
  refUpdateBehavior = "ok";
  conflictAttemptsRemaining = 0;
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
    [`POST /repos/nemarDatasets/${REPO}/git/trees`]: () =>
      json(201, { sha: nextTreeSha }),
    [`POST /repos/nemarDatasets/${REPO}/git/commits`]: () =>
      json(201, { sha: nextCommitSha }),
    [`PATCH /repos/nemarDatasets/${REPO}/git/refs/heads/${BRANCH}`]: () => {
      if (refUpdateBehavior === "conflict-always") {
        return json(422, { message: "Update is not a fast forward" });
      }
      if (refUpdateBehavior === "conflict-then-ok" && conflictAttemptsRemaining > 0) {
        conflictAttemptsRemaining--;
        // Advance the base so the retry sees a moved ref.
        baseCommitSha = `advanced${conflictAttemptsRemaining.toString().padStart(32, "0")}`;
        return json(422, { message: "Update is not a fast forward" });
      }
      return json(200, { ref: `refs/heads/${BRANCH}`, object: { sha: nextCommitSha } });
    },
    [`GET /repos/nemarDatasets/${REPO}/git/ref/heads/${BRANCH}`]: () =>
      json(200, { ref: `refs/heads/${BRANCH}`, object: { sha: baseCommitSha } }),
    [`PUT /repos/nemarDatasets/${REPO}/contents/.bidsignore`]: () =>
      json(201, { content: { sha: "blob0001" }, commit: { sha: nextCommitSha } }),
    [`GET /repos/nemarDatasets/${REPO}/contents/.bidsignore`]: () =>
      json(404, { message: "Not Found" }),
    [`PUT /repos/nemarDatasets/${REPO}/contents/.nemar/metadata.json`]: () =>
      json(201, { content: { sha: "blob0002" }, commit: { sha: nextCommitSha } }),
    [`GET /repos/nemarDatasets/${REPO}/contents/.nemar/metadata.json`]: () =>
      json(404, { message: "Not Found" }),
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

describe("commitFilesAsTree", () => {
  test("empty files array short-circuits to current SHA with no write calls", async () => {
    const result = await commitFilesAsTree(REPO, BRANCH, [], "noop", PAT);
    expect(result).toBe(baseCommitSha);
    // Only the ref-read for the short-circuit return path.
    const writes = Object.entries(fake.countByMethodPath)
      .filter(([k]) => k.startsWith("POST ") || k.startsWith("PATCH "))
      .reduce((sum, [, v]) => sum + v, 0);
    expect(writes).toBe(0);
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

  test("six-file commit (deployWorkflows shape) still makes exactly 4 calls", async () => {
    const files: TreeFile[] = Array.from({ length: 6 }, (_, i) => ({
      path: `.github/workflows/w${i}.yml`,
      content: `name: w${i}\non: push\njobs: {}\n`,
    }));
    await commitFilesAsTree(REPO, BRANCH, files, "Add 6 files", PAT);
    expect(fake.calls.length).toBe(4);
  });

  test("ref-update 422 conflict retries with fresh base, succeeds on second attempt", async () => {
    refUpdateBehavior = "conflict-then-ok";
    conflictAttemptsRemaining = 1;
    const files: TreeFile[] = [{ path: "a.txt", content: "a" }];
    const sha = await commitFilesAsTree(REPO, BRANCH, files, "retry test", PAT);
    expect(sha).toBe(nextCommitSha);
    // 4 calls in attempt 1 (conflict) + 4 in attempt 2 (success) = 8.
    expect(fake.calls.length).toBe(8);
    expect(fake.countByMethodPath[`GET /repos/nemarDatasets/${REPO}/branches/${BRANCH}`]).toBe(2);
  });

  test("ref-update 422 conflict exhausts retries and throws", async () => {
    refUpdateBehavior = "conflict-always";
    const files: TreeFile[] = [{ path: "a.txt", content: "a" }];
    await expect(commitFilesAsTree(REPO, BRANCH, files, "fail test", PAT)).rejects.toThrow();
    // 3 attempts x 4 calls each = 12 calls before giving up.
    expect(fake.calls.length).toBe(12);
  });
});

describe("deployWorkflows", () => {
  test("commits all workflow files in a single tree-batched commit (4 calls total)", async () => {
    const result = await deployWorkflows(REPO, PAT);
    expect(result.success).toBe(true);
    expect(result.errors).toEqual([]);
    const expectedNames = getWorkflowTemplates().map((w) => w.path.split("/").pop()!);
    expect(result.deployed).toEqual(expectedNames);
    // Critical assertion: regardless of how many workflow templates exist,
    // we make exactly 4 GitHub calls (vs the old 2N pattern).
    expect(fake.calls.length).toBe(4);
  });

  test("reports failure when the tree-batched commit fails", async () => {
    refUpdateBehavior = "conflict-always";
    const result = await deployWorkflows(REPO, PAT);
    expect(result.success).toBe(false);
    expect(result.errors.length).toBe(1);
    expect(result.deployed).toEqual([]);
  });
});
