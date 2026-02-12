/**
 * Cloudflare Workers environment bindings
 */
export interface Bindings {
  // D1 Database
  DB: D1Database;

  // Environment variables
  ENVIRONMENT: "production" | "development" | "staging" | "test";
  API_BASE_URL: string;
  FRONTEND_URL: string;
  AWS_REGION: string;
  S3_BUCKET: string;

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
}

/** User roles in hierarchical order: owner > admin > member */
export type UserRole = "owner" | "admin" | "member";

const ROLE_HIERARCHY: Record<UserRole, number> = { owner: 3, admin: 2, member: 1 };

/** Check if userRole meets or exceeds the minimum required role */
export function hasRole(userRole: UserRole, minimumRole: UserRole): boolean {
  return ROLE_HIERARCHY[userRole] >= ROLE_HIERARCHY[minimumRole];
}

/** Validate that a string is a valid UserRole */
export function isValidRole(value: string): value is UserRole {
  return value === "owner" || value === "admin" || value === "member";
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
  /** @deprecated Use role instead. Computed as role !== 'member'. */
  is_admin: boolean;
  orcid?: string;
}

/**
 * Extended Hono context variables
 */
export interface Variables {
  user: AuthUser;
}
