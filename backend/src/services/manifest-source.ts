/**
 * Where the data plane reads a version manifest from: an edge-cached copy
 * when S3 confirms it is current, otherwise S3 itself (#1502).
 *
 * WHY A CACHE. nm000281's manifest is 42,849,468 bytes, and every file,
 * directory and HEAD request for that dataset needs it. Streaming it
 * (`manifest-scan.ts`) bounds the memory; it does not stop each request
 * pulling 43 MB from S3. So the raw body is kept in the Workers Cache API
 * and each use costs S3 a conditional GET that answers 304 with no body.
 *
 * WHY REVALIDATE EVERY USE, rather than trust a TTL. A version's manifest is
 * NOT immutable in practice: the S3 objects for nm000132's three versions
 * were all last written on 2026-05-27, months after those versions were
 * published, and nm000281's on 2026-08-31, because the pipeline regenerates
 * manifests (the missing-manifest heal, the central workflow re-running).
 * A cache that answered from a copy without asking would serve a rewritten
 * manifest stale, and the manifest is the capability list (ADR 0066): which
 * paths are readable at all. So the copy is stored with the S3 ETag it came
 * with and every use sends `If-None-Match`; only a 304 lets the copy answer.
 * A rewrite gets a 200 with the new body, which replaces the copy. A deleted
 * object gets a 404 and the route answers exactly as it did without a cache.
 * The cache changes where the bytes come from, never what the route decides.
 *
 * THE GATE STAYS IN FRONT. Every caller runs `loadPublishedDataset` (the
 * visibility check) before it reads a manifest, so an entry, including one
 * for a manifest that needed the signed fallback, is only ever read on
 * behalf of a request that already passed the gate for that dataset. The key
 * is dataset- and version-scoped, never content-addressed (ADR 0066's rule
 * for the brokered files, for the same reason: a content-keyed entry would be
 * shared between datasets), and it lives under a path no public route
 * serves, so no request can read an entry directly.
 *
 * MEMORY ON A MISS. The body goes to the scanner and to `cache.put` at the
 * same time without being held whole: chunks for the cache pass through a
 * stream whose queue is capped at {@link CACHE_WRITE_MAX_LAG_BYTES}, and the
 * scan waits for the cache to drain below the cap. A cache write that stops
 * reading (a `put` that settles without consuming the body, or one that
 * stalls for {@link CACHE_STALL_MS}) is abandoned and the scan carries on
 * alone, so the cache can slow a request down but can never make it hold the
 * manifest. An entry is only committed after the scan has accepted the whole
 * document; a body that fails to scan, or that breaks off mid-read, is never
 * stored.
 */

import type { ManifestQuery } from "./manifest-queries";
import { type ManifestHeader, type ScanResult, scanManifestStream } from "./manifest-scan";
import { type ManifestObjectFetch, type PresignedUrlOptions, fetchManifestObject } from "./s3";

/** The two Cache API methods this uses; `caches.default` in a Worker. */
export type ManifestCache = Pick<Cache, "match" | "put">;

export interface ManifestSource {
  s3: PresignedUrlOptions;
  /** The edge cache, or null where there is none (`bun test`, a preview). */
  cache: ManifestCache | null;
  /** Origin of the request being served; the cache key is built on it. */
  cacheOrigin: string;
  /** Override of {@link CACHE_STALL_MS}, for the stalled-cache test. */
  cacheStallMs?: number;
}

/**
 * `ok` carries the query that ran rather than its answer: the caller calls
 * `finish` itself, outside whatever it wraps this in, so an exception from
 * answering (the `TypeError` a `null` entry has always produced) keeps its
 * old meaning instead of being mistaken for a failed read.
 */
export type ManifestRead<T> =
  | { kind: "ok"; header: ManifestHeader; query: ManifestQuery<T> }
  /** 404, or a 403 the signed fallback could not get past (both logged by s3.ts). */
  | { kind: "absent" }
  | { kind: "malformed"; message: string }
  | { kind: "no_files" };

/**
 * How far the cache write may fall behind the scan before the scan waits for
 * it. This, not the manifest, is the most a miss holds for the cache.
 */
export const CACHE_WRITE_MAX_LAG_BYTES = 4 * 1024 * 1024;

/**
 * How long the scan waits for a cache write that has stopped draining before
 * abandoning it. Far above a healthy write's pace; it exists so a wedged
 * `put` costs one delay and an uncached answer, never a hung request.
 */
export const CACHE_STALL_MS = 5000;

/**
 * Lifetime of an edge copy. Long, because it is revalidated against S3 on
 * every use and a stale copy can never answer; the TTL only bounds how long
 * an unused copy occupies the cache.
 */
export const MANIFEST_CACHE_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * The synthetic key an edge copy lives under. The path is not one the data
 * routes serve (`__nemar-internal` fails the dataset-id check with a 404),
 * and `v1` names the entry format so a change to it can move to new keys.
 */
export function manifestCacheKey(origin: string, datasetId: string, version: string): string {
  const tag = version.startsWith("v") ? version : `v${version}`;
  return `${origin}/__nemar-internal/manifest-cache/v1/${encodeURIComponent(datasetId)}/${encodeURIComponent(tag)}.json`;
}

let warnedIgnoredCondition = false;

/**
 * Read one manifest and answer one query from it. `makeQuery` is a factory
 * because a scan of a damaged edge copy is retried from S3 with a fresh query.
 * Transport failures (an S3 5xx, a body that breaks off) throw, as
 * `getManifest` did; the caller logs them.
 */
export async function readManifest<T>(
  source: ManifestSource,
  datasetId: string,
  version: string,
  makeQuery: () => ManifestQuery<T>,
): Promise<ManifestRead<T>> {
  const key = manifestCacheKey(source.cacheOrigin, datasetId, version);
  const cached = source.cache ? await matchEdgeCopy(source.cache, key) : null;

  if (cached !== null) {
    let fetched: ManifestObjectFetch;
    try {
      fetched = await fetchManifestObject(source.s3, datasetId, version, {
        ifNoneMatch: cached.etag,
      });
    } catch (err) {
      await cached.body.cancel().catch(() => {});
      throw err;
    }
    if (fetched.kind === "not_modified") {
      const query = makeQuery();
      const fromCopy = await scanEdgeCopy(cached.body, query, { datasetId, version, key });
      if (fromCopy !== null) return settle(fromCopy, query);
      // The copy could not be read back whole, so S3 answers instead, exactly
      // as if there had been no copy. It is re-stored from that read.
      return fromS3(
        source,
        key,
        await fetchManifestObject(source.s3, datasetId, version),
        makeQuery,
      );
    }
    await cached.body.cancel().catch(() => {});
    if (
      fetched.kind === "found" &&
      fetched.response.headers.get("ETag") === cached.etag &&
      !warnedIgnoredCondition
    ) {
      // Correct either way (the body is read and re-stored), but it means
      // every use is paying for the full transfer the cache exists to avoid.
      warnedIgnoredCondition = true;
      console.warn(
        `[manifest-cache] S3 answered 200 to If-None-Match for an unchanged ETag; the condition may not be reaching S3 dataset=${datasetId} version=${version}`,
      );
    }
    return fromS3(source, key, fetched, makeQuery);
  }

  return fromS3(source, key, await fetchManifestObject(source.s3, datasetId, version), makeQuery);
}

function settle<T>(result: ScanResult, query: ManifestQuery<T>): ManifestRead<T> {
  if (result.kind !== "ok") return result;
  return { kind: "ok", header: result.header, query };
}

async function matchEdgeCopy(
  cache: ManifestCache,
  key: string,
): Promise<{ etag: string; body: ReadableStream<Uint8Array> } | null> {
  let hit: Response | undefined;
  try {
    hit = await cache.match(new Request(key, { method: "GET" }));
  } catch (err) {
    // A cache outage degrades to reading S3, which is what happened before
    // the cache existed.
    console.error(
      `[manifest-cache] match failed key=${key}:`,
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
  if (!hit) return null;
  const etag = hit.headers.get("ETag");
  if (!hit.ok || !etag || !hit.body) {
    await hit.body?.cancel().catch(() => {});
    return null;
  }
  return { etag, body: hit.body };
}

/**
 * Scan an edge copy. `null` means the copy is unusable and S3 should answer:
 * a read error, or any verdict other than `ok`. The second is not a judgment
 * about the manifest: only a copy whose scan was accepted is ever stored, so a
 * copy that no longer scans is a damaged copy, and the manifest it came from
 * deserves to be read again rather than reported broken on the copy's word.
 */
async function scanEdgeCopy<T>(
  body: ReadableStream<Uint8Array>,
  query: ManifestQuery<T>,
  where: { datasetId: string; version: string; key: string },
): Promise<ScanResult | null> {
  let result: ScanResult;
  try {
    result = await scanManifestStream(body, query);
  } catch (err) {
    console.error(
      `[manifest-cache] edge copy failed mid-read; reading S3 instead dataset=${where.datasetId} version=${where.version}:`,
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
  if (result.kind !== "ok") {
    console.error(
      `[manifest-cache] edge copy did not scan (${result.kind}); reading S3 instead dataset=${where.datasetId} version=${where.version}`,
    );
    return null;
  }
  return result;
}

async function fromS3<T>(
  source: ManifestSource,
  key: string,
  fetched: ManifestObjectFetch,
  makeQuery: () => ManifestQuery<T>,
): Promise<ManifestRead<T>> {
  if (fetched.kind !== "found") return { kind: "absent" };
  const { response } = fetched;
  const body = response.body;
  const query = makeQuery();
  if (!body) {
    // A 200 with no body is an empty document, which `JSON.parse("")`
    // rejects; say so the same way.
    return { kind: "malformed", message: "Unexpected end of JSON input at position 0" };
  }
  const etag = response.headers.get("ETag");
  const sink =
    source.cache && etag
      ? new EdgeCopyWriter(source.cache, key, etag, source.cacheStallMs ?? CACHE_STALL_MS)
      : null;
  let result: ScanResult;
  try {
    result = await scanManifestStream(body, query, sink ? (chunk) => sink.write(chunk) : undefined);
  } catch (err) {
    await sink?.discard(err);
    throw err;
  }
  if (result.kind === "ok") await sink?.commit();
  else await sink?.discard(new Error(`manifest did not scan: ${result.kind}`));
  return settle(result, query);
}

/**
 * One `cache.put` fed chunk by chunk, through a queue this class bounds
 * itself. See the module comment for why it may give up and why giving up is
 * always safe.
 *
 * The body handed to `cache.put` is a pull stream with no queue of its own
 * (`highWaterMark: 0`): it releases a chunk only when the cache asks for one,
 * so every byte not yet taken is in `queue`, where it is counted. A
 * `TransformStream` would do the same on paper, but a runtime is free to drain
 * a Response's stream body into its own buffer ahead of the reader (Bun does,
 * measured while writing this), which hides the lag and the memory it costs.
 */
class EdgeCopyWriter {
  private readonly queue: Uint8Array[] = [];
  private queuedBytes = 0;
  /** `open` takes chunks; `closed` has had its last one; `done` is finished or dropped. */
  private state: "open" | "closed" | "done" = "open";
  private controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  /** Wakes a pull that found the queue empty. */
  private wakePull: (() => void) | null = null;
  /**
   * Wakes a write that is waiting on the cache: the queue drained below the
   * cap, the put settled, or the stall bound passed. ONE resolver, not a
   * `Promise.race` against `putSettled`: racing a promise that stays pending
   * for the whole scan leaves a reaction on it per wait, and each reaction
   * keeps that wait's chunk alive (measured under Bun: 300 waits on 64 KB
   * chunks retained 39 MB). That leak would have been the manifest again.
   */
  private wakeWriter: ((why: "drained" | "settled" | "stalled") => void) | null = null;
  /** Settles (never rejects) when `cache.put` does. */
  private readonly putSettled: Promise<void>;
  private putDone = false;

  constructor(
    cache: ManifestCache,
    private readonly key: string,
    etag: string,
    private readonly stallMs: number,
  ) {
    const body = new ReadableStream<Uint8Array>(
      {
        start: (controller) => {
          this.controller = controller;
        },
        pull: (controller) => this.pull(controller),
        cancel: () => {
          // The cache stopped reading for good: nothing will drain the queue.
          this.drop();
        },
      },
      { highWaterMark: 0 },
    );
    const entry = new Response(body, {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": `max-age=${MANIFEST_CACHE_TTL_SECONDS}`,
        ETag: etag,
      },
    });
    this.putSettled = (async () => {
      try {
        await cache.put(new Request(key, { method: "GET" }), entry);
      } catch (err) {
        // Expected when the write was abandoned or discarded (the body was
        // errored on purpose); otherwise a real cache failure. Either way the
        // answer is unaffected; only the next request's cost is.
        console.warn(
          `[manifest-cache] put did not complete key=${this.key}:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    })();
    this.putSettled.then(() => {
      this.putDone = true;
      this.wakeWriter?.("settled");
    });
  }

  async write(chunk: Uint8Array): Promise<void> {
    if (this.state !== "open") return;
    this.queue.push(chunk);
    this.queuedBytes += chunk.byteLength;
    this.wakePull?.();
    if (this.queuedBytes <= CACHE_WRITE_MAX_LAG_BYTES) return;

    // The cache is a full cap behind: wait for it to drain, but never on one
    // that has stopped reading (its put settled, or it cancelled the body)
    // and never past the stall bound.
    const outcome = this.putDone
      ? "settled"
      : await new Promise<"drained" | "settled" | "stalled">((resolve) => {
          const timer = setTimeout(() => wake("stalled"), this.stallMs);
          const wake = (why: "drained" | "settled" | "stalled") => {
            clearTimeout(timer);
            this.wakeWriter = null;
            resolve(why);
          };
          this.wakeWriter = wake;
        });
    if (this.state !== "open") return;
    if (outcome === "drained") return;
    console.warn(
      `[manifest-cache] abandoning the edge-cache write (${outcome}); answering without it key=${this.key}`,
    );
    await this.discard(new Error(`edge-cache write abandoned: ${outcome}`));
  }

  /** The scan accepted the document: let the cache read to the end. */
  async commit(): Promise<void> {
    if (this.state === "open") {
      this.state = "closed";
      this.wakePull?.();
    }
    await this.putOrTimeout();
  }

  /** Error the entry's body so the cache never stores a partial copy. */
  async discard(reason: unknown): Promise<void> {
    if (this.state !== "done") {
      this.drop();
      try {
        this.controller?.error(reason);
      } catch {
        // Already closed or errored; nothing left to stop.
      }
    }
    await this.putOrTimeout();
  }

  private pull(controller: ReadableStreamDefaultController<Uint8Array>): Promise<void> | undefined {
    if (this.serve(controller)) return undefined;
    return new Promise<void>((resolve) => {
      this.wakePull = () => {
        if (!this.serve(controller)) return;
        this.wakePull = null;
        resolve();
      };
    });
  }

  /** Give the cache one chunk, or the end. False when there is nothing yet. */
  private serve(controller: ReadableStreamDefaultController<Uint8Array>): boolean {
    const chunk = this.queue.shift();
    if (chunk !== undefined) {
      this.queuedBytes -= chunk.byteLength;
      controller.enqueue(chunk);
      if (this.queuedBytes <= CACHE_WRITE_MAX_LAG_BYTES) this.wakeWriter?.("drained");
      return true;
    }
    if (this.state === "closed") {
      this.state = "done";
      controller.close();
      return true;
    }
    return this.state === "done";
  }

  private drop(): void {
    this.state = "done";
    this.queue.length = 0;
    this.queuedBytes = 0;
    this.wakeWriter?.("drained");
    this.wakePull?.();
  }

  /**
   * Wait for the put to finish, but never longer than the stall bound: the
   * answer is already known, and a wedged cache must not hold it back.
   */
  private async putOrTimeout(): Promise<void> {
    if (this.putDone) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, this.stallMs);
      function done() {
        clearTimeout(timer);
        resolve();
      }
      // One reaction per writer, attached after the scan: nothing to retain.
      this.putSettled.then(done);
    });
  }
}
