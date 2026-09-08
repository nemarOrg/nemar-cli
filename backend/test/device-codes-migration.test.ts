/**
 * Migration 0081: `device_codes` (RFC 8628; epic #1272 phase 1, #1281;
 * ADR 0047).
 *
 * Drives the SQL constants exported by `services/device-auth.ts` directly
 * against a real bun:sqlite database with every migration applied --
 * `.rules/testing.md` forbids hand-copying SQL into a test, so every
 * statement here is imported, never retyped. What the route tests
 * (`device-auth-routes.test.ts`) cannot show is that the SCHEMA itself
 * enforces "confirmed/consumed implies user_id", the UNIQUE user_code, and
 * the cascade/SET NULL foreign keys -- those only fail if the application is
 * NOT careful, which is exactly what a schema-level test is for.
 *
 * bun:sqlite's `Database.exec()` swallows CHECK-constraint errors (it runs
 * every statement in the string and does not surface a failure the way
 * `prepare().run()` does), so every assertion that expects a CHECK or
 * UNIQUE violation to throw uses `db.query(...).run(...)`, never `db.exec`.
 *
 * Real bun:sqlite with every migration applied. No mocks.
 */

import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  DEVICE_CONFIRM_SQL,
  DEVICE_DENY_SQL,
  DEVICE_INSERT_SQL,
  DEVICE_MINT_CONSUME_SQL,
  DEVICE_MINT_INSERT_SQL,
  DEVICE_POLL_SQL,
  DEVICE_PRUNE_SQL,
  DEVICE_ROW_BY_HASH_SQL,
  DEVICE_ROW_BY_USER_CODE_SQL,
  DEVICE_STAMP_EXPIRED_SQL,
  KEY_MINT_SQL,
} from "../src/services/device-auth";
import { freshDb } from "./helpers/d1";

const MIGRATIONS_DIR = join(import.meta.dir, "../src/db/migrations");

/**
 * A fresh DB, replayed with `legacy_alter_table` OFF -- the modern SQLite
 * default (3.25+) real D1 uses, where renaming a table (`users_new` ->
 * `users`, migration 0026) rewrites OTHER tables' declared foreign keys to
 * follow the new name. bun:sqlite's `Database` defaults that pragma ON,
 * which leaves `tokens.user_id`'s FK target frozen at the pre-rename
 * `users_new` and makes ANY write to `tokens` throw `no such table: main
 * .users_new` once `PRAGMA foreign_keys = ON` -- a bun:sqlite test-harness
 * artifact (confirmed by toggling the pragma above), not a real schema
 * defect, and not something this phase's migration introduces or should fix.
 * Used ONLY by the SET NULL test below, which needs to delete a `tokens`
 * row with FK enforcement on; every other test in this file uses the shared
 * `freshDb()` unmodified.
 */
function freshDbWithModernRename(): Database {
  const modernDb = new Database(":memory:");
  modernDb.exec("PRAGMA legacy_alter_table = OFF;");
  for (const file of readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    modernDb.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf-8"));
  }
  return modernDb;
}

let db: Database;

function seedUser(
  email: string,
  opts: { status?: string; identityConflict?: boolean; deleted?: boolean } = {},
): number {
  db.run(
    `INSERT INTO users (username, email, status, signup_source, email_verified, identity_conflict, deleted_at)
     VALUES (?, ?, ?, 'web', 1, ?, ?)`,
    [
      email.split("@")[0],
      email,
      opts.status ?? "verified",
      opts.identityConflict ? 1 : 0,
      opts.deleted ? "2026-01-01 00:00:00" : null,
    ],
  );
  const row = db.query<{ id: number }, [string]>("SELECT id FROM users WHERE email = ?").get(email);
  if (!row) throw new Error("seed failed");
  return row.id;
}

function insertDeviceCode(hash: string, userCode: string, machineName = "test machine"): void {
  db.query(DEVICE_INSERT_SQL).run(hash, userCode, machineName);
}

beforeEach(() => {
  db = freshDb();
});

describe("device_codes schema", () => {
  test("device_code_hash is a primary key: a duplicate insert throws", () => {
    insertDeviceCode("hash-one", "AAAABBBB");
    expect(() => insertDeviceCode("hash-one", "CCCCDDDD")).toThrow();
  });

  test("user_code is UNIQUE: a duplicate code throws even with a different hash", () => {
    insertDeviceCode("hash-two", "AAAABBBB");
    expect(() => insertDeviceCode("hash-three", "AAAABBBB")).toThrow();
  });

  test("status is closed by a CHECK constraint", () => {
    insertDeviceCode("hash-four", "AAAACCCC");
    expect(() =>
      db
        .query("UPDATE device_codes SET status = 'bogus' WHERE device_code_hash = ?")
        .run("hash-four"),
    ).toThrow();
  });

  test("a confirmed row without user_id is rejected", () => {
    expect(() =>
      db
        .query(
          `INSERT INTO device_codes (device_code_hash, user_code, machine_name, status, expires_at)
           VALUES ('hash-five', 'AAAADDDD', 'm', 'confirmed', datetime('now', '+600 seconds'))`,
        )
        .run(),
    ).toThrow();
  });

  test("a consumed row without user_id is rejected", () => {
    expect(() =>
      db
        .query(
          `INSERT INTO device_codes (device_code_hash, user_code, machine_name, status, expires_at)
           VALUES ('hash-six', 'AAAAEEEE', 'm', 'consumed', datetime('now', '+600 seconds'))`,
        )
        .run(),
    ).toThrow();
  });

  test("pending and denied rows are fine without user_id", () => {
    insertDeviceCode("hash-seven", "AAAAFFFF");
    expect(() =>
      db
        .query("UPDATE device_codes SET status = 'denied' WHERE device_code_hash = ?")
        .run("hash-seven"),
    ).not.toThrow();
  });

  test("expires_at is SQL-datetime shaped and expires_in lands in [595, 600]", () => {
    insertDeviceCode("hash-eight", "AAAAGGGG");
    const row = db.query(DEVICE_ROW_BY_HASH_SQL).get("hash-eight") as {
      expires_at: string;
      expires_in: number;
    };
    expect(row.expires_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(row.expires_in).toBeGreaterThanOrEqual(595);
    expect(row.expires_in).toBeLessThanOrEqual(600);
  });

  test("expires_in is negative for a past-expiry row read before it is stamped", () => {
    db.query(
      `INSERT INTO device_codes (device_code_hash, user_code, machine_name, expires_at)
       VALUES ('hash-negative', 'AAAAHHHH', 'm', datetime('now', '-30 seconds'))`,
    ).run();
    const row = db.query(DEVICE_ROW_BY_HASH_SQL).get("hash-negative") as {
      status: string;
      expires_in: number;
    };
    // Still 'pending' -- nothing has stamped it yet -- but the computed
    // column already reports the row is past expiry.
    expect(row.status).toBe("pending");
    expect(row.expires_in).toBeLessThan(0);
  });
});

describe("DEVICE_CONFIRM_SQL", () => {
  test("changes 1 then 0, and extends expires_at by at least 120s near expiry", () => {
    const ada = seedUser("ada@nemar.test");
    db.query(
      `INSERT INTO device_codes (device_code_hash, user_code, machine_name, expires_at)
       VALUES ('hash-confirm', 'BBBBAAAA', 'm', datetime('now', '+30 seconds'))`,
    ).run();
    const before = db.query(DEVICE_ROW_BY_HASH_SQL).get("hash-confirm") as { expires_in: number };
    expect(before.expires_in).toBeLessThan(60);

    const first = db.query(DEVICE_CONFIRM_SQL).run(ada, "BBBBAAAA");
    expect(first.changes).toBe(1);

    const after = db.query(DEVICE_ROW_BY_HASH_SQL).get("hash-confirm") as {
      status: string;
      user_id: number;
      expires_in: number;
    };
    expect(after.status).toBe("confirmed");
    expect(after.user_id).toBe(ada);
    expect(after.expires_in).toBeGreaterThanOrEqual(115);

    const second = db.query(DEVICE_CONFIRM_SQL).run(ada, "BBBBAAAA");
    expect(second.changes).toBe(0);
  });
});

describe("DEVICE_POLL_SQL", () => {
  test("changes 1, then 0 (floor), then 1 after backdating last_polled_at 6s", () => {
    insertDeviceCode("hash-poll", "CCCCAAAA");

    const first = db.query(DEVICE_POLL_SQL).run("hash-poll");
    expect(first.changes).toBe(1);

    const second = db.query(DEVICE_POLL_SQL).run("hash-poll");
    expect(second.changes).toBe(0);

    db.query(
      "UPDATE device_codes SET last_polled_at = datetime('now', '-6 seconds') WHERE device_code_hash = ?",
    ).run("hash-poll");
    const third = db.query(DEVICE_POLL_SQL).run("hash-poll");
    expect(third.changes).toBe(1);

    const row = db.query(DEVICE_ROW_BY_HASH_SQL).get("hash-poll") as { poll_count: number };
    expect(row.poll_count).toBe(2);
  });
});

describe("DEVICE_STAMP_EXPIRED_SQL", () => {
  test("changes 1 the first time a past-expiry row is observed, then 0", () => {
    db.query(
      `INSERT INTO device_codes (device_code_hash, user_code, machine_name, expires_at)
       VALUES ('hash-expired', 'DDDDAAAA', 'm', datetime('now', '-1 seconds'))`,
    ).run();
    const first = db.query(DEVICE_STAMP_EXPIRED_SQL).run("hash-expired");
    expect(first.changes).toBe(1);
    const second = db.query(DEVICE_STAMP_EXPIRED_SQL).run("hash-expired");
    expect(second.changes).toBe(0);
    const row = db.query(DEVICE_ROW_BY_HASH_SQL).get("hash-expired") as { status: string };
    expect(row.status).toBe("expired");
  });
});

describe("DEVICE_PRUNE_SQL", () => {
  test("removes only the row more than 24h past expiry", () => {
    db.query(
      `INSERT INTO device_codes (device_code_hash, user_code, machine_name, expires_at)
       VALUES ('hash-old', 'EEEEAAAA', 'm', datetime('now', '-25 hours'))`,
    ).run();
    db.query(
      `INSERT INTO device_codes (device_code_hash, user_code, machine_name, expires_at)
       VALUES ('hash-recent', 'EEEEBBBB', 'm', datetime('now', '-1 hours'))`,
    ).run();
    db.query(DEVICE_PRUNE_SQL).run();
    expect(db.query(DEVICE_ROW_BY_HASH_SQL).get("hash-old")).toBeNull();
    expect(db.query(DEVICE_ROW_BY_HASH_SQL).get("hash-recent")).not.toBeNull();
  });

  test("the 24h boundary itself: +5s past is pruned, -5s past is kept", () => {
    db.query(
      `INSERT INTO device_codes (device_code_hash, user_code, machine_name, expires_at)
       VALUES ('hash-boundary-over', 'EEEECCCC', 'm', datetime('now', '-24 hours', '-5 seconds'))`,
    ).run();
    db.query(
      `INSERT INTO device_codes (device_code_hash, user_code, machine_name, expires_at)
       VALUES ('hash-boundary-under', 'EEEEDDDD', 'm', datetime('now', '-24 hours', '+5 seconds'))`,
    ).run();
    db.query(DEVICE_PRUNE_SQL).run();
    expect(db.query(DEVICE_ROW_BY_HASH_SQL).get("hash-boundary-over")).toBeNull();
    expect(db.query(DEVICE_ROW_BY_HASH_SQL).get("hash-boundary-under")).not.toBeNull();
  });
});

describe("DEVICE_DENY_SQL", () => {
  test("denies a pending row and records no user_id", () => {
    insertDeviceCode("hash-deny", "FFFFAAAA");
    const result = db.query(DEVICE_DENY_SQL).run("FFFFAAAA");
    expect(result.changes).toBe(1);
    const row = db.query(DEVICE_ROW_BY_USER_CODE_SQL).get("FFFFAAAA") as {
      status: string;
      user_id: number | null;
    };
    expect(row.status).toBe("denied");
    expect(row.user_id).toBeNull();
  });
});

describe("mint pair: DEVICE_MINT_INSERT_SQL + DEVICE_MINT_CONSUME_SQL", () => {
  function confirmedCode(hash: string, userCode: string, userId: number, machine = "adas-laptop") {
    db.query(
      `INSERT INTO device_codes (device_code_hash, user_code, machine_name, status, user_id, confirmed_at, expires_at)
       VALUES (?, ?, ?, 'confirmed', ?, datetime('now'), datetime('now', '+600 seconds'))`,
    ).run(hash, userCode, machine, userId);
  }

  test("mints a named token and consumes the device row for a confirmed row on a verified user", () => {
    const ada = seedUser("ada-mint@nemar.test");
    confirmedCode("hash-mint", "GGGGAAAA", ada, "adas-laptop");

    db.exec("BEGIN");
    const insertResult = db
      .query(DEVICE_MINT_INSERT_SQL)
      .run("apikeyhash-1", "nm_apikeyh...", "hash-mint");
    const consumeResult = db
      .query(DEVICE_MINT_CONSUME_SQL)
      .run("apikeyhash-1", "hash-mint", "apikeyhash-1");
    db.exec("COMMIT");

    expect(insertResult.changes).toBe(1);
    expect(consumeResult.changes).toBe(1);

    const token = db
      .query<{ id: number; name: string; user_id: number }, [string]>(
        "SELECT id, name, user_id FROM tokens WHERE api_key_hash = ?",
      )
      .get("apikeyhash-1");
    expect(token?.name).toBe("adas-laptop");
    expect(token?.user_id).toBe(ada);

    const deviceRow = db.query(DEVICE_ROW_BY_HASH_SQL).get("hash-mint") as {
      status: string;
      token_id: number | null;
    };
    expect(deviceRow.status).toBe("consumed");
    expect(deviceRow.token_id).toBe(token?.id ?? null);
  });

  test("a second run against the same (now consumed) row mints nothing", () => {
    const ada = seedUser("ada-mint2@nemar.test");
    confirmedCode("hash-mint2", "GGGGBBBB", ada);
    db.query(DEVICE_MINT_INSERT_SQL).run("apikeyhash-2", "nm_x...", "hash-mint2");
    db.query(DEVICE_MINT_CONSUME_SQL).run("apikeyhash-2", "hash-mint2", "apikeyhash-2");

    const insertAgain = db
      .query(DEVICE_MINT_INSERT_SQL)
      .run("apikeyhash-2b", "nm_y...", "hash-mint2");
    const consumeAgain = db
      .query(DEVICE_MINT_CONSUME_SQL)
      .run("apikeyhash-2b", "hash-mint2", "apikeyhash-2b");
    expect(insertAgain.changes).toBe(0);
    expect(consumeAgain.changes).toBe(0);
  });

  test("mints nothing for a pending (unconfirmed) row", () => {
    const ada = seedUser("ada-pending@nemar.test");
    insertDeviceCode("hash-pending", "GGGGCCCC");
    void ada;
    const insertResult = db
      .query(DEVICE_MINT_INSERT_SQL)
      .run("apikeyhash-3", "nm_x...", "hash-pending");
    const consumeResult = db
      .query(DEVICE_MINT_CONSUME_SQL)
      .run("apikeyhash-3", "hash-pending", "apikeyhash-3");
    expect(insertResult.changes).toBe(0);
    expect(consumeResult.changes).toBe(0);
  });

  test("mints nothing for a revoked account", () => {
    const bob = seedUser("bob-revoked@nemar.test", { status: "revoked" });
    confirmedCode("hash-revoked", "GGGGDDDD", bob);
    const insertResult = db
      .query(DEVICE_MINT_INSERT_SQL)
      .run("apikeyhash-4", "nm_x...", "hash-revoked");
    const consumeResult = db
      .query(DEVICE_MINT_CONSUME_SQL)
      .run("apikeyhash-4", "hash-revoked", "apikeyhash-4");
    expect(insertResult.changes).toBe(0);
    expect(consumeResult.changes).toBe(0);
  });

  test("mints nothing for a soft-deleted user", () => {
    const dave = seedUser("dave-deleted@nemar.test", { deleted: true });
    confirmedCode("hash-deleted", "GGGGZZZZ", dave);
    const insertResult = db
      .query(DEVICE_MINT_INSERT_SQL)
      .run("apikeyhash-7", "nm_x...", "hash-deleted");
    const consumeResult = db
      .query(DEVICE_MINT_CONSUME_SQL)
      .run("apikeyhash-7", "hash-deleted", "apikeyhash-7");
    expect(insertResult.changes).toBe(0);
    expect(consumeResult.changes).toBe(0);
  });

  test("mints nothing for an identity_conflict account", () => {
    const carol = seedUser("carol-conflict@nemar.test", { identityConflict: true });
    confirmedCode("hash-conflict", "GGGGEEEE", carol);
    const insertResult = db
      .query(DEVICE_MINT_INSERT_SQL)
      .run("apikeyhash-5", "nm_x...", "hash-conflict");
    const consumeResult = db
      .query(DEVICE_MINT_CONSUME_SQL)
      .run("apikeyhash-5", "hash-conflict", "apikeyhash-5");
    expect(insertResult.changes).toBe(0);
    expect(consumeResult.changes).toBe(0);
  });

  test("mints nothing once the account already holds 25 live keys", () => {
    const dave = seedUser("dave-full@nemar.test");
    confirmedCode("hash-full", "GGGGFFFF", dave);
    for (let i = 0; i < 25; i++) {
      db.run(
        "INSERT INTO tokens (user_id, api_key_hash, api_key_prefix, name) VALUES (?, ?, ?, ?)",
        [dave, `existing-hash-${i}`, "nm_xxx...", `key-${i}`],
      );
    }
    const insertResult = db
      .query(DEVICE_MINT_INSERT_SQL)
      .run("apikeyhash-6", "nm_x...", "hash-full");
    const consumeResult = db
      .query(DEVICE_MINT_CONSUME_SQL)
      .run("apikeyhash-6", "hash-full", "apikeyhash-6");
    expect(insertResult.changes).toBe(0);
    expect(consumeResult.changes).toBe(0);
  });
});

describe("KEY_MINT_SQL", () => {
  test("mints for an active, unflagged, under-cap account", () => {
    const ada = seedUser("ada-key-mint@nemar.test");
    const result = db.query(KEY_MINT_SQL).run(ada, "keyhash-1", "nm_key1...", "adas-key", ada);
    expect(result.changes).toBe(1);
    const row = db
      .query<{ user_id: number; name: string | null }, [string]>(
        "SELECT user_id, name FROM tokens WHERE api_key_hash = ?",
      )
      .get("keyhash-1");
    expect(row?.user_id).toBe(ada);
    expect(row?.name).toBe("adas-key");
  });

  test("mints nothing for an identity_conflict account", () => {
    const carol = seedUser("carol-key-mint@nemar.test", { identityConflict: true });
    const result = db
      .query(KEY_MINT_SQL)
      .run(carol, "keyhash-2", "nm_key2...", "carols-key", carol);
    expect(result.changes).toBe(0);
  });

  test("mints nothing for a revoked account", () => {
    const bob = seedUser("bob-key-mint@nemar.test", { status: "revoked" });
    const result = db.query(KEY_MINT_SQL).run(bob, "keyhash-3", "nm_key3...", "bobs-key", bob);
    expect(result.changes).toBe(0);
  });

  test("mints nothing once the account already holds 25 live keys", () => {
    const dave = seedUser("dave-key-mint@nemar.test");
    for (let i = 0; i < 25; i++) {
      db.run(
        "INSERT INTO tokens (user_id, api_key_hash, api_key_prefix, name) VALUES (?, ?, ?, ?)",
        [dave, `existing-key-mint-hash-${i}`, "nm_xxx...", `key-${i}`],
      );
    }
    const result = db
      .query(KEY_MINT_SQL)
      .run(dave, "keyhash-4", "nm_key4...", "one-too-many", dave);
    expect(result.changes).toBe(0);
  });
});

describe("foreign keys (PRAGMA foreign_keys = ON, matching D1)", () => {
  test("a deleted user cascades the device_codes row away", () => {
    const ada = seedUser("ada-cascade@nemar.test");
    db.run("PRAGMA foreign_keys = ON");
    db.query(
      `INSERT INTO device_codes (device_code_hash, user_code, machine_name, status, user_id, confirmed_at, expires_at)
       VALUES ('hash-cascade', 'HHHHAAAA', 'm', 'confirmed', ?, datetime('now'), datetime('now', '+600 seconds'))`,
    ).run(ada);
    db.run("DELETE FROM users WHERE id = ?", [ada]);
    expect(db.query(DEVICE_ROW_BY_HASH_SQL).get("hash-cascade")).toBeNull();
  });

  test("a deleted token SET NULLs the device_codes.token_id it minted", () => {
    // Uses freshDbWithModernRename(), not the module-level `db` -- see its
    // doc comment for why a plain `freshDb()` cannot exercise this FK.
    const modernDb = freshDbWithModernRename();
    modernDb.run(
      `INSERT INTO users (username, email, status, signup_source, email_verified) VALUES (?, ?, 'verified', 'web', 1)`,
      ["ada-setnull", "ada-setnull@nemar.test"],
    );
    const ada = modernDb
      .query<{ id: number }, []>("SELECT id FROM users WHERE email = 'ada-setnull@nemar.test'")
      .get()?.id;
    if (!ada) throw new Error("seed failed");
    modernDb.run(
      "INSERT INTO tokens (user_id, api_key_hash, api_key_prefix, name) VALUES (?, ?, ?, ?)",
      [ada, "setnull-hash", "nm_xxx...", "adas-laptop"],
    );
    const tokenRow = modernDb
      .query<{ id: number }, [string]>("SELECT id FROM tokens WHERE api_key_hash = ?")
      .get("setnull-hash");
    if (!tokenRow) throw new Error("seed failed");
    modernDb
      .query(
        `INSERT INTO device_codes (device_code_hash, user_code, machine_name, status, user_id, token_id, confirmed_at, consumed_at, expires_at)
       VALUES ('hash-token-null', 'IIIIAAAA', 'm', 'consumed', ?, ?, datetime('now'), datetime('now'), datetime('now', '+600 seconds'))`,
      )
      .run(ada, tokenRow.id);

    modernDb.run("PRAGMA foreign_keys = ON");
    modernDb.run("DELETE FROM tokens WHERE id = ?", [tokenRow.id]);
    const row = modernDb.query(DEVICE_ROW_BY_HASH_SQL).get("hash-token-null") as {
      token_id: number | null;
    };
    expect(row.token_id).toBeNull();
    modernDb.close();
  });
});

describe("replaying the migration (CREATE ... IF NOT EXISTS)", () => {
  test("re-running the raw migration text against an existing table leaves an existing row byte-identical", () => {
    insertDeviceCode("hash-replay", "JJJJAAAA", "replay-machine");
    const before = db
      .query("SELECT * FROM device_codes WHERE device_code_hash = ?")
      .get("hash-replay");

    // The real migration text, never retyped (.rules/testing.md) -- `db`
    // (freshDb()) already applied this file once when the suite's
    // beforeEach ran every migration in order, so this is a genuine SECOND
    // application against a database whose device_codes table already
    // holds the row seeded above.
    const migrationSql = readFileSync(join(MIGRATIONS_DIR, "0081_device_codes.sql"), "utf-8");
    expect(() => db.exec(migrationSql)).not.toThrow();

    const after = db
      .query("SELECT * FROM device_codes WHERE device_code_hash = ?")
      .get("hash-replay");
    expect(after).toEqual(before);
  });
});
