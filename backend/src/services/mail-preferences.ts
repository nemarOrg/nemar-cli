/**
 * Writing `users.email_preferences` with its audit trail (epic #2260 phase 1, ADR 0132).
 *
 * One writer for a change to an account's mail preferences, so the consent record cannot be
 * forgotten by the next route that edits them (the admin route today, the self-service route and
 * the unsubscribe link in later phases). Every change to a community category writes a
 * `mail_category_changed` audit row, `{category, on, via}`, in the SAME batch as the update, and
 * only when the stored value differs from the one being set: a row cannot claim a change that did
 * not happen, and a change cannot happen without its row. That record is what a controller needs to be able to show
 * when someone asks when and how they stopped receiving a category.
 *
 * A recall is never written: it has no key, and no value here could carry one.
 */

import { COMMUNITY_MAIL_CATEGORIES } from "../../../shared/contract/mail-categories.js";
import type { EmailPreferences } from "./email";

/**
 * Where a change came from, recorded as `via` in the audit row. `self` is an account changing its
 * own preferences through the admin route (the route does not know which client sent it);
 * `cli` and `settings` are for the self-service route's own clients, and `admin` is an owner or
 * admin acting for another account.
 */
export type MailChangeVia =
  | "self"
  | "settings"
  | "cli"
  | "one_click"
  | "link"
  | "link_all"
  | "admin"
  | "migration";

export interface SavePreferencesInput {
  /** The account whose preferences change. */
  targetId: number;
  targetUsername: string;
  /** Who made the change: the account itself, or an owner or admin acting for it. */
  actorId: number;
  /** ONLY the keys to set. Every other key in the stored blob is left exactly as it is. */
  changes: Partial<EmailPreferences>;
  via: MailChangeVia;
}

/**
 * The stored blob as an object, whatever the column holds: NULL, text that is not JSON, or JSON
 * that is not an object all read as `{}` (the parser reads each as "all on"). The inner CASE keeps
 * json_type() from ever seeing malformed text, which would raise instead of answering.
 */
const STORED_OBJECT_SQL = `(CASE WHEN email_preferences IS NOT NULL AND json_valid(email_preferences)
    THEN (CASE WHEN json_type(email_preferences) = 'object' THEN email_preferences ELSE '{}' END)
    ELSE '{}' END)`;

/** A key is OFF only when stored as strict JSON `false`, the way the parser reads every key. */
const KEY_IS_OFF_SQL = (key: string) =>
  `COALESCE(json_type(${STORED_OBJECT_SQL}, '$.${key}') = 'false', 0)`;

/**
 * Set the given keys for the target and leave the rest of the stored blob alone, writing one
 * `mail_category_changed` audit row per community category whose value actually changes, plus
 * (when the actor is not the target) the `email_preferences_updated` row an edit of someone else's
 * preferences has always left. That row records only the keys this call changed
 * (`{target, updated}`), not the whole stored blob.
 *
 * Two properties are the reason this is SQL and not a read-modify-write in the route:
 *
 * - The update is one `json_set` over only the changed keys, evaluated against the row as it is
 *   WHEN THE STATEMENT RUNS. A whole-blob write of a value read earlier would silently revert a
 *   concurrent write to any other key (an admin alert switched while a person unsubscribes), and
 *   the unsubscribe link of a later phase reuses this writer.
 * - Each audit row is an `INSERT ... SELECT` that runs BEFORE the update, in the same batch, and
 *   fires only when the stored value differs from the one being set. It therefore diffs against
 *   the value actually replaced, not against a copy read earlier, and it exists only when the
 *   account is live.
 *
 * One D1 batch, so it commits whole or not at all. A recall has no key and cannot be passed.
 * Returns whether the update matched a live account; false means nothing was written.
 */
export async function saveEmailPreferences(
  db: D1Database,
  input: SavePreferencesInput,
): Promise<boolean> {
  const { targetId, targetUsername, actorId, changes, via } = input;
  const entries = Object.entries(changes).filter(
    (entry): entry is [keyof EmailPreferences, boolean] => entry[1] !== undefined,
  );
  if (entries.length === 0) {
    // Nothing to write, but the answer is the same as for a non-empty change: false when the
    // account is not live, so an empty request cannot report success for a deleted account.
    const live = await db
      .prepare("SELECT 1 AS live FROM users WHERE id = ? AND deleted_at IS NULL")
      .bind(targetId)
      .first<{ live: number }>();
    return live !== null;
  }

  const statements: D1PreparedStatement[] = [];
  const communityKeys = new Set<string>(COMMUNITY_MAIL_CATEGORIES);
  for (const [key, on] of entries) {
    if (!communityKeys.has(key)) continue;
    statements.push(
      db
        .prepare(
          `INSERT INTO audit_log (user_id, action, resource_type, resource_id, details)
           SELECT ?, 'mail_category_changed', 'user', ?, ?
             FROM users
            WHERE id = ? AND deleted_at IS NULL AND ${KEY_IS_OFF_SQL(key)} <> ?`,
        )
        .bind(
          actorId,
          String(targetId),
          JSON.stringify({ category: key, on, via }),
          targetId,
          on ? 0 : 1,
        ),
    );
  }
  // Audit who changed whose prefs when someone acts for another account (#808 follow-up).
  if (targetId !== actorId) {
    statements.push(
      db
        .prepare(
          `INSERT INTO audit_log (user_id, action, resource_type, resource_id, details)
           SELECT ?, 'email_preferences_updated', 'user', ?, ?
             FROM users WHERE id = ? AND deleted_at IS NULL`,
        )
        .bind(
          actorId,
          String(targetId),
          JSON.stringify({ target: targetUsername, updated: Object.fromEntries(entries) }),
          targetId,
        ),
    );
  }
  const setPairs = entries.map(([key]) => `'$.${key}', json(?)`).join(", ");
  statements.push(
    db
      .prepare(
        `UPDATE users SET email_preferences = json_set(${STORED_OBJECT_SQL}, ${setPairs})
          WHERE id = ? AND deleted_at IS NULL`,
      )
      .bind(...entries.map(([, on]) => (on ? "true" : "false")), targetId),
  );

  const results = await db.batch(statements);
  return (results[results.length - 1]?.meta?.changes ?? 0) > 0;
}
