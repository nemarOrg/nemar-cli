/**
 * Notice management service
 *
 * CRUD for system notices displayed to CLI users on startup.
 * Notices can be scoped to specific roles and have optional expiry.
 */

import type { UserRole } from "../types/bindings";

/**
 * Notice severity (#1025). Ordered here most urgent first, which is also the
 * stacking order the website renders and {@link NOTICE_LEVEL_ORDER} encodes.
 *
 * - `critical`     live outage, data at risk
 * - `warning`      degraded right now
 * - `maintenance`  planned or in-progress work window
 * - `announcement` good news: a conference, a release, a milestone
 * - `tip`          low-key hint or standing note (was `info` before 0063)
 *
 * `info` is no longer a stored value, but the admin create route still
 * accepts it and normalizes it to `tip` so existing CLI invocations and
 * scripts keep working.
 */
export type NoticeLevel = "critical" | "warning" | "maintenance" | "announcement" | "tip";

export const NOTICE_LEVELS: NoticeLevel[] = [
  "critical",
  "warning",
  "maintenance",
  "announcement",
  "tip",
];

/**
 * Legacy level accepted on write and normalized away. Kept as its own
 * constant so the compatibility shim has exactly one definition.
 */
export const LEGACY_LEVEL_ALIASES: Record<string, NoticeLevel> = { info: "tip" };

/** Maps a caller-supplied level onto the stored vocabulary. */
export function normalizeLevel(level: string): string {
  return LEGACY_LEVEL_ALIASES[level] ?? level;
}

export interface Notice {
  id: number;
  message: string;
  level: NoticeLevel;
  scope: "all" | "admins" | "members";
  created_at: string;
  expires_at: string | null;
}

/**
 * SQL `CASE` fragment ranking levels by urgency for ORDER BY. Generated from
 * {@link NOTICE_LEVELS} rather than hand-written so a level added to the
 * union can never silently fall to the bottom of the stack: adding it to the
 * array is all that's required.
 *
 * Interpolated into SQL rather than bound as parameters because these are
 * compile-time constants from this module, never caller input — and a CASE's
 * WHEN values can't be parameterized positionally in a useful way here.
 */
const NOTICE_LEVEL_ORDER = `CASE level ${NOTICE_LEVELS.map(
  (level, index) => `WHEN '${level}' THEN ${index}`,
).join(" ")} ELSE ${NOTICE_LEVELS.length} END`;

/**
 * Timestamp columns, projected as explicit-UTC RFC3339 (#1024).
 *
 * Storage is SQLite's `YYYY-MM-DD HH:MM:SS` so that comparisons against
 * `datetime('now')` are byte-comparable (that mismatch WAS the bug). But
 * that format is a trap on the wire: `Date.parse("2026-07-25 14:30:00")` is
 * not ISO-8601, and both V8 and JavaScriptCore interpret it as *local* time,
 * so every JS consumer would silently shift it by the viewer's own UTC
 * offset. Appending the `Z` makes the instant unambiguous for the website,
 * the CLI, and anything else reading these endpoints.
 *
 * Applied to `created_at` as well as `expires_at`: they come back in the
 * same object, and returning one unambiguous field beside one that parses
 * as local time is exactly the kind of inconsistency that produces a
 * timezone bug six months from now.
 */
export const NOTICE_COLUMNS = `id, message, level, scope,
       strftime('%Y-%m-%dT%H:%M:%SZ', created_at) AS created_at,
       strftime('%Y-%m-%dT%H:%M:%SZ', expires_at) AS expires_at`;

/**
 * Predicate for "not expired" (#1024).
 *
 * Correct only because `expires_at` is stored in SQLite's own
 * `YYYY-MM-DD HH:MM:SS` format, so this is a like-for-like byte comparison.
 * Storing RFC3339 here instead is what made same-day expiries compare as
 * active — see migration 0064.
 *
 * Exported so the test suite asserts against the real predicate rather than
 * a copy that could drift away from it.
 */
export const NOTICE_ACTIVE_FILTER = "expires_at IS NULL OR expires_at > datetime('now')";

/**
 * Get active (non-expired) notices visible to a given role.
 * Unauthenticated callers only see "all"-scoped notices.
 */
export async function getActiveNotices(db: D1Database, userRole?: UserRole): Promise<Notice[]> {
  const scopes = ["all"];
  if (userRole === "admin" || userRole === "owner") scopes.push("admins");
  if (userRole === "member") scopes.push("members");

  const placeholders = scopes.map(() => "?").join(", ");
  const result = await db
    .prepare(
      `SELECT ${NOTICE_COLUMNS}
       FROM notices
       WHERE (${NOTICE_ACTIVE_FILTER})
         AND scope IN (${placeholders})
       ORDER BY ${NOTICE_LEVEL_ORDER}, created_at DESC`,
    )
    .bind(...scopes)
    .all<Notice>();

  return result.results || [];
}

/**
 * List all notices (including expired) for admin view.
 */
export async function listAllNotices(db: D1Database): Promise<Notice[]> {
  const result = await db
    .prepare(
      `SELECT ${NOTICE_COLUMNS}
       FROM notices
       ORDER BY created_at DESC`,
    )
    .all<Notice>();

  return result.results || [];
}

/**
 * Create a new notice. Returns the created notice.
 */
export async function createNotice(
  db: D1Database,
  data: {
    message: string;
    level: NoticeLevel;
    scope: "all" | "admins" | "members";
    expires_at?: string;
  },
  createdById: number,
): Promise<Notice> {
  const result = await db
    .prepare(
      // datetime(?) normalizes the RFC3339 input (any offset, or a Z) to
      // the storage format the expiry comparison uses. Without it the value
      // keeps its `T` separator and never compares correctly against
      // datetime('now') on the same date -- issue #1024.
      `INSERT INTO notices (message, level, scope, created_by, expires_at)
       VALUES (?, ?, ?, ?, datetime(?))
       RETURNING ${NOTICE_COLUMNS}`,
    )
    .bind(data.message, data.level, data.scope, createdById, data.expires_at || null)
    .first<Notice>();

  if (!result) throw new Error("Failed to create notice");

  // `datetime()` returns NULL for input it can't parse, and NULL in this
  // column means "never expires" — so a value that survives validation but
  // not SQLite would be written as a PERMANENT notice, with a 201 and no
  // error anywhere. Nothing throws; the write simply succeeds into the
  // wrong state.
  //
  // Reachable because the two validators disagree: zod's
  // `.datetime({ offset: true })` checks the offset's digit COUNT, not its
  // range, so `+15:00` (no such UTC offset) passes zod and yields NULL from
  // datetime(). Checking the round-trip rather than the offset specifically
  // is deliberate — it also covers any future divergence between what zod
  // accepts and what SQLite parses, which is the part likely to drift.
  if (data.expires_at && result.expires_at === null) {
    throw new Error(
      `expires_at ${JSON.stringify(data.expires_at)} passed validation but SQLite could not parse it; refusing to create a notice that would silently never expire`,
    );
  }
  return result;
}

/**
 * Delete a notice by ID. Returns true if a row was deleted.
 */
export async function deleteNotice(db: D1Database, id: number): Promise<boolean> {
  const result = await db.prepare("DELETE FROM notices WHERE id = ?").bind(id).run();
  return (result.meta?.changes ?? 0) > 0;
}
