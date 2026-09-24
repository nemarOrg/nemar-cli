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
 *    most a bounded delay, never the answer and never the memory bound.
 */

import { heapStats } from "bun:jsc";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveFile } from "../src/services/data-router";
import type { VersionManifest } from "../src/services/manifest";
import { type ManifestQuery, ResolvePathQuery } from "../src/services/manifest-queries";
import {
  CACHE_WRITE_MAX_LAG_BYTES,
  type ManifestCache,
  type ManifestSource,
  manifestCacheKey,
  readManifest,
} from "../src/services/manifest-source";
import { DrainingCache, InMemoryCache, StalledCache } from "./helpers/cache";
import { largeManifestText } from "./helpers/large-manifest";
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

/** Resolve one path and return the answer, or the non-ok verdict's kind. */
async function resolve(src: ManifestSource, raw: string, version = VERSION) {
  const read = await readManifest(src, ID, version, () => new ResolvePathQuery(raw));
  if (read.kind !== "ok") return read.kind;
  return read.query.finish(read.header);
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

describe("the edge copy is revalidated on every use", () => {
  test("a miss stores the body with its ETag; a hit costs a bodiless 304", async () => {
    const etag = s3.put(OBJECT, FIXTURE_TEXT);
    const cache = new DrainingCache();
    const src = source(cache);

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
    const src = source(cache);
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
    const src = source(cache);
    s3.put(OBJECT, FIXTURE_TEXT);
    await resolve(src, "");
    s3.remove(OBJECT);
    expect(await resolve(src, "")).toBe("absent");
    expect(traffic()).toEqual(["200", "INM 404"]);
  });

  test("a private manifest goes through the signed fallback, both times", async () => {
    const cache = new DrainingCache();
    const src = source(cache);
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
    const src = source(cache);
    expect(await resolve(src, "sub-004")).toEqual(resolveFile(parsed, "sub-004"));
    expect(await resolve(src, "sub-004")).toEqual(resolveFile(parsed, "sub-004"));
    expect(traffic()).toEqual(["200", "INM 304", "200"]);
  });

  test("below the lag cap, even a cache that never reads ends up with a whole copy", async () => {
    s3.put(OBJECT, FIXTURE_TEXT);
    const cache = new InMemoryCache();
    const src = source(cache);
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
    test(label, async () => {
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
    });
  }
});
