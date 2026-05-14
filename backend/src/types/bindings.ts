import type { MaintenanceMode } from "./maintenance";

/**
 * Cloudflare Workers environment bindings
 */
export interface Bindings {
  // D1 Database
  DB: D1Database;

  // Workers AI and Vectorize (for semantic dataset search)
  // Optional: deploy succeeds without index; runtime checks before use
  AI?: Ai;
  VECTORIZE?: VectorizeIndex;

  // Environment variables
  ENVIRONMENT: "production" | "development" | "staging" | "test";
  API_BASE_URL: string;
  FRONTEND_URL: string;
  AWS_REGION: string;
  S3_BUCKET: string;
  /** Undefined is treated as "off". See backend/src/types/maintenance.ts. */
  MAINTENANCE_MODE?: MaintenanceMode;
  /** Sender for outbound Resend emails, e.g. "NEMAR <nemar@osc.earth>".
   *  Falls back to DEFAULT_FROM_EMAIL in email.ts if unset/empty.
   *  The domain must be verified in the Resend account tied to RESEND_API_KEY,
   *  otherwise Resend rejects the send (caught and logged per-site). */
  FROM_EMAIL?: string;
  /** Reply-To address (e.g. "info@nemar.org") when FROM is a no-reply mailbox.
   *  Omitted when unset/empty. */
  REPLY_TO?: string;

  // Secrets
  GITHUB_ADMIN_PAT: string;
  AWS_ACCESS_KEY_ID: string;
  AWS_SECRET_ACCESS_KEY: string;
  RESEND_API_KEY: string;
  ZENODO_API_KEY: string;
  ZENODO_SANDBOX_API_KEY?: string; // Optional - for sandbox testing
  EZID_USERNAME: string; // EZID DOI service credentials (production)
  EZID_PASSWORD: string;
  EZID_SANDBOX_USERNAME?: string; // EZID test account (for --sandbox)
  EZID_SANDBOX_PASSWORD?: string;
  GITHUB_WEBHOOK_SECRET?: string; // Optional - for GitHub Actions webhook auth
  TEST_BYPASS_TOKEN?: string; // Optional - for CI/CD rate limit bypass
  ENCRYPTION_KEY?: string; // For encrypting stored credentials
  OPENROUTER_API_KEY?: string; // For LLM-based metadata enrichment
  NEMAR_USERNAME?: string; // nemar.org datapipeline API credentials
  NEMAR_PASSWORD?: string;

  // GitHub App credentials. Optional during the migration (#432); the
  // Worker falls back to GITHUB_ADMIN_PAT when any of these are unset.
  // Phase 5 will drop the PAT and make these required.
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string; // PKCS#8 PEM
  GITHUB_APP_INSTALLATION_ID_NEMAR_DATASETS?: string;
  GITHUB_APP_INSTALLATION_ID_NEMAR_ORG?: string;
}

/** User roles in hierarchical order: owner > admin > member */
export type UserRole = "owner" | "admin" | "member";

export const ROLE_HIERARCHY: Readonly<Record<UserRole, number>> = Object.freeze({
  owner: 3,
  admin: 2,
  member: 1,
});

/** Check if userRole meets or exceeds the minimum required role */
export function hasRole(userRole: UserRole, minimumRole: UserRole): boolean {
  return ROLE_HIERARCHY[userRole] >= ROLE_HIERARCHY[minimumRole];
}

/** Check if changing from oldRole to newRole is a demotion */
export function isDemotion(oldRole: UserRole, newRole: UserRole): boolean {
  return ROLE_HIERARCHY[newRole] < ROLE_HIERARCHY[oldRole];
}

/** Validate that a string is a valid UserRole */
export function isValidRole(value: string): value is UserRole {
  return value === "owner" || value === "admin" || value === "member";
}

/**
 * Validate and coerce a DB role value to UserRole.
 * Logs a warning if null (migration not applied), rejects invalid values.
 */
export function parseRole(value: string | null | undefined, username?: string): UserRole | null {
  if (value === null || value === undefined) {
    console.warn(
      `User ${username ?? "unknown"} has null role -- migration 0009 may not be applied. Defaulting to "member".`,
    );
    return "member";
  }
  if (!isValidRole(value)) {
    console.error(`User ${username ?? "unknown"} has invalid role value: "${value}"`);
    return null;
  }
  return value;
}

/**
 * User object set by auth middleware
 */
export interface AuthUser {
  id: number;
  username: string;
  email: string;
  github_username: string;
  role: UserRole;
  orcid?: string;
}

/**
 * Extended Hono context variables
 */
export interface Variables {
  user: AuthUser;
  // Set by optionalAuthMiddleware when an Authorization: Bearer header was
  // provided but did not resolve to a valid, approved user. Lets routes that
  // require auth on a flag (e.g., /datasets?mine=true) emit a token-specific
  // 401 instead of the generic "Authentication required" reply, so CLIs can
  // tell "no header sent" from "header sent but token invalid/expired".
  authAttempted: boolean;
}
