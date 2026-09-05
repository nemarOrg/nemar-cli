/**
 * Integration test for migration 0075_approval_grants_upload_access.sql
 * (ADR 0040, epic #1250 phase #1251, bug #1249).
 *
 * Real engine, no mocks: every migration EXCEPT 0075 is applied to an
 * in-memory bun:sqlite database, rows are seeded at the pre-0075 schema, then
 * 0075 is applied and its two rules are asserted against the real SQL.
 *
 * The invariant 0075 establishes -- status='approved' iff service_access=1 --
 * is asserted over the WHOLE seeded catalog rather than row by row, because a
 * rule that fixes the rows a test names while leaving a fourth shape behind is
 * exactly the failure mode this migration exists to clean up.
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS_DIR = join(import.meta.dir, "../src/db/migrations");
const TARGET = "0075_approval_grants_upload_access.sql";

/** Apply every migration up to (not including) the target. */
function dbBeforeTarget(): Database {
  const db = new Database(":memory:");
  for (const file of readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql") && f < TARGET)
    .sort()) {
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
  signupSource: "cli" | "web";
  serviceAccess?: 0 | 1;
  emailVerified?: 0 | 1;
  orcidVerified?: 0 | 1;
  grantedAt?: string | null;
  grantedBy?: number | null;
  approvedAt?: string | null;
  deleted?: boolean;
}

function seed(db: Database, rows: SeedRow[]): void {
  const stmt = db.prepare(
    `INSERT INTO users
       (email, status, signup_source, service_access, service_access_granted_at,
        service_access_granted_by, email_verified, orcid, orcid_verified,
        approved_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const r of rows) {
    stmt.run(
      r.email,
      r.status,
      r.signupSource,
      r.serviceAccess ?? 0,
      r.grantedAt ?? null,
      r.grantedBy ?? null,
      r.emailVerified ?? 0,
      r.orcidVerified ? "0000-0002-1825-0097" : null,
      r.orcidVerified ?? 0,
      r.approvedAt ?? null,
      r.deleted ? "2026-01-01 00:00:00" : null,
    );
  }
}

interface UserState {
  status: string;
  service_access: number;
  service_access_granted_at: string | null;
  service_access_granted_by: number | null;
  approved_at: string | null;
}

function state(db: Database, email: string): UserState {
  const row = db
    .prepare(
      `SELECT status, service_access, service_access_granted_at,
              service_access_granted_by, approved_at
         FROM users WHERE email = ?`,
    )
    .get(email) as UserState | null;
  if (!row) throw new Error(`no user ${email}`);
  return row;
}

/** Rows that break `status='approved' iff service_access=1`, live rows only. */
function invariantViolations(db: Database): { email: string; status: string; sa: number }[] {
  return db
    .prepare(
      `SELECT email, status, service_access AS sa FROM users
        WHERE deleted_at IS NULL
          AND ((status = 'approved') != (service_access = 1))`,
    )
    .all() as { email: string; status: string; sa: number }[];
}

describe("migration 0075_approval_grants_upload_access", () => {
  test("(a) grants upload access to already-approved CLI signups", () => {
    const db = dbBeforeTarget();
    seed(db, [
      { email: "cli-approved@x.test", status: "approved", signupSource: "cli", emailVerified: 1 },
    ]);
    applyTarget(db);

    const row = state(db, "cli-approved@x.test");
    expect(row.status).toBe("approved");
    expect(row.service_access).toBe(1);
    expect(row.service_access_granted_at).not.toBeNull();
    // NULL granted_by is how 0062 already spells "granted by the system".
    expect(row.service_access_granted_by).toBeNull();
  });

  test("(a) leaves non-approved and soft-deleted CLI rows alone", () => {
    const db = dbBeforeTarget();
    seed(db, [
      { email: "cli-verified@x.test", status: "verified", signupSource: "cli", emailVerified: 1 },
      { email: "cli-pending@x.test", status: "pending", signupSource: "cli" },
      { email: "cli-revoked@x.test", status: "revoked", signupSource: "cli", emailVerified: 1 },
      {
        email: "cli-deleted@x.test",
        status: "approved",
        signupSource: "cli",
        emailVerified: 1,
        deleted: true,
      },
    ]);
    applyTarget(db);

    expect(state(db, "cli-verified@x.test").service_access).toBe(0);
    expect(state(db, "cli-pending@x.test").service_access).toBe(0);
    expect(state(db, "cli-revoked@x.test").service_access).toBe(0);
    const deleted = state(db, "cli-deleted@x.test");
    expect(deleted.service_access).toBe(0);
    expect(deleted.status).toBe("approved");
  });

  test("(b) email-verified web signups land at 'verified'; ORCID alone lands at 'pending'", () => {
    const db = dbBeforeTarget();
    seed(db, [
      // The production shape: ORCID-verified, email never confirmed. ADR 0040
      // is explicit that ORCID does not stand in for the email code, so this
      // row must NOT reach the base tier.
      {
        email: "web-orcid-only@x.test",
        status: "approved",
        signupSource: "web",
        orcidVerified: 1,
        approvedAt: "2026-08-01 00:00:00",
      },
      {
        email: "web-email-verified@x.test",
        status: "approved",
        signupSource: "web",
        orcidVerified: 1,
        emailVerified: 1,
        approvedAt: "2026-08-01 00:00:00",
      },
      { email: "web-neither@x.test", status: "approved", signupSource: "web" },
    ]);
    applyTarget(db);

    expect(state(db, "web-orcid-only@x.test").status).toBe("pending");
    expect(state(db, "web-email-verified@x.test").status).toBe("verified");
    expect(state(db, "web-neither@x.test").status).toBe("pending");

    // None of them gains upload access, and the auto-approval stamp goes away
    // with the status it belonged to.
    for (const email of [
      "web-orcid-only@x.test",
      "web-email-verified@x.test",
      "web-neither@x.test",
    ]) {
      expect(state(db, email).service_access).toBe(0);
      expect(state(db, email).approved_at).toBeNull();
    }
  });

  test("(b) does not touch a web row that already holds upload access", () => {
    const db = dbBeforeTarget();
    seed(db, [
      {
        email: "web-granted@x.test",
        status: "approved",
        signupSource: "web",
        serviceAccess: 1,
        orcidVerified: 1,
        grantedAt: "2026-07-24 00:00:00",
        approvedAt: "2026-07-24 00:00:00",
      },
    ]);
    applyTarget(db);

    const row = state(db, "web-granted@x.test");
    expect(row.status).toBe("approved");
    expect(row.service_access).toBe(1);
    expect(row.service_access_granted_at).toBe("2026-07-24 00:00:00");
    expect(row.approved_at).toBe("2026-07-24 00:00:00");
  });

  test("establishes status='approved' iff service_access=1 across a mixed catalog", () => {
    const db = dbBeforeTarget();
    seed(db, [
      { email: "m-cli-approved@x.test", status: "approved", signupSource: "cli", emailVerified: 1 },
      {
        email: "m-cli-granted@x.test",
        status: "approved",
        signupSource: "cli",
        serviceAccess: 1,
        emailVerified: 1,
      },
      { email: "m-cli-verified@x.test", status: "verified", signupSource: "cli", emailVerified: 1 },
      { email: "m-web-orcid@x.test", status: "approved", signupSource: "web", orcidVerified: 1 },
      {
        email: "m-web-email@x.test",
        status: "approved",
        signupSource: "web",
        orcidVerified: 1,
        emailVerified: 1,
      },
      { email: "m-web-pending@x.test", status: "pending", signupSource: "web", orcidVerified: 1 },
    ]);
    expect(invariantViolations(db).length).toBeGreaterThan(0);

    applyTarget(db);

    expect(invariantViolations(db)).toEqual([]);
  });

  test("is a no-op on a second run (production applied rule (a) by hand)", () => {
    const db = dbBeforeTarget();
    seed(db, [
      { email: "idem-cli@x.test", status: "approved", signupSource: "cli", emailVerified: 1 },
      { email: "idem-web@x.test", status: "approved", signupSource: "web", orcidVerified: 1 },
    ]);
    applyTarget(db);
    const afterFirst = [state(db, "idem-cli@x.test"), state(db, "idem-web@x.test")];

    applyTarget(db);

    expect([state(db, "idem-cli@x.test"), state(db, "idem-web@x.test")]).toEqual(afterFirst);
  });

  test("a hand-fixed row keeps its original grant timestamp", () => {
    // Production applied rule (a) by hand on 2026-09-05, so those rows arrive
    // at the migration already at service_access=1. Re-stamping them would
    // overwrite the real grant time with the deploy time.
    const db = dbBeforeTarget();
    seed(db, [
      {
        email: "handfixed@x.test",
        status: "approved",
        signupSource: "cli",
        serviceAccess: 1,
        emailVerified: 1,
        grantedAt: "2026-09-05 12:00:00",
      },
    ]);
    applyTarget(db);

    expect(state(db, "handfixed@x.test").service_access_granted_at).toBe("2026-09-05 12:00:00");
  });
});
