/**
 * Unit tests for the schema-compare helper in manifest-coverage. The HTTP
 * probe and the D1 query are exercised end-to-end by the admin route
 * integration tests; the schema comparison is the only piece with branching
 * logic worth pinning here.
 *
 * Imported indirectly because compareSchemas is module-internal: we re-test
 * the public surface via the smallest fixture that exercises it.
 */

import { describe, expect, test } from "bun:test";

// Re-export under test via the function that uses it.
import { probeSummary } from "../backend/src/services/manifest-coverage";

describe("probeSummary schema classification", () => {
  // We can't run real HTTP against data.nemar.org from a unit test, so use a
  // mocked fetch that returns scripted bodies. Bun's global fetch is
  // overrideable per-test.
  function withFetch<T>(
    response: { status: number; body?: unknown } | { error: Error },
    fn: () => Promise<T>,
  ): Promise<T> {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => {
      if ("error" in response) throw response.error;
      const body = response.body ?? {};
      return new Response(JSON.stringify(body), { status: response.status });
    }) as typeof fetch;
    return fn().finally(() => {
      globalThis.fetch = original;
    });
  }

  test("schema 1.1 → ok", async () => {
    const state = await withFetch(
      { status: 200, body: { schema_version: "1.1" } },
      () => probeSummary("nm000999", "1.0.0"),
    );
    expect(state.kind).toBe("ok");
    if (state.kind === "ok") expect(state.schema_version).toBe("1.1");
  });

  test("schema 1.0 (legacy) → stale", async () => {
    const state = await withFetch(
      { status: 200, body: { schema_version: "1.0" } },
      () => probeSummary("nm000999", "1.0.0"),
    );
    expect(state.kind).toBe("stale");
    if (state.kind === "stale") expect(state.schema_version).toBe("1.0");
  });

  test("schema 1.2 (future minor) → ok (forward-compatible)", async () => {
    // Pin this: the comparator must not flip 1.2 to stale just because the
    // current target is 1.1. A future Phase X bump would update the target;
    // the comparator should keep treating already-newer payloads as ok in
    // the meantime.
    const state = await withFetch(
      { status: 200, body: { schema_version: "1.2" } },
      () => probeSummary("nm000999", "1.0.0"),
    );
    expect(state.kind).toBe("ok");
  });

  test("schema 2.0 (future major) → ok", async () => {
    const state = await withFetch(
      { status: 200, body: { schema_version: "2.0" } },
      () => probeSummary("nm000999", "1.0.0"),
    );
    expect(state.kind).toBe("ok");
  });

  test("404 → missing", async () => {
    const state = await withFetch(
      { status: 404 },
      () => probeSummary("nm000999", "1.0.0"),
    );
    expect(state.kind).toBe("missing");
  });

  test("5xx → error (NOT classified as missing)", async () => {
    // Important: a transient S3 5xx must not be reported as "missing" or the
    // backfill would re-dispatch every version on every transient hiccup.
    const state = await withFetch(
      { status: 503 },
      () => probeSummary("nm000999", "1.0.0"),
    );
    expect(state.kind).toBe("error");
    if (state.kind === "error") expect(state.status).toBe(503);
  });

  test("malformed JSON (missing schema_version) → error", async () => {
    const state = await withFetch(
      { status: 200, body: { totals: { files: 0 } } },
      () => probeSummary("nm000999", "1.0.0"),
    );
    expect(state.kind).toBe("error");
    if (state.kind === "error") {
      expect(state.message).toContain("schema_version");
    }
  });

  test("network error → error with status=0", async () => {
    const state = await withFetch(
      { error: new TypeError("fetch failed") },
      () => probeSummary("nm000999", "1.0.0"),
    );
    expect(state.kind).toBe("error");
    if (state.kind === "error") {
      expect(state.status).toBe(0);
      expect(state.message).toContain("fetch failed");
    }
  });

  test("version without v prefix is normalised", async () => {
    let capturedUrl = "";
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      capturedUrl = typeof input === "string" ? input : input.toString();
      return new Response(JSON.stringify({ schema_version: "1.1" }), { status: 200 });
    }) as typeof fetch;
    try {
      await probeSummary("nm000999", "1.0.0");
      expect(capturedUrl).toBe(
        "https://data.nemar.org/nm000999/v1.0.0/summary.json",
      );
    } finally {
      globalThis.fetch = original;
    }
  });

  test("version with v prefix is not double-prefixed", async () => {
    let capturedUrl = "";
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      capturedUrl = typeof input === "string" ? input : input.toString();
      return new Response(JSON.stringify({ schema_version: "1.1" }), { status: 200 });
    }) as typeof fetch;
    try {
      await probeSummary("nm000999", "v1.0.0");
      expect(capturedUrl).toBe(
        "https://data.nemar.org/nm000999/v1.0.0/summary.json",
      );
    } finally {
      globalThis.fetch = original;
    }
  });
});
