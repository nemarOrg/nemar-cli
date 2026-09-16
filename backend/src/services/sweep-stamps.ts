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

/**
 * Verdict of the last ANONYMITY sweep (#1409, epic #1406):
 * `verified` | `findings` | `unverifiable`.
 *
 * `findings` rather than `failed`, deliberately. The fidelity sweep's `failed`
 * means the serving copy misrepresents the data, which is always NEMAR's bug.
 * This sweep reports two different kinds of thing under one verdict: an
 * invariant NEMAR owns that has stopped holding, and a name the DEPOSITOR left
 * in their own file. Only the first is a bug, neither is repaired here, and a
 * word that implies "we broke it" would misdirect the person who has to act.
 */
export const ANONYMITY_STATUS_PATH = "$.anonymity_status";

/** When that verdict was written. Absent until a verdict exists. */
export const ANONYMITY_CHECKED_AT_PATH = "$.anonymity_checked_at";

/**
 * The findings themselves: a JSON array of `{check, severity, detail}`.
 *
 * Stored so `nemar dataset status` and the admin queue can show WHAT was found
 * without re-running the sweep, and so a depositor who deleted the email still
 * has it. The matched TEXT is never stored -- only the check id, the file, and
 * a count -- because this column is read by surfaces that were built to serve
 * a dataset's metadata, and a leak quoted into one of them is a leak.
 */
export const ANONYMITY_FINDINGS_PATH = "$.anonymity_findings";

/**
 * What the run could NOT check, as a JSON array of check ids.
 *
 * Its own path rather than a flag inside a finding, because absence of evidence
 * has to survive the trip to every reader (ADR 0005, ADR 0054: unknown is never
 * rendered as zero). Signal headers are annexed binaries and are therefore
 * ALWAYS in here; a run that also lost its EZID call adds that one. A reader
 * that shows "no findings" while this list is non-empty is lying by omission.
 */
export const ANONYMITY_UNCHECKED_PATH = "$.anonymity_unchecked";

/**
 * When the sweep last ATTEMPTED this dataset, whatever came of it.
 *
 * Same role as `ZARR_VERIFY_ATTEMPTED_AT_PATH` and adopted for the same reason:
 * a dataset whose manifest or EZID record is unreachable produces no verdict,
 * so without this it would be re-selected first on every run forever and the
 * datasets behind it would never be swept at all.
 */
export const ANONYMITY_ATTEMPTED_AT_PATH = "$.anonymity_attempted_at";

/**
 * When the archive last asked for this dataset's Zarr stores to be rebuilt.
 *
 * Written by the publication orchestrator when a deposit is de-anonymized, and
 * read by `scripts/zarr/zarr_queue.py` off the public catalog row. It exists
 * because the conversion pipeline had no per-dataset re-conversion lever at
 * all: `reconcile` re-queues on a `latest_version` change or a GLOBAL
 * `ZARR_ENGINE_VERSION` bump, and de-anonymization changes neither -- the tag
 * comes from the depositor's own `Version` field and `createTag` treats an
 * existing ref as success. Without this, a dataset published out of anonymity
 * keeps serving `citation: "Anonymous (withheld until publication)"` and no
 * DOI in `index.json` and in every store's `nemar` attribute, indefinitely.
 *
 * A timestamp rather than a boolean: the converter records the value it last
 * converted against, so "changed since" is the question, and a flag would have
 * to be cleared by the consumer -- which is on the other side of a cron on
 * another host.
 */
export const ZARR_REQUEUE_AT_PATH = "$.zarr_requeue_at";
