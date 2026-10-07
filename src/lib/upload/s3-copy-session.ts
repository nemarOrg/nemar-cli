/**
 * S3 copy that outlives one STS credential window.
 *
 * Upload credentials are STS session credentials capped at 2 h by the
 * backend (`duration_seconds` max 7200). The upload used to request them once
 * and hand them to a single `git annex copy` over the whole dataset, so any
 * copy longer than the window died part-way with ExpiredToken and had to be
 * re-run by hand (the iEEG campaign wrapped `nemar dataset upload` in a
 * 12-attempt retry loop for exactly this).
 *
 * Here the pending paths are copied in bounded batches. Before each batch the
 * lease is renewed when it is close to expiry; each batch runs under a
 * deadline just short of the expiry, and a batch that hits the deadline or
 * fails with an expired-credential error is retried with fresh credentials.
 * Nothing is tracked locally: git-annex's location log already skips files a
 * killed or failed batch delivered, so a retry costs only the remainder.
 */

import type { S3Credentials } from "../git-annex/s3-remote.js";

/** Credentials plus the wall-clock instant (ms) they stop working. */
export interface CredentialLease {
  credentials: S3Credentials;
  expiresAtMs: number;
}

export interface CopyBatchResult {
  success: boolean;
  error?: string;
  filesCopied: number;
  timedOut?: boolean;
}

export type CopyBatchFn = (
  paths: string[],
  credentials: S3Credentials,
  options: { deadlineMs: number },
) => Promise<CopyBatchResult>;

/** Renew when fewer than this many ms remain on the lease. */
export const DEFAULT_REFRESH_MARGIN_MS = 20 * 60 * 1000;
/** A batch is killed this long before its credentials expire. */
export const DEFAULT_DEADLINE_SLACK_MS = 2 * 60 * 1000;
/** Batch bounds: small enough that one batch fits well inside a lease. */
export const DEFAULT_BATCH_MAX_FILES = 200;
export const DEFAULT_BATCH_MAX_BYTES = 50 * 1024 ** 3;
/** Upper bound on credential renewals in one upload (~2 h each). */
export const DEFAULT_MAX_REFRESHES = 48;
/** Consecutive renewals that delivered nothing before giving up. */
export const MAX_FRUITLESS_REFRESHES = 2;
/** Assumed lifetime when the server's `expiration` is missing or unparseable. */
const FALLBACK_LEASE_MS = 55 * 60 * 1000;

/**
 * Lease from an upload-credentials response. A missing or unparseable
 * `expiration` falls back to a conservative 55 min instead of trusting 2 h.
 */
export function leaseFromResponse(
  credentials: S3Credentials,
  expiration: string | undefined,
  nowMs: number,
): CredentialLease {
  const parsed = expiration ? Date.parse(expiration) : Number.NaN;
  const expiresAtMs = Number.isFinite(parsed) ? parsed : nowMs + FALLBACK_LEASE_MS;
  return { credentials, expiresAtMs };
}

/** git-annex / S3 wording for credentials that stopped working mid-copy. */
export function isExpiredCredentialError(message: string | undefined): boolean {
  if (!message) return false;
  return /ExpiredToken|RequestExpired|token (has|is) expired|security token included in the request is (expired|invalid)|InvalidToken|InvalidAccessKeyId/i.test(
    message,
  );
}

/**
 * Split `paths` (kept in order) into batches bounded by file count and by the
 * sum of known sizes. A single file over the byte bound forms its own batch.
 */
export function planCopyBatches(
  paths: string[],
  sizes: Map<string, number>,
  bounds: { maxFiles?: number; maxBytes?: number } = {},
): string[][] {
  const maxFiles = bounds.maxFiles ?? DEFAULT_BATCH_MAX_FILES;
  const maxBytes = bounds.maxBytes ?? DEFAULT_BATCH_MAX_BYTES;
  const batches: string[][] = [];
  let current: string[] = [];
  let bytes = 0;
  for (const path of paths) {
    const size = sizes.get(path) ?? 0;
    if (current.length > 0 && (current.length >= maxFiles || bytes + size > maxBytes)) {
      batches.push(current);
      current = [];
      bytes = 0;
    }
    current.push(path);
    bytes += size;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

export interface CopySessionOptions {
  paths: string[];
  sizes: Map<string, number>;
  /** Fetch a fresh lease (calls the upload-credentials endpoint). */
  renewLease: () => Promise<CredentialLease>;
  copyBatch: CopyBatchFn;
  initialLease: CredentialLease;
  now?: () => number;
  refreshMarginMs?: number;
  deadlineSlackMs?: number;
  maxRefreshes?: number;
  batchMaxFiles?: number;
  batchMaxBytes?: number;
  /** Progress/diagnostic line sink (the CLI passes a spinner-aware logger). */
  log?: (line: string) => void;
  /** Called after every finished batch with (done batches, total batches). */
  onBatchDone?: (done: number, total: number) => void;
}

export interface CopySessionResult {
  success: boolean;
  error?: string;
  filesCopied: number;
  refreshes: number;
  /** The lease in force at the end, so the caller can reuse it. */
  lease: CredentialLease;
}

/**
 * Copy `paths` batch by batch, renewing the credential lease before it runs
 * out and retrying a batch that died of expiry. Any other failure is returned
 * as-is (the caller prints it and tells the user to re-run).
 */
export async function copyWithCredentialRefresh(
  opts: CopySessionOptions,
): Promise<CopySessionResult> {
  const now = opts.now ?? Date.now;
  const margin = opts.refreshMarginMs ?? DEFAULT_REFRESH_MARGIN_MS;
  const slack = opts.deadlineSlackMs ?? DEFAULT_DEADLINE_SLACK_MS;
  const maxRefreshes = opts.maxRefreshes ?? DEFAULT_MAX_REFRESHES;
  const log = opts.log ?? (() => {});
  const batches = planCopyBatches(opts.paths, opts.sizes, {
    maxFiles: opts.batchMaxFiles,
    maxBytes: opts.batchMaxBytes,
  });

  let lease = opts.initialLease;
  let refreshes = 0;
  let filesCopied = 0;
  // The longest batch seen so far: a lease is renewed when what is left of it
  // would not cover the margin plus one more batch like that, so batches are
  // not started only to be killed at the deadline.
  let longestBatchMs = 0;

  const renew = async (why: string): Promise<string | null> => {
    if (refreshes >= maxRefreshes) {
      return `Upload credentials were renewed ${refreshes} times and the copy is still not done; re-run the command to continue`;
    }
    try {
      lease = await opts.renewLease();
    } catch (e) {
      return `Could not renew upload credentials (${why}): ${e instanceof Error ? e.message : String(e)}`;
    }
    refreshes++;
    log(`Renewed upload credentials (${why})`);
    return null;
  };

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    let fruitless = 0;
    for (;;) {
      if (lease.expiresAtMs - now() < margin + longestBatchMs) {
        const err = await renew("close to expiry");
        if (err) return { success: false, error: err, filesCopied, refreshes, lease };
      }
      const started = now();
      const result = await opts.copyBatch(batch, lease.credentials, {
        deadlineMs: lease.expiresAtMs - slack,
      });
      if (result.success) longestBatchMs = Math.max(longestBatchMs, now() - started);
      filesCopied += result.filesCopied;
      if (result.success) break;
      const expired = result.timedOut || isExpiredCredentialError(result.error);
      if (!expired) {
        return { success: false, error: result.error, filesCopied, refreshes, lease };
      }
      // A retry that delivers nothing, twice in a row, is not an expiry
      // problem (or the lease is unusable from the start): stop instead of
      // spinning through renewals.
      fruitless = result.filesCopied > 0 ? 0 : fruitless + 1;
      if (fruitless > MAX_FRUITLESS_REFRESHES) {
        return {
          success: false,
          error: `Copy keeps failing with expired credentials and no progress: ${result.error ?? "deadline reached"}`,
          filesCopied,
          refreshes,
          lease,
        };
      }
      const err = await renew(
        result.timedOut ? "batch reached the credential deadline" : "expired",
      );
      if (err) return { success: false, error: err, filesCopied, refreshes, lease };
    }
    opts.onBatchDone?.(i + 1, batches.length);
  }
  return { success: true, filesCopied, refreshes, lease };
}
