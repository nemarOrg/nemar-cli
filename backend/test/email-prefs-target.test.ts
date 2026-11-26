import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { resolveEmailPrefsTarget } from "../src/routes/admin/users";

// Thin real-SQLite -> D1 passthrough so the production code runs its exact
// .prepare().bind().first() against a real database (no mocks; bun:sqlite
// executes the real SQL). Only the methods this code path uses are wired.
type Stmt = {
  bind: (...params: unknown[]) => Stmt;
  first: <T>() => Promise<T | null>;
  all: <T>() => Promise<{ results: T[] }>;
  run: () => Promise<{ success: boolean }>;
};

function asD1(db: Database): D1Database {
  const prepare = (sql: string): Stmt => {
    const stmt = db.query(sql);
    const make = (params: unknown[]): Stmt => ({
      bind: (...p: unknown[]) => make(p),
      first: async <T>() => (stmt.get(...(params as never[])) as T) ?? null,
      all: async <T>() => ({ results: stmt.all(...(params as never[])) as T[] }),
      run: async () => ({ success: true }),
    });
    return make([]);
  };
  return { prepare } as unknown as D1Database;
}

// resolveEmailPrefsTarget resolves whose email preferences a request targets (#808 follow-up).
// Since epic #2260 (ADR 0132) an owner or an admin may act for another account; what an admin may
// change there is the PUT handler's rule, proved through the real route in
// mail-preferences-route-d1.test.ts. Real bun:sqlite, no mocks: the query and the role logic are
// exercised exactly as production runs them.
describe("resolveEmailPrefsTarget", () => {
  let db: D1Database;

  beforeEach(() => {
    const raw = new Database(":memory:");
    raw.run(
      "CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, role TEXT, deleted_at TEXT);",
    );
    raw.run(
      `INSERT INTO users (id, username, role, deleted_at) VALUES
        (2, 'yahya', 'owner', NULL),
        (7, 'test-admin', 'admin', NULL),
        (13, 'arnodelorme', 'owner', NULL),
        (99, 'gone', 'admin', '2026-01-01');`,
    );
    db = asD1(raw);
  });

  const owner = { id: 2, username: "yahya", role: "owner" };
  const admin = { id: 7, username: "test-admin", role: "admin" };
  const member = { id: 21, username: "plain-member", role: "member" };

  test("no target -> the caller (self)", async () => {
    expect(await resolveEmailPrefsTarget(db, admin, undefined)).toEqual({
      id: 7,
      username: "test-admin",
    });
  });

  test("targeting own username -> self (no role gate)", async () => {
    expect(await resolveEmailPrefsTarget(db, admin, "test-admin")).toEqual({
      id: 7,
      username: "test-admin",
    });
  });

  test("owner targeting another user -> that user", async () => {
    expect(await resolveEmailPrefsTarget(db, owner, "test-admin")).toEqual({
      id: 7,
      username: "test-admin",
    });
  });

  test("an admin targeting another user -> that user (D8: owners and admins may act for others)", async () => {
    expect(await resolveEmailPrefsTarget(db, admin, "arnodelorme")).toEqual({
      id: 13,
      username: "arnodelorme",
    });
  });

  test("a requester who is neither owner nor admin targeting another user -> 403", async () => {
    // The route sits behind adminMiddleware, so this is the helper's own guard: it must not
    // become a way for a member to reach another account if it is ever mounted elsewhere.
    expect(await resolveEmailPrefsTarget(db, member, "arnodelorme")).toEqual({
      error: "Only owners and admins can manage other users' email preferences",
      status: 403,
    });
  });

  test("an admin targeting a missing or soft-deleted user -> 404", async () => {
    expect(await resolveEmailPrefsTarget(db, admin, "nobody")).toEqual({
      error: "User not found: nobody",
      status: 404,
    });
    expect(await resolveEmailPrefsTarget(db, admin, "gone")).toEqual({
      error: "User not found: gone",
      status: 404,
    });
  });

  test("owner targeting a missing user -> 404", async () => {
    expect(await resolveEmailPrefsTarget(db, owner, "nobody")).toEqual({
      error: "User not found: nobody",
      status: 404,
    });
  });

  test("owner targeting a soft-deleted user -> 404", async () => {
    expect(await resolveEmailPrefsTarget(db, owner, "gone")).toEqual({
      error: "User not found: gone",
      status: 404,
    });
  });
});
