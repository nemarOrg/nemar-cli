/**
 * Public OpenAPI 3.1 document: `GET /openapi.json` (issue #937 item 2, phase 5
 * of epic nemarOrg/website#284).
 *
 * Static and D1-free by design, mirroring `routes/schemas.ts`: the bytes are
 * the repo's own `shared/openapi.json`, generated at build time from the Zod
 * schemas in `shared/contract/` by `scripts/generate-openapi.ts`, imported
 * here rather than built per-request. This keeps generation cost off the
 * Worker's critical path and matches this repo's precedent for serving a
 * contract document (schemas.ts's "One file, two readers"). The committed
 * artifact cannot silently drift from the schemas it describes:
 * backend/test/openapi-document.test.ts regenerates the document from the
 * live schemas and asserts it deep-equals this file.
 *
 * Covers the public catalog READ surface only (GET /datasets, GET
 * /datasets/{id}, GET /datasets/search, GET /datasets/facets) -- see
 * scripts/generate-openapi.ts for what is and is not documented and why.
 */

import { Hono } from "hono";
import openApiDocument from "../../../shared/openapi.json" with { type: "json" };
import type { Bindings } from "../types/bindings";

/**
 * Same reasoning as schemas.ts's CACHE_CONTROL: this document only changes
 * when `scripts/generate-openapi.ts` is re-run and committed, which happens
 * alongside a contract change, not on a schedule -- a day-long TTL is safe
 * and keeps this off the Worker's critical path.
 */
const CACHE_CONTROL = "public, max-age=86400";

export const openApiRoutes = new Hono<{ Bindings: Bindings }>();

openApiRoutes.get("/", (c) => {
  // `application/openapi+json` is the media type an OpenAPI-aware client
  // (Swagger UI, Redoc, codegen tooling) content-sniffs for; it is a strict
  // subtype of application/json, so a plain JSON client is unaffected.
  return new Response(JSON.stringify(openApiDocument), {
    headers: {
      "Content-Type": "application/openapi+json; charset=utf-8",
      "Cache-Control": CACHE_CONTROL,
    },
  });
});
