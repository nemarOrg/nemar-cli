/**
 * A per-isolate, short-TTL cache of which datasets the bucket policy carves
 * out of public read (#1522).
 *
 * `manifest.json` now needs to know, on every request, whether it may emit
 * plain S3 object URLs or must keep presigning. That answer lives in
 * `getBucketPolicy` (a signed S3 GET against `?policy`, the same small
 * document `services/bucket-policy.ts` transforms), and paying that round
 * trip on every manifest.json request would put back exactly the kind of
 * per-request cost #1522 exists to remove. The policy changes only when an
 * admin flips a dataset's visibility, so the whole document -- not a
 * per-dataset entry -- is cached briefly and re-read as a unit.
 *
 * WHY 60 SECONDS. The bucket policy's `NotResource` carve-out and the
 * catalog's `datasets.visibility` column are two different systems that
 * nothing keeps atomic (#1524 records them drifting in the wild), so a flip
 * of one has to reach every isolate within a bound short enough to read as
 * the same event as the flip itself. 60 seconds matches manifest.json's own
 * historical client-facing `Cache-Control`, which is the number this
 * codebase already treats as "how stale may this endpoint's view of the
 * world be." There is no safety asymmetry to lean on in choosing it, only a
 * usability one, spelled out below.
 *
 * WHY NEITHER STALE DIRECTION IS A SECURITY PROBLEM, only an availability
 * one, and why that is what lets 60s be a usability number rather than a
 * defended ceiling:
 *
 *  - Stale "excluded" (a dataset just left the carve-out, should now get
 *    unsigned URLs, but this isolate still thinks it is excluded): the
 *    response keeps presigning. A presigned URL is signed with the Worker's
 *    OWN IAM credentials, which read the object regardless of the bucket
 *    policy's anonymous grant -- so the link still works, only more
 *    expensively than it needed to.
 *  - Stale "not excluded" (a dataset just entered the carve-out, should now
 *    be presigned, but this isolate still thinks it is not): the response
 *    emits an unsigned URL that S3 now answers 403 for. Broken for up to the
 *    TTL, never a leak: the object was never anonymously public in that
 *    window, `NotResource` guaranteed that, and an unsigned request against
 *    it simply fails the way it always would have.
 *
 * A policy the S3 call could not read (a network fault, a throttle) is
 * treated the SAME as "excluded", the direction that is always safe to fall
 * back to, and the cache is left unset so the very next request tries again
 * rather than pinning a failure for the TTL.
 */

import { listPrivateDatasets } from "./bucket-policy";
import { type PresignedUrlOptions, getBucketPolicy } from "./s3";

/** How long a read of the bucket policy is trusted before the next request
 *  re-reads it. See the module comment for why this number is a usability
 *  choice, not a security boundary. */
export const PUBLIC_READ_DECISION_TTL_MS = 60_000;

interface CacheEntry {
  excludedIds: ReadonlySet<string>;
  expiresAt: number;
}

/**
 * Keyed by (bucket, endpoint), not a single slot: a real deployment only
 * ever has one bucket per isolate, so this is always a one-entry map in
 * production and costs nothing there. It matters in tests, where several
 * suites in the SAME `bun test` process (per `.memory/bun-test-shared-...`)
 * each stand up their own local S3 double on a different port -- a single
 * global slot would let one suite's cached decision answer for another
 * suite's bucket, which is a correctness bug this map removes rather than a
 * cosmetic one.
 */
const cache = new Map<string, CacheEntry>();

function cacheKeyFor(s3Options: PresignedUrlOptions): string {
  return `${s3Options.bucket}::${s3Options.endpointUrl ?? ""}`;
}

/** Drop every cached decision, so the next call for any bucket re-reads its
 *  policy. */
export function __resetPublicReadCacheForTests(): void {
  cache.clear();
}

/** Seed one bucket's cached decision directly, bypassing S3, so a test can
 *  pin a TTL boundary without racing a real clock. */
export function __seedPublicReadCacheForTests(
  s3Options: PresignedUrlOptions,
  excludedIds: string[],
  expiresAt: number,
): void {
  cache.set(cacheKeyFor(s3Options), { excludedIds: new Set(excludedIds), expiresAt });
}

/**
 * True when `datasetId`'s objects are carved out of the bucket's
 * `PublicReadExceptPrivate` grant and manifest.json must keep presigning its
 * annexed URLs for it. See the module comment for the TTL and the fail-safe
 * direction on a read failure.
 */
export async function isDatasetExcludedFromPublicRead(
  s3Options: PresignedUrlOptions,
  datasetId: string,
  now: number = Date.now(),
): Promise<boolean> {
  const key = cacheKeyFor(s3Options);
  let entry = cache.get(key);
  if (!entry || entry.expiresAt <= now) {
    let excludedIds: ReadonlySet<string>;
    try {
      const policy = await getBucketPolicy(s3Options);
      // `getBucketPolicy` returns `null` for a 404 (no policy document at all)
      // and `listPrivateDatasets(null, ...)` answers `[]` -- "no exclusions",
      // the same fail-open reading a read failure gets below, only reached
      // silently rather than through the catch block. Named here so a bucket
      // that unexpectedly has no policy document shows up in logs instead of
      // quietly presigning nothing.
      if (policy === null) {
        console.warn(
          "[data] bucket-policy read returned 404 (no policy document); treating every dataset as not excluded from public read",
        );
      }
      excludedIds = new Set(listPrivateDatasets(policy, s3Options.bucket));
    } catch (err) {
      console.error(
        "[data] bucket-policy read failed; manifest.json will presign as a precaution:",
        err instanceof Error ? err.message : String(err),
      );
      // Leave this bucket's entry as it was (absent, or a stale-but-not-yet-
      // retried one) so the failure is never pinned for the TTL, and answer
      // the safe direction for THIS call regardless of what is cached.
      return true;
    }
    entry = { excludedIds, expiresAt: now + PUBLIC_READ_DECISION_TTL_MS };
    cache.set(key, entry);
  }
  return entry.excludedIds.has(datasetId);
}
