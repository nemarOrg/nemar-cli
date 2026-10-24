/**
 * The greppable markers an OpenNeuro import puts in front of a failure line.
 *
 * The onboard workflow forwards the CLI's failure line into `import_jobs.last_error`, and the
 * Worker's classifier (`backend/src/services/import-failure-cause.ts`) and recovery read these
 * literals there; the backend keeps its own copies, pinned to these by tests, because the CLI and
 * the Worker share no module. A module of their own so the prepare phase and its scrub step can
 * both import them without importing each other.
 */

/**
 * Distinct, greppable marker for "this import failed because OpenNeuro's own data
 * is unreachable" (objects not anonymously public + no signed login) vs a NEMAR
 * bug. Surfaces in the prepare error + workflow log so these datasets are
 * understood and can be collected into a tracking list. (#808)
 */
export const OPENNEURO_UPSTREAM_MARKER = "[openneuro-upstream-inaccessible]";

/**
 * Marker for "the import's identifier scrub refused" (ADR 0089): it could not read, verify or
 * scrub a recording header, or the bytes it must move exceed the bound. The word after
 * `refused:` says which, from a closed list (`IMPORT_SCRUB_REFUSALS` in `import-scrub.ts`).
 */
export const IMPORT_SCRUB_MARKER = "[nemar-identifier-scrub]";

/**
 * The tag pin's and the #1320 preflight's markers (epic #1046). Defined in `shared/`, where the
 * Worker imports them too, so unlike the two above they have no backend copy to pin.
 */
export {
  NEMAR_ANNEX_UUID_CONFLICT_MARKER,
  OPENNEURO_MIRROR_LAG_MARKER,
  OPENNEURO_UPSTREAM_MOVED_MARKER,
} from "../../shared/import-markers.js";
import type { ImportRefusalMarker } from "../../shared/import-markers.js";
export type { ImportRefusalMarker };

/**
 * A refusal by the import, carrying one of the markers above at the start of its message (the tag
 * pin's and the #1320 preflight's). `prepareImport` catches it in one place, prints the message as
 * the run's last failure line (the onboard workflow's reporter forwards the last `✖` line into
 * `import_jobs.last_error`), clears stale staging when the run persists it, and exits non-zero. When one is thrown nothing
 * has been reset, pushed or copied into the bucket, and a mirror lag has not even created the
 * dataset; that is what makes it a refusal rather than a failure.
 */
export class ImportRefused extends Error {
  constructor(
    readonly marker: ImportRefusalMarker,
    detail: string,
  ) {
    super(`${marker} ${detail}`);
    this.name = "ImportRefused";
  }
}
