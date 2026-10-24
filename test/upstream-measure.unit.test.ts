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
import { type SnapshotFile, summarizeSnapshotDelta } from "../shared/upstream-staleness";

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
