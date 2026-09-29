/**
 * The Workers Cache API copy of a manifest.json RESPONSE (#1522), sitting
 * beside the edge copy `manifest-source.ts` already keeps of the raw
 * manifest object. That cache lets a QUERY re-scan the manifest's bytes
 * without a second S3 read; this one stores the manifest.json HANDLER'S
 * OWN OUTPUT -- the JSON array every annexed and git-tracked entry scans
 * into -- so a hit skips the scan and the entry-building pass entirely, not
 * only the S3 round trip.
 *
 * WHY THIS IS SAFE NOW, AND WAS NOT BEFORE. A presigned `url` embeds a
 * signature computed at request time from the Worker's own credentials and
 * clock; two responses for the same manifest were never byte-identical, so
 * caching the built document would have meant serving one requester's
 * signature to everybody else. Once `url` is the plain public S3 URL for a
 * dataset the bucket policy does not exclude (`public-read-cache.ts`
 * decides which), the whole document is a pure function of the manifest's
 * own bytes: the same array for every requester until the manifest changes.
 * That is the property `git-file-cache.ts` (#1516) and the raw-manifest
 * cache (ADR 0072) already lean on for their own bytes; this is the same
 * argument one layer up, at the built response instead of the source.
 *
 * WHY VALIDATED BY THE MANIFEST'S OWN ETAG, NEVER A CONTENT HASH OF THE
 * RESPONSE (ADR 0066's rule for every cache on this data plane). A stored
 * document is trustworthy for exactly as long as the S3 manifest object it
 * was built from has not changed, and the ETag IS that object's identity.
 * `fetchManifestObject`'s `ifNoneMatch` answers "has it changed?" in one
 * conditional request with no body on a hit, the same idiom
 * `manifest-source.ts` already uses to revalidate its own copy. A
 * content-addressed key would need the new bytes in hand before it could
 * even be checked, defeating the point of skipping the scan.
 *
 * WHY AN EXCLUDED DATASET NEVER REACHES THIS CACHE. Its entries carry
 * presigned URLs, each good for one hour from the moment it was signed.
 * Caching that document would hand every later requester a signature timed
 * from whenever it was stored, which is precisely the staleness #1522
 * exists to remove. The caller (`routes/data.ts`) decides this before it
 * ever builds a cache key or calls into this module; nothing here inspects
 * the entries to guess which kind of document it was handed.
 *
 * WHY THE STORED ENTRY'S OWN TTL IS SEVEN DAYS WHILE THE CLIENT IS TOLD
 * SOMETHING SHORTER. Identical reasoning to `git-file-cache.ts`'s
 * `GIT_FILE_CACHE_TTL_SECONDS`: the Workers Cache API reads a stored
 * response's OWN `Cache-Control` to decide whether `cache.match` still
 * considers it fresh -- a different question from what a client downstream
 * is told to trust. Every hit here is revalidated against the live
 * manifest's ETag regardless of the entry's own age, so a long stored TTL
 * costs nothing; it only bounds how long an unused entry occupies the cache
 * before `cache.match` stops returning it. The client-facing value is
 * carried on its own internal header and restored verbatim on a hit, so a
 * client never sees the difference between the two numbers.
 */

import { toVersionTag } from "../../../shared/contract/version.js";
import type { ManifestCache } from "./manifest-source";

/** Marker on a STORED copy only, carrying the manifest's ETag at the moment
 *  this document was built. Doubles as the AWS S3 `ETag` header name so a
 *  stored entry can be read back and re-served with the same header a client
 *  would see from S3 itself, though nothing here requires that coincidence. */
const ETAG_HEADER = "ETag";

/** Carries the ORIGINAL client-facing `Cache-Control` on a stored copy, so a
 *  hit can hand it back unchanged even though the entry's own `Cache-Control`
 *  (what the Cache API reads for the entry's freshness) is
 *  {@link MANIFEST_JSON_CACHE_TTL_SECONDS}, a different number for a
 *  different question. */
const CLIENT_CACHE_CONTROL_HEADER = "X-Nemar-Cache-Client-Cache-Control";

/** Seven days, matching `GIT_FILE_CACHE_TTL_SECONDS` and
 *  `MANIFEST_CACHE_TTL_SECONDS` for the same reason both are long: every hit
 *  is re-validated against the live manifest's ETag before it answers, so
 *  this only bounds how long an unused entry sits in the cache, never how
 *  stale an answer can be. */
export const MANIFEST_JSON_CACHE_TTL_SECONDS = 7 * 24 * 60 * 60;

/** How long the writer waits for `cache.put` when there is no `waitUntil` to
 *  hand it to (`app.request()` with no execution context, as the route
 *  suites drive `dataRoutes`). Matches `GIT_FILE_CACHE_STALL_MS`: the whole
 *  body is already in memory (a JSON string) before the write starts, so a
 *  healthy put settles in microseconds and this is pure margin for a slow
 *  but real CI runner. */
export const MANIFEST_JSON_CACHE_STALL_MS = 500;

export interface ManifestJsonCacheHit {
  etag: string;
  body: string;
  /** The `Cache-Control` this document was originally served with, restored
   *  verbatim on a hit; `null` only if a stored entry somehow lost it. */
  clientCacheControl: string | null;
}

/**
 * The synthetic key one manifest.json document lives under. Dataset- and
 * version-scoped, never content-addressed (ADR 0066), and under a path no
 * public data route serves -- the same shape `manifestCacheKey` and
 * `gitFileCacheKey` already use, one path segment further so the three
 * families of entry never collide.
 */
export function manifestJsonCacheKey(origin: string, datasetId: string, version: string): string {
  const tag = toVersionTag(version);
  return `${origin}/__nemar-internal/manifest-json-cache/v1/${encodeURIComponent(datasetId)}/${encodeURIComponent(tag)}.json`;
}

/**
 * Look up a stored manifest.json document. A miss, a cache fault (a thrown
 * `match`), and a copy missing its ETag marker are all `null`, meaning
 * "build it fresh"; the caller still has to confirm the ETag is current
 * before trusting the body this returns.
 */
export async function matchManifestJsonCache(
  cache: ManifestCache,
  key: string,
): Promise<ManifestJsonCacheHit | null> {
  let hit: Response | undefined;
  try {
    hit = await cache.match(new Request(key, { method: "GET" }));
  } catch (err) {
    console.error(
      `[data] manifest.json cache match failed key=${key}:`,
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
  if (!hit) return null;
  const etag = hit.headers.get(ETAG_HEADER);
  if (!hit.ok || !etag) {
    await hit.body?.cancel().catch(() => {});
    return null;
  }
  let body: string;
  try {
    body = await hit.text();
  } catch (err) {
    // A copy that cannot be read back whole decides nothing: treat it as
    // absent and let the caller build fresh, the same rule every other cache
    // on this data plane follows.
    console.error(
      `[data] manifest.json cache entry failed to read back key=${key}:`,
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
  return { etag, body, clientCacheControl: hit.headers.get(CLIENT_CACHE_CONTROL_HEADER) };
}

/**
 * Store a manifest.json document. `body` is the exact JSON string the
 * client was sent; `clientCacheControl` is the exact `Cache-Control` header
 * value that went with it. Never throws: a failed `cache.put` is logged and
 * otherwise ignored, so a cache fault never changes the answer a request
 * already received.
 */
async function putManifestJsonCache(args: {
  cache: ManifestCache;
  key: string;
  etag: string;
  body: string;
  clientCacheControl: string;
}): Promise<void> {
  const { cache, key, etag, body, clientCacheControl } = args;
  const headers = new Headers({
    "Content-Type": "application/json",
    [ETAG_HEADER]: etag,
    [CLIENT_CACHE_CONTROL_HEADER]: clientCacheControl,
    "Cache-Control": `max-age=${MANIFEST_JSON_CACHE_TTL_SECONDS}`,
  });
  const entry = new Response(body, { status: 200, headers });
  try {
    await cache.put(new Request(key, { method: "GET" }), entry);
  } catch (err) {
    console.error(
      `[data] manifest.json cache put FAILED key=${key}:`,
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * Schedule the cache write so it can never hold the response back. With
 * `waitUntil` (every real Worker invocation) the write is handed off and
 * this returns at once; without one (`app.request()` with no execution
 * context) the write is awaited but bounded by
 * {@link MANIFEST_JSON_CACHE_STALL_MS}, mirroring
 * `scheduleGitFileCacheWrite`.
 */
export function scheduleManifestJsonCacheWrite(
  args: {
    cache: ManifestCache;
    key: string;
    etag: string;
    body: string;
    clientCacheControl: string;
  },
  waitUntil: ((work: Promise<unknown>) => void) | undefined,
): Promise<void> {
  const write = putManifestJsonCache(args);
  if (waitUntil) {
    waitUntil(write);
    return Promise.resolve();
  }
  return Promise.race([
    write,
    new Promise<void>((resolve) => setTimeout(resolve, MANIFEST_JSON_CACHE_STALL_MS)),
  ]);
}
