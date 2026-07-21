/**
 * Tests for validateImportStateBody (epic #749, Phase 5 / #754): the sole
 * gatekeeper between an /webhooks/import-state POST body and a DB write. Pure
 * function, no mocks. Pins the status enum (kept in lockstep with
 * IMPORT_STATUSES) and the type guards, incl. the shards_total YAML/JSON
 * coercion footgun.
 */

import { describe, expect, test } from "bun:test";
import { validateImportStateBody } from "../src/routes/callbacks/import-state";

const valid = {
  dataset_id: "on000001",
  source: "openneuro",
  source_id: "ds000001",
  stage: "copy",
  status: "copying",
};

describe("validateImportStateBody", () => {
  test("accepts a minimal valid body", () => {
    expect(validateImportStateBody(valid)).toBeNull();
  });

  test("accepts all optional fields with correct types", () => {
    expect(
      validateImportStateBody({
        ...valid,
        error_message: "oops",
        workflow_run_url: "https://github.com/x/y/actions/runs/1",
        shards_total: 8,
      }),
    ).toBeNull();
  });

  test("accepts every IMPORT_STATUSES value", () => {
    for (const status of [
      "preparing",
      "copying",
      "finalizing",
      "complete",
      "failed",
      "quarantined",
      "rolled_back",
    ]) {
      expect(validateImportStateBody({ ...valid, status })).toBeNull();
    }
  });

  test("rejects null / non-object body", () => {
    expect(validateImportStateBody(null)).not.toBeNull();
    expect(validateImportStateBody("string")).not.toBeNull();
  });

  test("rejects missing or empty required strings", () => {
    for (const k of ["dataset_id", "source", "source_id", "stage"]) {
      expect(validateImportStateBody({ ...valid, [k]: "" })).not.toBeNull();
      expect(validateImportStateBody({ ...valid, [k]: undefined })).not.toBeNull();
    }
  });

  test("rejects a status not in IMPORT_STATUSES", () => {
    expect(validateImportStateBody({ ...valid, status: "unknown" })).not.toBeNull();
    expect(validateImportStateBody({ ...valid, status: "" })).not.toBeNull();
  });

  test("rejects shards_total that is a string (YAML coercion footgun) or a float", () => {
    expect(validateImportStateBody({ ...valid, shards_total: "8" })).not.toBeNull();
    expect(validateImportStateBody({ ...valid, shards_total: 1.5 })).not.toBeNull();
  });

  test("rejects wrong-typed optional fields", () => {
    expect(validateImportStateBody({ ...valid, error_message: 42 })).not.toBeNull();
    expect(validateImportStateBody({ ...valid, workflow_run_url: 7 })).not.toBeNull();
  });
});
