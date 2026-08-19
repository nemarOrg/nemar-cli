/**
 * CLI Version Enforcement Middleware
 *
 * Rejects requests from CLI versions older than the minimum required.
 * Pre-v0.6.3 clients used registerurl instead of the S3 special remote.
 * The minimum is v0.6.4, the first version to send the X-CLI-Version header.
 */

import type { Context, Next } from "hono";
import type { Bindings, Variables } from "../types/bindings";

const MIN_CLI_VERSION = "0.6.4";

/**
 * Parse a semver string into comparable parts.
 * Returns null for unparseable versions. Accepts extra parts (only first 3 used).
 */
function parseSemver(v: string): [number, number, number] | null {
  const clean = v.replace(/^v/, "").split("-")[0];
  const parts = clean.split(".").map(Number);
  if (parts.length < 3 || parts.some(Number.isNaN)) return null;
  return [parts[0], parts[1], parts[2]];
}

function isVersionBelow(version: string, minimum: string): boolean | null {
  const v = parseSemver(version);
  const m = parseSemver(minimum);
  if (!v || !m) return null;
  if (v[0] !== m[0]) return v[0] < m[0];
  if (v[1] !== m[1]) return v[1] < m[1];
  return v[2] < m[2];
}

/**
 * Middleware that checks the X-CLI-Version header.
 * Returns 426 Upgrade Required if the CLI is too old.
 * Apply selectively to routes that require a minimum CLI version.
 */
export const cliVersionGuard = async (
  c: Context<{ Bindings: Bindings; Variables: Variables }>,
  next: Next,
) => {
  // Web-session (cookie) requests come from the dashboard's upload flow.
  // The browser fetches current site code on every page load, so it can
  // never be version-stale the way an installed CLI binary can, and it
  // sends no X-CLI-Version header. Only bearer-token (CLI) clients are
  // subject to the minimum-version gate.
  if (c.get("authMethod") === "cookie") {
    await next();
    return;
  }

  const cliVersion = c.req.header("X-CLI-Version");

  if (!cliVersion) {
    return c.json(
      {
        error: "CLI version too old",
        message: `This operation requires NEMAR CLI v${MIN_CLI_VERSION} or newer. Run: bun install -g nemar@latest`,
        minimum_version: MIN_CLI_VERSION,
      },
      426,
    );
  }

  const result = isVersionBelow(cliVersion, MIN_CLI_VERSION);

  if (result === null) {
    return c.json(
      {
        error: "Invalid CLI version",
        message: `Could not parse CLI version "${cliVersion}". Run: bun install -g nemar@latest`,
        minimum_version: MIN_CLI_VERSION,
        current_version: cliVersion,
      },
      400,
    );
  }

  if (result) {
    return c.json(
      {
        error: "CLI version too old",
        message: `Your CLI version (${cliVersion}) is below the minimum required (${MIN_CLI_VERSION}). Run: bun install -g nemar@latest`,
        minimum_version: MIN_CLI_VERSION,
        current_version: cliVersion,
      },
      426,
    );
  }

  await next();
};
