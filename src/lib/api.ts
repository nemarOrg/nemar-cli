/**
 * NEMAR API Client
 *
 * Handles all communication with the NEMAR backend API.
 * All methods throw ApiError on failure for consistent error handling.
 */

import { getConfig } from "./config.js";
import { printMaintenanceBanner } from "./maintenance-banner.js";
import { version } from "./version.js";

const DEFAULT_API_URL = "https://api.nemar.org";

/** ORCID identifier format: XXXX-XXXX-XXXX-XXXX (last char may be X) */
export const ORCID_REGEX = /^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/;

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
 */
export class ApiError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public details?: unknown,
    public step?: string,
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

export const IS_DEV_BUILD = DEFAULT_API_URL.includes("workers.dev");

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
    if (response.status === 503 && (data.mode === "read-only" || data.mode === "full")) {
      const message =
        typeof data.message === "string"
          ? data.message
          : "NEMAR is in maintenance mode. Please retry shortly.";
      const eta = typeof data.eta === "string" ? data.eta : null;
      const maintErr = new MaintenanceError(data.mode, message, eta, data.details);
      printMaintenanceBanner(maintErr);
      throw maintErr;
    }
    throw new ApiError(
      response.status,
      (data.error as string) || (data.message as string) || "Request failed",
      data.details,
      typeof data.step === "string" ? data.step : undefined,
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
 * Deploy CI workflows to a dataset repository (admin only).
 *
 * Returns immediately after the tree-batched commit; post-deploy
 * parseability validation lives in `validateCi()` (issue #472).
 */
export async function addCi(datasetId: string): Promise<AddCiResponse> {
  return request<AddCiResponse>(`/admin/datasets/${datasetId}/ci`, { method: "POST" }, true);
}

export interface ValidateCiResponse {
  dataset_id: string;
  /** Workflow basenames GitHub Actions could parse. */
  valid: string[];
  /** Deployed workflow basenames not listed by GitHub Actions — either a YAML
   *  parse error or transient indexing lag right after the deploy. */
  missing: string[];
  /** Transport / API errors from the listing call (5xx, network). The
   *  validation is best-effort; an error here doesn't fail the deploy. */
  errors: string[];
}

/**
 * One-shot parseability probe for the latest CI workflow deploy.
 * Callers (the CLI) handle the indexing-lag wait and retry locally so
 * the Worker's wall-clock budget stays out of the loop (issue #472).
 */
export async function validateCi(datasetId: string): Promise<ValidateCiResponse> {
  return request<ValidateCiResponse>(
    `/admin/datasets/${datasetId}/ci/validate`,
    { method: "POST" },
    true,
  );
}

export interface SyncCiResponse {
  dataset_id: string;
  checked: string[];
  changed: string[];
  added: string[];
  errors: string[];
  /** True iff a tree commit was actually made. */
  committed: boolean;
  /** True iff the workflow directory listing failed; treat result as
      "presence unknown" rather than "no workflows deployed." */
  list_failed: boolean;
}

/**
 * Sync deployed CI workflows to current templates (admin only).
 * Only writes files that drift or are missing.
 */
export async function syncCi(datasetId: string): Promise<SyncCiResponse> {
  return request<SyncCiResponse>(`/admin/datasets/${datasetId}/ci/sync`, { method: "POST" }, true);
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
   */
  visibility: "public" | "private";
  github_repo: string | null;
  concept_doi: string | null;
  created_at: string;
  // Catalog-enriched fields (from nemar_catalog JOIN or catalog-only)
  modalities?: string;
  participants?: number;
  tasks?: string;
  authors?: string;
  /** Free-text license string (e.g. "CC0", "CC-BY-4.0"), or "" when unknown.
      Added in #653; older backends omit it. The website derives a permissiveness
      tier from this for filtering/coloring. */
  license?: string;
  file_size?: number;
  file_size_formatted?: string;
  /** 'managed' = in D1 datasets table, 'catalog' = nemar.org only */
  source_type?: "managed" | "catalog";
  /** nemar.org sync status for managed datasets */
  nemar_sync_status?: string | null;
  /** DOI field from catalog (for catalog-only datasets) */
  doi?: string | null;
  /** Import source (e.g. "openneuro") */
  source?: string | null;
  /** Original ID at the source (e.g. "ds007315") */
  source_id?: string | null;
  /** Latest published version DOI tag (e.g. "1.0.0"), or null when no
      version has been minted yet. Added in v0.8.9; older backends omit it. */
  latest_version?: string | null;
}

export interface DatasetsListResponse {
  datasets: Dataset[];
  count: number;
  total_count: number;
  limit: number;
  offset: number;
  // Set by the backend when the list query degraded to a basic datasets-only
  // result (catalog/FTS table or consolidation column missing). When present,
  // filters were NOT applied and catalog datasets are NOT included (#646).
  fallback?: boolean;
  warning?: string;
}

export interface DatasetListFilters {
  mine?: boolean;
  search?: string;
  modality?: string;
  author?: string;
  task?: string;
  hasDoi?: boolean;
  recent?: number;
  /** Comma-separated license tiers (public, attribution, sharealike,
      noncommercial, noderiv, unknown), OR semantics. #653. */
  license?: string;
  sort?: "newest" | "oldest" | "name" | "participants" | "size";
  limit?: number;
  offset?: number;
  owner?: string;
}

export interface DatasetSearchResult {
  id: string;
  name: string;
  modalities: string;
  participants: number;
  doi: string;
  tasks: string;
  authors: string;
  score: number;
}

export interface DatasetSearchResponse {
  results: DatasetSearchResult[];
  count: number;
  method: "semantic" | "text" | "text_fallback" | "exact_id" | "unavailable";
  min_score?: number;
}

/**
 * Validate dataset object has correct status and visibility values
 * Throws error if validation fails
 */
export function validateDataset(data: unknown): Dataset {
  const d = data as Dataset;

  // Catalog-only records have null status; default to "active"
  if (!d.status) {
    d.status = "active";
  } else if (!["active", "archived", "deleted"].includes(d.status)) {
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
 * List datasets with optional filters
 */
export async function listDatasets(
  filters: DatasetListFilters = {},
): Promise<DatasetsListResponse> {
  const params = new URLSearchParams();
  if (filters.mine) params.set("mine", "true");
  if (filters.search) params.set("search", filters.search);
  if (filters.modality) params.set("modality", filters.modality);
  if (filters.author) params.set("author", filters.author);
  if (filters.task) params.set("task", filters.task);
  if (filters.license) params.set("license", filters.license);
  if (filters.hasDoi) params.set("has_doi", "true");
  if (filters.recent) params.set("recent", String(filters.recent));
  if (filters.sort) params.set("sort", filters.sort);
  if (filters.limit != null) params.set("limit", String(filters.limit));
  if (filters.offset != null) params.set("offset", String(filters.offset));
  if (filters.owner) params.set("owner", filters.owner);
  const query = params.toString() ? `?${params.toString()}` : "";
  const response = await request<DatasetsListResponse>(
    `/datasets${query}`,
    {},
    filters.mine ? true : "optional",
  );
  response.datasets = response.datasets.map(validateDataset);
  return response;
}

interface ResolveSourceResult {
  found: boolean;
  dataset_id?: string;
  name?: string;
  github_repo?: string | null;
  owner_username?: string;
}

/**
 * Resolve an OpenNeuro source ID (ds######) to its NEMAR counterpart
 */
export async function resolveSourceId(sourceId: string): Promise<ResolveSourceResult> {
  return request<ResolveSourceResult>(`/datasets/resolve/${sourceId}`, {}, "optional");
}

/**
 * Semantic dataset search
 */
export async function searchDatasets(
  query: string,
  filters: { modality?: string; limit?: number } = {},
): Promise<DatasetSearchResponse> {
  const params = new URLSearchParams({ q: query });
  if (filters.modality) params.set("modality", filters.modality);
  if (filters.limit) params.set("limit", String(filters.limit));
  return request<DatasetSearchResponse>(`/datasets/search?${params.toString()}`, {}, "optional");
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
  resumed: boolean;
  dataset: {
    id: string;
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
 * Download credentials share the exact STS-credentials shape as upload (#190);
 * the alias keeps the download return type self-documenting without duplicating
 * the interface.
 */
export type DownloadCredentialsResponse = UploadCredentialsResponse;

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
): Promise<DownloadCredentialsResponse> {
  return request<DownloadCredentialsResponse>(
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
  /**
   * "none"      - public dataset; nothing granted (already world-readable)
   * "requested" - private dataset; a pending request was queued for the owner
   */
  action: "none" | "requested";
  message: string;
  dataset_id: string;
  github_repo?: string;
}

/**
 * Request collaborator access to a dataset (requires authentication).
 * Publish-gated: public datasets grant nothing; private datasets queue a
 * request for the owner to approve.
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

export interface AccessRequest {
  username: string;
  github_username: string;
  status: "pending" | "approved" | "denied";
  created_at: string;
  decided_at: string | null;
}

export interface ListAccessRequestsResponse {
  dataset_id: string;
  status: string;
  requests: AccessRequest[];
  count: number;
}

/**
 * List access requests for a dataset (owner/admin only). Defaults to pending.
 */
export async function listAccessRequests(
  datasetId: string,
  status?: "pending" | "approved" | "denied",
): Promise<ListAccessRequestsResponse> {
  const qs = status ? `?status=${status}` : "";
  return request<ListAccessRequestsResponse>(
    `/datasets/${datasetId}/access-requests${qs}`,
    {},
    true,
  );
}

export interface DecideAccessRequestResponse {
  message: string;
  dataset_id: string;
  username: string;
}

/**
 * Approve a pending access request (owner/admin only).
 */
export async function approveAccessRequest(
  datasetId: string,
  username: string,
): Promise<DecideAccessRequestResponse> {
  return request<DecideAccessRequestResponse>(
    `/datasets/${datasetId}/access-requests/${username}/approve`,
    { method: "POST" },
    true,
  );
}

/**
 * Deny a pending access request (owner/admin only).
 */
export async function denyAccessRequest(
  datasetId: string,
  username: string,
): Promise<DecideAccessRequestResponse> {
  return request<DecideAccessRequestResponse>(
    `/datasets/${datasetId}/access-requests/${username}/deny`,
    { method: "POST" },
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
  block_reason?: string | null;
  // Present when status='blocked': link to the dataset repo's Actions tab so the
  // user can see the BIDS validation run (#428).
  ci_url?: string;
  // Non-blocking pre-screen advisory (#756): present when the screen flagged a
  // concern. The request is NOT blocked by this.
  advisory?: { source: "prescreen"; reasons: string[]; issue_url?: string };
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
    prescreen_status?: string | null;
    prescreen_reasons?: string | null;
    prescreen_issue_url?: string | null;
  }>;
  count: number;
}

export interface StepResult {
  step: string;
  status: "completed" | "failed" | "skipped";
  attempts: number;
  duration_ms: number;
  error?: string;
}

export interface PublishApproveResponse {
  message: string;
  dataset_id: string;
  status?: string;
  steps_completed?: string[];
  step_results?: StepResult[];
  error?: string;
  step?: string;
  hasMore?: boolean;
  /** S3 ListObjectsV2 continuation token returned by the server while
   *  streaming object-lock batches. The CLI threads it back unchanged on
   *  the next invocation until `hasMore` is false. Replaced the legacy
   *  `s3_lock_offset` field as of #385.
   */
  s3_lock_continuation_token?: string;
  /** Total object count under the dataset's `objects/` prefix, computed
   *  once on the first s3_lock call. The CLI threads it back via the
   *  request body on subsequent calls so progress reporting survives
   *  across Worker invocations. See #284.
   */
  s3_lock_total?: number;
  /** Number of objects locked in the most recent batch. The CLI sums
   *  these across pages to render a running total against `s3_lock_total`.
   */
  s3_lock_batch_count?: number;
  /** Legacy field — kept on the response type for back-compat but no
   *  longer populated by current servers. */
  s3_lock_offset?: number;
  /** Non-fatal warning(s) from the orchestrator (e.g. notify_user email
   *  failure, audit log failure). Publication succeeded; operator should
   *  review and follow up manually. Multiple warnings are joined with " | ". */
  warning?: string;
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
 * Info passed to `onRetry` when the orchestrator hits a transient failure
 * and the CLI is about to wait and re-invoke.
 */
export interface PublishRetryInfo {
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  step?: string;
  error: string;
}

/**
 * Progress information emitted by `approvePublication` while the
 * orchestrator runs. Two flavors:
 *   - step transitions: `step` advances and `s3LockLocked`/`s3LockTotal`
 *     are undefined.
 *   - s3_lock pagination: `step === "s3_lock"` and the counters are set
 *     after each batch response.
 *
 * `stepIndex` is 1-based against `stepTotal` so the CLI can render
 * "Step 14/17: s3 lock" without re-deriving from a step list.
 */
export interface PublishProgressInfo {
  /** Current step name as reported by the orchestrator (e.g. "s3_lock"). */
  step: string;
  /** 1-based position of this step in the orchestrator step list. */
  stepIndex: number;
  /** Total number of orchestrator steps. */
  stepTotal: number;
  /** Number of S3 objects locked so far across all pages this run. */
  s3LockLocked?: number;
  /** Total S3 objects to lock, once known. */
  s3LockTotal?: number;
  /**
   * True when emitting s3_lock progress after a Worker retry. The outer
   * retry loop (on 5xx/timeout) re-invokes the Worker with the persisted
   * continuation token so locking resumes from the right page; however
   * the visible counter can appear lower than the pre-retry value while
   * the new invocation re-accumulates its batches. Setting this flag lets
   * the CLI append "(resumed)" to the spinner line so the display is
   * honest rather than misleading. (#284)
   */
  s3LockResumed?: boolean;
}

/**
 * Ordered list of orchestrator step names, mirrored from
 * `backend/src/routes/admin.ts`. Used both for `stepIndex`/`stepTotal`
 * computation in `approvePublication` and to label progress in the CLI.
 *
 * The two lists must stay in sync; backend is the source of truth.
 */
export const PUBLICATION_STEPS = [
  "ci_check",
  "enrichment_check",
  "repo_public",
  "s3_public_read",
  "tag_protect",
  "doi_create",
  "update_metadata",
  "update_readme",
  "create_tag",
  "create_release",
  "upload_to_zenodo",
  "publish_doi",
  "version_doi",
  "s3_lock",
  "sync_nemar",
  "notify_user",
] as const;

/**
 * Resolve a step name to its 1-based index in `PUBLICATION_STEPS`, or
 * fall back to `stepsCompleted.length + 1` when the name isn't known
 * (defensive for future steps the CLI hasn't shipped a label for).
 */
export function stepIndexFor(step: string | undefined, stepsCompleted: string[] = []): number {
  if (step) {
    const idx = (PUBLICATION_STEPS as readonly string[]).indexOf(step);
    if (idx >= 0) return idx + 1;
  }
  return Math.min(stepsCompleted.length + 1, PUBLICATION_STEPS.length);
}

/**
 * Decide whether a failed `approvePublication` request is worth re-invoking
 * from a fresh Worker. The orchestrator persists progress in D1, so a
 * re-invocation skips already-completed steps and only re-attempts the one
 * that failed — that makes wait-and-retry safe and idempotent for the
 * transient failures admins actually see in practice:
 *
 *   - 5xx / 429 from the Worker itself or upstream services (EZID 503,
 *     Cloudflare "Too many subrequests by single Worker invocation",
 *     transient GitHub 5xx). In practice this is the dominant retry path:
 *     the orchestrator wraps every step failure as HTTP 500 with the
 *     upstream message in the body, so propagation 5xx and even GitHub's
 *     "Repository has been locked" 403 (re-wrapped as 500) match here.
 *   - Network-layer drops surfaced by the request helper as `statusCode === 0`
 *   - A bare HTTP 403 whose message still contains "repository has been
 *     locked" — defensive coverage for any future code path that returns
 *     the GitHub 403 directly without wrapping it in a 500.
 *
 * Real input errors (CI failure 422, sandbox-prefix rejection 400, missing
 * auth 401/403, dataset-not-found 404) are NOT retried — they will not fix
 * themselves with time and the admin needs to act.
 *
 * Exported for direct unit testing — kept as a pure predicate over
 * `ApiError` so the retry surface can be locked in by the test suite.
 */
export function isRetryablePublishError(err: unknown): boolean {
  if (!(err instanceof ApiError)) return false;
  if (err.statusCode === 0) return true;
  if (err.statusCode === 429) return true;
  if (err.statusCode >= 500 && err.statusCode < 600) return true;
  if (err.statusCode === 403 && /repository has been locked/i.test(err.message)) return true;
  return false;
}

/**
 * Approve publication request (admin) - runs orchestrator with
 * retry-with-delay across Worker invocations.
 *
 * The pipeline's flakiest steps (tag protection, EZID DOI mint, S3 Object
 * Lock) hit transient failures: GitHub propagation lag right after the
 * repo visibility flip, EZID rate limits, and Cloudflare per-invocation
 * subrequest limits. Inline retry inside a single Worker (`withRetry` in
 * the backend) made S3 Object Lock worse — each retry re-issued ~40 S3
 * PUTs in the same invocation and tripped CF's subrequest cap.
 *
 * Instead we drive retries from the CLI: each retry is a *fresh* Worker
 * invocation with a fresh subrequest budget, and the 10s gap between
 * attempts gives GitHub/EZID propagation a real chance to clear. The
 * orchestrator's persisted progress means the retry only re-runs the
 * failed step, not the whole pipeline.
 */
export async function approvePublication(
  datasetId: string,
  resume = false,
  sandbox = false,
  skipCiCheck = false,
  onRetry?: (info: PublishRetryInfo) => void,
  onProgress?: (info: PublishProgressInfo) => void,
): Promise<PublishApproveResponse> {
  const MAX_ATTEMPTS = 5;
  const RETRY_DELAY_MS = 10_000;

  let s3_lock_continuation_token: string | undefined;
  // Total object count for s3_lock — computed by the server on the first
  // s3_lock call and threaded back on every subsequent call so the
  // server doesn't have to re-count per page. See #284.
  let s3_lock_total: number | undefined;
  // Running locked-objects count accumulated across all hasMore=true pages
  // AND across outer retries. Kept at function scope so a Worker timeout
  // mid-s3_lock doesn't reset the counter to 0 on retry.
  let s3LockLocked = 0;
  // Set to true after the first outer-loop retry so s3_lock progress events
  // can carry the s3LockResumed flag — the spinner text can then say
  // "(resumed)" to clarify that the counter reflects pre-retry work plus
  // new batches from the fresh Worker, not a fresh start from 0. (#284)
  let s3LockIsResumed = false;
  let lastReportedStep: string | undefined;
  let useResume = resume;
  const accumulatedStepResults: StepResult[] = [];
  let lastError: unknown;

  /**
   * Emit a progress event whenever the orchestrator's reported step
   * changes (or s3_lock is making intra-step progress). Centralised so
   * step-only events and s3_lock-batch events share the same dedup logic.
   */
  function emitProgress(
    step: string,
    stepsCompleted: string[],
    s3Locked?: number,
    s3Total?: number,
  ) {
    if (!onProgress) return;
    onProgress({
      step,
      stepIndex: stepIndexFor(step, stepsCompleted),
      stepTotal: PUBLICATION_STEPS.length,
      s3LockLocked: s3Locked,
      s3LockTotal: s3Total,
      s3LockResumed: step === "s3_lock" && s3LockIsResumed ? true : undefined,
    });
  }

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      let result: PublishApproveResponse;
      // Inner loop handles S3 lock pagination (CF Workers ~50 subrequest
      // limit per invocation). On the first call, pass the caller's
      // `resume` flag so the orchestrator either starts fresh or resumes
      // from persisted progress. On subsequent iterations (S3 lock
      // batching) always pass resume=true so we skip already-completed
      // steps and only continue locking objects.
      let isFirstCall = true;
      do {
        result = await request<PublishApproveResponse>(
          `/admin/publish/${datasetId}/approve`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              resume: isFirstCall ? useResume : true,
              sandbox,
              s3_lock_continuation_token,
              s3_lock_total,
              skip_ci_check: skipCiCheck,
            }),
          },
          true,
        );
        isFirstCall = false;

        if (result.step_results) {
          accumulatedStepResults.push(...result.step_results);
        }

        // Cache the server-computed total so the next request doesn't
        // force a re-count. Server returns this in every s3_lock response.
        if (result.s3_lock_total !== undefined) {
          s3_lock_total = result.s3_lock_total;
        }
        // Accumulate locked count across pages. s3LockLocked is at
        // function scope so it persists across outer retries and the
        // counter never resets mid-stream. (#284)
        if (result.s3_lock_batch_count !== undefined) {
          s3LockLocked += result.s3_lock_batch_count;
        }

        // Emit progress when the current step changes or when s3_lock is
        // paging. `result.step` is populated on hasMore responses; on the
        // final non-paging response we fall back to the last completed
        // step in `step_results` so the caller sees the last transition.
        const currentStep =
          result.step ?? result.step_results?.[result.step_results.length - 1]?.step;
        if (currentStep && (currentStep !== lastReportedStep || currentStep === "s3_lock")) {
          emitProgress(
            currentStep,
            result.steps_completed ?? [],
            currentStep === "s3_lock" ? s3LockLocked : undefined,
            currentStep === "s3_lock" ? s3_lock_total : undefined,
          );
          lastReportedStep = currentStep;
        }

        if (result.hasMore && result.s3_lock_continuation_token !== undefined) {
          s3_lock_continuation_token = result.s3_lock_continuation_token;
        } else {
          break;
        }
      } while (result.hasMore);

      if (accumulatedStepResults.length > 0) {
        // Dedupe by step name, keeping the most recent entry. Without this,
        // a step that failed-then-succeeded across a retry boundary appears
        // twice in the post-publication summary (once failed, once
        // completed) and the admin can't trust the count.
        result.step_results = dedupeStepResults(accumulatedStepResults);
      }
      return result;
    } catch (err) {
      lastError = err;
      const lastAttempt = attempt === MAX_ATTEMPTS;
      if (lastAttempt || !isRetryablePublishError(err)) {
        if (err instanceof ApiError && accumulatedStepResults.length > 0) {
          // Attach the per-attempt step timeline to the thrown error so the
          // CLI handler can show the full retry history (which step failed
          // when, and how many attempts each took) instead of just the
          // final raw 500 message.
          (err as ApiError & { stepResults?: StepResult[] }).stepResults =
            dedupeStepResults(accumulatedStepResults);
        }
        throw err;
      }

      const apiErr = err as ApiError;
      onRetry?.({
        attempt,
        maxAttempts: MAX_ATTEMPTS,
        delayMs: RETRY_DELAY_MS,
        step: apiErr.step,
        error: apiErr.message,
      });

      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      // Anything that succeeded in the failed attempt is already persisted
      // in D1; the next attempt must resume to skip it.
      useResume = true;
      // If the failure happened during s3_lock (continuation token is set,
      // meaning we were mid-stream), mark subsequent s3_lock progress events
      // as resumed so the CLI can append "(resumed)" to the spinner line.
      // The counter (s3LockLocked) is kept from before the failure so the
      // display shows the true running total rather than appearing to restart.
      if (s3_lock_continuation_token !== undefined) {
        s3LockIsResumed = true;
      }
    }
  }

  throw lastError;
}

/**
 * Dedupe step results by step name, keeping the latest entry per step.
 * Used to collapse multi-attempt retry timelines into a single summary
 * where each step appears once with its final status.
 */
function dedupeStepResults(results: StepResult[]): StepResult[] {
  const byStep = new Map<string, StepResult>();
  for (const r of results) byStep.set(r.step, r);
  return Array.from(byStep.values());
}

export interface S3LockFailure {
  key: string;
  error: string;
}

export interface S3LockResponse {
  message: string;
  dataset_id: string;
  locked: number;
  failed: S3LockFailure[];
  hasMore: boolean;
  continuation_token?: string;
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
): Promise<{ locked: number; failed: S3LockFailure[] }> {
  let continuationToken: string | undefined;
  let totalLocked = 0;
  const allFailed: S3LockFailure[] = [];
  let hasMore = true;

  while (hasMore) {
    const result = await request<S3LockResponse>(
      `/admin/datasets/${datasetId}/s3-lock`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ continuation_token: continuationToken }),
      },
      true,
    );

    totalLocked += result.locked;
    if (result.failed?.length) allFailed.push(...result.failed);
    hasMore = result.hasMore;
    continuationToken = result.continuation_token;

    // Defensive guard: if the server says hasMore but doesn't return a
    // token, stop the loop instead of looping on undefined forever. The
    // server should never do this; if it does, surface the issue rather
    // than silently spin.
    if (hasMore && !continuationToken) {
      throw new ApiError(
        500,
        "S3 lock paginated response missing continuation_token; aborting to avoid infinite loop",
      );
    }
  }

  return { locked: totalLocked, failed: allFailed };
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

export interface BulkDeleteResponse {
  deleted: number;
  failed: number;
  results: Array<{ dataset_id: string; deleted: boolean; error?: string }>;
}

export async function bulkDeleteDatasets(datasetIds: string[]): Promise<BulkDeleteResponse> {
  return request<BulkDeleteResponse>(
    "/admin/datasets/bulk-delete",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dataset_ids: datasetIds }),
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

// ============================================================================
// Admin - nemar.org Datapipeline Sync
// ============================================================================

export interface SyncDatasetResponse {
  dataset_id: string;
  synced: boolean;
  errors: string[];
}

export interface SyncStatusResponse {
  datasets: Array<{
    dataset_id: string;
    name: string;
    nemar_sync_status: string | null;
    nemar_sync_at: string | null;
    nemar_sync_error: string | null;
  }>;
  total: number;
  synced: number;
  failed: number;
  pending: number;
}

export async function syncDataset(datasetId: string): Promise<SyncDatasetResponse> {
  return request<SyncDatasetResponse>(
    `/admin/datasets/${datasetId}/sync`,
    { method: "POST" },
    true,
  );
}

export async function getSyncStatus(): Promise<SyncStatusResponse> {
  return request<SyncStatusResponse>("/admin/sync/status", {}, true);
}

// ============================================================================
// Import jobs (issue #754)
// ============================================================================

export interface ImportJobRow {
  dataset_id: string;
  source: string;
  source_id: string;
  stage: string;
  status: string;
  last_error: string | null;
  workflow_run_url: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface ImportStatusResponse {
  imports: ImportJobRow[];
  total: number;
  by_status: Record<string, number>;
}

export async function getImportStatus(status?: string): Promise<ImportStatusResponse> {
  const q = status ? `?status=${encodeURIComponent(status)}` : "";
  return request<ImportStatusResponse>(`/admin/imports${q}`, {}, true);
}

export async function rollbackImport(
  datasetId: string,
): Promise<{ ok: boolean; dataset_id: string; rolled_back: boolean; warnings: string[] }> {
  return request(`/admin/imports/${datasetId}/rollback`, { method: "POST" }, true);
}

export async function retryImport(
  datasetId: string,
): Promise<{ ok: boolean; dataset_id: string; status: string }> {
  return request(`/admin/imports/${datasetId}/retry`, { method: "POST" }, true);
}

// ============================================================================
// Reindex (epic #417 phase 3)
// ============================================================================

export interface ReindexOptions {
  skip_enrichment?: boolean;
  skip_sync?: boolean;
  ref?: string;
}

export interface ReindexResponse {
  dataset_id: string;
  enrichment: { status: "ok" | "failed" | "skipped"; ref?: string; error?: string };
  sync: {
    status: "ok" | "failed" | "skipped";
    errors?: string[];
    metadata_columns_written?: boolean;
    metadata_columns_error?: string;
  };
}

export type ReindexFilter = "all" | "missing-metadata" | "stale";

export interface ReindexBulkOptions {
  older_than_days?: number;
  skip_enrichment?: boolean;
  skip_sync?: boolean;
  dry_run?: boolean;
}

export interface ReindexBulkResponse {
  filter: ReindexFilter;
  total: number;
  elapsed_ms: number;
  /** Populated only when dry_run=true. */
  dry_run?: boolean;
  /** Populated only when dry_run=true. */
  datasets?: string[];
  /** Populated only when dry_run is false or absent. */
  results?: ReindexResponse[];
}

export async function reindexDataset(
  datasetId: string,
  options?: ReindexOptions,
): Promise<ReindexResponse> {
  return request<ReindexResponse>(
    `/admin/datasets/${datasetId}/reindex`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(options ?? {}),
    },
    true,
  );
}

export async function reindexBulk(
  filter: ReindexFilter,
  options?: ReindexBulkOptions,
): Promise<ReindexBulkResponse> {
  return request<ReindexBulkResponse>(
    "/admin/datasets/reindex/bulk",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filter, ...(options ?? {}) }),
    },
    true,
  );
}

// ============================================================================
// Fleet governance (epic #713)
// ============================================================================

export interface FleetDriftResponse {
  scanned: number;
  limit: number;
  counts: Record<string, number>;
  buckets: Record<string, string[]>;
  repos: Array<{ dataset_id: string; buckets: string[] }>;
}

export async function getFleetDrift(opts?: {
  prefix?: string;
  visibility?: "public" | "private";
  limit?: number;
}): Promise<FleetDriftResponse> {
  const qs = new URLSearchParams();
  if (opts?.prefix) qs.set("prefix", opts.prefix);
  if (opts?.visibility) qs.set("visibility", opts.visibility);
  if (opts?.limit) qs.set("limit", String(opts.limit));
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  return request<FleetDriftResponse>(`/admin/fleet/drift${suffix}`, {}, true);
}

export interface EnforceResponse {
  dataset_id: string;
  dry_run: boolean;
  result: {
    visibility: string;
    defaultBranch: string;
    steps: Record<string, { status: string; detail?: string }>;
  };
}

export async function enforceDataset(datasetId: string, dryRun: boolean): Promise<EnforceResponse> {
  return request<EnforceResponse>(
    `/admin/datasets/${datasetId}/enforce`,
    { method: "POST", body: JSON.stringify({ dry_run: dryRun }) },
    true,
  );
}

export interface EnforceBulkResponse {
  dry_run: boolean;
  count: number;
  results: Array<{
    dataset_id: string;
    steps?: Record<string, { status: string; detail?: string }>;
    error?: string;
  }>;
}

export async function enforceBulk(opts: {
  prefix?: string;
  visibility?: "public" | "private";
  limit?: number;
  dryRun: boolean;
}): Promise<EnforceBulkResponse> {
  return request<EnforceBulkResponse>(
    "/admin/datasets/enforce/bulk",
    {
      method: "POST",
      body: JSON.stringify({
        prefix: opts.prefix,
        visibility: opts.visibility,
        limit: opts.limit,
        dry_run: opts.dryRun,
      }),
    },
    true,
  );
}

export interface RevalidateResponse {
  dataset_id: string;
  head_sha: string | null;
  triggered_by?: "sync" | "dispatch";
  skipped?: string;
}

export async function revalidateDataset(
  datasetId: string,
  force = false,
): Promise<RevalidateResponse> {
  const qs = force ? "?force=true" : "";
  return request<RevalidateResponse>(
    `/admin/datasets/${datasetId}/revalidate${qs}`,
    { method: "POST" },
    true,
  );
}

// ============================================================================
// Email Preferences
// ============================================================================

export interface EmailPreferences {
  user_approval: boolean;
  publication_request: boolean;
  announcements: boolean;
}

export async function getEmailPreferences(): Promise<EmailPreferences> {
  return request<EmailPreferences>("/admin/email-preferences", {}, true);
}

export async function updateEmailPreferences(
  prefs: Partial<EmailPreferences>,
): Promise<EmailPreferences> {
  return request<EmailPreferences>(
    "/admin/email-preferences",
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(prefs),
    },
    true,
  );
}

// ============================================================================
// Notices
// ============================================================================

export interface Notice {
  id: number;
  message: string;
  level: "info" | "warning" | "critical";
  scope: "all" | "admins" | "members";
  created_at: string;
  expires_at: string | null;
}

/**
 * Get active notices for the current user's role (optional auth)
 */
export async function getNotices(): Promise<{ notices: Notice[] }> {
  return request<{ notices: Notice[] }>("/notices", {}, "optional");
}

/**
 * List all notices including expired (admin only)
 */
export async function listAdminNotices(): Promise<{ notices: Notice[] }> {
  return request<{ notices: Notice[] }>("/admin/notices", {}, true);
}

/**
 * Create a notice (admin only)
 */
export async function createNotice(data: {
  message: string;
  level?: string;
  scope?: string;
  expires_at?: string;
}): Promise<Notice> {
  return request<Notice>(
    "/admin/notices",
    {
      method: "POST",
      body: JSON.stringify(data),
    },
    true,
  );
}

/**
 * Delete a notice (admin only)
 */
export async function deleteNotice(id: number): Promise<{ message: string }> {
  return request<{ message: string }>(`/admin/notices/${id}`, { method: "DELETE" }, true);
}

// ============================================================================
// Broadcast
// ============================================================================

export interface BroadcastResponse {
  broadcast_id: number;
  recipient_count: number;
  failure_count: number;
  failed_recipients: string[];
}

export interface BroadcastDryRunResponse {
  dry_run: true;
  recipient_group: string;
  recipient_count: number;
  recipients: string[];
}

/**
 * Send broadcast email to a user group or a single user (admin only).
 *
 * `to` and `user` are mutually exclusive; provide exactly one.
 */
export async function sendBroadcast(data: {
  to?: string;
  user?: string;
  subject: string;
  body: string;
  dry_run?: boolean;
}): Promise<BroadcastResponse | BroadcastDryRunResponse> {
  return request<BroadcastResponse | BroadcastDryRunResponse>(
    "/admin/notify",
    {
      method: "POST",
      body: JSON.stringify(data),
    },
    true,
  );
}

// ============================================================================
// Summary coverage (epic #618 / phase 2 #620)
// ============================================================================

export type SummarySchemaState =
  | { kind: "ok"; schema_version: string }
  | { kind: "stale"; schema_version: string }
  | { kind: "missing" }
  | { kind: "error"; status: number; message: string };

export interface SummaryVersionCoverage {
  dataset_id: string;
  version: string;
  doi: string;
  concept_doi: string | null;
  state: SummarySchemaState;
}

export interface SummaryCoverageReport {
  generated_at: string;
  target_schema: string;
  totals: {
    versions: number;
    ok: number;
    stale: number;
    missing: number;
    error: number;
  };
  versions: SummaryVersionCoverage[];
}

export async function getSummaryCoverage(): Promise<SummaryCoverageReport> {
  return request<SummaryCoverageReport>("/admin/summary/coverage", {}, true);
}

export interface DispatchManifestResponse {
  dispatched: boolean;
  dataset_id: string;
  version: string;
}

export async function dispatchManifest(
  datasetId: string,
  version: string,
  options?: { skipCanary?: boolean },
): Promise<DispatchManifestResponse> {
  return request<DispatchManifestResponse>(
    "/admin/manifest/dispatch",
    {
      method: "POST",
      body: JSON.stringify({
        dataset_id: datasetId,
        version,
        skip_canary: options?.skipCanary ?? false,
      }),
    },
    true,
  );
}
