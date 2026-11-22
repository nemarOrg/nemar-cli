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
import type { ComputeAccessDecision } from "../compute-access-state.js";
// --- The person's request ----------------------------------------------------------------------

/** The bounds of the purpose text, in characters (code points). The migration's CHECK says the same. */
export const COMPUTE_PURPOSE_MIN_CHARS = 20;
export const COMPUTE_PURPOSE_MAX_CHARS = 1000;

/**
 * Whether a purpose carries a control character other than newline (10) and tab (9): NUL included, and
 * DEL. SQLite's `length()` stops at the first NUL, so the migration's CHECK would count such a text short
 * and the write would fail; the Worker refuses it first (`purpose_required`) and the CLI says so before
 * sending. One function, so the two cannot disagree.
 */
export function hasPurposeControlChar(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if ((c < 32 && c !== 9 && c !== 10) || c === 127) return true;
  }
  return false;
}

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

/** The most characters (code points) the notice to the person may have, counted after trimming. */
export const COMPUTE_ACCESS_NOTICE_MAX_CHARS = 1000;

/**
 * Whether a decision takes a `notice`, the text the PERSON is sent (the compute terms promise that a
 * suspension or an ending is mailed with the reason and how to ask for a review, nemarOrg/docs#105):
 *
 *   suspend, revoke  required; a decision that takes access away says why.
 *   deny             optional; a declined request may say why, and the mail stands without it.
 *   grant            refused; the grant mail says nothing of the kind, and an administrator who typed
 *                    one would otherwise believe it was sent.
 */
export const COMPUTE_ACCESS_NOTICE_RULE = {
  grant: "refused",
  deny: "optional",
  suspend: "required",
  revoke: "required",
} as const satisfies Record<ComputeAccessDecision, "required" | "optional" | "refused">;

/** Why a notice cannot go with a decision, as a fixed word, or null when it can. */
export type ComputeAccessNoticeProblem =
  | "notice_required"
  | "notice_refused"
  | "notice_too_long"
  | "notice_control_char";

/**
 * The ONE notice rule, read by the Worker's body schema and by the CLI before it sends. `notice` is the
 * value as sent (undefined when absent); a notice of only whitespace counts as absent. Newline and tab
 * are allowed (a notice may run to paragraphs); any other control character is refused, as for a purpose.
 */
export function computeAccessNoticeProblem(
  decision: ComputeAccessDecision,
  notice: string | undefined,
): ComputeAccessNoticeProblem | null {
  const rule = COMPUTE_ACCESS_NOTICE_RULE[decision];
  if (rule === "refused") return notice === undefined ? null : "notice_refused";
  const trimmed = notice?.trim() ?? "";
  if (trimmed === "") return rule === "required" ? "notice_required" : null;
  if ([...trimmed].length > COMPUTE_ACCESS_NOTICE_MAX_CHARS) return "notice_too_long";
  if (hasPurposeControlChar(trimmed)) return "notice_control_char";
  return null;
}

/**
 * `POST /admin/compute/access/{grant|deny|suspend|revoke}/...`. Two texts that never mix:
 *
 *  - `reason` is for the RECORD: free text on the audit row, optional, and never mailed.
 *  - `notice` is for the PERSON: mailed under a fixed heading with how to ask for a review. Whether it is
 *    required, optional or refused is {@link COMPUTE_ACCESS_NOTICE_RULE}.
 */
export interface ComputeAccessDecisionRequest {
  reason?: string;
  notice?: string;
}

/**
 * The fields of a decision body. The outer notice bound keeps a huge body cheap to refuse before the rule
 * trims it; it counts UTF-16 units on the value as sent, so a notice padded with whitespace can trip it
 * while its trimmed text is within the rule. Its message is the rule's own word, so either refusal reads
 * `notice: notice_too_long` (the Worker reports a message that is a {@link ComputeAccessNoticeProblem}
 * word in place of zod's code). Senders trim before sending (the CLI and the website both do).
 */
export const computeAccessDecisionBodyShape = {
  reason: z.string().max(COMPUTE_ACCESS_REASON_MAX_CHARS).optional(),
  notice: z
    .string()
    .max(COMPUTE_ACCESS_NOTICE_MAX_CHARS * 4, {
      message: "notice_too_long" satisfies ComputeAccessNoticeProblem,
    })
    .optional(),
};

/** The fixed words of {@link ComputeAccessNoticeProblem}, for telling one apart from a zod message. */
export const COMPUTE_ACCESS_NOTICE_PROBLEMS: readonly ComputeAccessNoticeProblem[] = [
  "notice_required",
  "notice_refused",
  "notice_too_long",
  "notice_control_char",
];

/**
 * The notice rule as a zod refinement: a notice the rule refuses is an issue at `notice` whose message
 * is the {@link ComputeAccessNoticeProblem} word (the Worker names the field and the word, never the
 * value).
 */
export function computeAccessNoticeRefinement(decision: ComputeAccessDecision) {
  return (body: { notice?: string }, ctx: z.RefinementCtx): void => {
    const problem = computeAccessNoticeProblem(decision, body.notice);
    if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["notice"], message: problem });
  };
}

/**
 * The decision body for one decision, with the notice rule. Open like every schema in this directory
 * (an unknown key is dropped, not refused); the Worker closes the same shape itself, so a misspelled
 * field is a 400 there and never silently ignored.
 */
export function computeAccessDecisionBodySchema(decision: ComputeAccessDecision) {
  return z
    .object(computeAccessDecisionBodyShape)
    .superRefine(computeAccessNoticeRefinement(decision));
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
  /** An administrator granting their OWN compute access (an owner may). */
  "self_decision",
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
  self_decision: 409,
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
    /** When an administrator was told; NULL with an open request means nobody was, and the next call re-sends. */
    compute_access_notified_at: z.string().nullable().optional(),
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
