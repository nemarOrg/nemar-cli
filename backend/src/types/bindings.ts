/**
 * Cloudflare Workers environment bindings
 */
export interface Bindings {
  // D1 Database
  DB: D1Database;

  // Environment variables
  ENVIRONMENT: "production" | "development";
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
  EZID_USERNAME: string; // EZID DOI service credentials
  EZID_PASSWORD: string;
  GITHUB_WEBHOOK_SECRET?: string; // Optional - for GitHub Actions webhook auth
  TEST_BYPASS_TOKEN?: string; // Optional - for CI/CD rate limit bypass
  ENCRYPTION_KEY?: string; // For encrypting stored credentials
}

/**
 * User object set by auth middleware
 */
export interface AuthUser {
  id: number;
  username: string;
  email: string;
  github_username: string;
  is_admin: boolean;
  orcid?: string;
}

/**
 * Extended Hono context variables
 */
export interface Variables {
  user: AuthUser;
}
