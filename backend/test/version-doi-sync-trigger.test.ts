import { describe, expect, test } from "bun:test";
import { shouldSyncToNemarAfterVersionDoi } from "../src/routes/webhooks";

const CREDS = { nemarUsername: "user", nemarPassword: "pass" };
const DOI = "10.82901/NEMAR.nm000132/v1.0.0";

describe("shouldSyncToNemarAfterVersionDoi", () => {
  test("triggers for a normal nm dataset with DOI", () => {
    const result = shouldSyncToNemarAfterVersionDoi({
      datasetId: "nm000132",
      versionDoi: DOI,
      ...CREDS,
    });
    expect(result).toEqual({ trigger: true });
  });

  test("skips when credentials are missing", () => {
    const result = shouldSyncToNemarAfterVersionDoi({
      datasetId: "nm000132",
      versionDoi: DOI,
      nemarUsername: null,
      nemarPassword: null,
    });
    expect(result).toEqual({ trigger: false, reason: "no_credentials" });
  });

  test("skips when only username is missing", () => {
    const result = shouldSyncToNemarAfterVersionDoi({
      datasetId: "nm000132",
      versionDoi: DOI,
      nemarUsername: null,
      nemarPassword: "pass",
    });
    expect(result).toEqual({ trigger: false, reason: "no_credentials" });
  });

  test("skips OpenNeuro datasets (on-prefix)", () => {
    const result = shouldSyncToNemarAfterVersionDoi({
      datasetId: "on000001",
      versionDoi: DOI,
      ...CREDS,
    });
    expect(result).toEqual({ trigger: false, reason: "openneuro" });
  });

  test("skips sandbox datasets (xx-prefix)", () => {
    const result = shouldSyncToNemarAfterVersionDoi({
      datasetId: "xx000001",
      versionDoi: DOI,
      ...CREDS,
    });
    expect(result).toEqual({ trigger: false, reason: "sandbox" });
  });

  test("skips sandbox datasets regardless of credentials", () => {
    const result = shouldSyncToNemarAfterVersionDoi({
      datasetId: "xx999999",
      versionDoi: DOI,
      nemarUsername: "admin",
      nemarPassword: "secret",
    });
    expect(result).toEqual({ trigger: false, reason: "sandbox" });
  });

  test("skips when DOI is null", () => {
    const result = shouldSyncToNemarAfterVersionDoi({
      datasetId: "nm000132",
      versionDoi: null,
      ...CREDS,
    });
    expect(result).toEqual({ trigger: false, reason: "no_doi" });
  });

  test("skips when DOI is undefined", () => {
    const result = shouldSyncToNemarAfterVersionDoi({
      datasetId: "nm000132",
      versionDoi: undefined,
      ...CREDS,
    });
    expect(result).toEqual({ trigger: false, reason: "no_doi" });
  });

  test("skips when DOI is empty string", () => {
    const result = shouldSyncToNemarAfterVersionDoi({
      datasetId: "nm000132",
      versionDoi: "",
      ...CREDS,
    });
    expect(result).toEqual({ trigger: false, reason: "no_doi" });
  });

  test("credentials check takes priority over prefix checks", () => {
    // no_credentials is checked first, so a sandbox id with missing creds
    // returns no_credentials, not sandbox
    const result = shouldSyncToNemarAfterVersionDoi({
      datasetId: "xx000001",
      versionDoi: DOI,
      nemarUsername: null,
      nemarPassword: null,
    });
    expect(result).toEqual({ trigger: false, reason: "no_credentials" });
  });
});
