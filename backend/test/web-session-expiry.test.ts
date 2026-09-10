/**
 * `web_sessions.expires_at` is stored in SQLite's own datetime spelling, and an
 * expired session is actually expired (epic #1336 phase 0 review).
 *
 * Real engine throughout: bun:sqlite behind `realD1` with every migration
 * applied, real `issueSession` / `findSessionByCookieId` / `maybeSlideExpiry`,
 * and migration 0084 replayed from the file on disk. No mocks.
 *
 * THE BUG THESE TESTS PIN. `prepareSessionInsert` wrote
 * `new Date(...).toISOString()` while every reader compares
 * `expires_at > datetime('now')`, and SQLite compares those as TEXT:
 * `'2026-09-10T11:07:21.484Z'` versus `'2026-09-10 12:07:21'` is decided at byte
 * 11, where `'T'` (0x54) sorts after `' '` (0x20). So an expiry bearing the same
 * calendar date as the comparison ALWAYS won, and a session kept authenticating
 * until the next UTC midnight past its nominal end -- up to a day of extra life
 * on a 24-hour session, with nothing reporting it. The device flow's ADR (0047)
 * records this exact trap; it had simply never been checked in this table, which
 * is where the docs gate's `DOCS_GRANT_INSERT_SQL` re-proves an app session.
 *
 * The first test below asserts the byte-level comparison directly, so the reason
 * survives even if someone later "simplifies" the format back.
 */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { findSessionByCookieId, issueSession, maybeSlideExpiry } from "../src/services/web-session";
import type { Bindings } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

const SQL_DATETIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

const MIGRATION_0084 = readFileSync(
  join(import.meta.dir, "../src/db/migrations/0084_web_session_expiry_format.sql"),
  "utf-8",
);

let db: Database;

function env(): Bindings {
  return { DB: realD1(db), ENVIRONMENT: "test" } as unknown as Bindings;
}

function seedUser(): number {
  db.run(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified, account_kind)
     VALUES ('expiryuser', 'expiry@nemar.test', 'x', 'approved', 'member', 1, 'person')`,
  );
  const row = db
    .query<{ id: number }, []>("SELECT id FROM users WHERE username='expiryuser'")
    .get();
  if (!row) throw new Error("seed failed");
  return row.id;
}

function storedExpiry(userId: number): string {
  const row = db
    .query<{ expires_at: string }, [number]>(
      "SELECT expires_at FROM web_sessions WHERE user_id = ? ORDER BY id DESC LIMIT 1",
    )
    .get(userId);
  if (!row) throw new Error("no session row");
  return row.expires_at;
}

/** An ISO timestamp on the SAME UTC date as the database's own clock, at the
 *  earliest instant of that date -- so it is never in the future, and never
 *  lands on the previous date if the suite happens to run just after midnight.
 *  Pinning the date this way is what keeps the comparison test deterministic. */
function isoEarlierToday(): string {
  const today = db.query<{ d: string }, []>("SELECT date('now') AS d").get();
  if (!today) throw new Error("no clock");
  return `${today.d}T00:00:00.000Z`;
}

function comparesLive(value: string): boolean {
  const row = db
    .query<{ live: number }, [string]>("SELECT (? > datetime('now')) AS live")
    .get(value);
  return row?.live === 1;
}

beforeEach(() => {
  db = freshDb();
});

describe("the format, and why it is not a matter of taste", () => {
  test("an ISO expiry earlier TODAY compares as still live; the SQLite spelling does not", () => {
    const iso = isoEarlierToday();
    expect(comparesLive(iso)).toBe(true);
    // The same instant, written the way `datetime()` writes it.
    expect(comparesLive(iso.replace("T", " ").slice(0, 19))).toBe(false);
  });

  test("issueSession writes the SQLite spelling", async () => {
    const userId = seedUser();
    await issueSession(env(), userId, false, "agent", "127.0.0.1", "email_code");
    const stored = storedExpiry(userId);
    expect(stored).toMatch(SQL_DATETIME);
    expect(stored).not.toContain("T");
    expect(comparesLive(stored)).toBe(true);
  });

  test("a session one second past its expiry is refused", async () => {
    const userId = seedUser();
    const { cookieIdRaw } = await issueSession(env(), userId, false, "agent", "127.0.0.1", "orcid");
    expect(await findSessionByCookieId(env(), cookieIdRaw)).not.toBeNull();
    db.run("UPDATE web_sessions SET expires_at = datetime('now', '-1 second') WHERE user_id = ?", [
      userId,
    ]);
    expect(await findSessionByCookieId(env(), cookieIdRaw)).toBeNull();
  });
});

describe("migration 0084 rewrites the rows the old code left behind", () => {
  test("an ISO row authenticates before the rewrite and not after", async () => {
    // Both halves matter. The first is the bug as it shipped: a row whose
    // expiry passed hours ago resolves to a valid login. The second is the
    // migration doing its job on exactly that row.
    const userId = seedUser();
    const { cookieIdRaw } = await issueSession(env(), userId, false, "agent", "127.0.0.1", "orcid");
    db.run("UPDATE web_sessions SET expires_at = ? WHERE user_id = ?", [isoEarlierToday(), userId]);
    expect(await findSessionByCookieId(env(), cookieIdRaw)).not.toBeNull();

    db.exec(MIGRATION_0084);

    expect(storedExpiry(userId)).toMatch(SQL_DATETIME);
    expect(await findSessionByCookieId(env(), cookieIdRaw)).toBeNull();
  });

  test("it leaves a live ISO row live, converting rather than expiring it", async () => {
    // The rewrite must not become a mass sign-out: a remember-me session with
    // three weeks to run has to survive it.
    const userId = seedUser();
    const { cookieIdRaw } = await issueSession(env(), userId, true, "agent", "127.0.0.1", "orcid");
    const future = new Date(Date.now() + 21 * 24 * 60 * 60 * 1000).toISOString();
    db.run("UPDATE web_sessions SET expires_at = ? WHERE user_id = ?", [future, userId]);

    db.exec(MIGRATION_0084);

    expect(storedExpiry(userId)).toBe(future.replace("T", " ").slice(0, 19));
    expect(await findSessionByCookieId(env(), cookieIdRaw)).not.toBeNull();
  });

  test("it is idempotent: a second run changes nothing", () => {
    const userId = seedUser();
    db.run(
      `INSERT INTO web_sessions (user_id, cookie_id_hash, remember, expires_at)
       VALUES (?, 'hash-idem', 1, ?)`,
      [userId, isoEarlierToday()],
    );
    db.exec(MIGRATION_0084);
    const once = storedExpiry(userId);
    db.exec(MIGRATION_0084);
    expect(storedExpiry(userId)).toBe(once);
  });
});

describe("maybeSlideExpiry", () => {
  async function rememberSession(userId: number, daysLeft: number) {
    const { cookieIdRaw } = await issueSession(env(), userId, true, "agent", "127.0.0.1", "orcid");
    db.run(
      "UPDATE web_sessions SET expires_at = datetime('now', '+' || ? || ' days') WHERE user_id = ?",
      [daysLeft, userId],
    );
    const found = await findSessionByCookieId(env(), cookieIdRaw);
    if (!found) throw new Error("session not found after adjusting expiry");
    return found.session;
  }

  test("slides a session inside the refresh window, in the SQLite spelling", async () => {
    const userId = seedUser();
    const session = await rememberSession(userId, 2);
    const slid = await maybeSlideExpiry(env(), session);
    expect(slid).not.toBeNull();
    expect(slid?.maxAgeSeconds).toBe(30 * 24 * 60 * 60);
    const stored = storedExpiry(userId);
    // The write used to reintroduce the very format the insert had just been
    // fixed to stop producing, which would have re-broken expiry on any
    // long-lived session that stayed active.
    expect(stored).toMatch(SQL_DATETIME);
    const days = db
      .query<{ d: number }, [string]>("SELECT julianday(?) - julianday('now') AS d")
      .get(stored);
    expect(days?.d).toBeGreaterThan(29);
  });

  test("leaves a session outside the window alone", async () => {
    const userId = seedUser();
    const session = await rememberSession(userId, 20);
    const before = storedExpiry(userId);
    expect(await maybeSlideExpiry(env(), session)).toBeNull();
    expect(storedExpiry(userId)).toBe(before);
  });

  test("never slides a non-remember session", async () => {
    const userId = seedUser();
    const { cookieIdRaw } = await issueSession(env(), userId, false, "agent", "127.0.0.1", "orcid");
    const found = await findSessionByCookieId(env(), cookieIdRaw);
    if (!found) throw new Error("session missing");
    expect(await maybeSlideExpiry(env(), found.session)).toBeNull();
  });

  test("never slides a revoked session", async () => {
    // A revoked row is unreachable through `findSessionByCookieId`, so this can
    // only be reached by a caller holding a stale row -- and the answer has to
    // be no. The predicate is in the UPDATE rather than in JS, so it holds for
    // any caller.
    const userId = seedUser();
    const session = await rememberSession(userId, 2);
    db.run("UPDATE web_sessions SET revoked_at = datetime('now') WHERE user_id = ?", [userId]);
    const before = storedExpiry(userId);
    expect(await maybeSlideExpiry(env(), session)).toBeNull();
    expect(storedExpiry(userId)).toBe(before);
  });
});
