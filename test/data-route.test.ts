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
    const r = await fetch(`${API}/data/${TEST_DATASET}`, { headers, redirect: "manual" });
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
    expect(body.extensions.nemar.versions[0].manifest_url).toBe(
      `/${TEST_DATASET}/v${body.extensions.nemar.versions[0].version.replace(/^v/, "")}/manifest.json`,
    );
  });

  test("metadata.json 404s for unknown datasets without leaking existence", async () => {
    const r = await fetch(`${API}/data/nm999000/metadata.json`, { headers });
    expect(r.status).toBe(404);
    const body = (await r.json()) as { error: string };
    expect(body.error).toBe("Dataset not found");
  });
});
