/**
 * Admin account lookup and edit: wire contract (ADR 0093).
 *
 * Three surfaces share this file: `GET /admin/users?q=` (search, whose row shape
 * is `adminUserListItemSchema` in ./user.ts), `GET /admin/users/by-id/:id` (one
 * account's details) and `PATCH /admin/users/by-id/:id` (edit). The backend
 * route, the CLI client and the CLI renderer all read the field policy and the
 * refusal vocabulary from here, so a field cannot become editable on one side
 * and not the other.
 *
 * Kept out of ./index.ts on purpose, like ./neurobagel-admin.ts: this is an
 * operator surface, not something the website or a third party renders.
 *
 * Zero deps beyond zod (extraction-ready for @nemar/contract).
 */

import { z } from "zod";
import { accountKindSchema } from "./user.js";

/**
 * The fields an ADMIN may edit on someone else's account: how the person is
 * described, with no bearing on who can act as the account.
 */
export const ADMIN_USER_DESCRIPTIVE_FIELDS = [
  "given_name",
  "family_name",
  "affiliation",
  "city",
  "country",
] as const;

/**
 * The fields only an OWNER may edit: the three that decide who can act as the
 * account (the username keys approval, the email receives sign-in codes, the
 * GitHub handle receives repository access). Owner-only for the same reason
 * `role`, `kind` and key minting are (ADR 0048): a role-`admin` credential
 * should not be enough to take over another account, an owner's included.
 */
export const ADMIN_USER_IDENTITY_FIELDS = ["username", "github_username", "email"] as const;

export const ADMIN_USER_EDITABLE_FIELDS = [
  ...ADMIN_USER_DESCRIPTIVE_FIELDS,
  ...ADMIN_USER_IDENTITY_FIELDS,
] as const;
export type AdminUserEditableField = (typeof ADMIN_USER_EDITABLE_FIELDS)[number];

export function isAdminUserEditableField(value: string): value is AdminUserEditableField {
  return (ADMIN_USER_EDITABLE_FIELDS as readonly string[]).includes(value);
}

export function isAdminUserIdentityField(value: string): boolean {
  return (ADMIN_USER_IDENTITY_FIELDS as readonly string[]).includes(value);
}

/**
 * The two name fields. Once an account holds a VERIFIED ORCID iD, ORCID is the
 * authority on them: the record is re-read on every sign-in and would silently
 * overwrite an edit, which is worse than refusing it (ADR 0041,
 * `name_is_orcid_canonical`).
 */
export const ADMIN_USER_NAME_FIELDS = ["given_name", "family_name"] as const;

/**
 * The body of `PATCH /admin/users/by-id/:id`. Every field is optional (true
 * PATCH semantics); an empty string clears the two nullable ones
 * (`affiliation`, `github_username`), exactly as the self-service form does.
 *
 * Deliberately not a strict schema (test/contract-schemas.test.ts forbids them
 * for old-CLI compatibility, and scans for the call by its text, so this comment
 * does not spell it): the route reads the raw keys itself so that a key it does
 * not edit gets a sentence saying where that change IS made, which zod's
 * `unrecognized_keys` message cannot say.
 */
export const adminUserEditBodySchema = z.object({
  given_name: z.string().max(200).optional(),
  family_name: z.string().max(200).optional(),
  affiliation: z.string().max(500).optional(),
  city: z.string().max(200).optional(),
  country: z.string().max(200).optional(),
  username: z.string().max(100).optional(),
  github_username: z.string().max(100).optional(),
  email: z.string().max(320).optional(),
});
export type AdminUserEditBody = z.infer<typeof adminUserEditBodySchema>;

/**
 * Where each change a caller might reach for here is ACTUALLY made. A key not
 * in this table is answered with the generic sentence; one that is gets the
 * real route, because "not editable" with no next step sends an admin to the
 * database.
 */
export const ADMIN_USER_NOT_EDITABLE_HINTS: Readonly<Record<string, string>> = {
  orcid:
    "an ORCID iD is proven by signing in with ORCID and is never typed in; the person links it in Settings (ADR 0043)",
  orcid_verified:
    "the verified flag is set only by the ORCID sign-in flow; the person links or unlinks the iD in Settings",
  role: "use 'nemar admin role <username> <role>' (owner only)",
  status: "use 'nemar admin approve' or 'nemar admin revoke'",
  service_access: "upload access is granted only by 'nemar admin approve' (ADR 0040)",
  account_kind: "use 'nemar admin kind <username> <kind>' (owner only)",
  identity_conflict: "use 'nemar admin duplicates --clear <id>'",
  email_verified:
    "set when the person proves their inbox; changing the email address resets it for you",
  description: "that is the person's own statement, and an admin does not rewrite it",
  id: "an account's id never changes",
};

/**
 * Why an admin lookup or edit was refused.
 *
 * `error` carries one of these and `message` the sentence, the same shape the
 * kind route and the self-service profile routes use, so the CLI prints
 * `message`. The identity-uniqueness refusals (`username_taken`, `email_in_use`,
 * `github_in_use`) and the format refusals (`username_too_short`, ...) are NOT
 * repeated here: they are declared in ./user.ts and ./identity.ts and the CLI
 * already treats both sets as codes.
 *
 *   field_not_editable  a key outside the editable set; `message` says where
 *                       that change is made instead.
 *   owner_only_field    an admin (not an owner) sent username, email or a
 *                       GitHub handle. 403.
 *   edit_own_account    an owner tried to edit their OWN username, email or
 *                       GitHub handle here, which would skip the proof the
 *                       self-service path asks for. 400.
 *   invalid_edit        a value the route cannot read at all (not a string, not
 *                       an address). 400.
 *   invalid_search      `?q=` was empty, too long or had too many words. 400.
 *   invalid_user_id     the `:id` in the path is not a positive integer. 400.
 */
export const adminUserErrorCodeSchema = z.enum([
  "field_not_editable",
  "owner_only_field",
  "edit_own_account",
  "invalid_edit",
  "invalid_search",
  "invalid_user_id",
]);
export type AdminUserErrorCode = z.infer<typeof adminUserErrorCodeSchema>;

/** The refusal codes as a plain array, for `lib/api/client.ts`'s membership
 *  test that decides whether a body leads with `message`. */
export const ADMIN_USER_ERROR_CODES: readonly string[] = adminUserErrorCodeSchema.options;

export const ADMIN_USER_ERROR_MESSAGES = {
  owner_only_field:
    "Changing a username, email address or GitHub handle decides who can act as the account, so only an owner can do it. Ask an owner, or have the person change it in Settings.",
  edit_own_account:
    "You cannot change your own username, email address or GitHub handle here, because that skips the proof the self-service path asks for. Use 'nemar auth profile' instead.",
} as const satisfies Partial<Record<AdminUserErrorCode, string>>;

/** Bounds on a search, declared once so the CLI can refuse before the request
 *  and the route refuses the same inputs. */
export const ADMIN_USER_SEARCH_MAX_TERMS = 8;
export const ADMIN_USER_SEARCH_MAX_TERM_CHARS = 100;

/**
 * One account's details, as `GET /admin/users/by-id/:id` and the edit response
 * return them: every column of `users` EXCEPT the secrets and the notification
 * blob (the backend's `USER_COLUMN_ROLES` is the single classification), plus
 * three computed values.
 *
 * Only what the database guarantees is required; the rest is
 * `.nullable().optional()` and `.passthrough()` is on so a column added to the
 * route reaches an older CLI without a parse failure.
 */
export const adminUserDetailSchema = z
  .object({
    id: z.number().int(),
    username: z.string().nullable(),
    email: z.string(),
    github_username: z.string().nullable(),
    status: z.string(),
    role: z.string().nullable(),
    account_kind: accountKindSchema.optional(),
    email_verified: z.number().int().nullable().optional(),
    orcid: z.string().nullable().optional(),
    orcid_verified: z.number().int().nullable().optional(),
    given_name: z.string().nullable().optional(),
    family_name: z.string().nullable().optional(),
    affiliation: z.string().nullable().optional(),
    city: z.string().nullable().optional(),
    country: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
    signup_source: z.string().nullable().optional(),
    created_at: z.string(),
    updated_at: z.string().nullable().optional(),
    approved_at: z.string().nullable().optional(),
    revoked_at: z.string().nullable().optional(),
    deleted_at: z.string().nullable().optional(),
    service_access: z.number().int().nullable().optional(),
    service_access_granted_at: z.string().nullable().optional(),
    service_access_granted_by: z.number().int().nullable().optional(),
    upload_access_requested_at: z.string().nullable().optional(),
    upload_access_notified_at: z.string().nullable().optional(),
    identity_conflict: z.number().int().nullable().optional(),
    username_auto_assigned: z.number().int().nullable().optional(),
    sandbox_completed: z.number().int().nullable().optional(),
    sandbox_completed_at: z.string().nullable().optional(),
    sandbox_dataset_id: z.string().nullable().optional(),
    aws_iam_username: z.string().nullable().optional(),
    /** Datasets this account owns. */
    dataset_count: z.number().int().optional(),
    /** Live (unrevoked) API keys. A count only, never the keys. */
    active_tokens: z.number().int().optional(),
    /** Sign-in providers linked to the account (`orcid`, `github`, ...). */
    linked_identities: z.array(z.string()).optional(),
  })
  .passthrough();
export type AdminUserDetail = z.infer<typeof adminUserDetailSchema>;

/** `GET /admin/users/by-id/:id`. */
export const adminUserShowResponseSchema = z.object({ user: adminUserDetailSchema }).passthrough();
export type AdminUserShowResponse = z.infer<typeof adminUserShowResponseSchema>;

/** One field's before and after. `null` is "no value", for both sides. */
export const adminUserFieldChangeSchema = z.object({
  from: z.string().nullable(),
  to: z.string().nullable(),
});
export type AdminUserFieldChange = z.infer<typeof adminUserFieldChangeSchema>;

/**
 * `PATCH /admin/users/by-id/:id`. `changed` holds ONLY the fields that differ
 * from what the account held; re-sending a current value is not a change, and
 * a request that changes nothing answers 200 with `changed: {}` and writes no
 * audit row. `notes` are side effects and caveats the editor should read.
 */
export const adminUserEditResponseSchema = z
  .object({
    message: z.string(),
    changed: z.record(z.string(), adminUserFieldChangeSchema),
    notes: z.array(z.string()).optional(),
    user: adminUserDetailSchema,
  })
  .passthrough();
export type AdminUserEditResponse = z.infer<typeof adminUserEditResponseSchema>;
