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
