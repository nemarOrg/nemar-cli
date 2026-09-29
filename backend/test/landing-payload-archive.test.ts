/**
 * Tests for buildLandingPayload's archive field (#752). Pure function, no mocks.
 * Catches the page-bundle "archive omitted -> always null" class of bug and the
 * skipped/ready/size propagation the website relies on.
 */

import { describe, expect, test } from "bun:test";
import { buildLandingPayload } from "../src/services/data-router";
import { archiveForRequestedVersion } from "../src/services/page-bundle";

describe("buildLandingPayload archive", () => {
  test("archive defaults to all-null when the arg is omitted", () => {
    const p = buildLandingPayload({ datasetId: "nm000001", versionRows: [] });
    expect(p.archive).toEqual({ status: null, size: null, skip_reason: null });
  });

  test("skip_reason propagates; status stays null (the skipped representation)", () => {
    const p = buildLandingPayload({
      datasetId: "on005752",
      versionRows: [],
      archive: { skip_reason: "dataset 680.0 GiB exceeds 100.0 GiB archive limit" },
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

describe("archiveForRequestedVersion (#1518)", () => {
  test("returns the dataset's real archive field for the latest version", () => {
    const p = buildLandingPayload({
      datasetId: "nm000001",
      versionRows: [],
      archive: { status: "ready", size: 12345 },
    });
    expect(archiveForRequestedVersion(p, true)).toEqual({
      status: "ready",
      size: 12345,
      skip_reason: null,
    });
  });

  test("overrides to a no-archive note for a non-latest version, even if the dataset row says ready", () => {
    const p = buildLandingPayload({
      datasetId: "nm000001",
      versionRows: [
        { version: "1.1.0", doi: null, created_at: "2026-09-20 00:00:00" },
        { version: "1.0.0", doi: null, created_at: "2026-08-01 00:00:00" },
      ],
      // The dataset row's archive state always describes the LATEST build
      // (#752); a stale-but-"ready" value must not leak into an older
      // version's bundle.
      archive: { status: "ready", size: 999 },
    });
    const note = archiveForRequestedVersion(p, false);
    expect(note.status).toBeNull();
    expect(note.size).toBeNull();
    expect(note.skip_reason).toContain("v1.1.0");
    expect(note.skip_reason).toContain("download files directly");
  });

  // #1514 x #1518: the latest version's OWN archive can still be stale (a
  // new version just published, its own build not done yet) -- the two
  // rules are not redundant. archiveForRequestedVersion(payload, true) just
  // returns payload.archive unchanged, so this only proves the composition:
  // buildLandingPayload already nulled it out for staleness before
  // archiveForRequestedVersion ever sees it.
  test("a stale 'ready' archive is withheld even when the requested version IS the latest", () => {
    const oldVersion = { version: "1.0.1", doi: "d2", created_at: "2026-09-28 19:43:14" };
    const olderVersion = { version: "1.0.0", doi: "d1", created_at: "2026-01-01 00:00:00" };
    const p = buildLandingPayload({
      datasetId: "nm000284",
      versionRows: [oldVersion, olderVersion],
      archive: { status: "ready", size: 345_096_030_514, checked_at: "2026-09-28 17:58:40" },
    });
    expect(archiveForRequestedVersion(p, true)).toEqual({
      status: null,
      size: null,
      skip_reason: null,
    });
  });
});
