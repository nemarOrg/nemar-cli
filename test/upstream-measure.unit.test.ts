/**
 * The Phase 4c measurement, pure parts (epic #1046, #1910; ADR 0111, Phase 4c amendment):
 * `summarizeSnapshotDelta` over two REAL recorded OpenNeuro file listings, and
 * `estimateRepullDoiVolume` over the real recorded snapshot lists.
 *
 * The expected deltas are constants computed on 2026-10-24 by a separate script from the same
 * recorded files (`test/fixtures/openneuro-snapshot-files/provenance.json`); they are quoted
 * here, never recomputed by the code under test. Cases a real response cannot produce (a key
 * with no size anywhere, a directory entry, an unreadable date) are built from the recorded
 * shape and say so (testing.md, "when real data cannot falsify the rule").
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type MirrorFacts,
  type MirrorProbe,
  type SnapshotFile,
  UPSTREAM_STATES,
  type UpstreamRead,
  type UpstreamSnapshot,
  type UpstreamStatusRow,
  diffStaleMirrors,
  estimateRepullDoiVolume,
  summarizeSnapshotDelta,
  toWireRow,
} from "../shared/upstream-staleness";

const FILES = join(import.meta.dir, "fixtures/openneuro-snapshot-files");

function pair(name: string): { from: SnapshotFile[]; to: SnapshotFile[] } {
  const json = JSON.parse(readFileSync(join(FILES, name), "utf-8")) as {
    data: { a: { files: SnapshotFile[] }; b: { files: SnapshotFile[] } };
  };
  return { from: json.data.a.files, to: json.data.b.files };
}

describe("summarizeSnapshotDelta on recorded listings", () => {
  test("ds002893 1.0.0 -> 2.0.0 is data-changing, with the recorded counts and bytes", () => {
    const { from, to } = pair("snapshot-files-ds002893-1.0.0-2.0.0.response.json");
    expect(from.length).toBe(448);
    expect(to.length).toBe(400);
    expect(summarizeSnapshotDelta(from, to)).toEqual({
      added: 28,
      changed: 318,
      deleted: 76,
      annexed_added: 20,
      annexed_changed: 53,
      annexed_deleted: 6,
      data_changing: true,
      new_keys: 73,
      bytes_to_copy: 3431782003,
    });
  });

  test("ds003082 1.0.0 -> 1.0.1 is metadata-only: zero annexed, zero bytes (a real 0)", () => {
    const { from, to } = pair("snapshot-files-ds003082-1.0.0-1.0.1.response.json");
    expect(summarizeSnapshotDelta(from, to)).toEqual({
      added: 1,
      changed: 8,
      deleted: 0,
      annexed_added: 0,
      annexed_changed: 0,
      annexed_deleted: 0,
      data_changing: false,
      new_keys: 0,
      bytes_to_copy: 0,
    });
  });
});

describe("summarizeSnapshotDelta on built listings", () => {
  // Built from the recorded shape: OpenNeuro does not send a directory entry or a size-less
  // annexed key for these datasets today, and the rules for them must still hold.
  const file = (filename: string, id: string, over: Partial<SnapshotFile> = {}): SnapshotFile => ({
    filename,
    id,
    size: 10,
    annexed: false,
    directory: false,
    ...over,
  });

  test("changed means a different id: the same size with other content is changed", () => {
    const d = summarizeSnapshotDelta([file("a", "1", { size: 7 })], [file("a", "2", { size: 7 })]);
    expect(d.changed).toBe(1);
  });

  test("the same id with another size is not changed", () => {
    const d = summarizeSnapshotDelta([file("a", "1", { size: 7 })], [file("a", "1", { size: 9 })]);
    expect(d.changed).toBe(0);
  });

  test("directory entries are skipped on both sides", () => {
    const dir = file("sub-01", "d1", { directory: true });
    const d = summarizeSnapshotDelta(
      [dir],
      [file("sub-01", "d2", { directory: true }), file("x", "9")],
    );
    expect(d.added).toBe(1);
    expect(d.changed).toBe(0);
    expect(d.deleted).toBe(0);
  });

  test("a file moving from git to the annex counts as annexed changed, and its key is new", () => {
    const key = "SHA256E-s500--abc.bin";
    const d = summarizeSnapshotDelta(
      [file("a.bin", "gitsha")],
      [file("a.bin", key, { annexed: true, size: 500 })],
    );
    expect(d.annexed_changed).toBe(1);
    expect(d.data_changing).toBe(true);
    expect(d.new_keys).toBe(1);
    expect(d.bytes_to_copy).toBe(500);
  });

  test("a file moving from the annex to git counts as annexed changed too", () => {
    const d = summarizeSnapshotDelta(
      [file("a.bin", "SHA256E-s500--abc.bin", { annexed: true, size: 500 })],
      [file("a.bin", "gitsha")],
    );
    expect(d.annexed_changed).toBe(1);
    expect(d.data_changing).toBe(true);
    expect(d.new_keys).toBe(0);
  });

  test("an annexed deletion is data-changing but copies nothing", () => {
    const d = summarizeSnapshotDelta(
      [file("a.bin", "SHA256E-s500--abc.bin", { annexed: true })],
      [],
    );
    expect(d.deleted).toBe(1);
    expect(d.annexed_deleted).toBe(1);
    expect(d.data_changing).toBe(true);
    expect(d.new_keys).toBe(0);
    expect(d.bytes_to_copy).toBe(0);
  });

  test("a key already present under another name is not new", () => {
    const key = "SHA256E-s500--abc.bin";
    const d = summarizeSnapshotDelta(
      [file("old.bin", key, { annexed: true })],
      [file("renamed.bin", key, { annexed: true })],
    );
    expect(d.added).toBe(1);
    expect(d.deleted).toBe(1);
    expect(d.new_keys).toBe(0);
    expect(d.bytes_to_copy).toBe(0);
  });

  test("a key used by two files is one new key", () => {
    const key = "SHA256E-s500--abc.bin";
    const d = summarizeSnapshotDelta(
      [],
      [file("a.bin", key, { annexed: true }), file("b.bin", key, { annexed: true })],
    );
    expect(d.new_keys).toBe(1);
    expect(d.bytes_to_copy).toBe(500);
  });

  test("a new key with no declared size falls back to the listing's size", () => {
    const d = summarizeSnapshotDelta(
      [],
      [file("a.bin", "WORM-m17--a.bin", { annexed: true, size: 42 })],
    );
    expect(d.bytes_to_copy).toBe(42);
  });

  test("a new key with no size anywhere makes bytes_to_copy null, never 0", () => {
    const d = summarizeSnapshotDelta(
      [],
      [
        file("a.bin", "SHA256E-s500--abc.bin", { annexed: true }),
        file("b.bin", "WORM-m17--b.bin", { annexed: true, size: null }),
      ],
    );
    expect(d.new_keys).toBe(2);
    expect(d.bytes_to_copy).toBeNull();
  });
});

// ----------------------------------------------------------------------------
// DOI volume
// ----------------------------------------------------------------------------

describe("estimateRepullDoiVolume", () => {
  const FIXTURES = join(import.meta.dir, "../backend/test/fixtures/openneuro-graphql");
  const request = JSON.parse(
    readFileSync(join(FIXTURES, "graphql-upstream-snapshots.request.json"), "utf-8"),
  ) as { variables: Record<string, string> };
  const response = JSON.parse(
    readFileSync(join(FIXTURES, "graphql-upstream-snapshots.response.json"), "utf-8"),
  ) as {
    data: Record<
      string,
      null | { id: string; latestSnapshot: UpstreamSnapshot | null; snapshots: UpstreamSnapshot[] }
    >;
  };

  /** The rows the classifier produces from the recorded lists, each mirror recorded at `tags[ds]`. */
  function recordedRows(tags: Record<string, string>): UpstreamStatusRow[] {
    const upstream = new Map<string, UpstreamRead>();
    const mirrors: MirrorFacts[] = [];
    for (const [alias, ds] of Object.entries(request.variables)) {
      const node = response.data[alias];
      if (!node) continue;
      upstream.set(ds, {
        kind: "snapshot",
        latest: node.latestSnapshot,
        snapshots: node.snapshots,
      });
      mirrors.push({
        datasetId: `on${ds.slice(2)}`,
        sourceId: ds,
        visibility: "public",
        importStatus: "complete",
        blocklisted: false,
        blocklistReason: null,
        versions: [
          {
            version: "1.0.0",
            source_version: tags[ds] ?? null,
            source_version_basis: "doi",
            created_at: "2025-01-01 00:00:00",
          },
        ],
      });
    }
    const ready = new Map<string, MirrorProbe>(
      [...upstream.keys()].map((ds) => [ds, { kind: "ready" }]),
    );
    return diffStaleMirrors(mirrors, upstream, ready).map(toWireRow);
  }

  const RECORDED_AT: Record<string, string> = {
    ds003645: "2.0.2",
    ds004362: "1.0.0",
    ds000001: "00006",
    ds002893: "2.0.0",
    ds003082: "1.0.1",
  };

  test("the trailing year at the recording: ds003645 2.1.0 and ds004362 1.0.1", () => {
    const rows = recordedRows(RECORDED_AT);
    const v = estimateRepullDoiVolume(rows, Date.parse("2026-10-24T12:00:00Z"));
    expect(v.mirrors_counted).toBe(5);
    expect(v.catch_up).toBe(3);
    expect(v.per_snapshot).toBe(2);
    expect(v.at_most_every_30_days).toBe(2);
    expect(v.busiest_day).toBe(1);
    expect(v.upper_bound_with_patches).toEqual({
      catch_up: 6,
      per_snapshot: 4,
      at_most_every_30_days: 4,
    });
    expect(v.snapshots_with_unreadable_dates).toBe(0);
  });

  test("two snapshots on one day count twice per snapshot and once under the gap (real data)", () => {
    // ds003645's 2.0.1 and 2.0.2 were both created on 2023-04-14.
    const rows = recordedRows(RECORDED_AT);
    const v = estimateRepullDoiVolume(rows, Date.parse("2024-01-01T00:00:00Z"));
    expect(v.per_snapshot).toBe(2);
    expect(v.at_most_every_30_days).toBe(1);
    expect(v.busiest_day).toBe(2);
    const noGap = estimateRepullDoiVolume(rows, Date.parse("2024-01-01T00:00:00Z"), {
      minGapDays: 0,
    });
    expect(noGap.at_most_every_30_days).toBe(2);
  });

  test("the window is half open: a snapshot at the edge is out, at now is in", () => {
    const now = Date.parse("2026-10-24T04:10:36.000Z");
    // ds003645 2.1.0 was created at exactly `now`: in. Its 2.0.2 is long before the window.
    expect(estimateRepullDoiVolume(recordedRows(RECORDED_AT), now).per_snapshot).toBe(2);
    expect(estimateRepullDoiVolume(recordedRows(RECORDED_AT), now - 1).per_snapshot).toBe(1);
    // ds004362 1.0.1 as the window's lower edge: created exactly windowDays before now is out.
    const created = Date.parse(response.data.a1?.snapshots[1]?.created as string);
    const only = recordedRows({ ds004362: "1.0.0" }).filter((r) => r.ds === "ds004362");
    expect(
      estimateRepullDoiVolume(only, created + 30 * 86_400_000, { windowDays: 30 }),
    ).toMatchObject({
      per_snapshot: 0,
    });
    expect(
      estimateRepullDoiVolume(only, created + 30 * 86_400_000 - 1, { windowDays: 30 }),
    ).toMatchObject({ per_snapshot: 1 });
  });

  test("a dataset's first snapshot is the import, not a re-pull", () => {
    // ds003082's first snapshot (2020) is inside a 10-year window; only its 1.0.1 counts.
    const rows = recordedRows({ ds003082: "1.0.1" }).filter((r) => r.ds === "ds003082");
    const v = estimateRepullDoiVolume(rows, Date.parse("2026-10-24T12:00:00Z"), {
      windowDays: 3650,
    });
    expect(v.per_snapshot).toBe(1);
  });

  test("rows without a known tag are excluded and counted by state, never dropped", () => {
    const rows = recordedRows({ ds003645: "2.0.2" });
    const v = estimateRepullDoiVolume(rows, Date.parse("2026-10-24T12:00:00Z"));
    expect(v.mirrors_counted).toBe(1);
    const total = Object.values(v.excluded).reduce((a, b) => a + b, 0);
    expect(total).toBe(rows.length - 1);
    expect(Object.keys(v.excluded).sort()).toEqual([...UPSTREAM_STATES].sort());
  });

  test("an unparsable date is counted, not read as old and not dropped silently", () => {
    // Built: OpenNeuro does not send an unparsable `created` today.
    const row = (created: string | null): UpstreamStatusRow => ({
      dataset_id: "on000009",
      ds: "ds000009",
      visibility: "public",
      state: "current",
      anomaly: null,
      reason: "x",
      recorded: { version: "1.0.0", tag: "1.0.1", basis: "doi" },
      upstream: {
        latest_tag: "1.0.1",
        latest_created: null,
        snapshots: [
          { tag: "1.0.0", created: "2025-01-01T00:00:00Z" },
          { tag: "1.0.1", created },
        ],
      },
      import_status: "complete",
      probably_stale: null,
    });
    const now = Date.parse("2026-01-01T00:00:00Z");
    const bad = estimateRepullDoiVolume([row("not a date")], now);
    expect(bad.snapshots_with_unreadable_dates).toBe(1);
    expect(bad.per_snapshot).toBe(0);
    expect(estimateRepullDoiVolume([row(null)], now).snapshots_with_unreadable_dates).toBe(1);
    expect(estimateRepullDoiVolume([row("2025-06-01T00:00:00Z")], now).per_snapshot).toBe(1);
  });

  test("snapshots exactly the gap apart are both counted; one day less is one", () => {
    // Built: the boundary of the gap rule (real data has no pair exactly 30 days apart).
    const row = (second: string): UpstreamStatusRow => ({
      dataset_id: "on000009",
      ds: "ds000009",
      visibility: "public",
      state: "current",
      anomaly: null,
      reason: "x",
      recorded: { version: "1.0.0", tag: "1.0.2", basis: "doi" },
      upstream: {
        latest_tag: "1.0.2",
        latest_created: second,
        snapshots: [
          { tag: "1.0.0", created: "2025-01-01T00:00:00Z" },
          { tag: "1.0.1", created: "2025-03-01T00:00:00Z" },
          { tag: "1.0.2", created: second },
        ],
      },
      import_status: "complete",
      probably_stale: null,
    });
    const now = Date.parse("2026-01-01T00:00:00Z");
    expect(estimateRepullDoiVolume([row("2025-03-31T00:00:00Z")], now).at_most_every_30_days).toBe(
      2,
    );
    expect(estimateRepullDoiVolume([row("2025-03-30T00:00:00Z")], now).at_most_every_30_days).toBe(
      1,
    );
  });

  test("an empty fleet is zeros with every excluded key present", () => {
    const v = estimateRepullDoiVolume([], Date.now());
    expect(v.mirrors_counted).toBe(0);
    expect(v.busiest_day).toBe(0);
    expect(Object.keys(v.excluded).length).toBe(UPSTREAM_STATES.length);
  });
});
