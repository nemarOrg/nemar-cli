import { describe, expect, test } from "bun:test";
import type { VersionManifest } from "../src/lib/api";
import { diffManifests } from "../src/lib/manifest-diff";

function manifest(version: string, files: Record<string, string>): VersionManifest {
  return {
    dataset_id: "nm000999",
    version,
    doi: null,
    concept_doi: null,
    created: "2026-01-01T00:00:00Z",
    files: Object.fromEntries(
      Object.entries(files).map(([path, key]) => [path, { key, size: 0, checksum: key }]),
    ),
  };
}

describe("diffManifests", () => {
  test("identical manifests yield empty diff", () => {
    const a = manifest("1.0.0", { "a.edf": "K-A", "b.edf": "K-B" });
    const b = manifest("1.0.0", { "a.edf": "K-A", "b.edf": "K-B" });
    expect(diffManifests(a, b)).toEqual({ added: [], changed: [], removed: [] });
  });

  test("added paths are reported only in `added`", () => {
    const a = manifest("1.0.0", { "a.edf": "K-A" });
    const b = manifest("1.0.1", { "a.edf": "K-A", "new.edf": "K-NEW" });
    const d = diffManifests(a, b);
    expect(d.added).toEqual(["new.edf"]);
    expect(d.changed).toEqual([]);
    expect(d.removed).toEqual([]);
  });

  test("changed annex keys for the same path land in `changed`", () => {
    const a = manifest("1.0.0", { "a.edf": "K-OLD" });
    const b = manifest("1.0.1", { "a.edf": "K-NEW" });
    const d = diffManifests(a, b);
    expect(d.changed).toEqual(["a.edf"]);
    expect(d.added).toEqual([]);
    expect(d.removed).toEqual([]);
  });

  test("removed paths land in `removed`", () => {
    const a = manifest("1.0.0", { "a.edf": "K-A", "old.edf": "K-OLD" });
    const b = manifest("1.0.1", { "a.edf": "K-A" });
    const d = diffManifests(a, b);
    expect(d.removed).toEqual(["old.edf"]);
    expect(d.added).toEqual([]);
    expect(d.changed).toEqual([]);
  });

  test("results are sorted alphabetically", () => {
    const a = manifest("1.0.0", { "z.edf": "K-Z", "m.edf": "K-M" });
    const b = manifest("1.0.1", {
      "z.edf": "K-Z",
      "m.edf": "K-M2",
      "b.edf": "K-B",
      "a.edf": "K-A",
    });
    const d = diffManifests(a, b);
    expect(d.added).toEqual(["a.edf", "b.edf"]);
    expect(d.changed).toEqual(["m.edf"]);
  });

  test("handles missing files map gracefully", () => {
    const a = { ...manifest("1.0.0", {}), files: undefined as unknown as Record<string, never> };
    const b = manifest("1.0.1", { "a.edf": "K-A" });
    const d = diffManifests(a, b);
    expect(d.added).toEqual(["a.edf"]);
    expect(d.changed).toEqual([]);
    expect(d.removed).toEqual([]);
  });
});
