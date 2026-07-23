/**
 * CLI notice display
 *
 * Fetches active system notices from the backend and displays them
 * to stderr before command output. Tracks dismissed notice IDs
 * per-account in the CLI config.
 */

import chalk from "chalk";
import { type Notice, getNotices } from "./api/notices.js";
import { getConfig, isAuthenticated, setConfig } from "./config.js";

const MAX_DISMISSED = 100;

/**
 * Fetch and display active notices from the backend.
 * Filters out previously dismissed notices. Never blocks on failure.
 */
export async function fetchAndDisplayNotices(): Promise<void> {
  try {
    const { notices } = await getNotices();
    if (!notices || notices.length === 0) return;

    const config = getConfig();
    const dismissed = new Set(config.dismissedNoticeIds || []);
    const visible = notices.filter((n) => !dismissed.has(n.id));

    if (visible.length === 0) return;

    for (const notice of visible) {
      printNotice(notice);
    }

    // Auto-dismiss info-level notices after first display (only if authenticated)
    if (isAuthenticated()) {
      const infoDismissals = visible.filter((n) => n.level === "info").map((n) => n.id);
      if (infoDismissals.length > 0) {
        dismissNotices(infoDismissals);
      }
    }
  } catch (err) {
    // Notice failures must never block the CLI
    if (process.env.VERBOSE) {
      process.stderr.write(`[notices] ${err instanceof Error ? err.message : err}\n`);
    }
  }
}

function printNotice(notice: Notice): void {
  let prefix: string;
  let color: (text: string) => string;

  switch (notice.level) {
    case "critical":
      prefix = "CRITICAL";
      color = chalk.red.bold;
      break;
    case "warning":
      prefix = "WARNING";
      color = chalk.yellow;
      break;
    default:
      prefix = "NOTICE";
      color = chalk.blue;
  }

  const tag = color(`[${prefix}]`);

  if (notice.level === "critical") {
    const border = chalk.red("\u2500".repeat(50));
    process.stderr.write(`${border}\n${tag} ${notice.message}\n${border}\n`);
  } else {
    process.stderr.write(`${tag} ${notice.message}\n`);
  }
}

/**
 * Add notice IDs to the dismissed list in config.
 * Caps the list at MAX_DISMISSED with FIFO eviction.
 */
export function dismissNotices(ids: number[]): void {
  const config = getConfig();
  const current = config.dismissedNoticeIds || [];
  const updated = [...current, ...ids];

  // Cap the list to prevent unbounded growth
  if (updated.length > MAX_DISMISSED) {
    updated.splice(0, updated.length - MAX_DISMISSED);
  }

  setConfig("dismissedNoticeIds", updated);
}
