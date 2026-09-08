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

describe("projectionUrl", () => {
  test("key shape: host + dataset id + commit + projection + schema version", () => {
    const url = projectionUrl("nm000329", "7172d2d492dad63650f80cdb83352a0e9d4420f7", "recordings");
    expect(url).toBe(
      `https://mcp.nemar.org/_cache/nm000329/7172d2d492dad63650f80cdb83352a0e9d4420f7/recordings/v${PROJECTION_SCHEMA_VERSION}`,
    );
  });

  test("a nested projection string (events/<zarr>) passes through verbatim, version last", () => {
    const url = projectionUrl("nm000329", "abc", "events/sub-1/ses-0/eeg/x.zarr");
    expect(url).toBe(
      `https://mcp.nemar.org/_cache/nm000329/abc/events/sub-1/ses-0/eeg/x.zarr/v${PROJECTION_SCHEMA_VERSION}`,
    );
  });
});

describe("JSON projections", () => {
  test("write then read round-trips the value", async () => {
    const cache = new InMemoryCache();
    const url = projectionUrl("nm000329", "abc", "recordings");
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
      projectionUrl("nm000329", "abc", "recordings"),
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
    const url = projectionUrl("nm000329", "abc", "recordings");
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
      projectionUrl("nm000329", "abc", "recordings"),
      helloSchema,
    );
    expect(result.status).toBe("miss");
  });

  test("a stored entry that fails schema validation is a miss, not a crash", async () => {
    const cache = new InMemoryCache();
    const url = projectionUrl("nm000329", "abc", "recordings");
    // Wrong shape entirely: `n` is a string, `hello` is missing.
    writeJsonProjection(ctx, cache, url, { n: "not-a-number" });
    await Promise.resolve();

    const result = await readJsonProjection(cache, url, helloSchema);
    expect(result.status).toBe("miss");
  });

  test("the stored entry carries the 7-day Cache-Control header", async () => {
    const cache = new InMemoryCache();
    const url = projectionUrl("nm000329", "abc", "recordings");
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
    const url = projectionUrl("nm000329", "abc", "overview/x.zarr/eeg_250hz/800");
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
      projectionUrl("nm000329", "abc", "overview/x.zarr/eeg_250hz/800"),
    );
    expect(result.status).toBe("miss");
  });
});
