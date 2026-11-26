/**
 * Which addresses the CLI will send job bytes to or fetch results from (epic #2021 phase D3b, #2024).
 * Both kinds of address (the upload address and a result link) are bearer secrets handed out by the
 * Worker, so they are used only over `https:`, never followed across a redirect, and never printed.
 * Plain `http:` is accepted for a loopback host only (a store running on this machine, as the tests
 * do); nothing off this machine is ever reached without TLS.
 */

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

export function isStoreUrlAllowed(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
}
