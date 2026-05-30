/**
 * Stale-dataset warning logic for the scheduled cleanup cron (#662).
 *
 * Private `nm` datasets with no concept DOI are eligible for cleanup once they
 * have been inactive for STALENESS_LIMIT_DAYS. Rather than silently deleting
 * them (which destroyed nm000111/116/117), the cron now emails the owner an
 * escalating series of warnings, then hands off to admins for a manual,
 * deliberate deletion.
 *
 * These helpers are pure (no I/O) so the threshold maths is unit-testable.
 */

/** A dataset is eligible for cleanup once inactive this many days. */
export const STALENESS_LIMIT_DAYS = 90;

/**
 * Owner-warning thresholds expressed as days-until-deletion, most→least time.
 * The owner is emailed once as the dataset crosses into each bucket.
 */
export const WARNING_THRESHOLDS = [30, 14, 7, 2, 1] as const;

/** The widest warning threshold; nothing is warned before this many days left. */
export const FIRST_WARNING_DAYS = WARNING_THRESHOLDS[0];

const MS_PER_DAY = 86_400_000;

/**
 * Whole days elapsed since `effectiveActivity` as of `now`.
 *
 * `effectiveActivity` is the dataset's `COALESCE(last_activity_at, created_at)`
 * timestamp (SQLite `datetime()` format, treated as UTC). Returns a floored,
 * non-negative day count; a future timestamp yields 0.
 */
export function ageInDays(effectiveActivity: string, now: Date): number {
  const then = parseSqliteUtc(effectiveActivity);
  if (then === null) return 0;
  const days = Math.floor((now.getTime() - then) / MS_PER_DAY);
  return days < 0 ? 0 : days;
}

/**
 * Days remaining until the dataset reaches the 90-day deletion deadline.
 * Zero or negative means the deadline has passed.
 */
export function daysUntilDeletion(effectiveActivity: string, now: Date): number {
  return STALENESS_LIMIT_DAYS - ageInDays(effectiveActivity, now);
}

/**
 * The warning threshold to emit for a given days-until-deletion, or null when
 * the dataset is outside the warning window (more than FIRST_WARNING_DAYS away,
 * or already at/past the deadline).
 *
 * Returns the most-urgent threshold the dataset has crossed, i.e. the smallest
 * WARNING_THRESHOLDS value that is still >= daysLeft. Example: 20 days left →
 * 30 (crossed the 30-day mark, not yet the 14-day one); 5 days left → 7.
 */
export function warningStageForDaysLeft(daysLeft: number): number | null {
  if (daysLeft <= 0 || daysLeft > FIRST_WARNING_DAYS) return null;
  let stage: number | null = null;
  for (const threshold of WARNING_THRESHOLDS) {
    if (daysLeft <= threshold) stage = threshold;
  }
  return stage;
}

/**
 * The calendar date (UTC, "YYYY-MM-DD") on which a dataset reaches its 90-day
 * deletion deadline, for display in owner warning emails. Returns "soon" when
 * the activity timestamp can't be parsed.
 */
export function deletionDate(effectiveActivity: string): string {
  const then = parseSqliteUtc(effectiveActivity);
  if (then === null) return "soon";
  return new Date(then + STALENESS_LIMIT_DAYS * MS_PER_DAY).toISOString().slice(0, 10);
}

/**
 * Parse a SQLite `datetime('now')` string ("YYYY-MM-DD HH:MM:SS", UTC) into
 * epoch milliseconds. Returns null when unparseable. SQLite emits a space
 * separator and no zone, so we normalise to ISO-8601 UTC before parsing.
 */
function parseSqliteUtc(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const iso = trimmed.includes("T") ? trimmed : trimmed.replace(" ", "T");
  const withZone = /[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}Z`;
  const ms = Date.parse(withZone);
  return Number.isNaN(ms) ? null : ms;
}
