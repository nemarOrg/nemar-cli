/**
 * Behavioral test for the ORCID relink statement set (#913),
 * backend/src/services/orcid-auth.ts RELINK_*_SQL + relinkParams.
 *
 * Runs the production SQL + param marshaling against bun:sqlite (real SQLite
 * driver, no mocks — the audit-log-statement.unit.test.ts pattern). Pins the
 * three properties the route relies on:
 *   1. the swap replaces the identity row, updates users.orcid, and sets
 *      orcid_verified=1 together;
 *   2. DELETE+INSERT is idempotent under a concurrent unlink (DELETE matches
 *      nothing, INSERT still lands);
 *   3. UNIQUE(provider, provider_subject) still refuses a new iD that another
 *      account claimed between the route's check and the write.
 */

import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { AUDIT_LOG_INSERT_SQL, auditLogParams } from "../backend/src/db/audit-log";
import {
  RELINK_DELETE_IDENTITY_SQL,
  RELINK_INSERT_IDENTITY_SQL,
  RELINK_UPDATE_USER_SQL,
  relinkParams,
} from "../backend/src/services/orcid-auth";

// Verbatim from backend/src/db/migrations/0050_orcid_sso.sql.
const OAUTH_IDENTITIES_DDL = `CREATE TABLE IF NOT EXISTS oauth_identities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('orcid')),
  provider_subject TEXT NOT NULL,
  provider_email TEXT,
  display_name TEXT,
  connected_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT,
  UNIQUE (provider, provider_subject)
)`;

// Only the columns the relink statements touch; the real users table (0001 +
// migrations) is a superset and the SQL names its columns explicitly.
const USERS_DDL = `CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  orcid TEXT,
  orcid_verified INTEGER NOT NULL DEFAULT 0
)`;

const AUDIT_LOG_DDL = `CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL DEFAULT (datetime('now')),
  user_id INTEGER,
  action TEXT NOT NULL,
  resource_type TEXT,
  resource_id TEXT,
  details TEXT
)`;

const OLD_ID = "0000-0002-1825-0097";
const NEW_ID = "0000-0001-5109-353X";

let db: Database;

function runRelink(userId: number, newOrcid: string, name: string | null): void {
  // The route runs these as one D1 batch (implicit transaction); mirror that.
  const params = relinkParams(userId, newOrcid, name);
  const tx = db.transaction(() => {
    db.run(RELINK_DELETE_IDENTITY_SQL, params.deleteIdentity);
    db.run(RELINK_INSERT_IDENTITY_SQL, params.insertIdentity);
    db.run(RELINK_UPDATE_USER_SQL, params.updateUser);
    db.run(
      AUDIT_LOG_INSERT_SQL,
      auditLogParams({
        userId,
        action: "orcid_relinked",
        resourceType: "user",
        resourceId: String(userId),
        details: JSON.stringify({ from: OLD_ID, to: newOrcid }),
      }),
    );
  });
  tx();
}

beforeEach(() => {
  db = new Database(":memory:");
  db.run(USERS_DDL);
  db.run(OAUTH_IDENTITIES_DDL);
  db.run(AUDIT_LOG_DDL);
  db.run("INSERT INTO users (id, orcid, orcid_verified) VALUES (1, ?, 1)", [OLD_ID]);
  db.run(
    "INSERT INTO oauth_identities (user_id, provider, provider_subject, display_name) VALUES (1, 'orcid', ?, 'Old Name')",
    [OLD_ID],
  );
});

describe("relink statement set (#913)", () => {
  test("swaps the identity, follows users.orcid, sets verified, audits", () => {
    runRelink(1, NEW_ID, "New Name");

    const idents = db
      .query(
        "SELECT provider_subject, display_name, last_login_at FROM oauth_identities WHERE user_id = 1",
      )
      .all() as { provider_subject: string; display_name: string; last_login_at: string | null }[];
    expect(idents).toHaveLength(1); // old row gone, exactly one new row
    expect(idents[0].provider_subject).toBe(NEW_ID);
    expect(idents[0].display_name).toBe("New Name");
    expect(idents[0].last_login_at).not.toBeNull(); // datetime('now') populated

    const user = db.query("SELECT orcid, orcid_verified FROM users WHERE id = 1").get() as {
      orcid: string;
      orcid_verified: number;
    };
    expect(user.orcid).toBe(NEW_ID);
    expect(user.orcid_verified).toBe(1);

    const audit = db.query("SELECT action, user_id, details FROM audit_log").get() as {
      action: string;
      user_id: number;
      details: string;
    };
    expect(audit.action).toBe("orcid_relinked");
    expect(audit.user_id).toBe(1);
    expect(JSON.parse(audit.details)).toEqual({ from: OLD_ID, to: NEW_ID });
  });

  test("idempotent under a concurrent unlink: DELETE matches nothing, INSERT lands", () => {
    // Simulate an unlink that won the race between the route's SELECT and
    // its batch: the identity row is already gone.
    db.run("DELETE FROM oauth_identities WHERE user_id = 1");

    runRelink(1, NEW_ID, null);

    const idents = db
      .query("SELECT provider_subject FROM oauth_identities WHERE user_id = 1")
      .all() as { provider_subject: string }[];
    expect(idents).toHaveLength(1);
    expect(idents[0].provider_subject).toBe(NEW_ID);
  });

  test("UNIQUE(provider, provider_subject) refuses an iD claimed by another account", () => {
    db.run("INSERT INTO users (id) VALUES (2)");
    db.run(
      "INSERT INTO oauth_identities (user_id, provider, provider_subject) VALUES (2, 'orcid', ?)",
      [NEW_ID],
    );

    expect(() => runRelink(1, NEW_ID, null)).toThrow();

    // The transaction rolled back: user 1 keeps the old link and citation iD.
    const ident = db
      .query("SELECT provider_subject FROM oauth_identities WHERE user_id = 1")
      .get() as { provider_subject: string };
    expect(ident.provider_subject).toBe(OLD_ID);
    const user = db.query("SELECT orcid FROM users WHERE id = 1").get() as { orcid: string };
    expect(user.orcid).toBe(OLD_ID);
  });
});
