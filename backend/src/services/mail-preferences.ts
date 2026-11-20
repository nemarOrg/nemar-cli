/**
 * Writing `users.email_preferences` with its audit trail (epic #2260 phase 1, ADR 0132).
 *
 * One writer for a change to an account's mail preferences, so the consent record cannot be
 * forgotten by the next route that edits them (the admin route today, the self-service route and
 * the unsubscribe link in later phases). Every change to a community category writes a
 * `mail_category_changed` audit row, `{category, on, via}`, in the SAME batch as the update, and
 * only when the update changed a row: a row cannot claim a change that did not happen, and a
 * change cannot happen without its row. That record is what a controller needs to be able to show
 * when someone asks when and how they stopped receiving a category.
 *
 * A recall is never written: it has no key, and no value here could carry one.
 */

import {
  COMMUNITY_MAIL_CATEGORIES,
  type CommunityMailCategory,
} from "../../../shared/contract/mail-categories.js";
import { AUDIT_IF_PREVIOUS_CHANGED_SQL, auditLogParams } from "../db/audit-log";
import type { EmailPreferences } from "./email";

/** Where a change came from, recorded as `via` in the audit row. */
export type MailChangeVia =
  | "settings"
  | "cli"
  | "one_click"
  | "link"
  | "link_all"
  | "admin"
  | "migration";

export interface CommunityChange {
  category: CommunityMailCategory;
  on: boolean;
}

/** The community categories whose value differs between two preference sets, in table order. */
export function communityChanges(
  current: EmailPreferences,
  next: EmailPreferences,
): CommunityChange[] {
  return COMMUNITY_MAIL_CATEGORIES.filter((category) => current[category] !== next[category]).map(
    (category) => ({ category, on: next[category] }),
  );
}

export interface SavePreferencesInput {
  /** The account whose preferences change. */
  targetId: number;
  targetUsername: string;
  /** Who made the change: the account itself, or an owner or admin acting for it. */
  actorId: number;
  current: EmailPreferences;
  next: EmailPreferences;
  via: MailChangeVia;
}

/**
 * Store `next` for the target and write one audit row per changed community category, plus (when
 * the actor is not the target) the `email_preferences_updated` row an edit of someone else's
 * preferences has always left. One D1 batch, so it commits whole or not at all. Returns whether
 * the update matched a live account; false means nothing was written, audit rows included.
 */
export async function saveEmailPreferences(
  db: D1Database,
  input: SavePreferencesInput,
): Promise<boolean> {
  const { targetId, targetUsername, actorId, current, next, via } = input;
  const audit = (action: string, details: string) =>
    db.prepare(AUDIT_IF_PREVIOUS_CHANGED_SQL).bind(
      ...auditLogParams({
        userId: actorId,
        action,
        resourceType: "user",
        resourceId: String(targetId),
        details,
      }),
    );

  const statements: D1PreparedStatement[] = [
    db
      .prepare("UPDATE users SET email_preferences = ? WHERE id = ? AND deleted_at IS NULL")
      .bind(JSON.stringify(next), targetId),
  ];
  for (const change of communityChanges(current, next)) {
    statements.push(audit("mail_category_changed", JSON.stringify({ ...change, via })));
  }
  // Audit who changed whose prefs when someone acts for another account (#808 follow-up).
  if (targetId !== actorId) {
    statements.push(
      audit("email_preferences_updated", JSON.stringify({ target: targetUsername, updated: next })),
    );
  }

  const results = await db.batch(statements);
  return (results[0]?.meta?.changes ?? 0) > 0;
}
