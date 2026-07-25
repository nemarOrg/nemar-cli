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
      `SELECT id, message, level, scope, created_at, expires_at
       FROM notices
       WHERE (expires_at IS NULL OR expires_at > datetime('now'))
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
      `SELECT id, message, level, scope, created_at, expires_at
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
      `INSERT INTO notices (message, level, scope, created_by, expires_at)
       VALUES (?, ?, ?, ?, ?)
       RETURNING id, message, level, scope, created_at, expires_at`,
    )
    .bind(data.message, data.level, data.scope, createdById, data.expires_at || null)
    .first<Notice>();

  if (!result) throw new Error("Failed to create notice");
  return result;
}

/**
 * Delete a notice by ID. Returns true if a row was deleted.
 */
export async function deleteNotice(db: D1Database, id: number): Promise<boolean> {
  const result = await db.prepare("DELETE FROM notices WHERE id = ?").bind(id).run();
  return (result.meta?.changes ?? 0) > 0;
}
