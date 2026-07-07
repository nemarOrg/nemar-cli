/**
 * Catalog latest_version canonicalization (epic #896, #899).
 *
 * The api.nemar.org catalog plane must emit latest_version in the canonical
 * vX.Y.Z tag form (matching the data plane + hallu-sync's archives/<v>.zip
 * URLs), regardless of whether the D1 row stored it bare or tagged.
 */

import { describe, expect, test } from "bun:test";
import { withCanonicalLatestVersion } from "../src/routes/datasets/catalog";

describe("withCanonicalLatestVersion", () => {
  test("coerces a bare version to the v-prefixed tag", () => {
    expect(withCanonicalLatestVersion({ latest_version: "1.0.0" }).latest_version).toBe("v1.0.0");
  });

  test("is idempotent on an already-tagged version", () => {
    expect(withCanonicalLatestVersion({ latest_version: "v1.2.3" }).latest_version).toBe("v1.2.3");
  });

  test("leaves null / empty / missing untouched", () => {
    expect(withCanonicalLatestVersion({ latest_version: null }).latest_version).toBeNull();
    expect(withCanonicalLatestVersion({ latest_version: "" }).latest_version).toBe("");
    expect(withCanonicalLatestVersion({ name: "x" }).latest_version).toBeUndefined();
  });

  test("preserves the other row fields", () => {
    const row = { dataset_id: "nm000108", name: "Test", latest_version: "2.0.0", file_size: 42 };
    const out = withCanonicalLatestVersion(row);
    expect(out).toEqual({ ...row, latest_version: "v2.0.0" });
  });
});
