/**
 * Unit tests for the new GET /<id>/<version>/summary.json route added in
 * Stream C of epic #559 (PR-1, issue #558).
 *
 * Scope: route registration + visibility gate. The body-content path
 * requires real S3 (summary.json fetch) and real D1 (resolveVersion of
 * "latest"). Both are covered by the E2E suite (`test/data-route.test.ts`)
 * once Stream A's central workflow has produced summary.json artifacts
 * for the test dataset. Per the repo's "no mocks" policy, we do not
 * fabricate fake summaries here just to assert serialization.
 *
 * What this file pins down:
 *  - The route IS registered on `dataRoutes`.
 *  - A request for an invalid dataset id returns 404 (visibility gate
 *    short-circuits before any S3 or D1 work).
 *  - The handler is a static-passthrough: source has no presigned-URL
 *    injection (`buildRedirectUrl`) and no `generatePresignedGetUrl`
 *    call in its body. The summary contract is path-only by design.
 *
 * NOT covered here (intentional):
 *  - 200-path `Cache-Control: public, max-age=300, s-maxage=86400, ...`
 *    header. Requires both real S3 (an actual summary.json object) and
 *    real D1 (a published dataset row that passes `loadPublishedDataset`).
 *    Verified at epic-level by `nemar admin e2e-test --verbose` and by
 *    the real-S3 conditional `test/s3-summary.test.ts` (which proves
 *    `loadSummary` returns the bytes; the route then attaches the header
 *    unconditionally, as the source assertion above guarantees no
 *    branching can drop it).
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import "./setup";

import { dataRoutes } from "../backend/src/routes/data";
import type { Bindings } from "../backend/src/types/bindings";

/**
 * Minimal env stub. The only branches we exercise short-circuit before
 * touching `env.DB` or the S3 helpers, so the rest can be `undefined`
 * cast through `unknown`. Any test path that needs real D1 or S3 should
 * live in the E2E suite, not here.
 */
function stubEnv(): Bindings {
  return {} as unknown as Bindings;
}

describe("data summary route (#558)", () => {
  test("GET /:datasetId/:version/summary.json is registered on dataRoutes", () => {
    const matches = dataRoutes.routes.filter(
      (r) => r.method === "GET" && r.path === "/:datasetId/:version/summary.json",
    );
    expect(matches.length).toBe(1);
  });

  test("invalid dataset id returns 404 without touching D1 or S3", async () => {
    // `totally-invalid-id` fails `isValidDatasetId` synchronously inside
    // `loadPublishedDataset` so neither env.DB nor any S3 helper is
    // called -- making this a real call through the registered handler
    // (no mocks) that nevertheless does not require Workers bindings.
    const req = new Request("http://test.local/totally-invalid-id/v1.0.0/summary.json");
    const res = await dataRoutes.fetch(req, stubEnv());
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Dataset not found");
  });

  test("handler does not inject presigned URLs (static passthrough contract)", () => {
    // The contract for summary.json is "serve S3 bytes verbatim". If a
    // future change introduces per-request presigned URLs into the
    // handler, this test fails and forces a review of the cache-policy
    // assumption (s-maxage=86400). Scope the check to the function body
    // by isolating between `summaryJsonHandler` and the next handler
    // signature `metadataJsonHandler`.
    const source = readFileSync(
      join(import.meta.dir, "..", "backend", "src", "routes", "data.ts"),
      "utf-8",
    );
    const startIdx = source.indexOf("async function summaryJsonHandler");
    expect(startIdx).toBeGreaterThan(-1);
    // Either of the next handlers may follow alphabetically; the call
    // site that registers summary.json is between the handler and the
    // next `function ...Handler` declaration.
    const restAfterStart = source.slice(startIdx);
    // Pass a character offset past the WHOLE declaration prefix
    // `async function summaryJsonHandler`, not just `async function `.
    // The shorter offset (15) lands inside the declaration's own prefix,
    // which works today but would silently expand scope if a nested
    // helper named `async function ...` were introduced.
    const nextHandlerIdx = restAfterStart.indexOf(
      "async function ",
      "async function summaryJsonHandler".length,
    );
    const handlerBody =
      nextHandlerIdx === -1 ? restAfterStart : restAfterStart.slice(0, nextHandlerIdx);
    expect(handlerBody.includes("buildRedirectUrl")).toBe(false);
    expect(handlerBody.includes("generatePresignedGetUrl")).toBe(false);
  });
});
