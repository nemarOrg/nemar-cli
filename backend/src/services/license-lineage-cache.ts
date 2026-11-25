/**
 * The license-lineage resolver's per-DOI cache in the Worker (epic #2182, cards D1 and B4): the
 * Worker cache (`caches.default`), keyed by a URL on a host that is never fetched. Each registry
 * answer is kept for `CACHE_TTL_SECONDS`; a failed fetch is never cached (the resolver's rule).
 * One module for the two readers: the admin lineage route and the publication review's inputs.
 */

import {
  CACHE_TTL_SECONDS,
  type LineageCache,
  RESOLVER_VERSION,
  type SourceRecord,
} from "../../../shared/license-lineage.js";

/** A cache key is a URL in the Worker cache; this host is never fetched. */
const CACHE_ORIGIN = "https://license-lineage.cache.invalid/";

/** The Worker cache as the resolver's per-DOI cache, or undefined where there is none. */
export function workerLineageCache(): LineageCache | undefined {
  if (typeof caches === "undefined" || !("default" in caches)) return undefined;
  const cache = (caches as unknown as { default: Cache }).default;
  // The resolver's version is in the key: a record cached by an older resolver lacks the fields
  // a newer one reads, so it is never served to it.
  const keyOf = (k: string) =>
    new Request(`${CACHE_ORIGIN}${encodeURIComponent(RESOLVER_VERSION)}/${encodeURIComponent(k)}`);
  return {
    async get(k) {
      const hit = await cache.match(keyOf(k));
      return hit ? ((await hit.json()) as SourceRecord) : undefined;
    },
    async put(k, record) {
      await cache.put(
        keyOf(k),
        new Response(JSON.stringify(record), {
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": `max-age=${CACHE_TTL_SECONDS}`,
          },
        }),
      );
    },
  };
}
