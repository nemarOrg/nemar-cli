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
  type SnapshotDelta,
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

import { type DeltaMeasurement, renderMeasurement, totalsOf } from "../src/lib/upstream-measure";

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

  test("a key's name is not read as its size: the strict field wins over the listing", () => {
    // The documented exception in annexKeyDeclaredSize: `WORM-s5-m17--a-s9--b` reads as 9 there.
    // The field parser reads 5; the listing's 1000 is only a fallback for a key with no size.
    const d = summarizeSnapshotDelta(
      [],
      [file("a.bin", "WORM-s5-m17--a-s9--b", { annexed: true, size: 1000 })],
    );
    expect(d.bytes_to_copy).toBe(5);
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
    const now = Date.parse("2025-12-31T00:00:00Z");
    const bad = estimateRepullDoiVolume([row("not a date")], now);
    expect(bad.snapshots_with_unreadable_dates).toBe(1);
    // The unreadable date could be the earliest, so the import cannot be identified and the
    // readable first snapshot is counted: the estimate errs high, never low.
    expect(bad.per_snapshot).toBe(1);
    expect(estimateRepullDoiVolume([row(null)], now).snapshots_with_unreadable_dates).toBe(1);
    expect(estimateRepullDoiVolume([row("2025-06-01T00:00:00Z")], now).per_snapshot).toBe(1);
  });

  test("the import is the earliest by date, wherever the list puts it", () => {
    // Built: upstream lists in creation order today; the rule must not rely on list position.
    const mk = (snapshots: { tag: string; created: string | null }[]): UpstreamStatusRow => ({
      dataset_id: "on000009",
      ds: "ds000009",
      visibility: "public",
      state: "current",
      anomaly: null,
      reason: "x",
      recorded: { version: "1.0.0", tag: "1.0.1", basis: "doi" },
      upstream: { latest_tag: "1.0.1", latest_created: null, snapshots },
      import_status: "complete",
      probably_stale: null,
    });
    const now = Date.parse("2025-12-31T00:00:00Z");
    const reversed = mk([
      { tag: "1.0.1", created: "2025-06-01T00:00:00Z" },
      { tag: "1.0.0", created: "2020-01-01T00:00:00Z" },
    ]);
    expect(estimateRepullDoiVolume([reversed], now).per_snapshot).toBe(1);
    // An unreadable date anywhere means the earliest cannot be named: nothing is excluded.
    const unreadableLater = mk([
      { tag: "1.0.0", created: "2025-01-01T00:00:00Z" },
      { tag: "1.0.1", created: "2025-06-01T00:00:00Z" },
      { tag: "1.0.2", created: "garbage" },
    ]);
    const v = estimateRepullDoiVolume([unreadableLater], now);
    expect(v.per_snapshot).toBe(2);
    expect(v.snapshots_with_unreadable_dates).toBe(1);
  });

  test("a snapshot dated after now is counted as future-dated, not dropped", () => {
    // Built: OpenNeuro does not send a future creation date today.
    const row: UpstreamStatusRow = {
      dataset_id: "on000009",
      ds: "ds000009",
      visibility: "public",
      state: "current",
      anomaly: null,
      reason: "x",
      recorded: { version: "1.0.0", tag: "1.0.1", basis: "doi" },
      upstream: {
        latest_tag: "1.0.2",
        latest_created: null,
        snapshots: [
          { tag: "1.0.0", created: "2025-01-01T00:00:00Z" },
          { tag: "1.0.1", created: "2025-06-01T00:00:00Z" },
          { tag: "1.0.2", created: "2027-01-01T00:00:00Z" },
        ],
      },
      import_status: "complete",
      probably_stale: null,
    };
    const v = estimateRepullDoiVolume([row], Date.parse("2026-01-01T00:00:00Z"));
    expect(v.per_snapshot).toBe(1);
    expect(v.snapshots_dated_in_the_future).toBe(1);
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

// ----------------------------------------------------------------------------
// Totals and the rendering of unknowns
// ----------------------------------------------------------------------------

describe("totalsOf and renderMeasurement", () => {
  // Built: deltas as `summarizeSnapshotDelta` returns them, for the combinations a handful of
  // recorded datasets cannot reach (a new key with no known size; an odd catch-up count).
  const delta = (over: Partial<SnapshotDelta> = {}): SnapshotDelta => ({
    added: 1,
    changed: 2,
    deleted: 3,
    annexed_added: 0,
    annexed_changed: 0,
    annexed_deleted: 0,
    data_changing: false,
    new_keys: 0,
    bytes_to_copy: 0,
    ...over,
  });
  const measured = (id: string, d: SnapshotDelta | null): DeltaMeasurement => ({
    dataset_id: id,
    ds: `ds${id.slice(2)}`,
    from_tag: "1.0.0",
    to_tag: "1.0.1",
    delta: d,
    reason: d === null ? "OpenNeuro GraphQL answered HTTP 503" : null,
  });

  test("the catch-up takes whole days: three re-pulls at a cap of two are two days", () => {
    const t = totalsOf([measured("on000001", delta()), measured("on000002", delta())], 3, 3);
    expect(t.catch_up_days).toBe(2);
    expect(t.not_measured).toBe(1);
    expect(t.bytes_to_copy).toBeNull();
  });

  test("a measured delta whose new key has no size makes the total null, not the known sum", () => {
    const t = totalsOf(
      [
        measured("on000001", delta({ data_changing: true, new_keys: 1, bytes_to_copy: null })),
        measured("on000002", delta({ data_changing: true, new_keys: 1, bytes_to_copy: 500 })),
      ],
      2,
      2,
    );
    expect(t.bytes_to_copy).toBeNull();
    expect(t.bytes_to_copy_known).toBe(500);
    expect(t.measured).toBe(2);
    expect(t.delta_unknown).toBe(0);
  });

  test("an unknown delta contributes nothing to the file counts and is counted", () => {
    const t = totalsOf([measured("on000001", delta()), measured("on000002", null)], 2, 2);
    expect(t.delta_unknown).toBe(1);
    expect(t.measured).toBe(1);
    expect([t.files_added, t.files_changed, t.files_deleted]).toEqual([1, 2, 3]);
  });

  test("a size just under a unit boundary is promoted, not printed as 1024.0 KiB", () => {
    const deltas = [measured("on000001", delta({ data_changing: true, bytes_to_copy: 1048575 }))];
    const lines = renderMeasurement(
      {
        measured_at: "2026-10-24T12:00:00.000Z",
        endpoint: "x",
        scope: "fleet",
        complete: true,
        deltas,
        totals: totalsOf(deltas, 1, 1),
        doi_volume: estimateRepullDoiVolume([], Date.now()),
      },
      10,
    ).join("\n");
    expect(lines).toContain("Bytes to copy: 1048575 (1.0 MiB)");
    expect(lines).not.toContain("1024.0 KiB");
  });

  test("the human block never prints an unknown as a number", () => {
    const deltas = [
      measured("on000001", delta({ bytes_to_copy: null })),
      measured("on000002", null),
    ];
    const volume = estimateRepullDoiVolume([], Date.now());
    const lines = renderMeasurement(
      {
        measured_at: "2026-10-24T12:00:00.000Z",
        endpoint: "x",
        scope: "fleet",
        complete: false,
        deltas,
        totals: totalsOf(deltas, 2, 2),
        doi_volume: volume,
      },
      10,
    ).join("\n");
    expect(lines).toContain("Bytes to copy: unknown; at least 0 (0 B)");
    expect(lines).toContain("size unknown");
    expect(lines).toContain("delta unknown: OpenNeuro GraphQL answered HTTP 503");
    expect(lines).toContain("at least: not every delta was read");
  });
});
