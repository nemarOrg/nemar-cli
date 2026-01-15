/**
 * Cloudflare Workers environment bindings
 */
export interface Bindings {
  // D1 Database
  DB: D1Database;

  // KV for rate limiting
  RATE_LIMIT_KV: KVNamespace;

  // Environment variables
  API_BASE_URL: string;
  FRONTEND_URL: string;
  AWS_REGION: string;
  S3_BUCKET: string;

  // Secrets
  GITHUB_ADMIN_PAT: string;
  AWS_ACCESS_KEY_ID: string;
  AWS_SECRET_ACCESS_KEY: string;
  RESEND_API_KEY: string;
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
}

/**
 * Extended Hono context variables
 */
export interface Variables {
  user: AuthUser;
}
