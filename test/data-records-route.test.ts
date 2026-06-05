/**
 * Unit tests for the GET /<id>/<version>/records.json route (#615, epic P2).
 *
 * Scope: route registration + visibility gate + static-passthrough contract,
 * plus the pure S3-key helper. The body-content path requires real S3 (the
 * records.json artifact) and real D1 (resolveVersion), so it is an E2E /
 * post-deploy check, not unit-tested with fabricated data (no-mock policy).
 * Mirrors test/data-summary-route.test.ts, the directly-analogous sibling.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import "./setup";

import { dataRoutes } from "../backend/src/routes/data";
import { versionArtifactKey } from "../backend/src/services/s3";
import type { Bindings } from "../backend/src/types/bindings";

function stubEnv(): Bindings {
  // Branches exercised here short-circuit before touching env.DB or S3.
  return {} as unknown as Bindings;
}

describe("data records route (#615)", () => {
  test("GET /:datasetId/:version/records.json is registered on dataRoutes", () => {
    const matches = dataRoutes.routes.filter(
      (r) => r.method === "GET" && r.path === "/:datasetId/:version/records.json",
    );
    expect(matches.length).toBe(1);
  });

  test("records.json is registered before the /:datasetId/:version catch-all", () => {
    // Route order matters in Hono: a `records.json` request must hit the
    // dedicated handler, not be captured as a version/path by the later
    // `/:datasetId/:version` (931) or `/:datasetId/:version/*` (1001) arms.
    const order = dataRoutes.routes.filter((r) => r.method === "GET").map((r) => r.path);
    const records = order.indexOf("/:datasetId/:version/records.json");
    const versionCatchAll = order.indexOf("/:datasetId/:version");
    const fileCatchAll = order.indexOf("/:datasetId/:version/*");
    expect(records).toBeGreaterThan(-1);
    if (versionCatchAll !== -1) expect(records).toBeLessThan(versionCatchAll);
    if (fileCatchAll !== -1) expect(records).toBeLessThan(fileCatchAll);
  });

  test("invalid dataset id returns 404 without touching D1 or S3", async () => {
    // `totally-invalid-id` fails isValidDatasetId synchronously inside
    // loadPublishedDataset, so neither env.DB nor any S3 helper is called --
    // a real call through the registered handler that needs no bindings.
    const req = new Request("http://test.local/totally-invalid-id/v1.0.0/records.json");
    const res = await dataRoutes.fetch(req, stubEnv());
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Dataset not found");
  });

  test("handler is a static passthrough (no presigned-URL injection)", () => {
    // The records.json contract is "serve S3 bytes verbatim" (s-maxage=86400).
    // If a future change injects per-request presigned URLs, this fails and
    // forces a review of the cache-policy assumption. Scope to the function
    // body between recordsJsonHandler and the next handler declaration.
    const source = readFileSync(
      join(import.meta.dir, "..", "backend", "src", "routes", "data.ts"),
      "utf-8",
    );
    const startIdx = source.indexOf("async function recordsJsonHandler");
    expect(startIdx).toBeGreaterThan(-1);
    const restAfterStart = source.slice(startIdx);
    const nextHandlerIdx = restAfterStart.indexOf(
      "async function ",
      "async function recordsJsonHandler".length,
    );
    const handlerBody =
      nextHandlerIdx === -1 ? restAfterStart : restAfterStart.slice(0, nextHandlerIdx);
    expect(handlerBody.includes("buildRedirectUrl")).toBe(false);
    expect(handlerBody.includes("generatePresignedGetUrl")).toBe(false);
  });
});

describe("versionArtifactKey (#615)", () => {
  test("records suffix -> <id>/version/v<X>-records.json", () => {
    expect(versionArtifactKey("nm099999", "1.0.0", "-records")).toBe(
      "nm099999/version/v1.0.0-records.json",
    );
  });

  test("normalizes an already-v-prefixed version (no double v)", () => {
    expect(versionArtifactKey("nm099999", "v2.1.0", "-records")).toBe(
      "nm099999/version/v2.1.0-records.json",
    );
  });

  test("suffix selects the sibling artifact (records vs summary vs manifest)", () => {
    expect(versionArtifactKey("on007139", "1.0.0", "")).toBe("on007139/version/v1.0.0.json");
    expect(versionArtifactKey("on007139", "1.0.0", "-summary")).toBe(
      "on007139/version/v1.0.0-summary.json",
    );
    expect(versionArtifactKey("on007139", "1.0.0", "-records")).toBe(
      "on007139/version/v1.0.0-records.json",
    );
  });
});
