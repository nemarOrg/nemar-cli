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

/**
 * A `CacheLike` whose `put()` CONSUMES the response body before storing it,
 * the way the real Workers Cache API does (#1502). `InMemoryCache` above
 * stores a `clone()` and never reads the original, which is fine for a body
 * the caller already holds and wrong for a body the caller is still writing
 * into: nothing would ever pull it. The manifest edge copy is written that
 * way, so its tests need a cache that reads.
 *
 * `readDelayMs` slows the read down (a pause every `readDelayEvery` chunks),
 * standing in for a cache write slower than the scan, which is the case the
 * writer's bounded queue exists for. `keepBodies: false` counts bytes
 * without keeping them, so a memory measurement sees only the code under
 * test and not the cache's own storage.
 */
export class DrainingCache implements CacheLike {
  readonly store = new Map<string, { body: Uint8Array; status: number; headers: Headers }>();
  matches = 0;
  puts = 0;
  /** Bytes read by the last `put()`, whether or not it completed. */
  lastPutBytes = 0;
  /** Why the last `put()` failed, if it did. */
  lastPutError: unknown = null;

  constructor(
    private readonly opts: {
      readDelayMs?: number;
      readDelayEvery?: number;
      keepBodies?: boolean;
    } = {},
  ) {}

  async match(request: RequestInfo | URL): Promise<Response | undefined> {
    this.matches++;
    const stored = this.store.get(keyFor(request));
    if (!stored) return undefined;
    return new Response(stored.body.slice(), { status: stored.status, headers: stored.headers });
  }

  async put(request: RequestInfo | URL, response: Response): Promise<void> {
    this.puts++;
    if (response.status === 206) throw new Error("Cache API cannot store a 206 response");
    this.lastPutBytes = 0;
    this.lastPutError = null;
    const chunks: Uint8Array[] = [];
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const every = this.opts.readDelayEvery ?? 1;
    let n = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        this.lastPutBytes += value.byteLength;
        if (this.opts.keepBodies !== false) chunks.push(value);
        if (this.opts.readDelayMs && ++n % every === 0) await Bun.sleep(this.opts.readDelayMs);
      }
    } catch (err) {
      // The real API rejects the put when the body errors, and stores nothing.
      this.lastPutError = err;
      throw err;
    }
    const body = new Uint8Array(this.lastPutBytes);
    let at = 0;
    for (const c of chunks) {
      body.set(c, at);
      at += c.byteLength;
    }
    this.store.set(keyFor(request), {
      body: this.opts.keepBodies === false ? new Uint8Array(0) : body,
      status: response.status,
      headers: new Headers(response.headers),
    });
  }
}

/** A cache whose `put()` neither reads the body nor ever settles. */
export class StalledCache implements CacheLike {
  puts = 0;
  async match(): Promise<Response | undefined> {
    return undefined;
  }
  put(): Promise<void> {
    this.puts++;
    return new Promise<void>(() => {});
  }
}
