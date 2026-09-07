/**
 * Migration 0078: `orcid_link_intents` (ADR 0044, PR #1269 review item A3).
 *
 * The route tests drive the behaviour end to end -- an intent is minted,
 * walked through the interstitial, consumed by the callback, and refused on
 * replay. What they cannot show is that the SCHEMA is what makes that
 * enforceable rather than the application being careful: two writers racing
 * the same nonce, and rows outliving the account they belong to.
 *
 * Real bun:sqlite with every migration applied. No mocks.
 */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { freshDb } from "./helpers/d1";

let db: Database;

function seedUser(email: string): number {
  db.run(
    `INSERT INTO users (username, email, password_hash, status, role, signup_source, email_verified)
     VALUES (?, ?, 'x', 'verified', 'member', 'cli', 1)`,
    [email.split("@")[0], email],
  );
  const row = db.query<{ id: number }, [string]>("SELECT id FROM users WHERE email = ?").get(email);
  if (!row) throw new Error("seed failed");
  return row.id;
}

function insertIntent(nonce: string, userId: number): void {
  db.run(
    `INSERT INTO orcid_link_intents (nonce, user_id, mode, expires_at)
     VALUES (?, ?, 'link', datetime('now', '+10 minutes'))`,
    [nonce, userId],
  );
}

beforeEach(() => {
  db = freshDb();
});

describe("orcid_link_intents", () => {
  test("the nonce is a primary key, so an intent cannot be duplicated", () => {
    // Consume-once is a conditional UPDATE on this key. If two rows could
    // carry the same nonce, the second would still be unconsumed after the
    // first was spent -- and the replay the callback refuses would work.
    const ada = seedUser("ada@nemar.test");
    insertIntent("nonce-one", ada);
    expect(() => insertIntent("nonce-one", ada)).toThrow();
    expect(
      db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM orcid_link_intents").get()?.n,
    ).toBe(1);
  });

  test("a consumed intent stays consumed for a second UPDATE", () => {
    // The exact statement the callback runs: `changes` is what decides the
    // race, so the second attempt must report zero rather than re-stamping.
    const ada = seedUser("ada@nemar.test");
    insertIntent("nonce-two", ada);
    const sql = `UPDATE orcid_link_intents SET consumed_at = datetime('now')
                  WHERE nonce = ? AND user_id = ? AND consumed_at IS NULL
                    AND expires_at > datetime('now')`;
    expect(db.run(sql, ["nonce-two", ada]).changes).toBe(1);
    expect(db.run(sql, ["nonce-two", ada]).changes).toBe(0);
  });

  test("an expired intent is not consumable and prunes away", () => {
    const ada = seedUser("ada@nemar.test");
    db.run(
      `INSERT INTO orcid_link_intents (nonce, user_id, mode, expires_at)
       VALUES ('stale', ?, 'link', datetime('now', '-1 minute'))`,
      [ada],
    );
    const consumed = db.run(
      `UPDATE orcid_link_intents SET consumed_at = datetime('now')
        WHERE nonce = 'stale' AND consumed_at IS NULL AND expires_at > datetime('now')`,
    );
    expect(consumed.changes).toBe(0);
    // The prune `cli-start` runs on every mint, which is why this table needs
    // no cron.
    db.run("DELETE FROM orcid_link_intents WHERE expires_at < datetime('now')");
    expect(
      db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM orcid_link_intents").get()?.n,
    ).toBe(0);
  });

  test("intents go with the account they belong to", () => {
    // ON DELETE CASCADE, so a deleted account leaves no live intent naming an
    // id that no longer resolves. Foreign keys are off by default in SQLite,
    // so this asserts the DECLARATION does its job when they are on -- which
    // is how D1 runs.
    const ada = seedUser("ada@nemar.test");
    db.run("PRAGMA foreign_keys = ON");
    insertIntent("nonce-three", ada);
    db.run("DELETE FROM users WHERE id = ?", [ada]);
    expect(
      db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM orcid_link_intents").get()?.n,
    ).toBe(0);
  });
});
