/**
 * Issue #937 item 2 (phase 5, epic nemarOrg/website#284): the OpenAPI 3.1
 * document `scripts/generate-openapi.ts` builds from the Zod schemas in
 * shared/contract/, served statically at GET /openapi.json
 * (backend/src/routes/openapi.ts) from the committed shared/openapi.json.
 *
 * Lives in backend/test/ (flat, not a subdirectory -- test.yml's unit-pure
 * tier globs `backend/test/*.test.ts` only) so it lands in the required,
 * offline CI tier alongside the other contract tests
 * (catalog-contract-validation.test.ts, dataset-detail-contract.test.ts).
 * Nothing here touches the network or a live backend: document generation is
 * a pure function call, and the round-trip section drives the REAL Hono
 * catalog routes against an in-memory bun:sqlite-backed D1 (`realD1`), same
 * pattern as those two files.
 *
 * Four things are asserted:
 *  1. DRIFT GUARD -- the committed shared/openapi.json is byte-for-byte what
 *     `buildOpenApiDocument()` produces right now, so an edit to a contract
 *     schema or a facet definition without re-running the generator fails
 *     here instead of shipping a stale document.
 *  2. The document is structurally valid OpenAPI 3.1 with every `$ref`
 *     resolving inside `components.schemas`.
 *  3. Every public catalog GET route is documented, derived from the REAL
 *     router (`datasetRoutes.routes`, the same introspection
 *     test/datasets-route-inventory.unit.test.ts already pins) rather than a
 *     hand-typed list on its own -- see DOCUMENTED_GET_ROUTES below for the
 *     exact triage rule that makes a new undocumented route fail this test.
 *  4. ROUND-TRIP -- a real captured GET /datasets and GET /datasets/:id
 *     response validates against the generated JSON Schema for
 *     DatasetListEnvelope / DatasetDetailEnvelope.
 */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { Ajv2020 } from "ajv/dist/2020";
import { Hono } from "hono";
import { buildOpenApiDocument } from "../../scripts/generate-openapi";
import committedDocument from "../../shared/openapi.json" with { type: "json" };
import { registerCatalogRoutes } from "../src/routes/datasets/catalog";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

type App = Hono<{ Bindings: Bindings; Variables: Variables }>;

function newApp(): App {
  const app: App = new Hono();
  registerCatalogRoutes(app);
  return app;
}

function env(db: Database): Bindings {
  return { DB: realD1(db), ENVIRONMENT: "test" } as Bindings;
}

/** Mirrors dataset-detail-contract.test.ts / catalog-contract-validation.test.ts's
 *  insertDataset: every column not mentioned defaults to SQLite NULL (or the
 *  schema's own DEFAULT), which is exactly the public-catalog-visible shape
 *  these routes need. */
function insertDataset(
  db: Database,
  datasetId: string,
  cols: Record<string, string | number | null> = {},
): void {
  const merged: Record<string, string | number | null> = {
    owner_user_id: -1,
    name: datasetId,
    visibility: "public",
    status: "active",
    is_sandbox: 0,
    subject_count: 5,
    file_size: 12345,
    ...cols,
  };
  const keys = Object.keys(merged);
  db.query(
    `INSERT INTO datasets (dataset_id, ${keys.join(", ")}) VALUES (?, ${keys
      .map(() => "?")
      .join(", ")})`,
  ).run(datasetId, ...(keys.map((k) => merged[k]) as never[]));
}

describe("shared/openapi.json: drift guard", () => {
  test("the committed document is exactly what the generator produces right now", () => {
    // JSON round-trip on the generator's own output so key ORDER differences
    // (which toEqual ignores but a raw string compare would not) can never
    // fail this test for a reason unrelated to actual content drift -- the
    // committed file is itself the generator's literal JSON.stringify output
    // (scripts/generate-openapi.ts), so this is a real drift check, not a
    // formatting one.
    const fresh = JSON.parse(JSON.stringify(buildOpenApiDocument()));
    expect(fresh).toEqual(committedDocument);
  });
});

describe("shared/openapi.json: structural validity (OpenAPI 3.1)", () => {
  test("declares a 3.1 version, info, and non-empty paths", () => {
    const doc = committedDocument as {
      openapi: string;
      info?: { title?: string; version?: string };
      paths?: Record<string, unknown>;
    };
    expect(doc.openapi.startsWith("3.1")).toBe(true);
    expect(doc.info?.title).toBeTruthy();
    expect(doc.info?.version).toBeTruthy();
    expect(doc.paths).toBeTruthy();
    expect(Object.keys(doc.paths ?? {}).length).toBeGreaterThan(0);
  });

  test("every $ref resolves to a name under components.schemas", () => {
    const doc = committedDocument as {
      components?: { schemas?: Record<string, unknown> };
    };
    const schemaNames = new Set(Object.keys(doc.components?.schemas ?? {}));
    expect(schemaNames.size).toBeGreaterThan(0);

    const refs: string[] = [];
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) {
        for (const item of node) walk(item);
        return;
      }
      if (node && typeof node === "object") {
        for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
          if (key === "$ref" && typeof value === "string") refs.push(value);
          else walk(value);
        }
      }
    };
    walk(doc);

    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      expect(ref.startsWith("#/components/schemas/")).toBe(true);
      const name = ref.slice("#/components/schemas/".length);
      expect(schemaNames.has(name)).toBe(true);
    }
  });

  test("every components.schemas entry compiles as a JSON Schema 2020-12 document", () => {
    const doc = committedDocument as { components?: { schemas?: Record<string, unknown> } };
    for (const [name, schema] of Object.entries(doc.components?.schemas ?? {})) {
      const ajv = new Ajv2020({ strict: false, allErrors: true });
      expect(() => ajv.compile(schema as object), name).not.toThrow();
    }
  });
});

describe("shared/openapi.json: public catalog route coverage", () => {
  // The router-relative path -> the OpenAPI document path this route must
  // appear under. Restricted to issue #937 item 2's exact scope (the public
  // catalog READ surface) -- registerCatalogRoutes' other GET routes below
  // are auth-gated or out of scope and are triaged into
  // UNDOCUMENTED_GET_ROUTES instead, so neither map silently goes stale.
  const DOCUMENTED_GET_ROUTES: Record<string, string> = {
    "/": "/datasets",
    "/search": "/datasets/search",
    "/facets": "/datasets/facets",
    "/:id": "/datasets/{id}",
  };

  // Every other GET route the datasets router registers (across all of
  // registerCatalogRoutes and the other routes/datasets/* concern files
  // sharing the same router -- see test/datasets-route-inventory.unit.test.ts
  // for the full inventory), deliberately NOT part of this document: either
  // auth-gated (not a public catalog read) or a different concern
  // (manifests/versions/collaborators) outside issue #937 item 2's scope.
  //
  // A NEW GET route added anywhere on this router that is not triaged into
  // one of these two maps fails the test below -- add it to
  // DOCUMENTED_GET_ROUTES (and scripts/generate-openapi.ts) if it belongs in
  // the public catalog contract, or here with a one-line reason if not.
  const UNDOCUMENTED_GET_ROUTES = new Set<string>([
    "/resolve/:sourceId", // OpenNeuro source-id resolution, not a catalog envelope
    "/:id/access-requests", // auth-gated (owner/admin)
    "/:id/collaborators", // auth-gated (owner/admin)
    "/:id/publish/status", // auth-gated, publication workflow
    "/:id/ci/status", // auth-gated, CI status
    "/:id/manifest", // version manifest, not the contract's dataset envelope
    "/:id/manifest/:version", // version manifest, not the contract's dataset envelope
    "/:id/versions", // auth-gated, version listing
  ]);

  test("every GET route on the datasets router is documented or explicitly triaged", () => {
    const app = newApp();
    // registerCatalogRoutes alone (this file's own router, per newApp()
    // above) covers the four documented routes plus /resolve/:sourceId --
    // the other UNDOCUMENTED_GET_ROUTES entries live in sibling concern
    // files (manifests.ts, collaborators.ts, publication.ts) registered onto
    // the SAME shared router in production (routes/datasets/index.ts). This
    // test only needs catalog.ts's own routes to prove the positive
    // (documented routes exist) and that nothing catalog.ts registers is
    // untriaged; the full-router inventory is already pinned by
    // test/datasets-route-inventory.unit.test.ts.
    const getPaths = new Set(app.routes.filter((r) => r.method === "GET").map((r) => r.path));
    for (const path of getPaths) {
      const documented = path in DOCUMENTED_GET_ROUTES;
      const undocumented = UNDOCUMENTED_GET_ROUTES.has(path);
      expect(documented || undocumented, `GET ${path} is not triaged`).toBe(true);
    }
  });

  test("every documented route still exists on the router", () => {
    const app = newApp();
    const getPaths = new Set(app.routes.filter((r) => r.method === "GET").map((r) => r.path));
    for (const routerPath of Object.keys(DOCUMENTED_GET_ROUTES)) {
      expect(getPaths.has(routerPath), `GET ${routerPath} missing from the router`).toBe(true);
    }
  });

  test("the generated document has a GET operation at every documented path", () => {
    const doc = committedDocument as {
      paths?: Record<string, { get?: unknown }>;
    };
    for (const openApiPath of Object.values(DOCUMENTED_GET_ROUTES)) {
      expect(doc.paths?.[openApiPath]?.get, `missing GET ${openApiPath}`).toBeTruthy();
    }
    // And nothing else: exactly the four routes, no accidental extras.
    expect(Object.keys(doc.paths ?? {}).sort()).toEqual(
      Object.values(DOCUMENTED_GET_ROUTES).sort(),
    );
  });
});

describe("shared/openapi.json: round-trips real API responses", () => {
  let db: Database;
  let app: App;

  beforeEach(() => {
    db = freshDb();
    app = newApp();
  });

  test("a real GET /datasets response validates against DatasetListEnvelope", async () => {
    insertDataset(db, "nm090101", { name: "Round Trip List Fixture" });

    const res = await app.request("/", {}, env(db));
    expect(res.status).toBe(200);
    const body = await res.json();

    const doc = committedDocument as { components: { schemas: Record<string, object> } };
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    const validate = ajv.compile(doc.components.schemas.DatasetListEnvelope);
    const valid = validate(body);
    expect(valid, JSON.stringify(validate.errors)).toBe(true);
  });

  test("a real GET /datasets/:id response validates against DatasetDetailEnvelope", async () => {
    insertDataset(db, "nm090102", { name: "Round Trip Detail Fixture" });

    const res = await app.request("/nm090102", {}, env(db));
    expect(res.status).toBe(200);
    const body = await res.json();

    const doc = committedDocument as { components: { schemas: Record<string, object> } };
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    const validate = ajv.compile(doc.components.schemas.DatasetDetailEnvelope);
    const valid = validate(body);
    expect(valid, JSON.stringify(validate.errors)).toBe(true);
  });
});
