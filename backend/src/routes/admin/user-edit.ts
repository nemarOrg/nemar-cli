/**
 * Admin routes: one account's details and an admin edit of it (ADR 0093).
 *
 *   GET   /admin/users/by-id/:id   details, every non-secret column
 *   PATCH /admin/users/by-id/:id   edit a closed set of fields
 *
 * Keyed by id, not username, for the same reason `approve/by-id` and
 * `revoke/by-id` are: a web/ORCID account has username = NULL by design (#1012)
 * and the username-keyed routes cannot reach it. The search route
 * (`GET /admin/users?q=`) is how an admin finds the id.
 *
 * What the edit may change, and who may change it, is declared in
 * `shared/contract/admin-user.ts`; how a request is read and compared is in
 * `services/admin-user-edit.ts`. This file is the part that needs the database
 * and the caller: does the account exist, is it the caller's own, does anyone
 * already hold this address, and the one batch that writes the change with its
 * audit row.
 *
 * Deliberately absent, because each has a route that also carries the side
 * effects this one would skip: role (token revocation on demotion), status and
 * upload access (ADR 0040), account kind (ADR 0048), the ORCID iD (ADR 0043, it
 * is proven and never typed), the identity-conflict flag, and credentials.
 */

import {
  ADMIN_USER_EDITABLE_FIELDS,
  ADMIN_USER_ERROR_MESSAGES,
  ADMIN_USER_NAME_FIELDS,
  type AdminUserEditableField,
  isAdminUserIdentityField,
} from "../../../../shared/contract/admin-user.js";
import { auditLogStatement } from "../../db/audit-log";
import { flag } from "../../db/flag";
import {
  type AdminUserCurrent,
  diffAdminUserPatch,
  emailInboxChanged,
  parseAdminUserEdit,
} from "../../services/admin-user-edit";
import { findEmailHolder, findGithubHolder, isUniqueViolationOn } from "../../services/identity";
import { profileRefusal } from "../../services/profile";
import { ADMIN_USER_DETAIL_SELECT } from "../../services/user-search";
import type { AdminRouter } from "./shared";

/** A positive integer path segment, or null. Rejects `12abc`, `0`, `-3`, `1e3`. */
function parseUserId(raw: string): number | null {
  if (!/^\d{1,15}$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/**
 * One account's details. The SELECT list is {@link ADMIN_USER_DETAIL_SELECT},
 * an explicit list derived from the column classification, never `u.*`.
 */
async function loadUserDetail(
  db: D1Database,
  id: number,
  includeDeleted: boolean,
): Promise<Record<string, unknown> | null> {
  const row = await db
    .prepare(
      `SELECT ${ADMIN_USER_DETAIL_SELECT},
        (SELECT COUNT(*) FROM datasets WHERE owner_user_id = u.id) AS dataset_count,
        (SELECT COUNT(*) FROM tokens WHERE user_id = u.id AND revoked_at IS NULL) AS active_tokens,
        (SELECT group_concat(provider, ',')
           FROM (SELECT DISTINCT provider FROM oauth_identities WHERE user_id = u.id ORDER BY provider)
        ) AS linked_identities
      FROM users u
      WHERE u.id = ?1 ${includeDeleted ? "" : "AND u.deleted_at IS NULL"}`,
    )
    .bind(id)
    .first<Record<string, unknown>>();
  if (!row) return null;
  const linked = typeof row.linked_identities === "string" ? row.linked_identities : "";
  return { ...row, linked_identities: linked.split(",").filter((p) => p.length > 0) };
}

interface EditTarget extends AdminUserCurrent {
  id: number;
  orcid: string | null;
  orcid_verified: number;
}

export function registerUserEditRoutes(admin: AdminRouter): void {
  /**
   * GET /admin/users/by-id/:id - details for one account (any admin).
   * `?include_deleted=true` reads a tombstoned account, as the listing's does.
   */
  admin.get("/users/by-id/:id", async (c) => {
    const id = parseUserId(c.req.param("id"));
    if (id === null) {
      return c.json(
        { error: "invalid_user_id", message: "The user id must be a positive integer" },
        400,
      );
    }
    const user = await loadUserDetail(c.env.DB, id, c.req.query("include_deleted") === "true");
    if (!user) return c.json({ error: "User not found" }, 404);
    return c.json({ user });
  });

  /**
   * PATCH /admin/users/by-id/:id - edit an account.
   *
   * Descriptive fields (name, affiliation, city, country): any admin.
   * Identity fields (username, email, GitHub handle): owners only, and never on
   * the owner's own account. See the file header for what is NOT editable.
   */
  admin.patch("/users/by-id/:id", async (c) => {
    const id = parseUserId(c.req.param("id"));
    if (id === null) {
      return c.json(
        { error: "invalid_user_id", message: "The user id must be a positive integer" },
        400,
      );
    }
    const db = c.env.DB;
    const actor = c.get("user");

    const raw = await c.req.json().catch(() => null);
    const parsed = parseAdminUserEdit(raw, actor.role === "owner");
    if (!parsed.ok) {
      return c.json({ error: parsed.error, message: parsed.message }, parsed.status);
    }
    const patch = parsed.patch;

    const target = await db
      .prepare(
        `SELECT id, username, email, github_username, given_name, family_name, affiliation,
                city, country, orcid, orcid_verified
           FROM users WHERE id = ?1 AND deleted_at IS NULL`,
      )
      .bind(id)
      .first<EditTarget>();
    if (!target) return c.json({ error: "User not found" }, 404);

    // The owner's own account goes through the path that asks for proof. Without
    // this, `PATCH /admin/users/by-id/<my id> {"email": ...}` is a way around
    // the email-change code (ADR 0044) for the one role that can reach it.
    if (Object.keys(patch).some(isAdminUserIdentityField) && target.id === actor.id) {
      return c.json(
        { error: "edit_own_account", message: ADMIN_USER_ERROR_MESSAGES.edit_own_account },
        400,
      );
    }

    // A verified ORCID record owns the name and rewrites it at the next sign-in
    // (ADR 0041), so an edit here would last until then and look like a bug.
    if (
      ADMIN_USER_NAME_FIELDS.some((field) => field in patch) &&
      flag(target.orcid_verified) &&
      (target.orcid ?? "").trim() !== ""
    ) {
      return c.json(
        profileRefusal(
          "name_is_orcid_canonical",
          "This account's name comes from its verified ORCID record and is refreshed on every sign-in, so an edit here would be overwritten. The person updates it at orcid.org and signs in again.",
        ),
        409,
      );
    }

    const changed = diffAdminUserPatch(target, patch);
    const changedFields = ADMIN_USER_EDITABLE_FIELDS.filter((field) => field in changed);
    if (changedFields.length === 0) {
      const user = await loadUserDetail(db, id, false);
      return c.json({ message: "No changes: every value already matches", changed: {}, user });
    }

    // Uniqueness, checked up front so an admin gets a sentence naming the
    // account that holds the value (ADR 0043). The database still enforces it;
    // the catch around the write handles the race between this and that.
    if (changed.username?.to) {
      const holder = await db
        .prepare(
          `SELECT id, username FROM users
            WHERE username = ?1 COLLATE NOCASE AND id != ?2 AND deleted_at IS NULL LIMIT 1`,
        )
        .bind(changed.username.to, target.id)
        .first<{ id: number; username: string | null }>();
      if (holder) return c.json(heldBy("username_taken", "username", holder), 409);
    }
    if (changed.email?.to) {
      const holder = await findEmailHolder(db, changed.email.to, target.id);
      if (holder) return c.json(heldBy("email_in_use", "email address", holder), 409);
    }
    if (changed.github_username?.to) {
      const holder = await findGithubHolder(db, changed.github_username.to, target.id);
      if (holder) return c.json(heldBy("github_in_use", "GitHub handle", holder), 409);
    }

    // Column names come from the closed field list above, never from the
    // request, so interpolating them is safe; every VALUE is a numbered bind.
    const values: Array<string | number | null> = [];
    const bindValue = (value: string | number | null): string => `?${values.push(value)}`;
    const sets = changedFields.map((field: AdminUserEditableField) => {
      return `${field} = ${bindValue(changed[field]?.to ?? null)}`;
    });

    const notes: string[] = [];
    const emailReset = Boolean(
      changed.email && emailInboxChanged(changed.email.from, changed.email.to),
    );
    if (emailReset) {
      sets.push("email_verified = 0");
      notes.push(
        "The new email address is unconfirmed (email_verified reset to 0); the person confirms it in Settings. No message was sent to either address.",
      );
    }
    if (changed.username) {
      // The name is now an admin's deliberate choice, so the "we picked this,
      // change it if you like" prompt (ADR 0045) no longer applies.
      sets.push("username_auto_assigned = 0");
      notes.push(
        "Anything that refers to the old username by name (scripts, 'nemar admin approve <username>') now needs the new one. API keys are unaffected.",
      );
    }
    if (changed.github_username?.to) {
      notes.push(
        "The GitHub handle was checked for format and uniqueness only, not against GitHub. Confirm it resolves before the account is approved.",
      );
    }
    sets.push("updated_at = datetime('now')");
    const idPlaceholder = bindValue(target.id);

    try {
      await db.batch([
        db
          .prepare(
            `UPDATE users SET ${sets.join(", ")} WHERE id = ${idPlaceholder} AND deleted_at IS NULL`,
          )
          .bind(...values),
        auditLogStatement(db, {
          userId: actor.id,
          action: "admin_user_edited",
          resourceType: "user",
          resourceId: String(target.id),
          details: JSON.stringify({
            changed_by: actor.username,
            target_username: target.username,
            changed,
            email_verified_reset: emailReset,
          }),
        }),
      ]);
    } catch (error) {
      // Column-scoped (services/identity.ts): a UNIQUE hit on any OTHER column
      // must not be reported to an admin as "that address is taken".
      if (isUniqueViolationOn(error, "email")) {
        return c.json(
          {
            error: "email_in_use",
            message: "That email address already belongs to another account",
          },
          409,
        );
      }
      if (isUniqueViolationOn(error, "username")) {
        return c.json(
          { error: "username_taken", message: "That username already belongs to another account" },
          409,
        );
      }
      if (isUniqueViolationOn(error, "github_username")) {
        return c.json(
          {
            error: "github_in_use",
            message: "That GitHub handle already belongs to another account",
          },
          409,
        );
      }
      throw error;
    }

    const user = await loadUserDetail(db, id, false);
    const label = target.username ?? target.email;
    return c.json({
      message: `Updated ${label}: ${changedFields.join(", ")}`,
      changed,
      notes: notes.length > 0 ? notes : undefined,
      user,
    });
  });
}

/** The refusal for a value another live account already holds. Names the
 *  holder: this is an admin route, and "who has it" is what resolves it. */
function heldBy(
  code: "username_taken" | "email_in_use" | "github_in_use",
  what: string,
  holder: { id: number; username: string | null },
): { error: string; message: string; holder: { id: number; username: string | null } } {
  const who = holder.username ? `${holder.username} (id ${holder.id})` : `id ${holder.id}`;
  return {
    error: code,
    message: `That ${what} already belongs to account ${who}. One person has one account (ADR 0043); change or remove it there first.`,
    holder,
  };
}
