/**
 * Local before/after measurement for the brokered git-tracked file edge
 * cache (#1516), following #1505's method: drive the real `dataRoutes` Hono
 * app in-process against a real D1 (every migration applied) and a local
 * `Bun.serve` stand-in for GitHub's raw content host and for S3 (the same
 * host serves both, exactly like `test/git-file-broker.test.ts`'s route
 * suite), with artificial latency added to the raw-file handler so "upstream
 * fetch" costs something measurable, the way a real GitHub round trip does.
 *
 * Not a `bun:test` file on purpose -- it prints a report rather than
 * asserting, and its wall-clock numbers should not gate CI on the noise of
 * whatever else is running on the machine at the time.
 *
 * Run with:
 *   bun run backend/scripts/bench-git-file-cache.ts
 *   bun run backend/scripts/bench-git-file-cache.ts --files=500 --latency=60
 */

import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import { dataRoutes } from "../src/routes/data";
import type { Bindings, Variables } from "../src/types/bindings";
import { DrainingCache } from "../test/helpers/cache";
import { freshDb, realD1 } from "../test/helpers/d1";

const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? "true"];
  }),
);
const FILE_COUNT = Number(args.get("files") ?? 300);
const UPSTREAM_LATENCY_MS = Number(args.get("latency") ?? 60);
// The manifest stand-in answered instantly until #1494's placement/window
// follow-up: every git-file-cache measurement above was paying zero cost for
// the manifest conditional GET that precedes every single request
// (`fileOrIndexHandler` resolves the path via the manifest before it ever
// looks at the git-file cache), which understated how much a manifest round
// trip actually costs on staging (measured 120-460ms per #1494). Default
// chosen as a plausible same-region S3 conditional GET; staging's own number
// is worse (cross-Atlantic colos), which the placement change addresses
// separately from this bench.
const S3_LATENCY_MS = Number(args.get("s3-latency") ?? 40);
const PARALLELISM = Number(args.get("parallel") ?? 16);
const DATASET_ID = "nm000900";
const VERSION = "v1.0.0";

/** The git object name for a blob's contents -- SHA-1 over `blob <len>\0<bytes>`,
 *  the same public algorithm `git hash-object` and `gitBlobSha` in
 *  `routes/data.ts` compute. Reimplemented here (rather than imported) since
 *  it is not exported and this is a fixture-building concern, not the code
 *  under test. */
async function gitBlobSha(bytes: Uint8Array): Promise<string> {
  const header = new TextEncoder().encode(`blob ${bytes.byteLength}\0`);
  const framed = new Uint8Array(header.byteLength + bytes.byteLength);
  framed.set(header, 0);
  framed.set(bytes, header.byteLength);
  const digest = await crypto.subtle.digest("SHA-1", framed);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Backs ONLY the rate limiter's own counter keys (`rate-limit.internal/rl:...`);
 * every other key -- the git-file content cache, the manifest cache, both of
 * which also read `caches.default` -- is always a miss and every write to one
 * is silently dropped. Installed for the "before" phase (review: #1519) so
 * `checkDataMissBudget` behaves exactly as it does in production (a working
 * counter, no fail-open) while the content and manifest caches stay exactly
 * as absent as they were before this class existed (`globalThis.caches =
 * undefined`) -- without it, EVERY "before" miss threw
 * `caches.default is undefined` inside `checkDataMissBudget`'s try/catch and
 * logged `[rate-limit] cache failure`, hundreds of lines and exception
 * overhead that neither production nor the pre-#1516 code ever paid.
 */
class RateLimitOnlyCache implements Pick<Cache, "match" | "put"> {
  private counters = new Map<string, Response>();
  private static isCounterKey(request: RequestInfo | URL): boolean {
    const url = request instanceof Request ? request.url : String(request);
    return url.startsWith("https://rate-limit.internal/");
  }
  async match(request: RequestInfo | URL): Promise<Response | undefined> {
    if (!RateLimitOnlyCache.isCounterKey(request)) return undefined;
    const url = request instanceof Request ? request.url : String(request);
    return this.counters.get(url)?.clone();
  }
  async put(request: RequestInfo | URL, response: Response): Promise<void> {
    if (!RateLimitOnlyCache.isCounterKey(request)) return;
    const url = request instanceof Request ? request.url : String(request);
    this.counters.set(url, response.clone());
  }
}

interface Fixture {
  paths: string[];
  bidsPathOf(i: number): string;
}

async function buildFixture(db: Database, count: number): Promise<Fixture> {
  db.prepare(
    `INSERT INTO datasets (dataset_id, name, owner_user_id, status, visibility, is_sandbox)
     VALUES (?, ?, 1, 'active', 'public', 0)`,
  ).run(DATASET_ID, DATASET_ID);
  db.prepare(
    `INSERT INTO dataset_versions (dataset_id, version, doi, provider, created_at)
     VALUES (?, '1.0.0', '10.5072/FK2bench', 'ezid', datetime('now'))`,
  ).run(DATASET_ID);

  const files: Record<string, { key: string; size: number; checksum: string }> = {};
  const paths: string[] = [];
  for (let i = 0; i < count; i++) {
    const path = `sub-${String(i).padStart(4, "0")}/eeg/sub-${String(i).padStart(4, "0")}_channels.tsv`;
    const body = new TextEncoder().encode(`name\tunits\nEEG${i}\tuV\n`);
    const sha = await gitBlobSha(body);
    files[path] = { key: `git:${sha}`, size: body.byteLength, checksum: `git:${sha}` };
    paths.push(path);
  }

  return {
    paths,
    bidsPathOf: (i) => paths[i],
  };
}

async function main() {
  console.log(
    `git-file-cache bench: ${FILE_COUNT} files, ${UPSTREAM_LATENCY_MS}ms simulated upstream latency, ${PARALLELISM}-way parallel\n`,
  );

  const db = freshDb();
  const fixture = await buildFixture(db, FILE_COUNT);

  // Rebuild the manifest body from what buildFixture wrote, for the S3
  // stand-in to serve.
  const manifestFiles: Record<string, unknown> = {};
  for (const path of fixture.paths) {
    const body = new TextEncoder().encode(
      `name\tunits\nEEG${Number(path.match(/\d+/)?.[0])}\tuV\n`,
    );
    const sha = await gitBlobSha(body);
    manifestFiles[path] = { key: `git:${sha}`, size: body.byteLength, checksum: `git:${sha}` };
  }
  const manifestBody = JSON.stringify({
    dataset_id: DATASET_ID,
    version: "1.0.0",
    doi: null,
    concept_doi: null,
    created: "2026-01-01T00:00:00Z",
    files: manifestFiles,
  });
  const manifestKey = `/${DATASET_ID}/version/${VERSION}.json`;
  const manifestEtag = `"bench-${manifestBody.length}"`;

  let upstreamRequests = 0;
  let manifestRequests = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === manifestKey) {
        manifestRequests++;
        if (S3_LATENCY_MS > 0) await Bun.sleep(S3_LATENCY_MS);
        const inm = request.headers.get("If-None-Match");
        if (inm === manifestEtag) return new Response(null, { status: 304 });
        return new Response(manifestBody, {
          status: 200,
          headers: { ETag: manifestEtag, "Content-Type": "application/json" },
        });
      }
      const prefix = `/nemarDatasets/${DATASET_ID}/${VERSION}/`;
      if (url.pathname.startsWith(prefix)) {
        upstreamRequests++;
        if (UPSTREAM_LATENCY_MS > 0) await Bun.sleep(UPSTREAM_LATENCY_MS);
        const rawPath = decodeURIComponent(url.pathname.slice(prefix.length));
        const idx = fixture.paths.indexOf(rawPath);
        const body = new TextEncoder().encode(`name\tunits\nEEG${idx}\tuV\n`);
        return new Response(body, {
          status: 200,
          headers: { "Content-Length": String(body.byteLength) },
        });
      }
      return new Response("no route", { status: 404 });
    },
  });
  const base = `http://127.0.0.1:${server.port}`;

  function app(): Hono<{ Bindings: Bindings; Variables: Variables }> {
    const hono = new Hono<{ Bindings: Bindings; Variables: Variables }>();
    hono.route("/", dataRoutes);
    return hono;
  }
  function env(): Bindings {
    return {
      DB: realD1(db),
      ENVIRONMENT: "test",
      GITHUB_RAW_BASE: base,
      S3_ENDPOINT_URL: base,
      S3_BUCKET: "nemar",
      AWS_REGION: "us-east-2",
      AWS_ACCESS_KEY_ID: "AKIABENCH",
      AWS_SECRET_ACCESS_KEY: "secret",
      GITHUB_ADMIN_PAT: "bench-pat",
    } as Bindings;
  }

  async function fetchFile(i: number): Promise<number> {
    const path = fixture.bidsPathOf(i);
    const start = performance.now();
    const res = await app().request(`/${DATASET_ID}/${VERSION}/${path}`, {}, env());
    if (res.status !== 200) throw new Error(`unexpected status ${res.status} for ${path}`);
    await res.arrayBuffer();
    return performance.now() - start;
  }

  /**
   * HEAD instead of GET: `fileOrIndexHandler`'s HEAD branch resolves the path
   * through the manifest (the gate + `queryManifest`) and returns without ever
   * touching the git-file cache or GitHub. Isolates the manifest layer's own
   * cost from the content-cache measurements above, which is the layer #1494's
   * placement/trust-window follow-up changes.
   */
  async function headFile(i: number): Promise<number> {
    const path = fixture.bidsPathOf(i);
    const start = performance.now();
    const res = await app().request(`/${DATASET_ID}/${VERSION}/${path}`, { method: "HEAD" }, env());
    if (res.status !== 200) throw new Error(`unexpected status ${res.status} for ${path}`);
    return performance.now() - start;
  }

  async function parallelWallClock(
    indices: number[],
    parallelism: number,
    fetchOne: (i: number) => Promise<number> = fetchFile,
  ): Promise<number> {
    const start = performance.now();
    let next = 0;
    async function worker() {
      for (;;) {
        const i = next++;
        if (i >= indices.length) return;
        await fetchOne(indices[i]);
      }
    }
    await Promise.all(Array.from({ length: parallelism }, worker));
    return performance.now() - start;
  }

  const indices = fixture.paths.map((_, i) => i);

  // ---- BEFORE: no CONTENT or manifest caching -- every request is a real
  // upstream fetch, exactly the shape the route had before #1516
  // (`edgeCache()` sees a cache object, but `RateLimitOnlyCache` answers
  // every non-rate-limit key as an absent miss with a no-op write, so
  // neither cache actually does anything). The rate limiter's OWN counter
  // still works normally against this same object, matching production
  // (`checkDataMissBudget` always has a real `caches.default`) instead of
  // throwing and logging a fail-open on every single miss.
  (globalThis as { caches?: unknown }).caches = { default: new RateLimitOnlyCache() };
  upstreamRequests = 0;
  const beforeFirst = await fetchFile(0);
  const beforeWall = await parallelWallClock(indices, PARALLELISM);
  const beforeUpstream = upstreamRequests;

  // ---- AFTER: a real edge cache installed (the same `DrainingCache` the
  // route tests use, not a bespoke stand-in, so this bench and the test
  // suite agree on what the Workers Cache API does). First pass is a cold
  // miss for every file (writes the cache); second pass is a warm hit for
  // every file.
  const cache = new DrainingCache();
  const storedAt = Date.now();
  (globalThis as { caches?: unknown }).caches = { default: cache };
  upstreamRequests = 0;
  const afterMissFirst = await fetchFile(0);
  const afterMissWall = await parallelWallClock(indices.slice(1), PARALLELISM);
  const afterMissUpstream = upstreamRequests;

  upstreamRequests = 0;
  const afterHitFirst = await fetchFile(0);
  const afterHitWall = await parallelWallClock(indices.slice(1), PARALLELISM);
  const afterHitUpstream = upstreamRequests;

  // ---- AFTER, WARM, PAST THE CLIENT'S 300s: the cross-session case #1494
  // actually cares about. The stored entries are now "old" by more than the
  // client-facing `public, max-age=300` -- simulating a second downloader
  // arriving 6 minutes after the first, well inside GIT_FILE_CACHE_TTL_SECONDS
  // (7 days) but past the number a naive implementation would have reused as
  // the STORED entry's own freshness (the bug found in review: reusing the
  // client's Cache-Control verbatim made every copy expire after 5 minutes).
  // Still a hit here is the numbers proving the fix, not just the code.
  cache.getNow = () => storedAt + 6 * 60 * 1000;
  upstreamRequests = 0;
  const afterExpiryFirst = await fetchFile(0);
  const afterExpiryWall = await parallelWallClock(indices.slice(1), PARALLELISM);
  const afterExpiryUpstream = upstreamRequests;

  // ---- MANIFEST LAYER (#1494 placement/trust-window follow-up). HEAD only,
  // so this isolates the manifest read from the git-file content cache above:
  // every one of these FILE_COUNT requests resolves a DIFFERENT path in the
  // SAME dataset/version manifest, so a content-cache hit/miss is irrelevant
  // and what varies is purely how many of these reads cost a manifest S3
  // conditional GET (`manifestRequests`) versus how many are answered from
  // the edge copy without one.
  //
  // A fresh cache for this section: the git-file-cache passes above already
  // populated `manifestCacheKey` for this dataset/version, and reusing that
  // cache would make "cold" mean something different than it does elsewhere
  // in this report.
  const manifestCache = new DrainingCache();
  (globalThis as { caches?: unknown }).caches = { default: manifestCache };

  manifestRequests = 0;
  const manifestColdWall = await parallelWallClock(indices, PARALLELISM, headFile);
  const manifestColdRequests = manifestRequests;

  // Same paths again, immediately: still within the trust window on patched
  // code (and, on unpatched code, this is exactly today's "every read is a
  // conditional GET" behavior -- the comparison this section exists to make).
  manifestRequests = 0;
  const manifestWarmWall = await parallelWallClock(indices, PARALLELISM, headFile);
  const manifestWarmRequests = manifestRequests;

  // 70 seconds later: past a 60s trust window. `Date.now` is monkey-patched
  // rather than threaded through a test-only seam in the route itself --
  // acceptable in a throwaway-process bench script, not something a unit test
  // should do (see `test/manifest-source.test.ts` for the real seam,
  // `ManifestSource.now`).
  const realDateNow = Date.now;
  Date.now = () => realDateNow() + 70_000;
  manifestRequests = 0;
  let manifestExpiredWall: number;
  let manifestExpiredRequests: number;
  try {
    manifestExpiredWall = await parallelWallClock(indices, PARALLELISM, headFile);
    manifestExpiredRequests = manifestRequests;
  } finally {
    Date.now = realDateNow;
  }

  server.stop(true);

  const row = (label: string, ms: number, extra = "") =>
    console.log(`${label.padEnd(46)} ${ms.toFixed(1).padStart(9)} ms  ${extra}`);

  console.log("Single-request latency");
  row("before (no cache, upstream fetch)", beforeFirst);
  row("after, cold (cache miss, writes cache)", afterMissFirst);
  row("after, warm (cache hit)", afterHitFirst);
  row("after, warm, 6 min later (cross-session hit)", afterExpiryFirst);
  console.log();
  console.log(`${PARALLELISM}-parallel wall clock over ${FILE_COUNT} files`);
  row("before (no cache)", beforeWall, `upstream requests: ${beforeUpstream}`);
  row("after, cold (cache miss)", afterMissWall, `upstream requests: ${afterMissUpstream}`);
  row("after, warm (cache hit)", afterHitWall, `upstream requests: ${afterHitUpstream}`);
  row(
    "after, warm, 6 min later (cross-session)",
    afterExpiryWall,
    `upstream requests: ${afterExpiryUpstream}`,
  );
  console.log();
  console.log(
    `Manifest layer only (HEAD, ${PARALLELISM}-parallel, ${FILE_COUNT} distinct paths, ${S3_LATENCY_MS}ms simulated S3 latency)`,
  );
  row(
    "cold (first pass, fresh manifest cache)",
    manifestColdWall,
    `manifest S3 reads: ${manifestColdRequests}`,
  );
  row(
    "warm (same paths again, immediately)",
    manifestWarmWall,
    `manifest S3 reads: ${manifestWarmRequests}`,
  );
  row(
    "warm, 70s later (past a 60s trust window)",
    manifestExpiredWall,
    `manifest S3 reads: ${manifestExpiredRequests}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
