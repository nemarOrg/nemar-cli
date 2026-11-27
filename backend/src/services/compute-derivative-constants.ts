/**
 * The names and read bounds the derivative store shares with the modules it calls (ADR 0123): the object prefix
 * every derivative is stored under, and the bounds every reader of a run's dataset record and recordings table
 * takes. They live here, in a module that imports nothing of the services, so the store can import the progress
 * module (`resolveDecidedStored`) and the quality modules can read the prefix without either importing the other
 * back. `compute-derivatives.ts` re-exports them for its existing callers.
 */

import { QUALITY_TABLE_MAX_BYTES } from "../../../shared/contract/quality-route.js";

/** The most a derivative row's objects are named by: `d/<key>/<relative path>`. */
export const DERIVATIVE_OBJECT_PREFIX = "d/";

/** The recipe's dataset record is at most 256 KB; the read bound is the stamp sync's own. */
export const RECORD_READ_MAX_BYTES = 512 * 1024;

/**
 * The recordings table of a dataset of 25,000 stores is a few megabytes; this is a bound, not a size. It is
 * the quality route's own (`QUALITY_TABLE_MAX_BYTES`), so every reader of a run's table (reconciliation,
 * keying, the admin listing and the processing endpoint) takes the same tables.
 */
export const TABLE_READ_MAX_BYTES = QUALITY_TABLE_MAX_BYTES;
