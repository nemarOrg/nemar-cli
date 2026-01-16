/**
 * Version information for NEMAR CLI
 *
 * Reads version from package.json at build time via Bun's JSON import.
 */

import packageJson from "../../package.json";

export const version = packageJson.version;
