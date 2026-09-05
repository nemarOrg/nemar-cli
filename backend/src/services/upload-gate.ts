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
 * The gate itself is unchanged by ADR 0040 and needs nothing from phase 2: it
 * reads `service_access`, never `status`. What phase 2 (#1252) adds is the rest
 * of what `verified` is supposed to unlock — the API key, the sandbox routes,
 * and the login paths, all of which still require `status='approved'` today.
 *
 * Pure so the decision (and its ordering) is unit-testable without a live
 * backend; every real-upload entry point routes through these helpers so the
 * gate can't be added to one endpoint and forgotten on another.
 */

/**
 * `error` is the stable machine-readable half and must not change — the CLI
 * matches on it. `message` is the human half: it used to point at a
 * "request upload access from your account settings" flow that has never
 * existed (website ADR 0010 phase 2 was never built, #1249), so it sent people to a
 * settings page with nothing on it. It now names the path that actually works
 * today and says which one is coming.
 */
export const SERVICE_ACCESS_ERROR = {
  error: "Service access required",
  message:
    "Uploading requires upload access, a one-time admin approval. Ask an admin via https://nemar.org/support; the request flow is coming to Settings and the CLI.",
} as const;

export const SANDBOX_TRAINING_ERROR = {
  error: "Sandbox training required",
  message:
    "You must complete sandbox training before uploading real datasets. Run 'nemar sandbox' to complete training.",
} as const;

export type UploadGateBody = typeof SERVICE_ACCESS_ERROR | typeof SANDBOX_TRAINING_ERROR;

/**
 * Create-time gate for a real dataset: requires service access first (the
 * authorization gate), then sandbox training (the how-to gate). Returns the 403
 * body to send, or null when the upload is allowed.
 */
export function realDatasetCreateGate(user: {
  service_access: number;
  sandbox_completed: number;
}): UploadGateBody | null {
  if (!user.service_access) return SERVICE_ACCESS_ERROR;
  if (!user.sandbox_completed) return SANDBOX_TRAINING_ERROR;
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
