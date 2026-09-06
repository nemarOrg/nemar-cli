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
 * Try to open `url`, reporting whether the attempt was made.
 *
 * `false` means "tell the user to open it themselves" — it is not an error
 * and never throws. `NEMAR_NO_BROWSER=1` forces it, for CI, for tests, and
 * for anyone who does not want a CLI reaching for their browser.
 *
 * A spawn that fails after the fact (no `xdg-open` on a minimal container)
 * cannot be detected synchronously, which is the other reason the URL is
 * always printed regardless of what this returns.
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
    // Swallow the async failure (ENOENT for a missing opener) rather than
    // letting it reach the process as an unhandled 'error' event.
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}
