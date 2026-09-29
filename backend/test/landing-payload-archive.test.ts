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

describe("buildLandingPayload archive staleness (#1514)", () => {
  // The nm000284 shape: v1.0.0's zip was marked ready, then v1.0.1 published.
  const oldVersion = { version: "1.0.1", doi: "d2", created_at: "2026-09-28 19:43:14" };
  const olderVersion = { version: "1.0.0", doi: "d1", created_at: "2026-01-01 00:00:00" };

  test("a 'ready' archive checked BEFORE the latest version was created is hidden", () => {
    const p = buildLandingPayload({
      datasetId: "nm000284",
      versionRows: [oldVersion, olderVersion], // newest first, per PUBLIC_DATASET_VERSIONS_SQL
      archive: { status: "ready", size: 345_096_030_514, checked_at: "2026-09-28 17:58:40" },
    });
    expect(p.archive).toEqual({ status: null, size: null, skip_reason: null });
  });

  test("a 'ready' archive checked AFTER the latest version was created is advertised", () => {
    const p = buildLandingPayload({
      datasetId: "nm000284",
      versionRows: [oldVersion, olderVersion],
      archive: { status: "ready", size: 999, checked_at: "2026-09-28 20:00:00" },
    });
    expect(p.archive).toEqual({ status: "ready", size: 999, skip_reason: null });
  });

  test("a single-version dataset's 'ready' archive (checked after publish) is unaffected", () => {
    const p = buildLandingPayload({
      datasetId: "nm000001",
      versionRows: [olderVersion], // created_at 2026-01-01
      archive: { status: "ready", size: 42, checked_at: "2026-06-01 00:00:00" },
    });
    expect(p.archive.status).toBe("ready");
  });

  test("no checked_at on record (legacy row) trusts the status rather than hiding it", () => {
    const p = buildLandingPayload({
      datasetId: "nm000284",
      versionRows: [oldVersion, olderVersion],
      archive: { status: "ready", size: 999 },
    });
    expect(p.archive.status).toBe("ready");
  });

  test("staleness never touches a 'failed' status or a skip_reason", () => {
    const failed = buildLandingPayload({
      datasetId: "nm000284",
      versionRows: [oldVersion, olderVersion],
      archive: { status: "failed", checked_at: "2020-01-01 00:00:00" },
    });
    expect(failed.archive.status).toBe("failed");

    const skipped = buildLandingPayload({
      datasetId: "nm000284",
      versionRows: [oldVersion, olderVersion],
      archive: { skip_reason: "too big", checked_at: "2020-01-01 00:00:00" },
    });
    expect(skipped.archive.skip_reason).toBe("too big");
    expect(skipped.archive.status).toBeNull();
  });
});
