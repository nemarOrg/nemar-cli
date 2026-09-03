/**
 * DownloadProgressTracker unit tests.
 *
 * Verifies the fix for issue #346: progress bar must climb monotonically
 * from 0% to 100% when authoritative totals are pre-counted, and must not
 * pin filesTotal to filesCompleted on each completion event.
 */

import { describe, expect, test } from "bun:test";
import {
  DownloadProgressTracker,
  formatBytes,
  parseGitAnnexProgressLine,
} from "../src/lib/progress";

/**
 * Build a byte-progress event in the actual git-annex --json-progress shape.
 * git-annex nests `file`/`key`/`command` under `action` for in-flight events.
 */
function progressEvent(file: string, bytes: number, total: number): Record<string, unknown> {
  return {
    action: { command: "get", file, key: `SHA256E-s${total}--${file}` },
    "byte-progress": bytes,
    "total-size": total,
    "percent-progress": `${Math.round((bytes / total) * 100)}%`,
  };
}

/**
 * Build a completion event in the actual git-annex shape (top-level fields).
 */
function completionEvent(file: string, success = true): Record<string, unknown> {
  return {
    command: "get",
    file,
    key: `SHA256E--${file}`,
    success,
    "error-messages": [],
  };
}

// Silence stderr writes during render() so test output stays clean.
const origStderrWrite = process.stderr.write.bind(process.stderr);
function muteStderr(): () => void {
  // biome-ignore lint/suspicious/noExplicitAny: test-only override
  (process.stderr as any).write = () => true;
  return () => {
    // biome-ignore lint/suspicious/noExplicitAny: test-only restore
    (process.stderr as any).write = origStderrWrite;
  };
}

describe("DownloadProgressTracker", () => {
  test("monotonic 0->100% with authoritative bytesTotal", () => {
    const restore = muteStderr();
    try {
      // Three files: 100 bytes, 300 bytes, 600 bytes; total 1000.
      const tracker = new DownloadProgressTracker(3, 1000);
      const sequence = [
        progressEvent("a.bin", 50, 100),
        progressEvent("a.bin", 100, 100),
        completionEvent("a.bin"),
        progressEvent("b.bin", 150, 300),
        progressEvent("b.bin", 300, 300),
        completionEvent("b.bin"),
        progressEvent("c.bin", 200, 600),
        progressEvent("c.bin", 400, 600),
        progressEvent("c.bin", 600, 600),
        completionEvent("c.bin"),
      ];

      const percents: number[] = [];
      const startPercent = tracker.getPercent();
      expect(startPercent).toBe(0);
      percents.push(startPercent ?? 0);

      for (const line of sequence) {
        tracker.processLine(line);
        const p = tracker.getPercent();
        expect(p).not.toBeNull();
        percents.push(p as number);
      }

      // Monotonic non-decreasing
      for (let i = 1; i < percents.length; i++) {
        expect(percents[i]).toBeGreaterThanOrEqual(percents[i - 1]);
      }

      // Reaches 100%
      expect(percents[percents.length - 1]).toBe(100);

      const final = tracker.getProgress();
      expect(final.filesCompleted).toBe(3);
      expect(final.filesTotal).toBe(3);
      expect(final.bytesTransferred).toBe(1000);
      expect(final.bytesTotal).toBe(1000);
    } finally {
      restore();
    }
  });

  test("filesTotal is NOT mutated by completion events (issue #346 regression)", () => {
    const restore = muteStderr();
    try {
      // Pre-count says 5 files; only complete 2 so far. Tracker must keep
      // filesTotal at 5 (not collapse to 2).
      const tracker = new DownloadProgressTracker(5, 500);
      tracker.processLine(progressEvent("x", 100, 100));
      tracker.processLine(completionEvent("x"));
      tracker.processLine(progressEvent("y", 100, 100));
      tracker.processLine(completionEvent("y"));

      const snap = tracker.getProgress();
      expect(snap.filesCompleted).toBe(2);
      expect(snap.filesTotal).toBe(5);
      // 200 / 500 = 40%
      expect(tracker.getPercent()).toBe(40);
    } finally {
      restore();
    }
  });

  test("degraded mode (no totals known) reports null percent", () => {
    const restore = muteStderr();
    try {
      const tracker = new DownloadProgressTracker();
      expect(tracker.getPercent()).toBeNull();
      tracker.processLine(progressEvent("z", 50, 100));
      // No bytesTotal, no filesTotal -> still no authoritative percent
      expect(tracker.getPercent()).toBeNull();
      tracker.processLine(completionEvent("z"));
      // Still null: completing files must not invent a total.
      expect(tracker.getPercent()).toBeNull();

      const snap = tracker.getProgress();
      expect(snap.filesCompleted).toBe(1);
      expect(snap.filesTotal).toBe(0);
    } finally {
      restore();
    }
  });

  test("byte-based percent stays accurate when files have unequal sizes", () => {
    const restore = muteStderr();
    try {
      // 1 small file (10B) + 1 huge file (990B) = 1000B
      const tracker = new DownloadProgressTracker(2, 1000);

      // Finish small file
      tracker.processLine(progressEvent("small", 10, 10));
      tracker.processLine(completionEvent("small"));
      // 1/2 files done = 50% by file count, but only 1% by bytes
      expect(tracker.getPercent()).toBe(1);

      // Half through huge file
      tracker.processLine(progressEvent("huge", 495, 990));
      // (10 + 495) / 1000 = ~50.5%
      expect(tracker.getPercent()).toBe(51);
    } finally {
      restore();
    }
  });

  test("parseGitAnnexProgressLine handles JSON and ignores garbage", () => {
    expect(parseGitAnnexProgressLine("")).toBeNull();
    expect(parseGitAnnexProgressLine("not json")).toBeNull();
    expect(parseGitAnnexProgressLine("{broken")).toBeNull();
    const ok = parseGitAnnexProgressLine(
      '{"action":{"command":"get","file":"a"},"byte-progress":10,"total-size":20}',
    );
    expect(ok?.["byte-progress"]).toBe(10);
    expect(ok?.action?.file).toBe("a");
  });

  test("interleaved -J events credit bytes to the correct file", () => {
    // Reproduces the parallel-mode misattribution: with -J 4 git-annex
    // interleaves byte-progress events from concurrent files. The tracker
    // must key per-file state so that file A's completion doesn't credit
    // file B's bytes (or vice versa) to totalBytesTransferred.
    const restore = muteStderr();
    try {
      // Two files: A=100B (small), B=900B (large). Total=1000B.
      const tracker = new DownloadProgressTracker(2, 1000);
      const interleaved = [
        progressEvent("A", 50, 100),
        progressEvent("B", 200, 900),
        progressEvent("A", 100, 100),
        progressEvent("B", 500, 900),
        completionEvent("A"), // A done first
        progressEvent("B", 700, 900),
        progressEvent("B", 900, 900),
        completionEvent("B"),
      ];

      const percents: number[] = [];
      for (const line of interleaved) {
        tracker.processLine(line);
        const p = tracker.getPercent();
        if (p !== null) percents.push(p);
      }

      // Monotonic non-decreasing
      for (let i = 1; i < percents.length; i++) {
        expect(percents[i]).toBeGreaterThanOrEqual(percents[i - 1]);
      }

      // Crucial: when A completes (its 100B done), total credited must be
      // exactly 100 (A's size), not 100 + B's then-current 500 = 600.
      // Without the fix the percent would jump to 60% on A's ok event.
      const final = tracker.getProgress();
      expect(final.bytesTransferred).toBe(1000);
      expect(percents[percents.length - 1]).toBe(100);
      expect(final.filesCompleted).toBe(2);
    } finally {
      restore();
    }
  });

  test("ok event with no preceding byte-progress (tiny files)", () => {
    // Some small/skipped files emit only an ok event. The tracker must
    // still increment filesCompleted; bytes will undercount but the bar
    // continues to climb based on filesCompleted in file-only mode.
    const restore = muteStderr();
    try {
      const tracker = new DownloadProgressTracker(3, 0); // file-based percent
      tracker.processLine(completionEvent("a"));
      tracker.processLine(completionEvent("b"));
      tracker.processLine(completionEvent("c"));
      const snap = tracker.getProgress();
      expect(snap.filesCompleted).toBe(3);
      expect(snap.filesTotal).toBe(3);
      expect(tracker.getPercent()).toBe(100);
    } finally {
      restore();
    }
  });

  test("more ok events than precount: percent clamps at 100", () => {
    // Defense against precount/get drift (e.g., a transient retry, or a
    // file that flickered into pending between precount and get).
    const restore = muteStderr();
    try {
      const tracker = new DownloadProgressTracker(2, 200);
      tracker.processLine(progressEvent("a", 100, 100));
      tracker.processLine(completionEvent("a"));
      tracker.processLine(progressEvent("b", 100, 100));
      tracker.processLine(completionEvent("b"));
      tracker.processLine(progressEvent("c", 100, 100));
      tracker.processLine(completionEvent("c"));
      // 3 files completed against precounted 2: percent stays at 100, not >100
      expect(tracker.getPercent()).toBe(100);
      const snap = tracker.getProgress();
      expect(snap.filesCompleted).toBe(3);
    } finally {
      restore();
    }
  });

  test("fewer ok events than precount: percent stays below 100", () => {
    const restore = muteStderr();
    try {
      const tracker = new DownloadProgressTracker(4, 1000);
      tracker.processLine(progressEvent("a", 250, 250));
      tracker.processLine(completionEvent("a"));
      tracker.processLine(progressEvent("b", 250, 250));
      tracker.processLine(completionEvent("b"));
      // Aborted before c, d
      const p = tracker.getPercent();
      expect(p).not.toBeNull();
      expect(p as number).toBeLessThan(100);
      expect(p as number).toBe(50); // 500/1000
    } finally {
      restore();
    }
  });

  test("byte-progress with file nested under action (real git-annex shape)", () => {
    // Regression for the "stuck at 0% 134/181 files" bug: git-annex emits
    // {"action":{"file":"x"},"byte-progress":N,"total-size":M} for in-flight
    // events, with no top-level `file`. The earlier parser only checked
    // top-level `parsed.file`, so inFlight was never populated, every ok
    // credited 0 bytes, and the bar stayed at 0% even as files completed.
    const restore = muteStderr();
    try {
      const tracker = new DownloadProgressTracker(2, 200);

      // Real shape: file nested under action for byte-progress
      tracker.processLine({
        action: { command: "get", file: "big.bin", key: "K1" },
        "byte-progress": 50,
        "total-size": 100,
      });
      tracker.processLine({
        action: { command: "get", file: "big.bin", key: "K1" },
        "byte-progress": 100,
        "total-size": 100,
      });
      // Real shape: file at top level for completion
      tracker.processLine({ command: "get", file: "big.bin", key: "K1", success: true });

      // After one 100B file: 50% by bytes, NOT stuck at 0%.
      expect(tracker.getPercent()).toBe(50);
      const snap = tracker.getProgress();
      expect(snap.filesCompleted).toBe(1);
      expect(snap.bytesTransferred).toBe(100);

      // Second file with no preceding byte-progress (e.g., tiny file, fast
      // path). filesCompleted advances; byte credit defaults to 0 for that
      // file but the file count still climbs.
      tracker.processLine({ command: "get", file: "small.bin", key: "K2", success: true });
      expect(tracker.getProgress().filesCompleted).toBe(2);
    } finally {
      restore();
    }
  });
});

/**
 * Golden coverage for `formatBytes` (epic #1225 phase 4, issue #1227).
 * `formatBytes` is exported directly and consumed across the CLI (progress
 * bar, `formatSpeed`, upload plan/preflight, dataset/admin/sandbox commands)
 * -- those consumers need live git-annex/S3/network state to drive end to
 * end, so per .rules/testing.md this supplements that coverage by pinning
 * the exported function's own contract directly.
 *
 * The expected strings were computed independently against a verbatim copy
 * of the current formatter and cross-checked by running the real function
 * in this worktree before any implementation change landed -- see the phase
 * 4 implementation brief on issue #1227 for the full six-formatter table
 * this is one column of.
 */
describe("formatBytes", () => {
  test("golden vector — phase 4 pinned magnitudes (issue #1227)", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1)).toBe("1 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1023)).toBe("1023 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(1048576)).toBe("1.0 MB");
    expect(formatBytes(1073741824)).toBe("1.0 GB");
    expect(formatBytes(4628000000)).toBe("4.3 GB");
    expect(formatBytes(24000000000)).toBe("22.4 GB");
    expect(formatBytes(1099511627776)).toBe("1.0 TB");
    expect(formatBytes(1024 ** 5)).toBe("1024.0 TB"); // 1 PiB, no index clamp above TB
  });

  test("bad inputs (current behavior, no guards on this formatter)", () => {
    expect(formatBytes(-1)).toBe("NaN undefined");
    expect(formatBytes(Number.NaN)).toBe("NaN undefined");
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe("Infinity TB");
  });
});
