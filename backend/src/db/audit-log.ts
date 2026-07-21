// Canonical audit_log insert, shared by every route that writes an audit row.
// Before #903 the codebase carried several hand-rolled INSERT shapes (5-column
// and a drifted 3-column `(action, user_id, details)` variant); this module is
// the single shape call sites converge on as they move during the #902 split.
// resource_type / resource_id / details are nullable in the schema (migration
// 0001), so a null-filled 5-column insert is row-identical to the legacy
// 3-column one.

export interface AuditLogEntry {
  /** Acting user's id; null for system-initiated actions with no user. */
  userId: number | null;
  action: string;
  resourceType?: string | null;
  resourceId?: string | null;
  /** Free-form context, conventionally a JSON string. */
  details?: string | null;
}

export const AUDIT_LOG_INSERT_SQL = `INSERT INTO audit_log (user_id, action, resource_type, resource_id, details)
   VALUES (?, ?, ?, ?, ?)`;

/**
 * Positional params for AUDIT_LOG_INSERT_SQL. Exported separately so the
 * behavioral test can run the production SQL + marshaling against bun:sqlite
 * (same approach as user-tombstone.ts, whose test uses a different driver API
 * than D1).
 */
export function auditLogParams(
  entry: AuditLogEntry,
): [number | null, string, string | null, string | null, string | null] {
  return [
    entry.userId,
    entry.action,
    entry.resourceType ?? null,
    entry.resourceId ?? null,
    entry.details ?? null,
  ];
}

/**
 * The audit insert as a bound D1 statement. Wrapping it hides the positional
 * bind order so a call site can't transpose columns (the pre-#903 drift).
 * Returns the statement without running it: call sites keep their own
 * execution semantics (`await .run()`, `executionCtx.waitUntil`, or batch).
 */
export function auditLogStatement(db: D1Database, entry: AuditLogEntry): D1PreparedStatement {
  return db.prepare(AUDIT_LOG_INSERT_SQL).bind(...auditLogParams(entry));
}
