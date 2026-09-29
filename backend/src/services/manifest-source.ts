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
 * WHY REVALIDATE, rather than trust a TTL forever. A version's manifest is
 * NOT immutable in practice: the S3 objects for nm000132's three versions
 * were all last written on 2026-05-27, months after those versions were
 * published, and nm000281's on 2026-08-31, because the pipeline regenerates
 * manifests (the missing-manifest heal, the central workflow re-running).
 * A cache that answered from a copy without asking would serve a rewritten
 * manifest stale, and the manifest is the capability list (ADR 0066): which
 * paths are readable at all. So the copy is stored with the S3 ETag it came
 * with, and every use OUTSIDE the trust window below sends `If-None-Match`;
 * only a 304 lets the copy answer. A rewrite gets a 200 with the new body,
 * which replaces the copy. A deleted object gets a 404 and the route answers
 * exactly as it did without a cache. The cache changes where the bytes come
 * from, never what the route decides.
 *
 * THE TRUST WINDOW (#1494 amendment, 2026-09-28 -- ADR 0072). Staging
 * measured this module's OWN conditional GET as most of a cache hit's cost
 * (120-460ms of a 200-600ms response) once the Worker itself was no longer
 * colocated with its backends: every read paid a cross-colo round trip to S3
 * to confirm what the last read already confirmed a moment earlier. An edge
 * copy validated within the last {@link MANIFEST_TRUST_WINDOW_MS} is now used
 * WITHOUT asking S3 again; the validation time is recorded as a header on the
 * stored copy itself (`X-Nemar-Manifest-Validated-At`), not in per-isolate
 * memory, so the window is a property of the CACHE ENTRY and applies across
 * every isolate sharing it in a data center, not just the one that first
 * validated it. Once the window has passed, the next read revalidates against
 * S3 exactly as before; a 304 there both answers the read and restamps the
 * copy's validated-at time (streamed through the same bounded-queue writer a
 * miss uses, never buffered whole), so the window is a rolling one, and a
 * genuine rewrite (a 200 instead of a 304) is still caught the moment the
 * window next expires -- at most {@link MANIFEST_TRUST_WINDOW_MS} after it
 * happens, never later. See `manifest-answer-memo.ts` for the second,
 * independent speedup layered on top: memoizing the ANSWER, so a warm isolate
 * does not even re-scan the (now-trusted) copy for a query it has already run.
 *
 * THE GATE STAYS IN FRONT, for both. Every caller runs `loadPublishedDataset` (the
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
 * stored. In a Worker the tail of the write goes to `waitUntil`, so the cache
 * never delays an answer that is already known.
 */

import { ManifestAnswerMemo } from "./manifest-answer-memo";
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
  /**
   * `executionCtx.waitUntil` in a Worker. With it, finishing the cache write
   * is handed to the runtime and never delays the answer; without it (the
   * unit suites), the answer waits for the write, at most the stall bound.
   */
  waitUntil?: (work: Promise<unknown>) => void;
  /**
   * The clock the trust window is measured against. Defaults to `Date.now`;
   * tests override it to move a cached copy in and out of the window without
   * a real sleep, the same pattern `test/helpers/cache.ts`'s `getNow` uses.
   */
  now?: () => number;
}

/**
 * How a read's answer was obtained, for `Server-Timing` (#1494 amendment):
 * `"memo"` skipped both S3 and the scan (the per-isolate answer memo already
 * held this exact query); `"fresh"` skipped S3 (the copy was within the trust
 * window) but still scanned; `"revalidated"` asked S3 and got a 304;
 * `"rewrite"` asked S3 (or had no usable copy at all) and got a fresh 200.
 */
export type ManifestReadSource = "memo" | "fresh" | "revalidated" | "rewrite";

/**
 * `ok` carries the query that ran rather than its answer: the caller calls
 * `finish` itself, outside whatever it wraps this in, so an exception from
 * answering (the `TypeError` a `null` entry has always produced) keeps its
 * old meaning instead of being mistaken for a failed read. This still holds
 * for a `"memo"` source too -- `query` there is a trivial wrapper whose
 * `finish` only returns a value that a real `finish()` call already produced
 * successfully once before, so it cannot newly throw, but the caller's
 * calling convention (finish outside this module's own try/catch) stays the
 * same regardless of which source answered.
 *
 * `etag` is the manifest object's CURRENT S3 ETag -- the one the edge copy
 * either just confirmed with a 304, just stored fresh from a 200, or (on a
 * `"memo"` source) was keyed under when this exact answer was first
 * memoized -- so a caller that wants to key its own cache off "this exact
 * manifest" (#1522's manifest.json response cache) never has to fetch the
 * object a second time to learn it. `null` only when S3 answered without
 * one, which `settle` cannot recover from; a caller that needs the etag
 * treats `null` as "do not cache this answer" rather than a fault.
 *
 * `memoKey` is set on every NON-memo source that has a usable ETag: the
 * caller stores the finished answer under it (`rememberManifestAnswer`),
 * again outside this module, for the same reason `finish()` is called
 * outside it. `null` when the answer already came from the memo (nothing
 * further to store) or no ETag was available to key it safely by.
 */
export type ManifestRead<T> =
  | {
      kind: "ok";
      header: ManifestHeader;
      query: ManifestQuery<T>;
      etag: string | null;
      source: ManifestReadSource;
      memoKey: string | null;
    }
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

/**
 * How long an edge copy is trusted without asking S3 again (#1494 amendment,
 * ADR 0072). 60 seconds: manifests are rewritten in place but rarely (a
 * publish, a heal run, not continuously), and every client-facing response
 * this route already serves is trusted for at least as long without
 * revalidation -- `public, max-age=60` on the JSON directory listing,
 * `manifest.json` and the tombstone 404, `max-age=300` on a brokered
 * git-tracked file. This window is therefore never the largest source of
 * staleness a client already accepts; it only removes a REDUNDANT S3 round
 * trip the client cannot observe either way. A rewrite still takes effect
 * within this many seconds of the window's start, never later (see
 * `manifest-source.test.ts`, "a rewrite is visible within the trust window").
 */
export const MANIFEST_TRUST_WINDOW_MS = 60_000;

/**
 * Marker on a STORED edge copy only, recording when it was last confirmed
 * fresh against S3 (a first store, or a later 304). Never read by anything
 * outside this module: unlike the git-file cache (`git-file-cache.ts`), the
 * manifest's own bytes never reach a client directly, so there is no
 * client-facing header to protect here.
 */
const VALIDATED_AT_HEADER = "X-Nemar-Manifest-Validated-At";

/**
 * The per-isolate memo of a query's finished answer (`manifest-answer-memo.ts`).
 * Module-level so it survives across requests in a warm isolate, the same
 * lifetime `announced` above already has.
 */
const manifestAnswerMemo = new ManifestAnswerMemo();

/**
 * The composite key a memoized answer lives under: the manifest's own content
 * identity (dataset, version, ETag) plus the caller's own description of
 * which question was asked of it, joined by `\u0000`.
 *
 * Each component is `encodeURIComponent`-escaped first (the same defense
 * `manifestCacheKey` already uses for its own synthetic key), so the raw
 * `\u0000` separator can only ever appear as a separator, never inside a
 * component -- `encodeURIComponent` always emits `%00` for a literal NUL,
 * never the byte itself. This is load-bearing, not decorative: `queryDescriptor`
 * is built from a raw, URL-decoded BIDS path (`resolve:${rawPath}`,
 * `contains:${tombstonePath}`), so a request naming a path with an embedded
 * NUL controls part of this key directly. Without escaping, a NUL inside one
 * component can shift where the join "appears" to fall, making two DIFFERENT
 * tuples produce the IDENTICAL key -- for example
 * `("a\0b", "c", "d", "e")` and `("a", "b\0c", "d", "e")` both joined to the
 * literal 9-character string `a\0b\0c\0d\0e` under a plain join. Escaping
 * first makes that impossible by construction rather than relying on an
 * assumption that no component ever contains the separator.
 */
export function manifestAnswerKey(
  datasetId: string,
  version: string,
  etag: string,
  queryDescriptor: string,
): string {
  return [datasetId, version, etag, queryDescriptor].map(encodeURIComponent).join("\u0000");
}

/** What the memo stores per key: the answer, the header it was read with (a
 *  memo hit skips the scan entirely, so there is no fresh header to pair the
 *  answer with otherwise), and the ETag it was keyed under (so a `"memo"`
 *  source can still carry `ManifestRead.ok.etag`, same as every other
 *  source -- #1522's manifest.json response cache needs it regardless of
 *  which tier answered). */
interface MemoizedAnswer<T> {
  header: ManifestHeader;
  etag: string;
  value: T;
}

/**
 * Recall a previously finished answer, if this isolate's memo still has it.
 * `readManifest` calls this internally to decide whether a read can skip the
 * scan entirely; not exported, because a caller only ever needs
 * `rememberManifestAnswer` (the read side is already reflected in
 * `ManifestRead.source === "memo"`).
 */
function recallManifestAnswer<T>(memoKey: string): MemoizedAnswer<T> | undefined {
  return manifestAnswerMemo.get<MemoizedAnswer<T>>(memoKey);
}

/**
 * Remember a finished answer under `memoKey` (from a successful
 * `ManifestRead.ok`). Called by the caller AFTER `query.finish(header)`
 * succeeds, never from inside this module -- the same rule that keeps
 * `finish()` itself outside `readManifest`'s own error handling applies here:
 * a memo write is not this module's business to attempt before the caller has
 * proven the answer is real.
 */
export function rememberManifestAnswer<T>(
  memoKey: string,
  header: ManifestHeader,
  etag: string,
  value: T,
): void {
  manifestAnswerMemo.set(memoKey, { header, etag, value });
}

/** Forget every memoized answer, so a test can start from an empty memo. */
export function resetManifestAnswerMemo(): void {
  manifestAnswerMemo.clear();
}

/** Introspection for tests: how many answers are memoized, and how many
 *  bytes they are estimated to cost. */
export function manifestAnswerMemoStats(): { entries: number; bytes: number } {
  return { entries: manifestAnswerMemo.size, bytes: manifestAnswerMemo.byteSize };
}

/** A `ManifestQuery` whose `finish` only returns an already-computed value.
 *  Used for a memo hit, where nothing was scanned and there is no real query
 *  to hand back -- see the `ManifestRead.ok` doc comment for why this keeps
 *  the same "the caller calls finish()" shape as every other source. */
function memoizedQuery<T>(value: T): ManifestQuery<T> {
  return {
    reset() {},
    key() {
      return false;
    },
    value() {},
    finish() {
      return value;
    },
  };
}

let warnedIgnoredCondition = false;

/**
 * Which cache outcomes this isolate has already announced. Each is logged the
 * FIRST time it happens in an isolate, which is enough for `wrangler tail` to
 * prove the edge copy works under real workerd (a miss stores, the next use
 * answers on a 304) without a log line on every data-plane request.
 */
const announced = new Set<"stored" | "answered">();

function announceOnce(what: "stored" | "answered", message: string): void {
  if (announced.has(what)) return;
  announced.add(what);
  console.log(message);
}

/** Forget what has been announced, so a test can watch the first time again. */
export function resetEdgeCopyNotices(): void {
  announced.clear();
}

/**
 * Read one manifest and answer one query from it. `makeQuery` is a factory
 * because a scan of a damaged edge copy is retried from S3 with a fresh query.
 * Transport failures (an S3 5xx, a body that breaks off) throw, as
 * `getManifest` did; the caller logs them.
 *
 * `queryDescriptor`, when given, opts this read into the per-isolate answer
 * memo (`manifest-answer-memo.ts`): a short, caller-chosen string identifying
 * WHICH question this is (a path, a fixed word for a whole-manifest digest),
 * combined here with the manifest's own dataset/version/ETag into a key safe
 * to memoize by. Omitted, this read still gets the trust window below, just
 * never the memo (`manifest-source.test.ts`'s existing suite omits it
 * throughout, deliberately unaffected by this parameter's addition).
 */
export async function readManifest<T>(
  source: ManifestSource,
  datasetId: string,
  version: string,
  makeQuery: () => ManifestQuery<T>,
  queryDescriptor?: string,
): Promise<ManifestRead<T>> {
  const key = manifestCacheKey(source.cacheOrigin, datasetId, version);
  const cached = source.cache ? await matchEdgeCopy(source.cache, key) : null;
  const now = source.now ? source.now() : Date.now();

  if (cached !== null) {
    // The memo is checked ONLY once `cached.etag` is known to be current --
    // either because the window below still trusts it, or because a 304
    // just confirmed it. Checking it any earlier would key a lookup on an
    // etag the cache merely REMEMBERS, not one anything has confirmed is
    // still on S3, which would let a stale memo entry outlive the very
    // revalidation meant to catch a rewrite (caught by
    // "a manifest rewrite is not served from the old memo entry").
    const memoKeyFor = (etag: string): string | null =>
      queryDescriptor !== undefined
        ? manifestAnswerKey(datasetId, version, etag, queryDescriptor)
        : null;

    const withinWindow =
      cached.validatedAtMs !== null && now - cached.validatedAtMs < MANIFEST_TRUST_WINDOW_MS;
    if (withinWindow) {
      const memoKey = memoKeyFor(cached.etag);
      const memoized = memoKey ? recallManifestAnswer<T>(memoKey) : undefined;
      if (memoized !== undefined) {
        await cached.body.cancel().catch(() => {});
        return {
          kind: "ok",
          header: memoized.header,
          query: memoizedQuery(memoized.value),
          etag: memoized.etag,
          source: "memo",
          memoKey: null,
        };
      }

      const query = makeQuery();
      const fromCopy = await scanEdgeCopy(cached.body, query, { datasetId, version, key });
      if (fromCopy !== null) {
        announceOnce(
          "answered",
          `[manifest-cache] edge copy answered within the trust window (first in this isolate) dataset=${datasetId} version=${version}`,
        );
        return settle(fromCopy, query, cached.etag, "fresh", memoKey);
      }
      // A damaged copy inside the window is treated exactly like one found
      // outside it: read S3 fresh, unconditionally, and let that replace it.
      return fromS3(
        source,
        key,
        await fetchManifestObject(source.s3, datasetId, version),
        makeQuery,
        { datasetId, version, queryDescriptor },
        now,
      );
    }

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
      // The window just expired: restamp the copy's validated-at time so the
      // NEXT MANIFEST_TRUST_WINDOW_MS worth of reads can skip S3 again,
      // streamed through the same bounded-queue writer a miss uses (the tap
      // on `scanEdgeCopy` below) rather than buffered whole -- this can run
      // against nm000281's 43 MB manifest exactly as a miss already does.
      const sink = source.cache
        ? new EdgeCopyWriter(
            source.cache,
            key,
            cached.etag,
            source.cacheStallMs ?? CACHE_STALL_MS,
            source.waitUntil,
            now,
          )
        : null;

      // A 304 confirms `cached.etag` is still current, exactly like the
      // within-window branch already trusts it -- so the memo is checked
      // here too, before paying for a scan the memo could make unnecessary.
      // The window still needs restamping either way (a memo hit does not
      // mean the copy is still valid for free), so the copy's bytes are
      // still piped to the sink -- just without tokenizing them (review
      // finding: the first version of this always rescanned on a 304, which
      // defeated the memo for exactly the query it should have helped most:
      // one asked again right as its window boundary passed).
      const memoKey = memoKeyFor(cached.etag);
      const memoized = memoKey ? recallManifestAnswer<T>(memoKey) : undefined;
      if (memoized !== undefined) {
        if (sink) {
          const piped = await pipeToSink(cached.body, sink);
          if (piped) await sink.commit();
          else await sink.discard("the cached body failed mid-read while restamping a memo hit");
        } else {
          await cached.body.cancel().catch(() => {});
        }
        return {
          kind: "ok",
          header: memoized.header,
          query: memoizedQuery(memoized.value),
          etag: memoized.etag,
          source: "memo",
          memoKey: null,
        };
      }

      const query = makeQuery();
      const fromCopy = await scanEdgeCopy(
        cached.body,
        query,
        { datasetId, version, key },
        sink ? (chunk) => sink.write(chunk) : undefined,
      );
      if (fromCopy !== null) {
        await sink?.commit();
        announceOnce(
          "answered",
          `[manifest-cache] edge copy answered after a 304 (first in this isolate) dataset=${datasetId} version=${version}`,
        );
        return settle(fromCopy, query, cached.etag, "revalidated", memoKey);
      }
      await sink?.discard("the edge copy did not scan cleanly while restamping after a 304");
      // The copy could not be read back whole, so S3 answers instead, exactly
      // as if there had been no copy. It is re-stored from that read.
      return fromS3(
        source,
        key,
        await fetchManifestObject(source.s3, datasetId, version),
        makeQuery,
        { datasetId, version, queryDescriptor },
        now,
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
    return fromS3(source, key, fetched, makeQuery, { datasetId, version, queryDescriptor }, now);
  }

  return fromS3(
    source,
    key,
    await fetchManifestObject(source.s3, datasetId, version),
    makeQuery,
    { datasetId, version, queryDescriptor },
    now,
  );
}

function settle<T>(
  result: ScanResult,
  query: ManifestQuery<T>,
  etag: string | null,
  readSource: ManifestReadSource,
  memoKey: string | null,
): ManifestRead<T> {
  if (result.kind !== "ok") return result;
  return { kind: "ok", header: result.header, query, etag, source: readSource, memoKey };
}

async function matchEdgeCopy(
  cache: ManifestCache,
  key: string,
): Promise<{
  etag: string;
  body: ReadableStream<Uint8Array>;
  validatedAtMs: number | null;
} | null> {
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
  // Absent or unparsable means "treat as already outside the trust window":
  // an entry stored before this module knew about the header, or one a test
  // built by hand, revalidates on its very next use rather than being trusted
  // on the strength of a timestamp nobody ever recorded.
  const validatedAtRaw = hit.headers.get(VALIDATED_AT_HEADER);
  const validatedAtMs =
    validatedAtRaw !== null && /^\d+$/.test(validatedAtRaw) ? Number(validatedAtRaw) : null;
  return { etag, body: hit.body, validatedAtMs };
}

/**
 * Feed a body's raw bytes to a sink WITHOUT scanning them (#1494 amendment,
 * review). Used only when a 304 confirms an ETag the per-isolate memo already
 * has an answer for: the copy still needs restamping (its full bytes still
 * have to be re-stored under the new validated-at time), but nothing needs to
 * be tokenized to get there, which is the whole point of a memo hit. Never
 * throws: a read failure here costs the cache write, never the answer, which
 * the caller already has from the memo before this runs.
 */
async function pipeToSink(
  body: ReadableStream<Uint8Array>,
  sink: EdgeCopyWriter,
): Promise<boolean> {
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return true;
      if (value === undefined || value.byteLength === 0) continue;
      await sink.write(value);
    }
  } catch {
    return false;
  } finally {
    reader.releaseLock();
  }
}

/**
 * Scan an edge copy. `null` means the copy is unusable and S3 should answer:
 * a read error, or any verdict other than `ok`. The second is not a judgment
 * about the manifest: only a copy whose scan was accepted is ever stored, so a
 * copy that no longer scans is a damaged copy, and the manifest it came from
 * deserves to be read again rather than reported broken on the copy's word.
 *
 * `tap`, when given, sees every raw chunk as it is read -- used only while
 * restamping a copy after a 304 (see `readManifest`), so the whole body is
 * never held to re-store it.
 */
async function scanEdgeCopy<T>(
  body: ReadableStream<Uint8Array>,
  query: ManifestQuery<T>,
  where: { datasetId: string; version: string; key: string },
  tap?: (chunk: Uint8Array) => void | Promise<void>,
): Promise<ScanResult | null> {
  let result: ScanResult;
  try {
    result = await scanManifestStream(body, query, tap);
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
  where: { datasetId: string; version: string; queryDescriptor: string | undefined },
  now: number,
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
      ? new EdgeCopyWriter(
          source.cache,
          key,
          etag,
          source.cacheStallMs ?? CACHE_STALL_MS,
          source.waitUntil,
          now,
        )
      : null;
  let result: ScanResult;
  try {
    result = await scanManifestStream(body, query, sink ? (chunk) => sink.write(chunk) : undefined);
  } catch (err) {
    await sink?.discard(
      `the body failed mid-read: ${err instanceof Error ? err.message : String(err)}`,
    );
    throw err;
  }
  if (result.kind === "ok") await sink?.commit();
  else await sink?.discard(`the document did not scan: ${result.kind}`);
  const memoKey =
    etag && where.queryDescriptor !== undefined
      ? manifestAnswerKey(where.datasetId, where.version, etag, where.queryDescriptor)
      : null;
  return settle(result, query, etag, "rewrite", memoKey);
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
  /** Why this writer errored its own body, if it did: a put failing after that is expected. */
  private discardedBecause: string | null = null;

  constructor(
    cache: ManifestCache,
    private readonly key: string,
    etag: string,
    private readonly stallMs: number,
    private readonly waitUntil: ((work: Promise<unknown>) => void) | undefined,
    validatedAtMs: number,
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
        [VALIDATED_AT_HEADER]: String(validatedAtMs),
      },
    });
    this.putSettled = (async () => {
      try {
        await cache.put(new Request(key, { method: "GET" }), entry);
        // Only a put that read a committed body to its end stored a copy; one
        // that settled early (without reading) stored nothing usable.
        if (this.state === "done" && this.discardedBecause === null) {
          announceOnce(
            "stored",
            `[manifest-cache] stored an edge copy (first in this isolate) key=${this.key}`,
          );
        }
      } catch (err) {
        // Two different events, logged so a rising fault rate stands out from
        // the expected ones. Either way the answer is unaffected; only the
        // next request's cost is.
        const message = err instanceof Error ? err.message : String(err);
        if (this.discardedBecause !== null) {
          // This writer errored the body itself: a scan that did not accept
          // the document, or a cache write it gave up on. Expected.
          console.warn(
            `[manifest-cache] put ended: discarded (${this.discardedBecause}) key=${this.key}`,
          );
        } else {
          console.error(`[manifest-cache] put FAILED: cache fault key=${this.key}: ${message}`);
        }
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
    await this.discard(`abandoned: ${outcome}`);
  }

  /** The scan accepted the document: let the cache read to the end. */
  async commit(): Promise<void> {
    if (this.state === "open") {
      this.state = "closed";
      this.wakePull?.();
    }
    await this.finishPut();
  }

  /**
   * Error the entry's body so the cache never stores a partial copy. `why`
   * is what the put's own failure is then logged as.
   */
  async discard(why: string): Promise<void> {
    if (this.state !== "done") {
      this.discardedBecause = why;
      this.drop();
      try {
        this.controller?.error(new Error(`manifest edge copy discarded: ${why}`));
      } catch {
        // Already closed or errored; nothing left to stop.
      }
    }
    await this.finishPut();
  }

  /**
   * Hand the rest of the put to `waitUntil` where there is one, so the answer
   * is never held back by the cache; otherwise wait, bounded.
   */
  private async finishPut(): Promise<void> {
    if (this.waitUntil) {
      this.waitUntil(this.putSettled);
      return;
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
