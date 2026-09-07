/**
 * One place that turns a D1 boolean column into a JavaScript boolean.
 *
 * SQLite has no boolean type, so every flag on `users` is an INTEGER with a
 * `NOT NULL DEFAULT 0` — `email_verified` (0001), `orcid_verified` (0050),
 * `service_access` (0062), `identity_conflict` (0077),
 * `username_auto_assigned` (0079). Each one is read by several SELECTs and
 * converted at each of them, and the conversions were drifting into three
 * spellings for one question: `x === 1`, `!!x`, and `x === true || x === 1` for
 * a value that might already have been normalised upstream.
 *
 * They are not equivalent. `!!x` says true for any non-zero integer AND for a
 * non-empty string, so a column that ever held something unexpected reads as
 * set; `x === 1` says false for a `true` that a caller had already converted.
 * This is the third spelling, which is the correct one for both directions, and
 * it lives here so a new flag column has somewhere obvious to be read from
 * rather than a fourth spelling to invent.
 *
 * Lifted out of services/profile-gaps.ts (#1268 review), where it was a private
 * helper doing exactly this for the three flags the gap matrix reads.
 */

/**
 * True for the SQLite integer 1 and for a boolean `true`; false for everything
 * else, INCLUDING null and undefined.
 *
 * `null | undefined` is accepted rather than pushed onto callers because the
 * common shape is `flag(row?.some_column)` on a row that may not have been
 * found — and an absent row's flag is not set, which is the same answer as 0.
 */
export function flag(value: number | boolean | null | undefined): boolean {
  return value === true || value === 1;
}
