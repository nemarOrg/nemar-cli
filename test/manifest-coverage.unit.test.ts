/**
 * Unit tests for the schema classifier in manifest-coverage. The full
 * `buildCoverageReport` (D1 query + S3 fan-in) is exercised end-to-end by
 * the admin route + post-deploy smoke; the per-row schema classification
 * is the only piece with branching logic worth pinning here.
 *
 * Dependency-injection note: `probeSummary` accepts a `SummaryFetcher`
 * function so tests can stub the S3 read directly without swapping
 * `globalThis.fetch` or constructing a fake Bindings object. Production
 * wires the fetcher to `loadSummary()` (direct S3 SigV4).
 */

import { describe, expect, test } from "bun:test";

import {
  type SummaryFetcher,
  probeSummary,
} from "../backend/src/services/manifest-coverage";

/** Build a SummaryFetcher that always returns the same scripted result. */
function stubFetcher(
  scripted: { kind: "ok"; body: unknown } | { kind: "null" } | { kind: "throw"; error: Error },
): SummaryFetcher {
  return async () => {
    if (scripted.kind === "null") return null;
    if (scripted.kind === "throw") throw scripted.error;
    return JSON.stringify(scripted.body);
  };
}

describe("probeSummary schema classification", () => {
  test("schema 1.1 → ok", async () => {
    const state = await probeSummary(
      stubFetcher({ kind: "ok", body: { schema_version: "1.1" } }),
      "nm000999",
      "1.0.0",
    );
    expect(state.kind).toBe("ok");
    if (state.kind === "ok") expect(state.schema_version).toBe("1.1");
  });

  test("schema 1.0 (legacy) → stale", async () => {
    const state = await probeSummary(
      stubFetcher({ kind: "ok", body: { schema_version: "1.0" } }),
      "nm000999",
      "1.0.0",
    );
    expect(state.kind).toBe("stale");
    if (state.kind === "stale") expect(state.schema_version).toBe("1.0");
  });

  test("schema 1.2 (future minor) → ok (forward-compatible)", async () => {
    // Pin this: the comparator must NOT flip 1.2 to stale just because the
    // current TARGET_SCHEMA is 1.1. A future bump updates the target; the
    // comparator should keep treating already-newer payloads as ok in the
    // meantime.
    const state = await probeSummary(
      stubFetcher({ kind: "ok", body: { schema_version: "1.2" } }),
      "nm000999",
      "1.0.0",
    );
    expect(state.kind).toBe("ok");
    if (state.kind === "ok") expect(state.schema_version).toBe("1.2");
  });

  test("schema 2.0 (future major) → ok", async () => {
    const state = await probeSummary(
      stubFetcher({ kind: "ok", body: { schema_version: "2.0" } }),
      "nm000999",
      "1.0.0",
    );
    expect(state.kind).toBe("ok");
  });

  test("fetcher returns null → missing", async () => {
    // SummaryFetcher's contract: null means "definitely not there" (S3 404).
    // probeSummary maps that to {kind: missing}.
    const state = await probeSummary(stubFetcher({ kind: "null" }), "nm000999", "1.0.0");
    expect(state.kind).toBe("missing");
  });

  test("fetcher throws → error (status=0 sentinel for non-HTTP failures)", async () => {
    // loadSummary throws on 403-after-fallback and 5xx. probeSummary surfaces
    // these as {kind: error} so the whole sweep doesn't abort on one bad row.
    const state = await probeSummary(
      stubFetcher({ kind: "throw", error: new Error("S3 503 Service Unavailable") }),
      "nm000999",
      "1.0.0",
    );
    expect(state.kind).toBe("error");
    if (state.kind === "error") {
      expect(state.status).toBe(0);
      expect(state.message).toContain("S3 503");
    }
  });

  test("malformed JSON → error (not collapsed to missing)", async () => {
    // SummaryFetcher returning a string that isn't valid JSON: report as
    // error so the operator sees there's a corrupted artifact, not just
    // "no summary found".
    const stub: SummaryFetcher = async () => "{not: valid json}";
    const state = await probeSummary(stub, "nm000999", "1.0.0");
    expect(state.kind).toBe("error");
    if (state.kind === "error") {
      expect(state.message).toContain("invalid JSON");
    }
  });

  test("empty schema_version string is classified as error, NOT stale", async () => {
    // Ordering invariant: probeSummary short-circuits an empty schema_version
    // to {kind: error} BEFORE compareSchemas runs. If those checks ever swap,
    // an empty string would parse to "0.0" and become "stale", which would
    // mass-dispatch every malformed-payload version on --fix.
    const state = await probeSummary(
      stubFetcher({ kind: "ok", body: { schema_version: "" } }),
      "nm000999",
      "1.0.0",
    );
    expect(state.kind).toBe("error");
    if (state.kind === "error") {
      expect(state.message).toContain("schema_version");
    }
  });

  test("missing schema_version key → error", async () => {
    const state = await probeSummary(
      stubFetcher({ kind: "ok", body: { totals: { files: 0 } } }),
      "nm000999",
      "1.0.0",
    );
    expect(state.kind).toBe("error");
  });

  test("non-string schema_version (number) → error", async () => {
    // Defensive: a generator regression that emits `schema_version: 1.1`
    // (number, not string) would otherwise silently classify as error
    // because `typeof !== "string"`. Pin the contract.
    const state = await probeSummary(
      stubFetcher({ kind: "ok", body: { schema_version: 1.1 } }),
      "nm000999",
      "1.0.0",
    );
    expect(state.kind).toBe("error");
  });

  test("fetcher receives the exact (datasetId, version) passed to probeSummary", async () => {
    // Pin the wire contract — defends against a refactor that accidentally
    // swaps the args or normalises them before handing to the fetcher.
    let captured: { id: string; version: string } | null = null;
    const stub: SummaryFetcher = async (id, version) => {
      captured = { id, version };
      return JSON.stringify({ schema_version: "1.1" });
    };
    await probeSummary(stub, "on007315", "v2.1.0");
    expect(captured).toEqual({ id: "on007315", version: "v2.1.0" });
  });
});
