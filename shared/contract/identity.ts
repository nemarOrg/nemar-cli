/**
 * Identity-uniqueness wire vocabulary (#1254, epic #1250; ADR 0043).
 *
 * One person, one account: an ORCID iD, an email address (case-insensitively)
 * or a GitHub handle may back at most one live NEMAR account. When a sign-up,
 * an ORCID link, or an email change would break that, the route refuses with
 * one of the codes below rather than creating the second account.
 *
 * These are RENDERED, not just logged: the website's Settings and sign-up
 * screens switch on the code to decide what to show, so the set is declared
 * once here and consumed as a type by both halves -- the same pattern as
 * `publicationBlockReasonSchema` in publication.ts.
 *
 * Zero deps beyond zod (extraction-ready for @nemar/contract).
 */

import { z } from "zod";

/**
 * Why an identity write was refused.
 *
 * - `orcid_in_use` -- the iD is already on a live account through
 *   `users.orcid`. This is the case nothing checked before #1254, and it is
 *   how production rows 42/43 came to exist.
 * - `orcid_already_linked` -- the iD already has an `oauth_identities` row.
 *   Kept distinct from `orcid_in_use` because it is the pre-existing code the
 *   ORCID finalize route has always returned and the website already handles
 *   it; the two mean the same thing to a user and carry the same message.
 * - `orcid_linked_other` -- (redirect flows only) the finished iD backs a
 *   DIFFERENT account than the session's. Pre-existing.
 * - `email_in_use` -- the address is on a live account, compared
 *   case-insensitively. Pre-existing code, newly also covering case variants.
 * - `github_in_use` -- the handle is on a live account, case-insensitively.
 * - `identity_conflict_remains` -- an admin tried to clear a row's
 *   `identity_conflict` flag while the collision that earned it is still
 *   there. The response names the rows that still collide.
 */
export const identityConflictCodeSchema = z.enum([
  "orcid_in_use",
  "orcid_already_linked",
  "orcid_linked_other",
  "email_in_use",
  "github_in_use",
  "identity_conflict_remains",
]);
export type IdentityConflictCode = z.infer<typeof identityConflictCodeSchema>;

/** Where a person changes each identifier once they are signed in. */
export const IDENTITY_SETTINGS_URL = "https://nemar.org/settings";

/**
 * The "what to do about it" half of every identity refusal.
 *
 * Each one names the self-service fix on the account that ALREADY exists,
 * because that is the only fix that does not need an admin: sign in to it and
 * change the email, change the GitHub username, or unlink/re-link the ORCID
 * iD. Merging two accounts is manual and is deliberately not offered here as
 * if it were a button.
 *
 * In the CONTRACT rather than in the backend because three clients render
 * them: the website (from `code`), the CLI (which shows the sentence directly,
 * since a code means nothing in a terminal), and the backend's own JSON
 * `message`. One wording, three surfaces.
 */
export const IDENTITY_CONFLICT_MESSAGES: Record<IdentityConflictCode, string> = {
  orcid_in_use: `That ORCID iD already belongs to a NEMAR account. Sign in to that account instead; if you want the iD on a different account, unlink it there first (Settings, ${IDENTITY_SETTINGS_URL}).`,
  orcid_already_linked: `That ORCID iD already belongs to a NEMAR account. Sign in to that account instead; if you want the iD on a different account, unlink it there first (Settings, ${IDENTITY_SETTINGS_URL}).`,
  orcid_linked_other: `That ORCID iD is linked to a different NEMAR account. Unlink it there first (Settings, ${IDENTITY_SETTINGS_URL}), then link it here.`,
  email_in_use: `That email address already belongs to a NEMAR account. Sign in to that account instead, or change its address first (Settings, ${IDENTITY_SETTINGS_URL}).`,
  github_in_use: `That GitHub account is already linked to a NEMAR account. Sign in to that account instead, or change its GitHub username first (Settings, ${IDENTITY_SETTINGS_URL}).`,
  identity_conflict_remains:
    "The collision that flagged this account is still there. Resolve it on the other account first (change its email or GitHub username, or unlink its ORCID iD), or delete that account, then clear the flag.",
};

/** Which identifier a duplicate group is keyed on. */
export const identityKindSchema = z.enum(["orcid", "email", "github"]);
export type IdentityKind = z.infer<typeof identityKindSchema>;

/** One live account inside a duplicate group (`GET /admin/users/duplicates`). */
export const duplicateAccountSchema = z
  .object({
    id: z.number().int(),
    username: z.string().nullable(),
    email: z.string(),
    created_at: z.string(),
    /** Whether this row holds the `oauth_identities` row for its ORCID iD --
     *  the thing that decides which row is canonical in an ORCID group. */
    has_oauth_identity: z.boolean(),
    dataset_count: z.number().int(),
    /** The 0077 flag: 1 means this row has already lost its claim on at least
     *  one identifier and is invisible to the partial unique indexes. */
    identity_conflict: z.number().int(),
    /** True for the one row in THIS group that keeps the identifier. */
    canonical: z.boolean(),
  })
  .passthrough();
export type DuplicateAccount = z.infer<typeof duplicateAccountSchema>;

/** A set of live accounts sharing one normalised identifier. */
export const duplicateGroupSchema = z
  .object({
    kind: identityKindSchema,
    /** The shared value, normalised (email lowercased, GitHub handle
     *  lowercased, ORCID as stored). Never a secret. */
    value: z.string(),
    canonical_user_id: z.number().int(),
    accounts: z.array(duplicateAccountSchema),
  })
  .passthrough();
export type DuplicateGroup = z.infer<typeof duplicateGroupSchema>;

/** `GET /admin/users/duplicates`. */
export const duplicateReportSchema = z
  .object({
    groups: z.array(duplicateGroupSchema),
    group_count: z.number().int(),
    /** Live rows carrying `identity_conflict = 1`. This can exceed the number
     *  of non-canonical rows in `groups` only if a flag outlived its
     *  collision, which is exactly what the clear endpoint is for. */
    flagged_count: z.number().int(),
  })
  .passthrough();
export type DuplicateReport = z.infer<typeof duplicateReportSchema>;

/** `POST /admin/users/:id/clear-identity-conflict` on success. */
export const clearIdentityConflictResponseSchema = z
  .object({
    ok: z.literal(true),
    id: z.number().int(),
    /** False when the row was already clear -- a no-op, not an error. */
    cleared: z.boolean(),
  })
  .passthrough();
export type ClearIdentityConflictResponse = z.infer<typeof clearIdentityConflictResponseSchema>;
