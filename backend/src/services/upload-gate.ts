/**
 * Service-access upload gate (website ADR 0010, #1013; ADR 0040, #1250).
 *
 * Real (non-sandbox) uploads are gated on `service_access` — the admin-granted
 * permission to consume compute/storage, issued only after export-control review
 * of the person's GitHub + location/affiliation. ADR 0040 made admin approval
 * the single writer of it, so an account at the base tier (`verified`) never
 * holds it and `status='approved'` always does. Sandbox uploads are exempt (they
 * are the capped training playground).
 *
 * The gate reads `service_access`, never `status`, which is what let phase 2
 * widen every authenticated path to `verified` without widening upload.
 *
 * Phase 2 adds the CHANNEL to the create-time gate. Sandbox training is a CLI
 * exercise — `nemar sandbox` drives a real create/upload/finalize cycle
 * against a capped throwaway dataset — and there is no browser equivalent, so
 * requiring it of a web upload would gate the dashboard on a command the
 * dashboard cannot run. A browser upload is therefore gated on the admin
 * grant alone; the CLI keeps both gates.
 *
 * Pure so the decision (and its ordering) is unit-testable without a live
 * backend; every real-upload entry point routes through these helpers so the
 * gate can't be added to one endpoint and forgotten on another.
 */

import type { AccountKind } from "../../../shared/contract/user.js";
import { isReservedFixtureId } from "./datasetId.js";

/**
 * `error` is the stable machine-readable half and must not change — the CLI
 * matches on it. `message` is the human half, and it has now been wrong twice
 * in two different ways. It first pointed at a "request upload access from your
 * account settings" flow that had never been built (website ADR 0010 phase 2,
 * #1249); phase 1 replaced that with the support page and a promise that a
 * request flow was coming. Phase 3 (ADR 0042) built it, so the message finally
 * names the two places a person can actually ask, and says what happens next.
 */
export const SERVICE_ACCESS_ERROR = {
  error: "Service access required",
  message:
    "Request upload access from Settings on nemar.org or run `nemar auth request-upload-access`; an admin reviews it once.",
} as const;

export const SANDBOX_TRAINING_ERROR = {
  error: "Sandbox training required",
  message:
    "You must complete sandbox training before uploading real datasets. Run 'nemar sandbox' to complete training.",
} as const;

/**
 * A `test`-kind account on production may own only `xx` sandbox datasets, so
 * a real DOI never attaches to a persona (epic #1272 phase 4, #1284; ADR
 * 0048). `error` matches the stable-machine-readable convention the two
 * bodies above already follow.
 */
export const TEST_ACCOUNT_SANDBOX_ONLY_ERROR = {
  error: "test_account_sandbox_only",
  message:
    "Test accounts can only create sandbox (xx) datasets on production. Use a person account for real data.",
} as const;

export type UploadGateBody =
  | typeof SERVICE_ACCESS_ERROR
  | typeof SANDBOX_TRAINING_ERROR
  | typeof TEST_ACCOUNT_SANDBOX_ONLY_ERROR;

/**
 * Which client is uploading. "cli" is the bearer-token path, "web" the
 * dashboard's `nemar_session` cookie.
 */
export type UploadChannel = "cli" | "web";

/**
 * Derive the channel from the credential that authenticated the request
 * (`c.var.authMethod`, set by authMiddleware) rather than from anything the
 * client sends. A header or body field naming the channel would be a
 * self-declared exemption from sandbox training — "web" would be the one word
 * a CLI user has to type to skip it.
 *
 * An absent authMethod falls to "cli", the stricter of the two: a route that
 * somehow reaches the gate without the middleware having recorded a channel
 * must not be handed the laxer one by default.
 */
export function uploadChannelForAuthMethod(
  authMethod: "token" | "cookie" | undefined,
): UploadChannel {
  return authMethod === "cookie" ? "web" : "cli";
}

/**
 * Create-time gate for a real dataset: refuses a `test`-kind account first
 * (epic #1272 phase 4, #1284; ADR 0048), then requires service access (the
 * authorization gate), then — on the CLI channel only — sandbox training (the
 * how-to gate). Returns the 403 body to send, or null when the upload is
 * allowed.
 *
 * The kind check needs no separate `isProduction` input: the route only ever
 * calls this function from inside its own `if (!sandbox)` branch, and
 * `sandbox` is unconditionally forced `true` off production (the route
 * decides that from its own `isProduction` literal before this function ever
 * runs) -- so REACHING this function already proves the environment is
 * production, and a `test`-kind account off production is never refused here
 * (it never reaches `!sandbox` at all).
 *
 * `channel` is required, not defaulted: a caller that forgets it should fail
 * to compile rather than silently pick a policy.
 */
export function realDatasetCreateGate(
  user: {
    service_access: number;
    sandbox_completed: number;
    account_kind: AccountKind;
  },
  channel: UploadChannel,
): UploadGateBody | null {
  if (user.account_kind === "test") return TEST_ACCOUNT_SANDBOX_ONLY_ERROR;
  if (!user.service_access) return SERVICE_ACCESS_ERROR;
  if (channel === "cli" && !user.sandbox_completed) return SANDBOX_TRAINING_ERROR;
  return null;
}

/**
 * Byte-flow gate for an existing real dataset (upload-urls / upload-credentials /
 * collaborator invite): requires service access. Sandbox training was enforced
 * at create time; the authorization to consume compute is the service grant, so
 * a collaborator who never created a dataset is still gated here. Returns the
 * 403 body, or null when allowed.
 */
export function realDatasetServiceGate(user: { service_access: number }): UploadGateBody | null {
  if (!user.service_access) return SERVICE_ACCESS_ERROR;
  return null;
}

export const EXPLICIT_ID_PRODUCTION_ERROR = {
  error: "Explicit dataset ids are not available in production",
  message:
    "A dataset id is allocated, never chosen. Naming one is a non-production fixture affordance (ADR 0068).",
} as const;

export const EXPLICIT_ID_ADMIN_ERROR = {
  error: "Admin role required to name a dataset id",
  message: "Standing fixtures are created by an administrator, not by a depositor.",
} as const;

export const EXPLICIT_ID_NOT_RESERVED_ERROR = {
  error: "Dataset id is not in the reserved fixture band",
  message:
    "Only ids the allocator can never mint may be named: nm099900-nm099999 and xx099900-xx099999 (ADR 0068).",
} as const;

/**
 * Gate for naming a dataset id instead of being allocated one.
 *
 * This exists because ADR 0068 makes `generateDatasetId` structurally unable to
 * return a reserved id, so the standing fixtures that live in that band cannot
 * be created by the route that creates everything else. The alternative was a
 * hand-written D1 INSERT, which is the shortcut that produced a fixture nobody
 * could publish: it skips every gate the fixture exists to exercise.
 *
 * **It narrows a documented invariant, and does so without weakening it.** The
 * create route forces `sandbox = true` in every non-production environment,
 * commented "prevents dev from minting real nm-prefix dataset IDs". A reserved
 * id is, by construction, one the allocator can never hand to anybody, so dev
 * naming `nm099998` does not mint a real id and cannot collide with one. The
 * invariant's PURPOSE is preserved exactly; only its blunt form is narrowed.
 * That distinction is the whole reason phase 1 had to land first -- before the
 * reservation existed there was no checkable sense of "not a real id".
 *
 * Every other create-time gate still applies. In particular this does NOT
 * exempt the caller from `realDatasetCreateGate`: a fixture that skipped the
 * account gates would stop exercising them, which is the opposite of why it
 * exists. An operator who cannot pass them is not the right operator.
 *
 * All three terms are required, not any: non-production alone would let a dev
 * caller name `nm000104` and reach a LIVE repository, because `nemarDatasets`
 * is shared between environments.
 */
export type ExplicitIdGateBody =
  | typeof EXPLICIT_ID_PRODUCTION_ERROR
  | typeof EXPLICIT_ID_ADMIN_ERROR
  | typeof EXPLICIT_ID_NOT_RESERVED_ERROR;

export function explicitDatasetIdGate(input: {
  isProduction: boolean;
  isAdmin: boolean;
  datasetId: string;
}): ExplicitIdGateBody | null {
  if (input.isProduction) return EXPLICIT_ID_PRODUCTION_ERROR;
  if (!input.isAdmin) return EXPLICIT_ID_ADMIN_ERROR;
  if (!isReservedFixtureId(input.datasetId)) return EXPLICIT_ID_NOT_RESERVED_ERROR;
  return null;
}
