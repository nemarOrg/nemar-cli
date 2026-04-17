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
  MAINTENANCE_MODE?: "off" | "read-only" | "full";

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
}
