/**
 * NEMAR API client: admin endpoints (users, repo/CI, DOI, lifecycle, imports,
 * reindex, fleet, email, broadcast, summary, manifest dispatch).
 *
 * Split from lib/api.ts by endpoint group (#908, epic #902); bodies moved
 * verbatim.
 */

import { request } from "./client.js";

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

// ─── Exemplar ───────────────────────────────────────────────────────────────
// Staging exemplar datasets (epic #923, Phase 5). See
// backend/src/routes/admin/exemplar.ts for the endpoint contract; both routes
// 403 in production (staging-only fleet).

export interface CreateExemplarResponse {
  dataset_id: string;
  name: string;
  github_repo: string;
  source: string;
  source_id: string;
}

export async function createExemplar(opts: {
  dataset_id: string;
  source_id: string;
  name?: string;
  description?: string;
}): Promise<CreateExemplarResponse> {
  return request<CreateExemplarResponse>(
    "/admin/datasets/exemplar",
    {
      method: "POST",
      body: JSON.stringify(opts),
    },
    true,
  );
}

export interface RemintExemplarDoisResponse {
  dataset_id: string;
  concept_doi: string;
  status: "reserved" | "public" | "unavailable";
  warnings?: string[];
}

export async function remintExemplarDois(datasetId: string): Promise<RemintExemplarDoisResponse> {
  return request<RemintExemplarDoisResponse>(
    `/admin/datasets/${datasetId}/exemplar/remint-dois`,
    { method: "POST" },
    true,
  );
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
  // Retry engine + blocklist columns (#969, epic #967 Phase 2; migration 0058).
  recovery_attempts: number;
  first_incomplete_at: string | null;
  next_retry_at: string | null;
  blocklisted: number;
  blocklist_reason: string | null;
  maintainer_notified_at: string | null;
  integrity_checked_at: string | null;
}

export interface ImportStatusResponse {
  imports: ImportJobRow[];
  total: number;
  by_status: Record<string, number>;
}

export async function getImportStatus(
  status?: string,
  blocklisted?: boolean,
): Promise<ImportStatusResponse> {
  const params = new URLSearchParams();
  if (status) params.set("status", status);
  if (blocklisted !== undefined) params.set("blocklisted", blocklisted ? "1" : "0");
  const q = params.toString();
  return request<ImportStatusResponse>(`/admin/imports${q ? `?${q}` : ""}`, {}, true);
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

export interface ImportVerifyResponse {
  dataset_id: string;
  complete: boolean;
  missingKeys: string[];
  zeroByteKeys: string[];
  expectedCount: number;
  presentCount: number;
}

export async function verifyImport(datasetId: string): Promise<ImportVerifyResponse> {
  return request(`/admin/imports/${datasetId}/verify`, { method: "POST" }, true);
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

/** One batch of the HED backfill sweep (#869 phase 3, `POST /admin/datasets/hed-sweep`). */
export interface HedSweepBatchResponse {
  processed: number;
  /** Classified has_hed=1 this batch. */
  withHed: number;
  /** Classified has_hed=0 (checked, no HED) this batch. */
  withoutHed: number;
  /** Could not classify (no dataset_description.json / probe error) -> NULL. */
  unknown: number;
  errors: { dataset_id: string; error: string }[];
  /** Datasets still unswept (hed_checked_at IS NULL); 0 when the sweep is done. */
  remaining: number | null;
}

/** Response of `?reset=1`: count of probed rows cleared back to unclassified. */
export interface HedSweepResetResponse {
  reset: number;
}

/** Run one bounded HED sweep batch (default 15, server-clamped to [1,30]). */
export async function hedSweep(options?: { limit?: number }): Promise<HedSweepBatchResponse> {
  const limit = options?.limit ?? 15;
  return request<HedSweepBatchResponse>(
    `/admin/datasets/hed-sweep?limit=${encodeURIComponent(String(limit))}`,
    { method: "POST", headers: { "Content-Type": "application/json" } },
    true,
  );
}

/** Clear every probed HED row so a corrected detector can re-sweep from scratch. */
export async function hedSweepReset(): Promise<HedSweepResetResponse> {
  return request<HedSweepResetResponse>(
    "/admin/datasets/hed-sweep?reset=1",
    { method: "POST", headers: { "Content-Type": "application/json" } },
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

/** Preferences plus whose they are (the backend echoes the resolved username). */
export type EmailPreferencesResult = EmailPreferences & { username?: string };

/** `targetUser` (owner-only) reads another user's preferences; omit for self. */
export async function getEmailPreferences(targetUser?: string): Promise<EmailPreferencesResult> {
  const qs = targetUser ? `?user=${encodeURIComponent(targetUser)}` : "";
  return request<EmailPreferencesResult>(`/admin/email-preferences${qs}`, {}, true);
}

/** `targetUser` (owner-only) updates another user's preferences; omit for self. */
export async function updateEmailPreferences(
  prefs: Partial<EmailPreferences>,
  targetUser?: string,
): Promise<EmailPreferencesResult> {
  const qs = targetUser ? `?user=${encodeURIComponent(targetUser)}` : "";
  return request<EmailPreferencesResult>(
    `/admin/email-preferences${qs}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(prefs),
    },
    true,
  );
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
