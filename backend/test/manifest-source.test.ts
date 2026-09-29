/**
 * The manifest source (#1502): an edge copy that S3 revalidates on every use,
 * written without ever holding the manifest whole.
 *
 * Real engines: a real HTTP server stands in for the bucket
 * (`helpers/s3-manifest-standin.ts`, content ETags, `If-None-Match` -> 304,
 * a private object that needs a signature), and the caches are real
 * in-memory implementations of the Cache API surface (`helpers/cache.ts`),
 * because `bun test` has no `caches.default`. Every assertion about traffic
 * reads the server's own request log.
 *
 * What these tests pin, and why each matters:
 *  - a copy never answers without S3 saying 304 for its exact ETag, so a
 *    rewritten manifest is never served stale and a deleted one is absent;
 *  - a copy that cannot be read back whole never decides anything: S3 does;
 *  - a body that fails to scan, or breaks off, is never stored;
 *  - a cache that stops reading, stalls, or throws costs the request at
 *    most a bounded delay, never the answer and never the memory bound;
 *  - within the trust window (#1494 amendment) a read costs no S3 traffic at
 *    all, a rewrite during the window is still visible once the window
 *    expires and never later, and the per-isolate answer memo skips even the
 *    scan for a query this isolate has already run -- bounded by an LRU byte
 *    cap so it cannot grow with the manifest (`manifest-answer-memo.ts`).
 *
 * Tests in this file that predate the trust window and want "every use
 * revalidates" literally (the original ADR 0072 behavior) inject
 * `advancingClock()` so successive reads are always far enough apart in the
 * injected clock to fall outside the window; tests below that want the
 * window itself use the default clock (real, but reads in one test run in
 * microseconds, well inside 60s).
 */

import { heapStats } from "bun:jsc";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveFile } from "../src/services/data-router";
import type { VersionManifest } from "../src/services/manifest";
import {
  EntriesQuery,
  type ManifestQuery,
  ResolvePathQuery,
} from "../src/services/manifest-queries";
import {
  CACHE_WRITE_MAX_LAG_BYTES,
  MANIFEST_TRUST_WINDOW_MS,
  type ManifestCache,
  type ManifestSource,
  manifestAnswerMemoStats,
  manifestCacheKey,
  readManifest,
  rememberManifestAnswer,
  resetEdgeCopyNotices,
  resetManifestAnswerMemo,
} from "../src/services/manifest-source";
import { DrainingCache, InMemoryCache, StalledCache } from "./helpers/cache";
import { LARGE_MANIFEST_TEST_TIMEOUT_MS, largeManifestText } from "./helpers/large-manifest";
import { type S3ManifestStandin, startS3ManifestStandin } from "./helpers/s3-manifest-standin";

const FIXTURE_TEXT = readFileSync(
  join(import.meta.dir, "fixtures/manifest-nm000132-v1.1.1.json"),
  "utf8",
);
const FIXTURE: VersionManifest = JSON.parse(FIXTURE_TEXT);
const ID = "nm000132";
const VERSION = "v1.1.1";
const OBJECT = `/${ID}/version/${VERSION}.json`;
const ORIGIN = "https://data.nemar.org";

let s3: S3ManifestStandin;

beforeAll(() => {
  s3 = startS3ManifestStandin();
});

afterAll(() => {
  s3.stop();
});

beforeEach(() => {
  s3.objects.clear();
  s3.log.length = 0;
  resetManifestAnswerMemo();
});

function source(cache: ManifestCache | null, extra: Partial<ManifestSource> = {}): ManifestSource {
  return {
    s3: {
      bucket: "nemar",
      region: "us-east-2",
      accessKeyId: "AKIATEST",
      secretAccessKey: "secret",
      endpointUrl: s3.url,
    },
    cache,
    cacheOrigin: ORIGIN,
    ...extra,
  };
}

/**
 * A clock that jumps forward by more than the trust window on every read, so
 * a test built around "every use revalidates" (true before the #1494
 * amendment, still true once a read is far enough outside the window) keeps
 * meaning what it says instead of the window silently absorbing a repeat
 * read the test means to exercise. Starts at an arbitrary large value so
 * `validatedAtMs - MANIFEST_TRUST_WINDOW_MS` never goes negative.
 */
function advancingClock(stepMs = MANIFEST_TRUST_WINDOW_MS + 1_000): () => number {
  let now = MANIFEST_TRUST_WINDOW_MS * 10;
  return () => {
    now += stepMs;
    return now;
  };
}

/** Resolve one path and return the answer, or the non-ok verdict's kind.
 *  `queryDescriptor`, when given, opts the read into the per-isolate memo,
 *  exactly like a real call site in `routes/data.ts` would. */
async function resolve(
  src: ManifestSource,
  raw: string,
  version = VERSION,
  queryDescriptor?: string,
) {
  const read = await readManifest(
    src,
    ID,
    version,
    () => new ResolvePathQuery(raw),
    queryDescriptor,
  );
  if (read.kind !== "ok") return read.kind;
  const answer = read.query.finish(read.header);
  if (read.memoKey !== null) rememberManifestAnswer(read.memoKey, read.header, answer);
  return answer;
}

/** Like {@link resolve}, but returns the full `ManifestRead.ok` result (minus
 *  the query, already finished) so a test can inspect `source`/`memoKey`. */
async function resolveWithSource(
  src: ManifestSource,
  raw: string,
  version = VERSION,
  queryDescriptor?: string,
) {
  const read = await readManifest(
    src,
    ID,
    version,
    () => new ResolvePathQuery(raw),
    queryDescriptor,
  );
  if (read.kind !== "ok") throw new Error(`expected ok, got ${read.kind}`);
  const answer = read.query.finish(read.header);
  if (read.memoKey !== null) rememberManifestAnswer(read.memoKey, read.header, answer);
  return { answer, source: read.source };
}

const traffic = () =>
  s3.log.map((r) => `${r.ifNoneMatch ? "INM " : ""}${r.status}${r.signed ? " signed" : ""}`);

describe("without a cache", () => {
  test("one plain GET, and the answer resolveFile gives", async () => {
    s3.put(OBJECT, FIXTURE_TEXT);
    expect(await resolve(source(null), "sub-001")).toEqual(resolveFile(FIXTURE, "sub-001"));
    expect(traffic()).toEqual(["200"]);
  });

  test("absent, private-and-unsigned-and-failing, and malformed", async () => {
    expect(await resolve(source(null), "")).toBe("absent");
    s3.put(OBJECT, "{not json");
    expect(await resolve(source(null), "")).toBe("malformed");
    s3.put(OBJECT, '{"version":"1"}');
    expect(await resolve(source(null), "")).toBe("no_files");
  });
});

describe("the edge copy is revalidated on every use outside the trust window", () => {
  test("a miss stores the body with its ETag; a hit costs a bodiless 304", async () => {
    const etag = s3.put(OBJECT, FIXTURE_TEXT);
    const cache = new DrainingCache();
    const src = source(cache, { now: advancingClock() });

    expect(await resolve(src, "sub-001/eeg")).toEqual(resolveFile(FIXTURE, "sub-001/eeg"));
    const stored = cache.store.get(manifestCacheKey(ORIGIN, ID, VERSION));
    expect(stored?.headers.get("ETag")).toBe(etag);
    expect(new TextDecoder().decode(stored?.body)).toBe(FIXTURE_TEXT);

    for (const raw of ["", "participants.tsv", "nope"]) {
      expect(await resolve(src, raw)).toEqual(resolveFile(FIXTURE, raw));
    }
    expect(traffic()).toEqual(["200", "INM 304", "INM 304", "INM 304"]);
    expect(s3.log.slice(1).every((r) => r.ifNoneMatch === etag && r.bytesSent === 0)).toBe(true);
  });

  test("a rewritten manifest is read fresh, never served from the old copy", async () => {
    const cache = new DrainingCache();
    const src = source(cache, { now: advancingClock() });
    s3.put(OBJECT, FIXTURE_TEXT);
    expect(await resolve(src, "participants.tsv")).toMatchObject({ kind: "file" });

    // The pipeline regenerates manifests in place (nm000132's were rewritten
    // months after publication). Drop a file and change a size.
    const rewritten: VersionManifest = {
      ...FIXTURE,
      files: Object.fromEntries(
        Object.entries(FIXTURE.files)
          .filter(([path]) => path !== "participants.tsv")
          .map(([path, file]) => [path, path === "README.md" ? { ...file, size: 12345 } : file]),
      ),
    };
    const newEtag = s3.put(OBJECT, JSON.stringify(rewritten, null, 2));

    expect(await resolve(src, "participants.tsv")).toEqual({ kind: "not_found" });
    expect(await resolve(src, "")).toEqual(resolveFile(rewritten, ""));
    expect(traffic()).toEqual(["200", "INM 200", "INM 304"]);
    expect(cache.store.get(manifestCacheKey(ORIGIN, ID, VERSION))?.headers.get("ETag")).toBe(
      newEtag,
    );
  });

  test("a deleted manifest is absent even with a copy in the cache", async () => {
    const cache = new DrainingCache();
    const src = source(cache, { now: advancingClock() });
    s3.put(OBJECT, FIXTURE_TEXT);
    await resolve(src, "");
    s3.remove(OBJECT);
    expect(await resolve(src, "")).toBe("absent");
    expect(traffic()).toEqual(["200", "INM 404"]);
  });

  test("a private manifest goes through the signed fallback, both times", async () => {
    const cache = new DrainingCache();
    const src = source(cache, { now: advancingClock() });
    s3.put(OBJECT, FIXTURE_TEXT, { private: true });
    expect(await resolve(src, "sub-002")).toEqual(resolveFile(FIXTURE, "sub-002"));
    expect(await resolve(src, "sub-002")).toEqual(resolveFile(FIXTURE, "sub-002"));
    expect(traffic()).toEqual(["403", "200 signed", "INM 403", "INM 304 signed"]);
  });

  test("the cache key is per dataset and version, and not a public data path", () => {
    const key = manifestCacheKey(ORIGIN, ID, VERSION);
    expect(key).toBe(`${ORIGIN}/__nemar-internal/manifest-cache/v1/nm000132/v1.1.1.json`);
    expect(manifestCacheKey(ORIGIN, ID, "1.1.1")).toBe(key);
    expect(manifestCacheKey(ORIGIN, "nm000133", VERSION)).not.toBe(key);
    expect(manifestCacheKey(ORIGIN, ID, "v1.1.0")).not.toBe(key);
  });
});

describe("the trust window (#1494 amendment)", () => {
  test("within the window, a repeat read for a different path costs no S3 traffic", async () => {
    s3.put(OBJECT, FIXTURE_TEXT);
    const cache = new DrainingCache();
    const src = source(cache); // default (real, fast) clock: everything below is within the window.

    const first = await resolveWithSource(src, "sub-001/eeg");
    expect(first.source).toBe("rewrite"); // cold: no cache yet, fetched fresh from S3.
    expect(first.answer).toEqual(resolveFile(FIXTURE, "sub-001/eeg"));

    for (const raw of ["", "participants.tsv", "nope"]) {
      const read = await resolveWithSource(src, raw);
      expect(read.source).toBe("fresh");
      expect(read.answer).toEqual(resolveFile(FIXTURE, raw));
    }
    // Exactly the one store; not one conditional GET for any of the four reads.
    expect(traffic()).toEqual(["200"]);
  });

  test("a rewrite during the window is invisible until the window expires, never later", async () => {
    const cache = new DrainingCache();
    let now = 0;
    const src = source(cache, { now: () => now });
    s3.put(OBJECT, FIXTURE_TEXT);
    expect(await resolve(src, "participants.tsv")).toMatchObject({ kind: "file" });

    const rewritten: VersionManifest = {
      ...FIXTURE,
      files: Object.fromEntries(
        Object.entries(FIXTURE.files).filter(([path]) => path !== "participants.tsv"),
      ),
    };
    s3.put(OBJECT, JSON.stringify(rewritten, null, 2));

    // Still inside the window: the rewrite already happened on S3, but this
    // read must not know that yet -- that is the staleness bound the window
    // exists to accept in exchange for skipping the round trip.
    now = MANIFEST_TRUST_WINDOW_MS - 1;
    expect(await resolve(src, "participants.tsv")).toMatchObject({ kind: "file" });
    expect(traffic()).toEqual(["200"]);

    // The window has now passed: the very next read must see the rewrite,
    // not some later one. S3 answers 200 (a real content change, so a new
    // ETag), not 304 -- the conditional GET still only cost one request.
    now = MANIFEST_TRUST_WINDOW_MS + 1;
    expect(await resolve(src, "participants.tsv")).toEqual({ kind: "not_found" });
    expect(traffic()).toEqual(["200", "INM 200"]);
  });

  test("revalidating after the window restamps the copy, starting a new window", async () => {
    const cache = new DrainingCache();
    let now = 0;
    const src = source(cache, { now: () => now });
    s3.put(OBJECT, FIXTURE_TEXT);
    expect(await resolveWithSource(src, "sub-001")).toMatchObject({ source: "rewrite" });

    now = MANIFEST_TRUST_WINDOW_MS + 1;
    const revalidated = await resolveWithSource(src, "");
    expect(revalidated.source).toBe("revalidated");
    expect(traffic()).toEqual(["200", "INM 304"]);
    const stored = cache.store.get(manifestCacheKey(ORIGIN, ID, VERSION));
    expect(stored?.headers.get("X-Nemar-Manifest-Validated-At")).toBe(String(now));

    // A new window, measured from the restamp -- not from the original store.
    now += MANIFEST_TRUST_WINDOW_MS - 1;
    const stillFresh = await resolveWithSource(src, "participants.tsv");
    expect(stillFresh.source).toBe("fresh");
    expect(traffic()).toEqual(["200", "INM 304"]);
  });

  test("a copy stored before this header existed revalidates on its very next use", async () => {
    const etag = s3.put(OBJECT, FIXTURE_TEXT);
    const cache = new DrainingCache();
    cache.store.set(manifestCacheKey(ORIGIN, ID, VERSION), {
      body: new TextEncoder().encode(FIXTURE_TEXT),
      status: 200,
      headers: new Headers({ ETag: etag }), // no validated-at header at all
    });
    expect(await resolveWithSource(source(cache), "sub-001")).toMatchObject({
      source: "revalidated",
    });
    expect(traffic()).toEqual(["INM 304"]);
  });
});

describe("the per-isolate answer memo (#1494 amendment)", () => {
  test("a repeated identical query is answered without a second scan", async () => {
    s3.put(OBJECT, FIXTURE_TEXT);
    const cache = new DrainingCache();
    const src = source(cache);
    let scans = 0;
    const countedQuery = (raw: string) => {
      const inner = new ResolvePathQuery(raw);
      const query: ManifestQuery<ReturnType<ResolvePathQuery["finish"]>> = {
        reset: () => inner.reset(),
        key: (p) => inner.key(p),
        value: (p, v) => inner.value(p, v),
        finish: (h) => {
          scans++;
          return inner.finish(h);
        },
      };
      return query;
    };

    const first = await readManifest(
      src,
      ID,
      VERSION,
      () => countedQuery("participants.tsv"),
      "resolve:/participants.tsv",
    );
    if (first.kind !== "ok") throw new Error(first.kind);
    const answer1 = first.query.finish(first.header);
    expect(first.memoKey).not.toBeNull();
    rememberManifestAnswer(first.memoKey as string, first.header, answer1);
    expect(scans).toBe(1);

    const second = await readManifest(
      src,
      ID,
      VERSION,
      () => countedQuery("participants.tsv"),
      "resolve:/participants.tsv",
    );
    if (second.kind !== "ok") throw new Error(second.kind);
    const answer2 = second.query.finish(second.header);
    expect(second.source).toBe("memo");
    expect(second.memoKey).toBeNull();
    expect(answer2).toEqual(answer1);
    // The factory ran again (readManifest always calls `makeQuery`, cheaply --
    // constructing a `ResolvePathQuery` does no I/O), but `finish` -- the
    // expensive, scan-shaped step this memo exists to skip -- did not.
    expect(scans).toBe(1);
    expect(traffic()).toEqual(["200"]);
  });

  test("a different query for the same manifest is a memo miss but not an S3 hit", async () => {
    s3.put(OBJECT, FIXTURE_TEXT);
    const src = source(new DrainingCache());
    expect(await resolve(src, "sub-001", VERSION, "resolve:/sub-001")).toEqual(
      resolveFile(FIXTURE, "sub-001"),
    );
    expect(await resolve(src, "sub-002", VERSION, "resolve:/sub-002")).toEqual(
      resolveFile(FIXTURE, "sub-002"),
    );
    // Different descriptor -> different memo key -> both scanned, neither an
    // S3 round trip (still within the trust window).
    expect(traffic()).toEqual(["200"]);
  });

  test("a manifest rewrite is not served from the old memo entry", async () => {
    let now = 0;
    const src = source(new DrainingCache(), { now: () => now });
    s3.put(OBJECT, FIXTURE_TEXT);
    expect(
      await resolve(src, "participants.tsv", VERSION, "resolve:/participants.tsv"),
    ).toMatchObject({ kind: "file" });

    now = MANIFEST_TRUST_WINDOW_MS + 1;
    const rewritten: VersionManifest = {
      ...FIXTURE,
      files: Object.fromEntries(
        Object.entries(FIXTURE.files).filter(([path]) => path !== "participants.tsv"),
      ),
    };
    s3.put(OBJECT, JSON.stringify(rewritten, null, 2));
    // New ETag -> a different memo key -> the memo cannot answer this from
    // the old entry, so the read goes all the way to `not_found`, not to a
    // stale "file" answer.
    expect(await resolve(src, "participants.tsv", VERSION, "resolve:/participants.tsv")).toEqual({
      kind: "not_found",
    });
  });

  test("an oversized answer is never memoized, but is still answered", async () => {
    resetManifestAnswerMemo();
    const text = largeManifestText({ subjects: 30, runsPerSession: 50 });
    s3.put(OBJECT, text);
    const src = source(new DrainingCache());
    // The whole-manifest EntriesQuery (manifest.json's own query): thousands
    // of entries, serialized well past MANIFEST_ANSWER_MEMO_CAP_BYTES * 0.5.
    const read = await readManifest(
      src,
      ID,
      VERSION,
      () => new EntriesQuery(1_000_000),
      "entries:1000000",
    );
    if (read.kind !== "ok") throw new Error(read.kind);
    const answer = read.query.finish(read.header);
    expect(answer.kind).toBe("entries");
    expect(read.memoKey).not.toBeNull();
    rememberManifestAnswer(read.memoKey as string, read.header, answer);
    expect(manifestAnswerMemoStats().entries).toBe(0);
  });

  test("many small answers stay under the byte cap via LRU eviction", async () => {
    resetManifestAnswerMemo();
    s3.put(OBJECT, FIXTURE_TEXT);
    const src = source(new DrainingCache());
    const paths = Object.keys(FIXTURE.files);
    expect(paths.length).toBeGreaterThan(5);
    for (const path of paths) {
      await resolve(src, path, VERSION, `resolve:/${path}`);
    }
    const stats = manifestAnswerMemoStats();
    expect(stats.entries).toBeGreaterThan(0);
    expect(stats.entries).toBeLessThanOrEqual(paths.length);
    expect(stats.bytes).toBeLessThanOrEqual(4 * 1024 * 1024);
  });
});

describe("a copy that cannot be read back never decides", () => {
  test("a truncated copy under the right ETag falls back to S3", async () => {
    const etag = s3.put(OBJECT, FIXTURE_TEXT);
    const cache = new DrainingCache();
    cache.store.set(manifestCacheKey(ORIGIN, ID, VERSION), {
      body: new TextEncoder().encode(FIXTURE_TEXT.slice(0, 5000)),
      status: 200,
      headers: new Headers({ ETag: etag }),
    });
    expect(await resolve(source(cache), "sub-003")).toEqual(resolveFile(FIXTURE, "sub-003"));
    expect(traffic()).toEqual(["INM 304", "200"]);
    // And the damaged copy was replaced by a good one.
    const stored = cache.store.get(manifestCacheKey(ORIGIN, ID, VERSION));
    expect(new TextDecoder().decode(stored?.body)).toBe(FIXTURE_TEXT);
  });

  test("a copy whose body errors mid-read falls back to S3", async () => {
    // InMemoryCache stores a clone and never reads what it was given. Below
    // the lag cap that is harmless (the whole body fits in the writer's
    // queue and the clone reads it later), so this manifest is larger than
    // the cap: the writer fills the queue, sees the put already settled,
    // abandons it and errors the body. What the cache kept is a response
    // whose body fails when read: a damaged copy, made organically.
    const text = largeManifestText({ subjects: 30, runsPerSession: 50 });
    expect(text.length).toBeGreaterThan(CACHE_WRITE_MAX_LAG_BYTES);
    const parsed = JSON.parse(text) as VersionManifest;
    s3.put(OBJECT, text);
    const cache = new InMemoryCache();
    const src = source(cache, { now: advancingClock() });
    expect(await resolve(src, "sub-004")).toEqual(resolveFile(parsed, "sub-004"));
    expect(await resolve(src, "sub-004")).toEqual(resolveFile(parsed, "sub-004"));
    expect(traffic()).toEqual(["200", "INM 304", "200"]);
  });

  test("below the lag cap, even a cache that never reads ends up with a whole copy", async () => {
    s3.put(OBJECT, FIXTURE_TEXT);
    const cache = new InMemoryCache();
    const src = source(cache, { now: advancingClock() });
    expect(await resolve(src, "sub-004")).toEqual(resolveFile(FIXTURE, "sub-004"));
    expect(await resolve(src, "sub-004")).toEqual(resolveFile(FIXTURE, "sub-004"));
    expect(traffic()).toEqual(["200", "INM 304"]);
  });
});

describe("only an accepted document is stored", () => {
  test("a malformed body is not stored", async () => {
    s3.put(OBJECT, `${FIXTURE_TEXT.slice(0, -10)}!!!`);
    const cache = new DrainingCache();
    expect(await resolve(source(cache), "")).toBe("malformed");
    expect(cache.puts).toBe(1);
    expect(cache.store.size).toBe(0);
    expect(cache.lastPutError).not.toBeNull();
  });

  test("a body that is valid JSON but not a manifest is not stored", async () => {
    s3.put(OBJECT, '{"files":null}');
    const cache = new DrainingCache();
    expect(await resolve(source(cache), "")).toBe("no_files");
    expect(cache.store.size).toBe(0);
  });

  test("a body that breaks off mid-transfer throws and is not stored", async () => {
    s3.put(OBJECT, FIXTURE_TEXT, { breakAfter: 100_000 });
    const cache = new DrainingCache();
    await expect(resolve(source(cache), "")).rejects.toThrow();
    expect(cache.store.size).toBe(0);
  });
});

describe("the cache can slow a request, never break it", () => {
  test("a cache that throws on match and on put still answers", async () => {
    s3.put(OBJECT, FIXTURE_TEXT);
    const broken: ManifestCache = {
      match: async () => {
        throw new Error("cache down");
      },
      put: async () => {
        throw new Error("cache down");
      },
    };
    expect(await resolve(source(broken), "sub-005")).toEqual(resolveFile(FIXTURE, "sub-005"));
    expect(traffic()).toEqual(["200"]);
  });

  test("a put that never reads and never settles is abandoned after the stall bound", async () => {
    // Larger than the lag cap, so the writer has to wait on the cache.
    const text = largeManifestText({ subjects: 30, runsPerSession: 50 });
    expect(text.length).toBeGreaterThan(CACHE_WRITE_MAX_LAG_BYTES);
    s3.put(OBJECT, text);
    const cache = new StalledCache();
    const started = performance.now();
    const answer = await resolve(source(cache, { cacheStallMs: 100 }), "sub-001");
    const elapsed = performance.now() - started;
    expect(answer).toEqual(resolveFile(JSON.parse(text), "sub-001"));
    expect(cache.puts).toBe(1);
    // One stall wait while scanning, one bounded wait after it.
    expect(elapsed).toBeGreaterThanOrEqual(100);
    expect(elapsed).toBeLessThan(5000);
  });
});

describe("the cache write never holds an answer back, and says why it failed", () => {
  /** Run `work` with console.log, console.warn and console.error captured. */
  async function capturingLogs<T>(work: () => Promise<T>) {
    const lines: string[] = [];
    const saved = { log: console.log, warn: console.warn, error: console.error };
    console.log = (...args: unknown[]) => lines.push(`log ${args.join(" ")}`);
    console.warn = (...args: unknown[]) => lines.push(`warn ${args.join(" ")}`);
    console.error = (...args: unknown[]) => lines.push(`error ${args.join(" ")}`);
    try {
      return { result: await work(), lines };
    } finally {
      console.log = saved.log;
      console.warn = saved.warn;
      console.error = saved.error;
    }
  }

  test("with waitUntil, a wedged put is handed off and the answer returns at once", async () => {
    s3.put(OBJECT, FIXTURE_TEXT);
    const deferred: Promise<unknown>[] = [];
    const cache = new StalledCache();
    const started = performance.now();
    const answer = await resolve(
      source(cache, { waitUntil: (work) => deferred.push(work) }),
      "sub-001",
    );
    expect(answer).toEqual(resolveFile(FIXTURE, "sub-001"));
    // CACHE_STALL_MS is 5 s; a waited-for wedged put would cost all of it.
    expect(performance.now() - started).toBeLessThan(1000);
    expect(cache.puts).toBe(1);
    expect(deferred).toHaveLength(1);
  });

  test("the first store and the first 304 answer are announced once per isolate", async () => {
    s3.put(OBJECT, FIXTURE_TEXT);
    resetEdgeCopyNotices();
    const src = source(new DrainingCache(), { now: advancingClock() });
    const first = await capturingLogs(() => resolve(src, "sub-001"));
    const second = await capturingLogs(() => resolve(src, "sub-001"));
    const third = await capturingLogs(() => resolve(src, "sub-001"));
    expect(first.lines.filter((l) => l.includes("stored an edge copy"))).toHaveLength(1);
    expect(second.lines.filter((l) => l.includes("edge copy answered after a 304"))).toHaveLength(
      1,
    );
    expect(third.lines.filter((l) => l.includes("[manifest-cache]"))).toEqual([]);
    expect(traffic()).toEqual(["200", "INM 304", "INM 304"]);
  });

  test("a put that settles without reading is not announced as a stored copy", async () => {
    s3.put(OBJECT, largeManifestText({ subjects: 30, runsPerSession: 50 }));
    resetEdgeCopyNotices();
    const { lines } = await capturingLogs(() => resolve(source(new InMemoryCache()), "sub-001"));
    expect(lines.some((l) => l.includes("stored an edge copy"))).toBe(false);
  });

  test("a put the writer discarded itself is logged as expected", async () => {
    s3.put(OBJECT, `${FIXTURE_TEXT.slice(0, -10)}!!!`);
    const { result, lines } = await capturingLogs(() => resolve(source(new DrainingCache()), ""));
    expect(result).toBe("malformed");
    expect(lines.some((l) => l.startsWith("warn [manifest-cache] put ended: discarded"))).toBe(
      true,
    );
    expect(lines.some((l) => l.includes("cache fault"))).toBe(false);
  });

  test("a put the Cache API rejected on its own is logged as a fault", async () => {
    s3.put(OBJECT, FIXTURE_TEXT);
    const faulty: ManifestCache = {
      match: async () => undefined,
      put: async (_request, response) => {
        await response.body?.cancel();
        throw new Error("Cache API quota exceeded");
      },
    };
    const { result, lines } = await capturingLogs(() => resolve(source(faulty), "sub-001"));
    expect(result).toEqual(resolveFile(FIXTURE, "sub-001"));
    expect(
      lines.some(
        (l) =>
          l.startsWith("error [manifest-cache] put FAILED: cache fault") &&
          l.includes("Cache API quota exceeded"),
      ),
    ).toBe(true);
  });
});

describe("memory on a miss is bounded by the lag cap, not the manifest", () => {
  function liveBytes(): number {
    Bun.gc(true);
    const h = heapStats();
    return h.heapSize + h.extraMemorySize;
  }

  /** A ResolvePathQuery that samples live memory every 5,000 keys. */
  function sampled(raw: string) {
    const inner = new ResolvePathQuery(raw);
    const samples: number[] = [];
    let n = 0;
    const query: ManifestQuery<ReturnType<ResolvePathQuery["finish"]>> = {
      reset: () => inner.reset(),
      key(path) {
        if (++n % 5000 === 0) samples.push(liveBytes());
        return inner.key(path);
      },
      value: (p, v) => inner.value(p, v),
      finish: (h) => inner.finish(h),
    };
    return { query, samples };
  }

  const LARGE = { subjects: 374, runsPerSession: 50 };
  let large = "";
  let parsed: VersionManifest;

  beforeAll(() => {
    large = largeManifestText(LARGE);
    parsed = JSON.parse(large);
  });

  for (const [label, makeCache] of [
    [
      "a cache that drains slower than the scan",
      () => new DrainingCache({ readDelayMs: 1, readDelayEvery: 4, keepBodies: false }),
    ],
    ["a cache that never reads (a put that settles at once)", () => new InMemoryCache()],
  ] as const) {
    test(
      label,
      async () => {
        s3.put(OBJECT, large);
        const cache = makeCache();
        const target = "sub-300/ses-01/emg";
        const baseline = liveBytes();
        const { query, samples } = sampled(target);
        const read = await readManifest(source(cache), ID, VERSION, () => query);
        if (read.kind !== "ok") throw new Error(read.kind);
        expect(read.query.finish(read.header)).toEqual(resolveFile(parsed, target));
        expect(samples.length).toBeGreaterThan(25);
        // The cap plus a generous allowance; the manifest is ~63 MB.
        const peak = Math.max(...samples) - baseline;
        expect(peak).toBeLessThan(CACHE_WRITE_MAX_LAG_BYTES + 8 * 1024 * 1024);
        if (cache instanceof DrainingCache) {
          // It really was slower and it still got every byte.
          expect(cache.lastPutBytes).toBe(new TextEncoder().encode(large).length);
        }
      },
      LARGE_MANIFEST_TEST_TIMEOUT_MS,
    );
  }
});
