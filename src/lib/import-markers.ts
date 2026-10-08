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
