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

/**
 * GitHub's raw content host.
 *
 * A CDN, not the REST API, and the difference is load-bearing: a response from
 * here carries no `x-ratelimit-*` header and spends none of the installation's
 * hourly `core` budget, which publishing, imports and every sweep share. That
 * is why the data plane's git-file broker reads through this host rather than
 * the blobs API -- one cold dataset download is thousands of files, and
 * through the REST API that alone would exhaust the org's quota.
 *
 * It serves a PRIVATE repo when the request carries an installation token
 * (verified against `nemarDatasets/nm099999`: anonymous 404, authenticated
 * 200), which is what lets a dataset stay readable while its repo does not.
 */
export const GITHUB_RAW_ORIGIN = "https://raw.githubusercontent.com";

/**
 * `<base>/<org>/<repo>/<ref>/<encoded path>` -- the one raw-content URL
 * builder. `ref` is a tag, branch or commit SHA; `repo` is the dataset id,
 * since nemarDatasets names each dataset's repo after its own id.
 *
 * Per-segment `encodeURIComponent` rather than `encodeURI`: a BIDS path
 * segment can contain characters that are legal in a filename and meaningful
 * in a URL.
 */
export function rawContentUrl(base: string, repo: string, ref: string, path: string): string {
  const encoded = path
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
  return `${base}/${ORG_NAME}/${repo}/${ref}/${encoded}`;
}

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
