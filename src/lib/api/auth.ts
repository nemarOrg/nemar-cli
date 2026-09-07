/**
 * NEMAR API client: authentication, account, and sandbox-training endpoints.
 *
 * Split from lib/api.ts by endpoint group (#908, epic #902); bodies moved
 * verbatim.
 */

import { type ContractUser, userMeResponseSchema } from "../../../shared/contract/index.js";
import type { OrcidNameLookupStatus } from "../../../shared/contract/publication.js";
import { request } from "./client.js";

// ============================================================================
// Authentication
// ============================================================================

// ============================================================================
// Pre-signup validation
// ============================================================================

export interface CheckUsernameResponse {
  available: boolean;
  reason?: string;
}

/**
 * Check if a username is available
 */
export async function checkUsername(username: string): Promise<CheckUsernameResponse> {
  return request<CheckUsernameResponse>(
    `/auth/check-username?username=${encodeURIComponent(username)}`,
  );
}

export interface CheckGitHubResponse {
  valid: boolean;
  username?: string;
  registered?: boolean;
}

/**
 * Check if a GitHub username exists
 */
export async function checkGitHubUsername(username: string): Promise<CheckGitHubResponse> {
  return request<CheckGitHubResponse>(
    `/auth/check-github?username=${encodeURIComponent(username)}`,
  );
}

export interface OrcidNameResponse {
  /** `found` only when the record yielded BOTH name parts; the other two are
   *  kept apart so the caller can say WHY it is asking (#1255). */
  status: OrcidNameLookupStatus;
  given_name: string | null;
  family_name: string | null;
}

/**
 * Look up the given/family name on a public ORCID record before signing up.
 */
export async function checkOrcidName(orcid: string): Promise<OrcidNameResponse> {
  return request<OrcidNameResponse>(`/auth/orcid-name?orcid=${encodeURIComponent(orcid)}`);
}

export interface SignupRequest {
  username: string;
  email: string;
  password: string;
  github_username: string;
  description: string;
  /** Required (#835): canonical source for the user's name. */
  orcid: string;
  /** Only when the ORCID record hides its name (#1255); ORCID still wins. */
  given_name?: string;
  family_name?: string;
  affiliation?: string;
  /** Required for export-control screening (#835). */
  city: string;
  country: string;
}

export interface SignupResponse {
  message: string;
  email_sent: boolean;
  /** Whether the created account has a citable researcher name (#1255). The
   *  pre-flight lookup can disagree with this: only the insert knows. */
  researcher_name?: "recorded" | "missing";
  next_steps: string[];
}

/**
 * Register a new user account
 */
export async function signup(data: SignupRequest): Promise<SignupResponse> {
  return request<SignupResponse>("/auth/signup", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export interface LoginRequest {
  api_key: string;
}

export interface LoginResponse {
  valid: boolean;
  user: {
    username: string;
    email: string;
    github_username: string;
    role: "owner" | "admin" | "member";
    sandbox_completed: boolean;
    sandbox_dataset_id?: string;
  };
}

/**
 * Validate an API key and get user info
 */
export async function login(apiKey: string): Promise<LoginResponse> {
  return request<LoginResponse>("/auth/login", {
    method: "POST",
    body: JSON.stringify({ api_key: apiKey }),
  });
}

export interface ResendVerificationRequest {
  email: string;
}

/**
 * Resend verification email
 */
export async function resendVerification(email: string): Promise<{ message: string }> {
  return request<{ message: string }>("/auth/resend-verification", {
    method: "POST",
    body: JSON.stringify({ email }),
  });
}

export interface RetrieveKeyResponse {
  message: string;
  api_key: string;
}

export async function retrieveKey(email: string, password: string): Promise<RetrieveKeyResponse> {
  return request<RetrieveKeyResponse>("/auth/retrieve-key", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
}

export async function requestKeyRegeneration(email: string): Promise<{ message: string }> {
  return request<{ message: string }>("/auth/request-key-regeneration", {
    method: "POST",
    body: JSON.stringify({ email }),
  });
}

// ============================================================================
// User
// ============================================================================

/**
 * Get current user info (requires authentication).
 *
 * `/users/me` returns a NESTED envelope `{ user, token }`; this unwraps `.user`
 * (typed by the shared contract's `ContractUser`). Previously it declared a
 * flat `UserInfo` and did `request<UserInfo>` on the envelope, so every field
 * read (`.username`, `.role`, `.orcid`, ...) was
 * `undefined` at runtime, silently writing `undefined` over stored account
 * config on `auth status --refresh` and disabling the upload ORCID auto-match
 * (#895 / epic #896 #899). Validated against the shared contract so a future
 * shape drift fails loud here instead of silently.
 */
export async function getCurrentUser(): Promise<ContractUser> {
  const res = await request("/users/me", {}, true, userMeResponseSchema);
  return res.user;
}

// ============================================================================
// SSH Key Management
// TODO: These functions are prepared for future backend-managed SSH key registration.
// Currently, setup-ssh guides users to manually add keys to GitHub.
// ============================================================================

export interface RegisterSSHKeyResponse {
  message: string;
  key_id: number;
  key_title: string;
}

/**
 * Register an SSH public key with GitHub via the backend
 * The backend uses the user's GitHub credentials to add the deploy key
 *
 * Note: Not yet used; users currently add keys manually via GitHub UI.
 */
export async function registerSSHKey(publicKey: string): Promise<RegisterSSHKeyResponse> {
  return request<RegisterSSHKeyResponse>(
    "/auth/ssh-key",
    {
      method: "POST",
      body: JSON.stringify({ public_key: publicKey }),
    },
    true,
  );
}

/**
 * Check if user has an SSH key registered
 *
 * Note: Not yet used; users currently add keys manually via GitHub UI.
 */
export async function checkSSHKeyStatus(): Promise<{ registered: boolean; key_title?: string }> {
  return request<{ registered: boolean; key_title?: string }>("/auth/ssh-key", {}, true);
}

// ============================================================================
// Sandbox Training
// ============================================================================

export interface SandboxCompleteResponse {
  message: string;
  sandbox_completed: boolean;
  sandbox_dataset_id: string;
}

/**
 * Mark sandbox training as complete (called after successful sandbox upload)
 */
export async function completeSandbox(datasetId: string): Promise<SandboxCompleteResponse> {
  return request<SandboxCompleteResponse>(
    "/sandbox/complete",
    {
      method: "POST",
      body: JSON.stringify({ dataset_id: datasetId }),
    },
    true,
  );
}

/**
 * Reset sandbox training status (for testing or re-training)
 */
export async function resetSandbox(): Promise<{ message: string }> {
  return request<{ message: string }>(
    "/sandbox/reset",
    {
      method: "POST",
    },
    true,
  );
}

/**
 * Get sandbox training status
 */
export async function getSandboxStatus(): Promise<{
  sandbox_completed: boolean;
  sandbox_dataset_id?: string;
  sandbox_completed_at?: string;
}> {
  return request<{
    sandbox_completed: boolean;
    sandbox_dataset_id?: string;
    sandbox_completed_at?: string;
  }>("/sandbox/status", {}, true);
}

// ============================================================================
// Upload access (ADR 0042, #1253)
// ============================================================================

export interface UploadAccessRequestResponse {
  ok: true;
  /** True when a request was already open. */
  already_requested: boolean;
  requested_at?: string | null;
  /**
   * Whether at least one admin actually received the review card. False means
   * the request IS recorded but nobody was told yet; calling again re-sends
   * (ADR 0042). Optional so a backend that predates the second stamp reads as
   * "unknown" rather than as a failure.
   */
  email_sent?: boolean;
  /** Admins reached. `null` on a repeat call for an already-notified request,
   *  where the count belongs to the original send and is not re-derived. */
  admins_notified?: number | null;
}

/**
 * Ask for upload access, once. Every precondition failure arrives as an
 * ApiError whose `missing` names the account fields still to fill in, so the
 * caller can print them rather than a single sentence (see errors.ts).
 */
export async function requestUploadAccess(why: string): Promise<UploadAccessRequestResponse> {
  return request<UploadAccessRequestResponse>(
    "/users/me/upload-access/request",
    {
      method: "POST",
      body: JSON.stringify({ why }),
    },
    true,
  );
}

// ============================================================================
// Self-service identity edits (#1266, epic #1250; ADR 0044)
// ============================================================================
//
// The same routes the website's Settings page uses, reached with the CLI's
// bearer token instead of a session cookie. Every refusal arrives as an
// ApiError whose message is the backend's own sentence: the bodies carry a
// machine code in `error` and the sentence in `message`, and client.ts prefers
// the latter for the codes declared in shared/contract (identity.ts and
// user.ts).

export interface EmailChangeRequestResponse {
  ok: true;
  /** The new address, masked, for echoing back to the user. */
  masked_email: string;
  /** Non-production only, and only for a synthetic test target: the echo IS
   *  the delivery there (the dev worker must not mail real addresses). */
  dev_code?: string;
  /** Non-production: the target was not allow-listed, so nothing was sent. */
  dev_skip?: string;
}

/** Step 1 of an email change: mail a 6-digit code to the NEW address. */
export async function requestEmailChange(email: string): Promise<EmailChangeRequestResponse> {
  return request<EmailChangeRequestResponse>(
    "/auth/email/change/request",
    {
      method: "POST",
      body: JSON.stringify({ email }),
    },
    true,
  );
}

export interface EmailChangeVerifyResponse {
  ok: true;
  /**
   * Whether the PREVIOUS address was told the account email moved (#1054).
   * `false` is not a failure of the change -- the change has landed either
   * way -- but it is worth saying out loud, because the notice is the only
   * thing that would reach a legitimate owner if this were not them.
   * Optional: a backend deployed before #1266 does not send it.
   */
  old_address_notified?: boolean;
}

/** Step 2: redeem the code and move `users.email`. */
export async function verifyEmailChange(
  email: string,
  code: string,
): Promise<EmailChangeVerifyResponse> {
  return request<EmailChangeVerifyResponse>(
    "/auth/email/change/verify",
    {
      method: "POST",
      body: JSON.stringify({ email, code }),
    },
    true,
  );
}

/** Any subset of the self-editable profile fields; absent keys are untouched. */
export interface ProfilePatchRequest {
  github_username?: string;
  username?: string;
  given_name?: string;
  family_name?: string;
  city?: string;
  country?: string;
  affiliation?: string;
}

export interface ProfileUpdateResponse {
  ok: true;
}

/** Edit the account's own profile fields (`PATCH /auth/profile`). */
export async function updateProfile(patch: ProfilePatchRequest): Promise<ProfileUpdateResponse> {
  return request<ProfileUpdateResponse>(
    "/auth/profile",
    {
      method: "PATCH",
      body: JSON.stringify(patch),
    },
    true,
  );
}

export interface OrcidCliStartResponse {
  /** Open this in a browser; it sets the state cookie and bounces to ORCID. */
  authorize_url: string;
  /** Seconds the intent stays usable. */
  expires_in: number;
  mode: "link" | "relink";
}

/**
 * Mint a browser-openable ORCID link (or relink) intent for this account.
 * ORCID cannot be completed in a terminal — this is the handoff, and the
 * callback finishes the link for the account the intent names.
 */
export async function startOrcidCliLink(mode: "link" | "relink"): Promise<OrcidCliStartResponse> {
  return request<OrcidCliStartResponse>(
    "/auth/orcid/cli-start",
    {
      method: "POST",
      body: JSON.stringify({ mode }),
    },
    true,
  );
}

/** Remove the ORCID link (identity row, `users.orcid`, `orcid_verified`). */
export async function unlinkOrcid(): Promise<{ ok: true }> {
  return request<{ ok: true }>("/auth/orcid/unlink", { method: "POST" }, true);
}
