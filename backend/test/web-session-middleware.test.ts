/**
 * webSessionMiddleware's SCHEMA-vs-transient lookup-failure logging (epic
 * #1272 phase 4, #1284 review; ADR 0048): a migration-ordering mistake (a
 * column or table the query names does not exist yet on this environment)
 * must not be indistinguishable in the logs from a transient D1 blip.
 *
 * Real engine: a bun:sqlite database migrated only up to (not including)
 * migration 0082 -- which is exactly what `findSessionByCookieId`'s SELECT
 * (services/web-session.ts) reads `u.account_kind` from -- so the middleware's
 * catch receives a REAL "no such column" error from SQLite, not a hand-typed
 * `Error()`. No mocks; `console.error` is captured (not replaced with a
 * fake implementation of anything under test) the same way
 * manifest-sweep-guard.test.ts already does.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { webSessionMiddleware } from "../src/middleware/webSession";
import type { Bindings, Variables } from "../src/types/bindings";
import { realD1 } from "./helpers/d1";

const MIGRATIONS_DIR = join(import.meta.dir, "../src/db/migrations");
const TARGET = "0082_account_kind.sql";

/** Apply every migration up to (not including) the target -- mirrors
 *  account-kind-migration.test.ts's own helper. */
function dbBeforeTarget(): Database {
  const db = new Database(":memory:");
  for (const file of readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql") && f < TARGET)
    .sort()) {
    db.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf-8"));
  }
  return db;
}

let app: Hono<{ Bindings: Bindings; Variables: Variables }>;
let logs: unknown[][];
const realError = console.error;

beforeEach(() => {
  logs = [];
  console.error = (...args: unknown[]) => {
    logs.push(args);
  };
  app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.get("/probe", webSessionMiddleware, (c) => c.json({ ok: true }));
});

afterEach(() => {
  console.error = realError;
});

describe("webSessionMiddleware: SCHEMA vs transient lookup failures", () => {
  test("a real 'no such column' error (DB migrated behind the code) logs with the SCHEMA prefix", async () => {
    const db = dbBeforeTarget();
    const res = await app.request(
      "/probe",
      { headers: { Cookie: "nemar_session=whatever-nonempty-cookie-value" } },
      { DB: realD1(db) } as Bindings,
    );
    // Never blocks the request: the route still gets to decide.
    expect(res.status).toBe(200);

    const schemaLogs = logs.filter((l) => String(l[0]).includes("[web-session-mw] SCHEMA"));
    expect(schemaLogs).toHaveLength(1);
    expect(String(schemaLogs[0][1])).toContain("no such column");

    const plainLogs = logs.filter((l) => String(l[0]) === "[web-session-mw] lookup failed");
    expect(plainLogs).toHaveLength(0);
  });

  test("a no-op request (no cookie at all) never logs anything", async () => {
    const db = dbBeforeTarget();
    const res = await app.request("/probe", {}, { DB: realD1(db) } as Bindings);
    expect(res.status).toBe(200);
    expect(logs).toHaveLength(0);
  });
});
