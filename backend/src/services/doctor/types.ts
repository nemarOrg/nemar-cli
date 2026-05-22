/**
 * Shared types for the admin doctor framework.
 *
 * A "check" represents one diagnostic + remediation pair. Each check has:
 *   - scan(ctx, datasetId?): finds datasets exhibiting the problem
 *   - fix(ctx, finding): applies an idempotent remediation
 *
 * Scan is read-only and safe to run on a schedule. Fix is opt-in and writes;
 * callers should pass `dry_run: true` first to confirm the scope before
 * flipping the switch.
 */

import type { D1Database } from "@cloudflare/workers-types";
import type { PresignedUrlOptions } from "../s3";

/** Inputs every check needs. Wired up by the route handler. */
export interface CheckContext {
  db: D1Database;
  s3: PresignedUrlOptions;
  githubPat: string;
}

/**
 * One dataset (possibly one version) exhibiting the check's problem.
 * `details` is check-specific bag the fix function will read back.
 */
export interface Finding {
  dataset_id: string;
  version?: string;
  details: Record<string, unknown>;
}

/** What the fix did (or chose not to do). */
export interface FixResult {
  status: "fixed" | "skipped" | "failed";
  message?: string;
  details?: Record<string, unknown>;
}

export interface DoctorCheck {
  readonly name: string;
  readonly description: string;
  /**
   * Find datasets that match the problem. Optional `datasetId` narrows to one;
   * undefined scans the whole table.
   */
  scan(ctx: CheckContext, datasetId?: string): Promise<Finding[]>;
  /**
   * Apply the remediation. Must be idempotent: a second call on the same
   * finding (when the underlying state was already fixed by something else)
   * must return status="skipped", not "failed".
   */
  fix(ctx: CheckContext, finding: Finding): Promise<FixResult>;
}
