/**
 * NEMAR API client: admin endpoints (users, repo/CI, DOI, lifecycle, imports,
 * reindex, fleet, email, broadcast, summary, manifest dispatch).
 *
 * Split from lib/api.ts by endpoint group (#908, epic #902); bodies moved
 * verbatim.
 */

import {
  type AdminUserListItem,
  type AdminUsersListResponse,
  adminUsersListResponseSchema,
} from "../../../shared/contract/index.js";
import { request } from "./client.js";

// ============================================================================
// Admin
// ============================================================================

/**
 * Wire shapes for GET /admin/users live in shared/contract/user.ts and are
 * VALIDATED on the way in (below), not merely asserted with a cast. The
 * hand-written interface these replaced declared `service_access: number` and
 * `username: string`, neither of which the endpoint guarantees — a cast makes
 * both drifts invisible, which is the getCurrentUser bug (#899) in a new place.
 */
export type UserListItem = AdminUserListItem;
export type UsersListResponse = AdminUsersListResponse;

/**
 * The upload tier of a listed account (ADR 0040). Three states, not two:
 * `unknown` is a backend that did not report `service_access` at all (deployed
 * before #1251, or a rolling deploy mid-flight), and must not be shown or
 * filtered as "browse" — telling an uploader they have no upload access sends
 * them to an admin to ask for something they already hold.
 */
export type UploadTier = "upload" | "browse" | "unknown";

export function uploadTierOf(user: Pick<UserListItem, "service_access">): UploadTier {
  if (user.service_access === undefined || user.service_access === null) return "unknown";
  return user.service_access ? "upload" : "browse";
}

/**
 * List users (admin only)
 */
export async function listUsers(status?: string, role?: string): Promise<UsersListResponse> {
  const params = new URLSearchParams();
  if (status) params.set("status", status);
  if (role) params.set("role", role);
  const query = params.toString() ? `?${params.toString()}` : "";
  return request(`/admin/users${query}`, {}, true, adminUsersListResponseSchema);
}

export interface ApproveResponse {
  message: string;
  /**
   * Present only on the repair path: the account was already `approved` but
   * carried no upload grant, so only the grant was written (ADR 0040).
   */
  note?: string;
  user: {
    id: number;
    // NULL for web/ORCID accounts (they have no username by design).
    username: string | null;
    email: string;
    status: string;
    /** Approval grants upload access; always true on a 200 (ADR 0040). */
    service_access?: boolean;
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
 * Approve a user by their numeric id (admin only). Needed for web/ORCID
 * accounts, which have username = NULL and so cannot be addressed by the
 * username-keyed endpoint (#1012).
 */
export async function approveUserById(id: number): Promise<ApproveResponse> {
  return request<ApproveResponse>(
    `/admin/approve/by-id/${id}`,
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
 * Publish a dataset (make public) - admin only
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
  /** Always "ezid" since #1182 (ADR 0007); kept for older backends. */
  doi_provider: "ezid" | "zenodo";
  zenodo_concept_url: string | null;
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
// Withdrawal / restore (epic #967 phase 4, #971)
//
// NOTE (tracked, not fixed here -- #937): these wire types are hand-
// duplicated against backend/src/services/withdraw.ts rather than sourced
// from shared/contract, same as most of this file's other endpoints. The
// @nemar/contract migration is a separate tracked follow-up.
// ---------------------------------------------------------------------------

export interface DoiStepResult {
  doi: string;
  kind: "concept" | "version";
  version?: string;
  action: "unavailable" | "public";
  status: "planned" | "ok" | "failed";
  error?: string;
}

/** Mirrors services/visibility.ts's VisibilityTransitionResult failure branch
 *  (minus the `ok` discriminant) so the CLI can render exactly which surface
 *  (GitHub/S3/D1) desynced instead of a flattened error string. */
export type VisibilityStepResult =
  | { status: "planned" }
  | { status: "ok" }
  | { status: "failed"; stage: "not_found" | "no_repo" | "invalid_repo" | "github"; error: string }
  | { status: "failed"; stage: "s3"; error: string; githubReverted: boolean; revertError?: string }
  | {
      status: "failed";
      stage: "db";
      error: string;
      githubReverted: boolean;
      s3Reverted: boolean;
      revertError?: string;
    };

/** Discriminated on `skipped`: exactly one of the two shapes, mirroring
 *  backend/src/services/withdraw.ts's DatasetTransitionResult. withdraw and
 *  restore share this one name (rather than separate Withdraw/Restore
 *  aliases) since the shapes are otherwise identical. */
export type DatasetTransitionResponse =
  | { dataset_id: string; dry_run: boolean; skipped: string; resumed?: boolean }
  | {
      dataset_id: string;
      dry_run: boolean;
      resumed?: boolean;
      visibility: VisibilityStepResult;
      dois: DoiStepResult[];
      warning?: string;
    };

/**
 * Withdraw a published dataset: make it private and tombstone its concept +
 * version EZID DOIs. `dryRun` defaults to true server-side; pass `false` to
 * execute (requires `reason`).
 */
export async function withdrawDataset(
  datasetId: string,
  opts: { reason?: string; dryRun: boolean },
): Promise<DatasetTransitionResponse> {
  return request<DatasetTransitionResponse>(
    `/admin/datasets/${datasetId}/withdraw`,
    {
      method: "POST",
      body: JSON.stringify({ reason: opts.reason, dry_run: opts.dryRun }),
    },
    true,
  );
}

/**
 * Reverse a withdrawal: make the dataset public again and restore its
 * concept + version EZID DOIs. `dryRun` defaults to true server-side.
 */
export async function restoreDataset(
  datasetId: string,
  opts: { dryRun: boolean },
): Promise<DatasetTransitionResponse> {
  return request<DatasetTransitionResponse>(
    `/admin/datasets/${datasetId}/restore`,
    {
      method: "POST",
      body: JSON.stringify({ dry_run: opts.dryRun }),
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
  /**
   * Imported datasets that have since been withdrawn. NOT a value of
   * `by_status` -- withdrawal is orthogonal to the import lifecycle, and these
   * rows are counted inside `by_status.complete` because their import did
   * succeed. Optional: older backends omit it (#1048).
   */
  withdrawn?: number;
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

/**
 * Push `next_retry_at` forward for datasets `recover --execute` just
 * dispatched out-of-band, so the Phase-2 retry cron doesn't re-dispatch the
 * same onboard-openneuro.yml run on its next tick (#981).
 */
export async function dispatchCooldown(datasetIds: string[]): Promise<{ updated: number }> {
  return request(
    "/admin/imports/dispatch-cooldown",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dataset_ids: datasetIds }),
    },
    true,
  );
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
  /** Datasets still unswept (no `$.hed_checked_at` in sweep_stamps); 0 when done. */
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

/** One batch of the recording-stats backfill sweep (migration 0070, epic
 *  #1144 Phase 2, issue #1146, `POST /admin/datasets/recording-stats-sweep`). */
export interface RecordingStatsSweepBatchResponse {
  processed: number;
  /** Candidates whose zarr index yielded at least one measured recording. */
  measured: number;
  /** Candidates whose zarr index existed but had no measured recordings. */
  unmeasured: number;
  errors: { dataset_id: string; error: string }[];
  /** Datasets still unswept; 0 when done, null if the count query failed. */
  remaining: number | null;
}

/** Response of `?reset=1`: count of stamped rows cleared back to unswept. */
export interface RecordingStatsSweepResetResponse {
  reset: number;
}

/** Run one bounded recording-stats sweep batch (default 50, server-clamped to [1,200]). */
export async function recordingStatsSweep(options?: {
  limit?: number;
}): Promise<RecordingStatsSweepBatchResponse> {
  const limit = options?.limit ?? 50;
  return request<RecordingStatsSweepBatchResponse>(
    `/admin/datasets/recording-stats-sweep?limit=${encodeURIComponent(String(limit))}`,
    { method: "POST", headers: { "Content-Type": "application/json" } },
    true,
  );
}

/** Clear every stamped recording-stats row so a corrected aggregator can re-sweep from scratch. */
export async function recordingStatsSweepReset(): Promise<RecordingStatsSweepResetResponse> {
  return request<RecordingStatsSweepResetResponse>(
    "/admin/datasets/recording-stats-sweep?reset=1",
    { method: "POST", headers: { "Content-Type": "application/json" } },
    true,
  );
}

/** One batch of the signal-defaults backfill sweep (migrations 0072/0073, epic
 *  #1144 Phase 2b, issue #1153, `POST /admin/datasets/signal-defaults-sweep`). */
export interface SignalDefaultsSweepBatchResponse {
  processed: number;
  /** Candidates whose probe found at least one usable sidecar key and wrote it. */
  populated: number;
  /** Candidates whose probe completed but found nothing to write. */
  noData: number;
  errors: { dataset_id: string; error: string }[];
  /** Datasets still unswept; 0 when done, null if the count query failed. */
  remaining: number | null;
}

/** Response of `?reset=1`: count of stamped rows cleared back to unswept. */
export interface SignalDefaultsSweepResetResponse {
  reset: number;
}

/** Run one bounded signal-defaults sweep batch (default 15, server-clamped to [1,30]). */
export async function signalDefaultsSweep(options?: {
  limit?: number;
}): Promise<SignalDefaultsSweepBatchResponse> {
  const limit = options?.limit ?? 15;
  return request<SignalDefaultsSweepBatchResponse>(
    `/admin/datasets/signal-defaults-sweep?limit=${encodeURIComponent(String(limit))}`,
    { method: "POST", headers: { "Content-Type": "application/json" } },
    true,
  );
}

/** Clear every stamped signal-defaults row so a corrected probe can re-sweep from scratch. */
export async function signalDefaultsSweepReset(): Promise<SignalDefaultsSweepResetResponse> {
  return request<SignalDefaultsSweepResetResponse>(
    "/admin/datasets/signal-defaults-sweep?reset=1",
    { method: "POST", headers: { "Content-Type": "application/json" } },
    true,
  );
}

/** One batch of the data-integrity sweep (epic #967 Phase 3, #970,
 *  `POST /admin/datasets/data-integrity-sweep`). */
export interface DataIntegritySweepBatchResponse {
  processed: number;
  /** Verified complete (every annex-keyed manifest entry present at declared size). */
  complete: number;
  /** Verified incomplete this batch -- the #967 signature. */
  incomplete: number;
  /** Could not verify (no manifest / verify error) -> data_complete stays NULL. */
  unknown: number;
  errors: { dataset_id: string; error: string }[];
  /** Datasets still unaudited (or stale past --older-than); 0 when the sweep is done. */
  remaining: number | null;
}

/** Response of `?reset=1`: count of audited rows cleared back to unclassified. */
export interface DataIntegritySweepResetResponse {
  reset: number;
}

/** Run one bounded data-integrity sweep batch (default 15, server-clamped to
 *  [1,30]). `olderThan` widens candidacy to already-checked rows past N days
 *  for periodic re-audit (moving window, never converges to 0 on its own).
 *  `before` widens candidacy to an ANCHORED ISO8601 cutoff instead (#980) --
 *  pass the SAME timestamp on every call in a loop and `remaining` strictly
 *  decreases to 0, unlike `olderThan`. Omit both for the one-shot
 *  never-checked drain. */
export async function dataIntegritySweep(options?: {
  limit?: number;
  olderThan?: number;
  before?: string;
}): Promise<DataIntegritySweepBatchResponse> {
  const limit = options?.limit ?? 15;
  const params = new URLSearchParams({ limit: String(limit) });
  if (options?.olderThan != null) params.set("older-than", String(options.olderThan));
  if (options?.before != null) params.set("before", options.before);
  return request<DataIntegritySweepBatchResponse>(
    `/admin/datasets/data-integrity-sweep?${params.toString()}`,
    { method: "POST", headers: { "Content-Type": "application/json" } },
    true,
  );
}

/** Clear every audited row so a corrected verifier can re-sweep from scratch. */
export async function dataIntegritySweepReset(): Promise<DataIntegritySweepResetResponse> {
  return request<DataIntegritySweepResetResponse>(
    "/admin/datasets/data-integrity-sweep?reset=1",
    { method: "POST", headers: { "Content-Type": "application/json" } },
    true,
  );
}

// ============================================================================
// Availability report (epic #999 Phase 1, #1000)
// ============================================================================

/** One manifest path whose declared annex key is not present in S3 at its
 *  declared size. Keyed by path (not annex key): git-annex is
 *  content-addressed, so two distinct paths can share one key (repeated
 *  calibration/empty-room/identical-stimulus files are common in BIDS). */
export interface AvailabilityReportMissingEntry {
  path: string;
  key: string;
  declared_size: number;
  reason: "zero_byte" | "absent";
}

export interface AvailabilityReportCompleteness {
  files_present: number;
  files_declared: number;
  bytes_present: number;
  bytes_declared: number;
  /** bytes_present / bytes_declared, or null whenever bytes_declared is not
   *  > 0 (a 0-declared-bytes dataset, with or without a manifest). */
  pct_bytes: number | null;
}

/** `.nemar/availability-report.json` shape (mirrors
 *  backend/src/services/availability-report.ts's AvailabilityReport). */
export interface AvailabilityReport {
  dataset_id: string;
  version: string | null;
  generated_at: string;
  source: { type: string; id: string } | null;
  complete: boolean;
  completeness: AvailabilityReportCompleteness;
  missing: AvailabilityReportMissingEntry[];
  blocklist_reason?: string;
}

/** `POST /admin/datasets/:id/availability-report` response: the bare report
 *  on a dry run, or `{ written: true, report }` once it's committed. */
export type AvailabilityReportResult =
  | AvailabilityReport
  | { written: true; report: AvailabilityReport };

/**
 * Generate a dataset's availability report. Dry-run by default (server-side
 * `?dry_run=1`, returns the report without committing it); pass
 * `{ write: true }` to commit it to `.nemar/availability-report.json` on the
 * repo's `main` branch.
 */
export async function availabilityReport(
  datasetId: string,
  opts?: { write?: boolean },
): Promise<AvailabilityReportResult> {
  const query = opts?.write ? "" : "?dry_run=1";
  return request<AvailabilityReportResult>(
    `/admin/datasets/${datasetId}/availability-report${query}`,
    { method: "POST", headers: { "Content-Type": "application/json" } },
    true,
  );
}

/** One batch of the availability-report backfill sweep (epic #999 phase 2,
 *  #1001, `POST /admin/datasets/availability-report-sweep`). */
export interface AvailabilityReportSweepBatchResponse {
  processed: number;
  /** Successfully generated + committed this batch. */
  written: number;
  errors: { dataset_id: string; error: string }[];
  /** Datasets still unswept (no `$.availability_report_at` in sweep_stamps); 0 when done. */
  remaining: number | null;
}

/** Response of `?reset=1`: count of stamped rows cleared back to unswept. */
export interface AvailabilityReportSweepResetResponse {
  reset: number;
}

/** Run one bounded availability-report sweep batch (default 30,
 *  server-clamped to [1,30]). Each candidate does a GitHub commit, so the
 *  server clamp is the real bound -- asking for more just gets 30.
 *  `missingOnly` narrows candidacy to datasets already known incomplete
 *  (data_complete = 0). */
export async function availabilityReportSweep(options?: {
  limit?: number;
  missingOnly?: boolean;
}): Promise<AvailabilityReportSweepBatchResponse> {
  const limit = options?.limit ?? 30;
  const params = new URLSearchParams({ limit: String(limit) });
  if (options?.missingOnly) params.set("missing-only", "1");
  return request<AvailabilityReportSweepBatchResponse>(
    `/admin/datasets/availability-report-sweep?${params.toString()}`,
    { method: "POST", headers: { "Content-Type": "application/json" } },
    true,
  );
}

/** Clear every stamped row so a corrected report generator can re-sweep from scratch. */
export async function availabilityReportSweepReset(): Promise<AvailabilityReportSweepResetResponse> {
  return request<AvailabilityReportSweepResetResponse>(
    "/admin/datasets/availability-report-sweep?reset=1",
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

// ============================================================================
// Doctor (diagnostic checks + remediation, #1130)
// ============================================================================

/** One dataset/version exhibiting a check's problem. */
export interface DoctorFinding {
  dataset_id: string;
  version?: string;
  details?: Record<string, unknown>;
}

/** Response of `POST /admin/doctor/scan` (read-only). */
export interface DoctorScanResponse {
  scanned: string[];
  results: Record<string, { description: string; count: number; findings: DoctorFinding[] }>;
}

/** Per-finding outcome of a fix run. */
export interface DoctorFixResult {
  dataset_id: string;
  version?: string;
  status: "fixed" | "skipped" | "failed";
  message?: string;
  details?: Record<string, unknown>;
}

/** `POST /admin/doctor/fix` with `dry_run: true`: lists findings, writes nothing. */
export interface DoctorFixDryRunResponse {
  check: string;
  dry_run: true;
  would_fix: number;
  findings: DoctorFinding[];
}

/** `POST /admin/doctor/fix` live run: per-finding outcomes and counts. */
export interface DoctorFixLiveResponse {
  check: string;
  total: number;
  fixed: number;
  skipped: number;
  failed: number;
  results: DoctorFixResult[];
}

/** Discriminated on `dry_run` so a caller cannot read live-run counts off a
 *  dry-run response (or vice versa); the overloads on {@link doctorFix} pick
 *  the arm at the call site. */
export type DoctorFixResponse = DoctorFixDryRunResponse | DoctorFixLiveResponse;

/** Run doctor diagnostic checks (read-only). Omit `check` to run them all. */
export async function doctorScan(options?: {
  check?: string;
  datasetId?: string;
}): Promise<DoctorScanResponse> {
  return request<DoctorScanResponse>(
    "/admin/doctor/scan",
    {
      method: "POST",
      body: JSON.stringify({
        ...(options?.check && { check: options.check }),
        ...(options?.datasetId && { dataset_id: options.datasetId }),
      }),
    },
    true,
  );
}

/** Apply a doctor check's remediation. `dryRun` lists findings without writing. */
export async function doctorFix(options: {
  check: string;
  datasetId?: string;
  dryRun: true;
}): Promise<DoctorFixDryRunResponse>;
export async function doctorFix(options: {
  check: string;
  datasetId?: string;
  dryRun?: false;
}): Promise<DoctorFixLiveResponse>;
export async function doctorFix(options: {
  check: string;
  datasetId?: string;
  dryRun?: boolean;
}): Promise<DoctorFixResponse> {
  return request<DoctorFixResponse>(
    "/admin/doctor/fix",
    {
      method: "POST",
      body: JSON.stringify({
        check: options.check,
        ...(options.datasetId && { dataset_id: options.datasetId }),
        ...(options.dryRun && { dry_run: true }),
      }),
    },
    true,
  );
}

// ============================================================================
// Zarr catalog (issue #1062, epic #1181 phase 2)
// ============================================================================

export interface PublishZarrCatalogResponse {
  count: number;
  bytes: number;
}

/**
 * Rebuild and republish the top-level Zarr discovery catalog
 * (`zarr-catalog.json`) to this environment's own S3 bucket. The daily cron
 * does this automatically; this is the on-demand escape hatch for an
 * operator who doesn't want to wait for the next tick.
 */
export async function publishZarrCatalog(): Promise<PublishZarrCatalogResponse> {
  return request<PublishZarrCatalogResponse>(
    "/admin/zarr-catalog/publish",
    { method: "POST" },
    true,
  );
}

// ============================================================================
// Zarr fidelity verification sweep (issue #1068, epic #1181 phase 8)
// ============================================================================

/** One {path, code} mismatch example, bounded to 20 entries / 4 KB server-side. */
export interface ZarrFidelityMismatchExample {
  path: string;
  code: "channel_count_mismatch" | "duration_mismatch" | "rate_mismatch";
}

/** Per-dataset outcome for every candidate the sweep reached a verdict for. */
export interface ZarrFidelityDatasetResult {
  dataset_id: string;
  verdict: "verified" | "failed" | "unverifiable";
  sampled: number;
  checked: number;
  checked_channels: number;
  checked_duration: number;
  checked_rate: number;
  unchecked: number;
  examples: ZarrFidelityMismatchExample[];
  mismatch_count: number;
  examples_truncated: boolean;
}

/** One batch of the zarr fidelity sweep
 *  (`POST /admin/datasets/zarr-fidelity-sweep`). `ok` is false (with a 502
 *  status) only when every processed candidate errored -- a partial mix of
 *  verdicts and errors, or an empty candidate set, is still `ok: true`
 *  (#1203 review, item 6). */
export interface ZarrFidelitySweepBatchResponse {
  processed: number;
  verified: number;
  failed: number;
  unverifiable: number;
  results: ZarrFidelityDatasetResult[];
  errors: { dataset_id: string; error: string }[];
  /** Candidates still unverified after this run; null if the count query failed. */
  remaining: number | null;
  /** True when the sweep-wide fetch budget ran out before every requested
   *  candidate could be attempted; datasets past this point were never
   *  touched at all (#1203 review, item 3). */
  budget_exhausted: boolean;
  ok: boolean;
}

/** Run one bounded zarr fidelity sweep batch (server default and max: 25). */
export async function zarrFidelitySweep(options?: {
  limit?: number;
}): Promise<ZarrFidelitySweepBatchResponse> {
  const params = new URLSearchParams();
  if (options?.limit != null) params.set("limit", String(options.limit));
  const query = params.toString() ? `?${params.toString()}` : "";
  return request<ZarrFidelitySweepBatchResponse>(
    `/admin/datasets/zarr-fidelity-sweep${query}`,
    { method: "POST", headers: { "Content-Type": "application/json" } },
    true,
  );
}
