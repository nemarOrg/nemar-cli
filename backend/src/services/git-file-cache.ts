/**
 * The Workers Cache API copy of a brokered git-tracked file (#1516, ADR 0066
 * amendment 2026-09-28).
 *
 * ADR 0066 deferred this write on purpose, "pending a design for
 * purge-on-visibility-change". The amendment recorded alongside this module
 * IS that design, and its argument is short enough to repeat here: the
 * visibility gate (`loadPublishedDataset`) runs on every request, before
 * this cache is ever consulted, exactly as it always ran before the token
 * was minted. So there is nothing to purge -- a dataset that goes private
 * stops being served from this cache on its very next request, because
 * there is no code path that reaches `matchGitFileCache` without re-proving
 * visibility first. The cache changes where the bytes come from; it never
 * changes what the route is willing to answer for.
 *
 * WHY KEYED BY REQUEST URL, NEVER BY BLOB SHA. ADR 0066's rule for this
 * broker, restated because it is the one invariant a shortcut could break:
 * two datasets can hold byte-identical files (a shared `CHANGES.md`, an
 * empty `.bidsignore`), and a SHA-keyed entry would answer for whichever
 * dataset asked second, bypassing the gate entirely for it. The key here is
 * dataset-, version- and path-scoped -- the same shape as
 * `manifest-source.ts`'s `manifestCacheKey` -- and lives under a path no
 * public data route serves (the dataset-id check 404s `__nemar-internal`).
 *
 * WHY THIS DOES NOT REVALIDATE AGAINST GITHUB ON EVERY USE, the way the
 * manifest cache revalidates against S3. A manifest's OWN bytes change
 * under a stable key (the pipeline rewrites it in place); a git blob
 * cannot -- the object name IS the content hash. So a stored copy is
 * trustworthy for as long as the CURRENT manifest still names the same blob
 * SHA at this path, and the caller already holds that value: it just
 * resolved the manifest entry to reach here. Checking it costs nothing
 * extra -- no second network round trip, unlike the manifest cache's
 * conditional GET -- which is also why there is no ETag and no
 * `If-None-Match` anywhere in this file.
 *
 * WHY A HEADER ON THE STORED ENTRY CARRIES THE BLOB SHA, RATHER THAN THE KEY.
 * Folding the SHA into the key would turn a manifest rewrite (a moved tag,
 * a same-size edit -- ADR 0066's 2026-09-16 amendment) into an ordinary
 * cache MISS under a brand new key, leaving the old entry parked at its old
 * key forever with nothing left to ever evict it. An explicit,
 * internal-only marker header lets a rewrite REPLACE the one entry this
 * path has, rather than leak a new one per historical blob.
 *
 * WHY THE STORED ENTRY'S OWN `Cache-Control` IS NOT THE CLIENT'S. Found in
 * review: the first version of this module reused the client-facing
 * `public, max-age=300` verbatim as the STORED response's own header. The
 * Workers Cache API honors a stored response's `Cache-Control` for that
 * entry's OWN freshness -- `cache.match` answers `undefined` once it has
 * aged past the max-age it was stored with, independent of anything the
 * route decides afterward -- so every copy silently stopped being a hit
 * after five minutes, which defeats the point for a second downloader
 * arriving later, #1494's main scenario. The 300s number is about how long
 * an AUTHORIZATION decision may go unchecked by a downstream cache (ADR
 * 0066); it says nothing about how long THIS cache, which re-checks the
 * gate and the blob SHA on every single use, may keep a verified copy
 * around. `GIT_FILE_CACHE_TTL_SECONDS`, below, is that second, unrelated
 * number, stored under the entry's `Cache-Control` while the client-facing
 * value is preserved separately (`CLIENT_CACHE_CONTROL_HEADER`) and restored
 * verbatim on every hit, so nothing a client sees changes.
 */

import { toVersionTag } from "../../../shared/contract/version.js";
import type { ManifestFile } from "./manifest";
import type { ManifestCache } from "./manifest-source";

/**
 * Marker on a STORED copy only. Never forwarded to a client: `matchGitFileCache`
 * strips it before handing a hit back, and it is never set on the response the
 * broker builds for a miss. Prefixed like the rest of this codebase's
 * internal-only headers so a stray leak would be recognizable in a log.
 */
const BLOB_SHA_HEADER = "X-Nemar-Cache-Blob-Sha";

/**
 * Carries the ORIGINAL client-facing `Cache-Control` on a stored copy, so a
 * hit can hand it back unchanged even though the entry's own `Cache-Control`
 * (what the Cache API reads for the entry's freshness) is
 * {@link GIT_FILE_CACHE_TTL_SECONDS}, a different number for a different
 * question. Stored rather than hardcoded here because this module has no
 * business assuming what `routes/data.ts` sends a client -- only that
 * whatever it is must come back unchanged.
 */
const CLIENT_CACHE_CONTROL_HEADER = "X-Nemar-Cache-Client-Cache-Control";

/**
 * How long a stored copy is fresh AS FAR AS THE CACHE API IS CONCERNED --
 * never seen by a client, and unrelated to the 300s a client is told to
 * trust an authorization decision for (ADR 0066). Seven days, matching
 * `manifest-source.ts`'s `MANIFEST_CACHE_TTL_SECONDS`, for the same reason
 * that one is long: every hit is re-validated before it answers, here
 * against the blob SHA the CURRENT manifest names for this path, so a long
 * TTL cannot serve anything the live manifest disagrees with -- it only
 * bounds how long an entry nobody has asked for occupies the cache before
 * `cache.match` stops considering it fresh. A git blob is immutable by
 * construction (the object name IS the content hash), so this cache's
 * verification is actually stronger than the manifest cache's ETag-based
 * one: seven days is not a ceiling this needs to defend, just the number
 * that keeps the two TTLs easy to compare at a glance. The real Cache API
 * also evicts under its own storage pressure regardless of what a TTL
 * claims, so this is a freshness ceiling, not a retention guarantee.
 */
export const GIT_FILE_CACHE_TTL_SECONDS = 7 * 24 * 60 * 60;

/** How long the writer waits for `cache.put` when there is no `waitUntil` to
 *  hand it to (bun test driving the route directly, as `app.request` without
 *  an execution context does). Bounded so a wedged test double costs this
 *  suite a delay, never a hang; production always has `waitUntil` and never
 *  waits at all. Far below the manifest cache's 5s bound because a brokered
 *  file's whole body is already in memory before the write starts -- there is
 *  no chunk-by-chunk queue to drain, so a healthy put settles in microseconds
 *  and 500ms is pure margin for a slow but real CI runner. */
export const GIT_FILE_CACHE_STALL_MS = 500;

export interface GitFileCacheHit {
  status: number;
  headers: Headers;
  body: Uint8Array;
}

/** The git object name a manifest entry names, stripped of its `git:` tag. */
function blobShaOf(file: Pick<ManifestFile, "key">): string {
  return file.key.replace(/^git:/, "");
}

/**
 * The synthetic key one brokered file's edge copy lives under. Never
 * content-addressed (ADR 0066): dataset, version and path only -- the same
 * shape as `manifestCacheKey` -- under a path the data routes' own
 * dataset-id check 404s. The path is percent-encoded one segment at a time
 * so a `/` inside a BIDS path stays a path separator in the key instead of
 * becoming `%2F` and colliding subdirectories into one cache entry.
 *
 * Including the request's origin means the same file reached via
 * `data.nemar.org` and via the `/nemar/data` mount on another host stores
 * two copies. Deliberate, not an oversight: it is the same choice
 * `manifestCacheKey` (#1505) already made, and a Workers Cache API key must
 * be on a hostname the zone actually serves, so the alternative (a
 * synthetic, origin-independent host) is not simpler, just less honest about
 * what the cache actually is.
 */
export function gitFileCacheKey(
  origin: string,
  datasetId: string,
  version: string,
  bidsPath: string,
): string {
  const tag = toVersionTag(version);
  const path = bidsPath
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `${origin}/__nemar-internal/git-file-cache/v1/${encodeURIComponent(datasetId)}/${encodeURIComponent(tag)}/${path}`;
}

/**
 * Look up a stored copy and hand it back only when its recorded blob SHA
 * still matches the CURRENT manifest entry's. A cache miss, a cache fault
 * (thrown `match`), a copy with no recognizable marker, and a copy whose
 * marker disagrees with the live manifest (a retag or same-size edit since
 * it was stored, ADR 0066's amendment) are all indistinguishable to the
 * caller: `null`, meaning "fetch and replace it".
 */
export async function matchGitFileCache(
  cache: ManifestCache,
  key: string,
  currentFile: Pick<ManifestFile, "key">,
): Promise<GitFileCacheHit | null> {
  let hit: Response | undefined;
  try {
    hit = await cache.match(new Request(key, { method: "GET" }));
  } catch (err) {
    console.error(
      `[data] git-file cache match failed key=${key}:`,
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
  if (!hit) return null;

  const storedSha = hit.headers.get(BLOB_SHA_HEADER);
  if (!hit.ok || !storedSha) {
    await hit.body?.cancel().catch(() => {});
    return null;
  }
  if (storedSha !== blobShaOf(currentFile)) {
    // Not a fault: the manifest was rewritten since this copy was stored.
    // The entry will be replaced by whatever this miss fetches next.
    await hit.body?.cancel().catch(() => {});
    return null;
  }

  let body: Uint8Array;
  try {
    body = new Uint8Array(await hit.arrayBuffer());
  } catch (err) {
    // A copy that cannot be read back whole decides nothing (the same rule
    // `manifest-source.ts` follows): treat it as absent and let the caller
    // fetch fresh.
    console.error(
      `[data] git-file cache entry failed to read back key=${key}:`,
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
  const headers = new Headers(hit.headers);
  headers.delete(BLOB_SHA_HEADER);
  // Undo `putGitFileCache`'s substitution: the entry's own `Cache-Control`
  // (what just decided whether this counted as fresh) is
  // GIT_FILE_CACHE_TTL_SECONDS, not what a client should be told. Restore
  // the value that was actually served last time, verbatim; if somehow
  // absent, drop the header rather than leak the internal TTL to a client.
  const clientCacheControl = headers.get(CLIENT_CACHE_CONTROL_HEADER);
  headers.delete(CLIENT_CACHE_CONTROL_HEADER);
  if (clientCacheControl !== null) headers.set("Cache-Control", clientCacheControl);
  else headers.delete("Cache-Control");
  return { status: hit.status, headers, body };
}

/**
 * Store a brokered file's bytes. Callers pass ONLY the buffered branch's
 * verified body: the bytes have already been measured against the
 * manifest's declared size and hashed as a git blob against the manifest's
 * object name (`sizeCheckedBody` in `routes/data.ts`). The streamed branch
 * (above the buffer ceiling) and every error response are never offered
 * here -- there is nothing above the ceiling to cache safely, and an error
 * body is not the file.
 *
 * `headers` are the EXACT headers the client received: the entry stores the
 * real response, marked with the blob SHA, rather than a second
 * representation that could drift from what was actually served. The one
 * exception is `Cache-Control` itself: the client's value is preserved
 * verbatim under {@link CLIENT_CACHE_CONTROL_HEADER} so a hit can restore it,
 * and the header the STORED response carries is overwritten with
 * {@link GIT_FILE_CACHE_TTL_SECONDS} -- what the Cache API reads to decide
 * whether this copy is still fresh, a different question with a different
 * answer (see the module comment).
 *
 * Never throws: a failed `cache.put` is logged and otherwise ignored, the
 * same contract `manifest-source.ts`'s writer keeps, because a cache fault
 * must never change the answer a request already received.
 */
async function putGitFileCache(args: {
  cache: ManifestCache;
  key: string;
  blobSha: string;
  body: Uint8Array;
  headers: Headers;
}): Promise<void> {
  const { cache, key, blobSha, body, headers } = args;
  const stored = new Headers(headers);
  stored.set(BLOB_SHA_HEADER, blobSha);
  const clientCacheControl = stored.get("Cache-Control");
  if (clientCacheControl !== null) {
    stored.set(CLIENT_CACHE_CONTROL_HEADER, clientCacheControl);
  }
  stored.set("Cache-Control", `max-age=${GIT_FILE_CACHE_TTL_SECONDS}`);
  const entry = new Response(body, { status: 200, headers: stored });
  try {
    await cache.put(new Request(key, { method: "GET" }), entry);
  } catch (err) {
    console.error(
      `[data] git-file cache put FAILED key=${key}:`,
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * Schedule the cache write so it can never hold a response back.
 *
 * With `waitUntil` (every real Worker invocation), the write is handed off
 * and this returns at once -- a stalled or throwing `cache.put` costs the
 * isolate a dangling task, never this or any other request's latency. Without
 * one (`app.request()` with no execution context, which is how the route
 * suites drive `dataRoutes`), the write is awaited but bounded by
 * {@link GIT_FILE_CACHE_STALL_MS}, so a stalled test double cannot hang the
 * test -- mirroring `manifest-source.ts`'s `putOrTimeout`, at a far shorter
 * bound because there is no multi-megabyte body to drain here.
 */
export function scheduleGitFileCacheWrite(
  args: {
    cache: ManifestCache;
    key: string;
    blobSha: string;
    body: Uint8Array;
    headers: Headers;
  },
  waitUntil: ((work: Promise<unknown>) => void) | undefined,
): Promise<void> {
  const write = putGitFileCache(args);
  if (waitUntil) {
    waitUntil(write);
    return Promise.resolve();
  }
  return Promise.race([
    write,
    new Promise<void>((resolve) => setTimeout(resolve, GIT_FILE_CACHE_STALL_MS)),
  ]);
}
