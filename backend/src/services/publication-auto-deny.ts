/**
 * The automatic denial of a publication request, Worker side (ADR 0139, decisions 1 to 4).
 *
 * After a review's result is stored ({@link afterPublicationReviewStored}, called by the result
 * callback before the request's mail):
 *
 *  1. A first run whose `fail` is eligible (`autoDenyEligibility`) starts a confirming run on the
 *     confirming model over the same inputs (`startConfirmingReview`), unless the mode is `off`.
 *     Its live row holds the administrators' mail until it decides.
 *  2. A confirming run's result decides. It confirms when it is eligible too, its input digest is
 *     the first run's, and it names at least one eligible code the first run named; otherwise the
 *     first run is marked `disagreed` and the request goes to the administrators as before. A
 *     request that changed since (no longer waiting, the review no longer in force, anonymous, two
 *     earlier automatic denials) is `not_eligible`.
 *  3. A confirmation claims a place under the daily cap, atomically, BEFORE anything is recorded
 *     as denied or as would-deny. Past the cap the first run is `capped`, and the administrators'
 *     mail says "recommended: deny".
 *  4. In `shadow`, the claim records `would_deny` and nothing else happens. In `on`, and only in
 *     exactly `on`, the shared deny function (`denyPublicationRequest`) denies the request as the
 *     nemarAdmin service account, with the claim, the write, `auto_denied = 1` and the audit row in
 *     ONE batch. The write is guarded on the request still waiting, no approval in flight, the
 *     review still the one in force and the claim just taken; a lost race takes the claim back and
 *     records `not_eligible`. The depositor and the dataset's owner are then mailed.
 *
 * The mode is read from the environment at each step, so switching it off stops a confirmation
 * already running from denying anything. Nothing here throws to its caller but a database fault,
 * which the store logs; the mail follows whatever happened.
 *
 * The administrators' daily digest ({@link sendAutoDenyDigest}) and the reversal
 * ({@link restorePublicationRequest}) are here too.
 */

import { isOneOf } from "../../../shared/pr-review.js";
import {
  type AutoDenyCode,
  type AutoDenyMode,
  type AutoDenyReasonCode,
  type AutoDenyState,
  CAPPED_STATES,
  DIGEST_STATES,
  type Eligibility,
  MAX_EARLIER_AUTO_DENIALS,
  type RestoreRefusal,
  autoDenyDailyCapOf,
  autoDenyEligibility,
  autoDenyModeOf,
  confirmationOf,
  deniedReasonOf,
  eligibleCodesOf,
} from "../../../shared/publication-auto-deny.js";
import {
  type PublicationReviewReproducibility,
  reproducibilityOf,
} from "../../../shared/publication-review.js";
import { AUTO_DENY_AUDIT_ACTION } from "../../../shared/resubmission-note.js";
import { AUDIT_IF_PREVIOUS_CHANGED_SQL, auditLogParams } from "../db/audit-log.js";
import type { Bindings } from "../types/bindings.js";
import {
  type AutoDenyDigestRow,
  getAdminEmailsForCategory,
  resolveEmailConfig,
  sendAutoDeniedEmail,
  sendAutoDenyDigestEmail,
} from "./email.js";
import { isNonProductionEnv } from "./environment.js";
import { readStoredReport } from "./identifier-screen-stored.js";
import { denyPublicationRequest } from "./publication-deny.js";
import { errorWords } from "./publication-review-log.js";
import {
  type PublicationReviewRow,
  readReview,
  readReviewByKey,
  rowViewOf,
  screenedHeadSql,
} from "./publication-review-rows.js";
import { startConfirmingReview } from "./publication-review.js";

type Db = D1Database;

/** The service account an automatic denial is made as (migration 0009); looked up, never hard-coded. */
export const SERVICE_ACCOUNT_USERNAME = "nemarAdmin";

/** The mode, as the Worker reads `PUBLICATION_AUTO_DENY_MODE` now. */
export function autoDenyMode(env: Pick<Bindings, "PUBLICATION_AUTO_DENY_MODE">): AutoDenyMode {
  return autoDenyModeOf(env.PUBLICATION_AUTO_DENY_MODE);
}

/** The daily cap, as the Worker reads `PUBLICATION_AUTO_DENY_DAILY_CAP` now. */
export function autoDenyDailyCap(env: Pick<Bindings, "PUBLICATION_AUTO_DENY_DAILY_CAP">): number {
  return autoDenyDailyCapOf(env.PUBLICATION_AUTO_DENY_DAILY_CAP);
}

function sqlList(words: readonly string[]): string {
  return words
    .map((w) => {
      if (!/^[a-z_]+$/.test(w)) throw new Error("not a plain word");
      return `'${w}'`;
    })
    .join(", ");
}

// ---------------------------------------------------------------------------------------------
// Eligibility, read now
// ---------------------------------------------------------------------------------------------

interface RequestNow {
  id: number;
  dataset_id: string;
  status: string;
  anonymous: number;
  requested_by: number;
  identifier_screen_report: string | null;
}

/** The request of a review as it stands now, and its dataset's earlier automatic denials. */
async function requestNow(
  db: Db,
  row: PublicationReviewRow,
): Promise<{ request: RequestNow; earlier: number } | null> {
  const request = await db
    .prepare(
      `SELECT id, dataset_id, status, anonymous, requested_by, identifier_screen_report
         FROM publication_requests WHERE id = ? AND dataset_id = ?`,
    )
    .bind(row.requestId, row.datasetId)
    .first<RequestNow>();
  if (!request) return null;
  const earlier = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM publication_requests
        WHERE dataset_id = ? AND id < ? AND auto_denied = 1`,
    )
    .bind(row.datasetId, row.requestId)
    .first<{ n: number }>();
  return { request, earlier: Number(earlier?.n ?? 0) };
}

/**
 * A row's eligibility against its request now. `first` is the first run whose currency decides:
 * the review in force is the first run of the request's screened head and flag, and a confirming
 * row is about that same commit and kind.
 */
async function eligibilityOf(
  db: Db,
  row: PublicationReviewRow,
  first: PublicationReviewRow,
  now: { request: RequestNow; earlier: number },
): Promise<Eligibility> {
  const view = rowViewOf(row, Date.now());
  const report = view.kind === "reported" ? view.report : null;
  const head = readStoredReport(now.request.identifier_screen_report)?.head ?? null;
  const anonymous = now.request.anonymous === 1;
  let current = head === first.headSha && anonymous === first.anonymous;
  if (current) {
    const inForce = await readReviewByKey(db, first.requestId, first.headSha, first.anonymous);
    current = inForce?.id === first.id;
  }
  return autoDenyEligibility({
    state: row.state,
    report,
    current,
    requestStatus: now.request.status,
    anonymous,
    earlierAutoDenials: now.earlier,
  });
}

/** The reasons that say the request changed, not that the reviews disagree. */
const REQUEST_CHANGED: readonly string[] = [
  "not_current",
  "not_requested",
  "anonymous",
  "earlier_auto_denials",
];

// ---------------------------------------------------------------------------------------------
// After a result is stored
// ---------------------------------------------------------------------------------------------

/** What the step did, for the log and the tests. */
export type AfterStoreOutcome =
  | "off"
  | "no_row"
  | "not_eligible"
  | "confirming"
  | "confirm_not_started"
  | AutoDenyState;

/**
 * The automatic denial's step after a review's result is stored. A first run's eligible fail
 * starts its confirming run; a confirming run's result decides. Off: nothing at all.
 */
export async function afterPublicationReviewStored(env: Bindings, reviewId: number): Promise<void> {
  const outcome = await autoDenyStep(env, reviewId);
  if (outcome !== "off" && outcome !== "no_row" && outcome !== "not_eligible") {
    console.log(`[auto-deny] review ${reviewId}: ${outcome}`);
  }
}

/** {@link afterPublicationReviewStored}, with what it did. */
export async function autoDenyStep(env: Bindings, reviewId: number): Promise<AfterStoreOutcome> {
  if (autoDenyMode(env) === "off") return "off";
  const db = env.DB;
  const row = await readReview(db, reviewId);
  if (!row) return "no_row";
  if (row.confirmOf === null) {
    const now = await requestNow(db, row);
    if (!now) return "no_row";
    const eligibility = await eligibilityOf(db, row, row, now);
    if (!eligibility.eligible) return "not_eligible";
    const started = await startConfirmingReview(env, row);
    return started.started ? "confirming" : "confirm_not_started";
  }
  const first = await readReview(db, row.confirmOf);
  if (!first || first.confirmOf !== null) return "no_row";
  return decide(env, first, row);
}

/** Write a first run's word, once, while it still says `none`. */
async function markFirst(db: Db, firstId: number, state: AutoDenyState): Promise<boolean> {
  const r = await db
    .prepare(
      `UPDATE publication_reviews SET auto_deny_state = ?, auto_deny_at = datetime('now')
        WHERE id = ? AND confirm_of IS NULL AND auto_deny_state = 'none'`,
    )
    .bind(state, firstId)
    .run();
  return (r.meta.changes ?? 0) === 1;
}

/**
 * The cap's claim: one conditional write that records `state` on the first run only while fewer
 * than `cap` first runs were recorded `denied` or `would_deny` in the last day. One statement, so
 * two claims that race cannot both take the last place.
 */
function claimSql(): string {
  return `UPDATE publication_reviews SET auto_deny_state = ?, auto_deny_at = datetime('now')
     WHERE id = ? AND confirm_of IS NULL AND auto_deny_state = 'none'
       AND (SELECT COUNT(*) FROM publication_reviews AS c
             WHERE c.auto_deny_state IN (${sqlList(CAPPED_STATES)})
               AND c.auto_deny_at >= datetime('now', '-1 day')) < ?`;
}

async function stateOf(db: Db, id: number): Promise<string | null> {
  const r = await db
    .prepare("SELECT auto_deny_state FROM publication_reviews WHERE id = ?")
    .bind(id)
    .first<{ auto_deny_state: string }>();
  return r?.auto_deny_state ?? null;
}

/** The confirming run's result decides what the first run's fail does. */
async function decide(
  env: Bindings,
  first: PublicationReviewRow,
  confirm: PublicationReviewRow,
): Promise<AfterStoreOutcome> {
  const db = env.DB;
  if (first.autoDenyState !== "none") return first.autoDenyState as AutoDenyState;
  const now = await requestNow(db, first);
  if (!now) return "no_row";
  const a = await eligibilityOf(db, first, first, now);
  const b = await eligibilityOf(db, confirm, first, now);
  const changed = [a, b].some((e) => !e.eligible && REQUEST_CHANGED.includes(e.why));
  if (changed) {
    await markFirst(db, first.id, "not_eligible");
    return "not_eligible";
  }
  const agreement = confirmationOf(
    { eligibility: a, inputDigest: first.inputDigest },
    { eligibility: b, inputDigest: confirm.inputDigest },
  );
  if (!agreement.agrees) {
    await markFirst(db, first.id, "disagreed");
    return "disagreed";
  }

  // Read again here, at the moment of acting: only exactly `on` denies.
  const mode = autoDenyMode(env);
  const cap = autoDenyDailyCap(env);
  if (mode === "off") return "none";
  if (mode === "shadow") {
    const claimed = await db.prepare(claimSql()).bind("would_deny", first.id, cap).run();
    if ((claimed.meta.changes ?? 0) === 1) return "would_deny";
    if (await markFirst(db, first.id, "capped")) return "capped";
    return ((await stateOf(db, first.id)) ?? "none") as AutoDenyState;
  }
  return denyAutomatically(env, first, confirm, agreement.codes, agreement.reasons, cap);
}

/** Mode `on`: claim, deny, mark and audit in one batch, then mail. */
async function denyAutomatically(
  env: Bindings,
  first: PublicationReviewRow,
  confirm: PublicationReviewRow,
  codes: AutoDenyCode[],
  reasons: AutoDenyReasonCode[],
  cap: number,
): Promise<AfterStoreOutcome> {
  const db = env.DB;
  const service = await db
    .prepare("SELECT id FROM users WHERE username = ? AND deleted_at IS NULL")
    .bind(SERVICE_ACCOUNT_USERNAME)
    .first<{ id: number }>();
  if (!service) {
    // Nobody to deny as: a configuration fault, which leaves the request to a person.
    console.error(`[auto-deny] review ${first.id}: the service account is missing; nothing denied`);
    await markFirst(db, first.id, "not_eligible");
    return "not_eligible";
  }
  const details = JSON.stringify({
    request_id: first.requestId,
    review_ids: [first.id, confirm.id],
    head: first.headSha,
    models: [first.models, confirm.models].map((m) => {
      try {
        return m === null ? null : JSON.parse(m);
      } catch {
        return null;
      }
    }),
    prompt_version: first.promptVersion,
    input_digest: first.inputDigest,
    codes,
    reasons,
  });
  const [userId, action, resourceType, resourceId, boundDetails] = auditLogParams({
    userId: service.id,
    action: AUTO_DENY_AUDIT_ACTION,
    resourceType: "dataset",
    resourceId: first.datasetId,
    details,
  });

  // Whether the deny function reached its batch (the claim and the write) or refused before it.
  let batched = false;
  const outcome = await denyPublicationRequest(db, {
    datasetId: first.datasetId,
    requestId: first.requestId,
    deniedBy: service.id,
    reason: deniedReasonOf(reasons),
    set: "auto_denied = 1",
    // The request is still waiting, named, the review's commit is still the screened one, the
    // dataset still has fewer than two earlier automatic denials, and the cap's claim (the first
    // statement of the batch) took the place.
    guard: {
      sql: `status = 'requested' AND anonymous = 0
        AND ${screenedHeadSql("publication_requests")} = ?
        AND (SELECT COUNT(*) FROM publication_requests AS e
              WHERE e.dataset_id = publication_requests.dataset_id
                AND e.id < publication_requests.id AND e.auto_denied = 1) < ?
        AND EXISTS (SELECT 1 FROM publication_reviews AS r
                     WHERE r.id = ? AND r.auto_deny_state = 'denied')`,
      binds: [first.headSha, MAX_EARLIER_AUTO_DENIALS, first.id],
    },
    before: () => {
      batched = true;
      return [db.prepare(claimSql()).bind("denied", first.id, cap)];
    },
    after: (requestId) => [
      db
        .prepare(AUDIT_IF_PREVIOUS_CHANGED_SQL)
        .bind(userId, action, resourceType, resourceId, boundDetails),
      // A claim whose write did not land is taken back, in the same transaction.
      db
        .prepare(
          `UPDATE publication_reviews SET auto_deny_state = 'not_eligible'
            WHERE id = ? AND auto_deny_state = 'denied'
              AND NOT EXISTS (SELECT 1 FROM publication_requests
                               WHERE id = ? AND status = 'denied' AND auto_denied = 1)`,
        )
        .bind(first.id, requestId),
    ],
  });

  if (outcome.kind === "denied") {
    await mailDepositor(env, first, confirm, codes);
    return "denied";
  }
  // Refused before the batch (the request moved, an approval runs, it started publishing): no
  // claim was made, and the request changed. Refused by the batch: a claim that took a place was
  // taken back in the same transaction (`not_eligible`, a lost race), and one that took none was
  // past the cap (`none` still).
  if (!batched) {
    await markFirst(db, first.id, "not_eligible");
    return "not_eligible";
  }
  const state = await stateOf(db, first.id);
  if (state === "none") {
    await markFirst(db, first.id, "capped");
    return "capped";
  }
  return (state ?? "none") as AutoDenyState;
}

// ---------------------------------------------------------------------------------------------
// The depositor's mail
// ---------------------------------------------------------------------------------------------

/**
 * Mail the requester and the dataset's owner (once each) the transparent account of the denial.
 * Never throws; each send goes through the delivery fence, so the dev Worker reaches only
 * `DEV_EMAIL_ALLOWLIST`.
 */
async function mailDepositor(
  env: Bindings,
  first: PublicationReviewRow,
  confirm: PublicationReviewRow,
  codes: AutoDenyCode[],
): Promise<void> {
  try {
    const { results } = await env.DB.prepare(
      `SELECT u.email, u.username FROM users u
        WHERE u.deleted_at IS NULL AND u.email IS NOT NULL
          AND (u.id = (SELECT requested_by FROM publication_requests WHERE id = ?)
               OR u.id = (SELECT owner_user_id FROM datasets WHERE dataset_id = ?))`,
    )
      .bind(first.requestId, first.datasetId)
      .all<{ email: string; username: string }>();
    const records: { kind: "first" | "confirming"; record: PublicationReviewReproducibility }[] =
      [];
    const a = reproducibilityOf(first);
    const b = reproducibilityOf(confirm);
    if (a) records.push({ kind: "first", record: a });
    if (b) records.push({ kind: "confirming", record: b });
    const { fromEmail, replyTo, isDev } = resolveEmailConfig(env);
    const seen = new Set<string>();
    for (const r of results ?? []) {
      const key = r.email.trim().toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      try {
        await sendAutoDeniedEmail(
          r.email,
          r.username,
          first.datasetId,
          codes,
          records,
          env.RESEND_API_KEY ?? "",
          fromEmail,
          replyTo,
          isDev,
          env,
        );
      } catch (err) {
        console.error(
          `[auto-deny] request ${first.requestId}: denial mail not sent (${errorWords(err)})`,
        );
      }
    }
  } catch (err) {
    console.error(
      `[auto-deny] request ${first.requestId}: denial mail not read (${errorWords(err)})`,
    );
  }
}

// ---------------------------------------------------------------------------------------------
// The administrators' daily digest
// ---------------------------------------------------------------------------------------------

export interface AutoDenyDigestResult {
  skipped: boolean;
  claimed: boolean;
  rows: number;
  delivered: number;
}

/**
 * The administrators' daily digest of what the automatic denial did (`denied`, `would_deny`,
 * `capped`, `disagreed`) since the last digest that was sent. PRODUCTION-ONLY (AGENTS.md's default
 * for a new cron job; the recipients come from `getAdminEmailsForCategory`, which is fenced too).
 * Claimed once per UTC day by an insert, so two ticks cannot both send it; a digest that reached
 * nobody leaves its window open, and the next day's starts where the last sent one ended.
 */
export async function sendAutoDenyDigest(env: Bindings): Promise<AutoDenyDigestResult> {
  const result: AutoDenyDigestResult = { skipped: false, claimed: false, rows: 0, delivered: 0 };
  if (isNonProductionEnv(env)) {
    result.skipped = true;
    return result;
  }
  const db = env.DB;
  const claim = await db
    .prepare(
      `INSERT INTO publication_auto_deny_digests (day, window_end)
       VALUES (date('now'), datetime('now')) ON CONFLICT (day) DO NOTHING`,
    )
    .run();
  if ((claim.meta.changes ?? 0) !== 1) return result;
  result.claimed = true;
  const digestId = Number(claim.meta.last_row_id);
  const window = await db
    .prepare(
      `SELECT (SELECT window_end FROM publication_auto_deny_digests WHERE id = ?) AS until,
              COALESCE((SELECT MAX(window_end) FROM publication_auto_deny_digests
                         WHERE id <> ? AND sent_at IS NOT NULL),
                       datetime('now', '-1 day')) AS since`,
    )
    .bind(digestId, digestId)
    .first<{ until: string; since: string }>();
  const { results } = await db
    .prepare(
      `SELECT id, request_id, dataset_id, head_sha, anonymous, state, report, confirm_of,
              auto_deny_state
         FROM publication_reviews
        WHERE confirm_of IS NULL AND auto_deny_state IN (${sqlList(DIGEST_STATES)})
          AND auto_deny_at > ? AND auto_deny_at <= ?
        ORDER BY auto_deny_at, id LIMIT 500`,
    )
    .bind(window?.since ?? "", window?.until ?? "")
    .all<Record<string, unknown>>();
  const rows: AutoDenyDigestRow[] = [];
  for (const raw of results ?? []) {
    const state = raw.auto_deny_state;
    if (!isOneOf(DIGEST_STATES, state)) continue;
    const review = await readReview(db, Number(raw.id));
    const view = review ? rowViewOf(review, Date.now()) : null;
    const report = view?.kind === "reported" ? view.report : null;
    rows.push({
      state,
      datasetId: String(raw.dataset_id),
      requestId: Number(raw.request_id),
      codes: report === null ? [] : eligibleCodesOf(report).codes,
    });
  }
  result.rows = rows.length;
  if (rows.length === 0) {
    await markDigestSent(db, digestId);
    return result;
  }
  const admins = await getAdminEmailsForCategory(db, "publication_request", env);
  const { fromEmail, replyTo, isDev } = resolveEmailConfig(env);
  const outcome = await sendAutoDenyDigestEmail(
    admins,
    rows,
    autoDenyMode(env),
    autoDenyDailyCap(env),
    env.RESEND_API_KEY ?? "",
    fromEmail,
    replyTo,
    isDev,
    env,
  );
  result.delivered = outcome.delivered;
  if (outcome.delivered > 0) await markDigestSent(db, digestId);
  return result;
}

async function markDigestSent(db: Db, id: number): Promise<void> {
  await db
    .prepare("UPDATE publication_auto_deny_digests SET sent_at = datetime('now') WHERE id = ?")
    .bind(id)
    .run();
}

// ---------------------------------------------------------------------------------------------
// The reversal
// ---------------------------------------------------------------------------------------------

export type RestoreOutcome =
  | { kind: "restored"; requestId: number }
  | { kind: "refused"; refusal: RestoreRefusal };

/** The audit action of a restore. */
export const RESTORE_AUDIT_ACTION = "publication_restore";

/**
 * Restore a denied request to `requested` (ADR 0139, decision 4): the dataset's newest request,
 * denied and not withdrawn, with no newer request. One batch: the guarded write and an audit row
 * that exists only if the write changed the request. `auto_denied` goes back to 0, so a denial that
 * was reversed does not count toward the dataset's two.
 */
export async function restorePublicationRequest(
  db: Db,
  args: { datasetId: string; adminId: number; requestId?: number },
): Promise<RestoreOutcome> {
  const newest = await db
    .prepare(
      `SELECT id, status, withdrawn_at, auto_denied FROM publication_requests
        WHERE dataset_id = ? ORDER BY requested_at DESC, id DESC LIMIT 1`,
    )
    .bind(args.datasetId)
    .first<{ id: number; status: string; withdrawn_at: string | null; auto_denied: number }>();
  if (!newest) return { kind: "refused", refusal: "not_found" };
  if (args.requestId !== undefined && args.requestId !== newest.id) {
    return { kind: "refused", refusal: "newer_request" };
  }
  if (newest.status !== "denied") return { kind: "refused", refusal: "not_denied" };
  if (newest.withdrawn_at !== null) return { kind: "refused", refusal: "withdrawn" };

  const details = JSON.stringify({ request_id: newest.id, auto_denied: newest.auto_denied === 1 });
  const results = await db.batch([
    db
      .prepare(
        `UPDATE publication_requests
            SET status = 'requested', denied_at = NULL, denied_by = NULL, denied_reason = NULL,
                auto_denied = 0, updated_at = datetime('now')
          WHERE id = ? AND dataset_id = ? AND status = 'denied' AND withdrawn_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM publication_requests AS n
                             WHERE n.dataset_id = publication_requests.dataset_id
                               AND n.id <> publication_requests.id
                               AND (n.requested_at > publication_requests.requested_at
                                    OR (n.requested_at = publication_requests.requested_at
                                        AND n.id > publication_requests.id)))`,
      )
      .bind(newest.id, args.datasetId),
    db.prepare(AUDIT_IF_PREVIOUS_CHANGED_SQL).bind(
      ...auditLogParams({
        userId: args.adminId,
        action: RESTORE_AUDIT_ACTION,
        resourceType: "dataset",
        resourceId: args.datasetId,
        details,
      }),
    ),
  ]);
  if ((results[0]?.meta?.changes ?? 0) !== 1) {
    // It moved between the read and the write: say why, by the same rule.
    return restoreRefusalNow(db, args.datasetId, newest.id);
  }
  return { kind: "restored", requestId: newest.id };
}

async function restoreRefusalNow(db: Db, datasetId: string, id: number): Promise<RestoreOutcome> {
  const newest = await db
    .prepare(
      `SELECT id, status, withdrawn_at FROM publication_requests
        WHERE dataset_id = ? ORDER BY requested_at DESC, id DESC LIMIT 1`,
    )
    .bind(datasetId)
    .first<{ id: number; status: string; withdrawn_at: string | null }>();
  if (!newest) return { kind: "refused", refusal: "not_found" };
  if (newest.id !== id) return { kind: "refused", refusal: "newer_request" };
  if (newest.withdrawn_at !== null) return { kind: "refused", refusal: "withdrawn" };
  return { kind: "refused", refusal: "not_denied" };
}
