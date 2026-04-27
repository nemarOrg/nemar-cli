/**
 * DownloadProgressTracker unit tests.
 *
 * Verifies the fix for issue #346: progress bar must climb monotonically
 * from 0% to 100% when authoritative totals are pre-counted, and must not
 * pin filesTotal to filesCompleted on each completion event.
 */

import { describe, expect, test } from "bun:test";
import { DownloadProgressTracker, parseGitAnnexProgressLine } from "../src/lib/progress";

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
        { file: "a.bin", "byte-progress": 50, "total-size": 100 },
        { file: "a.bin", "byte-progress": 100, "total-size": 100 },
        { file: "a.bin", ok: true },
        { file: "b.bin", "byte-progress": 150, "total-size": 300 },
        { file: "b.bin", "byte-progress": 300, "total-size": 300 },
        { file: "b.bin", ok: true },
        { file: "c.bin", "byte-progress": 200, "total-size": 600 },
        { file: "c.bin", "byte-progress": 400, "total-size": 600 },
        { file: "c.bin", "byte-progress": 600, "total-size": 600 },
        { file: "c.bin", ok: true },
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
      tracker.processLine({ file: "x", "byte-progress": 100, "total-size": 100 });
      tracker.processLine({ file: "x", ok: true });
      tracker.processLine({ file: "y", "byte-progress": 100, "total-size": 100 });
      tracker.processLine({ file: "y", ok: true });

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
      tracker.processLine({ file: "z", "byte-progress": 50, "total-size": 100 });
      // No bytesTotal, no filesTotal -> still no authoritative percent
      expect(tracker.getPercent()).toBeNull();
      tracker.processLine({ file: "z", ok: true });
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
      tracker.processLine({ file: "small", "byte-progress": 10, "total-size": 10 });
      tracker.processLine({ file: "small", ok: true });
      // 1/2 files done = 50% by file count, but only 1% by bytes
      expect(tracker.getPercent()).toBe(1);

      // Half through huge file
      tracker.processLine({ file: "huge", "byte-progress": 495, "total-size": 990 });
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
    const ok = parseGitAnnexProgressLine('{"file":"a","byte-progress":10}');
    expect(ok?.["byte-progress"]).toBe(10);
  });
});
