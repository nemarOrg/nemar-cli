/**
 * Tests for the zarr.nemar.org data-plane helpers (epic #684, Stream D).
 *
 * The serve() handler does D1/S3/Cache I/O (exercised E2E against the live host,
 * per the no-mock policy); these unit-test the pure pieces that encode the
 * security boundary (restricted-origin CORS) and the cache-TTL split.
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
  test("short TTL for the freshness-sensitive metadata", () => {
    expect(cacheControlFor("nm000132/zarr/index.json")).toContain("max-age=60");
    expect(cacheControlFor("nm000132/zarr/sub-01/eeg/x_eeg.zarr/zarr.json")).toContain(
      "max-age=60",
    );
  });

  test("long TTL for bulk chunk objects", () => {
    expect(cacheControlFor("nm000132/zarr/sub-01/eeg/x_eeg.zarr/eeg_250hz/0/c/0/0")).toContain(
      "max-age=86400",
    );
    expect(
      cacheControlFor("nm000132/zarr/sub-01/eeg/x_eeg.zarr/eeg_250hz/view/1/c/0/0/0"),
    ).toContain("max-age=86400");
  });
});
