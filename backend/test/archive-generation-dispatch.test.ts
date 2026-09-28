/**
 * `triggerArchiveGeneration`'s client_payload carries `total_bytes`/
 * `total_files` when the caller has them (#1514), so the central workflow's
 * preflight can apply the archive size policy without depending on the
 * version manifest being publicly fetchable (it isn't for a private
 * dataset, an anonymous deposit before release, or a version whose
 * `dataset_versions` row hasn't landed yet -- the nm000284 incident).
 *
 * Real engine: driven against a `Bun.serve()` stand-in for api.github.com,
 * same pattern as manifest-dispatch-bucket-guard.test.ts. No mocks: the
 * shape sent is read straight off the request the fake server received.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { CENTRAL_WORKFLOW_REPO, triggerArchiveGeneration } from "../src/services/github/dispatch";

let server: Server;
let dispatches: Array<{ path: string; body: unknown }> = [];

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      dispatches.push({ path: url.pathname, body: await request.json() });
      return new Response(null, { status: 204 });
    },
  });
  (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL =
    `http://127.0.0.1:${server.port}`;
});

afterEach(() => {
  dispatches = [];
});

afterAll(() => {
  (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL = undefined;
  server.stop(true);
});

interface ArchiveDispatchBody {
  event_type: string;
  client_payload: {
    dataset_id: string;
    version: string;
    public: boolean;
    total_bytes?: number;
    total_files?: number;
  };
}

describe("triggerArchiveGeneration client_payload", () => {
  test("carries total_bytes/total_files when the caller supplies them", async () => {
    await triggerArchiveGeneration("nm000010", "nm000010", "1.0.0", "test-token", {
      totalBytes: 5 * 1024 * 1024 * 1024,
      totalFiles: 200,
    });

    expect(dispatches).toHaveLength(1);
    expect(dispatches[0].path).toBe(`/repos/${CENTRAL_WORKFLOW_REPO}/dispatches`);
    const body = dispatches[0].body as ArchiveDispatchBody;
    expect(body.event_type).toBe("generate-archive");
    expect(body.client_payload.dataset_id).toBe("nm000010");
    expect(body.client_payload.total_bytes).toBe(5 * 1024 * 1024 * 1024);
    expect(body.client_payload.total_files).toBe(200);
  });

  test("omits total_bytes/total_files when the caller has nothing to offer", async () => {
    // Old-caller compatibility: a dispatch with no options at all sends
    // exactly the pre-#1514 payload shape.
    await triggerArchiveGeneration("nm000011", "nm000011", "2.0.0", "test-token");

    expect(dispatches).toHaveLength(1);
    const body = dispatches[0].body as ArchiveDispatchBody;
    expect(body.client_payload.total_bytes).toBeUndefined();
    expect(body.client_payload.total_files).toBeUndefined();
    expect("total_bytes" in body.client_payload).toBe(false);
    expect("total_files" in body.client_payload).toBe(false);
  });

  test("null (unknown) totals are omitted the same way as absent ones", async () => {
    await triggerArchiveGeneration("nm000012", "nm000012", "1.0.0", "test-token", {
      totalBytes: null,
      totalFiles: null,
      s3Bucket: "nemar",
    });

    expect(dispatches).toHaveLength(1);
    const body = dispatches[0].body as ArchiveDispatchBody;
    expect("total_bytes" in body.client_payload).toBe(false);
    expect("total_files" in body.client_payload).toBe(false);
  });
});
