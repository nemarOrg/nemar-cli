// App-wide backend constants for the dataset-store consolidation (#646).

/**
 * Sentinel owner for legacy catalog-only datasets folded into `datasets`
 * (migration 0028). These rows have no real user behind them.
 *
 * The id is NEGATIVE on purpose:
 *   - guaranteed free on every environment (real users.id are AUTOINCREMENT
 *     positives starting at 1, and id=1/2/... are already taken),
 *   - inserting it does NOT bump the users AUTOINCREMENT sequence
 *     (sqlite_sequence only tracks the max positive rowid), so the next real
 *     user keeps getting the next natural id,
 *   - identical compile-time value across dev and prod, so SQL guards
 *     (`owner_user_id != SYSTEM_USER_ID`) and the source_type discriminator
 *     are deterministic.
 *
 * Use this to discriminate folded "catalog" rows from real "managed" rows:
 *   source_type = owner_user_id = SYSTEM_USER_ID ? 'catalog' : 'managed'.
 */
export const SYSTEM_USER_ID = -1;

/** Username of the sentinel system owner created in migration 0027. */
export const SYSTEM_USER_USERNAME = "nemar-system";
