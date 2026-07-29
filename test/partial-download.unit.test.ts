/**
 * Partial-retrieval classification (#1038).
 *
 * A dataset imported from an upstream archive can legitimately be missing a
 * fraction of the files it declares -- on004624 is 65,062 of 65,063 files. The
 * download must still succeed. These tests pin the decision rule and the
 * parsing of git-annex's failure summary; both are pure, so no git-annex, no
 * network, no fixtures.
 *
 * The literal git-annex output strings below were captured from real runs
 * against on003574 (11 anat files absent upstream), not hand-written.
 */

import { describe, expect, test } from "bun:test";
import { classifyGetOutcome, parseFailedSummary } from "../src/lib/git-annex/transfer.js";

describe("classifyGetOutcome", () => {
  test("nothing unavailable is complete", () => {
    expect(classifyGetOutcome({ retrieved: 65063, unavailable: 0 })).toBe("complete");
  });

  test("zero retrieved with zero unavailable is complete (already local)", () => {
    // `nemar dataset get` on a fully-present clone retrieves nothing and must
    // not be mistaken for a failed transfer.
    expect(classifyGetOutcome({ retrieved: 0, unavailable: 0 })).toBe("complete");
  });

  test("one missing file out of 65,063 is partial, not failed", () => {
    // The on004624 case: a single stray upstream temp file previously failed
    // the entire 20 GB download.
    expect(classifyGetOutcome({ retrieved: 65062, unavailable: 1 })).toBe("partial");
  });

  test("a heavily incomplete dataset is still partial", () => {
    // on006159: 442 of 664 files present (30% of bytes). Degraded, but the
    // 442 files that exist must reach the user.
    expect(classifyGetOutcome({ retrieved: 442, unavailable: 222 })).toBe("partial");
  });

  test("nothing retrieved with no diagnosable cause stays fatal", () => {
    expect(classifyGetOutcome({ retrieved: 0, unavailable: 11 })).toBe("failed");
  });

  test("re-running on an already-partial dataset is partial, not fatal", () => {
    // The idempotent-rerun case: git-annex silently skips files already
    // present, so a second `get` retrieves nothing and re-reports the same
    // absent files. Real captured stderr from on003574.
    const stderr = [
      "get sub-01/anat/sub-01_T1w.nii.gz (from s3-PUBLIC...) ",
      "  download failed: Not Found",
      "get: 11 failed",
    ].join("\n");
    expect(classifyGetOutcome({ retrieved: 0, unavailable: 11, failureText: stderr })).toBe(
      "partial",
    );
  });

  test("expired or denied credentials stay fatal", () => {
    const stderr = "  download failed: AccessDenied (403)\nget: 11 failed";
    expect(classifyGetOutcome({ retrieved: 0, unavailable: 11, failureText: stderr })).toBe(
      "failed",
    );
  });

  test("a transport signal outweighs a co-occurring 404", () => {
    // A run that shows both must not be downgraded on the strength of the 404.
    const stderr = "download failed: Not Found\ndownload failed: AccessDenied\nget: 2 failed";
    expect(classifyGetOutcome({ retrieved: 0, unavailable: 2, failureText: stderr })).toBe(
      "failed",
    );
  });

  test("a dead network stays fatal", () => {
    const stderr = "  could not connect to host\nget: 90 failed";
    expect(classifyGetOutcome({ retrieved: 0, unavailable: 90, failureText: stderr })).toBe(
      "failed",
    );
  });

  test("requireComplete turns any gap into a failure", () => {
    expect(classifyGetOutcome({ retrieved: 65062, unavailable: 1, requireComplete: true })).toBe(
      "failed",
    );
  });

  test("requireComplete does not disturb a complete run", () => {
    expect(classifyGetOutcome({ retrieved: 90, unavailable: 0, requireComplete: true })).toBe(
      "complete",
    );
  });
});

describe("parseFailedSummary", () => {
  test("reads the trailing summary git-annex writes to stderr under -J", () => {
    const stderr = [
      "get sub-05/anat/sub-05_T1w.nii.gz (from s3-PUBLIC...) ",
      "  download failed: Not Found",
      "",
      "  Unable to access these remotes: s3-PUBLIC",
      "failed",
      "get: 2 failed",
    ].join("\n");
    expect(parseFailedSummary(stderr)).toBe(2);
  });

  test("reads the git-annex: prefixed form", () => {
    expect(parseFailedSummary("git-annex: get: 11 failed")).toBe(11);
  });

  test("returns null when the run had no failure summary", () => {
    // A clean run: absence of the summary is what separates "content missing"
    // from "the whole invocation failed".
    expect(parseFailedSummary("get sub-01/eeg/sub-01_task-rest_eeg.edf ok\n")).toBeNull();
  });

  test("does not match a path that merely contains the phrase", () => {
    expect(parseFailedSummary("get sub-01/derivatives/get: 3 failed/x.set ok")).toBeNull();
  });
});
