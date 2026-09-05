/**
 * NEMAR API client: error types.
 *
 * Split from lib/api.ts by endpoint group (#908, epic #902); bodies moved
 * verbatim. All API functions throw ApiError on failure.
 */

/** Extract a human-readable message from an unknown error value. */
export function errorDetail(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * API error with status code and message.
 *
 * `step` carries the top-level `step` field from orchestrator-style error
 * responses (publish-approve, etc.), where the failing pipeline step is
 * surfaced separately from `details`. It is optional because most endpoints
 * don't use this field.
 *
 * `blockReason` carries the top-level `block_reason` from a publication
 * refusal, so a caller can key an actionable hint on WHY it was refused
 * rather than on the status code alone (#1255): a 422 from the publish paths
 * used to always print the CI hint, which is the wrong advice for a missing
 * researcher name.
 */
export class ApiError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public details?: unknown,
    public step?: string,
    public blockReason?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * Thrown when the backend is in maintenance mode (503 with a `mode` body).
 * Mode describes what the server is rejecting; CLI treats it as an expected
 * temporary state and shows a friendly banner instead of a stack trace.
 */
export class MaintenanceError extends ApiError {
  constructor(
    public readonly mode: "read-only" | "full",
    message: string,
    public readonly eta: string | null,
    details?: unknown,
  ) {
    super(503, message, details);
    this.name = "MaintenanceError";
  }
}
