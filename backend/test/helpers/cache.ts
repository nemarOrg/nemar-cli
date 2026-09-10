// Shared real (in-memory) `CacheLike` test double (epic #1065 phase 3, issue
// #1295). Moved here from `zarr-data-cache.test.ts` (#1178 phase 1) so the
// MCP recording-tools tests
// (`mcp-recording-tools.test.ts`, `mcp-overview.test.ts`,
// `mcp-projection-cache.test.ts`, `mcp-index-reader.test.ts`) can share the
// same implementation zarr-data.ts's own edge-cache tests already trust.
//
// Whatever is `put()` is what `match()` returns, keyed by request URL,
// nothing canned -- and it throws on a 206 exactly like the real Workers
// Cache API does (`InMemoryCache.put` below), matching the real API's
// documented refusal to store a Partial Content response.

import type { CacheLike } from "../../src/routes/zarr-data.js";

/** Exported too: `zarr-data-cache.test.ts`'s `RateLimitCache` (a distinct,
 *  full `Cache`-shaped double for the rate limiter's own `caches.default`
 *  use) keys its store the same way. */
export function keyFor(request: RequestInfo | URL): string {
  return request instanceof Request ? request.url : String(request);
}

export class InMemoryCache implements CacheLike {
  private store = new Map<string, Response>();

  async match(request: RequestInfo | URL): Promise<Response | undefined> {
    const stored = this.store.get(keyFor(request));
    return stored?.clone();
  }

  async put(request: RequestInfo | URL, response: Response): Promise<void> {
    // The real Workers Cache API refuses to store a 206 Partial Content
    // response outright (`cache.put` throws) -- mirrored here so any
    // FUTURE code path that tries to put a raw 206 (rather than the
    // synthetic 200 `zarr-data.ts` writes for a cached range, or a real
    // 404 negative entry -- both of which the real API DOES accept) fails
    // the same way in tests (#1181 review item 13).
    if (response.status === 206) {
      throw new Error("Cache API cannot store a 206 response");
    }
    this.store.set(keyFor(request), response.clone());
  }
}
