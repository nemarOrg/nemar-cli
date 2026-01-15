/**
 * NEMAR API Client
 *
 * Handles all communication with the NEMAR backend API.
 * All methods throw ApiError on failure for consistent error handling.
 */

import { getConfig } from "./config.js";

const DEFAULT_API_URL = "https://api.osc.earth/nemar";

/**
 * API error with status code and message
 */
export class ApiError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public details?: unknown
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * Get the API base URL from config or default
 */
function getApiUrl(): string {
  const config = getConfig();
  return config.apiUrl || DEFAULT_API_URL;
}

/**
 * Make an authenticated or unauthenticated API request
 */
async function request<T>(
  path: string,
  options: RequestInit = {},
  authenticated = false
): Promise<T> {
  const url = `${getApiUrl()}${path}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string>),
  };

  if (authenticated) {
    const config = getConfig();
    if (!config.apiKey) {
      throw new ApiError(401, "Not authenticated. Run 'nemar auth login' first.");
    }
    headers["Authorization"] = `Bearer ${config.apiKey}`;
  }

  let response: Response;
  try {
    response = await fetch(url, {
      ...options,
      headers,
    });
  } catch (fetchError) {
    // Network error - DNS resolution, connection refused, etc.
    throw new ApiError(
      0,
      `Network error: Could not connect to ${getApiUrl()}`,
      { originalError: fetchError instanceof Error ? fetchError.message : String(fetchError) }
    );
  }

  let data: Record<string, unknown>;
  try {
    data = (await response.json()) as Record<string, unknown>;
  } catch {
    // Response wasn't valid JSON
    throw new ApiError(
      response.status,
      `Invalid response from server (status ${response.status})`,
    );
  }

  if (!response.ok) {
    throw new ApiError(
      response.status,
      (data.error as string) || (data.message as string) || "Request failed",
      data.details
    );
  }

  return data as T;
}

// ============================================================================
// Authentication
// ============================================================================

export interface SignupRequest {
  username: string;
  email: string;
  password: string;
  github_username: string;
  description: string;
}

export interface SignupResponse {
  message: string;
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
    is_admin: boolean;
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

// ============================================================================
// User
// ============================================================================

export interface UserInfo {
  id: number;
  username: string;
  email: string;
  github_username: string;
  status: string;
  is_admin: boolean;
  created_at: string;
}

/**
 * Get current user info (requires authentication)
 */
export async function getCurrentUser(): Promise<UserInfo> {
  return request<UserInfo>("/users/me", {}, true);
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
  is_admin: number;
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
export async function listUsers(status?: string): Promise<UsersListResponse> {
  const query = status ? `?status=${status}` : "";
  return request<UsersListResponse>(`/admin/users${query}`, {}, true);
}

export interface ApproveResponse {
  message: string;
  user: {
    username: string;
    email: string;
    status: string;
  };
  api_key: string;
}

/**
 * Approve a pending user (admin only)
 */
export async function approveUser(username: string): Promise<ApproveResponse> {
  return request<ApproveResponse>(`/admin/approve/${username}`, {
    method: "POST",
  }, true);
}

/**
 * Revoke a user's access (admin only)
 */
export async function revokeUser(username: string): Promise<{ message: string }> {
  return request<{ message: string }>(`/admin/revoke/${username}`, {
    method: "POST",
  }, true);
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
  status: string;
  github_repo: string | null;
  concept_doi: string | null;
  created_at: string;
}

export interface DatasetsListResponse {
  datasets: Dataset[];
  count: number;
}

/**
 * List datasets
 */
export async function listDatasets(): Promise<DatasetsListResponse> {
  return request<DatasetsListResponse>("/datasets");
}

/**
 * Get a single dataset by ID
 */
export async function getDataset(datasetId: string): Promise<Dataset> {
  return request<Dataset>(`/datasets/${datasetId}`);
}

export interface CreateDatasetRequest {
  name: string;
  description?: string;
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
}

/**
 * Create a new dataset (requires authentication)
 * Returns dataset info including GitHub repo URL and S3 prefix
 */
export async function createDataset(data: CreateDatasetRequest): Promise<CreateDatasetResponse> {
  return request<CreateDatasetResponse>("/datasets", {
    method: "POST",
    body: JSON.stringify(data),
  }, true);
}

export interface FinalizeDatasetResponse {
  message: string;
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
  return request<FinalizeDatasetResponse>(`/datasets/${datasetId}/finalize`, {
    method: "POST",
  }, true);
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
}

export interface CreateConceptDoiResponse {
  message: string;
  concept_doi: string;
  zenodo_id: number;
  zenodo_url: string;
  setup_command: string;
  warning: string;
}

/**
 * Create concept DOI for a dataset (admin only)
 */
export async function createConceptDoi(
  datasetId: string,
  data: CreateConceptDoiRequest
): Promise<CreateConceptDoiResponse> {
  return request<CreateConceptDoiResponse>(`/admin/datasets/${datasetId}/doi/concept`, {
    method: "POST",
    body: JSON.stringify(data),
  }, true);
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
  data: PublishVersionDoiRequest
): Promise<PublishVersionDoiResponse> {
  return request<PublishVersionDoiResponse>(`/admin/datasets/${datasetId}/doi/publish`, {
    method: "POST",
    body: JSON.stringify(data),
  }, true);
}

export interface DoiInfoResponse {
  dataset_id: string;
  name: string;
  concept_doi: string | null;
  latest_version_doi: string | null;
  zenodo_concept_url: string | null;
  zenodo_latest_version_url: string | null;
}

/**
 * Get DOI info for a dataset (admin only)
 */
export async function getDoiInfo(datasetId: string): Promise<DoiInfoResponse> {
  return request<DoiInfoResponse>(`/admin/datasets/${datasetId}/doi`, {}, true);
}
