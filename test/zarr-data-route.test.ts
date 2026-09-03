/**
 * Tests for the zarr.nemar.org data-plane helpers (epic #684, Stream D).
 *
 * The serve() handler does D1/S3/Cache I/O (exercised E2E against the live host,
 * per the no-mock policy); these unit-test the pure pieces that encode the
 * security boundary (restricted-origin CORS) and the cache-TTL split, including
 * the tokened-vs-untokened split added in #1178 phase 1 (see epic #1181's
 * backend/test/zarr-data-cache.test.ts for the full route-level cache behavior).
 */

import { describe, expect, test } from "bun:test";
import "./setup";
import { allowedOrigin, cacheControlFor, corsHeaders } from "../backend/src/routes/zarr-data";

describe("allowedOrigin", () => {
  test("allows NEMAR origins", () => {
    for (const o of [
      "https://ww2.nemar.org",
      "https://nemar.org",
      "https://app.nemar.org",
      "http://localhost:4321",
      "http://127.0.0.1:3000",
    ]) {
      expect(allowedOrigin(o)).toBe(o);
    }
  });

  test("blocks third-party origins (OpenNeuro etc.)", () => {
    for (const o of [
      "https://openneuro.org",
      "https://evil.example",
      "https://nemar.org.evil.com",
      "https://notnemar.org",
    ]) {
      expect(allowedOrigin(o)).toBeNull();
    }
  });

  test("null / unparseable origin -> null", () => {
    expect(allowedOrigin(null)).toBeNull();
    expect(allowedOrigin("not a url")).toBeNull();
  });
});

describe("corsHeaders", () => {
  test("reflects an allowed origin and exposes the range headers zarrita needs", () => {
    const h = corsHeaders("https://ww2.nemar.org");
    expect(h["Access-Control-Allow-Origin"]).toBe("https://ww2.nemar.org");
    expect(h["Access-Control-Allow-Methods"]).toContain("GET");
    expect(h["Access-Control-Allow-Headers"]).toContain("Range");
    expect(h["Access-Control-Expose-Headers"]).toContain("Content-Range");
    expect(h["Access-Control-Expose-Headers"]).toContain("ETag");
    expect(h.Vary).toBe("Origin");
  });

  test("omits Access-Control-Allow-Origin for a blocked origin", () => {
    const h = corsHeaders("https://openneuro.org");
    expect(h["Access-Control-Allow-Origin"]).toBeUndefined();
    // still advertises the methods/headers (harmless without ACAO)
    expect(h["Access-Control-Allow-Methods"]).toContain("GET");
  });
});

describe("cacheControlFor", () => {
  // #1178 phase 1: untokened index.json moved from max-age=60 to 300 (the
  // zarr-ready callback purges it on rebuild, so a moderate TTL is safe --
  // see the function's own docstring for why). zarr.json stays at 60
  // untokened since it isn't purged as reliably (only changed stores are).
  test("untokened index.json gets a moderate TTL (auto-purged on rebuild)", () => {
    expect(cacheControlFor("nm000132/zarr/index.json", { tokened: false })).toContain(
      "max-age=300",
    );
  });

  test("untokened zarr.json (freshness-sensitive metadata) gets a short TTL", () => {
    expect(
      cacheControlFor("nm000132/zarr/sub-01/eeg/x_eeg.zarr/zarr.json", { tokened: false }),
    ).toContain("max-age=60");
  });

  // A `?v=` tokened URL is immutable by construction (a re-conversion mints
  // a new v), so both metadata files get the same full-day TTL as chunks.
  test("tokened metadata (index.json and zarr.json) gets a full day", () => {
    expect(cacheControlFor("nm000132/zarr/index.json", { tokened: true })).toContain(
      "max-age=86400",
    );
    expect(
      cacheControlFor("nm000132/zarr/sub-01/eeg/x_eeg.zarr/zarr.json", { tokened: true }),
    ).toContain("max-age=86400");
  });

  test("long TTL for bulk chunk objects", () => {
    expect(
      cacheControlFor("nm000132/zarr/sub-01/eeg/x_eeg.zarr/eeg_250hz/0/c/0/0", {
        tokened: false,
      }),
    ).toContain("max-age=86400");
    expect(
      cacheControlFor("nm000132/zarr/sub-01/eeg/x_eeg.zarr/eeg_250hz/view/1/c/0/0/0", {
        tokened: false,
      }),
    ).toContain("max-age=86400");
  });

  test("chunks stay at max-age=86400 whether tokened or not", () => {
    expect(
      cacheControlFor("nm000132/zarr/sub-01/eeg/x_eeg.zarr/eeg_250hz/0/c/0/0", {
        tokened: true,
      }),
    ).toContain("max-age=86400");
  });
});
