/**
 * The shared in-memory Cache API test doubles (`InMemoryCache`, `DrainingCache`),
 * pinned against the real Workers Cache API rules they model (#1516 review):
 * an entry expires from its OWN stored `Cache-Control` max-age, `Vary: *` is
 * refused, and a `Set-Cookie` response is never stored. These are unit tests
 * of the doubles themselves -- the regression these rules exist to catch
 * (the git-file cache's stored TTL bug) is exercised end to end in
 * `git-file-broker.test.ts`'s "the stored copy's OWN freshness is not the
 * client's 300s" test.
 */

import { describe, expect, test } from "bun:test";
import { DrainingCache, InMemoryCache, keyFor } from "./cache";

function response(body: string, headers: HeadersInit = {}): Response {
  return new Response(body, { status: 200, headers });
}

for (const [name, makeCache] of [
  ["InMemoryCache", () => new InMemoryCache()],
  ["DrainingCache", () => new DrainingCache()],
] as const) {
  describe(name, () => {
    test("a plain put/match round-trips the body and headers", async () => {
      const cache = makeCache();
      await cache.put(new Request("https://x/1"), response("hello", { "X-Foo": "bar" }));
      const hit = await cache.match(new Request("https://x/1"));
      expect(await hit?.text()).toBe("hello");
      expect(hit?.headers.get("X-Foo")).toBe("bar");
    });

    test("a miss is undefined", async () => {
      const cache = makeCache();
      expect(await cache.match(new Request("https://x/nope"))).toBeUndefined();
    });

    test("a 206 is refused outright", async () => {
      const cache = makeCache();
      const partial = new Response("partial", { status: 206 });
      await expect(cache.put(new Request("https://x/206"), partial)).rejects.toThrow(/206/);
    });

    test("Vary: * is refused outright", async () => {
      const cache = makeCache();
      const varyStar = response("body", { Vary: "*" });
      await expect(cache.put(new Request("https://x/vary-star"), varyStar)).rejects.toThrow(/Vary/);
    });

    test("Vary: Accept and Vary: Origin are stored normally (only the literal * is refused)", async () => {
      for (const vary of ["Accept", "Origin", "Accept, Origin"]) {
        const cache = makeCache();
        await cache.put(new Request("https://x/vary"), response("body", { Vary: vary }));
        const hit = await cache.match(new Request("https://x/vary"));
        expect(hit).toBeDefined();
        expect(hit?.headers.get("Vary")).toBe(vary);
      }
    });

    test("a response carrying Set-Cookie is never stored, and put() still resolves", async () => {
      const cache = makeCache();
      await expect(
        cache.put(
          new Request("https://x/cookie"),
          response("body", { "Set-Cookie": "session=abc; HttpOnly" }),
        ),
      ).resolves.toBeUndefined();
      expect(await cache.match(new Request("https://x/cookie"))).toBeUndefined();
    });

    test("an entry with no Cache-Control never expires", async () => {
      const cache = makeCache();
      cache.getNow = () => 0;
      await cache.put(new Request("https://x/no-cc"), response("body"));
      cache.getNow = () => 1000 * 365 * 24 * 60 * 60; // a year later
      expect(await cache.match(new Request("https://x/no-cc"))).toBeDefined();
    });

    test("an entry expires exactly at its stored max-age, per the injected clock", async () => {
      const cache = makeCache();
      cache.getNow = () => 0;
      await cache.put(
        new Request("https://x/ttl"),
        response("body", { "Cache-Control": "max-age=300" }),
      );

      cache.getNow = () => 299_999;
      expect(await cache.match(new Request("https://x/ttl"))).toBeDefined();

      cache.getNow = () => 300_000;
      expect(await cache.match(new Request("https://x/ttl"))).toBeUndefined();

      // And it stays gone -- the entry was evicted, not merely skipped once.
      cache.getNow = () => 300_001;
      expect(await cache.match(new Request("https://x/ttl"))).toBeUndefined();
    });

    test("a long stored max-age survives well past a short client-facing one", async () => {
      // The exact shape of the git-file cache's fix: the STORED header can
      // carry a long TTL independent of whatever a client was told.
      const cache = makeCache();
      cache.getNow = () => 0;
      await cache.put(
        new Request("https://x/long-ttl"),
        response("body", { "Cache-Control": "max-age=604800" }), // 7 days
      );
      cache.getNow = () => 301_000; // 301s later: past a hypothetical 300s TTL
      expect(await cache.match(new Request("https://x/long-ttl"))).toBeDefined();
    });
  });
}

test("keyFor keys on the request URL, not the Request object identity", () => {
  const a = new Request("https://x/same");
  const b = new Request("https://x/same");
  expect(keyFor(a)).toBe(keyFor(b));
  expect(keyFor("https://x/same")).toBe(keyFor(a));
});
