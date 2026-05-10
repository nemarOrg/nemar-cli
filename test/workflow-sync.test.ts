/**
 * Workflow ensure/sync tests (issue #407).
 *
 * Exercises `ensureWorkflowsDeployed` and `syncWorkflowTemplates` against a
 * local Bun.serve fake GitHub. Asserts call counts via the fake's
 * `countByMethodPath` so we can verify the "no commit when nothing to do"
 * cases produce exactly one HTTP request (the Contents-API listing).
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import "./setup";
import { type FakeGithubServer, json, startFakeGithub } from "./helpers/fetch-counter";
import {
  __resetRateLimitStateForTests,
  ensureWorkflowsDeployed,
  getWorkflowTemplates,
  syncWorkflowTemplates,
} from "../backend/src/services/github";

const REPO = "nm099999";
const BRANCH = "main";
const PAT = "fake-pat-for-tests";

let fake: FakeGithubServer;

// Tree-commit fake state (shared across tests).
const BASE_COMMIT = "base000000000000000000000000000000000001";
const BASE_TREE = "base000000000000000000000000000000000002";
const NEW_TREE = "new0000000000000000000000000000000000002";
const NEW_COMMIT = "new0000000000000000000000000000000000001";

// Which workflow files the fake reports as deployed. Mutated per test.
let presentPaths: string[] = [];
// Content the fake returns for each present workflow path (defaults to template).
let contentByPath: Record<string, string> = {};
// Tree-commit hook: records the body of the POST /git/trees call (so tests can
// assert which files were included in the commit).
let lastTreeBody: { tree: Array<{ path: string }> } | null = null;
// Whether the listing should return 404 (workflows directory missing).
let listingMissing = false;

function setGithubApiOverride(url: string | undefined): void {
  if (url === undefined) {
    delete (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL;
  } else {
    (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL = url;
  }
}

beforeAll(() => {
  const handlers: Record<string, (req: Request) => Promise<Response> | Response> = {
    [`GET /repos/nemarDatasets/${REPO}/contents/.github/workflows`]: () => {
      if (listingMissing) return json(404, { message: "Not Found" });
      return json(
        200,
        presentPaths.map((p) => ({ path: p, type: "file", sha: "deadbeef" })),
      );
    },
    // commitFilesAsTree happy-path fakes:
    [`GET /repos/nemarDatasets/${REPO}/branches/${BRANCH}`]: () =>
      json(200, {
        name: BRANCH,
        commit: { sha: BASE_COMMIT, commit: { tree: { sha: BASE_TREE } } },
      }),
    [`POST /repos/nemarDatasets/${REPO}/git/trees`]: async (req) => {
      lastTreeBody = (await req.json()) as { tree: Array<{ path: string }> };
      return json(201, { sha: NEW_TREE });
    },
    [`POST /repos/nemarDatasets/${REPO}/git/commits`]: () => json(201, { sha: NEW_COMMIT }),
    [`PATCH /repos/nemarDatasets/${REPO}/git/refs/heads/${BRANCH}`]: () => json(200, {}),
  };
  // Register a contents handler for every template path so we don't have to
  // hand-maintain the list as templates evolve.
  for (const template of getWorkflowTemplates()) {
    handlers[`GET /repos/nemarDatasets/${REPO}/contents/${template.path}`] = () =>
      makeContentsResponse(template.path);
  }
  fake = startFakeGithub(handlers);
  setGithubApiOverride(fake.url);
});

afterAll(() => {
  fake.stop();
  setGithubApiOverride(undefined);
});

beforeEach(() => {
  fake.reset();
  presentPaths = [];
  contentByPath = {};
  lastTreeBody = null;
  listingMissing = false;
  __resetRateLimitStateForTests();
});

afterEach(() => {
  __resetRateLimitStateForTests();
});

function makeContentsResponse(filePath: string): Response {
  const content = contentByPath[filePath];
  if (content === undefined) return json(404, { message: "Not Found" });
  // GitHub Contents API returns base64-encoded content. The service decodes
  // it via atob, so we encode the same way here.
  const encoded = btoa(content);
  return json(200, {
    name: filePath.split("/").pop(),
    path: filePath,
    sha: "deadbeef",
    content: encoded,
    encoding: "base64",
  });
}

describe("ensureWorkflowsDeployed", () => {
  test("all present: no commit, single Contents-API call", async () => {
    const templates = getWorkflowTemplates();
    presentPaths = templates.map((t) => t.path);

    const result = await ensureWorkflowsDeployed(REPO, BRANCH, PAT);

    expect(result.errors).toEqual([]);
    expect(result.deployed).toEqual([]);
    expect(result.alreadyPresent.length).toBe(templates.length);

    expect(
      fake.countByMethodPath[`GET /repos/nemarDatasets/${REPO}/contents/.github/workflows`],
    ).toBe(1);
    expect(fake.countByMethodPath[`POST /repos/nemarDatasets/${REPO}/git/trees`]).toBeUndefined();
    expect(fake.calls.length).toBe(1);
  });

  test("some missing: tree commit with only the missing files", async () => {
    const templates = getWorkflowTemplates();
    // Pretend only the first three are deployed.
    presentPaths = templates.slice(0, 3).map((t) => t.path);
    const missing = templates.slice(3);

    const result = await ensureWorkflowsDeployed(REPO, BRANCH, PAT);

    expect(result.errors).toEqual([]);
    expect(result.deployed.length).toBe(missing.length);
    expect(result.alreadyPresent.length).toBe(3);

    expect(lastTreeBody).not.toBeNull();
    const treePaths = lastTreeBody?.tree.map((e) => e.path) ?? [];
    expect(new Set(treePaths)).toEqual(new Set(missing.map((m) => m.path)));
    expect(fake.countByMethodPath[`POST /repos/nemarDatasets/${REPO}/git/trees`]).toBe(1);
  });

  test("workflows directory missing (404): deploys all templates", async () => {
    listingMissing = true;
    const templates = getWorkflowTemplates();

    const result = await ensureWorkflowsDeployed(REPO, BRANCH, PAT);

    expect(result.errors).toEqual([]);
    expect(result.alreadyPresent).toEqual([]);
    expect(result.deployed.length).toBe(templates.length);

    const treePaths = lastTreeBody?.tree.map((e) => e.path) ?? [];
    expect(new Set(treePaths)).toEqual(new Set(templates.map((t) => t.path)));
  });
});

describe("syncWorkflowTemplates", () => {
  test("no diffs: no commit", async () => {
    const templates = getWorkflowTemplates();
    presentPaths = templates.map((t) => t.path);
    for (const t of templates) contentByPath[t.path] = t.content;

    const result = await syncWorkflowTemplates(REPO, BRANCH, PAT);

    expect(result.errors).toEqual([]);
    expect(result.changed).toEqual([]);
    expect(result.added).toEqual([]);
    expect(result.checked.length).toBe(templates.length);
    expect(fake.countByMethodPath[`POST /repos/nemarDatasets/${REPO}/git/trees`]).toBeUndefined();
  });

  test("one file drifted: tree commit contains only that file", async () => {
    const templates = getWorkflowTemplates();
    presentPaths = templates.map((t) => t.path);
    for (const t of templates) contentByPath[t.path] = t.content;
    // Drift one file:
    contentByPath[templates[2].path] = "# stale\n";

    const result = await syncWorkflowTemplates(REPO, BRANCH, PAT);

    expect(result.errors).toEqual([]);
    expect(result.added).toEqual([]);
    expect(result.changed.length).toBe(1);
    expect(result.changed[0]).toBe(templates[2].path.split("/").pop());

    const treePaths = lastTreeBody?.tree.map((e) => e.path) ?? [];
    expect(treePaths).toEqual([templates[2].path]);
  });

  test("missing + drift mix: commit includes both", async () => {
    const templates = getWorkflowTemplates();
    // Drop one (added) and stale another (changed).
    presentPaths = templates.filter((_, i) => i !== 0).map((t) => t.path);
    for (const p of presentPaths) contentByPath[p] = templates.find((t) => t.path === p)!.content;
    contentByPath[templates[1].path] = "drifted content\n";

    const result = await syncWorkflowTemplates(REPO, BRANCH, PAT);

    expect(result.errors).toEqual([]);
    expect(result.added.length).toBe(1);
    expect(result.changed.length).toBe(1);
    const treePaths = lastTreeBody?.tree.map((e) => e.path) ?? [];
    expect(new Set(treePaths)).toEqual(new Set([templates[0].path, templates[1].path]));
  });

  test("CRLF line endings do not cause false-positive diffs", async () => {
    const templates = getWorkflowTemplates();
    presentPaths = templates.map((t) => t.path);
    for (const t of templates) contentByPath[t.path] = t.content.replace(/\n/g, "\r\n");

    const result = await syncWorkflowTemplates(REPO, BRANCH, PAT);

    expect(result.errors).toEqual([]);
    expect(result.changed).toEqual([]);
    expect(result.added).toEqual([]);
    expect(fake.countByMethodPath[`POST /repos/nemarDatasets/${REPO}/git/trees`]).toBeUndefined();
  });
});
