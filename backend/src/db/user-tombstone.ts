// Shared SQL for the user tombstone (soft delete), so the DELETE
// /admin/users/by-id/:id endpoint and its behavioral test exercise the EXACT
// same masking statement (no drift between the security logic and its test).
//
// The mask is the load-bearing mechanism for two guarantees:
//   1. PII erasure — email is replaced with a non-PII placeholder; username,
//      github, password, orcid, description, AWS creds, verification tokens and
//      email prefs are nulled; email_verified is zeroed.
//   2. Re-signup freedom — nulling username/github and rewriting email FREES
//      those UNIQUE values so the original owner can sign up again later. (The
//      signup de-dup checks intentionally still see tombstoned rows.)

/**
 * Masked email for a tombstoned user. Embeds the AUTOINCREMENT primary key,
 * which is globally unique and never reused, so two tombstones can never collide
 * on the `email` UNIQUE constraint. `.invalid` (RFC 6761) is un-routable, so the
 * address can never be real or receive mail.
 */
export function maskedDeletedEmail(id: number): string {
  return `deleted+${id}@deleted.invalid`;
}

/**
 * Single-statement PII mask + tombstone. Bind order: [maskedEmail, id].
 * `AND deleted_at IS NULL` makes it idempotent (a re-delete matches 0 rows).
 * Sets status='revoked' so existing status-pinned queries also treat the row as
 * dead, and stamps `deleted_at` (the canonical soft-delete discriminator every
 * auth/list query filters on).
 */
export const USER_TOMBSTONE_MASK_SQL = `UPDATE users
   SET email = ?,
       username = NULL,
       github_username = NULL,
       password_hash = NULL,
       orcid = NULL,
       description = NULL,
       email_preferences = NULL,
       email_verified = 0,
       verification_token = NULL,
       verification_expires_at = NULL,
       aws_iam_username = NULL,
       aws_access_key_id_encrypted = NULL,
       aws_secret_access_key_encrypted = NULL,
       status = 'revoked',
       revoked_at = COALESCE(revoked_at, datetime('now')),
       deleted_at = datetime('now'),
       updated_at = datetime('now')
   WHERE id = ? AND deleted_at IS NULL`;
