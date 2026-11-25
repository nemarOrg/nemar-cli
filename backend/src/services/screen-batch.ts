/**
 * A paced re-screen of many publication requests, mailed as one digest (epic #2182, card D4;
 * ADR 0086, amendment of 2026-11-25).
 *
 * `nemar admin repo publish screen-batch --apply` creates a batch ({@link createScreenBatch}),
 * then dispatches the screens one at a time through the ordinary re-run route with the batch's
 * id. Each screen stores exactly the result a single `screen` stores, and the gate and the
 * review start are unchanged. What a batch changes is the mail:
 *
 *   - the per-request administrator mail is not sent: the result is stored with its mail marked
 *     covered (`identifier_screen_emailed_at`), so neither the callback, the review's result nor
 *     the watchdog sends it;
 *   - the depositor mail on a block is not sent;
 *   - one digest goes to the administrators when the batch ends ({@link sendDigestIfDue}), and it
 *     NAMES everything the batch did not mail about: the requests it blocked, the ones whose state
 *     changed and the ones that never reported. A mail is never dropped without the digest saying
 *     so.
 *
 * A request SETTLES once: one conditional UPDATE sets `identifier_screen_batch_settled_at` and only
 * a row it returns is counted in `reported`, so a repeated call or a replayed callback never counts
 * a request twice ({@link settleBatchEntry}). The digest is due when the batch is closed or every
 * request has settled, and no request the batch dispatched is still unsettled (so a result stored
 * between a close and its settle is waited for), or two hours after the last dispatch (the
 * watchdog, {@link sweepScreenBatchDigests}). It is claimed with a lease in one conditional UPDATE,
 * so of two callbacks racing for the last report exactly one sends. Once the digest has gone out,
 * a report that arrives late is an ordinary one and is mailed as before: the digest told the
 * administrators it had not reported.
 *
 * The digest says counts, kinds and dataset ids, nothing a workflow wrote beyond what
 * `parseScreenReport` accepted.
 */

import type { FindingKind } from "../../../shared/identifier-scan.js";
import {
  type ScreenState,
  isScreenState,
  kindsPhrase,
  screenErrorText,
  screenStateLabel,
} from "../../../shared/identifier-screen-report.js";
import { SCREEN_BATCH_MAX_SIZE } from "../../../shared/publication-limits.js";
import type { Bindings } from "../types/bindings.js";
import { OPEN_REQUEST_STATUSES_SQL } from "./approval-dispatch.js";
import {
  SCREEN_BATCH_REFUSAL_TEXT,
  type ScreenBatchDigest,
  type ScreenBatchRefusal,
  getAdminEmailsForCategory,
  resolveEmailConfig,
  sendScreenBatchDigestEmail,
} from "./email.js";
import { readStoredReport, readStoredState } from "./identifier-screen-stored.js";

/** The most requests one batch holds: its selection is one JSON column, and D1 bounds a statement at 100 KB. */
export const MAX_BATCH_SIZE = SCREEN_BATCH_MAX_SIZE;

/** The digest is due this long after the last dispatch even when a request never reported. */
export const DIGEST_AFTER_LAST_DISPATCH_MINUTES = 120;

/** How long a claim on the digest holds before the watchdog may retake it. */
export const DIGEST_LEASE_MINUTES = 5;

/** Batches the watchdog handles per tick. */
export const DIGEST_SWEEP_LIMIT = 5;

const LEASE_NOW_SQL = "strftime('%Y-%m-%d %H:%M:%f', 'now')";
const LEASE_EXPIRED_SQL = `strftime('%Y-%m-%d %H:%M:%f', 'now', '-${DIGEST_LEASE_MINUTES} minutes')`;

/**
 * True while the request's batch has not sent its digest. In a SET clause on `publication_requests`
 * it reads the row's own batch id. A module constant of fixed text, never input.
 */
export const BATCH_DIGEST_OPEN_SQL = `EXISTS (SELECT 1 FROM screen_batches b
        WHERE b.id = publication_requests.identifier_screen_batch_id AND b.digest_sent_at IS NULL)`;

/**
 * The value `identifier_screen_emailed_at` takes when a result is stored or timed out: stamped
 * (the digest covers the mail) while the request's batch has not sent its digest, NULL (the mail
 * is owed, as for any screen) otherwise, which includes a request with no batch.
 */
export const MAIL_COVERED_BY_DIGEST_SQL = `CASE WHEN ${BATCH_DIGEST_OPEN_SQL} THEN datetime('now') ELSE NULL END`;

/**
 * When a batch's digest is due, as a condition on `screen_batches` (an UPDATE's or a SELECT's WHERE):
 * closed, or every request settled, with no request the batch dispatched still unsettled; or two
 * hours since the last dispatch. A module constant of fixed text, never input.
 */
const DIGEST_DUE_SQL = `(
  ((closed_at IS NOT NULL OR reported >= total)
    AND NOT EXISTS (SELECT 1 FROM publication_requests pr
                     WHERE pr.identifier_screen_batch_id = screen_batches.id
                       AND pr.identifier_screen_batch_settled_at IS NULL))
  OR last_dispatch_at < datetime('now', '-${DIGEST_AFTER_LAST_DISPATCH_MINUTES} minutes'))`;

/** One request of a batch, as stored: [request id, dataset id, screen state before, status before]. */
export type SelectionEntry = [number, string, string | null, string];

export interface CreatedBatch {
  batchId: number;
  total: number;
  /** Dataset ids with no open request, by id; they are not in the batch. */
  skipped: string[];
}

/** Dataset ids in chunks that stay inside D1's bound-parameter budget. */
const ID_CHUNK = 50;

/**
 * Create a batch for the active publication requests of `datasetIds` (at most
 * {@link MAX_BATCH_SIZE}). The screen state and the status of each request at this instant are
 * kept, so the digest can say what changed. Ids with no open request, and repeated ids, are not
 * in the batch; the first are returned in `skipped`. Returns null when none is left.
 */
export async function createScreenBatch(
  env: Bindings,
  createdBy: number,
  datasetIds: readonly string[],
): Promise<CreatedBatch | null> {
  const wanted = [...new Set(datasetIds)];
  const found = new Map<string, { id: number; status: string; screen: string | null }>();
  for (let i = 0; i < wanted.length; i += ID_CHUNK) {
    const chunk = wanted.slice(i, i + ID_CHUNK);
    const rows = await env.DB.prepare(
      `SELECT id, dataset_id, status, identifier_screen_status AS screen
         FROM publication_requests
        WHERE dataset_id IN (${chunk.map(() => "?").join(", ")})
          AND status IN ${OPEN_REQUEST_STATUSES_SQL}
        ORDER BY requested_at DESC, id DESC`,
    )
      .bind(...chunk)
      .all<{ id: number; dataset_id: string; status: string; screen: string | null }>();
    // Newest first, so the first row of a dataset is the request an approval would act on.
    for (const r of rows.results) {
      if (!found.has(r.dataset_id)) found.set(r.dataset_id, r);
    }
  }
  const selection: SelectionEntry[] = [];
  const skipped: string[] = [];
  for (const id of wanted) {
    const r = found.get(id);
    if (!r) skipped.push(id);
    else selection.push([r.id, id, readStoredState(r.screen), r.status]);
  }
  if (selection.length === 0) return null;
  const res = await env.DB.prepare(
    "INSERT INTO screen_batches (created_by, total, selection) VALUES (?, ?, ?) RETURNING id",
  )
    .bind(createdBy, selection.length, JSON.stringify(selection))
    .first<{ id: number }>();
  if (!res) throw new Error("the batch could not be recorded");
  return { batchId: res.id, total: selection.length, skipped };
}

/** The batch's open state and its selection, or null when it does not exist. */
export async function readScreenBatch(
  env: Bindings,
  batchId: number,
): Promise<{ selection: SelectionEntry[]; digestSent: boolean } | null> {
  const row = await env.DB.prepare(
    "SELECT selection, digest_sent_at FROM screen_batches WHERE id = ?",
  )
    .bind(batchId)
    .first<{ selection: string; digest_sent_at: string | null }>();
  if (!row) return null;
  return { selection: parseSelection(row.selection), digestSent: row.digest_sent_at !== null };
}

/** The selection column, read back without trusting it: an entry of the wrong shape is dropped. */
export function parseSelection(raw: string): SelectionEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: SelectionEntry[] = [];
  for (const e of parsed) {
    if (
      Array.isArray(e) &&
      e.length === 4 &&
      typeof e[0] === "number" &&
      typeof e[1] === "string" &&
      (e[2] === null || typeof e[2] === "string") &&
      typeof e[3] === "string"
    ) {
      out.push([e[0], e[1], e[2], e[3]]);
    }
  }
  return out;
}

/** A dispatch went out: the two-hour clock to the digest restarts. Never throws. */
export async function noteBatchDispatch(env: Bindings, batchId: number): Promise<void> {
  try {
    await env.DB.prepare(
      "UPDATE screen_batches SET last_dispatch_at = datetime('now') WHERE id = ?",
    )
      .bind(batchId)
      .run();
  } catch (err) {
    console.error(
      `[screen-batch] could not record a dispatch of batch ${batchId}: ${errorText(err)}`,
    );
  }
}

/**
 * One request the batch dispatched has settled (a stored report, or a screen that could not
 * start): count it once, and send the digest if that was the last. The statement that marks it
 * settled is the dedupe: it matches only a row of THIS batch that is not yet settled, so a second
 * call for the same request (a replayed callback, a repeated dispatch) counts nothing. A request
 * the batch had already counted as refused is not counted again. Never throws.
 */
export async function settleBatchEntry(
  env: Bindings,
  batchId: number,
  requestId: number,
): Promise<void> {
  try {
    const settled = await env.DB.prepare(
      `UPDATE publication_requests SET identifier_screen_batch_settled_at = datetime('now')
        WHERE id = ? AND identifier_screen_batch_id = ?
          AND identifier_screen_batch_settled_at IS NULL
        RETURNING dataset_id`,
    )
      .bind(requestId, batchId)
      .first<{ dataset_id: string }>();
    if (!settled) return;
    await env.DB.prepare(
      `UPDATE screen_batches
          SET reported = reported + CASE WHEN EXISTS (
                SELECT 1 FROM json_each(COALESCE(refused, '[]'))
                 WHERE json_extract(value, '$[0]') = ?) THEN 0 ELSE 1 END
        WHERE id = ?`,
    )
      .bind(settled.dataset_id, batchId)
      .run();
  } catch (err) {
    console.error(`[screen-batch] could not count a report of batch ${batchId}: ${errorText(err)}`);
    return;
  }
  await sendDigestIfDue(env, batchId);
}

/**
 * A request of the batch will not be screened by it, or was screened again outside it: record the
 * reason once per dataset, count it settled (unless it was already counted, as a request that had
 * reported before it was screened again), and send the digest if that was the last. The digest
 * says each reason apart from a screen that could not start and from one that never reported.
 * Never throws.
 */
export async function settleBatchRefusal(
  env: Bindings,
  batchId: number,
  datasetId: string,
  reason: ScreenBatchRefusal,
  alreadyCounted = false,
): Promise<void> {
  try {
    await env.DB.prepare(
      `UPDATE screen_batches
          SET reported = reported + ?,
              refused = json_insert(COALESCE(refused, '[]'), '$[#]', json(?))
        WHERE id = ? AND digest_sent_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM json_each(COALESCE(refused, '[]'))
                           WHERE json_extract(value, '$[0]') = ?)`,
    )
      .bind(alreadyCounted ? 0 : 1, JSON.stringify([datasetId, reason]), batchId, datasetId)
      .run();
  } catch (err) {
    console.error(
      `[screen-batch] could not record a refusal in batch ${batchId}: ${errorText(err)}`,
    );
    return;
  }
  await sendDigestIfDue(env, batchId);
}

/**
 * The administrator stopped dispatching. Records `closed_at` and leaves `total` alone: the digest
 * is then due once no request the batch dispatched is unsettled, so a result stored after the
 * close but not yet settled is still waited for. A batch with nothing dispatched is due at once.
 * Returns false when the batch does not exist or its digest has gone out; closing twice is fine.
 */
export async function closeScreenBatch(env: Bindings, batchId: number): Promise<boolean> {
  const res = await env.DB.prepare(
    `UPDATE screen_batches SET closed_at = COALESCE(closed_at, datetime('now'))
      WHERE id = ? AND digest_sent_at IS NULL`,
  )
    .bind(batchId)
    .run();
  if ((res.meta.changes ?? 0) !== 1) return false;
  await sendDigestIfDue(env, batchId);
  return true;
}

export type DigestOutcome = "sent" | "not-due" | "undelivered";

/**
 * Send the batch's digest when it is due and nobody else holds it. Never throws.
 *
 * Due: every request settled, or {@link DIGEST_AFTER_LAST_DISPATCH_MINUTES} after the last
 * dispatch. Claimed with a lease before the send, stamped `digest_sent_at` only after a send that
 * reached at least one administrator, and released when it reached nobody, so the watchdog retries.
 */
export async function sendDigestIfDue(env: Bindings, batchId: number): Promise<DigestOutcome> {
  const db = env.DB;
  let claim: { claim: string; selection: string; refused: string | null } | null;
  try {
    claim = await db
      .prepare(
        `UPDATE screen_batches
            SET digest_claimed_at = ${LEASE_NOW_SQL}
          WHERE id = ? AND digest_sent_at IS NULL
            AND (digest_claimed_at IS NULL OR digest_claimed_at < ${LEASE_EXPIRED_SQL})
            AND ${DIGEST_DUE_SQL}
        RETURNING digest_claimed_at AS claim, selection, refused`,
      )
      .bind(batchId)
      .first();
  } catch (err) {
    console.error(
      `[screen-batch] could not claim the digest of batch ${batchId}: ${errorText(err)}`,
    );
    return "undelivered";
  }
  if (!claim) return "not-due";

  let delivered = 0;
  try {
    const digest = await buildDigest(
      env,
      batchId,
      parseSelection(claim.selection),
      parseRefused(claim.refused),
    );
    const emails = await getAdminEmailsForCategory(env.DB, "publication_request", env);
    if (emails.length > 0) {
      const { fromEmail, replyTo, isDev } = resolveEmailConfig(env);
      const outcome = await sendScreenBatchDigestEmail(
        emails,
        digest,
        env.RESEND_API_KEY,
        fromEmail,
        replyTo,
        isDev,
        env,
      );
      delivered = outcome.delivered;
    }
  } catch (err) {
    console.error(`[screen-batch] digest of batch ${batchId} failed: ${errorText(err)}`);
  }

  try {
    await db
      .prepare(
        delivered > 0
          ? `UPDATE screen_batches SET digest_sent_at = datetime('now'), digest_claimed_at = NULL
              WHERE id = ? AND digest_claimed_at = ?`
          : `UPDATE screen_batches SET digest_claimed_at = NULL
              WHERE id = ? AND digest_claimed_at = ?`,
      )
      .bind(batchId, claim.claim)
      .run();
  } catch (err) {
    console.error(
      `[screen-batch] could not record the digest of batch ${batchId}; the lease will expire and be retried: ${errorText(err)}`,
    );
  }
  if (delivered > 0) return "sent";
  console.warn(`[screen-batch] digest of batch ${batchId} reached nobody; released for retry`);
  return "undelivered";
}

/** The `refused` column, read back without trusting it: dataset id to reason, unknown words dropped. */
export function parseRefused(raw: string | null): Map<string, ScreenBatchRefusal> {
  const out = new Map<string, ScreenBatchRefusal>();
  if (!raw) return out;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      for (const e of parsed) {
        if (
          Array.isArray(e) &&
          typeof e[0] === "string" &&
          typeof e[1] === "string" &&
          e[1] in SCREEN_BATCH_REFUSAL_TEXT
        ) {
          out.set(e[0], e[1] as ScreenBatchRefusal);
        }
      }
    }
  } catch {
    // An unreadable column names nobody; every request without a stored result is still listed.
  }
  return out;
}

/**
 * What the digest says, read from the requests' rows now. Every request of the selection is in
 * exactly one of three places: reported (a screen result is stored), not started (the screen could
 * not start, the dispatch was refused or never made, each with its reason), or did not report
 * (dispatched, no result by the deadline).
 */
async function buildDigest(
  env: Bindings,
  batchId: number,
  selection: SelectionEntry[],
  refused: Map<string, ScreenBatchRefusal>,
): Promise<ScreenBatchDigest> {
  const rows = new Map<
    number,
    {
      status: string;
      block_reason: string | null;
      screen: string | null;
      report: string | null;
      batch: number | null;
    }
  >();
  for (let i = 0; i < selection.length; i += ID_CHUNK) {
    const chunk = selection.slice(i, i + ID_CHUNK).map((e) => e[0]);
    const got = await env.DB.prepare(
      `SELECT id, status, block_reason, identifier_screen_status AS screen,
              identifier_screen_report AS report, identifier_screen_batch_id AS batch
         FROM publication_requests WHERE id IN (${chunk.map(() => "?").join(", ")})`,
    )
      .bind(...chunk)
      .all<{
        id: number;
        status: string;
        block_reason: string | null;
        screen: string | null;
        report: string | null;
        batch: number | null;
      }>();
    for (const r of got.results) rows.set(r.id, r);
  }

  const NO_SCREEN = "no screen on record";
  const NOT_STARTED = "not started";
  const RESCREENED = "screened again outside the batch";
  const beforeCounts = new Map<string, number>();
  const afterCounts = new Map<string, number>();
  const kinds: Partial<Record<FindingKind, number>> = {};
  const changed: ScreenBatchDigest["changed"] = [];
  const blocked: string[] = [];
  const notReported: string[] = [];
  const notStarted: ScreenBatchDigest["notStarted"] = [];
  const rescreened: string[] = [];
  const stillBlocked: ScreenBatchDigest["stillBlocked"] = [];
  const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
  let reported = 0;

  for (const [requestId, datasetId, beforeState, beforeStatus] of selection) {
    const before =
      beforeState && isScreenState(beforeState) ? screenStateLabel(beforeState) : NO_SCREEN;
    bump(beforeCounts, before);
    const row = rows.get(requestId);
    const state: ScreenState | null = row ? readStoredState(row.screen) : null;
    const inBatch = row !== undefined && row.batch === batchId;
    if (!row || !inBatch) {
      // Not (or no longer) this batch's screen: screened again outside it, refused with the reason
      // the route gave, or never reached.
      const why = refused.get(datasetId) ?? "not-dispatched";
      if (why === "rescreened") {
        bump(afterCounts, RESCREENED);
        rescreened.push(datasetId);
      } else {
        bump(afterCounts, NOT_STARTED);
        notStarted.push({ datasetId, reason: SCREEN_BATCH_REFUSAL_TEXT[why] });
      }
      continue;
    }
    if (state === null || state === "pending" || state === "unreported") {
      bump(afterCounts, "did not report");
      notReported.push(datasetId);
      continue;
    }
    const report = readStoredReport(row.report);
    if (report?.error === "dispatch-unconfigured" || report?.error === "dispatch-failed") {
      // The screen could not start: its error is stored, but no screen ran.
      bump(afterCounts, NOT_STARTED);
      notStarted.push({ datasetId, reason: screenErrorText(report.error) });
      continue;
    }
    reported++;
    const after = screenStateLabel(state);
    bump(afterCounts, after);
    for (const [kind, n] of Object.entries(report?.scan?.findings_by_kind ?? {})) {
      kinds[kind as FindingKind] = (kinds[kind as FindingKind] ?? 0) + (n ?? 0);
    }
    const nowBlocked = row.status === "blocked" && beforeStatus !== "blocked";
    if (nowBlocked) blocked.push(datasetId);
    if (row.status === "blocked" && beforeStatus === "blocked") {
      // A batch never changes a block, so whatever the screen found, the request is still blocked.
      stillBlocked.push({ datasetId, from: before, to: after });
    } else if (after !== before || nowBlocked) {
      changed.push({ datasetId, from: before, to: after, nowBlocked });
    }
  }

  return {
    batchId,
    // The requests the batch was made for: the digest answers for every one of them.
    total: selection.length,
    reported,
    before: [...beforeCounts],
    after: [...afterCounts],
    kinds: kindsPhrase(kinds),
    changed,
    blocked,
    stillBlocked,
    notStarted,
    rescreened,
    notReported,
  };
}

/**
 * The watchdog's pass over digests that are due and not sent: a batch whose last request never
 * reported (two hours after its last dispatch), or one whose send reached nobody. Production only
 * by its caller. Returns the digests sent.
 */
export async function sweepScreenBatchDigests(env: Bindings): Promise<{
  sent: number;
  undelivered: number;
  errors: number;
}> {
  const out = { sent: 0, undelivered: 0, errors: 0 };
  let due: { id: number }[] = [];
  try {
    due = (
      await env.DB.prepare(
        `SELECT id FROM screen_batches
          WHERE digest_sent_at IS NULL
            AND (digest_claimed_at IS NULL OR digest_claimed_at < ${LEASE_EXPIRED_SQL})
            AND ${DIGEST_DUE_SQL}
          ORDER BY id LIMIT ?`,
      )
        .bind(DIGEST_SWEEP_LIMIT)
        .all<{ id: number }>()
    ).results;
  } catch (err) {
    out.errors++;
    console.error(`[screen-batch-sweep] due query failed: ${errorText(err)}`);
  }
  for (const { id } of due) {
    const outcome = await sendDigestIfDue(env, id);
    if (outcome === "sent") out.sent++;
    else if (outcome === "undelivered") out.undelivered++;
  }
  return out;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : "unknown error";
}
