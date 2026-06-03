/**
 * Cloudflare cache control for the Zarr serving host (epic #684 / Stream C).
 *
 * The per-recording Zarr stores are read by the browser viewer (zarrita) through
 * a Cloudflare-cached host fronting the public S3 zarr prefix (`ZARR_CACHE_BASE_URL`,
 * e.g. https://zarr.nemar.org). Chunk objects ride a long edge TTL; the small,
 * shared, frequently-read objects (`index.json`, a store's `zarr.json` group
 * metadata) must reflect a re-conversion promptly, so `/webhooks/zarr-ready`
 * actively purges those URLs when a store is rebuilt.
 *
 * This is the project's first Cloudflare-API integration. It is intentionally
 * BEST-EFFORT: a purge failure must never fail the conversion callback (the TTL
 * + ETag revalidation bounds staleness on its own; a missed purge only delays a
 * metadata refresh by up to the TTL). Callers log and carry on.
 *
 * Auth: a scoped Cloudflare API token (`CLOUDFLARE_API_TOKEN`, Workers secret)
 * with the `Zone.Cache Purge` permission on the SCCN zone (`CLOUDFLARE_ZONE_ID`).
 */

import type { Bindings } from "../types/bindings.js";

/** Cloudflare's single-file purge cap is 30 URLs per request on
 *  Free/Pro/Business plans; chunk larger lists to stay within it. */
const PURGE_URLS_PER_REQUEST = 30;

export interface PurgeResult {
  /** True when every batch was accepted (or there was nothing to purge). */
  ok: boolean;
  /** Number of URLs submitted across all batches. */
  submitted: number;
  /** Human-readable reason when `ok` is false or the purge was skipped. */
  detail?: string;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Purge a set of absolute URLs from the Cloudflare edge cache.
 *
 * No-ops (returns `ok: true`) when the integration is unconfigured
 * (`CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ZONE_ID` unset) or the URL list is
 * empty, so a deploy without the secrets degrades to "TTL-only" caching rather
 * than erroring. Never throws.
 */
export async function purgeCacheUrls(env: Bindings, urls: string[]): Promise<PurgeResult> {
  const unique = [...new Set(urls.filter((u) => u && /^https?:\/\//.test(u)))];
  if (unique.length === 0) return { ok: true, submitted: 0 };

  if (!env.CLOUDFLARE_API_TOKEN || !env.CLOUDFLARE_ZONE_ID) {
    return {
      ok: true,
      submitted: 0,
      detail: "cloudflare purge skipped: CLOUDFLARE_API_TOKEN/CLOUDFLARE_ZONE_ID unset",
    };
  }

  const endpoint = `https://api.cloudflare.com/client/v4/zones/${env.CLOUDFLARE_ZONE_ID}/purge_cache`;
  let allOk = true;
  let lastError: string | undefined;

  for (const batch of chunk(unique, PURGE_URLS_PER_REQUEST)) {
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ files: batch }),
      });
      if (!res.ok) {
        allOk = false;
        lastError = `HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`;
        console.error(`[cloudflare] purge_cache batch failed: ${lastError}`);
      }
    } catch (err) {
      allOk = false;
      lastError = err instanceof Error ? err.message : String(err);
      console.error(`[cloudflare] purge_cache request threw: ${lastError}`);
    }
  }

  return { ok: allOk, submitted: unique.length, ...(lastError ? { detail: lastError } : {}) };
}

/**
 * Base URL of the Cloudflare-cached Zarr host, trailing slash stripped.
 * Returns null when `ZARR_CACHE_BASE_URL` is unset (the viewer/CLI then has no
 * host to point at, which is a configuration error surfaced by the caller).
 */
export function zarrCacheBaseUrl(env: Bindings): string | null {
  const raw = env.ZARR_CACHE_BASE_URL?.trim();
  if (!raw) return null;
  return raw.replace(/\/+$/, "");
}

/**
 * Build the absolute, cache-host URLs whose freshness matters most after a
 * store is (re)built: the dataset's `index.json` (so the viewer discovers
 * added/removed stores immediately) and each changed store's root `zarr.json`
 * (group metadata). Chunk objects are intentionally left to ride the edge TTL +
 * ETag revalidation -- enumerating every chunk URL for a URL-list purge is not
 * worthwhile, and prefix purge is Enterprise-only.
 */
export function zarrPurgeTargets(
  env: Bindings,
  datasetId: string,
  changedStorePaths: string[],
): string[] {
  const base = zarrCacheBaseUrl(env);
  if (!base) return [];
  const targets = [`${base}/${datasetId}/zarr/index.json`];
  for (const storePath of changedStorePaths) {
    const clean = storePath.trim().replace(/^\/+/, "").replace(/\/+$/, "");
    if (!clean) continue;
    targets.push(`${base}/${datasetId}/zarr/${clean}/zarr.json`);
  }
  return targets;
}
