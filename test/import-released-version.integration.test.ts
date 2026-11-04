/**
 * `hasReleasedVersion`, which the import's upstream-moved guard asks before it decides between a
 * refusal and a retarget (epic #1046 Phase 3, ADR 0111 decision 10).
 *
 * Two halves. Against a local server in the backend's response shapes, the answers the guard can
 * get, error paths included: a missing dataset is "not released", and every way of not knowing
 * (a backend without the route, a 500, a body without a list) throws, because "not released" is
 * what lets an import move a dataset to a new tag. Against the live dev backend, when the run is
 * configured for it (TEST_API_URL and TEST_ADMIN_API_KEY): a released exemplar answers true and
 * `nm099900`, the id reserved never to resolve (ADR 0068), answers false.
 *
 * Integration tier: it reaches the dev backend. The local half points the API client at its own
 * server for its own describe block and restores the environment after.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "./setup";
import { hasReleasedVersion } from "../src/lib/api/datasets";
import { LIVE_TARGET_BLOCKED, TEST_CONFIG } from "./setup";

const LIVE_URL = process.env.TEST_API_URL;

function useAccount(apiUrl: string, apiKey: string): () => void {
  const saved = {
    NEMAR_CONFIG_DIR: process.env.NEMAR_CONFIG_DIR,
    TEST_API_URL: process.env.TEST_API_URL,
  };
  const dir = mkdtempSync(join(tmpdir(), "nemar-released-version-"));
  writeFileSync(
    join(dir, "config.json"),
    JSON.stringify({ activeAccount: "guard", accounts: { guard: { apiKey, apiUrl } } }),
  );
  process.env.NEMAR_CONFIG_DIR = dir;
  process.env.TEST_API_URL = apiUrl;
  return () => {
    rmSync(dir, { recursive: true, force: true });
    for (const [k, v] of Object.entries(saved)) {
      // Reflect.deleteProperty, never `= undefined`, which stores the string "undefined".
      if (v === undefined) Reflect.deleteProperty(process.env, k);
      else process.env[k] = v;
    }
  };
}

describe("what each answer of GET /datasets/:id/versions means to the guard", () => {
  let server: ReturnType<typeof Bun.serve>;
  let restore: () => void;
  const version = { version: "v1.0.0", doi: "10.5072/FK2X", provider: "ezid", created_at: "x" };

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      fetch(req) {
        const path = new URL(req.url).pathname;
        const id = path.split("/")[2];
        switch (id) {
          case "on000001":
            return Response.json({ dataset_id: id, current_version: "1.0.0", versions: [version] });
          case "on000002":
            return Response.json({ dataset_id: id, current_version: "1.0.0", versions: [] });
          case "on000003":
            return Response.json({ error: "Dataset not found" }, { status: 404 });
          case "on000004":
            // backend/src/lib/not-found.ts: what a Worker without the route answers.
            return Response.json(
              { error: "Not Found", message: `Route GET ${path} not found` },
              { status: 404 },
            );
          case "on000005":
            return Response.json({ error: "Internal error" }, { status: 500 });
          default:
            return Response.json({ dataset_id: id, current_version: "1.0.0" });
        }
      },
    });
    restore = useAccount(`http://localhost:${server.port}`, "k");
  });

  afterAll(() => {
    restore();
    server.stop(true);
  });

  test("a version row is released; none is not; a dataset the backend lacks is not", async () => {
    expect(await hasReleasedVersion("on000001")).toBe(true);
    expect(await hasReleasedVersion("on000002")).toBe(false);
    expect(await hasReleasedVersion("on000003")).toBe(false);
  });

  test("not knowing throws: a backend without the route, a 500, a body without a list", async () => {
    await expect(hasReleasedVersion("on000004")).rejects.toThrow();
    await expect(hasReleasedVersion("on000005")).rejects.toThrow();
    await expect(hasReleasedVersion("on000006")).rejects.toThrow(/without a versions list/);
  });
});

const LIVE = LIVE_URL !== undefined && !LIVE_TARGET_BLOCKED && TEST_CONFIG.adminApiKey.length > 0;

describe.skipIf(!LIVE)("against the live dev backend", () => {
  let restore: () => void;
  beforeAll(() => {
    restore = useAccount(LIVE_URL as string, TEST_CONFIG.adminApiKey);
  });
  afterAll(() => restore());

  test("a released exemplar is released; the id reserved never to resolve is not", async () => {
    // xx099900 is the first of the exemplar fleet, published in dev with sandbox DOIs.
    expect(await hasReleasedVersion("xx099900")).toBe(true);
    expect(await hasReleasedVersion("nm099900")).toBe(false);
  }, 60_000);
});
