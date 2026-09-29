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
//
// #1516 review: a bug slipped past these doubles because they modeled
// storage but not EXPIRY -- a stored entry answered forever, so a test could
// not tell "cached" from "cached for five more minutes". Three more real
// Workers Cache API rules are modeled now:
//  - An entry expires from its OWN stored `Cache-Control` (`s-maxage` when
//    present, else `max-age` -- the real Cache API is a shared cache and
//    prefers `s-maxage`, RFC 9111 SS5.2.2.10), the same number the real edge
//    honors to decide whether `cache.match` answers or returns `undefined`.
//    `getNow` is an injectable clock (defaulting to the real wall clock,
//    matching `rate-limit-buckets.test.ts`'s own double) so a test can
//    simulate time passing without a real sleep. An entry with no
//    `Cache-Control` at all -- true only of a handful of tests that poke
//    `.store` directly rather than going through `put()` -- never expires;
//    every real write in this codebase sets one.
//  - `Vary: *` is refused outright (`put()` throws), because there is no way
//    to key a cache entry on "every possible header". Only the literal `*`
//    value is refused: `Vary: Accept` and `Vary: Origin`, which the data and
//    zarr routes both store, are unaffected -- the real API does not use a
//    named Vary for cache-key partitioning, but it does not refuse to store
//    one either.
//  - A response carrying `Set-Cookie` is never stored. Quieter than the two
//    refusals above: `put()` still resolves (a caller that does not check
//    the promise must not be surprised by a thrown rejection for a header it
//    did not choose), the entry is simply never written, so the next
//    `match()` on that key answers exactly as if nothing had been stored.

import type { CacheLike } from "../../src/routes/zarr-data.js";

/** Exported too: `zarr-data-cache.test.ts`'s `RateLimitCache` (a distinct,
 *  full `Cache`-shaped double for the rate limiter's own `caches.default`
 *  use) keys its store the same way. */
export function keyFor(request: RequestInfo | URL): string {
  return request instanceof Request ? request.url : String(request);
}

function directiveSeconds(cacheControl: string, directive: "s-maxage" | "max-age"): number | null {
  const m = cacheControl.match(new RegExp(`(?:^|[,\\s])${directive}=(\\d+)`, "i"));
  return m ? Number(m[1]) : null;
}

/** `s-maxage=<seconds>` if a stored response carries one, else
 *  `max-age=<seconds>`, else `null` ("never expires" -- see the module
 *  comment). The real Workers Cache API is a shared cache, and RFC 9111
 *  SS5.2.2.10 gives `s-maxage` precedence over `max-age` for exactly that
 *  kind of cache when a response carries both -- `catalog.ts` and `data.ts`
 *  both set `public, max-age=<client>, s-maxage=<edge>` pairs, so a test
 *  double that only read `max-age` would honor the wrong number for those. */
function maxAgeSecondsOf(headers: Headers): number | null {
  const raw = headers.get("Cache-Control");
  if (!raw) return null;
  return directiveSeconds(raw, "s-maxage") ?? directiveSeconds(raw, "max-age");
}

/** Whether `getNow() - storedAtMs` has passed the entry's own max-age.
 *  `storedAtMs` defaults to 0 (i.e., "already expired") for an entry that
 *  reached `.store` without going through `put()`; harmless in practice
 *  because every such entry in this codebase also has no `Cache-Control`,
 *  which already short-circuits this to `false` above. */
function isExpired(headers: Headers, storedAtMs: number | undefined, now: number): boolean {
  const maxAgeSeconds = maxAgeSecondsOf(headers);
  if (maxAgeSeconds === null) return false;
  return now - (storedAtMs ?? 0) >= maxAgeSeconds * 1000;
}

/** Throws for `Vary: *`, exactly like the real Cache API's outright refusal.
 *  Named separately from the 206 check because it guards a HEADER, not the
 *  status, and the two are pinned by different tests. */
function assertVaryStorable(response: Response): void {
  if (response.headers.get("Vary") === "*") {
    throw new Error("Cache API cannot store a response with Vary: *");
  }
}

export class InMemoryCache implements CacheLike {
  private store = new Map<string, { response: Response; headers: Headers; storedAtMs: number }>();

  /** Injected clock; see the module comment. */
  getNow: () => number = () => Date.now();

  async match(request: RequestInfo | URL): Promise<Response | undefined> {
    const key = keyFor(request);
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (isExpired(entry.headers, entry.storedAtMs, this.getNow())) {
      this.store.delete(key);
      return undefined;
    }
    return entry.response.clone();
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
    assertVaryStorable(response);
    if (response.headers.has("Set-Cookie")) return;
    this.store.set(keyFor(request), {
      response: response.clone(),
      headers: response.headers,
      storedAtMs: this.getNow(),
    });
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
  readonly store = new Map<
    string,
    { body: Uint8Array; status: number; headers: Headers; storedAtMs?: number }
  >();
  matches = 0;
  puts = 0;
  /** Bytes read by the most recently started `put()`, whether or not it completed. */
  lastPutBytes = 0;
  /** Why the last `put()` failed, if it did. */
  lastPutError: unknown = null;
  private startedPuts = 0;

  /** Injected clock; see the module comment. Some tests inject a store
   *  entry directly (bypassing `put()`, to simulate a damaged copy) and
   *  those entries carry no `storedAtMs` -- `isExpired` treats that as `0`,
   *  which only matters when the entry also carries a `Cache-Control`, and
   *  none of today's direct-injection tests do. */
  getNow: () => number = () => Date.now();

  async match(request: RequestInfo | URL): Promise<Response | undefined> {
    this.matches++;
    const key = keyFor(request);
    const stored = this.store.get(key);
    if (!stored) return undefined;
    if (isExpired(stored.headers, stored.storedAtMs, this.getNow())) {
      this.store.delete(key);
      return undefined;
    }
    return new Response(stored.body.slice(), { status: stored.status, headers: stored.headers });
  }

  async put(request: RequestInfo | URL, response: Response): Promise<void> {
    this.puts++;
    if (response.status === 206) throw new Error("Cache API cannot store a 206 response");
    assertVaryStorable(response);
    const declineStorage = response.headers.has("Set-Cookie");
    // Each put counts its own bytes: two puts can be in flight at once, as
    // concurrent requests in one isolate make them, and a count shared on
    // the instance would size one copy from the other's reads.
    const started = ++this.startedPuts;
    let read = 0;
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
        read += value.byteLength;
        if (started === this.startedPuts) this.lastPutBytes = read;
        if (this.opts.keepBodies !== false) chunks.push(value);
        if (this.opts.readDelayMs && ++n % every === 0) await Bun.sleep(this.opts.readDelayMs);
      }
    } catch (err) {
      // The real API rejects the put when the body errors, and stores nothing.
      this.lastPutError = err;
      throw err;
    }
    // The real API still drains a Set-Cookie response's body (the request
    // completes) before declining to keep it; only the final store write is
    // skipped.
    if (declineStorage) return;
    const body = new Uint8Array(read);
    let at = 0;
    for (const c of chunks) {
      body.set(c, at);
      at += c.byteLength;
    }
    this.store.set(keyFor(request), {
      body: this.opts.keepBodies === false ? new Uint8Array(0) : body,
      status: response.status,
      headers: new Headers(response.headers),
      storedAtMs: this.getNow(),
    });
  }

  constructor(
    private readonly opts: {
      readDelayMs?: number;
      readDelayEvery?: number;
      keepBodies?: boolean;
    } = {},
  ) {}
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
