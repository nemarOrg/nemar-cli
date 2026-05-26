/**
 * E2E tests for the data.nemar.org route (epic #449, phase 1).
 *
 * Targets a deployed backend (set TEST_API_URL; defaults to api.nemar.org).
 * Exercises the path-based mount at `<host>/data/...` so the same suite
 * works on workers.dev (dev), api.nemar.org (prod fallback), and -- once
 * DNS is in place -- via the data.nemar.org custom domain (which serves
 * the same handlers at the root path).
 *
 * The suite assumes a public dataset with at least one published version
 * exists. nm099999 is the canonical test dataset; tests skip gracefully
 * if it is not currently published.
 *
 * Prod-traffic safeguard: if TEST_API_URL points at api.nemar.org, the
 * suite skips itself unless TEST_ALLOW_PROD=1 is also set. Even though
 * these tests are read-only, the default-to-prod posture is footgun-shaped
 * for any contributor running `bun test` blindly.
 */

import { describe, expect, test } from "bun:test";
import "./setup";
import { TEST_CONFIG } from "./setup";

const TEST_DATASET = process.env.TEST_DATA_DATASET ?? "nm099999";
const API = TEST_CONFIG.apiUrl;
const headers: Record<string, string> = TEST_CONFIG.bypassToken
  ? { "X-Test-Bypass": TEST_CONFIG.bypassToken }
  : {};
const POINTS_AT_PROD = API.includes("api.nemar.org") || API.includes("data.nemar.org");
const PROD_GUARD_ACTIVE = POINTS_AT_PROD && !process.env.TEST_ALLOW_PROD;

async function fetchNoRedirect(path: string): Promise<Response> {
  return fetch(`${API}${path}`, { redirect: "manual", headers });
}

interface ManifestSummary {
  versions?: string[];
}

interface CatalogRow {
  visibility?: string;
}

async function detectAvailable(): Promise<{ available: boolean; reason?: string }> {
  const dsResp = await fetch(`${API}/datasets/${TEST_DATASET}`, { headers });
  if (dsResp.status === 404) return { available: false, reason: "dataset not found" };
  if (!dsResp.ok) return { available: false, reason: `dataset GET ${dsResp.status}` };
  const ds = (await dsResp.json()) as CatalogRow;
  if (ds.visibility !== "public")
    return { available: false, reason: `visibility=${ds.visibility}` };

  const manResp = await fetch(`${API}/datasets/${TEST_DATASET}/manifest`, { headers });
  if (!manResp.ok) return { available: false, reason: `manifest list ${manResp.status}` };
  const m = (await manResp.json()) as ManifestSummary;
  if (!m.versions || m.versions.length === 0) {
    return { available: false, reason: "no published versions" };
  }
  return { available: true };
}

describe("data.nemar.org route (epic #449, phase 1)", async () => {
  if (PROD_GUARD_ACTIVE) {
    test.skip("refusing to run against production without TEST_ALLOW_PROD=1", () => undefined);
    return;
  }

  const { available, reason } = await detectAvailable();
  if (!available) {
    test.skip(`prerequisite missing: ${reason}`, () => undefined);
    return;
  }

  test("nonexistent dataset returns 404 with structured error body", async () => {
    const r = await fetchNoRedirect("/data/nm999000/latest/anything");
    expect(r.status).toBe(404);
    expect(r.headers.get("content-type")).toContain("application/json");
    const body = (await r.json()) as { error: string };
    expect(body.error).toBe("Dataset not found");
  });

  test("rejects bogus dataset IDs without leaking 5xx", async () => {
    const r = await fetchNoRedirect("/data/totally-invalid-id/latest/x");
    expect(r.status).toBe(404);
  });

  test("rejects bogus version strings", async () => {
    const r = await fetchNoRedirect(`/data/${TEST_DATASET}/not-a-version/x`);
    expect(r.status).toBe(404);
  });

  test("rejects path traversal", async () => {
    const r = await fetchNoRedirect(`/data/${TEST_DATASET}/latest/../../../etc/passwd`);
    expect(r.status).toBe(404);
  });

  test("manifest.json returns the published file index", async () => {
    const r = await fetch(`${API}/data/${TEST_DATASET}/latest/manifest.json`, { headers });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("application/json");
    const body = (await r.json()) as Array<{
      path: string;
      size: number;
      checksum: string;
      checksum_algorithm: string;
      url: string | null;
      error?: string;
    }>;
    expect(body.length).toBeGreaterThan(0);
    expect(body[0]).toHaveProperty("path");
    expect(body[0]).toHaveProperty("url");
    // url should be a URL for healthy rows; null only when the per-row
    // try/catch caught a buildRedirectUrl failure (e.g. unrecognized key).
    if (body[0].url !== null) expect(body[0].url).toMatch(/^https:\/\//);
  });

  test("root index returns HTML with a manifest.json link", async () => {
    const r = await fetch(`${API}/data/${TEST_DATASET}/latest/`, { headers });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/html");
    const body = await r.text();
    expect(body).toContain("Index of /");
    expect(body).toContain("manifest.json");
  });

  test("dataset root (no version) returns a public landing page", async () => {
    const r = await fetch(`${API}/data/${TEST_DATASET}`, {
      headers: { ...headers, Accept: "text/html" },
      redirect: "manual",
    });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/html");
    const body = await r.text();
    expect(body).toContain("/latest/");
    expect(body).toContain("/latest/manifest.json");
  });

  test("dataset root rejects unknown dataset ids before rendering HTML", async () => {
    const r = await fetch(`${API}/data/nm999000`, { headers, redirect: "manual" });
    expect(r.status).toBe(404);
  });

  test("file path 302s to a URL that resolves to the actual bytes", async () => {
    const manResp = await fetch(`${API}/data/${TEST_DATASET}/latest/manifest.json`, { headers });
    const entries = (await manResp.json()) as Array<{
      path: string;
      url: string | null;
      size: number;
    }>;
    const target =
      entries.find((e) => e.path.endsWith("dataset_description.json") && e.url !== null) ??
      entries.find((e) => e.url !== null);
    expect(target).toBeDefined();
    if (!target?.url) return;

    const redirect = await fetchNoRedirect(`/data/${TEST_DATASET}/latest/${target.path}`);
    expect(redirect.status).toBe(302);
    const location = redirect.headers.get("location");
    expect(location).toBeDefined();
    if (!location) return;
    const fileResp = await fetch(location);
    expect(fileResp.ok).toBe(true);
    const bytes = new Uint8Array(await fileResp.arrayBuffer());
    expect(bytes.byteLength).toBe(target.size);
  });

  test("anonymous (no Authorization header) behaves identically", async () => {
    const r = await fetch(`${API}/data/${TEST_DATASET}/latest/manifest.json`, {
      headers,
    });
    expect(r.status).toBe(200);
  });

  // ---------------------------------------------------------------------------
  // Phase 2 (#496): metadata.json sibling endpoint
  // ---------------------------------------------------------------------------

  test("metadata.json returns a neuroschema-shaped dataset document", async () => {
    const r = await fetch(`${API}/data/${TEST_DATASET}/metadata.json`, { headers });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("application/json");
    expect(r.headers.get("cache-control")).toContain("max-age=60");

    const body = (await r.json()) as {
      schema_version: string;
      doc_type: string;
      dataset_id: string;
      source: string;
      authors: Array<{ name: string }>;
      versions?: unknown;
      extensions: {
        nemar: {
          versions: Array<{ version: string; doi: string; manifest_url: string }>;
          bids_index: { version: string; subjects: Record<string, unknown> } | null;
          pipeline_stage: string | null;
        };
      };
    };

    expect(body.schema_version).toBe("0.3.0");
    expect(body.doc_type).toBe("dataset");
    expect(body.dataset_id).toBe(TEST_DATASET);
    expect(body.source).toBe("nemar");
    expect(Array.isArray(body.authors)).toBe(true);
    expect(body.extensions.nemar.versions.length).toBeGreaterThan(0);
    // version field is always tag-form (v-prefixed) on the wire.
    expect(body.extensions.nemar.versions[0].version).toMatch(/^v\d+\.\d+\.\d+$/);
    expect(body.extensions.nemar.versions[0].manifest_url).toBe(
      `/${TEST_DATASET}/${body.extensions.nemar.versions[0].version}/manifest.json`,
    );
  });

  test("metadata.json 404s for unknown datasets without leaking existence", async () => {
    const r = await fetch(`${API}/data/nm999000/metadata.json`, { headers });
    expect(r.status).toBe(404);
    const body = (await r.json()) as { error: string };
    expect(body.error).toBe("Dataset not found");
  });

  // ---------------------------------------------------------------------------
  // Epic #618 / phase 3 (#621): page-bundle endpoint
  // ---------------------------------------------------------------------------

  test("page-bundle.json returns landing+metadata+summary+catalog in one payload", async () => {
    const r = await fetch(`${API}/data/${TEST_DATASET}/page-bundle.json`, { headers });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("application/json");

    const body = (await r.json()) as {
      dataset_id: string;
      version: string | null;
      complete: boolean;
      landing: { ok: boolean };
      metadata: { ok: boolean };
      summary: { ok: boolean; data?: unknown };
      catalog_row: { ok: boolean };
      enrichment_degraded: boolean;
    };

    expect(body.dataset_id).toBe(TEST_DATASET);
    expect(body.landing.ok).toBe(true);
    expect(body.metadata.ok).toBe(true);
    expect(body.summary.ok).toBe(true);
    expect(body.catalog_row.ok).toBe(true);
    expect(typeof body.enrichment_degraded).toBe("boolean");
  });

  // Cache-poisoning regression guard: a `complete=true` response MUST carry the
  // long s-maxage policy, and a `complete=false` response MUST be no-store. The
  // partial-cache-poisoning class previously hit ww2.nemar.org's SSR partials
  // (transient upstream failures returning 200 with success Cache-Control got
  // pinned at the CF edge for up to 24h via stale-while-revalidate). The
  // page-bundle's `isBundleComplete` predicate is what defends against that;
  // assert the wire contract end-to-end so a refactor can't silently flip it.
  test("page-bundle.json: Cache-Control matches the complete flag", async () => {
    const r = await fetch(`${API}/data/${TEST_DATASET}/page-bundle.json`, { headers });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { complete: boolean };
    const cacheControl = r.headers.get("cache-control") ?? "";

    if (body.complete) {
      // Success branch: long edge cache + SWR. Exact policy is allowed to
      // evolve, but it MUST be cacheable and MUST NOT be no-store.
      expect(cacheControl).toContain("s-maxage");
      expect(cacheControl).not.toContain("no-store");
    } else {
      // Partial-failure branch: no-store is non-negotiable. Anything else
      // re-opens the partial-cache-poisoning class.
      expect(cacheControl).toContain("no-store");
    }
  });

  test("page-bundle.json: ?v=<unknown> falls back to landing.latest (no 404)", async () => {
    // The bundle deliberately recovers from a typo'd version rather than
    // 404-ing the whole page; the consumer reads `version` from the body
    // and can render "version not found, showing latest" UX.
    const r = await fetch(
      `${API}/data/${TEST_DATASET}/page-bundle.json?v=v999.999.999`,
      { headers },
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as { version: string | null; complete: boolean };
    // landing.latest is what's served; version field is non-null and not the bogus input.
    expect(body.version).not.toBe("999.999.999");
    expect(body.version).not.toBeNull();
    expect(body.complete).toBe(true);
  });

  test("page-bundle.json 404s for unknown datasets without leaking existence", async () => {
    const r = await fetch(`${API}/data/nm999000/page-bundle.json`, { headers });
    expect(r.status).toBe(404);
  });

  // ---------------------------------------------------------------------------
  // Phase 3 (#497): sitemap landing page + tombstone 404s
  // ---------------------------------------------------------------------------

  test("dataset root: default Accept yields JSON with versions array", async () => {
    // curl-like default (no Accept). The route picks JSON, surfacing the
    // version list machine-readably without requiring an explicit
    // ?format=json on the URL.
    const r = await fetch(`${API}/data/${TEST_DATASET}`, { headers, redirect: "manual" });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("application/json");
    const body = (await r.json()) as {
      dataset_id: string;
      latest: string | null;
      metadata_url: string;
      versions: Array<{
        version: string;
        manifest_url: string;
        browse_url: string;
        doi: string | null;
        created_at: string | null;
      }>;
    };
    expect(body.dataset_id).toBe(TEST_DATASET);
    expect(body.versions.length).toBeGreaterThan(0);
    expect(body.latest).toBe(body.versions[0].version);
    expect(body.metadata_url).toBe(`/${TEST_DATASET}/metadata.json`);
    expect(body.versions[0].manifest_url).toMatch(/^\/.*\/manifest\.json$/);
  });

  test("dataset root: ?format=json overrides browser Accept", async () => {
    const r = await fetch(`${API}/data/${TEST_DATASET}?format=json`, {
      headers: { ...headers, Accept: "text/html" },
      redirect: "manual",
    });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("application/json");
  });

  test("HTML index page includes the 'all versions' footer link", async () => {
    const r = await fetch(`${API}/data/${TEST_DATASET}/latest/`, {
      headers: { ...headers, Accept: "text/html" },
    });
    expect(r.status).toBe(200);
    const body = await r.text();
    expect(body).toContain(`href="/${TEST_DATASET}/"`);
    expect(body).toContain("all versions");
  });

  test("nonexistent file path returns 404 JSON with no tombstone fields", async () => {
    // sub-zz/never.edf has never existed in any version -> no tombstone.
    const r = await fetchNoRedirect(`/data/${TEST_DATASET}/latest/sub-zz/never.edf`);
    expect(r.status).toBe(404);
    expect(r.headers.get("content-type")).toContain("application/json");
    const body = (await r.json()) as {
      error: string;
      version?: string;
      path?: string;
      reason?: string;
      last_seen_version?: string;
    };
    expect(body.error).toBe("File not found");
    // version/path are always echoed so a JSON consumer doesn't need to
    // re-parse the request URL to know what it asked for.
    expect(body.version).toBeTruthy();
    expect(body.path).toBe("sub-zz/never.edf");
    expect(body.reason).toBeUndefined();
    expect(body.last_seen_version).toBeUndefined();
  });

  test("nonexistent file path with Accept: text/html returns an HTML 404", async () => {
    const r = await fetchNoRedirect(`/data/${TEST_DATASET}/latest/sub-zz/never.edf`);
    // Re-issue with the right Accept header (fetchNoRedirect doesn't take one).
    const html = await fetch(`${API}/data/${TEST_DATASET}/latest/sub-zz/never.edf`, {
      headers: { ...headers, Accept: "text/html" },
      redirect: "manual",
    });
    expect(r.status).toBe(404);
    expect(html.status).toBe(404);
    expect(html.headers.get("content-type")).toContain("text/html");
    const body = await html.text();
    expect(body).toContain("404");
    expect(body).toContain("all versions");
  });

  // Tombstone E2E (reason: "removed") requires nm099999 to have at least
  // two published versions where the second drops a path the first had.
  // The standard e2e-test fixture is a single-version reset, so we skip
  // this test when the precondition isn't met. Cross-referenced with the
  // unit-test fixture in `multiVersionFixtures` which covers the same
  // branch with hand-built manifests.
  test("tombstone 404 (when fixture supports it)", async () => {
    const manResp = await fetch(`${API}/data/${TEST_DATASET}/manifest`, { headers });
    const list = (await manResp.json()) as { versions?: string[] };
    if (!list.versions || list.versions.length < 2) {
      console.log(`[skip] tombstone E2E: ${TEST_DATASET} needs >=2 versions, has ${list.versions?.length ?? 0}`);
      return;
    }
    // Find a path present in v[N-1] but absent in v[N] = "latest".
    const olderTag = list.versions[1].startsWith("v") ? list.versions[1] : `v${list.versions[1]}`;
    const olderMan = await fetch(`${API}/data/${TEST_DATASET}/${olderTag}/manifest.json`, { headers });
    if (!olderMan.ok) return;
    const olderEntries = (await olderMan.json()) as Array<{ path: string }>;
    const latestMan = await fetch(`${API}/data/${TEST_DATASET}/latest/manifest.json`, { headers });
    if (!latestMan.ok) return;
    const latestPaths = new Set(((await latestMan.json()) as Array<{ path: string }>).map((e) => e.path));
    const removed = olderEntries.find((e) => !latestPaths.has(e.path));
    if (!removed) {
      console.log("[skip] tombstone E2E: no path was removed between latest and prior version");
      return;
    }
    const r = await fetchNoRedirect(`/data/${TEST_DATASET}/latest/${removed.path}`);
    expect(r.status).toBe(404);
    const body = (await r.json()) as { error: string; reason?: string; last_seen_version?: string; last_seen_url?: string };
    expect(body.reason).toBe("removed");
    expect(body.last_seen_version).toBeTruthy();
    expect(body.last_seen_url).toContain(removed.path);
  });

  // ---------------------------------------------------------------------------
  // Phase 4 (#498): rclone-compatible HEAD + metadata headers on file responses
  // ---------------------------------------------------------------------------

  test("HEAD on a file returns 200 with size, mtime, ETag, no body", async () => {
    const manResp = await fetch(`${API}/data/${TEST_DATASET}/latest/manifest.json`, { headers });
    const entries = (await manResp.json()) as Array<{
      path: string;
      size: number;
      url: string | null;
    }>;
    const target =
      entries.find((e) => e.path.endsWith("dataset_description.json") && e.url !== null) ??
      entries.find((e) => e.url !== null);
    expect(target).toBeDefined();
    if (!target) return;

    const head = await fetch(`${API}/data/${TEST_DATASET}/latest/${target.path}`, {
      method: "HEAD",
      headers,
      redirect: "manual",
    });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe(String(target.size));
    const lastModified = head.headers.get("last-modified");
    expect(lastModified).toBeTruthy();
    if (lastModified) {
      // RFC 1123 dates parse cleanly via the Date constructor.
      expect(Number.isNaN(new Date(lastModified).getTime())).toBe(false);
    }
    const etag = head.headers.get("etag");
    expect(etag).toBeTruthy();
    // Manifest checksum is "sha256:<hex>" / "md5:<hex>" / "sha1:<hex>" / "git:<sha>"; quoted per RFC 7232.
    if (etag) expect(etag).toMatch(/^"(?:sha256:|md5:|sha1:|git:)/);
    const buf = await head.arrayBuffer();
    expect(buf.byteLength).toBe(0);
  });

  test("HEAD on a directory returns 200 with text/html, no body", async () => {
    const head = await fetch(`${API}/data/${TEST_DATASET}/latest/`, {
      method: "HEAD",
      headers,
    });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-type")).toContain("text/html");
    const buf = await head.arrayBuffer();
    expect(buf.byteLength).toBe(0);
  });

  test("HEAD on a missing path returns 404 with no tombstone body", async () => {
    // Tombstone walk is intentionally skipped on HEAD so rclone sync
    // against a divergent local copy doesn't fan out N manifest fetches
    // per missing file. Response is just 404 with no body.
    const head = await fetch(`${API}/data/${TEST_DATASET}/latest/sub-zz/never.edf`, {
      method: "HEAD",
      headers,
    });
    expect(head.status).toBe(404);
    const buf = await head.arrayBuffer();
    expect(buf.byteLength).toBe(0);
  });

  test("GET 302 on a file carries Last-Modified and ETag (Content-Length intentionally omitted)", async () => {
    // RFC 9110 §8.6: Content-Length on a 302 describes the (empty)
    // message body, not the redirect target. Carrying the file's size
    // on a no-body redirect can confuse intermediaries that mis-frame
    // the response. The S3 target's GET response carries Content-Length
    // accurately. Last-Modified and ETag remain on the 302 -- both are
    // valid on redirects per RFC 9110 §8.8 and let some clients skip
    // the HEAD step entirely.
    const manResp = await fetch(`${API}/data/${TEST_DATASET}/latest/manifest.json`, { headers });
    const entries = (await manResp.json()) as Array<{
      path: string;
      size: number;
      url: string | null;
    }>;
    const target = entries.find((e) => e.url !== null);
    expect(target).toBeDefined();
    if (!target) return;

    const r = await fetch(`${API}/data/${TEST_DATASET}/latest/${target.path}`, {
      headers,
      redirect: "manual",
    });
    expect(r.status).toBe(302);
    expect(r.headers.get("last-modified")).toBeTruthy();
    expect(r.headers.get("etag")).toBeTruthy();
    expect(r.headers.get("location")).toBeTruthy();
  });
});

/**
 * Catalog index at the data sub-app root (#584). Independent of any
 * specific test dataset existing -- the catalog endpoint itself is
 * the unit under test, not nm099999 -- so this lives in its own
 * describe block instead of the nm099999-gated suite above.
 */
describe("data.nemar.org catalog index (#584)", async () => {
  if (PROD_GUARD_ACTIVE) {
    test.skip("refusing to run against production without TEST_ALLOW_PROD=1", () => undefined);
    return;
  }

  // Reachability probe: GET / on the data sub-app. A healthy, deployed
  // catalog handler returns 200. Anything else means the route is not
  // yet on this backend (404 -- the common case for a PR that adds the
  // route before merge), D1 is unavailable (503), or the deployment is
  // broken (5xx). In every case the right move is to skip rather than
  // fail every assertion with a confusing message about an unrelated
  // status code.
  const probe = await fetch(`${API}/data/`, { headers, redirect: "manual" });
  if (probe.status !== 200) {
    test.skip(
      `catalog endpoint returned ${probe.status}; route not deployed on ${API} yet`,
      () => undefined,
    );
    return;
  }

  test("returns HTML with at least one nm dataset link", async () => {
    const r = await fetch(`${API}/data/`, {
      headers: { ...headers, Accept: "text/html" },
    });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/html");
    expect(r.headers.get("cache-control")).toContain("max-age=60");
    expect(r.headers.get("vary")).toContain("Accept");
    const body = await r.text();
    expect(body).toContain("data.nemar.org");
    expect(body).toMatch(/href="\/nm\d+\/"/);
    expect(body).not.toContain(">nm099999/<");
    expect(body).not.toMatch(/>xx\d+\//);
  });

  test("returns JSON via Accept: application/json with consistent shape", async () => {
    const r = await fetch(`${API}/data/`, {
      headers: { ...headers, Accept: "application/json" },
    });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("application/json");
    expect(r.headers.get("cache-control")).toContain("max-age=60");
    expect(r.headers.get("vary")).toContain("Accept");
    const body = (await r.json()) as {
      count: number;
      datasets: Array<{
        id: string;
        title: string | null;
        latest: string | null;
        doi: string | null;
        published: string | null;
        browse_url: string;
      }>;
    };
    expect(body.count).toBe(body.datasets.length);
    expect(body.datasets.length).toBeGreaterThan(0);
    for (const d of body.datasets) {
      expect(d.id).toMatch(/^nm\d+$/);
      expect(d.id).not.toBe("nm099999");
      expect(d.browse_url).toBe(`/${d.id}/`);
    }
  });

  test("?format=json overrides Accept: text/html", async () => {
    const r = await fetch(`${API}/data/?format=json`, {
      headers: { ...headers, Accept: "text/html" },
    });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("application/json");
  });

  // Regression for v0.8.28: `dataRoutes.get("/")` mounted at `/data`
  // only matches `/data` (no trailing slash) under Hono v4. The
  // `/data/` form requires the api-level alias and the data.nemar.org
  // dispatcher's root normalization. Cover both forms so a future
  // routing refactor can't quietly break the public canonical URL.
  test("both /data and /data/ return the catalog (trailing-slash regression)", async () => {
    const noSlash = await fetch(`${API}/data?format=json`, { headers });
    const trailing = await fetch(`${API}/data/?format=json`, { headers });
    expect(noSlash.status).toBe(200);
    expect(trailing.status).toBe(200);
    const a = (await noSlash.json()) as { count: number };
    const b = (await trailing.json()) as { count: number };
    expect(a.count).toBe(b.count);
  });
});
