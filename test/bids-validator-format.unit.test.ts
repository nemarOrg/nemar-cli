/**
 * Golden coverage for src/lib/bids-validator.ts's private `formatBytes`
 * (epic #1225 phase 4, issue #1227).
 *
 * `formatBytes` there is module-private, so per .rules/testing.md ("test the
 * entry point, not the piece") this drives it through the real consumer,
 * `formatValidationResult`, and reads the "Size:" line of the rendered
 * report exactly as `nemar dataset validate` prints it.
 *
 * The expected strings below were computed independently against a verbatim
 * copy of the CURRENT (pre-consolidation) formatter and cross-checked by
 * running the real function in this worktree before any implementation
 * change landed — see the phase 4 implementation brief on issue #1227 for
 * the full six-formatter table this is one column of.
 *
 * The 1 PiB case pins a real bug: this formatter has no index clamp, so at
 * 1 PiB and above `sizes[i]` is `undefined` and the line reads
 * "Size: 1 undefined". That is intentionally pinned here in this phase's
 * first commit. The consolidation commit fixes the clamp in
 * `shared/bytes.ts`'s `formatBytesTrimmed`, and updates ONLY this one
 * expectation (to the clamped, correct value) as the sanctioned exception
 * called out by the implementation brief's step 3 -- every other value in
 * this file is unchanged by the fix.
 */

import { describe, expect, test } from "bun:test";
import type { BidsValidationResult } from "../src/lib/bids-validator";
import { formatValidationResult } from "../src/lib/bids-validator";

function resultWithSize(size: number): BidsValidationResult {
  return {
    valid: true,
    issues: [],
    codeMessages: {},
    summary: {
      sessions: [],
      subjects: [],
      tasks: [],
      modalities: [],
      totalFiles: 1,
      size,
      dataProcessed: true,
      schemaVersion: "1.0.0",
    },
    errorCount: 0,
    warningCount: 0,
  };
}

/** Extract the "Size: X" summary line rendered by formatValidationResult. */
function sizeLine(size: number): string {
  const text = formatValidationResult(resultWithSize(size), false);
  const line = text.split("\n").find((l) => l.startsWith("  Size:"));
  if (line === undefined) throw new Error("Size line not found in report");
  return line.replace("  Size: ", "");
}

describe("bids-validator formatBytes (via formatValidationResult)", () => {
  test("golden vector — phase 4 pinned magnitudes (issue #1227)", () => {
    expect(sizeLine(0)).toBe("0 B");
    expect(sizeLine(1)).toBe("1 B");
    expect(sizeLine(512)).toBe("512 B");
    expect(sizeLine(1023)).toBe("1023 B");
    expect(sizeLine(1024)).toBe("1 KB");
    expect(sizeLine(1536)).toBe("1.5 KB");
    expect(sizeLine(1048576)).toBe("1 MB");
    expect(sizeLine(1073741824)).toBe("1 GB");
    expect(sizeLine(4628000000)).toBe("4.31 GB");
    expect(sizeLine(24000000000)).toBe("22.35 GB");
    expect(sizeLine(1099511627776)).toBe("1 TB");
  });

  test("1 PiB: no index clamp, sizes[i] is undefined (the latent bug)", () => {
    // 1024**5. Fixed in the consolidation commit; this pins the CURRENT,
    // buggy behavior of the pre-refactor formatter.
    expect(sizeLine(1024 ** 5)).toBe("1 undefined");
  });

  test("bad inputs (current behavior, unaffected by the clamp fix)", () => {
    // Math.min(NaN, ...) is NaN, so the clamp added for the 1 PiB fix does
    // not touch these -- pinned here so a future change is visible.
    expect(sizeLine(-1)).toBe("NaN undefined");
    expect(sizeLine(Number.NaN)).toBe("NaN undefined");
    expect(sizeLine(Number.POSITIVE_INFINITY)).toBe("NaN undefined");
  });
});
