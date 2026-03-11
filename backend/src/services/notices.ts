/**
 * Notice management service
 *
 * CRUD for system notices displayed to CLI users on startup.
 * Notices can be scoped to specific roles and have optional expiry.
 */

import type { UserRole } from "../types/bindings";

export interface Notice {
  id: number;
  message: string;
  level: "info" | "warning" | "critical";
  scope: "all" | "admins" | "members";
  created_at: string;
  expires_at: string | null;
}

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
       ORDER BY
         CASE level WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,
         created_at DESC`,
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
    level: "info" | "warning" | "critical";
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
