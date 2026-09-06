/**
 * Open a URL in the user's browser (#1266, epic #1250; ADR 0044).
 *
 * Used by the ORCID link/relink handoff, which cannot happen in a terminal:
 * the consent screen is ORCID's, and the CLI's job is to get the person in
 * front of it. Opening is a CONVENIENCE and never the mechanism — the URL is
 * always printed first, so a headless box, an SSH session, or a machine with
 * no opener is a copy-and-paste rather than a dead end.
 *
 * No dependency for this (ADR 0037's make-versus-take test): the whole
 * platform table is three commands, none of them moving, and `open`'s value
 * over that is handling cases a scientific CLI does not meet.
 */

import { spawn } from "node:child_process";
import { dlog } from "./debug-log.js";

export interface BrowserOpener {
  command: string;
  args: string[];
}

/**
 * The opener for a platform, or null when we do not know one.
 *
 * Pure so the table is testable without spawning anything. Windows goes
 * through `cmd /c start` with an empty title argument: `start` treats a first
 * quoted argument as the window title, so omitting it breaks any URL that
 * needs quoting.
 */
export function browserOpenerFor(platform: NodeJS.Platform, url: string): BrowserOpener | null {
  if (platform === "darwin") return { command: "open", args: [url] };
  if (platform === "win32") return { command: "cmd", args: ["/c", "start", "", url] };
  if (platform === "linux") return { command: "xdg-open", args: [url] };
  return null;
}

/**
 * Try to open `url`. The return value is whether an opener was LAUNCHED, and
 * deliberately not whether it worked.
 *
 * That distinction is the reason the caller says "trying to open your browser"
 * rather than "opened" (#1266 review): `spawn` returns before the child can
 * fail, so a missing `xdg-open` on a minimal container produces an async
 * `error` event long after this function has answered. Claiming success there
 * would leave someone waiting for a window that is never coming, next to a URL
 * they were supposed to click.
 *
 * `false` means "there was nothing to try" — no opener for the platform, or
 * `NEMAR_NO_BROWSER=1`, which exists for CI, for tests, and for anyone who
 * does not want a CLI reaching for their browser. Never throws; the URL is
 * printed by the caller either way.
 *
 * The async failure goes to the debug log rather than the terminal: it is
 * diagnostic detail for `--debug`, and printing it under a URL the person can
 * already click would be noise.
 */
export function openInBrowser(url: string): boolean {
  if (process.env.NEMAR_NO_BROWSER === "1") return false;
  const opener = browserOpenerFor(process.platform, url);
  if (!opener) return false;
  try {
    const child = spawn(opener.command, opener.args, {
      stdio: "ignore",
      detached: true,
    });
    // Recorded, not discarded, and never rethrown: an unhandled 'error' event
    // on a detached child would take the CLI down over a browser that did not
    // open.
    child.on("error", (err) => {
      dlog(`openInBrowser: ${opener.command} failed: ${err instanceof Error ? err.message : err}`);
    });
    child.unref();
    return true;
  } catch (err) {
    dlog(
      `openInBrowser: could not spawn ${opener.command}: ${err instanceof Error ? err.message : err}`,
    );
    return false;
  }
}
