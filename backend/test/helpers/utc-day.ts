/**
 * Keep a test inside one UTC day on the database's own clock.
 *
 * The re-pull's daily caps (the merge cap, `MERGE_CLAIMS_TODAY_SQL`; the open cap,
 * `OPEN_DISPATCHES_TODAY_SQL`) count a fixed UTC day with `date('now')` inside the statement
 * (ADR 0099: a fixed window on D1's clock), and none of the functions that claim takes a clock to
 * fix the instant. So a test that makes several claims and expects them in one day fails when it
 * runs across 00:00 UTC. Awaited before such a test: when less than `marginMs` is left of the UTC
 * day, it waits, polling, for the day to turn. The wait happens only in that margin before
 * midnight and is at most the margin; the tests it guards take well under a second.
 */

import type { Database } from "bun:sqlite";

/** What is left of the UTC day on `db`'s clock, in milliseconds: one statement, so one `now`. */
const LEFT_OF_DAY_SQL =
  "SELECT (julianday(date('now', '+1 day')) - julianday('now')) * 86400000.0 AS ms";

export async function insideOneUtcDay(db: Database, marginMs = 2_000): Promise<void> {
  const left = () => (db.query(LEFT_OF_DAY_SQL).get() as { ms: number }).ms;
  const first = left();
  if (first >= marginMs) return;
  // The day turns in `first` milliseconds, so a second past that is the deadline.
  const deadline = Date.now() + first + 1_000;
  while (left() < marginMs) {
    if (Date.now() > deadline) {
      throw new Error(`the UTC day did not turn within ${Math.ceil(first) + 1_000} ms`);
    }
    await Bun.sleep(50);
  }
}
