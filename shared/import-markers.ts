/**
 * Markers an OpenNeuro import puts in front of a refusal, read back by the Worker (epic #1046,
 * ADR 0111 decision 10; #1320).
 *
 * The CLI prints one at the start of its failure line, the onboard workflow forwards that line into
 * `import_jobs.last_error`, and the Worker's classifier, recovery and retry engine read the literal
 * there. These three are defined once, here, and imported by both sides, so there is no backend copy
 * to keep pinned. The older markers (`src/lib/import-markers.ts`) predate this module and keep their
 * pinned copies.
 */

/**
 * The upstream tag being imported is not on OpenNeuro's GitHub mirror yet, or OpenNeuro could not
 * say which tag is its latest. Nothing was created. Transient: the retry engine retries it, and
 * parks it as `mirror_lag` once its retry window has passed.
 */
export const OPENNEURO_MIRROR_LAG_MARKER = "[openneuro-mirror-lag]";

/**
 * The dataset has released a version, its `main` records an upstream tag, and the tag being
 * imported is a different one. Moving a released mirror to a newer snapshot is an upstream re-pull's
 * job (ADR 0111), not a re-import's, so the import refuses before anything is reset or pushed, and
 * the retry engine parks it.
 */
export const OPENNEURO_UPSTREAM_MOVED_MARKER = "[openneuro-upstream-moved]";

/**
 * The bucket's `annex-uuid` names a special remote that the dataset's git-annex branch does not
 * record as `nemar-s3` (#1320). Initialising the remote would fail on it, and every retry would
 * fail the same way, so the import refuses with both uuids and the retry engine parks it.
 */
export const NEMAR_ANNEX_UUID_CONFLICT_MARKER = "[nemar-annex-uuid-conflict]";

/** The markers an import refusal (`ImportRefused` in `src/lib/import-markers.ts`) may carry. */
export type ImportRefusalMarker =
  | typeof OPENNEURO_MIRROR_LAG_MARKER
  | typeof OPENNEURO_UPSTREAM_MOVED_MARKER
  | typeof NEMAR_ANNEX_UUID_CONFLICT_MARKER;
