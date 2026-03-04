/**
 * NEMAR API Client
 *
 * Handles all communication with the NEMAR backend API.
 * All methods throw ApiError on failure for consistent error handling.
 */

import { getConfig } from "./config.js";
import { version } from "./version.js";

const DEFAULT_API_URL = "https://api.osc.earth/nemar";

/** ORCID identifier format: XXXX-XXXX-XXXX-XXXX (last char may be X) */
export const ORCID_REGEX = /^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/;

/** Extract a human-readable message from an unknown error value. */
export function errorDetail(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * API error with status code and message
 */
export class ApiError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

const IS_DEV_BUILD = DEFAULT_API_URL.includes("workers.dev");

/**
 * Get the API base URL from config or default.
 * Dev builds (injected URL) always use the dev backend regardless of stored config.
 */
function getApiUrl(): string {
  if (process.env.TEST_API_URL) {
    return process.env.TEST_API_URL;
  }
  if (IS_DEV_BUILD) {
    return DEFAULT_API_URL;
  }
  const config = getConfig();
  return config.apiUrl || DEFAULT_API_URL;
}

/**
 * Make an authenticated or unauthenticated API request
 */
async function request<T>(
  path: string,
  options: RequestInit = {},
  authenticated: boolean | "optional" = false,
): Promise<T> {
  const url = `${getApiUrl()}${path}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-CLI-Version": version,
    ...(options.headers as Record<string, string>),
  };

  if (authenticated) {
    const config = getConfig();
    if (!config.apiKey && authenticated === true) {
      throw new ApiError(401, "Not authenticated. Run 'nemar auth login' first.");
    }
    if (config.apiKey) {
      headers.Authorization = `Bearer ${config.apiKey}`;
    }
  }

  let response: Response;
  try {
    response = await fetch(url, {
      ...options,
      headers,
    });
  } catch (fetchError) {
    // Network error - DNS resolution, connection refused, etc.
    throw new ApiError(0, `Network error: Could not connect to ${getApiUrl()}`, {
      originalError: fetchError instanceof Error ? fetchError.message : String(fetchError),
    });
  }

  let data: Record<string, unknown>;
  try {
    data = (await response.json()) as Record<string, unknown>;
  } catch {
    // Response wasn't valid JSON
    throw new ApiError(response.status, `Invalid response from server (status ${response.status})`);
  }

  if (!response.ok) {
    throw new ApiError(
      response.status,
      (data.error as string) || (data.message as string) || "Request failed",
      data.details,
    );
  }

  return data as T;
}

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

export interface SignupRequest {
  username: string;
  email: string;
  password: string;
  github_username: string;
  description: string;
  orcid?: string;
}

export interface SignupResponse {
  message: string;
  email_sent: boolean;
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

export interface UserInfo {
  id: number;
  username: string;
  email: string;
  github_username: string;
  orcid?: string | null;
  status: string;
  role: "owner" | "admin" | "member";
  created_at: string;
  sandbox_completed: boolean;
  sandbox_dataset_id?: string;
}

/**
 * Get current user info (requires authentication)
 */
export async function getCurrentUser(): Promise<UserInfo> {
  return request<UserInfo>("/users/me", {}, true);
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
// Admin
// ============================================================================

export interface UserListItem {
  id: number;
  username: string;
  email: string;
  github_username: string;
  status: string;
  email_verified: number;
  role: string;
  created_at: string;
  approved_at: string | null;
  revoked_at: string | null;
}

export interface UsersListResponse {
  users: UserListItem[];
  count: number;
}

/**
 * List users (admin only)
 */
export async function listUsers(status?: string, role?: string): Promise<UsersListResponse> {
  const params = new URLSearchParams();
  if (status) params.set("status", status);
  if (role) params.set("role", role);
  const query = params.toString() ? `?${params.toString()}` : "";
  return request<UsersListResponse>(`/admin/users${query}`, {}, true);
}

export interface ApproveResponse {
  message: string;
  user: {
    username: string;
    email: string;
    status: string;
  };
  email_sent: boolean;
  iam_setup?: boolean;
  iam_username?: string;
  github_pat_created?: boolean;
  github_pat_name?: string;
  warning?: string;
}

/**
 * Approve a pending user (admin only)
 */
export async function approveUser(username: string): Promise<ApproveResponse> {
  return request<ApproveResponse>(
    `/admin/approve/${username}`,
    {
      method: "POST",
    },
    true,
  );
}

/**
 * Revoke a user's access (admin only)
 */
export async function revokeUser(username: string): Promise<{ message: string }> {
  return request<{ message: string }>(
    `/admin/revoke/${username}`,
    {
      method: "POST",
    },
    true,
  );
}

export interface ChangeRoleResponse {
  message: string;
  user: { username: string; role: string };
  tokens_revoked?: number;
}

/**
 * Change a user's role (owner only)
 */
export async function changeUserRole(
  username: string,
  role: "owner" | "admin" | "member",
): Promise<ChangeRoleResponse> {
  return request<ChangeRoleResponse>(
    `/admin/users/${username}/role`,
    {
      method: "POST",
      body: JSON.stringify({ role }),
    },
    true,
  );
}

export interface RegenerateIamResponse {
  message: string;
  user: {
    username: string;
    iam_username: string;
    role: string;
  };
  /**
   * Number of dataset prefixes restored for regular users,
   * or "all (full bucket access)" for admins
   */
  datasets_restored: number | string;
  /** Warning if old key revocation failed (security concern) */
  warning?: string;
}

export async function regenerateUserIam(username: string): Promise<RegenerateIamResponse> {
  return request<RegenerateIamResponse>(
    `/admin/regenerate-iam/${username}`,
    {
      method: "POST",
    },
    true,
  );
}

// ============================================================================
// Admin - Repository Management
// ============================================================================

export interface VisibilityResponse {
  message: string;
  dataset_id: string;
  visibility: "public" | "private";
}

/**
 * Change dataset repository visibility (admin only)
 */
export async function changeVisibility(
  datasetId: string,
  visibility: "public" | "private",
): Promise<VisibilityResponse> {
  return request<VisibilityResponse>(
    `/admin/datasets/${datasetId}/visibility`,
    {
      method: "PATCH",
      body: JSON.stringify({ visibility }),
    },
    true,
  );
}

export interface PublishDatasetResponse {
  success: boolean;
  message: string;
  dataset_id: string;
  github_url: string;
  s3_url: string;
}

/**
 * Publish a dataset (make public) - owner or admin
 * This is a one-way operation that cannot be undone
 */
export async function publishDataset(datasetId: string): Promise<PublishDatasetResponse> {
  return request<PublishDatasetResponse>(
    `/datasets/${datasetId}/publish`,
    { method: "POST" },
    true,
  );
}

// ============================================================================
// Admin - CI Management
// ============================================================================

export interface CiStatusResponse {
  dataset_id: string;
  bids_validation: {
    present: boolean;
    status: string;
    url: string | null;
  };
  version_check: {
    present: boolean;
  };
}

/**
 * Get CI workflow status for a dataset (admin only)
 */
export async function getCiStatus(datasetId: string): Promise<CiStatusResponse> {
  return request<CiStatusResponse>(`/admin/datasets/${datasetId}/ci`, {}, true);
}

export interface AddCiResponse {
  message: string;
  dataset_id: string;
  workflows_deployed: string[];
}

/**
 * Deploy CI workflows to a dataset repository (admin only)
 */
export async function addCi(datasetId: string): Promise<AddCiResponse> {
  return request<AddCiResponse>(`/admin/datasets/${datasetId}/ci`, { method: "POST" }, true);
}

export interface UserCiStatusResponse {
  dataset_id: string;
  bids_validation: {
    present: boolean;
    status: string;
    url: string | null;
  };
}

/**
 * Get CI workflow status for a dataset (user-accessible, owner or admin)
 */
export async function getUserCiStatus(datasetId: string): Promise<UserCiStatusResponse> {
  return request<UserCiStatusResponse>(`/datasets/${datasetId}/ci/status`, {}, true);
}

// ============================================================================
// Manifests
// ============================================================================

export interface ManifestFile {
  key: string;
  size: number;
  checksum: string;
}

export interface VersionManifest {
  dataset_id: string;
  version: string;
  doi: string | null;
  concept_doi: string | null;
  created: string;
  files: Record<string, ManifestFile>;
}

export interface ManifestListResponse {
  dataset_id: string;
  versions: string[];
}

/**
 * List available version manifests for a dataset
 */
export async function listManifestVersions(datasetId: string): Promise<ManifestListResponse> {
  return request<ManifestListResponse>(`/datasets/${datasetId}/manifest`, {}, true);
}

/**
 * Get a specific version manifest for a dataset
 */
export async function getManifest(datasetId: string, version: string): Promise<VersionManifest> {
  return request<VersionManifest>(`/datasets/${datasetId}/manifest/${version}`, {}, true);
}

// ============================================================================
// Datasets
// ============================================================================

export interface Dataset {
  id: number;
  dataset_id: string;
  name: string;
  description: string | null;
  owner_username: string;
  /**
   * Lifecycle state of the dataset.
   * - active: Dataset is operational
   * - archived: Dataset is read-only, preserved for historical reference
   * - deleted: Dataset is soft-deleted, invisible to users
   */
  status: "active" | "archived" | "deleted";
  /**
   * Access control state.
   * - private: Only owner and admins can view (default for new datasets)
   * - public: Visible to all users, accessible via public catalog
   *
   * Independent from status: datasets can be active+private, archived+public, etc.
   */
  visibility: "public" | "private";
  github_repo: string | null;
  concept_doi: string | null;
  created_at: string;
}

export interface DatasetsListResponse {
  datasets: Dataset[];
  count: number;
}

/**
 * Validate dataset object has correct status and visibility values
 * Throws error if validation fails
 */
export function validateDataset(data: unknown): Dataset {
  const d = data as Dataset;

  if (!["active", "archived", "deleted"].includes(d.status)) {
    throw new Error(`Invalid dataset status: ${d.status}`);
  }

  // Default to private if visibility not set (older records missing column)
  if (!d.visibility) {
    d.visibility = "private";
  } else if (!["public", "private"].includes(d.visibility)) {
    throw new Error(`Invalid dataset visibility: ${d.visibility}`);
  }

  return d;
}

/**
 * List datasets
 */
export async function listDatasets(mine = false): Promise<DatasetsListResponse> {
  const query = mine ? "?mine=true" : "";
  const response = await request<DatasetsListResponse>(
    `/datasets${query}`,
    {},
    mine ? true : "optional",
  );
  // Validate each dataset in the response
  response.datasets = response.datasets.map(validateDataset);
  return response;
}

interface GetDatasetResponse {
  dataset: Dataset;
}

/**
 * Get a single dataset by ID
 */
export async function getDataset(datasetId: string): Promise<Dataset> {
  const response = await request<GetDatasetResponse>(`/datasets/${datasetId}`, {}, "optional");
  return validateDataset(response.dataset);
}

// ============================================================================
// Version History
// ============================================================================

export interface VersionInfo {
  version: string;
  doi: string;
  provider: "ezid" | "zenodo";
  created_at: string;
}

export interface VersionHistoryResponse {
  dataset_id: string;
  current_version: string;
  versions: VersionInfo[];
}

/**
 * Get version history for a dataset (requires auth)
 */
export async function getVersionHistory(datasetId: string): Promise<VersionHistoryResponse> {
  return request<VersionHistoryResponse>(`/datasets/${datasetId}/versions`, {}, true);
}

export interface FileInfo {
  path: string;
  size: number;
  type: "metadata" | "data";
}

export interface CreateDatasetRequest {
  name: string;
  description?: string;
  files?: FileInfo[];
  sandbox?: boolean; // If true, creates sandbox dataset with xx000xxx ID
}

export interface CreateDatasetResponse {
  message: string;
  dataset: {
    id: number;
    dataset_id: string;
    name: string;
    description: string | null;
    github_repo: string;
    github_url: string;
    ssh_url: string;
    s3_prefix: string;
  };
  // Presigned URLs for file uploads (keyed by relative file path)
  upload_urls?: Record<string, string>;
  // S3 configuration for constructing public URLs
  s3_config: {
    bucket: string;
    region: string;
    public_url: string;
  };
}

/**
 * Create a new dataset (requires authentication)
 * Returns dataset info including GitHub repo URL and S3 prefix
 */
export async function createDataset(data: CreateDatasetRequest): Promise<CreateDatasetResponse> {
  return request<CreateDatasetResponse>(
    "/datasets",
    {
      method: "POST",
      body: JSON.stringify(data),
    },
    true,
  );
}

export interface FinalizeDatasetResponse {
  message: string;
  warnings?: string[];
  dataset: {
    dataset_id: string;
    status: string;
    github_url: string;
  };
}

/**
 * Finalize a dataset after upload (requires authentication)
 * Applies branch protection and marks dataset as published
 */
export async function finalizeDataset(datasetId: string): Promise<FinalizeDatasetResponse> {
  return request<FinalizeDatasetResponse>(
    `/datasets/${datasetId}/finalize`,
    {
      method: "POST",
    },
    true,
  );
}

export interface UploadUrlsResponse {
  upload_urls: Record<string, string>;
}

/**
 * Request presigned upload URLs for files (requires authentication)
 * Used for uploading additional files to an existing dataset
 */
export async function requestUploadUrls(
  datasetId: string,
  files: string[],
): Promise<UploadUrlsResponse> {
  return request<UploadUrlsResponse>(
    `/datasets/${datasetId}/upload-urls`,
    {
      method: "POST",
      body: JSON.stringify({ files }),
    },
    true,
  );
}

export interface UploadCredentialsResponse {
  credentials: {
    access_key_id: string;
    secret_access_key: string;
    session_token: string;
    expiration: string;
  };
  s3: {
    bucket: string;
    region: string;
    prefix: string;
  };
}

/**
 * Request temporary STS credentials for direct S3 upload via AWS CLI.
 * Throws on failure; callers should fall back to presigned URLs.
 */
export async function requestUploadCredentials(
  datasetId: string,
  durationSeconds?: number,
): Promise<UploadCredentialsResponse> {
  return request<UploadCredentialsResponse>(
    `/datasets/${datasetId}/upload-credentials`,
    {
      method: "POST",
      body: JSON.stringify({
        duration_seconds: durationSeconds,
      }),
    },
    true,
  );
}

/**
 * Request temporary read-only STS credentials for downloading private dataset
 * files from S3 via git-annex.
 */
export async function requestDownloadCredentials(
  datasetId: string,
  durationSeconds?: number,
): Promise<UploadCredentialsResponse> {
  return request<UploadCredentialsResponse>(
    `/datasets/${datasetId}/download-credentials`,
    {
      method: "POST",
      body: JSON.stringify({
        duration_seconds: durationSeconds,
      }),
    },
    true,
  );
}

// ============================================================================
// Health
// ============================================================================

export interface HealthResponse {
  status: string;
  timestamp: string;
  version: string;
}

/**
 * Check API health
 */
export async function checkHealth(): Promise<HealthResponse> {
  return request<HealthResponse>("/health");
}

// ============================================================================
// DOI Management (Admin)
// ============================================================================

export interface CreateConceptDoiRequest {
  title?: string;
  description?: string;
  authors?: Array<{ name: string; affiliation?: string }>;
  sandbox?: boolean;
  provider?: "ezid" | "zenodo";
}

interface CreateConceptDoiResponseBase {
  message: string;
  concept_doi: string;
  warning: string;
  metadata_warning?: string;
}

export type CreateConceptDoiResponse = CreateConceptDoiResponseBase &
  (
    | { provider: "ezid"; ezid_identifier: string; doi_url: string }
    | { provider: "zenodo"; zenodo_id: number; zenodo_url: string }
  );

/**
 * Create concept DOI for a dataset (admin only)
 */
export async function createConceptDoi(
  datasetId: string,
  data: CreateConceptDoiRequest,
): Promise<CreateConceptDoiResponse> {
  return request<CreateConceptDoiResponse>(
    `/admin/datasets/${datasetId}/doi/concept`,
    {
      method: "POST",
      body: JSON.stringify(data),
    },
    true,
  );
}

export interface PublishVersionDoiRequest {
  version: string;
  release_url: string;
  sandbox?: boolean;
}

export interface PublishVersionDoiResponse {
  message: string;
  version: string;
  version_doi: string;
  concept_doi: string;
  zenodo_url: string;
  warning: string;
}

/**
 * Publish version DOI for a dataset (admin only)
 */
export async function publishVersionDoi(
  datasetId: string,
  data: PublishVersionDoiRequest,
): Promise<PublishVersionDoiResponse> {
  return request<PublishVersionDoiResponse>(
    `/admin/datasets/${datasetId}/doi/publish`,
    {
      method: "POST",
      body: JSON.stringify(data),
    },
    true,
  );
}

export interface DoiInfoResponse {
  dataset_id: string;
  name: string;
  concept_doi: string | null;
  latest_version_doi: string | null;
  doi_provider: "ezid" | "zenodo";
  zenodo_concept_url: string | null;
  zenodo_latest_version_url: string | null;
  ezid_identifier: string | null;
  ezid_status: "reserved" | "public" | "unavailable" | null;
  doi_url: string | null;
}

/**
 * Get DOI info for a dataset (admin only)
 */
export async function getDoiInfo(datasetId: string): Promise<DoiInfoResponse> {
  return request<DoiInfoResponse>(`/admin/datasets/${datasetId}/doi`, {}, true);
}

export interface UpdateDoiRequest {
  status?: "public" | "unavailable";
  refresh_metadata?: boolean;
}

export interface UpdateDoiResponse {
  message: string;
  ezid_identifier: string;
  status: "reserved" | "public" | "unavailable";
  doi_url: string;
  metadata_refreshed: boolean;
}

/**
 * Update EZID DOI metadata or status (admin only)
 */
export async function updateDoi(
  datasetId: string,
  data: UpdateDoiRequest,
): Promise<UpdateDoiResponse> {
  return request<UpdateDoiResponse>(
    `/admin/datasets/${datasetId}/doi/update`,
    {
      method: "POST",
      body: JSON.stringify(data),
    },
    true,
  );
}

// ============================================================================
// Dataset Access
// ============================================================================

export interface RequestAccessResponse {
  message: string;
  dataset_id: string;
  github_repo: string;
}

/**
 * Request collaborator access to a dataset (requires authentication)
 * Auto-grants for public repos
 */
export async function requestDatasetAccess(datasetId: string): Promise<RequestAccessResponse> {
  return request<RequestAccessResponse>(
    `/datasets/${datasetId}/request-access`,
    {
      method: "POST",
    },
    true,
  );
}

export interface InviteCollaboratorResponse {
  message: string;
  dataset_id: string;
  invitee: string;
}

/**
 * Invite a user as collaborator to a dataset (owner/admin only)
 */
export async function inviteCollaborator(
  datasetId: string,
  username: string,
): Promise<InviteCollaboratorResponse> {
  return request<InviteCollaboratorResponse>(
    `/datasets/${datasetId}/invite`,
    {
      method: "POST",
      body: JSON.stringify({ username }),
    },
    true,
  );
}

export interface Collaborator {
  username: string;
  github_username: string;
  access_type: "requested" | "invited";
  granted_at: string;
  granted_by_username: string | null;
}

export interface ListCollaboratorsResponse {
  dataset_id: string;
  collaborators: Collaborator[];
  count: number;
}

/**
 * List collaborators for a dataset (owner/admin only)
 */
export async function listCollaborators(datasetId: string): Promise<ListCollaboratorsResponse> {
  return request<ListCollaboratorsResponse>(`/datasets/${datasetId}/collaborators`, {}, true);
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
// Publication Workflow
// ============================================================================

export interface PublishStatusResponse {
  dataset_id: string;
  status: string;
  requested_at?: string;
  requested_by?: string;
  approved_at?: string | null;
  denied_at?: string | null;
  denied_reason?: string | null;
  steps_completed?: string[];
  current_step?: string | null;
  last_error?: string | null;
  updated_at?: string;
  message?: string;
}

export interface PublishRequestsResponse {
  requests: Array<{
    id: number;
    dataset_id: string;
    status: string;
    requested_at: string;
    requested_by_username: string;
    requested_by_email: string;
    steps_completed: string[];
    current_step: string | null;
    last_error: string | null;
  }>;
  count: number;
}

export interface PublishApproveResponse {
  message: string;
  dataset_id: string;
  status?: string;
  steps_completed?: string[];
  error?: string;
  step?: string;
  hasMore?: boolean;
  s3_lock_offset?: number;
}

/**
 * Request publication of a dataset (user)
 */
export async function requestPublication(
  datasetId: string,
): Promise<{ message: string; dataset_id: string; status: string }> {
  return request<{ message: string; dataset_id: string; status: string }>(
    `/datasets/${datasetId}/publish/request`,
    { method: "POST" },
    true,
  );
}

/**
 * Get publication status (user)
 */
export async function getPublishStatus(datasetId: string): Promise<PublishStatusResponse> {
  return request<PublishStatusResponse>(`/datasets/${datasetId}/publish/status`, {}, true);
}

/**
 * Resend publication notification (user)
 */
export async function resendPublishNotification(datasetId: string): Promise<{ message: string }> {
  return request<{ message: string }>(
    `/datasets/${datasetId}/publish/resend`,
    { method: "POST" },
    true,
  );
}

/**
 * List publication requests (admin)
 */
export async function listPublishRequests(status?: string): Promise<PublishRequestsResponse> {
  const query = status ? `?status=${status}` : "";
  return request<PublishRequestsResponse>(`/admin/publish/requests${query}`, {}, true);
}

/**
 * Deny publication request (admin)
 */
export async function denyPublication(
  datasetId: string,
  reason: string,
): Promise<{ message: string }> {
  return request<{ message: string }>(
    `/admin/publish/${datasetId}/deny`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason }),
    },
    true,
  );
}

/**
 * Approve publication request (admin) - runs orchestrator
 */
export async function approvePublication(
  datasetId: string,
  resume = false,
  sandbox = false,
  skipCiCheck = false,
): Promise<PublishApproveResponse> {
  let s3_lock_offset: number | undefined;
  let result: PublishApproveResponse;

  // Loop to handle S3 lock pagination (CF Workers subrequest limit)
  do {
    result = await request<PublishApproveResponse>(
      `/admin/publish/${datasetId}/approve`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          resume,
          sandbox,
          s3_lock_offset,
          skip_ci_check: skipCiCheck,
        }),
      },
      true,
    );

    if (result.hasMore && result.s3_lock_offset !== undefined) {
      s3_lock_offset = result.s3_lock_offset;
    } else {
      break;
    }
  } while (result.hasMore);

  return result;
}

export interface S3LockResponse {
  message: string;
  dataset_id: string;
  locked: number;
  total: number;
  failed: string[];
  hasMore: boolean;
  offset: number;
}

// ============================================================================
// Enrichment
// ============================================================================

import type { NemarMetadata } from "../../shared/datacite-constants.js";
export type NemarMetadataPayload = NemarMetadata;

export interface SubmitEnrichmentResponse {
  message: string;
  dataset_id: string;
  committed: boolean;
  bidsignore_updated: boolean;
}

/**
 * Submit metadata enrichment for a dataset (admin only)
 * Commits nemar_metadata.json to the dataset repo and caches in D1.
 */
export async function submitEnrichment(
  datasetId: string,
  metadata: NemarMetadataPayload,
): Promise<SubmitEnrichmentResponse> {
  return request<SubmitEnrichmentResponse>(
    `/admin/datasets/${datasetId}/enrichment`,
    {
      method: "POST",
      body: JSON.stringify(metadata),
    },
    true,
  );
}

export interface DatasetFileInfo {
  path: string;
  size: number;
}

export interface DatasetFilesResponse {
  dataset_id: string;
  file_count: number;
  total_size: number;
  extensions: string[];
  files: DatasetFileInfo[];
}

/**
 * Get dataset file listing with sizes (admin only)
 */
export async function getDatasetFiles(datasetId: string): Promise<DatasetFilesResponse> {
  return request<DatasetFilesResponse>(`/admin/datasets/${datasetId}/files`, {}, true);
}

// ============================================================================
// S3 Management
// ============================================================================

export async function applyS3Lock(
  datasetId: string,
): Promise<{ locked: number; total: number; failed: string[] }> {
  let offset = 0;
  let totalLocked = 0;
  const allFailed: string[] = [];
  let total = 0;
  let hasMore = true;

  while (hasMore) {
    const result = await request<S3LockResponse>(
      `/admin/datasets/${datasetId}/s3-lock`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ offset }),
      },
      true,
    );

    totalLocked += result.locked;
    allFailed.push(...result.failed);
    total = result.total;
    hasMore = result.hasMore;

    if (hasMore) {
      offset += 40;
    }
  }

  return { locked: totalLocked, total, failed: allFailed };
}

// ---------------------------------------------------------------------------
// Dataset deletion
// ---------------------------------------------------------------------------

export interface DeleteDatasetResponse {
  datasetId: string;
  deleted: boolean;
  steps: {
    github: { success: boolean; error?: string };
    s3: { deleted: number; failed: Array<{ key: string; error: string }>; skipped?: boolean };
    d1: { success: boolean; versionsDeleted: number; pubRequestsDeleted: number; error?: string };
  };
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Test dataset reset
// ---------------------------------------------------------------------------

export interface ResetTestDatasetResponse {
  message: string;
  success: boolean;
  github_ssh_url: string;
  steps: { s3_deleted: number; github_recreated: boolean; d1_cleaned: boolean };
}

/**
 * Reset a test dataset to clean state (admin only, nm099999 only)
 */
export async function resetTestDataset(datasetId: string): Promise<ResetTestDatasetResponse> {
  return request<ResetTestDatasetResponse>(
    `/admin/datasets/${datasetId}/reset`,
    { method: "POST" },
    true,
  );
}

export async function deleteDataset(
  datasetId: string,
  force = false,
): Promise<DeleteDatasetResponse> {
  return request<DeleteDatasetResponse>(
    `/admin/datasets/${datasetId}`,
    {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ force }),
    },
    true,
  );
}

// ─── Import ─────────────────────────────────────────────────────────────────

export interface ImportDatasetResponse {
  dataset_id: string;
  name: string;
  github_repo: string;
  source: string;
  source_id: string;
}

export async function importDataset(opts: {
  dataset_id: string;
  name: string;
  description?: string;
  source: "openneuro";
  source_id: string;
}): Promise<ImportDatasetResponse> {
  return request<ImportDatasetResponse>(
    "/admin/datasets/import",
    {
      method: "POST",
      body: JSON.stringify(opts),
    },
    true,
  );
}
