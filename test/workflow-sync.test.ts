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
// When set, the listing endpoint returns this HTTP status (overrides
// `listingMissing`). Used to simulate non-404 listing errors.
let listingStatusOverride: number | null = null;
// When set, the ref-update endpoint fails so commitFilesAsTree throws.
let refUpdateShouldFail = false;
// Paths whose content endpoint should return the given status instead of
// the normal content response. Used to test read failures.
let contentEndpointStatus: Record<string, number> = {};
// When non-null, the listing endpoint returns this exact entry list
// (overrides `presentPaths`). Used to test non-file `type` values.
let listingEntriesOverride: Array<{ path: string; type: string; sha: string }> | null = null;

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
      if (listingStatusOverride !== null)
        return json(listingStatusOverride, { message: "Simulated failure" });
      if (listingMissing) return json(404, { message: "Not Found" });
      if (listingEntriesOverride !== null) return json(200, listingEntriesOverride);
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
    [`PATCH /repos/nemarDatasets/${REPO}/git/refs/heads/${BRANCH}`]: () => {
      if (refUpdateShouldFail) {
        // 422 with a non-fast-forward-conflict body is terminal (no retry).
        return json(422, { message: "Reference does not exist" });
      }
      return json(200, {});
    },
  };
  // Register a contents handler for every template path so we don't have to
  // hand-maintain the list as templates evolve.
  for (const template of getWorkflowTemplates()) {
    handlers[`GET /repos/nemarDatasets/${REPO}/contents/${template.path}`] = () => {
      const override = contentEndpointStatus[template.path];
      if (override !== undefined) return json(override, { message: "Simulated read failure" });
      return makeContentsResponse(template.path);
    };
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
  listingStatusOverride = null;
  refUpdateShouldFail = false;
  contentEndpointStatus = {};
  listingEntriesOverride = null;
  __resetRateLimitStateForTests();
});

afterEach(() => {
  __resetRateLimitStateForTests();
});

function makeContentsResponse(filePath: string): Response {
  const content = contentByPath[filePath];
  if (content === undefined) return json(404, { message: "Not Found" });
  // Match the byte-level wire format GitHub uses: UTF-8 encode then base64,
  // so non-Latin1 characters like a UTF-8 BOM (U+FEFF) round-trip correctly.
  // `btoa(content)` would throw on those.
  const bytes = new TextEncoder().encode(content);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  const encoded = btoa(binary);
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
    expect(result.listFailed).toBe(false);

    expect(
      fake.countByMethodPath[`GET /repos/nemarDatasets/${REPO}/contents/.github/workflows`],
    ).toBe(1);
    expect(fake.countByMethodPath[`POST /repos/nemarDatasets/${REPO}/git/trees`]).toBeUndefined();
    expect(fake.calls.length).toBe(1);
  });

  test("some missing: tree commit with only the missing files", async () => {
    const templates = getWorkflowTemplates();
    presentPaths = templates.slice(0, 3).map((t) => t.path);
    const missing = templates.slice(3);

    const result = await ensureWorkflowsDeployed(REPO, BRANCH, PAT);

    expect(result.errors).toEqual([]);
    expect(result.deployed.length).toBe(missing.length);
    expect(result.alreadyPresent.length).toBe(3);
    expect(result.listFailed).toBe(false);

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
    expect(result.listFailed).toBe(false);

    const treePaths = lastTreeBody?.tree.map((e) => e.path) ?? [];
    expect(new Set(treePaths)).toEqual(new Set(templates.map((t) => t.path)));
  });

  test("listing fails (non-404): listFailed=true, no commit, error recorded", async () => {
    // 422 is a terminal status (no retry) so the test finishes fast while
    // still exercising the listing-failure path.
    listingStatusOverride = 422;

    const result = await ensureWorkflowsDeployed(REPO, BRANCH, PAT);

    expect(result.listFailed).toBe(true);
    expect(result.alreadyPresent).toEqual([]);
    expect(result.deployed).toEqual([]);
    expect(result.errors.length).toBe(1);
    expect(fake.countByMethodPath[`POST /repos/nemarDatasets/${REPO}/git/trees`]).toBeUndefined();
  });

  test("commit failure: deployed=[], error recorded, alreadyPresent preserved", async () => {
    const templates = getWorkflowTemplates();
    presentPaths = templates.slice(0, 2).map((t) => t.path);
    refUpdateShouldFail = true;

    const result = await ensureWorkflowsDeployed(REPO, BRANCH, PAT);

    expect(result.deployed).toEqual([]);
    expect(result.alreadyPresent.length).toBe(2);
    expect(result.errors.length).toBe(1);
    expect(result.listFailed).toBe(false);
  });

  test("symlinked workflow is treated as MISSING and replaced (not skipped)", async () => {
    // Older DataLad-style repos can have workflow YAMLs annexed, which
    // GitHub returns as `type: "symlink"`. Actions cannot read or execute
    // those, so a symlinked workflow looks deployed in the Contents API
    // but is actually broken. ensureWorkflowsDeployed must overwrite it
    // with a real file blob instead of skipping it.
    const templates = getWorkflowTemplates();
    listingEntriesOverride = templates.map((t, i) => ({
      path: t.path,
      type: i === 0 ? "symlink" : "file",
      sha: "deadbeef",
    }));

    const result = await ensureWorkflowsDeployed(REPO, BRANCH, PAT);

    // The symlinked entry must be in `deployed`, not `alreadyPresent`.
    const symlinkName = templates[0].path.split("/").pop();
    expect(result.deployed).toEqual([symlinkName as string]);
    expect(result.alreadyPresent).not.toContain(symlinkName as string);
    // A tree commit must have been issued for the missing/symlinked file.
    expect(fake.countByMethodPath[`POST /repos/nemarDatasets/${REPO}/git/trees`]).toBe(1);
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
    expect(result.committed).toBe(false);
    expect(result.listFailed).toBe(false);
    expect(fake.countByMethodPath[`POST /repos/nemarDatasets/${REPO}/git/trees`]).toBeUndefined();
  });

  test("one file drifted: tree commit contains only that file", async () => {
    const templates = getWorkflowTemplates();
    presentPaths = templates.map((t) => t.path);
    for (const t of templates) contentByPath[t.path] = t.content;
    contentByPath[templates[2].path] = "# stale\n";

    const result = await syncWorkflowTemplates(REPO, BRANCH, PAT);

    expect(result.errors).toEqual([]);
    expect(result.added).toEqual([]);
    expect(result.changed.length).toBe(1);
    expect(result.changed[0]).toBe(templates[2].path.split("/").pop());
    expect(result.committed).toBe(true);

    const treePaths = lastTreeBody?.tree.map((e) => e.path) ?? [];
    expect(treePaths).toEqual([templates[2].path]);
    expect(fake.countByMethodPath[`POST /repos/nemarDatasets/${REPO}/git/trees`]).toBe(1);
  });

  test("missing + drift mix: commit includes both", async () => {
    const templates = getWorkflowTemplates();
    presentPaths = templates.filter((_, i) => i !== 0).map((t) => t.path);
    for (const p of presentPaths) contentByPath[p] = templates.find((t) => t.path === p)!.content;
    contentByPath[templates[1].path] = "drifted content\n";

    const result = await syncWorkflowTemplates(REPO, BRANCH, PAT);

    expect(result.errors).toEqual([]);
    expect(result.added.length).toBe(1);
    expect(result.changed.length).toBe(1);
    expect(result.committed).toBe(true);
    const treePaths = lastTreeBody?.tree.map((e) => e.path) ?? [];
    expect(new Set(treePaths)).toEqual(new Set([templates[0].path, templates[1].path]));
    expect(fake.countByMethodPath[`POST /repos/nemarDatasets/${REPO}/git/trees`]).toBe(1);
  });

  test("CRLF line endings do not cause false-positive diffs", async () => {
    const templates = getWorkflowTemplates();
    presentPaths = templates.map((t) => t.path);
    for (const t of templates) contentByPath[t.path] = t.content.replace(/\n/g, "\r\n");

    const result = await syncWorkflowTemplates(REPO, BRANCH, PAT);

    expect(result.errors).toEqual([]);
    expect(result.changed).toEqual([]);
    expect(result.added).toEqual([]);
    expect(result.committed).toBe(false);
    expect(fake.countByMethodPath[`POST /repos/nemarDatasets/${REPO}/git/trees`]).toBeUndefined();
  });

  test("UTF-8 BOM and trailing whitespace do not cause false-positive diffs", async () => {
    const templates = getWorkflowTemplates();
    presentPaths = templates.map((t) => t.path);
    for (const t of templates) {
      // Prefix BOM and drop the trailing newline (worst-case round-trip
      // through Windows editor + missing-newline-at-EOF).
      contentByPath[t.path] = `﻿${t.content.replace(/\n+$/, "")}`;
    }

    const result = await syncWorkflowTemplates(REPO, BRANCH, PAT);

    expect(result.errors).toEqual([]);
    expect(result.changed).toEqual([]);
    expect(result.committed).toBe(false);
  });

  test("per-file read failure: file is skipped, error recorded, others sync", async () => {
    const templates = getWorkflowTemplates();
    presentPaths = templates.map((t) => t.path);
    for (const t of templates) contentByPath[t.path] = t.content;
    // Make one read fail and another drift; the drift should still commit
    // even though the failed read is left untouched.
    contentEndpointStatus[templates[0].path] = 422; // terminal, fast
    contentByPath[templates[1].path] = "drifted content\n";

    const result = await syncWorkflowTemplates(REPO, BRANCH, PAT);

    expect(result.errors.length).toBe(1);
    expect(result.errors[0]).toContain(templates[0].path);
    expect(result.changed.length).toBe(1);
    expect(result.changed[0]).toBe(templates[1].path.split("/").pop());
    expect(result.committed).toBe(true);
    const treePaths = lastTreeBody?.tree.map((e) => e.path) ?? [];
    expect(treePaths).toEqual([templates[1].path]); // failed-read file NOT in the commit
  });

  test("commit failure: intended changed/added preserved, committed=false", async () => {
    const templates = getWorkflowTemplates();
    presentPaths = templates.filter((_, i) => i !== 0).map((t) => t.path);
    for (const p of presentPaths) contentByPath[p] = templates.find((t) => t.path === p)!.content;
    contentByPath[templates[1].path] = "drifted\n";
    refUpdateShouldFail = true;

    const result = await syncWorkflowTemplates(REPO, BRANCH, PAT);

    // Both the added and changed lists are preserved so callers can see what
    // we wanted to write; `committed: false` distinguishes from happy "no diff".
    expect(result.added.length).toBe(1);
    expect(result.changed.length).toBe(1);
    expect(result.committed).toBe(false);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]).toContain("commit failed");
  });

  test("listing failure: listFailed=true, no read attempts, error recorded", async () => {
    listingStatusOverride = 422;

    const result = await syncWorkflowTemplates(REPO, BRANCH, PAT);

    expect(result.listFailed).toBe(true);
    expect(result.changed).toEqual([]);
    expect(result.added).toEqual([]);
    expect(result.committed).toBe(false);
    expect(result.errors.length).toBe(1);
    expect(fake.countByMethodPath[`POST /repos/nemarDatasets/${REPO}/git/trees`]).toBeUndefined();
  });
});
