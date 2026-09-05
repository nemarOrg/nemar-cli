/**
 * POST /admin/users/backfill-names (#1255, epic #1250).
 *
 * Most accounts predate the signup-time ORCID name lookup, so they carry an
 * ORCID and no researcher name -- which now blocks publishing, because DOIs
 * cite the uploader by name. This route closes that gap from each account's
 * own public ORCID record.
 *
 * Real engine: bun:sqlite behind realD1 with every migration applied, the
 * real admin router (authMiddleware + adminMiddleware, real hashed tokens),
 * real zod validation. ORCID's public API is a local `Bun.serve()` reached
 * through the ORCID_PUB_API_BASE binding, serving real personal-details
 * response shapes -- so `fetchOrcidName`'s own parse runs, and a per-iD
 * failure is a real HTTP failure rather than a thrown stub.
 *
 * The load-bearing assertions are the ones about what is NOT written: a dry
 * run must write nothing, and a record publishing only half a name must not
 * leave a half-filled row that looks done but still blocks publishing.
 */

import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { adminRoutes } from "../src/routes/admin";
import { hashApiKey } from "../src/services/token";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

const ADMIN_KEY = "backfill-admin-key-0123456789abcdef0123456789ab";

/** ORCID iD -> what the local public API returns for it. */
let records: Record<string, { status: number; body: unknown }>;
let server: ReturnType<typeof Bun.serve>;
let base: string;

let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;

function fullName(given: string, family: string) {
  return {
    status: 200,
    body: { name: { "given-names": { value: given }, "family-name": { value: family } } },
  };
}

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      const m = url.pathname.match(/\/v3\.0\/([^/]+)\/personal-details$/);
      const record = m ? records[m[1]] : undefined;
      if (!record) return new Response("not found", { status: 404 });
      return new Response(JSON.stringify(record.body), {
        status: record.status,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  base = `http://localhost:${server.port}`;
});

afterAll(() => server.stop(true));

async function seedAdmin() {
  db.query(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified,
                        given_name, family_name)
     VALUES ('backfilladmin', 'backfilladmin@example.org', 'x', 'approved', 'admin', 1,
             'Root', 'Admin')`,
  ).run();
  const u = db
    .query<{ id: number }, []>("SELECT id FROM users WHERE username='backfilladmin'")
    .get();
  if (!u) throw new Error("seed: admin insert failed");
  db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)").run(
    u.id,
    await hashApiKey(ADMIN_KEY),
    ADMIN_KEY.slice(0, 8),
  );
}

interface UserSeed {
  orcid?: string | null;
  given?: string | null;
  family?: string | null;
  deleted?: boolean;
}

function seedUser(
  username: string,
  { orcid = null, given = null, family = null, deleted = false }: UserSeed,
) {
  db.query(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified,
                        orcid, given_name, family_name, deleted_at)
     VALUES (?, ?, 'x', 'approved', 'member', 1, ?, ?, ?, ?)`,
  ).run(
    username,
    `${username}@example.org`,
    orcid,
    given,
    family,
    deleted ? "2026-01-01T00:00:00Z" : null,
  );
  const u = db
    .query<{ id: number }, [string]>("SELECT id FROM users WHERE username = ?")
    .get(username);
  if (!u) throw new Error(`seed failed for ${username}`);
  return u.id;
}

function nameOf(username: string) {
  return db
    .query<{ given_name: string | null; family_name: string | null }, [string]>(
      "SELECT given_name, family_name FROM users WHERE username = ?",
    )
    .get(username);
}

function env(): Bindings {
  return { DB: realD1(db), ENVIRONMENT: "test", ORCID_PUB_API_BASE: base } as Bindings;
}

function backfill(body: Record<string, unknown> = {}): Promise<Response> {
  return app.request(
    "/admin/users/backfill-names",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${ADMIN_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    env(),
  );
}

beforeEach(async () => {
  db = freshDb();
  app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/admin", adminRoutes);
  records = {
    "0000-0002-1825-0097": fullName("Ada", "Lovelace"),
    "0000-0001-5109-3519": fullName("Grace", "Hopper"),
  };
  await seedAdmin();
});

describe("POST /admin/users/backfill-names", () => {
  test("dry run by default: reports the fill and writes nothing", async () => {
    seedUser("nameless", { orcid: "0000-0002-1825-0097" });

    const res = await backfill();
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.apply).toBe(false);
    expect(body.would_fill).toBe(1);
    expect(body.filled).toBe(0);
    expect(body.results[0]).toMatchObject({
      username: "nameless",
      outcome: "would_fill",
      given_name: "Ada",
      family_name: "Lovelace",
    });
    // The whole point of a dry run.
    expect(nameOf("nameless")).toEqual({ given_name: null, family_name: null });
  });

  test("apply: true writes the name and logs an audit row", async () => {
    seedUser("nameless", { orcid: "0000-0002-1825-0097" });

    const res = await backfill({ apply: true });
    const body = await res.json();

    expect(body.filled).toBe(1);
    expect(nameOf("nameless")).toEqual({ given_name: "Ada", family_name: "Lovelace" });

    const audit = db
      .query<{ action: string; details: string | null }, []>(
        "SELECT action, details FROM audit_log WHERE action = 'user_names_backfilled'",
      )
      .get();
    expect(audit).not.toBeNull();
    expect(JSON.parse(audit?.details ?? "{}").filled).toBe(1);
  });

  test("fills a HALF-filled row too", async () => {
    // family_name set, given_name NULL: still not citable, still a candidate.
    seedUser("halfnamed", { orcid: "0000-0002-1825-0097", family: "Lovelace" });

    const res = await backfill({ apply: true });
    expect((await res.json()).filled).toBe(1);
    expect(nameOf("halfnamed")).toEqual({ given_name: "Ada", family_name: "Lovelace" });
  });

  test("writes NOTHING when the record publishes only half a name", async () => {
    records["0000-0002-1825-0097"] = {
      status: 200,
      body: { name: { "given-names": { value: "Ada" }, "family-name": null } },
    };
    seedUser("nameless", { orcid: "0000-0002-1825-0097" });

    const res = await backfill({ apply: true });
    const body = await res.json();

    expect(body.no_public_name).toBe(1);
    expect(body.filled).toBe(0);
    // A row with given_name set and family_name NULL would still block
    // publishing, while looking filled to the next operator reading the table.
    expect(nameOf("nameless")).toEqual({ given_name: null, family_name: null });
  });

  test("a failing ORCID read is reported and leaves the row a candidate", async () => {
    records["0000-0002-1825-0097"] = { status: 503, body: {} };
    seedUser("unreadable", { orcid: "0000-0002-1825-0097" });
    seedUser("readable", { orcid: "0000-0001-5109-3519" });

    const res = await backfill({ apply: true });
    const body = await res.json();

    expect(body.lookup_failed).toBe(1);
    // The batch continued: one bad record does not strand the rest.
    expect(body.filled).toBe(1);
    expect(nameOf("readable")).toEqual({ given_name: "Grace", family_name: "Hopper" });
    expect(nameOf("unreadable")).toEqual({ given_name: null, family_name: null });
    expect(body.remaining).toBe(1);
  });

  test("skips accounts that already have a full name", async () => {
    seedUser("named", {
      orcid: "0000-0002-1825-0097",
      given: "Existing",
      family: "Name",
    });

    const res = await backfill({ apply: true });
    const body = await res.json();

    expect(body.scanned).toBe(0);
    expect(nameOf("named")).toEqual({ given_name: "Existing", family_name: "Name" });
  });

  test("skips accounts with no ORCID (nothing to read a name from)", async () => {
    seedUser("noorcid", {});

    const res = await backfill({ apply: true });
    expect((await res.json()).scanned).toBe(0);
  });

  test("skips deleted accounts", async () => {
    seedUser("tombstoned", { orcid: "0000-0002-1825-0097", deleted: true });

    const res = await backfill({ apply: true });
    expect((await res.json()).scanned).toBe(0);
  });

  test("limit bounds the batch and remaining reports the rest", async () => {
    seedUser("first", { orcid: "0000-0002-1825-0097" });
    seedUser("second", { orcid: "0000-0001-5109-3519" });

    const res = await backfill({ apply: true, limit: 1 });
    const body = await res.json();

    expect(body.scanned).toBe(1);
    expect(body.filled).toBe(1);
    expect(body.remaining).toBe(1);
  });

  test("is idempotent: a second run has nothing left to do", async () => {
    seedUser("nameless", { orcid: "0000-0002-1825-0097" });

    await backfill({ apply: true });
    const second = await backfill({ apply: true });
    const body = await second.json();

    expect(body.scanned).toBe(0);
    expect(body.remaining).toBe(0);
  });

  test("requires an admin token", async () => {
    seedUser("nameless", { orcid: "0000-0002-1825-0097" });
    const res = await app.request(
      "/admin/users/backfill-names",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      },
      env(),
    );
    expect(res.status).toBe(401);
    expect(nameOf("nameless")).toEqual({ given_name: null, family_name: null });
  });
});
