/**
 * Unit tests for the service-access upload gate (ADR 0010, #1013).
 * Pure decision logic shared by every real-upload entry point
 * (POST /datasets, /:id/upload-urls, /:id/upload-credentials).
 */

import { describe, expect, test } from "bun:test";
import {
  SANDBOX_TRAINING_ERROR,
  SERVICE_ACCESS_ERROR,
  realDatasetCreateGate,
  realDatasetServiceGate,
} from "../src/services/upload-gate";

describe("realDatasetCreateGate", () => {
  test("service access is checked first: no service access -> service-access error", () => {
    // Even with sandbox training done, no service access blocks first.
    expect(realDatasetCreateGate({ service_access: 0, sandbox_completed: 1 })).toBe(
      SERVICE_ACCESS_ERROR,
    );
    expect(realDatasetCreateGate({ service_access: 0, sandbox_completed: 0 })).toBe(
      SERVICE_ACCESS_ERROR,
    );
  });

  test("service access but no sandbox training -> sandbox-training error", () => {
    expect(realDatasetCreateGate({ service_access: 1, sandbox_completed: 0 })).toBe(
      SANDBOX_TRAINING_ERROR,
    );
  });

  test("both present -> allowed (null)", () => {
    expect(realDatasetCreateGate({ service_access: 1, sandbox_completed: 1 })).toBeNull();
  });
});

describe("realDatasetServiceGate", () => {
  test("no service access -> service-access error (a collaborator without service access)", () => {
    expect(realDatasetServiceGate({ service_access: 0 })).toBe(SERVICE_ACCESS_ERROR);
  });

  test("service access present -> allowed (null); sandbox training is not re-checked", () => {
    expect(realDatasetServiceGate({ service_access: 1 })).toBeNull();
  });
});
