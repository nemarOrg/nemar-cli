/**
 * Unit tests for `triggerArchiveGeneration` after Phase 3 centralization
 * (#608).
 *
 * The helper used to dispatch against the per-dataset repo where the legacy
 * `generate-archive.yml` listened; it now dispatches against
 * `nemarDatasets/.github` where the central `run-generate-archive.yml`
 * lives. The `client_payload` shape is unchanged — `dataset_id`, `version`,
 * `public` — so existing callers (admin endpoints, CLI, version-doi
 * workflow) don't need to update their call sites.
 *
 * Mirrors trigger-enrichment.test.ts (#602) and trigger-version-doi.test.ts
 * (#606).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import "./setup";
import { triggerArchiveGeneration } from "../backend/src/services/github";
import { type FakeGithubServer, startFakeGithub } from "./helpers/fetch-counter";

const CENTRAL_DISPATCH_PATH = "/repos/nemarDatasets/.github/dispatches";

let fake: FakeGithubServer;
let nextResponse: () => Response = () => new Response(null, { status: 204 });

function setGithubApiOverride(url: string | undefined): void {
  if (url === undefined) {
    delete (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL;
  } else {
    (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL = url;
  }
}

beforeAll(() => {
  fake = startFakeGithub({
    [`POST ${CENTRAL_DISPATCH_PATH}`]: () => nextResponse(),
  });
  setGithubApiOverride(fake.url);
});

afterAll(() => {
  fake.stop();
  setGithubApiOverride(undefined);
});

beforeEach(() => {
  fake.reset();
  nextResponse = () => new Response(null, { status: 204 });
});

describe("triggerArchiveGeneration", () => {
  test("dispatches against nemarDatasets/.github (not the dataset repo)", async () => {
    await triggerArchiveGeneration("nm099999", "nm099999", "1.0.0", "test-pat");

    expect(fake.calls.length).toBe(1);
    const call = fake.calls[0];
    expect(call.method).toBe("POST");
    expect(call.path).toBe(CENTRAL_DISPATCH_PATH);
  });

  test("client_payload carries dataset_id, version, public", async () => {
    await triggerArchiveGeneration("nm099999", "nm099999", "1.0.0", "test-pat", { public: true });

    const body = JSON.parse(fake.calls[0].body ?? "{}") as {
      event_type: string;
      client_payload: { dataset_id: string; version: string; public: boolean };
    };
    expect(body.event_type).toBe("generate-archive");
    expect(body.client_payload).toEqual({
      dataset_id: "nm099999",
      version: "1.0.0",
      public: true,
    });
  });

  test("public defaults to false when not provided", async () => {
    await triggerArchiveGeneration("nm099999", "nm099999", "2.0.0", "test-pat");

    const body = JSON.parse(fake.calls[0].body ?? "{}") as {
      client_payload: { public: boolean };
    };
    expect(body.client_payload.public).toBe(false);
  });

  test("throws with HTTP status + body on non-2xx", async () => {
    nextResponse = () =>
      new Response(JSON.stringify({ message: "Not Found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });

    let caught: unknown;
    try {
      await triggerArchiveGeneration("nm000999", "nm000999", "1.0.0", "test-pat");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    const msg = (caught as Error).message;
    expect(msg).toContain("HTTP 404");
    expect(msg).toContain("Not Found");
  });

  test("warns but still dispatches when legacy repo parameter doesn't match dataset_id", async () => {
    // The signature preserves the legacy `repo` parameter for callsite
    // stability. After Phase 3 the parameter is no longer used to address
    // the dispatch target (which is always .github), only logged. Verify
    // the dispatch goes through with the dataset_id from the second
    // argument regardless of what `repo` says.
    await triggerArchiveGeneration("some-legacy-name", "nm099999", "1.0.0", "test-pat");

    expect(fake.calls.length).toBe(1);
    expect(fake.calls[0].path).toBe(CENTRAL_DISPATCH_PATH);
    const body = JSON.parse(fake.calls[0].body ?? "{}") as {
      client_payload: { dataset_id: string };
    };
    expect(body.client_payload.dataset_id).toBe("nm099999");
  });
});
