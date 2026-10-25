/**
 * NEMAR API client: data-plane endpoints (upload/download credentials, S3
 * object lock, dataset file listings).
 *
 * Split from lib/api.ts by endpoint group (#908, epic #902); bodies moved
 * verbatim.
 */

import { request } from "./client.js";
import { ApiError } from "./errors.js";

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

/** At most this many objects per call of the explicit lock (the Worker's batch size). */
export const OBJECTS_PER_EXPLICIT_LOCK = 100;

/**
 * Lock exactly the named objects of a dataset, `<id>/objects/<key>` each, at their current
 * versions (`POST /admin/datasets/:id/s3-lock` with `objects`), in batches the Worker takes. An
 * upstream re-pull's release locks the objects its copy and its uploads wrote this way, and
 * nothing else under the prefix (ADR 0111, decision 8). A 403 counts as locked only when the
 * Worker read the object's retention back.
 */
export async function lockS3Objects(
  datasetId: string,
  keys: readonly string[],
): Promise<{
  locked: number;
  failed: S3LockFailure[];
  objects: Array<{ key: string; version_id: string | null }>;
}> {
  let locked = 0;
  const failed: S3LockFailure[] = [];
  const objects: Array<{ key: string; version_id: string | null }> = [];
  for (let i = 0; i < keys.length; i += OBJECTS_PER_EXPLICIT_LOCK) {
    const batch = keys.slice(i, i + OBJECTS_PER_EXPLICIT_LOCK);
    const result = await request<
      S3LockResponse & { objects?: Array<{ key: string; version_id: string | null }> }
    >(
      `/admin/datasets/${datasetId}/s3-lock`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ objects: batch }),
      },
      true,
    );
    // An answer that does not name each locked object is not a count of them.
    if (!Array.isArray(result.objects)) {
      throw new ApiError(500, "The s3-lock route did not name the objects it locked.");
    }
    locked += result.objects.length;
    objects.push(...result.objects);
    if (result.failed?.length) failed.push(...result.failed);
  }
  return { locked, failed, objects };
}
