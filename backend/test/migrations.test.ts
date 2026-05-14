/**
 * Integration test for D1 migration 0021_broadcast_user_recipient.sql.
 *
 * Runs against a real in-memory SQLite database via bun:sqlite (no mocks).
 * Applies migrations 0001-0020 to build a valid schema, inserts
 * representative broadcast_emails rows, then applies 0021 and asserts
 * all invariants from issue #479.
 *
 * Invariants verified:
 *  1. All original rows are preserved verbatim after the table rebuild.
 *  2. New CHECK accepts `user:<username>` values.
 *  3. New CHECK rejects unknown recipient_group values.
 *  4. AUTOINCREMENT sequence continues above the max pre-migration id.
 *  5. Both indexes exist after the RENAME.
 *
 * Note: bun:sqlite's exec() silently swallows CHECK constraint violations when
 * the SQL string has leading whitespace/newlines (multi-statement path quirk).
 * INSERT statements in this file use prepare().run() or single-line strings so
 * that constraint errors are always surfaced.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MIGRATIONS_DIR = join(import.meta.dir, "../src/db/migrations");

/** Return migration files sorted lexicographically. */
function getMigrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

/**
 * Execute a multi-statement SQL script against db.
 * bun:sqlite exec() handles semicolon-separated statements.
 */
function execScript(db: Database, sql: string): void {
  db.exec(sql);
}

/**
 * Run a single INSERT statement via prepare().run() so that CHECK constraint
 * violations are always propagated as thrown errors.
 *
 * bun:sqlite's exec() silently swallows SQLite errors when the SQL string
 * begins with whitespace (the multi-statement execution path). Using
 * prepare().run() bypasses that path and surfaces errors reliably.
 */
function execInsert(db: Database, sql: string): void {
  db.prepare(sql.trim()).run();
}

// ---------------------------------------------------------------------------
// Fixture data — representative broadcast_emails rows
// ---------------------------------------------------------------------------

type BroadcastRow = {
  id: number;
  sent_by: number;
  recipient_group: string;
  subject: string;
  body_markdown: string;
  recipient_count: number;
  failure_count: number;
  failed_recipients: string;
  sent_at: string;
};

const FIXTURE_ROWS: Omit<BroadcastRow, "id">[] = [
  // recipient_group = 'all', no failures
  {
    sent_by: 1,
    recipient_group: "all",
    subject: "Platform announcement",
    body_markdown: "## Welcome\n\nWelcome to NEMAR.",
    recipient_count: 42,
    failure_count: 0,
    failed_recipients: "[]",
    sent_at: "2025-01-01 10:00:00",
  },
  // recipient_group = 'all', with failures
  {
    sent_by: 1,
    recipient_group: "all",
    subject: "Maintenance window",
    body_markdown: "Scheduled downtime tonight.",
    recipient_count: 40,
    failure_count: 2,
    failed_recipients: '["a@x.com","b@x.com"]',
    sent_at: "2025-01-02 09:00:00",
  },
  // recipient_group = 'admins'
  {
    sent_by: 1,
    recipient_group: "admins",
    subject: "Admin alert",
    body_markdown: "Please review pending approvals.",
    recipient_count: 3,
    failure_count: 0,
    failed_recipients: "[]",
    sent_at: "2025-02-14 08:30:00",
  },
  // recipient_group = 'admins', with failure
  {
    sent_by: 1,
    recipient_group: "admins",
    subject: "Security notice",
    body_markdown: "Rotate your credentials.",
    recipient_count: 3,
    failure_count: 1,
    failed_recipients: '["admin@nemar.org"]',
    sent_at: "2025-03-01 12:00:00",
  },
  // recipient_group = 'members'
  {
    sent_by: 1,
    recipient_group: "members",
    subject: "New feature available",
    body_markdown: "Dataset download speeds improved.",
    recipient_count: 39,
    failure_count: 0,
    failed_recipients: "[]",
    sent_at: "2025-04-10 14:00:00",
  },
  // recipient_group = 'members', failure_count > 0
  {
    sent_by: 1,
    recipient_group: "members",
    subject: "Survey invitation",
    body_markdown: "Help us improve NEMAR.",
    recipient_count: 35,
    failure_count: 4,
    failed_recipients: '["u1@x.com","u2@x.com","u3@x.com","u4@x.com"]',
    sent_at: "2025-05-05 11:00:00",
  },
  // recipient_count = 0 (edge case)
  {
    sent_by: 1,
    recipient_group: "members",
    subject: "Empty send test",
    body_markdown: "No recipients.",
    recipient_count: 0,
    failure_count: 0,
    failed_recipients: "[]",
    sent_at: "2025-06-01 00:00:00",
  },
  // Large recipient_count
  {
    sent_by: 1,
    recipient_group: "all",
    subject: "Year in review",
    body_markdown: "Thank you for a great year.",
    recipient_count: 1000,
    failure_count: 0,
    failed_recipients: "[]",
    sent_at: "2025-12-31 23:59:00",
  },
  // failure_count equals recipient_count (total failure)
  {
    sent_by: 1,
    recipient_group: "admins",
    subject: "Critical alert",
    body_markdown: "SMTP relay down.",
    recipient_count: 3,
    failure_count: 3,
    failed_recipients: '["a@nemar.org","b@nemar.org","c@nemar.org"]',
    sent_at: "2025-07-04 06:00:00",
  },
  // Another 'all' row
  {
    sent_by: 1,
    recipient_group: "all",
    subject: "Policy update",
    body_markdown: "Terms of service updated.",
    recipient_count: 50,
    failure_count: 5,
    failed_recipients: '["x1@x.com","x2@x.com","x3@x.com","x4@x.com","x5@x.com"]',
    sent_at: "2025-08-15 10:30:00",
  },
];

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("migration 0021 — broadcast_emails user recipient", () => {
  let db: Database;

  beforeAll(() => {
    db = new Database(":memory:");

    // Apply migrations 0001 through 0020 in order.
    const files = getMigrationFiles();
    const pre0021 = files.filter((f) => {
      const num = Number.parseInt(f.split("_")[0], 10);
      return num >= 1 && num <= 20;
    });

    for (const file of pre0021) {
      const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf-8");
      execScript(db, sql);
    }

    // Seed a user so the broadcast_emails FK (sent_by -> users.id) is satisfied.
    execInsert(
      db,
      `INSERT INTO users (id, username, email, password_hash, github_username, status)
       VALUES (1, 'yahya', 'yahya@nemar.org', 'hash', 'yahya', 'approved')`,
    );

    // Insert the fixture rows (broadcast_emails created by migration 0017).
    const insert = db.prepare(
      `INSERT INTO broadcast_emails
        (sent_by, recipient_group, subject, body_markdown, recipient_count, failure_count, failed_recipients, sent_at)
       VALUES
        ($sent_by, $recipient_group, $subject, $body_markdown, $recipient_count, $failure_count, $failed_recipients, $sent_at)`,
    );
    for (const row of FIXTURE_ROWS) {
      insert.run({
        $sent_by: row.sent_by,
        $recipient_group: row.recipient_group,
        $subject: row.subject,
        $body_markdown: row.body_markdown,
        $recipient_count: row.recipient_count,
        $failure_count: row.failure_count,
        $failed_recipients: row.failed_recipients,
        $sent_at: row.sent_at,
      });
    }
    insert.finalize();

    // Apply the migration under test.
    const migration0021 = readFileSync(
      join(MIGRATIONS_DIR, "0021_broadcast_user_recipient.sql"),
      "utf-8",
    );
    execScript(db, migration0021);
  });

  afterAll(() => {
    db.close();
  });

  // -------------------------------------------------------------------------
  // Invariant 1: all original rows preserved verbatim
  // -------------------------------------------------------------------------

  test("all 10 fixture rows are preserved after table rebuild", () => {
    const rows = db
      .prepare("SELECT * FROM broadcast_emails ORDER BY id")
      .all() as BroadcastRow[];
    expect(rows).toHaveLength(FIXTURE_ROWS.length);
  });

  test("row fields match fixture data verbatim", () => {
    const rows = db
      .prepare("SELECT * FROM broadcast_emails ORDER BY id")
      .all() as BroadcastRow[];

    for (let i = 0; i < FIXTURE_ROWS.length; i++) {
      const expected = FIXTURE_ROWS[i];
      const actual = rows[i];
      expect(actual.sent_by).toBe(expected.sent_by);
      expect(actual.recipient_group).toBe(expected.recipient_group);
      expect(actual.subject).toBe(expected.subject);
      expect(actual.body_markdown).toBe(expected.body_markdown);
      expect(actual.recipient_count).toBe(expected.recipient_count);
      expect(actual.failure_count).toBe(expected.failure_count);
      expect(actual.failed_recipients).toBe(expected.failed_recipients);
      expect(actual.sent_at).toBe(expected.sent_at);
    }
  });

  test("row ids are sequential starting from 1", () => {
    const rows = db
      .prepare("SELECT id FROM broadcast_emails ORDER BY id")
      .all() as { id: number }[];
    for (let i = 0; i < rows.length; i++) {
      expect(rows[i].id).toBe(i + 1);
    }
  });

  // -------------------------------------------------------------------------
  // Invariant 2: new CHECK accepts 'user:<username>'
  // -------------------------------------------------------------------------

  test("CHECK accepts user:alex", () => {
    expect(() => {
      execInsert(
        db,
        `INSERT INTO broadcast_emails (sent_by, recipient_group, subject, body_markdown, recipient_count, failure_count, failed_recipients, sent_at) VALUES (1, 'user:alex', 'Direct to alex', 'Hi Alex.', 1, 0, '[]', '2026-01-01 00:00:00')`,
      );
    }).not.toThrow();
  });

  test("CHECK accepts user:cool-vibers (hyphenated username)", () => {
    expect(() => {
      execInsert(
        db,
        `INSERT INTO broadcast_emails (sent_by, recipient_group, subject, body_markdown, recipient_count, failure_count, failed_recipients, sent_at) VALUES (1, 'user:cool-vibers', 'Direct to cool-vibers', 'Hi.', 1, 0, '[]', '2026-01-02 00:00:00')`,
      );
    }).not.toThrow();
  });

  test("original enum values still accepted after migration", () => {
    for (const group of ["all", "admins", "members"]) {
      expect(() => {
        execInsert(
          db,
          `INSERT INTO broadcast_emails (sent_by, recipient_group, subject, body_markdown, recipient_count, failure_count, failed_recipients, sent_at) VALUES (1, '${group}', 'Test ${group}', 'Body.', 0, 0, '[]', '2026-02-01 00:00:00')`,
        );
      }).not.toThrow();
    }
  });

  // -------------------------------------------------------------------------
  // Invariant 3: new CHECK rejects unknown values
  // -------------------------------------------------------------------------

  test("CHECK rejects 'unknown'", () => {
    expect(() => {
      execInsert(
        db,
        `INSERT INTO broadcast_emails (sent_by, recipient_group, subject, body_markdown, recipient_count, failure_count, failed_recipients, sent_at) VALUES (1, 'unknown', 'Bad group', 'Body.', 0, 0, '[]', '2026-03-01 00:00:00')`,
      );
    }).toThrow();
  });

  test("CHECK rejects 'Users:alex' (capital U — not matching LIKE 'user:%')", () => {
    expect(() => {
      execInsert(
        db,
        `INSERT INTO broadcast_emails (sent_by, recipient_group, subject, body_markdown, recipient_count, failure_count, failed_recipients, sent_at) VALUES (1, 'Users:alex', 'Bad group', 'Body.', 0, 0, '[]', '2026-03-02 00:00:00')`,
      );
    }).toThrow();
  });

  test("CHECK rejects empty string", () => {
    expect(() => {
      execInsert(
        db,
        `INSERT INTO broadcast_emails (sent_by, recipient_group, subject, body_markdown, recipient_count, failure_count, failed_recipients, sent_at) VALUES (1, '', 'Bad group', 'Body.', 0, 0, '[]', '2026-03-03 00:00:00')`,
      );
    }).toThrow();
  });

  test("CHECK rejects 'user' without colon suffix", () => {
    expect(() => {
      execInsert(
        db,
        `INSERT INTO broadcast_emails (sent_by, recipient_group, subject, body_markdown, recipient_count, failure_count, failed_recipients, sent_at) VALUES (1, 'user', 'Bad group', 'Body.', 0, 0, '[]', '2026-03-04 00:00:00')`,
      );
    }).toThrow();
  });

  // -------------------------------------------------------------------------
  // Invariant 4: AUTOINCREMENT sequence continues above max pre-migration id
  // -------------------------------------------------------------------------

  test("new row id is strictly greater than max pre-migration id", () => {
    const maxPreMigration = db
      .prepare("SELECT MAX(id) AS m FROM broadcast_emails WHERE sent_at < '2026-01-01'")
      .get() as { m: number };

    execInsert(
      db,
      `INSERT INTO broadcast_emails (sent_by, recipient_group, subject, body_markdown, recipient_count, failure_count, failed_recipients, sent_at) VALUES (1, 'all', 'Autoincrement check', 'Body.', 1, 0, '[]', '2026-05-01 00:00:00')`,
    );

    const newRow = db
      .prepare(
        "SELECT id FROM broadcast_emails WHERE subject = 'Autoincrement check' ORDER BY id DESC LIMIT 1",
      )
      .get() as { id: number };

    expect(newRow.id).toBeGreaterThan(maxPreMigration.m);
  });

  // -------------------------------------------------------------------------
  // Invariant 5: both indexes exist after the RENAME
  // -------------------------------------------------------------------------

  test("idx_broadcast_sent_at exists on broadcast_emails", () => {
    const idx = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_broadcast_sent_at' AND tbl_name='broadcast_emails'",
      )
      .get() as { name: string } | null;
    expect(idx).not.toBeNull();
    expect(idx?.name).toBe("idx_broadcast_sent_at");
  });

  test("idx_broadcast_sent_by exists on broadcast_emails", () => {
    const idx = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_broadcast_sent_by' AND tbl_name='broadcast_emails'",
      )
      .get() as { name: string } | null;
    expect(idx).not.toBeNull();
    expect(idx?.name).toBe("idx_broadcast_sent_by");
  });

  test("no stale broadcast_emails_new table remains after migration", () => {
    const tbl = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='broadcast_emails_new'",
      )
      .get();
    expect(tbl).toBeNull();
  });
});
