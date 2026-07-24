/**
 * Service-access upload gate (ADR 0010, #1013).
 *
 * Real (non-sandbox) uploads are gated on `service_access` — the admin-granted
 * permission to consume compute/storage, issued only after export-control review
 * of the person's GitHub + location/affiliation. Base-access accounts
 * (auto-approved ORCID sign-ins) never have it. Sandbox uploads are exempt (they
 * are the capped training playground).
 *
 * Pure so the decision (and its ordering) is unit-testable without a live
 * backend; every real-upload entry point routes through these helpers so the
 * gate can't be added to one endpoint and forgotten on another.
 */

export const SERVICE_ACCESS_ERROR = {
  error: "Service access required",
  message:
    "Uploading requires service access. Request upload access from your account settings; an admin reviews it before granting.",
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
