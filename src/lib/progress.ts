/**
 * Download progress tracking and display
 *
 * Parses git-annex --json-progress output and renders a live progress bar
 * showing percentage, files completed, bytes transferred, speed, and ETA.
 */

import chalk from "chalk";

export interface DownloadProgress {
  filesCompleted: number;
  filesTotal: number;
  bytesTransferred: number;
  bytesTotal: number;
  currentFile?: string;
  speed?: number; // bytes/sec
  eta?: number; // seconds remaining
}

/**
 * git-annex --json-progress output line (progress update)
 */
interface GitAnnexProgressLine {
  action?: string;
  file?: string;
  "byte-progress"?: number;
  "total-size"?: number;
  "percent-progress"?: string;
  key?: string;
  ok?: boolean;
  success?: boolean;
}

/**
 * Parse a single line from git-annex --json-progress output.
 * Returns null if the line is not valid JSON or not a progress/completion event.
 */
export function parseGitAnnexProgressLine(line: string): GitAnnexProgressLine | null {
  const trimmed = line.trim();
  if (!trimmed || !trimmed.startsWith("{")) return null;
  try {
    return JSON.parse(trimmed) as GitAnnexProgressLine;
  } catch {
    return null;
  }
}

/**
 * Format bytes to a human-readable string
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** i;
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/**
 * Format speed (bytes/sec) to a human-readable string
 */
function formatSpeed(bytesPerSec: number): string {
  return `${formatBytes(bytesPerSec)}/s`;
}

/**
 * Format seconds to a human-readable ETA string
 */
function formatEta(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

/**
 * Render a progress bar string
 */
function renderProgressBar(percent: number, width = 20): string {
  const filled = Math.round((percent / 100) * width);
  const empty = width - filled;
  return `[${"=".repeat(filled)}${" ".repeat(empty)}]`;
}

/**
 * Progress tracker for git-annex get operations.
 * Parses --json-progress output lines and renders live progress to stderr.
 */
export class DownloadProgressTracker {
  private filesCompleted = 0;
  private filesTotal: number;
  private bytesTotal = 0;
  private currentFileBytesTransferred = 0;
  private currentFileBytesTotal = 0;
  private currentFile = "";
  private startTime: number;
  private lastUpdateTime: number;
  private lastBytesTransferred = 0;
  private totalBytesTransferred = 0;
  private speedSamples: number[] = [];
  private lastRenderedLine = "";

  constructor(filesTotal = 0, bytesTotal = 0) {
    this.filesTotal = filesTotal;
    this.bytesTotal = bytesTotal;
    this.startTime = Date.now();
    this.lastUpdateTime = this.startTime;
  }

  /**
   * Process a parsed JSON line from git-annex --json-progress output
   */
  processLine(parsed: GitAnnexProgressLine): void {
    // File completion event
    if (parsed.ok === true || parsed.success === true) {
      this.filesCompleted++;
      this.totalBytesTransferred += this.currentFileBytesTotal || this.currentFileBytesTransferred;
      this.currentFileBytesTransferred = 0;
      this.currentFileBytesTotal = 0;
      this.render();
      return;
    }

    // Progress update within a file
    if (parsed["byte-progress"] !== undefined) {
      this.currentFile = parsed.file || this.currentFile;
      this.currentFileBytesTransferred = parsed["byte-progress"];
      if (parsed["total-size"] !== undefined) {
        this.currentFileBytesTotal = parsed["total-size"];
      }

      // Update speed estimate
      const now = Date.now();
      const elapsed = (now - this.lastUpdateTime) / 1000;
      if (elapsed > 0.5) {
        const bytesDelta =
          this.totalBytesTransferred + this.currentFileBytesTransferred - this.lastBytesTransferred;
        const speed = bytesDelta / elapsed;
        if (speed > 0) {
          this.speedSamples.push(speed);
          if (this.speedSamples.length > 5) this.speedSamples.shift();
        }
        this.lastBytesTransferred = this.totalBytesTransferred + this.currentFileBytesTransferred;
        this.lastUpdateTime = now;
      }

      this.render();
    }
  }

  /**
   * Mark an additional file as completed (for fallback counting)
   */
  incrementFilesCompleted(): void {
    this.filesCompleted++;
  }

  /**
   * Set total file count (if known ahead of time)
   */
  setFilesTotal(total: number): void {
    this.filesTotal = total;
  }

  /**
   * Set total bytes to transfer (if known ahead of time).
   * When > 0, the progress percentage is computed from bytes (more stable
   * than file count when sizes vary). When 0, the bar is hidden until known.
   */
  setBytesTotal(total: number): void {
    this.bytesTotal = total;
  }

  /**
   * Compute the current percent (0-100). Used for rendering and testing.
   * Returns null when no authoritative total has been set.
   */
  getPercent(): number | null {
    const currentTotal = this.totalBytesTransferred + this.currentFileBytesTransferred;
    if (this.bytesTotal > 0) {
      return Math.min(100, Math.round((currentTotal / this.bytesTotal) * 100));
    }
    if (this.filesTotal > 0) {
      return Math.min(100, Math.round((this.filesCompleted / this.filesTotal) * 100));
    }
    return null;
  }

  /**
   * Snapshot current counters (used in tests).
   */
  getProgress(): DownloadProgress {
    return {
      filesCompleted: this.filesCompleted,
      filesTotal: this.filesTotal,
      bytesTransferred: this.totalBytesTransferred + this.currentFileBytesTransferred,
      bytesTotal: this.bytesTotal,
      currentFile: this.currentFile || undefined,
    };
  }

  /**
   * Render the current progress line to stderr
   */
  render(): void {
    const avgSpeed =
      this.speedSamples.length > 0
        ? this.speedSamples.reduce((a, b) => a + b, 0) / this.speedSamples.length
        : 0;

    const currentTotal = this.totalBytesTransferred + this.currentFileBytesTransferred;

    // Prefer byte-based percentage when an authoritative bytesTotal was set.
    // Fall back to file-based only when files are pre-counted. Never invent a
    // total from completed counts (would pin progress at 100%).
    let percent = 0;
    let hasAuthoritativeTotal = false;
    if (this.bytesTotal > 0) {
      percent = Math.min(100, Math.round((currentTotal / this.bytesTotal) * 100));
      hasAuthoritativeTotal = true;
    } else if (this.filesTotal > 0) {
      percent = Math.min(100, Math.round((this.filesCompleted / this.filesTotal) * 100));
      hasAuthoritativeTotal = true;
    }

    const filesStr =
      this.filesTotal > 0
        ? `${this.filesCompleted}/${this.filesTotal} files`
        : `${this.filesCompleted} files`;

    let line: string;
    if (hasAuthoritativeTotal) {
      const bar = renderProgressBar(percent);
      line = `${bar} ${percent}% ${filesStr}`;
    } else {
      // Degraded mode: no authoritative totals known. Show running counters
      // without a misleading percent or bar.
      line = filesStr;
    }

    if (currentTotal > 0) {
      const bytesStr =
        this.bytesTotal > 0
          ? `${formatBytes(currentTotal)}/${formatBytes(this.bytesTotal)}`
          : formatBytes(currentTotal);
      line += ` | ${bytesStr}`;
    }
    if (avgSpeed > 0) {
      line += ` | ${formatSpeed(avgSpeed)}`;
    }
    if (avgSpeed > 0) {
      // ETA from overall remaining bytes when known, else from current file
      const remaining =
        this.bytesTotal > 0
          ? Math.max(0, this.bytesTotal - currentTotal)
          : this.currentFileBytesTotal > 0
            ? this.currentFileBytesTotal - this.currentFileBytesTransferred
            : 0;
      if (remaining > 0) {
        const eta = remaining / avgSpeed;
        if (eta > 0) line += ` | ETA ${formatEta(eta)}`;
      }
    }

    // Only write if changed (avoids flicker)
    if (line !== this.lastRenderedLine) {
      process.stderr.write(`\r${chalk.cyan(line)}${" ".repeat(10)}`);
      this.lastRenderedLine = line;
    }
  }

  /**
   * Clear the progress line and print a final summary
   */
  finish(filesDownloaded: number): void {
    const elapsed = (Date.now() - this.startTime) / 1000;
    process.stderr.write(`\r${" ".repeat(this.lastRenderedLine.length + 15)}\r`);

    if (filesDownloaded > 0) {
      const avgSpeed = elapsed > 0 ? `${formatSpeed(this.totalBytesTransferred / elapsed)}` : "";
      const summary = [
        `${filesDownloaded} file${filesDownloaded !== 1 ? "s" : ""} downloaded`,
        this.totalBytesTransferred > 0 ? formatBytes(this.totalBytesTransferred) : "",
        avgSpeed,
      ]
        .filter(Boolean)
        .join(" | ");
      process.stderr.write(`${chalk.green(summary)}\n`);
    }
  }
}
