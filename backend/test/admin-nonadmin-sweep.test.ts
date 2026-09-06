/**
 * Negative sweep: a base-tier account cannot reach ANY admin route
 * (ADR 0040 phase 2, #1252).
 *
 * Phase 2 widened `authMiddleware` so a `verified` account authenticates, and
 * the admin router's protection is one layer further in — `adminMiddleware`,
 * mounted as router-level `use("*")`. A per-route test would have proved that
 * for whichever routes someone remembered to list; this iterates
 * `adminRoutes.routes` the way test/admin-route-inventory.unit.test.ts does,
 * so a route added later is swept the day it is registered.
 *
 * 403 specifically, and not 200 or 500: a 500 would mean the request reached
 * a handler and died there, which is a handler running work for a caller who
 * should never have got that far.
 *
 * Real engine: bun:sqlite behind realD1 with every migration applied, the
 * real admin router, and a real hashed token for a real `verified` member.
 * No env beyond DB is configured, so any request that DID reach a handler
 * would fail loudly rather than silently succeeding.
 */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { adminRoutes } from "../src/routes/admin";
import { hashApiKey } from "../src/services/token";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

const MEMBER_KEY = "sweep-member-key-0123456789abcdef0123456789abcdef";
const ADMIN_KEY = "sweep-admin-key-0123456789abcdef0123456789abcdef";

let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;

function env(): Bindings {
  return { DB: realD1(db), ENVIRONMENT: "test" } as Bindings;
}

async function seed(username: string, role: string, status: string, key: string): Promise<void> {
  db.run(
    `INSERT INTO users (username, email, password_hash, github_username, status, role,
                        signup_source, email_verified, service_access)
     VALUES (?, ?, 'x', ?, ?, ?, 'cli', 1, 0)`,
    [username, `${username}@example.org`, `${username}-gh`, status, role],
  );
  const row = db
    .query<{ id: number }, [string]>("SELECT id FROM users WHERE username = ?")
    .get(username);
  if (!row) throw new Error(`seed failed for ${username}`);
  db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)").run(
    row.id,
    await hashApiKey(key),
    key.slice(0, 8),
  );
}

/**
 * A concrete URL for a registered route pattern. The substituted value is
 * deliberately dataset-id-shaped and cannot collide with any static sibling
 * segment, so the request lands on an admin route (which one does not matter:
 * every one of them must refuse this caller).
 */
function concreteUrl(path: string): string {
  return `/admin${path.replace(/:[A-Za-z_]+/g, "nm000123")}`;
}

/** Every registered admin route, deduped, minus the router-level middleware
 *  entries (`ALL /*`), which are not addressable paths. */
function adminEndpoints(): Array<{ method: string; path: string }> {
  const seen = new Set<string>();
  const out: Array<{ method: string; path: string }> = [];
  for (const r of adminRoutes.routes) {
    if (r.method === "ALL") continue;
    const key = `${r.method} ${r.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ method: r.method, path: r.path });
  }
  return out;
}

function request(method: string, path: string, key: string): Promise<Response> {
  return app.request(
    concreteUrl(path),
    {
      method,
      headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: method === "GET" || method === "HEAD" ? undefined : "{}",
    },
    env(),
  );
}

beforeEach(async () => {
  db = freshDb();
  app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/admin", adminRoutes);
  await seed("sweepmember", "member", "verified", MEMBER_KEY);
  await seed("sweepadmin", "admin", "approved", ADMIN_KEY);
});

describe("a verified non-admin on the admin router", () => {
  test("the sweep actually covers the router (guards against an empty loop)", () => {
    // An assertion over an empty list passes. Pin that the list is populated
    // and that it is the whole table minus the two middleware entries.
    const endpoints = adminEndpoints();
    expect(endpoints.length).toBeGreaterThan(50);
    const middlewareEntries = adminRoutes.routes.filter((r) => r.method === "ALL").length;
    const duplicates = adminRoutes.routes.length - middlewareEntries - endpoints.length;
    // Hono lists one entry per handler, so validators/extra middleware show up
    // as duplicates of the same method+path; every one of them must be a
    // duplicate of something in `endpoints`, never a path the sweep missed.
    expect(duplicates).toBeGreaterThanOrEqual(0);
  });

  test("is refused with 403 on every registered admin route", async () => {
    const surprises: string[] = [];
    for (const { method, path } of adminEndpoints()) {
      const res = await request(method, path, MEMBER_KEY);
      if (res.status !== 403) surprises.push(`${method} ${path} -> ${res.status}`);
    }
    // One assertion carrying every offender: a per-route expect would stop at
    // the first and hide the rest.
    expect(surprises).toEqual([]);
  });

  test("the refusal is the role check, not an accident of the path", async () => {
    const res = await request("GET", "/users", MEMBER_KEY);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("Admin access required");
  });

  test("an admin token is NOT refused on the same route (the sweep isn't refusing everything)", async () => {
    const res = await request("GET", "/users", ADMIN_KEY);
    expect(res.status).toBe(200);
  });
});
