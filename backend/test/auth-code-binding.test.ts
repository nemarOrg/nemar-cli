/**
 * Engine-level tests for migration 0066 (auth_codes.user_id) and the
 * email-change rate buckets (#911 hardening):
 *   - the sign-in and email-change flows can never redeem each other's codes
 *     (the "structural instead of emergent" separation the migration exists for)
 *   - the atomic INSERT guard enforces all three buckets: per-target 1/min,
 *     per-target 5/hour, and per-account 5/hour across ALL targets
 *
 * Runs the production SQL — imported from auth-web.ts, not copied, so the
 * test cannot drift from what the routes execute — against real in-memory
 * SQLite via the shared freshDb helper. No mocks. Complements the live-worker
 * E2E in test/auth-passwordless.test.ts, which proves the HTTP-level guards
 * but deliberately avoids driving the shared dev worker into a rate-limit
 * state that would poison subsequent runs inside the same window.
 */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import {
  EMAIL_CHANGE_CODE_INSERT_SQL,
  EMAIL_CHANGE_CODE_LOOKUP_SQL,
  PER_HOUR_LIMIT,
  PER_MINUTE_LIMIT,
  SIGNIN_CODE_LOOKUP_SQL,
} from "../src/routes/auth-web.js";
import { freshDb } from "./helpers/d1.js";

/** Run the production guarded INSERT for an email-change code; returns rows
 *  changed (0 = a bucket refused it). */
function guardedInsert(db: Database, email: string, userId: number): number {
  return db
    .prepare(EMAIL_CHANGE_CODE_INSERT_SQL)
    .run(
      email,
      "hash",
      "9999-01-01 00:00:00",
      userId,
      email,
      PER_MINUTE_LIMIT,
      email,
      PER_HOUR_LIMIT,
      userId,
      PER_HOUR_LIMIT,
    ).changes;
}

/** Direct insert bypassing the guard, for arranging preconditions.
 *  createdAgo is an SQLite datetime modifier, e.g. "-5 minutes". */
function insertCode(
  db: Database,
  opts: { email: string; userId: number | null; createdAgo?: string },
): void {
  db.prepare(
    `INSERT INTO auth_codes (email, code_hash, expires_at, user_id, created_at)
     VALUES (?, 'hash', '9999-01-01 00:00:00', ?, datetime('now', ?))`,
  ).run(opts.email, opts.userId, opts.createdAgo ?? "-0 seconds");
}

describe("migration 0066: auth_codes.user_id", () => {
  let db: Database;
  beforeEach(() => {
    db = freshDb();
  });

  test("column exists and is nullable (sign-in codes leave it NULL)", () => {
    insertCode(db, { email: "signin@nemar.org", userId: null });
    insertCode(db, { email: "change@nemar.org", userId: 7 });
    const rows = db.prepare("SELECT email, user_id FROM auth_codes ORDER BY id").all() as Array<{
      email: string;
      user_id: number | null;
    }>;
    expect(rows).toEqual([
      { email: "signin@nemar.org", user_id: null },
      { email: "change@nemar.org", user_id: 7 },
    ]);
  });

  test("a change code is invisible to the sign-in lookup", () => {
    insertCode(db, { email: "shared@lab.org", userId: 7 });
    expect(db.prepare(SIGNIN_CODE_LOOKUP_SQL).get("shared@lab.org")).toBeFalsy();
  });

  test("a sign-in code is invisible to the change-verify lookup", () => {
    insertCode(db, { email: "shared@lab.org", userId: null });
    expect(db.prepare(EMAIL_CHANGE_CODE_LOOKUP_SQL).get("shared@lab.org", 7)).toBeFalsy();
  });

  test("each lookup sees exactly its own kind for the same address", () => {
    // The shared-inbox scenario the migration comment names: both flows have
    // live codes for one address, and each query resolves only its own.
    insertCode(db, { email: "shared@lab.org", userId: null });
    insertCode(db, { email: "shared@lab.org", userId: 7 });
    const signin = db.prepare(SIGNIN_CODE_LOOKUP_SQL).get("shared@lab.org") as { id: number };
    const change = db.prepare(EMAIL_CHANGE_CODE_LOOKUP_SQL).get("shared@lab.org", 7) as {
      id: number;
    };
    expect(signin).toBeTruthy();
    expect(change).toBeTruthy();
    expect(signin.id).not.toBe(change.id);
  });

  test("another signed-in user cannot see someone else's change code", () => {
    insertCode(db, { email: "shared@lab.org", userId: 7 });
    expect(db.prepare(EMAIL_CHANGE_CODE_LOOKUP_SQL).get("shared@lab.org", 8)).toBeFalsy();
  });
});

describe("email-change rate buckets (guarded INSERT)", () => {
  let db: Database;
  beforeEach(() => {
    db = freshDb();
  });

  test("per-target 1/min: an immediate repeat to the same address is refused", () => {
    expect(guardedInsert(db, "new@nemar.org", 1)).toBe(1);
    expect(guardedInsert(db, "new@nemar.org", 1)).toBe(0);
  });

  test("per-target 5/hour holds even when each request clears the minute bucket", () => {
    for (let i = 0; i < PER_HOUR_LIMIT; i++) {
      insertCode(db, { email: "new@nemar.org", userId: 1, createdAgo: `-${i + 2} minutes` });
    }
    expect(guardedInsert(db, "new@nemar.org", 1)).toBe(0);
  });

  test("per-account 5/hour caps one account across DISTINCT targets", () => {
    // The bucket the #911 hardening added: without it a session could cycle
    // fresh addresses to spray codes, since the per-email buckets reset with
    // every new target.
    for (let i = 0; i < PER_HOUR_LIMIT; i++) {
      expect(guardedInsert(db, `target-${i}@nemar.org`, 2)).toBe(1);
    }
    expect(guardedInsert(db, "target-fresh@nemar.org", 2)).toBe(0);
  });

  test("one account at its cap does not throttle another account", () => {
    for (let i = 0; i < PER_HOUR_LIMIT; i++) {
      guardedInsert(db, `target-${i}@nemar.org`, 2);
    }
    expect(guardedInsert(db, "other@nemar.org", 3)).toBe(1);
  });

  test("sign-in codes (user_id NULL) do not consume any account's bucket", () => {
    // user_id = ? never matches NULL rows, so a burst of sign-in codes for
    // unrelated addresses leaves every account's change budget intact.
    for (let i = 0; i < PER_HOUR_LIMIT + 2; i++) {
      insertCode(db, { email: `signin-${i}@nemar.org`, userId: null });
    }
    expect(guardedInsert(db, "new@nemar.org", 4)).toBe(1);
  });

  test("codes older than the hour window free the account bucket again", () => {
    for (let i = 0; i < PER_HOUR_LIMIT; i++) {
      insertCode(db, { email: `target-${i}@nemar.org`, userId: 5, createdAgo: "-61 minutes" });
    }
    expect(guardedInsert(db, "target-fresh@nemar.org", 5)).toBe(1);
  });
});
