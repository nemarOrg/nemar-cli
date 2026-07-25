/**
 * CLI notice display
 *
 * Fetches active system notices from the backend and displays them
 * to stderr before command output. Tracks dismissed notice IDs
 * per-account in the CLI config.
 */

import chalk from "chalk";
import { type Notice, type NoticeLevel, getNotices } from "./api/notices.js";
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

    // Auto-dismiss the low-urgency levels after first display (only if
    // authenticated). `tip` replaced `info` in #1025; `announcement` joins it
    // because good news is a read-once thing too. Anything describing live or
    // imminent operational state (warning/maintenance/critical) deliberately
    // keeps reappearing until it expires — the same split the website uses
    // for banner dismissal persistence.
    if (isAuthenticated()) {
      const readOnce: NoticeLevel[] = ["tip", "announcement"];
      const autoDismissed = visible.filter((n) => readOnce.includes(n.level)).map((n) => n.id);
      if (autoDismissed.length > 0) {
        dismissNotices(autoDismissed);
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

  // Mirrors the website's banner tones (#1025) so a level reads the same in
  // the terminal as on the site. `default` also catches a level added
  // upstream before this client learns about it, rather than dropping it.
  switch (notice.level) {
    case "critical":
      prefix = "CRITICAL";
      color = chalk.red.bold;
      break;
    case "warning":
      prefix = "WARNING";
      color = chalk.yellow;
      break;
    case "maintenance":
      prefix = "MAINTENANCE";
      color = chalk.magenta;
      break;
    case "announcement":
      prefix = "NEWS";
      color = chalk.green;
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
