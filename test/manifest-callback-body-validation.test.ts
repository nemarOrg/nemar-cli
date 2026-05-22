/**
 * Unit tests for `validateManifestCallbackBody` (#557 Stream B).
 *
 * Exported pure function (no external deps) used by both
 * /webhooks/manifest-ready and /webhooks/manifest-failed to gate
 * malformed payloads before the HMAC lookup runs. Pin the contract here
 * so a future regression that, e.g., accepts an empty dataset_id or a
 * non-object body can't reach the D1 layer.
 *
 * Mirrors the test pattern used for `validateEnrichmentRef` and
 * `shouldSyncToNemarAfterVersionDoi`: real assertions, no mocks.
 */

import { describe, expect, test } from "bun:test";
import { validateManifestCallbackBody } from "../backend/src/routes/webhooks";

const VALID_READY_BODY = {
  dataset_id: "nm099999",
  version: "1.0.0",
  manifest_url: "https://nemar.s3.us-east-2.amazonaws.com/nm099999/version/v1.0.0.json",
  summary_url: "https://nemar.s3.us-east-2.amazonaws.com/nm099999/version/v1.0.0-summary.json",
  totals: { files: 100, bytes: 12345 },
  workflow_run_id: "98765",
};

const READY_FIELDS = [
  "dataset_id",
  "version",
  "manifest_url",
  "summary_url",
  "totals",
  "workflow_run_id",
] as const;

const FAILED_FIELDS = ["dataset_id", "version"] as const;

describe("validateManifestCallbackBody (manifest-ready)", () => {
  test("accepts a valid manifest-ready body (all required fields present)", () => {
    expect(validateManifestCallbackBody(VALID_READY_BODY, READY_FIELDS)).toBeNull();
  });

  test("rejects non-object body (null)", () => {
    expect(validateManifestCallbackBody(null, READY_FIELDS)).toBe("Body must be a JSON object");
  });

  test("rejects non-object body (string)", () => {
    expect(validateManifestCallbackBody("not an object", READY_FIELDS)).toBe(
      "Body must be a JSON object",
    );
  });

  test("rejects non-object body (number)", () => {
    expect(validateManifestCallbackBody(42, READY_FIELDS)).toBe("Body must be a JSON object");
  });

  test("rejects non-object body (array)", () => {
    // Arrays are typeof "object" but should not be treated as the
    // callback body shape; the dataset_id type check below catches it.
    const err = validateManifestCallbackBody([], READY_FIELDS);
    expect(err).not.toBeNull();
  });

  test("rejects missing dataset_id", () => {
    const { dataset_id: _, ...body } = VALID_READY_BODY;
    const err = validateManifestCallbackBody(body, READY_FIELDS);
    expect(err).toBe("Missing required field: dataset_id");
  });

  test("rejects empty dataset_id string", () => {
    const body = { ...VALID_READY_BODY, dataset_id: "" };
    const err = validateManifestCallbackBody(body, READY_FIELDS);
    // Empty string makes the field-presence check fail too via the
    // string-type guard. Either error message is acceptable; the test
    // pins that we reject.
    expect(err).not.toBeNull();
    expect(err).toContain("dataset_id");
  });

  test("rejects empty version string", () => {
    const body = { ...VALID_READY_BODY, version: "" };
    const err = validateManifestCallbackBody(body, READY_FIELDS);
    expect(err).not.toBeNull();
    expect(err).toContain("version");
  });

  test("rejects dataset_id of wrong type (number)", () => {
    const body = { ...VALID_READY_BODY, dataset_id: 12345 };
    const err = validateManifestCallbackBody(body, READY_FIELDS);
    expect(err).toBe("dataset_id must be a non-empty string");
  });

  test("rejects version of wrong type (object)", () => {
    const body = { ...VALID_READY_BODY, version: { major: 1 } };
    const err = validateManifestCallbackBody(body, READY_FIELDS);
    expect(err).toBe("version must be a non-empty string");
  });

  test("rejects missing manifest_url", () => {
    const { manifest_url: _, ...body } = VALID_READY_BODY;
    const err = validateManifestCallbackBody(body, READY_FIELDS);
    expect(err).toBe("Missing required field: manifest_url");
  });

  test("rejects missing summary_url", () => {
    const { summary_url: _, ...body } = VALID_READY_BODY;
    const err = validateManifestCallbackBody(body, READY_FIELDS);
    expect(err).toBe("Missing required field: summary_url");
  });

  test("rejects missing totals", () => {
    const { totals: _, ...body } = VALID_READY_BODY;
    const err = validateManifestCallbackBody(body, READY_FIELDS);
    expect(err).toBe("Missing required field: totals");
  });

  test("rejects missing workflow_run_id", () => {
    const { workflow_run_id: _, ...body } = VALID_READY_BODY;
    const err = validateManifestCallbackBody(body, READY_FIELDS);
    expect(err).toBe("Missing required field: workflow_run_id");
  });

  test("rejects field present but explicitly null", () => {
    const body = { ...VALID_READY_BODY, summary_url: null };
    const err = validateManifestCallbackBody(body, READY_FIELDS);
    expect(err).toBe("Missing required field: summary_url");
  });

  // Stream A fix round added `canary_skipped: boolean` to the callback
  // body. It's optional (older Stream A runs predate the field) and
  // must not cause the validator to reject otherwise-valid payloads.
  test("accepts body with canary_skipped: true", () => {
    const body = { ...VALID_READY_BODY, canary_skipped: true };
    expect(validateManifestCallbackBody(body, READY_FIELDS)).toBeNull();
  });

  test("accepts body with canary_skipped: false", () => {
    const body = { ...VALID_READY_BODY, canary_skipped: false };
    expect(validateManifestCallbackBody(body, READY_FIELDS)).toBeNull();
  });

  test("accepts body without canary_skipped (back-compat with older Stream A)", () => {
    // Already covered by the first test, but pin it explicitly: the
    // validator must not start REQUIRING canary_skipped now that it's
    // documented in the contract.
    expect("canary_skipped" in VALID_READY_BODY).toBe(false);
    expect(validateManifestCallbackBody(VALID_READY_BODY, READY_FIELDS)).toBeNull();
  });
});

describe("validateManifestCallbackBody (manifest-failed)", () => {
  test("accepts a minimal manifest-failed body (dataset_id + version only)", () => {
    const body = { dataset_id: "nm099999", version: "1.0.0" };
    expect(validateManifestCallbackBody(body, FAILED_FIELDS)).toBeNull();
  });

  test("accepts manifest-failed body with optional error_message + workflow_run_url", () => {
    const body = {
      dataset_id: "nm099999",
      version: "1.0.0",
      error_message: "build failed",
      workflow_run_url: "https://github.com/nemarOrg/nemar-cli/actions/runs/123",
    };
    expect(validateManifestCallbackBody(body, FAILED_FIELDS)).toBeNull();
  });

  test("rejects manifest-failed body missing version", () => {
    const body = { dataset_id: "nm099999" };
    const err = validateManifestCallbackBody(body, FAILED_FIELDS);
    expect(err).toBe("Missing required field: version");
  });

  test("rejects manifest-failed body missing dataset_id", () => {
    const body = { version: "1.0.0" };
    const err = validateManifestCallbackBody(body, FAILED_FIELDS);
    expect(err).toBe("Missing required field: dataset_id");
  });
});
