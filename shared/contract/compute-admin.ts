/**
 * The owner and admin routes of the compute gateway's allocation ledger and policy (epic #2005
 * phase A2, #2007; ADR 0118): their error words, request shapes and the RESPONSES the command-line
 * interface (CLI) parses.
 *
 * Every response schema here is open. A released CLI must keep working when the Worker adds a key,
 * so each object accepts and keeps one it does not know, at the top level and nested, and a word
 * the Worker may grow (a holder kind, a ledger kind) is a string here and not an enum. The strict
 * schema of the owner policy (`ComputePolicySchema` in `./compute.ts`) checks what the owner SENDS
 * and what the Worker WRITES; no response is parsed with it, and this file never imports it (a test
 * keeps every file under shared/contract but `compute.ts` and `compute-launch.ts` from doing so).
 *
 * Money is whole thousandths of a service unit (SU) throughout: `*_milli` is an integer, `12.5`
 * SU is 12500 (`parseSuToMilli` and `formatSu` in `./compute.ts`).
 */

import { z } from "zod";
import type { ComputePool } from "./compute.js";

// --- Words -----------------------------------------------------------------------------------

/** Whose pool it is: a person, one of NEMAR's two platform budgets, or a partner client. */
export const COMPUTE_POOL_HOLDER_KINDS = ["account", "platform", "partner"] as const;

export type ComputePoolHolderKind = (typeof COMPUTE_POOL_HOLDER_KINDS)[number];

/** NEMAR's own pipelines' share of the platform budget, and the one nobody else's spend is counted against. */
export const COMPUTE_PIPELINES_BUDGET = "pipelines" as const;

/** Everyone else's share: the budget every account's and partner's spend is counted against. */
export const COMPUTE_PEOPLE_BUDGET = "people" as const;

/** NEMAR's own two budgets. The migration seeds each of them, for cpu and for gpu. */
export const COMPUTE_PLATFORM_KEYS = [COMPUTE_PIPELINES_BUDGET, COMPUTE_PEOPLE_BUDGET] as const;

export type ComputePlatformKey = (typeof COMPUTE_PLATFORM_KEYS)[number];

/** Whether a word is the key of one of the platform's budgets. */
export function isComputePlatformKey(word: string): word is ComputePlatformKey {
  return (COMPUTE_PLATFORM_KEYS as readonly string[]).includes(word);
}

/**
 * The most SU one request may grant or move, in milli-SU: 2^40, about a billion SU, far above any
 * grant and far below the 2^53 - 1 that a stored total may not pass (a total that would pass it is
 * refused too, as `would_exceed_limit`).
 */
export const COMPUTE_REQUEST_MILLI_MAX = 2 ** 40;

/** Which total an admin's adjustment corrects. */
export const COMPUTE_ADJUST_TARGETS = ["granted", "charged"] as const;

export type ComputeAdjustTarget = (typeof COMPUTE_ADJUST_TARGETS)[number];

/** The most pools a listing answers with at once. */
export const COMPUTE_POOLS_PAGE_MAX = 200;

/**
 * The `Idempotency-Key` header a grant or an adjustment must carry: 8 to 100 letters, digits and
 * `. _ -` (a UUID fits). The ledger stores it behind a prefix of its own, so a key an admin sends
 * can never be the key of an entry the Worker writes for a job.
 */
export const COMPUTE_IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._-]{8,100}$/;

/** The words an administrator's route answers with, in `{ error: <sentence>, code: <word> }`. */
export const COMPUTE_ADMIN_ERROR_CODES = [
  "invalid_body",
  "invalid_query",
  "idempotency_key_required",
  "idempotency_key_invalid",
  "idempotency_conflict",
  "owner_only",
  "account_not_found",
  "pool_not_found",
  "would_go_negative",
  "would_exceed_limit",
  "policy_unreadable",
  "internal",
] as const;

export type ComputeAdminErrorCode = (typeof COMPUTE_ADMIN_ERROR_CODES)[number];

/** The HTTP status of each word, declared once so no route picks its own. */
export const COMPUTE_ADMIN_ERROR_STATUS = {
  invalid_body: 400,
  invalid_query: 400,
  idempotency_key_required: 400,
  idempotency_key_invalid: 400,
  idempotency_conflict: 409,
  owner_only: 403,
  account_not_found: 404,
  pool_not_found: 404,
  would_go_negative: 409,
  would_exceed_limit: 409,
  policy_unreadable: 503,
  internal: 500,
} as const satisfies Record<ComputeAdminErrorCode, number>;

// --- Requests (plain types: the Worker validates them, the CLI builds them) -------------------

/** `PUT /admin/compute/policy`: the whole policy (the strict schema decides) and an optional note. */
export interface ComputePolicyPutRequest {
  policy: unknown;
  note?: string;
}

/** `POST /admin/compute/pools/.../grant`: SU into one pool. The reason is a fixed word. */
export interface ComputePoolGrantRequest {
  pool: ComputePool;
  amount_milli: number;
  reason?: string;
}

/** `POST /admin/compute/pools/.../adjust`: a correction of the grant or of the charge, either way. */
export interface ComputePoolAdjustRequest {
  pool: ComputePool;
  target: ComputeAdjustTarget;
  /** Never 0; negative takes away. */
  delta_milli: number;
  reason: string;
}

// --- Responses (open) ------------------------------------------------------------------------

const milli = z.number().int();

/** A pool as the Worker reports it; `available_milli` is granted - held - charged and may be negative. */
export const ComputePoolViewSchema = z
  .object({
    id: z.number().int(),
    holder_kind: z.string(),
    holder_ref: z.string(),
    pool: z.string(),
    granted_milli: milli,
    held_milli: milli,
    charged_milli: milli,
    available_milli: milli,
    frozen: z.boolean(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .passthrough();

export type ComputePoolView = z.infer<typeof ComputePoolViewSchema>;

/** One ledger entry. */
export const ComputeLedgerEntryViewSchema = z
  .object({
    id: z.number().int(),
    kind: z.string(),
    pool_id: z.number().int(),
    budget_pool_id: z.number().int().nullable(),
    granted_delta_milli: milli,
    held_delta_milli: milli,
    charged_delta_milli: milli,
    job_id: z.string().nullable(),
    hold_ref: z.number().int().nullable(),
    reason: z.string().nullable(),
    actor_user_id: z.number().int().nullable(),
    created_at: z.string(),
  })
  .passthrough();

export type ComputeLedgerEntryView = z.infer<typeof ComputeLedgerEntryViewSchema>;

/** `GET /admin/compute/pools`: a keyset page, newest last; `next_after` continues it. */
export const ComputePoolsResponseSchema = z
  .object({
    pools: z.array(ComputePoolViewSchema),
    next_after: z.number().int().nullable(),
  })
  .passthrough();

export type ComputePoolsResponse = z.infer<typeof ComputePoolsResponseSchema>;

/** `GET /admin/compute/pools/by-id/:accountId`: the account's pools; none yet is an empty list. */
export const ComputeAccountPoolsResponseSchema = z
  .object({
    account_id: z.number().int(),
    pools: z.array(ComputePoolViewSchema),
  })
  .passthrough();

export type ComputeAccountPoolsResponse = z.infer<typeof ComputeAccountPoolsResponseSchema>;

/** A grant or an adjustment: the pool afterwards, the entry, and whether the key had been used. */
export const ComputePoolWriteResponseSchema = z
  .object({
    pool: ComputePoolViewSchema,
    entry: ComputeLedgerEntryViewSchema,
    replayed: z.boolean(),
  })
  .passthrough();

export type ComputePoolWriteResponse = z.infer<typeof ComputePoolWriteResponseSchema>;

/**
 * `GET` and `PUT /admin/compute/policy`. `version` is null and `is_default` true while no version
 * has been set (the policy in force is then the default); `policy` is the policy as an open object,
 * so a key the Worker adds later still reaches the CLI.
 */
export const ComputePolicyResponseSchema = z
  .object({
    version: z.number().int().nullable(),
    is_default: z.boolean(),
    policy: z.object({}).passthrough(),
    set_by: z.number().int().nullable(),
    note: z.string().nullable(),
    created_at: z.string().nullable(),
  })
  .passthrough();

export type ComputePolicyResponse = z.infer<typeof ComputePolicyResponseSchema>;
