/**
 * Issue #339: nemar.org sync trigger after version-DOI publication.
 *
 * Both the EZID and Zenodo version-DOI webhook paths gate the
 * background sync through `shouldSyncToNemarAfterVersionDoi`. The
 * effectful waitUntil call still requires a live Worker runtime, but
 * the gating predicate itself is pure — these tests pin the rules so
 * a regression that, say, accidentally skipped the Zenodo path (the
 * exact bug #339 fixes) would fail here.
 */

import { describe, expect, test } from "bun:test";
import { shouldSyncToNemarAfterVersionDoi } from "../backend/src/routes/webhooks";

describe("shouldSyncToNemarAfterVersionDoi", () => {
  const baseCreds = { nemarUsername: "nemar", nemarPassword: "pw" };

  test("triggers for a standard nm dataset with credentials and a DOI", () => {
    const decision = shouldSyncToNemarAfterVersionDoi({
      datasetId: "nm000132",
      versionDoi: "10.82901/NEMAR.nm000132.v1.0.0",
      ...baseCreds,
    });
    expect(decision.trigger).toBe(true);
  });

  test("skips when NEMAR_USERNAME is missing", () => {
    const decision = shouldSyncToNemarAfterVersionDoi({
      datasetId: "nm000132",
      versionDoi: "10.82901/NEMAR.nm000132.v1.0.0",
      nemarUsername: "",
      nemarPassword: "pw",
    });
    expect(decision.trigger).toBe(false);
    if (!decision.trigger) expect(decision.reason).toBe("no_credentials");
  });

  test("skips when NEMAR_PASSWORD is missing", () => {
    const decision = shouldSyncToNemarAfterVersionDoi({
      datasetId: "nm000132",
      versionDoi: "10.82901/NEMAR.nm000132.v1.0.0",
      nemarUsername: "nemar",
      nemarPassword: null,
    });
    expect(decision.trigger).toBe(false);
    if (!decision.trigger) expect(decision.reason).toBe("no_credentials");
  });

  test("skips OpenNeuro datasets (on-prefix)", () => {
    const decision = shouldSyncToNemarAfterVersionDoi({
      datasetId: "on000123",
      versionDoi: "10.18112/openneuro.on000123.v1.0.0",
      ...baseCreds,
    });
    expect(decision.trigger).toBe(false);
    if (!decision.trigger) expect(decision.reason).toBe("openneuro");
  });

  test("skips when versionDoi is null (Zenodo failure to mint)", () => {
    const decision = shouldSyncToNemarAfterVersionDoi({
      datasetId: "nm000132",
      versionDoi: null,
      ...baseCreds,
    });
    expect(decision.trigger).toBe(false);
    if (!decision.trigger) expect(decision.reason).toBe("no_doi");
  });

  test("skips when versionDoi is an empty string", () => {
    const decision = shouldSyncToNemarAfterVersionDoi({
      datasetId: "nm000132",
      versionDoi: "",
      ...baseCreds,
    });
    expect(decision.trigger).toBe(false);
    if (!decision.trigger) expect(decision.reason).toBe("no_doi");
  });

  test("credentials check runs before on-prefix check", () => {
    // Missing credentials wins so we don't accidentally claim a skip is
    // about provenance when it's really a config gap.
    const decision = shouldSyncToNemarAfterVersionDoi({
      datasetId: "on000123",
      versionDoi: null,
      nemarUsername: null,
      nemarPassword: null,
    });
    expect(decision.trigger).toBe(false);
    if (!decision.trigger) expect(decision.reason).toBe("no_credentials");
  });
});
