/**
 * Tests for buildLandingPayload's archive field (#752). Pure function, no mocks.
 * Catches the page-bundle "archive omitted -> always null" class of bug and the
 * skipped/ready/size propagation the website relies on.
 */

import { describe, expect, test } from "bun:test";
import { buildLandingPayload } from "../src/services/data-router";

describe("buildLandingPayload archive", () => {
  test("archive defaults to all-null when the arg is omitted", () => {
    const p = buildLandingPayload({ datasetId: "nm000001", versionRows: [] });
    expect(p.archive).toEqual({ status: null, size: null, skip_reason: null });
  });

  test("skip_reason propagates; status stays null (the skipped representation)", () => {
    const p = buildLandingPayload({
      datasetId: "on005752",
      versionRows: [],
      archive: { skip_reason: "dataset 680.0 GB exceeds 100.0 GB archive limit" },
    });
    expect(p.archive.skip_reason).toContain("exceeds");
    expect(p.archive.status).toBeNull();
    expect(p.archive.size).toBeNull();
  });

  test("ready status + size propagate; skip_reason null", () => {
    const p = buildLandingPayload({
      datasetId: "nm000001",
      versionRows: [],
      archive: { status: "ready", size: 12345 },
    });
    expect(p.archive).toEqual({ status: "ready", size: 12345, skip_reason: null });
  });
});
