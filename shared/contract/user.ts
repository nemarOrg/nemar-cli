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
