/**
 * Canonical dataset-version format for the NEMAR wire contract (epic #896, #898).
 *
 * A dataset version has ONE canonical wire form: the `v`-prefixed tag `vX.Y.Z`
 * (e.g. `v1.0.0`). D1 historically stored both bare (`1.0.0`) and tagged forms,
 * and the two backend surfaces disagreed: the data plane normalized to `v1.0.0`
 * under the key `latest`, while the catalog plane emitted the raw column under
 * `latest_version` — so `data.nemar.org` path-building and website rendering
 * drifted (a bare value yields `/<id>/1.0.0/`; a double-prefix yields `vv1.0.0`).
 * This module is the single source of truth both planes MUST route through.
 *
 * Zero deps beyond zod (extraction-ready for a standalone @nemar/contract pkg).
 */

import { z } from "zod";

/** Semver core, optionally `v`-prefixed, with the project's pre-release shapes. */
const VERSION_CORE = /^v?\d+\.\d+\.\d+(?:-(?:rc|alpha|beta)\d*)?$/;
/** Canonical tag form: MUST carry the `v` prefix. */
const VERSION_TAG = /^v\d+\.\d+\.\d+(?:-(?:rc|alpha|beta)\d*)?$/;

/**
 * Coerce any accepted version string to the canonical `v`-prefixed tag.
 * Idempotent: `toVersionTag("v1.0.0") === toVersionTag("1.0.0") === "v1.0.0"`.
 * (Promoted verbatim from services/data-router.ts so both planes share it.)
 */
export function toVersionTag(raw: string): string {
  return raw.startsWith("v") ? raw : `v${raw}`;
}

/** True when `s` is already the canonical `vX.Y.Z` tag form. */
export function isVersionTag(s: string): boolean {
  return VERSION_TAG.test(s);
}

/** Strip the canonical tag back to the bare semver (`v1.0.0` -> `1.0.0`). */
export function toBareVersion(raw: string): string {
  return raw.startsWith("v") ? raw.slice(1) : raw;
}

/** Accepts bare or tagged input; the parsed OUTPUT is always the canonical tag. */
export const versionTagSchema = z
  .string()
  .regex(VERSION_CORE, "must be a semver version, optionally v-prefixed")
  .transform(toVersionTag);

/** Strict: only the already-canonical `vX.Y.Z` tag validates (no coercion). */
export const strictVersionTagSchema = z
  .string()
  .regex(VERSION_TAG, "must be the canonical v-prefixed tag (vX.Y.Z)");
