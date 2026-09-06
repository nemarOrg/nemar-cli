/**
 * User wire-shape contract (epic #896, #898).
 *
 * GET /users/me returns a NESTED envelope `{ user, token }`, not a flat user.
 * The CLI's getCurrentUser() declared it as a flat UserInfo and read fields off
 * the top level (all undefined at runtime) — the #899 drift fix unwraps `.user`;
 * this schema is the shape it validates against.
 *
 * Zero deps beyond zod (extraction-ready for @nemar/contract).
 */

import { z } from "zod";

/** A NEMAR user as returned inside the /users/me envelope. */
export const userSchema = z
  .object({
    id: z.number().int(),
    username: z.string().nullable(),
    email: z.string(),
    github_username: z.string().nullable(),
    role: z.string(),
    orcid: z.string().nullable().optional(),
    created_at: z.string().optional(),
    approved_at: z.string().nullable().optional(),
    dataset_count: z.number().int().optional(),
    sandbox_completed: z.boolean().optional(),
    sandbox_completed_at: z.string().nullable().optional(),
    sandbox_dataset_id: z.string().nullable().optional(),
    /**
     * Upload access: the one-time admin approval (ADR 0040). Optional because
     * an older backend does not send it; `undefined` is "unknown", not "no".
     */
    service_access: z.boolean().optional(),
  })
  .passthrough();
export type ContractUser = z.infer<typeof userSchema>;

/** The API-token summary block of the /users/me envelope (null when no token). */
export const tokenInfoSchema = z
  .object({
    prefix: z.string(),
    created_at: z.string(),
    last_used_at: z.string().nullable(),
  })
  .passthrough()
  .nullable();

/** GET /users/me — the nested envelope. `getCurrentUser()` must read `.user`. */
export const userMeResponseSchema = z
  .object({
    user: userSchema,
    token: tokenInfoSchema.optional(),
  })
  .passthrough();
export type UserMeResponse = z.infer<typeof userMeResponseSchema>;

/**
 * One row of GET /admin/users (ADR 0040, #1251).
 *
 * Every field a web/ORCID account can legitimately lack is `.nullable()` here
 * rather than assumed present — `username` and `github_username` are NULL by
 * design on those rows (#1012), and reading them as strings is what put the
 * literal "null" in the admin listing.
 *
 * `service_access` is `.optional()` on purpose and MUST NOT be given a default:
 * a CLI talking to a backend deployed before #1251 (or mid-rollout) receives no
 * such key, and coercing that absence to 0 would report an uploader as
 * browse-only. Absent means unknown; the caller renders a third state.
 */
export const adminUserListItemSchema = z
  .object({
    id: z.number().int(),
    username: z.string().nullable(),
    email: z.string(),
    github_username: z.string().nullable(),
    status: z.string(),
    email_verified: z.number().int().nullable().optional(),
    role: z.string().nullable(),
    created_at: z.string(),
    approved_at: z.string().nullable().optional(),
    revoked_at: z.string().nullable().optional(),
    signup_source: z.string().nullable().optional(),
    service_access: z.number().int().nullable().optional(),
    service_access_granted_at: z.string().nullable().optional(),
    given_name: z.string().nullable().optional(),
    family_name: z.string().nullable().optional(),
    orcid: z.string().nullable().optional(),
    /**
     * When this account asked for upload access (ADR 0042, #1253). `.optional()`
     * for the same reason `service_access` is: a backend deployed before #1253
     * omits the key, and absence means "this API cannot say", not "never asked".
     * An OPEN request is this being set while `service_access` is 0 — once an
     * admin approves, the stamp stays as the record of when they asked.
     */
    upload_access_requested_at: z.string().nullable().optional(),
  })
  .passthrough();
export type AdminUserListItem = z.infer<typeof adminUserListItemSchema>;

/** GET /admin/users — the listing envelope. */
export const adminUsersListResponseSchema = z
  .object({
    users: z.array(adminUserListItemSchema),
    count: z.number().int(),
  })
  .passthrough();
export type AdminUsersListResponse = z.infer<typeof adminUsersListResponseSchema>;

/**
 * Per-user outcome of `POST /admin/users/backfill-usernames` (ADR 0042, #1253).
 *
 * The five terminal values are kept apart because each one asks a different
 * thing of the operator, exactly as `backfillNameOutcomeSchema` splits
 * `no_public_name` from `lookup_failed`:
 *
 *   assigned / would_assign  the sweep can finish this row on its own.
 *   single_name              a given name and no family name. NOT guessed at:
 *                            deriving a handle from the email local part
 *                            invents an identity the person never chose
 *                            (ADR 0042), so these are listed for a human.
 *   no_name                  neither part, and no ORCID record to read one
 *                            from. Run `nemar admin backfill-names` first.
 *   lookup_failed            transient: the ORCID read failed. Retry the batch.
 *   conflict                 the suggested username was claimed between the
 *                            scan and the write. Retry picks the next suffix.
 */
export const backfillUsernameOutcomeSchema = z.enum([
  "assigned",
  "would_assign",
  "single_name",
  "no_name",
  "lookup_failed",
  "conflict",
]);
export type BackfillUsernameOutcome = z.infer<typeof backfillUsernameOutcomeSchema>;

/**
 * What happened to the one verify-your-email message an `--apply` run sends to
 * a row it just gave a username to (ADR 0042, #1253).
 *
 * `skipped_fence` is not a failure: outside production `issueEmailVerificationCode`
 * refuses any address that is not a synthetic test target and writes nothing at
 * all (AGENTS.md — the dev D1 holds ~609 real addresses behind a live Resend
 * key). Reporting it as `failed` would send an operator hunting a bug in the
 * one behaviour that is protecting real people.
 */
export const backfillVerifyOutcomeSchema = z.enum([
  "sent",
  "already_verified",
  "skipped_fence",
  "rate_limited",
  "failed",
  "not_attempted",
]);
export type BackfillVerifyOutcome = z.infer<typeof backfillVerifyOutcomeSchema>;

/**
 * `GET /auth/profile/username-suggestion` (ADR 0042, #1253).
 *
 * `suggestion` is null exactly when `based_on` is "unavailable": the account
 * has no family name to build one from, or the name folds to nothing usable in
 * ASCII. The two fields are reported separately so the website can tell "here
 * is a default, edit it if you like" from "type one yourself" without
 * inspecting a null.
 */
export const usernameSuggestionResponseSchema = z
  .object({
    suggestion: z.string().nullable(),
    based_on: z.enum(["name", "unavailable"]),
  })
  .passthrough();
export type UsernameSuggestionResponse = z.infer<typeof usernameSuggestionResponseSchema>;
