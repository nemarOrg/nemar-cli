/**
 * Issue #1152: `GET /datasets`, `GET /datasets/search`, and `GET
 * /datasets/resolve/:id` are all anonymous (`optionalAuthMiddleware`), so
 * their failure-path `details` field must never carry the raw
 * `Error#message` -- table/column names, query shape, occasionally
 * file-path fragments -- to an unauthenticated caller. The real message
 * must still reach the server-side `console.error` log unchanged.
 *
 * Per `.rules/testing.md`'s "test the entry point" rule, every case here
 * drives the real registered route (`app.request`) against a real
 * bun:sqlite-backed D1 (`realD1`) wrapped with a fault-injection layer that
 * throws a controlled, distinctive message from a specific query --
 * mirroring the project's established pattern in
 * backend/test/facet-filters-route.test.ts's `excludedUnknownFailingD1` /
 * `primaryCountFailingD1` -- rather than a canned-response mock.
 */

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { registerCatalogRoutes } from "../src/routes/datasets/catalog";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

type App = Hono<{ Bindings: Bindings; Variables: Variables }>;

const GENERIC_DETAILS = "An internal error occurred while processing this request.";

function newApp(): App {
  const app: App = new Hono();
  registerCatalogRoutes(app);
  return app;
}

/**
 * Wraps a real D1 (bun:sqlite-backed) so `fault(sql, method)` can inject a
 * synchronous throw from a specific prepared statement's `.all()`/`.first()`/
 * `.run()` call, identified by a SQL substring -- every OTHER query still
 * executes against real SQLite. Returns the message to throw, or `undefined`
 * to let the real call proceed.
 */
function faultyD1(
  target: Database,
  fault: (sql: string, method: string) => string | undefined,
): Bindings {
  const base = realD1(target);
  return {
    DB: {
      prepare(sql: string) {
        const stmt = base.prepare(sql);
        const wrapper = {
          bind: (...args: unknown[]) => {
            stmt.bind(...args);
            return wrapper;
          },
          run: () => {
            const msg = fault(sql, "run");
            if (msg) throw new Error(msg);
            return stmt.run();
          },
          first: <T>() => {
            const msg = fault(sql, "first");
            if (msg) throw new Error(msg);
            return stmt.first<T>();
          },
          all: <T>() => {
            const msg = fault(sql, "all");
            if (msg) throw new Error(msg);
            return stmt.all<T>();
          },
        };
        return wrapper;
      },
    } as unknown as D1Database,
    ENVIRONMENT: "development",
  } as Bindings;
}

/** Marker unique to the public `GET /datasets` main/prefix query
 *  (`buildPublicPrefix`), absent from the degraded fallback query -- lets a
 *  fault target one without the other. */
const PUBLIC_PREFIX_MARKER = "d.dataset_id AS id";

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

function loggedRawMessage(needle: string): boolean {
  return consoleErrorCalls.some((call) =>
    call.some((arg) => typeof arg === "string" && arg.includes(needle)),
  );
}

describe("GET /datasets: anonymous callers never see the raw D1 error message", () => {
  test("an opaque main-query failure returns a generic details string, logs the real one", async () => {
    const RAW = "D1_ERROR: table nemar_internal_credentials has no column named super_secret_token";
    const env = faultyD1(db, (sql, method) =>
      method === "all" && sql.includes(PUBLIC_PREFIX_MARKER) ? RAW : undefined,
    );

    const res = await app.request("/", {}, env);
    expect(res.status).toBe(500);
    const bodyText = await res.text();
    const body = JSON.parse(bodyText) as { error: string; details: string };

    expect(body.error).toBe("Failed to retrieve datasets");
    expect(body.details).toBe(GENERIC_DETAILS);
    // The raw message must not appear anywhere in the response body.
    expect(bodyText.includes("super_secret_token")).toBe(false);
    expect(bodyText.includes("nemar_internal_credentials")).toBe(false);
    // But it must still be visible server-side.
    expect(loggedRawMessage(RAW)).toBe(true);
  });

  test("a failure that also breaks the degraded fallback query still returns a generic details string", async () => {
    // A message matching one of executeAndReturn's graceful-degradation
    // triggers ("no such column") so the handler enters the fallback branch;
    // the fallback query itself is then ALSO made to fail, landing in the
    // nested catch this fix touches (previously unlogged and leaking
    // fallbackMsg raw).
    const FALLBACK_RAW = "FALLBACK_INTERNAL: unreachable replica at /var/lib/leaked/secrets.env";
    const env = faultyD1(db, (sql, method) => {
      if (method !== "all") return undefined;
      if (sql.includes(PUBLIC_PREFIX_MARKER)) return "no such column: fake_column_xyz";
      return FALLBACK_RAW;
    });

    const res = await app.request("/", {}, env);
    expect(res.status).toBe(500);
    const bodyText = await res.text();
    const body = JSON.parse(bodyText) as { error: string; details: string };

    expect(body.error).toBe("Failed to retrieve datasets");
    expect(body.details).toBe(GENERIC_DETAILS);
    expect(bodyText.includes("secrets.env")).toBe(false);
    expect(bodyText.includes("FALLBACK_INTERNAL")).toBe(false);
    // The fallback catch had no console.error before this fix -- assert the
    // real message is now actually logged, not just hidden.
    expect(loggedRawMessage(FALLBACK_RAW)).toBe(true);
  });
});

describe("GET /datasets/search: anonymous callers never see the raw D1 error message", () => {
  test("an opaque FTS-tier failure returns a generic details string, logs the real one", async () => {
    const RAW = "FTS_INTERNAL: index shard 7 corrupt at offset 0x1F3, path=/data/shard7.db";
    const env = faultyD1(db, (sql, method) =>
      method === "all" && sql.includes("JOIN datasets d ON d.id = datasets_fts.rowid")
        ? RAW
        : undefined,
    );

    const res = await app.request("/search?q=eeg", {}, env);
    expect(res.status).toBe(500);
    const bodyText = await res.text();
    const body = JSON.parse(bodyText) as { error: string; details: string };

    expect(body.error).toBe("Search failed");
    expect(body.details).toBe(GENERIC_DETAILS);
    expect(bodyText.includes("shard7.db")).toBe(false);
    expect(bodyText.includes("FTS_INTERNAL")).toBe(false);
    expect(loggedRawMessage(RAW)).toBe(true);
  });
});

describe("GET /datasets/resolve/:sourceId: anonymous callers never see the raw D1 error message", () => {
  test("an opaque query failure returns a generic details string, logs the real one", async () => {
    const RAW = "RESOLVE_INTERNAL: replica lag exceeded on shard nemar-3, key=/secrets/ssh_key";
    const env = faultyD1(db, (sql, method) =>
      method === "first" && sql.includes("WHERE d.source_id = ?") ? RAW : undefined,
    );

    const res = await app.request("/resolve/ds123456", {}, env);
    expect(res.status).toBe(500);
    const bodyText = await res.text();
    const body = JSON.parse(bodyText) as { error: string; details: string };

    expect(body.error).toBe("Failed to resolve dataset");
    expect(body.details).toBe(GENERIC_DETAILS);
    expect(bodyText.includes("ssh_key")).toBe(false);
    expect(bodyText.includes("RESOLVE_INTERNAL")).toBe(false);
    expect(loggedRawMessage(RAW)).toBe(true);
  });
});
