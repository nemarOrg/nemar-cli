/**
 * Golden coverage for services/s3.ts's `formatBytes` (epic #1225 phase 4,
 * issue #1227) -- the decimal/1000 outlier among NEMAR's six byte
 * formatters, the audit's named bug (`.context/research-make-vs-take-audit.md`
 * candidate 2).
 *
 * This file exists ONLY to pin the CURRENT behavior before the consolidation
 * commit deletes the function outright (its single caller,
 * enrich-dataset.ts's Stage 1a size seed, switches to the canonical binary
 * `formatFileSize` from `shared/bytes.ts` -- see the phase 4 implementation
 * brief on issue #1227). This file is removed in that same commit: unlike
 * the other five formatters, this one is not moved, so there is nothing left
 * to test here afterward.
 *
 * The expected strings were computed independently against a verbatim copy
 * of the current formatter and cross-checked by running the real function
 * in this worktree before any implementation change landed.
 */

import { describe, expect, test } from "bun:test";
import { formatBytes } from "../src/services/s3";

describe("s3.ts formatBytes (decimal/1000 outlier, deleted in the next commit)", () => {
  test("golden vector — phase 4 pinned magnitudes (issue #1227)", () => {
    expect(formatBytes(0)).toBe("0.0 KB");
    expect(formatBytes(1)).toBe("0.0 KB");
    expect(formatBytes(512)).toBe("0.5 KB");
    expect(formatBytes(1023)).toBe("1.0 KB");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(1048576)).toBe("1.0 MB");
    expect(formatBytes(1073741824)).toBe("1.1 GB");
    expect(formatBytes(4628000000)).toBe("4.6 GB");
    expect(formatBytes(24000000000)).toBe("24.0 GB");
    expect(formatBytes(1099511627776)).toBe("1.1 TB");
    expect(formatBytes(1024 ** 5)).toBe("1125.9 TB"); // 1 PiB
  });

  test("bad inputs (no guards on this formatter)", () => {
    expect(formatBytes(-1)).toBe("-0.0 KB");
    expect(formatBytes(Number.NaN)).toBe("NaN KB");
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe("Infinity TB");
  });
});
