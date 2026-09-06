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

export type UploadGateBody = typeof SERVICE_ACCESS_ERROR | typeof SANDBOX_TRAINING_ERROR;

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
 * Create-time gate for a real dataset: requires service access first (the
 * authorization gate), then — on the CLI channel only — sandbox training (the
 * how-to gate). Returns the 403 body to send, or null when the upload is
 * allowed.
 *
 * `channel` is required, not defaulted: a caller that forgets it should fail
 * to compile rather than silently pick a policy.
 */
export function realDatasetCreateGate(
  user: {
    service_access: number;
    sandbox_completed: number;
  },
  channel: UploadChannel,
): UploadGateBody | null {
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
