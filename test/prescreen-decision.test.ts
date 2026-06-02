/**
 * Unit tests for the pure pre-screen helpers (issue #666):
 *   - validatePrescreenCallbackBody: the callback body contract
 *   - decidePrescreenOutcome: claude verdict combined with the independent
 *     server-side S3 presence check
 *
 * Pure functions, no I/O, no mocks.
 */

import { describe, expect, test } from "bun:test";

import {
  decidePrescreenOutcome,
  validatePrescreenCallbackBody,
} from "../backend/src/routes/webhooks";

describe("validatePrescreenCallbackBody", () => {
  const ok = { dataset_id: "nm099999", request_id: 7, verdict: "pass" as const };

  test("accepts a minimal valid body", () => {
    expect(validatePrescreenCallbackBody(ok)).toBeNull();
  });

  test("accepts optional reasons + issue_url", () => {
    expect(
      validatePrescreenCallbackBody({
        ...ok,
        verdict: "block",
        reasons: ["no README"],
        issue_url: "https://github.com/nemarDatasets/nm099999/issues/1",
      }),
    ).toBeNull();
  });

  test("accepts verdict 'error' (workflow could not complete)", () => {
    expect(validatePrescreenCallbackBody({ ...ok, verdict: "error" })).toBeNull();
  });

  test("accepts request_id 0 and -1 (integer guard, not truthy guard)", () => {
    expect(validatePrescreenCallbackBody({ ...ok, request_id: 0 })).toBeNull();
    expect(validatePrescreenCallbackBody({ ...ok, request_id: -1 })).toBeNull();
  });

  test("rejects NaN / Infinity request_id", () => {
    expect(validatePrescreenCallbackBody({ ...ok, request_id: Number.NaN })).toMatch(/request_id/);
    expect(validatePrescreenCallbackBody({ ...ok, request_id: Number.POSITIVE_INFINITY })).toMatch(
      /request_id/,
    );
  });

  test("rejects non-object bodies", () => {
    expect(validatePrescreenCallbackBody(null)).toMatch(/JSON object/);
    expect(validatePrescreenCallbackBody("x")).toMatch(/JSON object/);
  });

  test("rejects missing / empty dataset_id", () => {
    expect(validatePrescreenCallbackBody({ ...ok, dataset_id: "" })).toMatch(/dataset_id/);
    expect(validatePrescreenCallbackBody({ request_id: 7, verdict: "pass" })).toMatch(/dataset_id/);
  });

  test("rejects a non-integer request_id", () => {
    expect(validatePrescreenCallbackBody({ ...ok, request_id: "7" })).toMatch(/request_id/);
    expect(validatePrescreenCallbackBody({ ...ok, request_id: 7.5 })).toMatch(/request_id/);
  });

  test("rejects a verdict outside pass|block", () => {
    expect(validatePrescreenCallbackBody({ ...ok, verdict: "maybe" })).toMatch(/verdict/);
  });

  test("rejects reasons that aren't a string array", () => {
    expect(validatePrescreenCallbackBody({ ...ok, reasons: "no README" })).toMatch(/reasons/);
    expect(validatePrescreenCallbackBody({ ...ok, reasons: [1, 2] })).toMatch(/reasons/);
  });

  test("rejects a non-string issue_url", () => {
    expect(validatePrescreenCallbackBody({ ...ok, issue_url: 5 })).toMatch(/issue_url/);
  });
});

describe("decidePrescreenOutcome", () => {
  test("verdict=block blocks regardless of S3", () => {
    const r = decidePrescreenOutcome("block", ["README empty"], { totalSize: 999, objectCount: 5 });
    expect(r.blocked).toBe(true);
    expect(r.reasons).toEqual(["README empty"]);
  });

  test("verdict=pass with real S3 data passes", () => {
    const r = decidePrescreenOutcome("pass", [], { totalSize: 1_000_000, objectCount: 42 });
    expect(r.blocked).toBe(false);
  });

  test("verdict=pass but empty S3 prefix -> blocked with appended reason", () => {
    const r = decidePrescreenOutcome("pass", [], { totalSize: 0, objectCount: 0 });
    expect(r.blocked).toBe(true);
    expect(r.reasons.length).toBe(1);
    expect(r.reasons[0]).toMatch(/storage/i);
  });

  test("does not double-add an S3 reason the workflow already supplied", () => {
    const r = decidePrescreenOutcome("block", ["No data files found in storage."], {
      totalSize: 0,
      objectCount: 0,
    });
    expect(r.blocked).toBe(true);
    expect(r.reasons).toEqual(["No data files found in storage."]);
  });

  test("objectCount=undefined (page cap hit = many objects) is NOT treated as missing", () => {
    const r = decidePrescreenOutcome("pass", [], { totalSize: 5_000_000, objectCount: undefined });
    expect(r.blocked).toBe(false);
  });

  test("null S3 (read error) never forces a block on a passing verdict", () => {
    const r = decidePrescreenOutcome("pass", [], null);
    expect(r.blocked).toBe(false);
    expect(r.reasons).toEqual([]);
  });

  test("verdict=block with null S3 stays blocked and preserves reasons", () => {
    const r = decidePrescreenOutcome("block", ["README missing"], null);
    expect(r.blocked).toBe(true);
    expect(r.reasons).toEqual(["README missing"]);
  });

  test("an 's3'-matching workflow reason is not duplicated by the empty-prefix check", () => {
    const r = decidePrescreenOutcome("block", ["S3 prefix is empty"], {
      totalSize: 0,
      objectCount: 0,
    });
    expect(r.blocked).toBe(true);
    expect(r.reasons).toEqual(["S3 prefix is empty"]);
  });
});
