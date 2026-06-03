/**
 * Tests for the Cloudflare cache-purge helper used by /webhooks/zarr-ready
 * (epic #684 / Stream C #685).
 *
 * `zarrPurgeTargets` is pure (URL construction) and `purgeCacheUrls` is tested
 * only on its no-network branches: the unconfigured no-op and empty/invalid
 * input. The actual purge_cache HTTP call is NOT mocked (repo no-mock policy);
 * it is exercised against a real zone in the deploy runbook, not unit tests.
 */

import { describe, expect, test } from "bun:test";
import "./setup";
import { purgeCacheUrls, zarrPurgeTargets } from "../backend/src/services/cloudflare";
import type { Bindings } from "../backend/src/types/bindings";

function env(overrides: Partial<Bindings> = {}): Bindings {
  // Only the fields the helper reads matter; cast the partial to Bindings so the
  // test doesn't have to construct the full ~40-field environment.
  return overrides as Bindings;
}

describe("zarrPurgeTargets", () => {
  test("returns index.json + each changed store's zarr.json", () => {
    const targets = zarrPurgeTargets(
      env({ ZARR_CACHE_BASE_URL: "https://zarr.nemar.org" }),
      "nm000104",
      ["sub-01/eeg/sub-01_task-rest_eeg.zarr", "sub-02/emg/sub-02_task-x_emg.zarr"],
    );
    expect(targets).toEqual([
      "https://zarr.nemar.org/nm000104/zarr/index.json",
      "https://zarr.nemar.org/nm000104/zarr/sub-01/eeg/sub-01_task-rest_eeg.zarr/zarr.json",
      "https://zarr.nemar.org/nm000104/zarr/sub-02/emg/sub-02_task-x_emg.zarr/zarr.json",
    ]);
  });

  test("strips a trailing slash from the base url", () => {
    const targets = zarrPurgeTargets(
      env({ ZARR_CACHE_BASE_URL: "https://zarr.nemar.org/" }),
      "nm000104",
      [],
    );
    expect(targets).toEqual(["https://zarr.nemar.org/nm000104/zarr/index.json"]);
  });

  test("returns [] when the cache host is unset", () => {
    expect(zarrPurgeTargets(env({}), "nm000104", ["sub-01/eeg/x_eeg.zarr"])).toEqual([]);
  });

  test("ignores empty store paths", () => {
    const targets = zarrPurgeTargets(
      env({ ZARR_CACHE_BASE_URL: "https://zarr.nemar.org" }),
      "nm000104",
      ["", "  "],
    );
    expect(targets).toEqual(["https://zarr.nemar.org/nm000104/zarr/index.json"]);
  });
});

describe("purgeCacheUrls", () => {
  test("no-ops (ok) with an empty list", async () => {
    const r = await purgeCacheUrls(env({}), []);
    expect(r.ok).toBe(true);
    expect(r.submitted).toBe(0);
  });

  test("no-ops (ok) when CLOUDFLARE_* secrets are unset", async () => {
    const r = await purgeCacheUrls(env({}), ["https://zarr.nemar.org/nm000104/zarr/index.json"]);
    expect(r.ok).toBe(true);
    expect(r.submitted).toBe(0);
    expect(r.detail).toContain("skipped");
  });

  test("filters non-http entries before counting work", async () => {
    // Unconfigured -> still a no-op, but the filter runs first; an all-invalid
    // list collapses to the empty-input fast path.
    const r = await purgeCacheUrls(env({}), ["", "ftp://x/y", "not a url"]);
    expect(r.ok).toBe(true);
    expect(r.submitted).toBe(0);
  });
});
