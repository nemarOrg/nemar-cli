/**
 * Unit test for the `dataset_id` ⇄ `source_id` correspondence enforced on
 * OpenNeuro import (#1030).
 *
 * Why this is worth pinning: nemarOrg/website#190 rewrites legacy citation
 * URLs (`/dataexplorer/detail?dataset_id=ds007964` → `/dataset/on007964`) on
 * the strength of this contract, and that target is also where the DOI
 * `10.82901/nemar.on007964` resolves. A violating row therefore does not
 * produce a 404 — it routes a *cited* URL to the *wrong dataset*, with
 * nothing to surface it.
 */

import { describe, expect, test } from "bun:test";
import { isValidSourceIdForDataset } from "../src/routes/admin/imports";

describe("openneuro id correspondence", () => {
  test("accepts a digit-for-digit match", () => {
    expect(isValidSourceIdForDataset("openneuro", "on007964", "ds007964")).toBe(true);
    expect(isValidSourceIdForDataset("openneuro", "on000001", "ds000001")).toBe(true);
  });

  // The case the whole rule exists to stop: two individually well-formed ids
  // that don't belong together.
  test("rejects a mismatch between otherwise valid ids", () => {
    expect(isValidSourceIdForDataset("openneuro", "on999999", "ds000001")).toBe(false);
    expect(isValidSourceIdForDataset("openneuro", "on007964", "ds007965")).toBe(false);
  });

  test("rejects an upstream id that isn't a ds###### at all", () => {
    for (const sourceId of ["007964", "ds7964", "ds0079640", "on007964", "", "ds00796a"]) {
      expect(isValidSourceIdForDataset("openneuro", "on007964", sourceId)).toBe(false);
    }
  });
});

describe("unregistered sources fail closed", () => {
  // `nm######` datasets are NEMAR-native uploads with source and source_id
  // both NULL — they have nothing to correspond to and never reach the import
  // endpoint. More prefixes are expected, and there is no reason to assume a
  // future archive shares OpenNeuro's digit-preserving shape. So an
  // unregistered source is rejected rather than silently inheriting a rule
  // that may be wrong for it.
  test("rejects any source without a registered rule", () => {
    for (const source of ["", "openfmri", "zenodo", "nemar", "OPENNEURO"]) {
      expect(isValidSourceIdForDataset(source, "on007964", "ds007964")).toBe(false);
    }
  });

  // Guards against the rule table being consulted with a prototype key rather
  // than an own property — `constructor` and friends must not resolve.
  test("is not fooled by inherited Object properties", () => {
    for (const source of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      expect(isValidSourceIdForDataset(source, "on007964", "ds007964")).toBe(false);
    }
  });
});
