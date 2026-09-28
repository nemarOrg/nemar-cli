/**
 * The brokered git-tracked file edge cache (#1516, ADR 0066 amendment).
 *
 * Unit-level, against the real (in-memory) Cache API implementations
 * `test/helpers/cache.ts` already provides for the manifest cache and the
 * rate limiter, since `bun test` has no `caches.default` of its own. The
 * route-level behavior (the gate runs first, a token is never minted on a
 * hit, HEAD and Range are unaffected) is covered in
 * `git-file-broker.test.ts`'s "the edge cache" describe block, which drives
 * the real `dataRoutes` app; this file pins the cache module's own contract
 * in isolation: the key shape, hit/miss/mismatch, and what a faulty or
 * stalled cache costs.
 */

import { describe, expect, test } from "bun:test";
import {
  GIT_FILE_CACHE_STALL_MS,
  gitFileCacheKey,
  matchGitFileCache,
  scheduleGitFileCacheWrite,
} from "../src/services/git-file-cache";
import type { ManifestFile } from "../src/services/manifest";
import type { ManifestCache } from "../src/services/manifest-source";
import { DrainingCache, InMemoryCache, StalledCache } from "./helpers/cache";

const ORIGIN = "https://data.nemar.org";
const SHA = "8cb31ee475b57f9caf41c02a1e4de7862cde420c";
const OTHER_SHA = "6cba04dc47d61c155d1548ec35a832361646ee66";

function file(sha = SHA): Pick<ManifestFile, "key"> {
  return { key: `git:${sha}` };
}

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

describe("gitFileCacheKey", () => {
  test("dataset-, version- and path-scoped, never content-addressed", () => {
    const key = gitFileCacheKey(ORIGIN, "nm000862", "v1.0.0", "dataset_description.json");
    expect(key).toBe(
      `${ORIGIN}/__nemar-internal/git-file-cache/v1/nm000862/v1.0.0/dataset_description.json`,
    );
    // A bare version gets the `v` prefix folded in, like manifestCacheKey.
    expect(gitFileCacheKey(ORIGIN, "nm000862", "1.0.0", "dataset_description.json")).toBe(key);
    // Different dataset, version or path -> a different key. Never the SHA.
    expect(gitFileCacheKey(ORIGIN, "nm000863", "v1.0.0", "dataset_description.json")).not.toBe(key);
    expect(gitFileCacheKey(ORIGIN, "nm000862", "v1.0.1", "dataset_description.json")).not.toBe(key);
    expect(gitFileCacheKey(ORIGIN, "nm000862", "v1.0.0", "README.md")).not.toBe(key);
  });

  test("lives under a path no public data route serves", () => {
    const key = gitFileCacheKey(ORIGIN, "nm000862", "v1.0.0", "dataset_description.json");
    expect(key).toContain("/__nemar-internal/");
  });

  test("a subdirectory path keeps its separators, not a %2F blob", () => {
    const key = gitFileCacheKey(ORIGIN, "nm000862", "v1.0.0", "sub-01/eeg/participants.tsv");
    expect(key).toBe(
      `${ORIGIN}/__nemar-internal/git-file-cache/v1/nm000862/v1.0.0/sub-01/eeg/participants.tsv`,
    );
    // A path segment that itself contains a slash-like escape stays scoped to
    // its own segment rather than merging with its neighbor.
    const withSpace = gitFileCacheKey(ORIGIN, "nm000862", "v1.0.0", "sub 01/eeg file.tsv");
    expect(withSpace).toBe(
      `${ORIGIN}/__nemar-internal/git-file-cache/v1/nm000862/v1.0.0/sub%2001/eeg%20file.tsv`,
    );
  });
});

describe("matchGitFileCache", () => {
  const KEY = gitFileCacheKey(ORIGIN, "nm000862", "v1.0.0", "dataset_description.json");

  test("an empty cache is a miss", async () => {
    const cache = new InMemoryCache();
    expect(await matchGitFileCache(cache, KEY, file())).toBeNull();
  });

  test("a stored copy under the matching blob SHA is a hit", async () => {
    const cache = new InMemoryCache();
    await scheduleGitFileCacheWrite(
      {
        cache,
        key: KEY,
        blobSha: SHA,
        body: bytes("hello"),
        headers: new Headers({ "Content-Type": "text/plain" }),
      },
      undefined,
    );
    const hit = await matchGitFileCache(cache, KEY, file(SHA));
    expect(hit).not.toBeNull();
    expect(new TextDecoder().decode(hit?.body)).toBe("hello");
    expect(hit?.status).toBe(200);
    expect(hit?.headers.get("Content-Type")).toBe("text/plain");
  });

  test("the internal blob-SHA marker is never handed back to a caller", async () => {
    const cache = new InMemoryCache();
    await scheduleGitFileCacheWrite(
      { cache, key: KEY, blobSha: SHA, body: bytes("hello"), headers: new Headers() },
      undefined,
    );
    const hit = await matchGitFileCache(cache, KEY, file(SHA));
    const names = [...(hit?.headers.keys() ?? [])];
    expect(names.some((n) => n.toLowerCase().includes("blob-sha"))).toBe(false);
  });

  test("a manifest rewrite (a different blob SHA at the same path) is a miss, not a stale hit", async () => {
    // ADR 0072: manifests are rewritten in place. A retag or a same-size
    // edit changes the blob SHA a path names without changing the request
    // URL, so the entry's own marker -- checked against the CURRENT
    // manifest entry the caller already resolved -- is what catches it.
    const cache = new InMemoryCache();
    await scheduleGitFileCacheWrite(
      { cache, key: KEY, blobSha: SHA, body: bytes("old content"), headers: new Headers() },
      undefined,
    );
    expect(await matchGitFileCache(cache, KEY, file(OTHER_SHA))).toBeNull();
    // The stale entry is still readable under the OLD sha -- this call alone
    // does not evict it; only a fresh `scheduleGitFileCacheWrite` replaces it,
    // which is what the route does on every miss.
    expect(await matchGitFileCache(cache, KEY, file(SHA))).not.toBeNull();
  });

  test("a cache that throws on match is a miss, not a failure", async () => {
    const broken: ManifestCache = {
      match: async () => {
        throw new Error("cache down");
      },
      put: async () => {
        throw new Error("cache down");
      },
    };
    expect(await matchGitFileCache(broken, KEY, file())).toBeNull();
  });

  test("an entry with no recognizable marker is treated as absent", async () => {
    const cache = new InMemoryCache();
    await cache.put(new Request(KEY), new Response(bytes("mystery"), { status: 200 }));
    expect(await matchGitFileCache(cache, KEY, file())).toBeNull();
  });
});

describe("scheduleGitFileCacheWrite", () => {
  const KEY = gitFileCacheKey(ORIGIN, "nm000862", "v1.0.0", "dataset_description.json");

  test("with a waitUntil, the write is handed off and this resolves at once", async () => {
    const cache = new StalledCache();
    const deferred: Promise<unknown>[] = [];
    const started = performance.now();
    await scheduleGitFileCacheWrite(
      { cache, key: KEY, blobSha: SHA, body: bytes("x"), headers: new Headers() },
      (work) => deferred.push(work),
    );
    expect(performance.now() - started).toBeLessThan(100);
    expect(cache.puts).toBe(1);
    expect(deferred).toHaveLength(1);
  });

  test("without a waitUntil, a stalled cache is abandoned after the bound, and the call never throws", async () => {
    const cache = new StalledCache();
    const started = performance.now();
    await scheduleGitFileCacheWrite(
      { cache, key: KEY, blobSha: SHA, body: bytes("x"), headers: new Headers() },
      undefined,
    );
    const elapsed = performance.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(GIT_FILE_CACHE_STALL_MS);
    expect(elapsed).toBeLessThan(GIT_FILE_CACHE_STALL_MS + 2000);
  });

  test("without a waitUntil, a healthy cache settles well under the stall bound", async () => {
    const cache = new InMemoryCache();
    const started = performance.now();
    await scheduleGitFileCacheWrite(
      { cache, key: KEY, blobSha: SHA, body: bytes("x"), headers: new Headers() },
      undefined,
    );
    expect(performance.now() - started).toBeLessThan(GIT_FILE_CACHE_STALL_MS);
    expect(await matchGitFileCache(cache, KEY, file(SHA))).not.toBeNull();
  });

  test("a cache.put that throws never rejects the caller, with or without a waitUntil", async () => {
    const faulty: ManifestCache = {
      match: async () => undefined,
      put: async () => {
        throw new Error("Cache API quota exceeded");
      },
    };
    await expect(
      scheduleGitFileCacheWrite(
        { cache: faulty, key: KEY, blobSha: SHA, body: bytes("x"), headers: new Headers() },
        undefined,
      ),
    ).resolves.toBeUndefined();

    const deferred: Promise<unknown>[] = [];
    await expect(
      scheduleGitFileCacheWrite(
        { cache: faulty, key: KEY, blobSha: SHA, body: bytes("x"), headers: new Headers() },
        (work) => deferred.push(work),
      ),
    ).resolves.toBeUndefined();
    // The handed-off promise is caught INSIDE the module (putGitFileCache's
    // own try/catch), so what a real `waitUntil` receives never rejects
    // either -- there is nothing here for the runtime to log as an
    // unhandled rejection.
    expect(deferred).toHaveLength(1);
    await expect(deferred[0]).resolves.toBeUndefined();
  });

  test("a real DrainingCache round-trip: what is put is what is matched", async () => {
    const cache = new DrainingCache();
    await scheduleGitFileCacheWrite(
      {
        cache,
        key: KEY,
        blobSha: SHA,
        body: bytes("dataset_description bytes"),
        headers: new Headers({ "Content-Type": "application/json" }),
      },
      undefined,
    );
    const hit = await matchGitFileCache(cache, KEY, file(SHA));
    expect(new TextDecoder().decode(hit?.body)).toBe("dataset_description bytes");
    expect(hit?.headers.get("Content-Type")).toBe("application/json");
  });
});
