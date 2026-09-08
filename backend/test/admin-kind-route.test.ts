/**
 * POST /admin/users/:username/kind and GET /admin/users?kind= (epic #1272
 * phase 4, #1284; ADR 0048).
 *
 * Real engine: bun:sqlite behind realD1 with every migration applied, the
 * real admin router (authMiddleware + adminMiddleware + ownerMiddleware,
 * real hashed tokens). No mocks.
 *
 * ONE THING THIS FILE CANNOT EXERCISE, BY CONSTRUCTION, NOT BY OMISSION
 * (`.rules/testing.md`: say so when real data cannot falsify a rule): the
 * ACTUAL concurrent race the kind route's guarded UPDATE closes (two
 * owners changing the same account's kind at once). Tried first with
 * `Promise.all([postKind(target, "service"), postKind(target, "test")])`
 * run 20 times against this harness: every attempt landed 200/200, never
 * 200/409 -- `realD1`'s `.first()`/`.run()` wrap an already-synchronous
 * bun:sqlite call in `Promise.resolve(...)`, so by the time either
 * request's async function yields at an `await`, ITS OWN database
 * operation has already completed; nothing is left for the other
 * request's handler to interleave with. Same limitation
 * device-auth-routes.test.ts's header documents for its own conditional
 * UPDATEs. The "guarded UPDATE's shape" test below is the real-engine
 * substitute this file uses instead: it runs the EXACT exported statement
 * the route runs, and proves its guard by mutating the row between two
 * calls to it -- by hand, since the harness cannot do it via real
 * concurrency -- rather than asserting something a fake would only be
 * pretending to prove.
 */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { ACCOUNT_KIND_ERROR_MESSAGES } from "../../shared/contract/user.js";
import { adminRoutes } from "../src/routes/admin";
import { KIND_CHANGE_GUARDED_UPDATE_SQL } from "../src/routes/admin/users";
import { hashApiKey } from "../src/services/token";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

const OWNER_KEY = "kind-route-owner-key-0123456789abcdef012345";
const ADMIN_KEY = "kind-route-admin-key-0123456789abcdef012345";

let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;

async function seedActor(username: string, role: "owner" | "admin", apiKey: string): Promise<void> {
  db.query(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified, service_access)
     VALUES (?, ?, 'x', 'approved', ?, 1, 1)`,
  ).run(username, `${username}@example.org`, role);
  const u = db
    .query<{ id: number }, [string]>("SELECT id FROM users WHERE username = ?")
    .get(username);
  if (!u) throw new Error("seed: actor insert failed");
  db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)").run(
    u.id,
    await hashApiKey(apiKey),
    apiKey.slice(0, 8),
  );
}

function seedTarget(
  username: string,
  opts: { accountKind?: "person" | "service" | "test"; orcidVerified?: boolean } = {},
): void {
  db.query(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified, account_kind, orcid, orcid_verified)
     VALUES (?, ?, 'x', 'verified', 'member', 1, ?, ?, ?)`,
  ).run(
    username,
    `${username}@example.org`,
    opts.accountKind ?? "person",
    opts.orcidVerified ? "0000-0002-1825-0097" : null,
    opts.orcidVerified ? 1 : 0,
  );
}

function kindOf(username: string): string | undefined {
  return db
    .query<{ account_kind: string }, [string]>("SELECT account_kind FROM users WHERE username = ?")
    .get(username)?.account_kind;
}

function auditRows(action: string) {
  return db
    .query<
      { user_id: number | null; resource_id: string | null; details: string | null },
      [string]
    >("SELECT user_id, resource_id, details FROM audit_log WHERE action = ? ORDER BY id")
    .all(action);
}

function postKind(username: string, kind: string, apiKey: string): Promise<Response> {
  return app.request(
    `/admin/users/${username}/kind`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ kind }),
    },
    { DB: realD1(db), ENVIRONMENT: "test" } as Bindings,
  );
}

function getUsers(query: string, apiKey: string): Promise<Response> {
  return app.request(`/admin/users${query}`, { headers: { Authorization: `Bearer ${apiKey}` } }, {
    DB: realD1(db),
    ENVIRONMENT: "test",
  } as Bindings);
}

beforeEach(async () => {
  db = freshDb();
  app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/admin", adminRoutes);
  await seedActor("kindowner", "owner", OWNER_KEY);
  await seedActor("kindadmin", "admin", ADMIN_KEY);
});

describe("POST /admin/users/:username/kind", () => {
  test("an owner changes a person to service and back", async () => {
    seedTarget("persona1", { accountKind: "person" });

    const toService = await postKind("persona1", "service", OWNER_KEY);
    expect(toService.status).toBe(200);
    const body = (await toService.json()) as { message: string; user: { account_kind: string } };
    expect(body.user.account_kind).toBe("service");
    expect(body.message).toContain("'person' to 'service'");
    expect(kindOf("persona1")).toBe("service");

    const toTest = await postKind("persona1", "test", OWNER_KEY);
    expect(toTest.status).toBe(200);
    expect(kindOf("persona1")).toBe("test");
  });

  test("an admin (non-owner) gets 403", async () => {
    seedTarget("persona2");
    const res = await postKind("persona2", "service", ADMIN_KEY);
    expect(res.status).toBe(403);
    expect(kindOf("persona2")).toBe("person");
  });

  test("targeting your own account answers 400 own_account", async () => {
    const res = await postKind("kindowner", "service", OWNER_KEY);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("own_account");
    expect(body.message).toBe(ACCOUNT_KIND_ERROR_MESSAGES.own_account);
    expect("code" in body).toBe(false);
    expect(kindOf("kindowner")).toBe("person");
  });

  test("an unchanged kind answers 409 same_kind, with the typed message and no separate code field", async () => {
    seedTarget("persona3", { accountKind: "test" });
    const res = await postKind("persona3", "test", OWNER_KEY);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("same_kind");
    expect(body.message).toBe(ACCOUNT_KIND_ERROR_MESSAGES.same_kind);
    expect("code" in body).toBe(false);
  });

  test("an invalid kind value answers 400 at the validation boundary", async () => {
    seedTarget("persona4");
    const res = await postKind("persona4", "bogus", OWNER_KEY);
    expect(res.status).toBe(400);
    expect(kindOf("persona4")).toBe("person");
  });

  test("an unknown username answers 404", async () => {
    const res = await postKind("nonexistent-user", "service", OWNER_KEY);
    expect(res.status).toBe(404);
  });

  test("a verified ORCID iD refuses the move to a non-person kind with 409 orcid_linked", async () => {
    seedTarget("persona5", { accountKind: "person", orcidVerified: true });
    const res = await postKind("persona5", "service", OWNER_KEY);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("orcid_linked");
    expect(body.message).toBe(ACCOUNT_KIND_ERROR_MESSAGES.orcid_linked);
    expect(body.message).toContain("nemar auth profile orcid unlink");
    expect("code" in body).toBe(false);
    expect(kindOf("persona5")).toBe("person");
  });

  test("a verified ORCID iD does NOT block a move TO person (already person, so this is same_kind)", async () => {
    // The orcid_linked refusal only fires for a move AWAY from person; moving
    // INTO person with a verified iD is the ordinary, unblocked case.
    seedTarget("persona6", { accountKind: "test", orcidVerified: true });
    const res = await postKind("persona6", "person", OWNER_KEY);
    expect(res.status).toBe(200);
    expect(kindOf("persona6")).toBe("person");
  });

  test("writes an account_kind_changed audit row with from/to", async () => {
    seedTarget("persona7", { accountKind: "person" });
    await postKind("persona7", "service", OWNER_KEY);
    const rows = auditRows("account_kind_changed");
    expect(rows).toHaveLength(1);
    expect(rows[0].resource_id).toBe("persona7");
    expect(JSON.parse(rows[0].details ?? "{}")).toMatchObject({ from: "person", to: "service" });
  });

  test("keys are not revoked on a kind change", async () => {
    seedTarget("persona8", { accountKind: "person" });
    const target = db
      .query<{ id: number }, [string]>("SELECT id FROM users WHERE username = ?")
      .get("persona8");
    if (!target) throw new Error("seed failed");
    db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)").run(
      target.id,
      "persona8-existing-hash",
      "nm_persona",
    );

    await postKind("persona8", "service", OWNER_KEY);

    const row = db
      .query<{ revoked_at: string | null }, [string]>(
        "SELECT revoked_at FROM tokens WHERE api_key_hash = ?",
      )
      .get("persona8-existing-hash");
    expect(row?.revoked_at).toBeNull();
  });

  test("the guarded UPDATE's shape: a matching from-kind updates, a stale one does not (kind_changed_concurrently)", async () => {
    // Proves what the route's own zero-changes branch answers
    // `kind_changed_concurrently` for, without needing a real concurrent
    // requester -- bun:sqlite's single-writer test double cannot reliably
    // produce that interleaving (see the SQL constant's own docstring and
    // device-auth-routes.test.ts's header for the same limitation). This
    // "flips the kind between read and write" by hand: read, then mutate
    // the row as a concurrent winner would have, then run the SAME guarded
    // statement the route runs with the now-STALE from-kind and observe it
    // change nothing.
    seedTarget("persona9", { accountKind: "person" });
    const target = db
      .query<{ id: number; account_kind: string }, [string]>(
        "SELECT id, account_kind FROM users WHERE username = ?",
      )
      .get("persona9");
    if (!target) throw new Error("seed failed");
    expect(target.account_kind).toBe("person");

    // A matching from-kind updates.
    const matching = db.query(KIND_CHANGE_GUARDED_UPDATE_SQL).run("service", target.id, "person");
    expect(matching.changes).toBe(1);
    expect(kindOf("persona9")).toBe("service");

    // A concurrent winner changes the row again, out from under the first
    // read (the row is now 'test', not the 'person' the guard below still
    // names).
    db.query("UPDATE users SET account_kind = 'test' WHERE id = ?").run(target.id);

    // The SAME statement, bound with the now-stale `person` from-kind,
    // changes nothing -- this is exactly the shape that makes the route
    // answer 409 `kind_changed_concurrently` instead of silently
    // overwriting the concurrent winner's write.
    const stale = db.query(KIND_CHANGE_GUARDED_UPDATE_SQL).run("service", target.id, "person");
    expect(stale.changes).toBe(0);
    expect(kindOf("persona9")).toBe("test");
  });
});

describe("GET /admin/users?kind=", () => {
  beforeEach(() => {
    seedTarget("filterperson", { accountKind: "person" });
    seedTarget("filterservice", { accountKind: "service" });
    seedTarget("filtertest", { accountKind: "test" });
  });

  test("narrows to the requested kind", async () => {
    const body = (await (await getUsers("?kind=test", OWNER_KEY)).json()) as {
      users: { username: string }[];
    };
    expect(body.users.map((u) => u.username)).toEqual(["filtertest"]);
  });

  test("an invalid kind value answers 400", async () => {
    const res = await getUsers("?kind=bogus", OWNER_KEY);
    expect(res.status).toBe(400);
  });

  test("account_kind is carried on every listed row", async () => {
    const body = (await (await getUsers("?kind=service", OWNER_KEY)).json()) as {
      users: { username: string; account_kind: string }[];
    };
    expect(body.users[0]?.account_kind).toBe("service");
  });
});
