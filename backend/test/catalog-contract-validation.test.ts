/**
 * Issue #1207: nothing today parses a live catalog/detail response against
 * the shared contract schemas (shared/contract/dataset.ts), so a production
 * regression in a derive path ships data the contract calls invalid and
 * only surfaces when some consumer's own parse throws -- the #1206 review's
 * own near-miss (`SELECT d.*` serving the detail route's numeric primary
 * key where the schema declares `id: string`, documented in
 * backend/test/catalog-has-zarr.test.ts).
 *
 * Per `.rules/testing.md`'s "test the entry point" rule, this drives the
 * REAL registered routes (`app.request`) against a real bun:sqlite-backed
 * D1, seeded with a deliberately invalid row -- an out-of-enum
 * `zarr_verify_status` (via the `sweep_stamps` JSON column, which only
 * CHECKs `json_valid`, unlike the stored `zarr_status` column's own `CHECK
 * (status IN (...))`, so it is the field this suite can actually get an
 * invalid value into) no application write path can produce today, standing
 * in for "a future derive path drifts from the contract" the way the
 * issue's own near-miss did. Asserts the log-not-throw hook fires while the
 * response still serves the (invalid) data unmodified -- ADR 0005: reporting
 * is never a precondition for serving.
 *
 * #1224 review: the hook itself is now deferred off the response's critical
 * path via `deferContractCheck`'s `executionCtx.waitUntil` (catalog.ts),
 * mirroring `afterResponse()` in routes/auth-orcid.ts. Every request in this
 * file goes through `requestFlushed`, which supplies an explicit test
 * `ExecutionContext` and awaits everything handed to its `waitUntil` before
 * returning -- the same deterministic pattern
 * `backend/test/zarr-data-cache.test.ts`'s `requestWith` already uses for
 * cache-put work deferred the same way -- rather than relying on the
 * fallback fire-and-forget microtask (used when no ExecutionContext is
 * available at all, e.g. a real anonymous `app.request()` call) to have
 * settled by the time `await` resolves.
 */

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { registerCatalogRoutes } from "../src/routes/datasets/catalog";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

type App = Hono<{ Bindings: Bindings; Variables: Variables }>;

function newApp(): App {
  const app: App = new Hono();
  registerCatalogRoutes(app);
  return app;
}

function env(db: Database, environment: Bindings["ENVIRONMENT"] = "development"): Bindings {
  return { DB: realD1(db), ENVIRONMENT: environment } as Bindings;
}

/**
 * Drives one request through `app` with an explicit `ExecutionContext` whose
 * `waitUntil` collects every promise `deferContractCheck` hands it, then
 * awaits `Promise.allSettled` over them before returning -- so the contract
 * check has definitely run by the time the caller inspects
 * `consoleErrorCalls`, mirroring the real Workers runtime keeping the
 * isolate alive until `waitUntil` promises settle (same pattern as
 * `backend/test/zarr-data-cache.test.ts`'s `requestWith`).
 */
async function requestFlushed(
  targetApp: App,
  path: string,
  init: RequestInit,
  reqEnv: Bindings,
): Promise<Response> {
  const waited: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => {
      waited.push(p);
    },
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;
  const res = await targetApp.request(path, init, reqEnv, ctx);
  await Promise.allSettled(waited);
  return res;
}

/** Mirrors facet-filters-route.test.ts's insertDataset: every column not
 *  mentioned defaults to SQLite NULL (or the schema's own DEFAULT), which is
 *  exactly the public-catalog-visible shape this suite needs. */
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
    ...cols,
  };
  const keys = Object.keys(merged);
  db.query(
    `INSERT INTO datasets (dataset_id, ${keys.join(", ")}) VALUES (?, ${keys
      .map(() => "?")
      .join(", ")})`,
  ).run(datasetId, ...(keys.map((k) => merged[k]) as never[]));
}

let db: Database;
let app: App;
let consoleErrorCalls: unknown[][];
let originalConsoleError: typeof console.error;

beforeEach(() => {
  db = freshDb();
  app = newApp();
  consoleErrorCalls = [];
  originalConsoleError = console.error;
  console.error = (...args: unknown[]) => {
    consoleErrorCalls.push(args);
  };
});

afterEach(() => {
  console.error = originalConsoleError;
});

/** Filters the captured console.error calls down to this fix's own
 *  `[contract] <route> response violates the shared contract` line, and
 *  returns each call's structured second argument. */
function contractViolationCalls(
  route: string,
): { dataset_id: unknown; issues: { path: string; message: string }[] }[] {
  return consoleErrorCalls
    .filter(
      (call) =>
        typeof call[0] === "string" &&
        call[0] === `[contract] ${route} response violates the shared contract`,
    )
    .map((call) => call[1] as { dataset_id: unknown; issues: { path: string; message: string }[] });
}

describe("GET /datasets: contract validation hook (issue #1207)", () => {
  test("a deliberately invalid zarr_verify_status logs a violation but the row still serves", async () => {
    // zarr_verify_status is derived via json_extract from the sweep_stamps
    // JSON column (ADR 0034/0035, no dedicated column), which only CHECKs
    // json_valid(...) -- unlike the stored zarr_status column, which carries
    // its own CHECK (status IN (...)) and so cannot hold an out-of-enum
    // value at all. No application write path (the standing fidelity sweep)
    // can produce this value; inserted directly to stand in for a future
    // derive-path regression, the same shape of gap as the issue's own
    // near-miss.
    insertDataset(db, "nm090001", {
      sweep_stamps: JSON.stringify({ zarr_verify_status: "not_a_real_status" }),
    });

    const res = await requestFlushed(app, "/", {}, env(db));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      datasets: { dataset_id: string; zarr_verify_status: string }[];
    };
    const row = body.datasets.find((d) => d.dataset_id === "nm090001");
    // Log-not-throw: the invalid value is still served, unmodified -- this
    // hook must never turn a good (200) response into a failure.
    expect(row?.zarr_verify_status).toBe("not_a_real_status");

    const violations = contractViolationCalls("GET /datasets");
    expect(violations.length).toBe(1);
    expect(violations[0].dataset_id).toContain("nm090001");
    expect(violations[0].issues.some((issue) => issue.path.includes("zarr_verify_status"))).toBe(
      true,
    );
  });

  test("an all-well-formed catalog logs no contract violation", async () => {
    insertDataset(db, "nm090002", { file_size: 100, subject_count: 5 });

    const res = await requestFlushed(app, "/", {}, env(db));
    expect(res.status).toBe(200);
    expect(contractViolationCalls("GET /datasets").length).toBe(0);
  });
});

describe("GET /datasets/:id: contract validation hook (issue #1207)", () => {
  test("a deliberately invalid zarr_verify_status logs a violation but the row still serves", async () => {
    insertDataset(db, "nm090003", {
      sweep_stamps: JSON.stringify({ zarr_verify_status: "not_a_real_status" }),
    });

    const res = await requestFlushed(app, "/nm090003", {}, env(db));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { dataset: { zarr_verify_status: string } };
    expect(body.dataset.zarr_verify_status).toBe("not_a_real_status");

    const violations = contractViolationCalls("GET /datasets/:id");
    expect(violations.length).toBe(1);
    expect(violations[0].dataset_id).toBe("nm090003");
    expect(violations[0].issues.some((issue) => issue.path.includes("zarr_verify_status"))).toBe(
      true,
    );
  });

  // #1224 review, item 1: the detail route used to be saturated from day
  // one -- `SELECT d.*`'s raw numeric `id` and a null `file_size_formatted`
  // both violated the contract on EVERY well-formed row, so this positive
  // control could never have passed before catalog.ts stringified `id` at
  // the source and shared/contract/dataset.ts's datasetDetailSchema was
  // widened to describe the detail route's genuinely nullable
  // file_size_formatted (see that schema's comment for why nullable is the
  // truthful fix here rather than changing the detail route's runtime
  // behavior to match the list route's `''` coalesce).
  test("an all-well-formed row logs no contract violation", async () => {
    insertDataset(db, "nm090007", { name: "Well Formed Detail Fixture" });

    const res = await requestFlushed(app, "/nm090007", {}, env(db));
    expect(res.status).toBe(200);
    expect(contractViolationCalls("GET /datasets/:id").length).toBe(0);
  });
});

describe("Contract validation cost gate: production samples instead of validating every response", () => {
  test("over many production-mode requests, the hook fires sometimes but not on every request", async () => {
    insertDataset(db, "nm090004", {
      sweep_stamps: JSON.stringify({ zarr_verify_status: "not_a_real_status" }),
    });
    const ITERATIONS = 1000;
    for (let i = 0; i < ITERATIONS; i++) {
      const res = await requestFlushed(app, "/", {}, env(db, "production"));
      expect(res.status).toBe(200);
    }
    const violationCount = contractViolationCalls("GET /datasets").length;
    // This is inherently statistical (Math.random()-driven sampling), so say
    // so here rather than pretending the bounds are exact: expected count is
    // ~2% of ITERATIONS (~20). >=1 rules out "production never validates"
    // (silently losing all coverage; P(0 hits) is astronomically small at
    // this sample size for a working 2% gate). <=200 (10x the expected rate)
    // rules out "production validates every response" (the dev/test cost
    // profile leaking into prod, the exact cost problem this gate exists to
    // avoid) while leaving enormous headroom for ordinary statistical
    // variance around the true mean.
    expect(violationCount).toBeGreaterThanOrEqual(1);
    expect(violationCount).toBeLessThanOrEqual(200);
  });
});
