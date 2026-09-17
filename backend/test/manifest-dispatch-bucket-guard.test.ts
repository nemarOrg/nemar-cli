/**
 * The central manifest dispatch refuses a bucket the workflow will ignore (#1451).
 *
 * `generate-manifest.yml` in `nemarDatasets/.github` hardcodes `S3_BUCKET: nemar`
 * and never reads `client_payload.s3_bucket`, even though epic #923 added the
 * field and a comment saying the workflow follows it. So a dispatch from the dev
 * worker does not write to the dev bucket; it writes a dev dataset's manifest
 * over the production prefix. Found while looking for a way to heal `nm099998`'s
 * manifest on dev, which is exactly the moment the parameter looks safe to trust.
 *
 * Real engine: `triggerManifestGeneration` is driven as the entry point against
 * a `Bun.serve()` stand-in for api.github.com. The refusal is asserted by what
 * the server did NOT receive, and the prod-bucket case pins that the same call
 * does dispatch, so a guard that refused everything would fail here.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import {
  CENTRAL_MANIFEST_BUCKET,
  CENTRAL_WORKFLOW_REPO,
  triggerManifestGeneration,
} from "../src/services/github/dispatch";

const DATASET = "nm099998";
const VERSION = "1.0.0";

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

function dispatch(s3Bucket: string | undefined) {
  return triggerManifestGeneration(
    DATASET,
    VERSION,
    "10.5072/fk2nm099998.v1.0.0",
    "10.5072/fk2nm099998",
    "",
    "",
    "test-token",
    { skipCallback: true, s3Bucket },
  );
}

describe("triggerManifestGeneration and the bucket the workflow really uses", () => {
  test("refuses a non-production bucket, and sends nothing", async () => {
    await expect(dispatch("nemar-dev")).rejects.toThrow(/Refusing to dispatch/);
    expect(dispatches).toEqual([]);
  });

  test("names the bucket, the dataset version and the reason", async () => {
    // An operator reading this has to learn that the parameter is inert, not
    // that "the dispatch failed" -- the whole failure is that it would succeed.
    let message = "";
    try {
      await dispatch("nemar-staging");
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain('"nemar-staging"');
    expect(message).toContain(`${DATASET}@${VERSION}`);
    expect(message).toContain("ignores s3_bucket");
    expect(message).toContain("inline");
  });

  test("dispatches for the production bucket", async () => {
    await dispatch(CENTRAL_MANIFEST_BUCKET);

    expect(dispatches).toHaveLength(1);
    expect(dispatches[0].path).toBe(`/repos/${CENTRAL_WORKFLOW_REPO}/dispatches`);
    const body = dispatches[0].body as {
      event_type: string;
      client_payload: { dataset_id: string; s3_bucket: string };
    };
    expect(body.event_type).toBe("generate-manifest");
    expect(body.client_payload.dataset_id).toBe(DATASET);
    expect(body.client_payload.s3_bucket).toBe(CENTRAL_MANIFEST_BUCKET);
  });

  test("dispatches when no bucket is given, which the workflow reads as production", async () => {
    await dispatch(undefined);

    expect(dispatches).toHaveLength(1);
    const body = dispatches[0].body as { client_payload: { s3_bucket?: string } };
    expect(body.client_payload.s3_bucket).toBeUndefined();
  });
});
