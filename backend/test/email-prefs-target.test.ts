import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { resolveEmailPrefsTarget } from "../src/routes/admin";

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

// resolveEmailPrefsTarget gates owner-manages-others for email preferences (#808
// follow-up). Real bun:sqlite, no mocks: the query and the role/owner logic are
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

  test("no target -> the caller (self)", async () => {
    expect(await resolveEmailPrefsTarget(db, admin, undefined)).toEqual({
      id: 7,
      username: "test-admin",
    });
  });

  test("targeting own username -> self (no owner gate)", async () => {
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

  test("non-owner targeting another user -> 403", async () => {
    expect(await resolveEmailPrefsTarget(db, admin, "arnodelorme")).toEqual({
      error: "Only owners can manage other users' email preferences",
      status: 403,
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
