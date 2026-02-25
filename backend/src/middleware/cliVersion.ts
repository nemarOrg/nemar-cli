/**
 * CLI Version Enforcement Middleware
 *
 * Rejects requests from CLI versions older than the minimum required.
 * Prevents broken uploads from pre-v0.6.4 clients that don't create
 * the S3 special remote properly.
 */

import type { Context, Next } from "hono";
import type { Bindings, Variables } from "../types/bindings";

const MIN_CLI_VERSION = "0.6.4";

/**
 * Parse a semver string into comparable parts.
 * Returns null for unparseable versions.
 */
function parseSemver(v: string): [number, number, number] | null {
	// Strip leading 'v' and any pre-release suffix for comparison
	const clean = v.replace(/^v/, "").split("-")[0];
	const parts = clean.split(".").map(Number);
	if (parts.length < 3 || parts.some(Number.isNaN)) return null;
	return [parts[0], parts[1], parts[2]];
}

function isVersionBelow(version: string, minimum: string): boolean {
	const v = parseSemver(version);
	const m = parseSemver(minimum);
	if (!v || !m) return false; // Can't parse; don't block
	if (v[0] !== m[0]) return v[0] < m[0];
	if (v[1] !== m[1]) return v[1] < m[1];
	return v[2] < m[2];
}

/**
 * Middleware that checks X-CLI-Version header on write endpoints.
 * Returns 426 Upgrade Required if the CLI is too old.
 */
export function cliVersionGuard() {
	return async (
		c: Context<{ Bindings: Bindings; Variables: Variables }>,
		next: Next,
	) => {
		const cliVersion = c.req.header("X-CLI-Version");

		// No header = old CLI or non-CLI client. Block it.
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

		if (isVersionBelow(cliVersion, MIN_CLI_VERSION)) {
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
}
