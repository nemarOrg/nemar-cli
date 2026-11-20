/**
 * Who a community mail category reaches (epic #2260 phase 1, ADR 0132).
 *
 * {@link communityRecipients} is the only place a categorized send selects people. The audience
 * rules (which statuses and account kinds, who may switch the category off) are read from
 * `MAIL_CATEGORY_TABLE`, so this function holds no copy of them; what it adds is the account
 * predicate every audience shares, the role narrowing of a group, and each person's own choice.
 *
 * Every audience requires a live account (`deleted_at IS NULL`), a proved inbox
 * (`email_verified = 1`) and an address on file, and never includes the system account
 * (`SYSTEM_USER_ID`): migration 0026 seeds it as a revoked person with a verified `system@nemar.org`,
 * which is exactly what a recall's audience (revoked included) would otherwise pick up, and that
 * address is a catch-all that becomes a support ticket (ADR 0112). `pending` and `test` accounts are in none, and a
 * recall is the only category that ignores a stored preference, because a recall cannot be
 * switched off.
 *
 * This function selects; it does not send. The delivery fence (`isEmailDeliveryAllowed`, ADR 0009)
 * still runs at enqueue and again at send, so a dev worker that selects a real address here still
 * sends nothing to it.
 */

import {
  MAIL_CATEGORY_TABLE,
  type MailCategory,
  type MailRecipientGroup,
  isCommunityMailCategory,
} from "../../../shared/contract/mail-categories.js";
import { SYSTEM_USER_ID } from "../lib/constants";
import { parseEmailPreferences } from "./email";

export interface MailRecipient {
  userId: number;
  email: string;
}

interface AudienceRow {
  id: number;
  email: string;
  email_preferences: string | null;
}

/** The role clause a group adds. A group narrows the audience and never widens it. */
function roleClause(group: MailRecipientGroup): string {
  switch (group) {
    case "admins":
      return "AND role IN ('owner', 'admin')";
    case "members":
      return "AND role = 'member'";
    default:
      return "";
  }
}

/**
 * The accounts `category` reaches inside `group`, in id order. For a category a person may turn
 * off, an account that has turned it off is left out; a recall reaches the whole audience.
 */
export async function communityRecipients(
  db: D1Database,
  category: MailCategory,
  group: MailRecipientGroup,
): Promise<MailRecipient[]> {
  const rule = MAIL_CATEGORY_TABLE[category];
  const statuses = rule.statuses.map(() => "?").join(", ");
  const kinds = rule.accountKinds.map(() => "?").join(", ");
  const result = await db
    .prepare(
      `SELECT id, email, email_preferences FROM users
        WHERE deleted_at IS NULL
          AND email_verified = 1
          AND email IS NOT NULL AND trim(email) <> ''
          AND id <> ?
          AND status IN (${statuses})
          AND account_kind IN (${kinds}) ${roleClause(group)}
        ORDER BY id`,
    )
    .bind(SYSTEM_USER_ID, ...rule.statuses, ...rule.accountKinds)
    .all<AudienceRow>();

  // The category a person's stored choice can switch off, or null for one nobody may (a recall).
  const switchable = rule.canBeTurnedOff && isCommunityMailCategory(category) ? category : null;
  return result.results
    .filter(
      (row) => switchable === null || parseEmailPreferences(row.email_preferences)[switchable],
    )
    .map((row) => ({ userId: row.id, email: row.email }));
}
