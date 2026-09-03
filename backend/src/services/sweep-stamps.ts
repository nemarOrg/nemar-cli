/**
 * The `datasets.sweep_stamps` JSON paths, in one place.
 *
 * `sweep_stamps` is the single JSON column that holds per-sweep bookkeeping so
 * each new sweep does not spend the `datasets` column budget (ADR 0034). That
 * makes the PATH the interface: `'$.zarr_verify_status'` was written by the
 * fidelity sweep and read, spelled out by hand, in four unrelated files
 * (`routes/datasets/catalog.ts` twice, `services/zarr-catalog.ts`,
 * `services/dataset-filters.ts`) with no test crossing the seam. A typo in any
 * one of them is not a compile error and not a query error either -- SQLite's
 * `json_extract` returns NULL for a path that matches nothing, so the reader
 * simply sees "never swept" forever, which is precisely what the sweep exists
 * to distinguish from "swept and fine".
 *
 * Importing the constant does not by itself make a query correct, but it does
 * mean one edit changes every site, and a renamed key breaks the build rather
 * than quietly emptying a filter.
 */

/** Verdict of the last fidelity sweep: verified | failed | unverifiable. */
export const ZARR_VERIFY_STATUS_PATH = "$.zarr_verify_status";

/** When that verdict was written. Absent until a verdict exists. */
export const ZARR_VERIFIED_AT_PATH = "$.zarr_verified_at";

/** The `zarr_source_commit` the verdict was reached against. */
export const ZARR_VERIFIED_COMMIT_PATH = "$.zarr_verified_commit";

/**
 * When the sweep last ATTEMPTED this dataset, whatever came of it.
 *
 * Distinct from `zarr_verified_at`, and the distinction is the point: a dataset
 * whose index cannot be fetched (S3 unreachable, credentials rotated, its own
 * fetch budget spent) produces no verdict, so it stamps no `zarr_verified_at`
 * and stays a candidate. With candidates ordered by `dataset_id`, the ~25
 * alphabetically earliest such datasets were re-selected on every run forever
 * and nothing behind them was ever swept. Ordering by this stamp instead
 * (never-attempted first, then oldest attempt) keeps the queue moving without
 * ever recording a verdict that was not reached.
 */
export const ZARR_VERIFY_ATTEMPTED_AT_PATH = "$.zarr_verify_attempted_at";
