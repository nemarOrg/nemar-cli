/**
 * The license-lineage resolver's per-DOI cache in the Worker (epic #2182, cards D1 and B4): the
 * Worker cache (`caches.default`), keyed by a URL on a host that is never fetched. Each registry
 * answer is kept for `CACHE_TTL_SECONDS`; a failed fetch and a `not_found` are never cached, so an
 * `unresolved` source is never served from it (the resolver's rule, ADR 0142 decision 3).
 * One module for the readers: the admin lineage route, the publication review's inputs, and the
 * decision card (`decision-card-inputs.ts`), which all resolve through {@link resolveWorkerLineage}.
 */

import {
  CACHE_TTL_SECONDS,
  type LineageCache,
  type LineageInputs,
  type LineageResult,
  type SourceRecord,
  resolveLicenseLineage,
} from "../../../shared/license-lineage.js";

/** A cache key is a URL in the Worker cache; this host is never fetched. */
const CACHE_ORIGIN = "https://license-lineage.cache.invalid/";

/** The Worker cache as the resolver's per-DOI cache, or undefined where there is none. */
export function workerLineageCache(): LineageCache | undefined {
  if (typeof caches === "undefined" || !("default" in caches)) return undefined;
  const cache = (caches as unknown as { default: Cache }).default;
  // The resolver puts its own version in every key, so an older record is never served.
  const keyOf = (k: string) => new Request(`${CACHE_ORIGIN}${encodeURIComponent(k)}`);
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

/**
 * A lineage resolved again now, as every Worker reader resolves it (ADR 0142 decision 3): the
 * resolver's default retries (`LINEAGE_RETRY`, within its fetch budget), the Worker cache for
 * answers only, and a fresh `resolved_at`. An `unresolved` source is asked again every time, so the
 * review, the admin command and the decision card each get the registries' answer of their own
 * moment; the card shows its own beside the review's and never raises the stored verdict.
 */
export function resolveWorkerLineage(inputs: LineageInputs): Promise<LineageResult> {
  return resolveLicenseLineage(inputs, { cache: workerLineageCache() });
}
