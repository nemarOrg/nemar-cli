/**
 * Unit tests for the pure metadata helpers in
 * backend/src/services/dataset-metadata-columns.ts.
 *
 * Covers:
 *   - authorsFromEnrichment: extract a CSV author string from either the
 *     object-keyed form ({"Name": {orcid, ...}, ...}) the enrichment
 *     pipeline emits today, or the legacy array-of-objects form some older
 *     rows still carry.
 *   - formatFileSize: byte count -> human-readable string for the
 *     datasets.file_size_formatted column.
 */

import { describe, expect, test } from "bun:test";
import {
  authorsFromEnrichment,
  formatFileSize,
} from "../backend/src/services/dataset-metadata-columns";

describe("authorsFromEnrichment", () => {
  test("returns null when input is missing", () => {
    expect(authorsFromEnrichment(null)).toBeNull();
    expect(authorsFromEnrichment(undefined)).toBeNull();
    expect(authorsFromEnrichment({})).toBeNull();
    expect(authorsFromEnrichment({ authors: null })).toBeNull();
  });

  test("returns null when authors is empty", () => {
    expect(authorsFromEnrichment({ authors: {} })).toBeNull();
    expect(authorsFromEnrichment({ authors: [] })).toBeNull();
  });

  test("joins object keys for the object form (current enrichment output)", () => {
    // Matches the live shape for nm000166:
    //   "authors": { "Gan Huang": {}, "Zhenxing Hu": {}, ... }
    const enrichment = {
      authors: {
        "Gan Huang": {},
        "Zhenxing Hu": { orcid: "0000-0001-x" },
        "Weize Chen": {},
      },
    };
    expect(authorsFromEnrichment(enrichment)).toBe("Gan Huang, Zhenxing Hu, Weize Chen");
  });

  test("handles legacy array-of-objects form", () => {
    const enrichment = {
      authors: [{ name: "Daniel G. Wakeman" }, { name: "Richard N Henson" }],
    };
    expect(authorsFromEnrichment(enrichment)).toBe("Daniel G. Wakeman, Richard N Henson");
  });

  test("handles array of plain strings", () => {
    expect(authorsFromEnrichment({ authors: ["Alpha One", "Beta Two"] })).toBe(
      "Alpha One, Beta Two",
    );
  });

  test("skips array entries that lack a usable name field", () => {
    const enrichment = {
      authors: [{ name: "First" }, { affiliation: "Lab" }, { name: "" }, { name: "Last" }],
    };
    expect(authorsFromEnrichment(enrichment)).toBe("First, Last");
  });
});

describe("formatFileSize", () => {
  test("returns null for zero or negative or non-finite", () => {
    expect(formatFileSize(0)).toBeNull();
    expect(formatFileSize(-1)).toBeNull();
    expect(formatFileSize(null)).toBeNull();
    expect(formatFileSize(undefined)).toBeNull();
    expect(formatFileSize(Number.NaN)).toBeNull();
    expect(formatFileSize(Number.POSITIVE_INFINITY)).toBeNull();
  });

  test("formats bytes through GB with two decimals when value is small", () => {
    expect(formatFileSize(512)).toBe("512 B");
    expect(formatFileSize(2048)).toBe("2.00 KB");
    expect(formatFileSize(2.5 * 1024 * 1024)).toBe("2.50 MB");
    expect(formatFileSize(1.2 * 1024 * 1024 * 1024)).toBe("1.20 GB");
  });

  test("drops decimals above 100 in the chosen unit to stay compact", () => {
    // 270 GB stays in GB and prints without decimals
    expect(formatFileSize(270 * 1024 * 1024 * 1024)).toBe("270 GB");
  });

  test("scales into TB for very large datasets", () => {
    expect(formatFileSize(5 * 1024 ** 4)).toBe("5.00 TB");
  });

  test("decimal cut-off at exactly 100 in the unit follows the >=100 rule", () => {
    // The branch is `n >= 100 ? toFixed(0) : toFixed(2)`. Pin the boundary
    // so a future tweak ("> 100" vs ">= 100") doesn't silently flip the
    // displayed precision on values that sit on the line.
    expect(formatFileSize(100 * 1024 * 1024 * 1024)).toBe("100 GB");
    expect(formatFileSize(99.5 * 1024 * 1024 * 1024)).toBe("99.50 GB");
  });
});
