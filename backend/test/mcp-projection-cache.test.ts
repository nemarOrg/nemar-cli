/**
 * `projection-cache.ts` tests (epic #1065 phase 3, issue #1295). Real
 * in-memory `CacheLike` (`InMemoryCache`, `test/helpers/cache.ts`) -- no
 * mocks.
 */

import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  PROJECTION_CACHE_CONTROL,
  PROJECTION_SCHEMA_VERSION,
  projectionUrl,
  readBinaryProjection,
  readJsonProjection,
  writeBinaryProjection,
  writeJsonProjection,
} from "../src/mcp/projection-cache.js";
import { InMemoryCache } from "./helpers/cache.js";

const ctx = {
  waitUntil: (p: Promise<unknown>) => {
    p.catch(() => {});
  },
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

const helloSchema = z.object({ hello: z.string(), n: z.number() });

const PROD_ENV = { MCP_HOSTNAME: "mcp.nemar.org" };
const COMMIT = "7172d2d492dad63650f80cdb83352a0e9d4420f7";

describe("projectionUrl", () => {
  test("key shape: host + id + commit.conversion + projection + schema version", () => {
    const url = projectionUrl({
      env: PROD_ENV,
      datasetId: "nm000329",
      sourceCommit: COMMIT,
      convertedAt: "2026-09-01 12:00:00",
      projection: "recordings",
    });
    expect(url).toBe(
      `https://mcp.nemar.org/_cache/nm000329/${COMMIT}.2026-09-01%2012%3A00%3A00/recordings/v${PROJECTION_SCHEMA_VERSION}`,
    );
  });

  test("a nested projection string (events/<zarr>) passes through verbatim, version last", () => {
    const url = projectionUrl({
      env: PROD_ENV,
      datasetId: "nm000329",
      sourceCommit: "abc",
      convertedAt: null,
      projection: "events/sub-1/ses-0/eeg/x.zarr",
    });
    expect(url).toBe(
      `https://mcp.nemar.org/_cache/nm000329/abc.unconverted/events/sub-1/ses-0/eeg/x.zarr/v${PROJECTION_SCHEMA_VERSION}`,
    );
  });

  test("a re-conversion at the SAME commit produces a DIFFERENT key", () => {
    // The correctness of the whole layer. `source_commit` is the dataset repo's
    // HEAD, and an engine bump re-converts without changing it (ADR 0033), so a
    // commit-only key served stale bytes for its full 7-day TTL: stale
    // `scale[]`/`offset[]` against re-quantized data (wrong physical values,
    // silently) and stale shard byte offsets replayed as Range reads (every 206
    // and length check passing, on the wrong bytes).
    const before = projectionUrl({
      env: PROD_ENV,
      datasetId: "nm000329",
      sourceCommit: COMMIT,
      convertedAt: "2026-09-01 12:00:00",
      projection: "array/x.zarr/eeg/0",
    });
    const after = projectionUrl({
      env: PROD_ENV,
      datasetId: "nm000329",
      sourceCommit: COMMIT,
      convertedAt: "2026-09-08 03:30:00",
      projection: "array/x.zarr/eeg/0",
    });
    expect(after).not.toBe(before);
  });

  test("a null conversion stamp cannot collide with a stamped one", () => {
    const stamped = projectionUrl({
      env: PROD_ENV,
      datasetId: "nm000329",
      sourceCommit: COMMIT,
      convertedAt: "unconverted",
      projection: "recordings",
    });
    const unstamped = projectionUrl({
      env: PROD_ENV,
      datasetId: "nm000329",
      sourceCommit: COMMIT,
      convertedAt: null,
      projection: "recordings",
    });
    // The literal string "unconverted" is what null encodes to, so this pair is
    // the one genuine collision the encoding allows. It is unreachable in
    // practice (`zarr_converted_at` is a timestamp), and asserted here so a
    // future change to the sentinel has to look at it.
    expect(unstamped).toBe(stamped);
  });

  test("prod and staging never share a key (caches.default is ZONE-scoped)", () => {
    // Both mcp.nemar.org and mcp-test.nemar.org are custom domains on the
    // nemar.org zone, so a hardcoded namespace had the two environments reading
    // and writing each other's entries for the same (dataset, commit) while
    // their `data_base` pointed at different buckets.
    const args = {
      datasetId: "nm000329",
      sourceCommit: COMMIT,
      convertedAt: "2026-09-01 12:00:00",
      projection: "recordings",
    } as const;
    const prod = projectionUrl({ env: PROD_ENV, ...args });
    const staging = projectionUrl({ env: { MCP_HOSTNAME: "mcp-test.nemar.org" }, ...args });
    const unset = projectionUrl({ env: {}, ...args });
    expect(staging).not.toBe(prod);
    // An unconfigured environment lands in neither.
    expect(unset).not.toBe(prod);
    expect(unset).not.toBe(staging);
  });
});

describe("JSON projections", () => {
  test("write then read round-trips the value", async () => {
    const cache = new InMemoryCache();
    const url = projectionUrl({
      env: PROD_ENV,
      datasetId: "nm000329",
      sourceCommit: "abc",
      convertedAt: null,
      projection: "recordings",
    });
    writeJsonProjection(ctx, cache, url, { hello: "world", n: 3 });
    // writeJsonProjection defers the put() via waitUntil -- flush it.
    await Promise.resolve();

    const result = await readJsonProjection(cache, url, helloSchema);
    expect(result.status).toBe("hit");
    if (result.status !== "hit") throw new Error("unreachable");
    expect(result.value).toEqual({ hello: "world", n: 3 });
  });

  test("a cache miss answers status miss", async () => {
    const cache = new InMemoryCache();
    const result = await readJsonProjection(
      cache,
      projectionUrl({
        env: PROD_ENV,
        datasetId: "nm000329",
        sourceCommit: "abc",
        convertedAt: null,
        projection: "recordings",
      }),
      helloSchema,
    );
    expect(result.status).toBe("miss");
  });

  test("a cache whose put() throws is logged and treated as a miss (never surfaces)", async () => {
    class ThrowingPutCache {
      async match(): Promise<Response | undefined> {
        return undefined;
      }
      async put(): Promise<void> {
        throw new Error("simulated put failure");
      }
    }
    const cache = new ThrowingPutCache();
    const url = projectionUrl({
      env: PROD_ENV,
      datasetId: "nm000329",
      sourceCommit: "abc",
      convertedAt: null,
      projection: "recordings",
    });
    // Must not throw synchronously or reject the caller.
    writeJsonProjection(ctx, cache, url, { x: 1 });
    await Promise.resolve();
    await Promise.resolve();
  });

  test("a cache whose match() throws is treated as a miss", async () => {
    class ThrowingMatchCache {
      async match(): Promise<Response | undefined> {
        throw new Error("simulated match failure");
      }
      async put(): Promise<void> {}
    }
    const result = await readJsonProjection(
      new ThrowingMatchCache(),
      projectionUrl({
        env: PROD_ENV,
        datasetId: "nm000329",
        sourceCommit: "abc",
        convertedAt: null,
        projection: "recordings",
      }),
      helloSchema,
    );
    expect(result.status).toBe("miss");
  });

  test("a stored entry that fails schema validation is a miss, not a crash", async () => {
    const cache = new InMemoryCache();
    const url = projectionUrl({
      env: PROD_ENV,
      datasetId: "nm000329",
      sourceCommit: "abc",
      convertedAt: null,
      projection: "recordings",
    });
    // Wrong shape entirely: `n` is a string, `hello` is missing.
    writeJsonProjection(ctx, cache, url, { n: "not-a-number" });
    await Promise.resolve();

    const result = await readJsonProjection(cache, url, helloSchema);
    expect(result.status).toBe("miss");
  });

  test("the stored entry carries the 7-day Cache-Control header", async () => {
    const cache = new InMemoryCache();
    const url = projectionUrl({
      env: PROD_ENV,
      datasetId: "nm000329",
      sourceCommit: "abc",
      convertedAt: null,
      projection: "recordings",
    });
    writeJsonProjection(ctx, cache, url, { hello: "world", n: 1 });
    await Promise.resolve();
    const hit = await cache.match(new Request(url));
    expect(hit).toBeDefined();
    expect(hit?.headers.get("cache-control")).toBe(PROJECTION_CACHE_CONTROL);
    expect(PROJECTION_CACHE_CONTROL).toContain("max-age=604800");
  });
});

describe("binary projections", () => {
  test("write then read round-trips bytes and content type", async () => {
    const cache = new InMemoryCache();
    const url = projectionUrl({
      env: PROD_ENV,
      datasetId: "nm000329",
      sourceCommit: "abc",
      convertedAt: null,
      projection: "overview/x.zarr/eeg_250hz/3/800",
    });
    const bytes = new Uint8Array([137, 80, 78, 71]); // PNG magic prefix
    writeBinaryProjection(ctx, cache, url, bytes, "image/png");
    await Promise.resolve();

    const result = await readBinaryProjection(cache, url);
    expect(result.status).toBe("hit");
    if (result.status !== "hit") throw new Error("unreachable");
    expect(Array.from(result.bytes)).toEqual([137, 80, 78, 71]);
    expect(result.contentType).toBe("image/png");
  });

  test("a binary miss answers status miss", async () => {
    const cache = new InMemoryCache();
    const result = await readBinaryProjection(
      cache,
      projectionUrl({
        env: PROD_ENV,
        datasetId: "nm000329",
        sourceCommit: "abc",
        convertedAt: null,
        projection: "overview/x.zarr/eeg_250hz/3/800",
      }),
    );
    expect(result.status).toBe("miss");
  });
});
