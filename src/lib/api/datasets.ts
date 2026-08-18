/**
 * NEMAR API client: dataset catalog, manifests, access/collaborators, and
 * enrichment endpoints.
 *
 * Split from lib/api.ts by endpoint group (#908, epic #902); bodies moved
 * verbatim.
 */

import { request } from "./client.js";

/** ORCID identifier format: XXXX-XXXX-XXXX-XXXX (last char may be X) */
export const ORCID_REGEX = /^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/;

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
  /** DOI field from catalog (for catalog-only datasets) */
  doi?: string | null;
  /** Import source (e.g. "openneuro") */
  source?: string | null;
  /** Original ID at the source (e.g. "ds007315") */
  source_id?: string | null;
  /** Latest published version DOI tag (e.g. "1.0.0"), or null when no
      version has been minted yet. Added in v0.8.9; older backends omit it. */
  latest_version?: string | null;
  /** HED presence of the latest version (#869): 1 = has HED, 0 = checked/none,
      null = not classified yet. Older backends omit it. */
  has_hed?: number | null;
  /** Declared HEDVersion of the latest version (#869), or null. */
  hed_version?: string | null;
  /** Honest total file count (#970: manifest-first, S3-sum fallback for
      pre-manifest datasets). Older backends omit it. */
  total_files?: number | null;
  /** Data completeness of the latest version (#970): 1 = every annex-keyed
      manifest entry verified present at its declared size, 0 = incomplete
      (the #967 signature), null = not audited yet. Older backends omit it. */
  data_complete?: number | null;
  /** Actual bytes present in S3 (#970) -- distinct from file_size when
      data_complete=0. */
  bytes_present?: number | null;
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
  /** Only datasets with HED annotations (#869). Serialized as has_hed=1. */
  hasHed?: boolean;
  /** Only datasets verified data-complete (#970). Serialized as data_complete=1. */
  dataComplete?: boolean;
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
  /** HED presence (#869): 1 = has HED, 0 = checked/none, null = not classified. */
  has_hed?: number | null;
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
  if (filters.hasHed) params.set("has_hed", "1");
  if (filters.dataComplete) params.set("data_complete", "1");
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
  filters: { modality?: string; limit?: number; hasHed?: boolean } = {},
): Promise<DatasetSearchResponse> {
  const params = new URLSearchParams({ q: query });
  if (filters.modality) params.set("modality", filters.modality);
  if (filters.limit) params.set("limit", String(filters.limit));
  if (filters.hasHed) params.set("has_hed", "1");
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
  // Deposit attestation (#1077): recorded on the dataset row (migration 0067).
  // Optional at the wire level for older CLIs; collected for every new upload.
  attestation?: {
    deposit_type: "owner" | "redistribution";
    key_status: "destroyed" | "retained";
    deidentified: true;
    no_duplicate?: boolean;
    upstream_source?: string;
  };
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
// Enrichment
// ============================================================================

import type { NemarMetadata } from "../../../shared/datacite-constants.js";
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
