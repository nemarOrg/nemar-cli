/**
 * `index-reader.ts` tests (epic #1065 phase 3, issue #1295; plan decision
 * 2). Real engines throughout: `index.json` is fetched through the REAL
 * zarr sub-app (`createZarrDataRoutes`) against a real `Bun.serve()`
 * upstream (`test/helpers/fixture-server.ts`) and a real bun:sqlite-backed
 * D1 (`freshDb`/`realD1`) -- the D1 public-visibility gate is exercised for
 * real, not stubbed.
 */

import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { MAX_INDEX_BYTES, readZarrIndex } from "../src/mcp/index-reader.js";
import { createZarrDataRoutes } from "../src/routes/zarr-data.js";
import type { Bindings } from "../src/types/bindings.js";
import nm000111IndexV1 from "./fixtures/mcp/nm000111-index-v1.json";
import nm000329Index from "./fixtures/mcp/nm000329-index.json";
import { InMemoryCache } from "./helpers/cache.js";
import { freshDb, realD1 } from "./helpers/d1.js";
import { type FixtureServer, startFixtureServer } from "./helpers/fixture-server.js";

const V3_ID = "nm000329";
const V1_ID = "nm000111";
const EMPTY_COMMIT_ID = "nm000112";
const PRIVATE_ID = "nm500777";

const ctx = {
  waitUntil: (p: Promise<unknown>) => {
    p.catch(() => {});
  },
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

function encode(doc: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(doc));
}

describe("index-reader", () => {
  let db: Database;
  let fixtureServer: FixtureServer;
  let zarrApp: ReturnType<typeof createZarrDataRoutes>;
  let env: Bindings;

  beforeAll(() => {
    fixtureServer = startFixtureServer({
      [`${V3_ID}/zarr/index.json`]: encode(nm000329Index),
      [`${V1_ID}/zarr/index.json`]: encode(nm000111IndexV1),
      [`${EMPTY_COMMIT_ID}/zarr/index.json`]: encode({
        ...nm000111IndexV1,
        dataset_id: EMPTY_COMMIT_ID,
        source_commit: "",
      }),
    });
    zarrApp = createZarrDataRoutes({
      cache: () => new InMemoryCache(),
      fetch: (...args: Parameters<typeof fetch>) => fetch(...args),
      s3Base: fixtureServer.url,
    });
  });

  afterAll(() => {
    fixtureServer.stop();
  });

  function insertDataset(datasetId: string, visibility: "public" | "private"): void {
    db.query(
      `INSERT INTO datasets (dataset_id, owner_user_id, name, visibility, status, is_sandbox)
       VALUES (?, -1, ?, ?, 'active', 0)`,
    ).run(datasetId, datasetId, visibility);
  }

  beforeEach(() => {
    db = freshDb();
    env = { DB: realD1(db), ENVIRONMENT: "development" } as unknown as Bindings;
    insertDataset(V3_ID, "public");
    insertDataset(V1_ID, "public");
    insertDataset(EMPTY_COMMIT_ID, "public");
    insertDataset(PRIVATE_ID, "private");
  });

  test("a v3 fixture parses as v3 and keeps its ETag", async () => {
    const result = await readZarrIndex({ zarrRoutes: zarrApp }, env, ctx, V3_ID);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("unreachable");
    expect(result.formatVersion).toBe(3);
    expect(result.index.format_version).toBe(3);
    expect(result.sourceCommit).toBe("7172d2d492dad63650f80cdb83352a0e9d4420f7");
    expect(result.etag).not.toBeNull();
    expect(result.etag).toContain("fixture-");
    expect(result.bytes).toBeGreaterThan(0);
  });

  test("a v1 fixture parses through the legacy schema with formatVersion 1 and sourceCommit set", async () => {
    const result = await readZarrIndex({ zarrRoutes: zarrApp }, env, ctx, V1_ID);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("unreachable");
    expect(result.formatVersion).toBe(1);
    expect(result.sourceCommit).toBe("510a05377459cf857e60b861ab377bc53b5b5b29");
    expect(result.index.dataset_id).toBe(V1_ID);
  });

  test("a v1 document with an empty source_commit parses with sourceCommit: null", async () => {
    const result = await readZarrIndex({ zarrRoutes: zarrApp }, env, ctx, EMPTY_COMMIT_ID);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("unreachable");
    expect(result.formatVersion).toBe(1);
    expect(result.sourceCommit).toBeNull();
  });

  test("a private dataset makes the zarr sub-app 404, reported as not_found", async () => {
    const result = await readZarrIndex({ zarrRoutes: zarrApp }, env, ctx, PRIVATE_ID);
    expect(result.status).toBe("not_found");
  });

  test("the D1 gate is real: flipping a dataset private mid-test changes the reader's answer", async () => {
    const before = await readZarrIndex({ zarrRoutes: zarrApp }, env, ctx, V3_ID);
    expect(before.status).toBe("ok");

    db.query("UPDATE datasets SET visibility = 'private' WHERE dataset_id = ?").run(V3_ID);

    const after = await readZarrIndex({ zarrRoutes: zarrApp }, env, ctx, V3_ID);
    expect(after.status).toBe("not_found");
  });

  describe("the inline-parse size bound", () => {
    // A stand-in for the zarr sub-app that answers whatever this test wants,
    // because the bound is about the RESPONSE, not about any dataset's real
    // document. Not a mock of business logic: readZarrIndex's own contract is
    // "fetch through zarrRoutes and interpret the response", and that
    // interpretation is exactly what is under test.
    function respondingWith(init: { body: string; contentLength?: string }): {
      fetch: () => Response;
    } {
      const headers = new Headers({ "content-type": "application/json", etag: '"x"' });
      if (init.contentLength !== undefined) headers.set("content-length", init.contentLength);
      return { fetch: () => new Response(init.body, { status: 200, headers }) };
    }

    test("an oversized content-length is refused WITHOUT reading the body", async () => {
      // The important branch: the header alone is enough to decline, so a
      // pathological document costs no parse and no allocation.
      //
      // Proven by making the body UNREADABLE. If the bound were checked after
      // reading, this would come back "invalid" ("body could not be read")
      // instead of "too_large" -- so the verdict itself distinguishes the two
      // code paths, rather than relying on a stream-pull probe, which Bun may
      // invoke on its own schedule.
      const routes = {
        fetch: () => {
          const headers = new Headers({
            "content-type": "application/json",
            "content-length": String(MAX_INDEX_BYTES + 1),
          });
          const body = new ReadableStream<Uint8Array>({
            pull() {
              throw new Error("body must not be read once the header is over the bound");
            },
          });
          return new Response(body, { status: 200, headers });
        },
      };
      const result = await readZarrIndex({ zarrRoutes: routes }, env, ctx, V3_ID);
      expect(result.status).toBe("too_large");
      if (result.status !== "too_large") throw new Error("unreachable");
      expect(result.detail).toContain(String(MAX_INDEX_BYTES));
      // The refusal is actionable: the document is public.
      expect(result.detail).toContain("index.json");
      expect(result.detail).toContain("read it directly");
    });

    test("a body over the bound with NO content-length is still refused", async () => {
      // Otherwise the bound is trivially bypassed by omitting the header.
      const oversized = `{"pad":"${"x".repeat(MAX_INDEX_BYTES + 16)}"}`;
      const result = await readZarrIndex(
        { zarrRoutes: respondingWith({ body: oversized }) },
        env,
        ctx,
        V3_ID,
      );
      expect(result.status).toBe("too_large");
    });

    test("a document just UNDER the bound is read normally", async () => {
      // The bound must not be a blanket refusal: nm000281's real index.json is
      // 12,846,915 bytes and has to keep working, so this checks the near edge
      // rather than only the far one.
      const realIndex = JSON.stringify(nm000329Index);
      const result = await readZarrIndex(
        { zarrRoutes: respondingWith({ body: realIndex }) },
        env,
        ctx,
        V3_ID,
      );
      expect(result.status).toBe("ok");
      if (result.status !== "ok") throw new Error("unreachable");
      // With no content-length header, `bytes` falls back to the body length
      // rather than reporting a misleading 0.
      expect(result.bytes).toBe(realIndex.length);
    });
  });

  test("an unknown dataset id (never inserted) is not_found", async () => {
    const result = await readZarrIndex({ zarrRoutes: zarrApp }, env, ctx, "nm599999");
    expect(result.status).toBe("not_found");
  });
});
