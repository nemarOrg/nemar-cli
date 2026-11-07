/**
 * The wire contract of compute access (epic #2021 phase D1, #2022; ADR 0118, the compute-access
 * addendum): the person's request, the administrator's decisions, and the words both answer with.
 *
 * Two audiences, two shapes, as upload access has them (ADR 0042):
 *
 *  - The PERSON's route, `POST /users/me/compute-access/request`, answers a refusal as
 *    `{ error: <code>, message, missing }`, which the website renders as highlighted fields and the
 *    command-line interface (CLI) prints with where to fix each one. The codes are
 *    {@link COMPUTE_ACCESS_ERROR_CODES}; `error` carries the code and `message` the sentence, so the
 *    CLI's client prefers `message` for them.
 *  - The ADMINISTRATOR's routes, `/admin/compute/access/...`, answer as the compute admin routes do,
 *    `{ error: <sentence>, code: <word> }`, with the words of {@link COMPUTE_ACCESS_ADMIN_ERROR_CODES}.
 *
 * Every RESPONSE schema is open (`.passthrough()`), so a released CLI keeps working when the Worker
 * adds a key; the request body of the person is the one closed shape, and the Worker validates it.
 * A field a new Worker adds to an account is optional here and never defaulted: absent means this
 * Worker cannot say, never "no".
 *
 * Money is whole thousandths of a service unit (SU), as everywhere in the compute contract.
 */

import { z } from "zod";
// --- The person's request ----------------------------------------------------------------------

/** The bounds of the purpose text, in characters (code points). The migration's CHECK says the same. */
export const COMPUTE_PURPOSE_MIN_CHARS = 20;
export const COMPUTE_PURPOSE_MAX_CHARS = 1000;

/**
 * `POST /users/me/compute-access/request`. Bounds only at the door (the real rule, with the typed
 * refusals, is `checkComputeAccessRequest` in the Worker): `purpose` is what the person intends to
 * compute, and `accept_terms_version` is the terms version they accepted, which must be the current
 * one (`COMPUTE_TERMS_VERSION`).
 */
export const computeAccessRequestSchema = z.object({
  purpose: z
    .string()
    .max(COMPUTE_PURPOSE_MAX_CHARS * 4)
    .optional()
    .default(""),
  accept_terms_version: z.string().max(64).optional().default(""),
});
export type ComputeAccessRequestBody = z.input<typeof computeAccessRequestSchema>;

/**
 * Why a request was refused, in the order the Worker checks them (the first four are the person's
 * own words and account, the rest the profile):
 *
 *   terms_unpublished   503; the terms are not published yet (exact production only). Retry later.
 *   already_active      409; compute access is already held.
 *   access_closed       409; the request was answered (denied or revoked), and a person does not ask again.
 *   purpose_required    400; the purpose is missing or outside 20 to 1000 characters.
 *   terms_not_accepted  400; `accept_terms_version` is not the current terms version.
 *   email_not_verified  400; verify the email address first.
 *   orcid_not_proven    400; the ORCID iD must be proven by a sign-in (`missing: ["orcid_verified"]`).
 *   profile_incomplete  400; a name, affiliation, city or country is missing (`missing` names them).
 */
export const computeAccessErrorCodeSchema = z.enum([
  "purpose_required",
  "terms_not_accepted",
  "email_not_verified",
  "orcid_not_proven",
  "profile_incomplete",
  "access_closed",
  "already_active",
  "terms_unpublished",
]);
export type ComputeAccessErrorCode = z.infer<typeof computeAccessErrorCodeSchema>;

/** The codes as a plain array, for a runtime membership test (the CLI client prefers `message` for them). */
export const COMPUTE_ACCESS_ERROR_CODES: readonly string[] = computeAccessErrorCodeSchema.options;

/** The HTTP status each refusal is answered with. */
export const COMPUTE_ACCESS_ERROR_STATUS = {
  purpose_required: 400,
  terms_not_accepted: 400,
  email_not_verified: 400,
  orcid_not_proven: 400,
  profile_incomplete: 400,
  access_closed: 409,
  already_active: 409,
  terms_unpublished: 503,
} as const satisfies Record<ComputeAccessErrorCode, number>;

/** A refusal body: the code, a sentence, and the account fields still to fix (empty when none). */
export interface ComputeAccessRefusal {
  error: ComputeAccessErrorCode;
  message: string;
  missing: string[];
}

export const computeAccessRequestResponseSchema = z
  .object({
    ok: z.literal(true),
    /** True when a request was already open: nothing new was written. */
    already_requested: z.boolean(),
    requested_at: z.string().nullable().optional(),
    /** Whether at least one administrator received the review card; false means a repeat call re-sends. */
    email_sent: z.boolean().optional(),
    admins_notified: z.number().int().nullable().optional(),
  })
  .passthrough();
export type ComputeAccessRequestResponse = z.infer<typeof computeAccessRequestResponseSchema>;

// --- The administrator's routes ----------------------------------------------------------------

/** The most characters an administrator's reason may have. */
export const COMPUTE_ACCESS_REASON_MAX_CHARS = 500;

/** The most accounts one listing answers with at once. */
export const COMPUTE_ACCESS_PAGE_MAX = 200;

/** `POST /admin/compute/access/{grant|deny|suspend|revoke}/...`: an optional reason. */
export interface ComputeAccessDecisionRequest {
  reason?: string;
}

export const COMPUTE_ACCESS_ADMIN_ERROR_CODES = [
  "invalid_body",
  "invalid_query",
  "account_not_found",
  /** Grant or deny of an account that never asked. */
  "not_requested",
  /** Suspend or revoke of an account that does not hold compute access. */
  "not_active",
  /** Grant of an account that already holds it. */
  "already_active",
  /** Grant to an account that is deleted, revoked or not verified: its standing is not good. */
  "account_not_in_good_standing",
  /** The state changed between the read and the write; read it again. */
  "stale_state",
  "policy_unreadable",
  "internal",
] as const;
export type ComputeAccessAdminErrorCode = (typeof COMPUTE_ACCESS_ADMIN_ERROR_CODES)[number];

export const COMPUTE_ACCESS_ADMIN_ERROR_STATUS = {
  invalid_body: 400,
  invalid_query: 400,
  account_not_found: 404,
  not_requested: 409,
  not_active: 409,
  already_active: 409,
  account_not_in_good_standing: 409,
  stale_state: 409,
  policy_unreadable: 503,
  internal: 500,
} as const satisfies Record<ComputeAccessAdminErrorCode, number>;

/** One account in the administrator's listing, as the Worker reports it. */
export const computeAccessAccountSchema = z
  .object({
    id: z.number().int(),
    username: z.string().nullable(),
    email: z.string(),
    given_name: z.string().nullable().optional(),
    family_name: z.string().nullable().optional(),
    affiliation: z.string().nullable().optional(),
    city: z.string().nullable().optional(),
    country: z.string().nullable().optional(),
    orcid: z.string().nullable().optional(),
    account_kind: z.string().optional(),
    compute_access: z.string(),
    compute_access_requested_at: z.string().nullable().optional(),
    compute_access_granted_at: z.string().nullable().optional(),
    compute_access_granted_by: z.number().int().nullable().optional(),
    compute_purpose: z.string().nullable().optional(),
    compute_terms_version: z.string().nullable().optional(),
    compute_terms_accepted_at: z.string().nullable().optional(),
  })
  .passthrough();
export type ComputeAccessAccount = z.infer<typeof computeAccessAccountSchema>;

/** `GET /admin/compute/access`: a page, oldest request first, and where the next one starts. */
export const computeAccessListResponseSchema = z
  .object({
    accounts: z.array(computeAccessAccountSchema),
    next_after: z.number().int().nullable().optional(),
  })
  .passthrough();
export type ComputeAccessListResponse = z.infer<typeof computeAccessListResponseSchema>;

/**
 * What a grant did to the person's allocation. The owner's policy names a default per pool
 * (`defaultGrantMilli`); a grant opens it once for the account, and a second grant (after a
 * suspension, a denial or a revocation) opens nothing more. A policy whose default is zero opens
 * nothing at all, and says so here (`reason: "policy_default_zero"`).
 */
export const computeAccessAllocationSchema = z
  .object({
    /** True when this grant wrote at least one ledger entry. */
    granted: z.boolean(),
    cpu_milli: z.number().int(),
    gpu_milli: z.number().int(),
    /** Why nothing was written, as a fixed word, when `granted` is false. */
    reason: z.string().nullable().optional(),
    /** The policy version the default was read from; null while the default policy applies. */
    policy_version: z.number().int().nullable().optional(),
  })
  .passthrough();
export type ComputeAccessAllocation = z.infer<typeof computeAccessAllocationSchema>;

export const computeAccessDecisionResponseSchema = z
  .object({
    decision: z.string(),
    from: z.string(),
    to: z.string(),
    account: computeAccessAccountSchema,
    /** Only for a grant. */
    allocation: computeAccessAllocationSchema.optional(),
    /** Whether the person's decision mail was delivered; the decision stands either way. */
    email_sent: z.boolean().optional(),
  })
  .passthrough();
export type ComputeAccessDecisionResponse = z.infer<typeof computeAccessDecisionResponseSchema>;
