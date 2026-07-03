/**
 * Constants and small helpers shared across the services/github/* modules.
 *
 * Moved verbatim from services/github.ts (#906, epic #902); the only
 * intentional changes are import paths and the `export` keyword on
 * GITHUB_API, VALIDATOR_VERSION, errText, and ghHeaders (previously private
 * to the monolith; needed cross-module now). These four are deliberately NOT
 * re-exported by the services/github barrel — they are internal wiring, not
 * public API.
 */

import validatorPin from "../../../../validator-version.json" with { type: "json" };

export const VALIDATOR_VERSION = validatorPin.version;

// NEMAR_GITHUB_API_URL is a test-only override that points at a local
// Bun.serve fake. Stored on globalThis because the Workers runtime has no
// `process.env`; read at call time so test helpers can install the override
// after the module has loaded.
export function GITHUB_API(): string {
  const override = (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL;
  return override ?? "https://api.github.com";
}
// Dataset repos (nm000XXX) live in nemarDatasets org; tooling repos live in nemarOrg
export const ORG_NAME = "nemarDatasets";

export function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function ghHeaders(pat: string): Record<string, string> {
  return {
    Authorization: `Bearer ${pat}`,
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "NEMAR-API",
  };
}
