/**
 * One fetch path for DOI registry records, shared by ORCID discovery
 * (doi-orcid-discovery.ts, enrichment stages 1b and 2c) and DOI metadata
 * resolution (doi-metadata.ts, stage 1d), so an enrichment run asks each
 * registry about each DOI once (#1549).
 *
 * DataCite content negotiation answers for DataCite AND Crossref DOIs in one
 * shape; Crossref's REST API is the second opinion. Every lookup is
 * classified, because "the registry says this DOI does not exist" and "the
 * registry did not answer" call for different follow-ups: the first is a
 * fact about the DOI, the second is an outage, which only reindexing the
 * dataset again can recover from (nothing in the backend retries).
 */

import { normalizeDoiKey } from "../../../shared/never-data-paper.js";

export type RegistryName = "DataCite" | "Crossref";

export type RegistryRecord =
  | { outcome: "found"; body: unknown }
  /** The registry answered that it has no such DOI (HTTP 400, 404, 410). */
  | { outcome: "absent" }
  /** No usable answer: rate limit (429), server error, timeout, network
   *  failure, or an unparseable body. The DOI may well exist. */
  | { outcome: "failed"; detail: string };

/** Per-run memo keyed by registry and normalized DOI. It holds the promise,
 *  so concurrent lookups of one DOI share a single request. */
export type RegistryCache = Map<string, Promise<RegistryRecord>>;

// Polite pool: identify ourselves per Crossref etiquette.
const USER_AGENT = "NEMAR/1.0 (https://nemar.org; mailto:nemar@ucsd.edu)";
const REGISTRY_TIMEOUT_MS = 10_000;
const ABSENT_STATUSES: ReadonlySet<number> = new Set([400, 404, 410]);

const REGISTRY_ENDPOINTS: Record<RegistryName, { base: string; accept: string }> = {
  DataCite: {
    base: "https://api.datacite.org/application/vnd.datacite.datacite+json",
    accept: "application/vnd.datacite.datacite+json",
  },
  Crossref: { base: "https://api.crossref.org/works", accept: "application/json" },
};

/** How an HTTP status from a registry reads: a record, a definite "no such
 *  DOI", or no answer (429 and 5xx included) that a retry may fix. */
export function classifyRegistryStatus(status: number): "found" | "absent" | "failed" {
  if (ABSENT_STATUSES.has(status)) return "absent";
  return status >= 200 && status < 300 ? "found" : "failed";
}

function isNetworkError(err: unknown): boolean {
  const msg = err instanceof Error ? `${err.name} ${err.message}` : String(err);
  return /AbortError|TimeoutError|timeout|fetch|network/i.test(msg);
}

async function fetchOnce(
  registry: RegistryName,
  doiKey: string,
  deadline?: AbortSignal,
): Promise<RegistryRecord> {
  const { base, accept } = REGISTRY_ENDPOINTS[registry];
  const perRequest = AbortSignal.timeout(REGISTRY_TIMEOUT_MS);
  try {
    const response = await fetch(`${base}/${encodeURIComponent(doiKey)}`, {
      headers: { Accept: accept, "User-Agent": USER_AGENT },
      signal: deadline ? AbortSignal.any([perRequest, deadline]) : perRequest,
    });
    const verdict = classifyRegistryStatus(response.status);
    if (verdict === "absent") return { outcome: "absent" };
    if (verdict === "failed") {
      const detail = `HTTP ${response.status}`;
      console.warn(`[doi-registry] ${registry} returned ${detail} for ${doiKey}`);
      return { outcome: "failed", detail };
    }
    return { outcome: "found", body: await response.json() };
  } catch (err) {
    // The caller's deadline, not the registry: one summary line is logged
    // by the caller rather than a warning per request.
    if (deadline?.aborted) return { outcome: "failed", detail: "deadline reached" };
    const detail = err instanceof Error ? err.message : String(err);
    if (isNetworkError(err)) {
      console.warn(`[doi-registry] ${registry} lookup failed for ${doiKey}: ${detail}`);
    } else {
      console.error(`[doi-registry] Unexpected error querying ${registry} for ${doiKey}:`, err);
    }
    return { outcome: "failed", detail };
  }
}

/** Fetch one registry's record for `doi`, through `cache` when given. Never
 *  rejects: every failure comes back as `{ outcome: "failed" }`. A registry
 *  or network failure is logged per request; the deadline is not, since the
 *  caller logs one summary line for it.
 *
 *  `deadline` aborts the request when the caller's overall budget runs out
 *  (it composes with the per-request timeout). A cached answer is returned
 *  even after the deadline, since it costs nothing, but no new request starts
 *  once the deadline has passed. Any failed lookup that settles after the
 *  deadline is evicted from the cache, because a failure then says nothing
 *  about the registry and a later stage should be free to ask again. */
export function fetchRegistryRecord(
  registry: RegistryName,
  doi: string,
  cache?: RegistryCache,
  deadline?: AbortSignal,
): Promise<RegistryRecord> {
  const doiKey = normalizeDoiKey(doi);
  const cacheKey = `${registry}:${doiKey}`;
  const hit = cache?.get(cacheKey);
  if (hit) return hit;
  if (deadline?.aborted) {
    return Promise.resolve<RegistryRecord>({ outcome: "failed", detail: "deadline reached" });
  }
  const pending = fetchOnce(registry, doiKey, deadline);
  if (cache) {
    cache.set(cacheKey, pending);
    if (deadline) {
      void pending.then((record) => {
        if (record.outcome === "failed" && deadline.aborted && cache.get(cacheKey) === pending) {
          cache.delete(cacheKey);
        }
      });
    }
  }
  return pending;
}
