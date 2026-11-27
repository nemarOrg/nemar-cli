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
  CONFIRMING_MODEL,
  DENIAL_MAIL_MAX_ATTEMPTS,
  DIGEST_STATES,
  type DenialMailState,
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
  DevEmailFenceError,
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
  ROW_COLUMNS,
  readReview,
  readReviewByKey,
  rowViewOf,
  screenedHeadSql,
  toRow,
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
    // A first run the automatic denial already acted on (a restore among them) never starts
    // another confirming run: a restored commit is not denied automatically again.
    if (row.autoDenyState !== "none") return "not_eligible";
    const eligibility = await eligibilityOf(db, row, row, now);
    if (!eligibility.eligible) return "not_eligible";
    // A first run made on the confirming model cannot be confirmed by it: the denial rests on two
    // different models agreeing (ADR 0139), and the depositor's mail says so. No confirming run.
    const firstView = rowViewOf(row, Date.now());
    if (firstView.kind === "reported" && firstView.report?.model === CONFIRMING_MODEL) {
      return "not_eligible";
    }
    const started = await startConfirmingReview(env, row);
    if (started.started) return "confirming";
    // A second start of the same confirmation is not a failure of it.
    if (started.reason === "duplicate") return "confirm_not_started";
    // The request stopped waiting between the store and the start: it changed, not the reviews.
    if (started.reason === "request_not_requested") {
      await markFirst(db, row.id, "not_eligible");
      return "not_eligible";
    }
    // Nothing will confirm this fail. EVERY other `started: false` reason lands here on purpose,
    // `running` and `has_result` included (the dispatch failed, the Worker could not hand it over,
    // the platform's allowance declined it, the review is off or not this Worker's, or anything a
    // start may answer later): it fails closed, never toward a deny, and a person decides.
    await markFirst(db, row.id, "confirm_failed");
    return "confirm_failed";
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
  // A confirming run that reported nothing confirms nothing: a state of its own, never a deny.
  if (confirm.state !== "reported") {
    await markFirst(db, first.id, "confirm_failed");
    return "confirm_failed";
  }
  const a = await eligibilityOf(db, first, first, now);
  const b = await eligibilityOf(db, confirm, first, now);
  const changed = [a, b].some((e) => !e.eligible && REQUEST_CHANGED.includes(e.why));
  if (changed) {
    await markFirst(db, first.id, "not_eligible");
    return "not_eligible";
  }
  const agreement = confirmationOf(
    { eligibility: a, inputDigest: first.inputDigest, promptVersion: first.promptVersion },
    { eligibility: b, inputDigest: confirm.inputDigest, promptVersion: confirm.promptVersion },
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
    await markFirst(db, first.id, "no_service_account");
    return "no_service_account";
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
 * The denial mail's recipients: the requester and every account with owner rights on the dataset,
 * once each. The rights the backend grants on a dataset's repository come from two places
 * (`repo-spec.ts`): `datasets.owner_user_id` (maintain) and `dataset_collaborators` (write, with
 * no role column). So the owner is the one account with owner rights, and a collaborator, who can
 * push but not decide on the dataset, is not mailed. A deleted account is never mailed.
 */
const RECIPIENTS_SQL = `SELECT u.email, u.username FROM users u
  WHERE u.deleted_at IS NULL AND u.email IS NOT NULL
    AND (u.id = (SELECT requested_by FROM publication_requests WHERE id = ?)
         OR u.id = (SELECT owner_user_id FROM datasets WHERE dataset_id = ?))
  ORDER BY u.id`;

/**
 * Mail the recipients the transparent account of the denial, and record what became of it on the
 * first run (`denial_mail_state`, one more `denial_mail_attempts`): `failed` when any send failed
 * other than by the dev fence, else `sent` when one went, else `fenced`. Never throws: a mail that
 * could not even be built is `failed`, so the daily tick retries it and the digest shows it.
 */
async function mailDepositor(
  env: Bindings,
  first: PublicationReviewRow,
  confirm: PublicationReviewRow,
  codes: readonly AutoDenyCode[],
): Promise<DenialMailState> {
  let state: DenialMailState = "failed";
  try {
    const { results } = await env.DB.prepare(RECIPIENTS_SQL)
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
    let sent = 0;
    let failed = 0;
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
        sent++;
      } catch (err) {
        if (!(err instanceof DevEmailFenceError)) failed++;
        console.error(
          `[auto-deny] request ${first.requestId}: denial mail not sent (${errorWords(err)})`,
        );
      }
    }
    state = failed > 0 || seen.size === 0 ? "failed" : sent > 0 ? "sent" : "fenced";
  } catch (err) {
    console.error(
      `[auto-deny] request ${first.requestId}: denial mail not read (${errorWords(err)})`,
    );
  }
  try {
    await env.DB.prepare(
      `UPDATE publication_reviews
          SET denial_mail_state = ?, denial_mail_attempts = denial_mail_attempts + 1
        WHERE id = ?`,
    )
      .bind(state, first.id)
      .run();
  } catch (err) {
    console.error(
      `[auto-deny] review ${first.id}: denial mail state not recorded (${errorWords(err)})`,
    );
  }
  return state;
}

/**
 * Try once more each denial mail that failed. Only a mail tried once: a second failure stays
 * `failed` and the digest lists it. It runs ONLY in the production digest tick
 * ({@link sendAutoDenyDigest}, after its day claim and before it reads its rows), so a mail is retried
 * at most once a day and never from the dev Worker, which shares real addresses.
 */
export async function retryFailedDenialMails(env: Bindings): Promise<number> {
  const db = env.DB;
  const { results } = await db
    .prepare(
      `SELECT ${ROW_COLUMNS} FROM publication_reviews
        WHERE confirm_of IS NULL AND auto_deny_state = 'denied' AND denial_mail_state = 'failed'
          AND denial_mail_attempts < ? ORDER BY id LIMIT 50`,
    )
    .bind(DENIAL_MAIL_MAX_ATTEMPTS)
    .all<Record<string, unknown>>();
  let retried = 0;
  for (const raw of results ?? []) {
    const first = toRow(raw);
    const confirm = toRowOrNull(
      await db
        .prepare(`SELECT ${ROW_COLUMNS} FROM publication_reviews WHERE confirm_of = ?`)
        .bind(first.id)
        .first<Record<string, unknown>>(),
    );
    const view = rowViewOf(first, Date.now());
    const codes = view.kind === "reported" && view.report ? eligibleCodesOf(view.report).codes : [];
    const sharedCodes =
      confirm === null
        ? codes
        : (() => {
            const v = rowViewOf(confirm, Date.now());
            const theirs = v.kind === "reported" && v.report ? eligibleCodesOf(v.report).codes : [];
            return codes.filter((c) => theirs.includes(c));
          })();
    await mailDepositor(env, first, confirm ?? first, sharedCodes.length > 0 ? sharedCodes : codes);
    retried++;
  }
  return retried;
}

function toRowOrNull(raw: Record<string, unknown> | null): PublicationReviewRow | null {
  return raw ? toRow(raw) : null;
}

// ---------------------------------------------------------------------------------------------
// The administrators' daily digest
// ---------------------------------------------------------------------------------------------

export interface AutoDenyDigestResult {
  skipped: boolean;
  claimed: boolean;
  /** Rows the digest listed. */
  rows: number;
  /** Rows held back past the limit, for the next digest. */
  more: number;
  /** Denials whose mail reached nobody after its retry. */
  undelivered: number;
  /** Denial mails tried again before the digest. */
  retried: number;
  delivered: number;
}

/** The most rows one digest lists; the rest wait for the next one. */
export const DIGEST_ROW_LIMIT = 500;

/**
 * The administrators' daily digest of what the automatic denial did (every word of
 * `DIGEST_STATES`) since the last digest that was sent, and of the denials whose mail reached
 * nobody. PRODUCTION-ONLY (AGENTS.md's default for a new cron job; the recipients come from
 * `getAdminEmailsForCategory`, which is fenced too).
 *
 * Claimed once per UTC day by an insert, so two ticks cannot both send it. Then, in order: the
 * denial mails that failed once are tried again; the rows of the window are counted; at most
 * {@link DIGEST_ROW_LIMIT} are listed, and when there are more, the window closes at the last row
 * listed (rows with the same instant included) and the digest says how many wait, so the window
 * never passes a row nobody was told about. A digest that reached nobody leaves its window open:
 * the next one starts where the last SENT one ended. If anything after the claim throws, the claim
 * is deleted so the next tick tries again.
 */
export async function sendAutoDenyDigest(env: Bindings): Promise<AutoDenyDigestResult> {
  const result: AutoDenyDigestResult = {
    skipped: false,
    claimed: false,
    rows: 0,
    more: 0,
    undelivered: 0,
    retried: 0,
    delivered: 0,
  };
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
  try {
    await digestAfterClaim(env, digestId, result);
  } catch (err) {
    console.error(`[auto-deny-digest] failed after its claim (${errorWords(err)}); released`);
    try {
      await db
        .prepare("DELETE FROM publication_auto_deny_digests WHERE id = ? AND sent_at IS NULL")
        .bind(digestId)
        .run();
    } catch (inner) {
      console.error(`[auto-deny-digest] claim not released (${errorWords(inner)})`);
    }
    throw err;
  }
  return result;
}

const IN_WINDOW = `confirm_of IS NULL AND auto_deny_state IN (${sqlList(DIGEST_STATES)})
  AND auto_deny_at > ? AND auto_deny_at <= ?`;

async function digestAfterClaim(
  env: Bindings,
  digestId: number,
  result: AutoDenyDigestResult,
): Promise<void> {
  const db = env.DB;
  result.retried = await retryFailedDenialMails(env);
  const window = await db
    .prepare(
      `SELECT (SELECT window_end FROM publication_auto_deny_digests WHERE id = ?) AS until,
              COALESCE((SELECT MAX(window_end) FROM publication_auto_deny_digests
                         WHERE id <> ? AND sent_at IS NOT NULL),
                       datetime('now', '-1 day')) AS since`,
    )
    .bind(digestId, digestId)
    .first<{ until: string; since: string }>();
  const since = window?.since ?? "";
  let until = window?.until ?? "";
  const total = Number(
    (
      await db
        .prepare(`SELECT COUNT(*) AS n FROM publication_reviews WHERE ${IN_WINDOW}`)
        .bind(since, until)
        .first<{ n: number }>()
    )?.n ?? 0,
  );
  if (total > DIGEST_ROW_LIMIT) {
    // Close the window at the instant of the last row listed, so every row after it is the next
    // digest's; the rows of that same instant are listed with it.
    const last = await db
      .prepare(
        `SELECT auto_deny_at AS at FROM publication_reviews WHERE ${IN_WINDOW}
          ORDER BY auto_deny_at, id LIMIT 1 OFFSET ?`,
      )
      .bind(since, until, DIGEST_ROW_LIMIT - 1)
      .first<{ at: string }>();
    if (last?.at) until = last.at;
  }
  const { results } = await db
    .prepare(
      `SELECT ${ROW_COLUMNS} FROM publication_reviews WHERE ${IN_WINDOW}
        ORDER BY auto_deny_at, id`,
    )
    .bind(since, until)
    .all<Record<string, unknown>>();
  const rows: AutoDenyDigestRow[] = [];
  for (const raw of results ?? []) {
    const review = toRow(raw);
    const state = review.autoDenyState;
    if (!isOneOf(DIGEST_STATES, state)) continue;
    const view = rowViewOf(review, Date.now());
    const report = view.kind === "reported" ? view.report : null;
    rows.push({
      state,
      datasetId: review.datasetId,
      requestId: review.requestId,
      codes: report === null ? [] : eligibleCodesOf(report).codes,
    });
  }
  result.rows = rows.length;
  result.more = Math.max(0, total - rows.length);
  // The denials whose mail failed at the denial and again on its retry, chosen by their mail state
  // and never by the window: every one not yet listed, each listed once (marked below, only once
  // a digest carrying it reached an administrator).
  const undeliveredRows = (
    await db
      .prepare(
        `SELECT id, dataset_id, request_id FROM publication_reviews
          WHERE confirm_of IS NULL AND denial_mail_state = 'failed'
            AND denial_mail_attempts >= ? AND denial_mail_listed_at IS NULL
          ORDER BY auto_deny_at, id LIMIT ?`,
      )
      .bind(DENIAL_MAIL_MAX_ATTEMPTS, DIGEST_ROW_LIMIT)
      .all<{ id: number; dataset_id: string; request_id: number }>()
  ).results;
  const undelivered = undeliveredRows.map((r) => ({
    datasetId: String(r.dataset_id),
    requestId: Number(r.request_id),
  }));
  result.undelivered = undelivered.length;
  await db
    .prepare("UPDATE publication_auto_deny_digests SET window_end = ? WHERE id = ?")
    .bind(until, digestId)
    .run();
  if (rows.length === 0 && undelivered.length === 0) {
    await markDigestSent(db, digestId);
    return;
  }
  const admins = await getAdminEmailsForCategory(db, "publication_request", env);
  const { fromEmail, replyTo, isDev } = resolveEmailConfig(env);
  const outcome = await sendAutoDenyDigestEmail(
    admins,
    rows,
    { more: result.more, undelivered },
    autoDenyMode(env),
    autoDenyDailyCap(env),
    env.RESEND_API_KEY ?? "",
    fromEmail,
    replyTo,
    isDev,
    env,
  );
  result.delivered = outcome.delivered;
  if (outcome.delivered > 0) {
    await markDigestSent(db, digestId);
    for (const r of undeliveredRows) {
      await db
        .prepare(
          `UPDATE publication_reviews SET denial_mail_listed_at = datetime('now')
            WHERE id = ? AND denial_mail_listed_at IS NULL`,
        )
        .bind(r.id)
        .run();
    }
  }
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
 * denied and not withdrawn, with no newer request. One batch: the guarded write, an audit row that
 * exists only if the write changed the request, and the automatic denial's review marked
 * `restored` (never denied automatically again for that commit; its cap place stays counted). `auto_denied` goes back to 0, so a denial that
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
    // The review the automatic denial acted on says it was restored. Its `auto_deny_at` is kept,
    // so its place under the day's cap stays counted (`CAPPED_STATES`), and a first run that is no
    // longer `none` never starts another confirming run: this commit is not denied again.
    db
      .prepare(
        `UPDATE publication_reviews SET auto_deny_state = 'restored'
          WHERE request_id = ? AND confirm_of IS NULL AND auto_deny_state = 'denied'
            AND EXISTS (SELECT 1 FROM publication_requests
                         WHERE id = ? AND status = 'requested' AND denied_at IS NULL)`,
      )
      .bind(newest.id, newest.id),
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
