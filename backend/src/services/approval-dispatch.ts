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
 *   2. `approving` with a fresh `updated_at`. A terminal approval never sets
 *      `approval_dispatched_at`, so without this clause the web could start a
 *      second run beside a person's own.
 *
 * Both are limited to a request that can still run (`requested` or `approving`):
 * a `published`, `denied` or `blocked` row has no run to protect, and a row
 * published a minute after its dispatch must not read as in flight.
 *
 * A FAILED run is the exception to "live for the whole lease". The orchestrator
 * records a step's failure in `last_error` and answers 500; the caller then
 * either gives up or retries. Treating the failure as "still running" for the
 * rest of the lease would hold a dead run for up to fifteen minutes. But
 * treating it as stopped AT ONCE would be wrong too: the CLI retries a failed
 * step after a fixed wait (`APPROVE_RETRY_DELAY_MS`, 10 seconds, up to five
 * times), and an executor launched in that wait would run beside the retry that
 * is about to start. So a failed run stays in flight for
 * {@link FAILED_RUN_GRACE_SECONDS}, comfortably longer than that wait, and is
 * stalled after it. A retry clears `last_error` as it starts (the orchestrator's
 * request-start UPDATE) and so is in flight again at once, and so is a fresh
 * dispatch (the claim clears it): the previous attempt's error is history.
 */

/** How long a run stays "in flight" after its last sign of life. */
export const APPROVAL_LEASE_MINUTES = 15;

/**
 * How long a run that recorded an error stays in flight after recording it.
 * Must outlast the CLI's wait between attempts; a test binds it to
 * `APPROVE_RETRY_DELAY_MS` so the two cannot drift apart.
 */
export const FAILED_RUN_GRACE_SECONDS = 60;

/**
 * SQL boolean expression: this `publication_requests` row's lease is live, by
 * time alone (the two clauses above), ignoring whether the run has failed.
 * `columnPrefix` qualifies the columns (`"pr."` in a join, `""` in an UPDATE's
 * WHERE). The interpolated value is a module constant, never input.
 *
 * Used where "is anything still associated with this request" is the question
 * rather than "is it running right now": attribution, which must keep naming
 * the admin who clicked across a failed step's retries.
 */
export function approvalLeaseLiveSql(columnPrefix = ""): string {
  const p = columnPrefix;
  const since = `datetime('now', '-${APPROVAL_LEASE_MINUTES} minutes')`;
  return `(${p}status IN ('requested', 'approving') AND (
      (${p}approval_dispatched_at IS NOT NULL AND ${p}approval_dispatched_at >= ${since})
      OR (${p}status = 'approving' AND ${p}updated_at >= ${since})
    ))`;
}

/**
 * SQL boolean expression: this row has a live approval run RIGHT NOW. The
 * lease is live, and the run has not failed more than
 * {@link FAILED_RUN_GRACE_SECONDS} ago. This is what the dispatch claim and the
 * list route's `approval_in_flight` read.
 */
export function approvalInFlightSql(columnPrefix = ""): string {
  const p = columnPrefix;
  const failedBefore = `datetime('now', '-${FAILED_RUN_GRACE_SECONDS} seconds')`;
  return `(${approvalLeaseLiveSql(p)} AND (${p}last_error IS NULL OR ${p}updated_at >= ${failedBefore}))`;
}

/**
 * The newest request an approval could act on, for one dataset. The orchestrator
 * (`runPublicationApproval`) and the dispatch route both read it, and it must be
 * the SAME row: the executor's `/approve` call picks its request with this, so a
 * dispatch that claimed a different row would put the clicking admin on a
 * request the run never touches. `blocked` is included because `/approve` acts
 * on it; the dispatch route then refuses it separately. Selected columns are the
 * caller's: this is only the WHERE / ORDER tail, bound with the dataset id.
 */
export const ACTIVE_REQUEST_TAIL_SQL = `FROM publication_requests
   WHERE dataset_id = ? AND status IN ('requested', 'approving', 'blocked')
   ORDER BY requested_at DESC LIMIT 1`;

/** Who a publication is recorded as approved by. */
export interface Approver {
  id: number;
  username: string;
}

/**
 * The approver of a run: the admin who clicked Approve on the website while that
 * click's run is still live, otherwise the account calling `/approve`.
 *
 * Attribution forks on purpose (ADR 0080). An executor authenticates with its
 * own service key, so without this the `approved_by` column and the
 * `dataset_published` audit row would name the bot for every web approval. A
 * terminal approval never sets `approval_requested_by`, so it falls through to
 * the caller and behaves exactly as it always has; the caller is the person.
 *
 * `approval_requested_by` is honored only while the lease is live
 * (`approvalLeaseLiveSql`, by time alone). The column is never cleared, so
 * without this a run that lapsed and was later resumed by a different admin at a
 * terminal would be recorded as the original clicker's approval, naming someone
 * who never saw that run finish. The caller evaluates `leaseLive` at the TOP of
 * `/approve`, before the request-start UPDATE bumps the heartbeat: every batch
 * call of a long web run arrives with a fresh `updated_at` and so still resolves
 * to the clicker, and so does the retry of a failed step (which is why this
 * reads the time-only lease and not the failure-aware in-flight predicate: a
 * failure must not strip the attribution from the retry that finishes the run).
 *
 * The cost, stated in the ADR: a web run that sat quiet for longer than the
 * lease before its first `/approve` call is recorded under the executing key,
 * with `executed_by` still in the audit details.
 *
 * A clicker whose account row is gone falls back to the caller rather than
 * failing a publication that is already underway; the dispatch left its own
 * audit row naming the clicker by id.
 */
export async function resolveApprover(
  db: D1Database,
  approvalRequestedBy: number | null,
  leaseLive: boolean,
  caller: Approver,
): Promise<Approver> {
  if (approvalRequestedBy === null || !leaseLive) return caller;
  const clicker = await db
    .prepare("SELECT id, username, email FROM users WHERE id = ?")
    .bind(approvalRequestedBy)
    .first<{ id: number; username: string | null; email: string }>();
  if (!clicker) return caller;
  // Web-only accounts may have no username yet; the address still names them.
  return { id: clicker.id, username: clicker.username || clicker.email };
}
