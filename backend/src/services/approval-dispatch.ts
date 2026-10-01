/**
 * The lease behind a web-launched approval (ADR 0080).
 *
 * A run is "in flight" while something is still driving it, and the database
 * has no heartbeat for that other than two timestamps: `approval_dispatched_at`
 * (set when the dispatch route claims the request) and `updated_at` (bumped by
 * every call to `/approve`, which is every batch of the caller's S3 Object Lock
 * loop and every step the orchestrator records). The run counts as live for
 * {@link APPROVAL_LEASE_MINUTES} after its last sign of life, and the lease
 * simply lapses once the signs stop, which is the only way a crashed or
 * cancelled executor can release it.
 *
 * ONE predicate, two readers. The dispatch route claims with it (a second click,
 * or a second admin, must not start a second run beside the first) and the list
 * route reports it as `approval_in_flight`, so a page never offers a button the
 * route would refuse. Clients must not hard-code the minutes: they read the
 * boolean. That is why this is SQL rather than a function over a row: the claim
 * has to be one atomic conditional UPDATE, and a TypeScript copy for the list
 * would be a second statement of the same rule free to drift from the first.
 *
 * Two clauses, because there are two ways to run an approval:
 *
 *   1. dispatched within the lease. The executor may not have made its first
 *      `/approve` call yet (a queued runner), so `updated_at` alone would call
 *      a freshly dispatched run idle.
 *   2. `approving` with a fresh `updated_at`. A terminal-driven approval never
 *      sets `approval_dispatched_at`, so without this clause the web could start
 *      a second run beside a person's own.
 *
 * Both are limited to a request that can still run (`requested` or
 * `approving`): a `published`, `denied` or `blocked` row has no run to protect,
 * and a row published a minute after its dispatch must not read as in flight.
 *
 * Known limit: a run that FAILS keeps the lease until it lapses, because
 * nothing in the schema says an executor has stopped. An admin who wants to
 * retry sooner approves from a terminal, which this lease does not gate.
 */

/** How long a run stays "in flight" after its last sign of life. */
export const APPROVAL_LEASE_MINUTES = 15;

/**
 * SQL boolean expression: this `publication_requests` row has a live approval
 * run. `columnPrefix` qualifies the columns (`"pr."` in a join, `""` in an
 * UPDATE's WHERE). The interpolated value is a module constant, never input.
 */
export function approvalInFlightSql(columnPrefix = ""): string {
  const p = columnPrefix;
  const since = `datetime('now', '-${APPROVAL_LEASE_MINUTES} minutes')`;
  return `(${p}status IN ('requested', 'approving') AND (
      (${p}approval_dispatched_at IS NOT NULL AND ${p}approval_dispatched_at >= ${since})
      OR (${p}status = 'approving' AND ${p}updated_at >= ${since})
    ))`;
}
