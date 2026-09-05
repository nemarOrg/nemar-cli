/**
 * Integration test for migration 0062_service_access.sql (website ADR 0010, #1013).
 *
 * Runs against a real in-memory SQLite database via bun:sqlite (no mocks). To
 * exercise the grandfather backfill, it applies every migration EXCEPT 0062,
 * seeds users at the pre-0062 schema, then applies 0062 and asserts:
 *   1. the new columns exist with the right default;
 *   2. existing uploaders (approved + sandbox_completed) are grandfathered;
 *   3. admins/owners are grandfathered regardless of sandbox training;
 *   4. base users (approved, no sandbox) and pending users are NOT granted;
 *   5. soft-deleted rows are skipped.
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS_DIR = join(import.meta.dir, "../src/db/migrations");
const TARGET = "0062_service_access.sql";

function migrationsBefore(target: string): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql") && f < target)
    .sort();
}

/** Apply every migration up to (not including) 0062. */
function dbBeforeTarget(): Database {
  const db = new Database(":memory:");
  for (const file of migrationsBefore(TARGET)) {
    db.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf-8"));
  }
  return db;
}

function applyTarget(db: Database): void {
  db.exec(readFileSync(join(MIGRATIONS_DIR, TARGET), "utf-8"));
}

interface SeedRow {
  email: string;
  status: string;
  role: string;
  sandbox_completed: number;
  deleted?: boolean;
}

function seed(db: Database, rows: SeedRow[]): void {
  const stmt = db.prepare(
    `INSERT INTO users (email, status, role, sandbox_completed, deleted_at)
     VALUES (?, ?, ?, ?, ?)`,
  );
  for (const r of rows) {
    stmt.run(
      r.email,
      r.status,
      r.role,
      r.sandbox_completed,
      r.deleted ? "2026-01-01 00:00:00" : null,
    );
  }
}

function statusByEmail(db: Database, email: string): string {
  const row = db.prepare("SELECT status FROM users WHERE email = ?").get(email) as {
    status: string;
  } | null;
  if (!row) throw new Error(`no user ${email}`);
  return row.status;
}

function serviceAccessByEmail(db: Database, email: string): number {
  const row = db.prepare("SELECT service_access FROM users WHERE email = ?").get(email) as {
    service_access: number;
  } | null;
  if (!row) throw new Error(`no user ${email}`);
  return row.service_access;
}

describe("migration 0062_service_access", () => {
  test("adds the columns with the right default", () => {
    const db = dbBeforeTarget();
    applyTarget(db);
    const cols = (
      db.prepare("PRAGMA table_info(users)").all() as { name: string; dflt_value: string | null }[]
    )
      .filter((c) => c.name.startsWith("service_access"))
      .map((c) => c.name);
    expect(cols).toEqual(
      expect.arrayContaining([
        "service_access",
        "service_access_granted_at",
        "service_access_granted_by",
      ]),
    );
    // Fresh insert after the migration defaults to no service access.
    db.prepare("INSERT INTO users (email, status) VALUES ('fresh@x.test', 'approved')").run();
    expect(serviceAccessByEmail(db, "fresh@x.test")).toBe(0);
  });

  test("grandfathers existing uploaders and admins; withholds from base/pending/deleted", () => {
    const db = dbBeforeTarget();
    seed(db, [
      { email: "uploader@x.test", status: "approved", role: "member", sandbox_completed: 1 },
      { email: "owner@x.test", status: "approved", role: "owner", sandbox_completed: 0 },
      { email: "admin@x.test", status: "approved", role: "admin", sandbox_completed: 0 },
      { email: "base@x.test", status: "approved", role: "member", sandbox_completed: 0 },
      { email: "pending@x.test", status: "pending", role: "member", sandbox_completed: 1 },
      {
        email: "deleted-uploader@x.test",
        status: "approved",
        role: "member",
        sandbox_completed: 1,
        deleted: true,
      },
    ]);
    applyTarget(db);

    // Grandfathered: could already upload, or is an admin/owner.
    expect(serviceAccessByEmail(db, "uploader@x.test")).toBe(1);
    expect(serviceAccessByEmail(db, "owner@x.test")).toBe(1);
    expect(serviceAccessByEmail(db, "admin@x.test")).toBe(1);

    // Withheld: base access, not-yet-approved, and soft-deleted rows.
    expect(serviceAccessByEmail(db, "base@x.test")).toBe(0);
    expect(serviceAccessByEmail(db, "pending@x.test")).toBe(0);
    expect(serviceAccessByEmail(db, "deleted-uploader@x.test")).toBe(0);
  });

  test("unstick flips only pending verified-ORCID web signups to approved", () => {
    const db = dbBeforeTarget();
    // Insert with the columns the unstick UPDATE keys on. signup_source
    // defaults to 'cli' (migration 0026), so set 'web' explicitly where needed.
    const stmt = db.prepare(
      `INSERT INTO users (email, status, signup_source, orcid, orcid_verified, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    // Target: pending + web + verified ORCID -> should become approved.
    stmt.run("orcid-web@x.test", "pending", "web", "0000-0001-2345-6789", 1, null);
    // Untouched: CLI-origin pending (no ORCID).
    stmt.run("cli-pending@x.test", "pending", "cli", null, 0, null);
    // Untouched: web pending but ORCID not verified.
    stmt.run("web-unverified@x.test", "pending", "web", "0000-0001-2345-6780", 0, null);
    // Untouched: soft-deleted, even though it otherwise matches.
    stmt.run("orcid-web-deleted@x.test", "pending", "web", "0000-0001-2345-6781", 1, "2026-01-01");

    applyTarget(db);

    expect(statusByEmail(db, "orcid-web@x.test")).toBe("approved");
    expect(statusByEmail(db, "cli-pending@x.test")).toBe("pending");
    expect(statusByEmail(db, "web-unverified@x.test")).toBe("pending");
    expect(statusByEmail(db, "orcid-web-deleted@x.test")).toBe("pending");

    // Unstick grants base access only — never service (upload) access.
    expect(serviceAccessByEmail(db, "orcid-web@x.test")).toBe(0);
  });
});
