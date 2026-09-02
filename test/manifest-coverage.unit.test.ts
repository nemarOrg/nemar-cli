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
  buildCoverageReport,
  probeSummary,
} from "../backend/src/services/manifest-coverage";
import type { Bindings } from "../backend/src/types/bindings";

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
    //
    // Note: the `v` prefix normalisation that used to live in probeSummary
    // (when this probed `data.nemar.org/<id>/v<version>/summary.json`) now
    // lives in `loadSummary` (backend/src/services/s3.ts, line ~493). Tests
    // for that normalisation belong with loadSummary, not here.
    let captured: { id: string; version: string } | null = null;
    const stub: SummaryFetcher = async (id, version) => {
      captured = { id, version };
      return JSON.stringify({ schema_version: "1.1" });
    };
    await probeSummary(stub, "on007315", "v2.1.0");
    expect(captured).toEqual({ id: "on007315", version: "v2.1.0" });
  });

  test("hanging fetcher times out after PROBE_TIMEOUT_MS instead of starving the slot", async () => {
    // PROBE_TIMEOUT_MS in source is 8000; use a far-shorter assertion that
    // wraps the production timeout's behavior — if probeSummary races against
    // an indefinitely-pending fetcher and surfaces the timeout as an error
    // state, this test should resolve in well under the 8s cap.
    //
    // Bun's test runner has a default 5s timeout per test, so we'd see a
    // test-runner timeout if probeSummary wasn't doing its own race. We
    // explicitly bound the test at 9s (one second past the production cap)
    // so a regression to "no timeout" surfaces as a test failure with a
    // useful message, not just a hung CI job.
    const start = Date.now();
    const hangingFetcher: SummaryFetcher = () => new Promise(() => {});
    const state = await probeSummary(hangingFetcher, "nm000999", "1.0.0");
    const elapsed = Date.now() - start;

    expect(state.kind).toBe("error");
    if (state.kind === "error") {
      expect(state.message).toContain("timeout");
    }
    // Sanity: completed well below the production 8s cap (we're not asserting
    // exact timing, just that the race fired roughly when expected).
    expect(elapsed).toBeLessThan(8500);
    expect(elapsed).toBeGreaterThanOrEqual(7000);
  }, 10_000); // override Bun's default 5s test timeout
});

describe("buildCoverageReport", () => {
  /**
   * Smallest viable D1 stub: enough to satisfy `env.DB.prepare(...).all<T>()`.
   * Per project no-mocks rule, this is dependency-injection at the published
   * function boundary (buildCoverageReport accepts `fetchSummary?` as its
   * second arg), NOT a mock of a database. The D1 surface we exercise here
   * is one prepared query; faking it lets us pin the totals tally without
   * standing up a real D1.
   */
  function stubEnv(
    rows: { dataset_id: string; version: string; doi: string; concept_doi: string | null }[],
  ): Bindings {
    const fakeDB = {
      prepare: (_sql: string) => ({
        all: async <T>() => ({ results: rows as unknown as T[], success: true, meta: {} }),
      }),
    };
    return { DB: fakeDB } as unknown as Bindings;
  }

  test("totals tally matches the per-row classifier output", async () => {
    // Pin the classifier→totals mapping. A typo like `ok++` vs `stale++`
    // would silently mis-color the dashboard; nothing currently catches it.
    const env = stubEnv([
      { dataset_id: "nm000100", version: "1.0.0", doi: "d", concept_doi: "c" },
      { dataset_id: "nm000101", version: "1.0.0", doi: "d", concept_doi: "c" },
      { dataset_id: "nm000102", version: "1.0.0", doi: "d", concept_doi: "c" },
      { dataset_id: "nm000103", version: "1.0.0", doi: "d", concept_doi: "c" },
      { dataset_id: "nm000104", version: "1.0.0", doi: "d", concept_doi: "c" },
    ]);
    const scripted: Record<string, () => Promise<string | null>> = {
      nm000100: async () => JSON.stringify({ schema_version: "1.1" }), // ok
      nm000101: async () => JSON.stringify({ schema_version: "1.0" }), // stale
      nm000102: async () => null, // missing
      nm000103: async () => {
        throw new Error("S3 503");
      }, // error
      nm000104: async () => JSON.stringify({ schema_version: "1.1" }), // ok
    };
    const fetcher: SummaryFetcher = (id) => scripted[id]?.() ?? Promise.resolve(null);

    const report = await buildCoverageReport(env, fetcher);

    expect(report.totals).toEqual({
      versions: 5,
      ok: 2,
      stale: 1,
      missing: 1,
      error: 1,
    });
    expect(report.target_schema).toBe("1.1");
  });

  test("probeAll preserves input row order even when fetchers resolve out of order", async () => {
    // The CLI table and cron markdown rely on out[i] === rows[i] ordering.
    // A future refactor to out.push(...) would silently break this.
    const env = stubEnv([
      { dataset_id: "nm000aaa", version: "1.0.0", doi: "d", concept_doi: "c" },
      { dataset_id: "nm000bbb", version: "1.0.0", doi: "d", concept_doi: "c" },
      { dataset_id: "nm000ccc", version: "1.0.0", doi: "d", concept_doi: "c" },
      { dataset_id: "nm000ddd", version: "1.0.0", doi: "d", concept_doi: "c" },
    ]);
    // Reverse delays: first row sleeps longest, so out-of-order completion
    // is forced. If the implementation pushes (not index-assigns), the
    // returned order would be the inverse of the input.
    const fetcher: SummaryFetcher = async (id) => {
      const delay = { nm000aaa: 80, nm000bbb: 60, nm000ccc: 40, nm000ddd: 20 }[id] ?? 0;
      await new Promise((resolve) => setTimeout(resolve, delay));
      return JSON.stringify({ schema_version: "1.1" });
    };

    const report = await buildCoverageReport(env, fetcher);

    expect(report.versions.map((v) => v.dataset_id)).toEqual([
      "nm000aaa",
      "nm000bbb",
      "nm000ccc",
      "nm000ddd",
    ]);
  });
});
