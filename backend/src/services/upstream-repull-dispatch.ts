/**
 * The dispatch record of the automatic re-pull (epic #1046 phase 7, #1913; ADR 0111, decisions 6
 * and 7).
 *
 * The automatic path runs a re-pull unattended: the Worker claims a dispatch here, sends it to a
 * central workflow (`.github/dataset-workflows/run-upstream-repull.yml`), and the run presents the
 * dispatch's token twice, at the automatic create (`POST /admin/repulls`, the only way a record is
 * written with `origin = 'automatic'`) and at its report callback (`POST /webhooks/repull-state`).
 * The table is `upstream_repull_dispatches` (migration 0112); its words are
 * `shared/repull-state.ts`.
 *
 * THE RULES, each one deliberate:
 *  - Nothing here acts outside exact production. A claim needs the open switch as well
 *    (`autoRepullEnabled`), except the finish of a re-pull already merged: a minted DOI's lineage,
 *    lock and `complete` must not be stranded by turning the switch off. The `nemarDatasets`
 *    organization is shared with dev, so a non-production Worker never claims, verifies or stores
 *    anything here, and an `xx` dataset is never dispatched (the table refuses any id but `on`).
 *  - The open cap is a fixed UTC day on D1's own clock, counted in the statement that claims the
 *    unit, so two claims racing for the last unit cannot both win; a refused claim writes nothing
 *    (ADR 0099). A dispatch GitHub refused never ran and frees its unit; one whose answer was lost
 *    keeps it, because it may be running.
 *  - One live dispatch per dataset (`upstream_repull_dispatches_one_live`: unique per dataset,
 *    partial on a held nonce), so two runs never work on one dataset at once.
 *  - Single use is the row's nonce, not the HMAC: it is set only while the dispatch is live and
 *    cleared by the edge that ends it, so a token replayed after its run ended verifies nothing.
 *  - A code is a fixed word from DISPATCH_CODES, never a message, a path or a key: the weekly
 *    report counts them on a public-facing repository.
 *
 * NO MAIL. Nothing here or in the callback imports a mail service (`repull-no-mail-scan.test.ts`).
 */

import { z } from "zod";
import { isOpenNeuroTag, normalizeUpstreamTag } from "../../../shared/openneuro-tag.js";
import type { DispatchView, RepullCapReading } from "../../../shared/repull-observability.js";
import {
  DISPATCH_CODES,
  DISPATCH_LIVE,
  DISPATCH_PHASES,
  DISPATCH_RUN_URL_RE,
  type DispatchCode,
  type DispatchPhase,
  type DispatchRow,
  type DispatchStatus,
  REPULL_STATUSES,
  type RepullRow,
  TERMINAL_STATUSES,
  isDispatchCode,
} from "../../../shared/repull-state.js";
import type { Bindings } from "../types/bindings.js";
import { signRepullDispatchToken, verifyRepullDispatchToken } from "./github/callback-tokens.js";
import { autoRepullEnabled, isExactProduction, repullOpenCap } from "./repull-switches.js";
import type { RepullRefusal } from "./upstream-repull.js";

/** How long a run has to report before the Worker calls it `unreported`: the job's 330 minutes plus queueing. */
export const DISPATCH_DEADLINE_HOURS = 8;

const quoted = (words: readonly string[]) => words.map((w) => `'${w}'`).join(", ");
const LIVE_LIST = quoted(DISPATCH_LIVE);
const TERMINAL_LIST = quoted(TERMINAL_STATUSES);

/** The re-pull states before its pull request is open: a stalled automatic row resumes from these. */
const RESUMABLE = REPULL_STATUSES.slice(0, REPULL_STATUSES.indexOf("pr_open"));
/** A run that reports `opened` names a row at `pr_open` or later that has not been closed. */
const OPENED_OR_LATER = REPULL_STATUSES.filter(
  (s, i) =>
    i >= REPULL_STATUSES.indexOf("pr_open") &&
    (s === "complete" || !(TERMINAL_STATUSES as readonly string[]).includes(s)),
);

// ----------------------------------------------------------------------------
// SQL. Exported so a test runs the statement the service runs, never a copy.
// ----------------------------------------------------------------------------

export const DISPATCH_BY_ID_SQL = "SELECT * FROM upstream_repull_dispatches WHERE id = ?";

const DISPATCH_BY_NONCE_SQL = "SELECT * FROM upstream_repull_dispatches WHERE nonce = ?";

/** The page size of the admin list of dispatches, and the most a caller may ask for. */
export const DISPATCH_PAGE_DEFAULT = 25;
export const DISPATCH_PAGE_MAX = 50;

/**
 * The admin list of dispatches, newest first, a keyset page. `?1` the dataset or NULL, `?2` the
 * state or NULL, `?3` the id the page continues below or NULL, `?4` the page size. Every column
 * is named, never `SELECT *`: the row's one-shot nonce is the secret a live run's token is checked
 * against and leaves the Worker nowhere, so a column added to the table later reaches this list
 * only when someone adds it here.
 */
export const DISPATCH_LIST_SQL = `SELECT id, kind, dataset_id, upstream_ds, from_tag, to_tag, repull_id,
    status, code, workflow_run_url, dispatched_at, reported_at
  FROM upstream_repull_dispatches
  WHERE (?1 IS NULL OR dataset_id = ?1)
    AND (?2 IS NULL OR status = ?2)
    AND (?3 IS NULL OR id < ?3)
  ORDER BY id DESC LIMIT ?4`;

/**
 * A page of dispatches, newest first, for an administrator (the route shows dataset ids; the
 * weekly report never does). `after` continues below that id. The page is clamped to
 * {@link DISPATCH_PAGE_MAX} here as well as at the route, so no caller gets more.
 */
export async function listDispatches(
  db: D1Database,
  q: { dataset?: string; status?: DispatchStatus; after?: number; limit?: number },
): Promise<DispatchView[]> {
  const limit = Math.min(Math.max(q.limit ?? DISPATCH_PAGE_DEFAULT, 1), DISPATCH_PAGE_MAX);
  const { results } = await db
    .prepare(DISPATCH_LIST_SQL)
    .bind(q.dataset ?? null, q.status ?? null, q.after ?? null, limit)
    .all<DispatchView>();
  return results;
}

/**
 * Today's units of the open cap: every `open` dispatch of the UTC day on D1's clock, first
 * dispatches and resumes alike, except those GitHub refused (they never ran). `dispatched_at` is
 * `datetime('now')`, so the day is the range from `date('now')` to the next day, which the index
 * on the column serves.
 */
const OPEN_DISPATCHES_TODAY_EXPR = `(SELECT COUNT(*) FROM upstream_repull_dispatches
    WHERE kind = 'open' AND status <> 'dispatch_failed'
      AND dispatched_at >= date('now') AND dispatched_at < date('now', '+1 day'))`;

export const OPEN_DISPATCHES_TODAY_SQL = `SELECT ${OPEN_DISPATCHES_TODAY_EXPR} AS used`;

/**
 * Claim one unit of the open cap. `?1` dataset, `?2` ds, `?3` from_tag, `?4` to_tag, `?5` the
 * re-pull it resumes or NULL, `?6` the nonce, `?7` the cap. The count and the claim are one
 * statement. A first dispatch (`?5` NULL) needs the dataset to have no open re-pull; a resume needs
 * `?5` to be an automatic row of that dataset and those tags that stalled before its pull request
 * opened. The tags are bound without a leading `v` and the row's are matched in either spelling,
 * so a row that records `v1.0.0` is the same snapshot's as one that records `1.0.0`. A unique-index
 * failure means a dispatch of the dataset is live.
 */
export const DISPATCH_OPEN_CLAIM_SQL = `INSERT INTO upstream_repull_dispatches
  (kind, dataset_id, upstream_ds, from_tag, to_tag, repull_id, nonce, status)
  SELECT 'open', ?1, ?2, ?3, ?4, ?5, ?6, 'dispatched'
   WHERE ${OPEN_DISPATCHES_TODAY_EXPR} < ?7
     AND (CASE WHEN ?5 IS NULL
          THEN NOT EXISTS (SELECT 1 FROM upstream_repulls
                            WHERE dataset_id = ?1 AND status NOT IN (${TERMINAL_LIST}))
          ELSE EXISTS (SELECT 1 FROM upstream_repulls
                        WHERE id = ?5 AND dataset_id = ?1 AND origin = 'automatic'
                          AND upstream_ds = ?2 AND from_tag IN (?3, 'v' || ?3)
                          AND to_tag IN (?4, 'v' || ?4)
                          AND status IN (${quoted(RESUMABLE)}))
          END)`;

/**
 * Claim the finish of a merged automatic re-pull, `?1` its id, `?2` the nonce. No cap: a merge
 * already minted a DOI, and the finish only records what followed it. The dataset and the tags are
 * the row's, never the caller's. A unique-index failure means a dispatch of the dataset is live.
 */
export const DISPATCH_FINISH_INSERT_SQL = `INSERT INTO upstream_repull_dispatches
  (kind, dataset_id, upstream_ds, from_tag, to_tag, repull_id, nonce, status)
  SELECT 'finish', dataset_id, upstream_ds, from_tag, to_tag, id, ?2, 'dispatched'
    FROM upstream_repulls
   WHERE id = ?1 AND origin = 'automatic' AND status IN ('merged', 'released')`;

/**
 * The audit row of a claim, written only when the claim before it inserted. Its details (dataset,
 * kind, tags, re-pull; never the nonce or the token) are built here from the row the claim just
 * inserted, so they are that row's and cannot disagree with it. `last_insert_rowid()` is the
 * claim's id, which nothing in between moves.
 */
export const AUDIT_DISPATCH_CLAIMED_SQL = `INSERT INTO audit_log (user_id, action, resource_type, resource_id, details)
  SELECT NULL, 'repull_dispatch', 'upstream_repull_dispatch', CAST(d.id AS TEXT),
    json_object('dataset_id', d.dataset_id, 'kind', d.kind, 'from_tag', d.from_tag,
                'to_tag', d.to_tag, 'repull_id', d.repull_id)
    FROM upstream_repull_dispatches d
   WHERE d.id = last_insert_rowid() AND changes() > 0`;

/** GitHub refused the dispatch, so the run never started: `?1` the code, `?2` the id. */
export const DISPATCH_SEND_FAILED_SQL = `UPDATE upstream_repull_dispatches
  SET status = 'dispatch_failed', nonce = NULL, code = ?1
  WHERE id = ?2 AND status = 'dispatched'`;

/**
 * The same end, found by the claim's nonce, for a claim whose id is not known (the insert reported
 * none): `?1` the code, `?2` the nonce. The nonce is random and held by no other row.
 */
export const DISPATCH_SEND_FAILED_BY_NONCE_SQL = `UPDATE upstream_repull_dispatches
  SET status = 'dispatch_failed', nonce = NULL, code = ?1
  WHERE nonce = ?2 AND status = 'dispatched'`;

/**
 * A run's report, one statement per phase, each a compare-and-set on the id, the nonce that
 * verified and the status it was read in. `?1` id, `?2` nonce, `?3` the status read, `?4` code,
 * `?5` workflow run URL (kept once set), `?6` the re-pull the report names (`opened` only). Every
 * edge but `started` ends the dispatch and clears the nonce, so a replay after it cannot verify.
 * `opened` needs the re-pull to be this dispatch's, of its dataset, automatic and at `pr_open` or
 * later and not closed; `finished` needs it `complete`. Both are read in the statement that
 * writes, so they hold when it applies. The nonce term is belt and braces behind the service's
 * own token check: the service binds the nonce it just verified, so only a caller of this
 * statement (a test does) can bind another, and then nothing applies.
 */
export const DISPATCH_REPORT_SQL: Readonly<Record<DispatchPhase, string>> = (() => {
  const set = (status: string, clear: boolean) => `UPDATE upstream_repull_dispatches
  SET status = '${status}', code = ?4, reported_at = datetime('now'),
      workflow_run_url = COALESCE(workflow_run_url, ?5)${clear ? ", nonce = NULL" : ""}`;
  const where = "WHERE id = ?1 AND nonce = ?2 AND status = ?3";
  const row = (statuses: readonly string[]) => `EXISTS (SELECT 1 FROM upstream_repulls r
        WHERE r.id = upstream_repull_dispatches.repull_id
          AND r.dataset_id = upstream_repull_dispatches.dataset_id
          AND r.origin = 'automatic' AND r.status IN (${quoted(statuses)}))`;
  return {
    started: `${set("started", false)}
  ${where} AND status = 'dispatched' AND ?6 IS NULL`,
    opened: `${set("opened", true)}
  ${where} AND status IN (${LIVE_LIST}) AND kind = 'open' AND repull_id = ?6
    AND ${row(OPENED_OR_LATER)}`,
    finished: `${set("finished", true)}
  ${where} AND status IN (${LIVE_LIST}) AND kind = 'finish' AND ?6 IS NULL
    AND ${row(["complete"])}`,
    refused: `${set("refused", true)}
  ${where} AND status IN (${LIVE_LIST}) AND ?6 IS NULL`,
    failed: `${set("failed", true)}
  ${where} AND status IN (${LIVE_LIST}) AND ?6 IS NULL`,
  };
})();

/**
 * The watchdog: a live dispatch older than {@link DISPATCH_DEADLINE_HOURS} said nothing in time.
 * It ends `unreported` and its nonce goes, so its run's late report is refused.
 */
export const DISPATCH_UNREPORTED_SQL = `UPDATE upstream_repull_dispatches
  SET status = 'unreported', nonce = NULL
  WHERE status IN (${LIVE_LIST}) AND dispatched_at < datetime('now', '-${DISPATCH_DEADLINE_HOURS} hours')`;

/** The watchdog's one audit row, written only when it marked something (`changes()` is its count). */
export const AUDIT_DISPATCHES_UNREPORTED_SQL = `INSERT INTO audit_log (user_id, action, resource_type, resource_id, details)
  SELECT NULL, 'repull_dispatch_unreported', 'upstream_repull_dispatch', NULL,
    json_object('marked', changes(), 'deadline_hours', ${DISPATCH_DEADLINE_HOURS})
   WHERE changes() > 0`;

// ----------------------------------------------------------------------------
// Claims
// ----------------------------------------------------------------------------

/** What the scheduler (a first dispatch) or the advance tick (a resume) asks to dispatch. */
export interface OpenCandidate {
  datasetId: string;
  upstreamDs: string;
  fromTag: string;
  toTag: string;
  /** The stalled automatic re-pull a resume continues; null or absent for a first dispatch. */
  repullId?: number | null;
}

export type DispatchClaim = { id: number; token: string };

/**
 * Why nothing was claimed; nothing is written for any of them.
 *  - `off`: not exact production, or (for an `open` claim) the open switch is off;
 *  - `unconfigured`: the Worker has no callback secret, so no token could be signed;
 *  - `cap`: today's units are used, or the cap is set to 0;
 *  - `cap-unreadable`: `REPULL_DAILY_OPEN_CAP` is set to something the reader cannot take, which
 *    reads 0 but is not a full day: it carries the reader's `source` so the caller can say so;
 *  - `candidate`: an upstream tag that is not a tag, or two that name one snapshot (external data);
 *  - `live`: a dispatch of the dataset is live;
 *  - `row`: the re-pull to resume or finish is not one this dispatch may continue;
 *  - `open-row`: a first dispatch for a dataset that has an open re-pull.
 */
export type ClaimRefusal =
  | { refused: "off" | "unconfigured" | "cap" | "candidate" | "live" | "row" | "open-row" }
  | { refused: "cap-unreadable"; source: RepullCapReading["source"] };

const looksUnique = (err: unknown) => /UNIQUE constraint failed/i.test(String(err));

/**
 * Read the claimed row back by its nonce, which is random and held by no other row, and sign its
 * token. The claim has committed by now: if either step throws, the dispatch is ended as
 * `dispatch-failed` before the error goes on, because a row left `dispatched` would hold one unit
 * of the cap and the dataset's one live slot for the eight hours until the watchdog, with no run
 * to report. It is ended by the id the claim's own insert returned, never by a read, since a read
 * is what may have failed; when the insert reported no id it is ended by its nonce. If the ending
 * itself fails, both errors are logged and the original goes on.
 */
async function issued(
  env: Bindings,
  nonce: string,
  secret: string,
  claimId: number | undefined,
): Promise<DispatchClaim> {
  try {
    const row = await env.DB.prepare(DISPATCH_BY_NONCE_SQL).bind(nonce).first<DispatchRow>();
    if (!row) throw new Error("upstream_repull_dispatches: a claimed dispatch was not readable");
    const token = await signRepullDispatchToken(
      { dispatchId: row.id, datasetId: row.dataset_id, nonce },
      secret,
    );
    return { id: row.id, token };
  } catch (err) {
    try {
      if (claimId !== undefined && claimId >= 1) {
        await markDispatchSendFailed(env.DB, claimId, "dispatch-failed");
      } else {
        await env.DB.prepare(DISPATCH_SEND_FAILED_BY_NONCE_SQL)
          .bind("dispatch-failed", nonce)
          .run();
      }
    } catch (cleanupErr) {
      console.error("[repull-dispatch] a committed claim could not be ended:", cleanupErr);
      console.error("[repull-dispatch] the claim failed with:", err);
    }
    throw err;
  }
}

/**
 * Claim a dispatch that opens a re-pull's pull request: a first one, or a resume of an automatic
 * row that stalled before its pull request opened. It counts against `REPULL_DAILY_OPEN_CAP`,
 * which is read here, so no caller can pass a larger one. Exact production and the open switch
 * only. A malformed dataset id, `ds` or re-pull id is a defect in the caller and throws; an
 * upstream tag comes from outside, so one that is not a tag, or two that name one snapshot, is the
 * refusal `candidate`.
 */
export async function claimOpenDispatch(
  env: Bindings,
  c: OpenCandidate,
): Promise<DispatchClaim | ClaimRefusal> {
  if (!autoRepullEnabled(env)) return { refused: "off" };
  const repullId = c.repullId ?? null;
  const fromTag = normalizeUpstreamTag(c.fromTag);
  const toTag = normalizeUpstreamTag(c.toTag);
  if (
    !/^on\d{6}$/.test(c.datasetId) ||
    !/^ds\d{6}$/.test(c.upstreamDs) ||
    (repullId !== null && !(Number.isSafeInteger(repullId) && repullId >= 1))
  ) {
    throw new Error("claimOpenDispatch: the candidate is not an on mirror");
  }
  if (!isOpenNeuroTag(c.fromTag) || !isOpenNeuroTag(c.toTag) || fromTag === toTag) {
    return { refused: "candidate" };
  }
  const secret = env.PRESCREEN_CALLBACK_SECRET;
  if (!secret) return { refused: "unconfigured" };
  const reading = repullOpenCap(env);
  if (reading.source === "unreadable") return { refused: "cap-unreadable", source: reading.source };
  const cap = reading.value;
  if (cap === 0) return { refused: "cap" };

  const db = env.DB;
  const nonce = crypto.randomUUID();
  let results: D1Result[];
  try {
    results = await db.batch([
      db
        .prepare(DISPATCH_OPEN_CLAIM_SQL)
        .bind(c.datasetId, c.upstreamDs, fromTag, toTag, repullId, nonce, cap),
      db.prepare(AUDIT_DISPATCH_CLAIMED_SQL),
    ]);
  } catch (err) {
    if (looksUnique(err)) return { refused: "live" };
    throw err;
  }
  if ((results[0]?.meta?.changes ?? 0) === 0) {
    const used = (await db.prepare(OPEN_DISPATCHES_TODAY_SQL).first<{ used: number }>())?.used;
    if ((used ?? 0) >= cap) return { refused: "cap" };
    return { refused: repullId === null ? "open-row" : "row" };
  }
  return issued(env, nonce, secret, results[0]?.meta?.last_row_id);
}

/**
 * Claim the finish of an automatic re-pull that merged (`merged` or `released`). Exact production
 * only, and the switches are not read: turning them off must not strand a minted DOI's lineage,
 * lock and `complete`. No cap.
 */
export async function claimFinishDispatch(
  env: Bindings,
  row: Pick<RepullRow, "id" | "dataset_id" | "origin" | "status" | "from_tag" | "to_tag">,
): Promise<DispatchClaim | ClaimRefusal> {
  if (!isExactProduction(env)) return { refused: "off" };
  if (
    row.origin !== "automatic" ||
    !/^on\d{6}$/.test(row.dataset_id) ||
    (row.status !== "merged" && row.status !== "released")
  ) {
    return { refused: "row" };
  }
  const secret = env.PRESCREEN_CALLBACK_SECRET;
  if (!secret) return { refused: "unconfigured" };
  const db = env.DB;
  const nonce = crypto.randomUUID();
  let results: D1Result[];
  try {
    results = await db.batch([
      db.prepare(DISPATCH_FINISH_INSERT_SQL).bind(row.id, nonce),
      db.prepare(AUDIT_DISPATCH_CLAIMED_SQL),
    ]);
  } catch (err) {
    if (looksUnique(err)) return { refused: "live" };
    throw err;
  }
  // The row moved (or is not what the caller read) between the read and the claim.
  if ((results[0]?.meta?.changes ?? 0) === 0) return { refused: "row" };
  return issued(env, nonce, secret, results[0]?.meta?.last_row_id);
}

/**
 * GitHub's answers to a send that say the dispatch itself was refused, for its payload or its
 * target (404, 422), and so spend an attempt: `dispatch-refused`. Every other refusal (the Worker's
 * credential, permission or rate) is `dispatch-deferred` and spends none. The one set the open
 * resume and the finish of a merged record both read.
 */
export const REFUSED_FOR_THE_DISPATCH: ReadonlySet<number> = new Set([404, 422]);

/**
 * End a dispatch that was claimed and never sent, so its run never started: the unit of the cap
 * is freed and the dataset's live slot released. Three callers, each for a dispatch nothing ran:
 * the scheduler when GitHub refused the send (a 4xx, `dispatch-refused`); `issued()` here when the
 * committed claim could not be read back or signed (`dispatch-failed`); and the scheduler when the
 * payload could not be built after the claim (`dispatch-failed`). A dispatch whose answer was lost
 * (a 5xx, a timeout, a network error) is never ended this way: it stays `dispatched` and counts,
 * because it may be running, and the watchdog ends it. Applies only while the dispatch is still
 * `dispatched`. A code outside DISPATCH_CODES is a defect and throws.
 */
export async function markDispatchSendFailed(
  db: D1Database,
  id: number,
  code: DispatchCode,
): Promise<boolean> {
  if (!isDispatchCode(code)) throw new Error("markDispatchSendFailed: not a dispatch code");
  const res = await db.prepare(DISPATCH_SEND_FAILED_SQL).bind(code, id).run();
  return (res.meta?.changes ?? 0) > 0;
}

// ----------------------------------------------------------------------------
// The automatic create's check of its dispatch
// ----------------------------------------------------------------------------

/**
 * The one answer to every failure of the dispatch token at the automatic create, as at the report
 * callback: the dispatch does not exist, has ended (its nonce is gone), or the token is not the
 * one the Worker signed for it. It names no id and no status, so the door does not say which
 * dispatches exist or how they ended.
 */
export function dispatchTokenRefusal(): RepullRefusal {
  return {
    status: 401,
    code: "dispatch-token",
    message: "The dispatch token is not the one the Worker signed for a live dispatch.",
  };
}

/**
 * The dispatch an automatic create presents, verified: its token is the one the Worker signed over
 * a live dispatch's id, dataset and nonce (checked FIRST, and every failure of it is the same
 * {@link dispatchTokenRefusal}), it is an `open` dispatch, and it names the dataset, the `ds` and
 * both tags of the plan. The caller has already checked exact production and the open switch. A
 * Worker with no callback secret answers 503: that is configuration, not an answer about a token.
 * Returns the row, wrapped (a dispatch row has a `status` and a `code` of its own, so a bare row
 * would read as a refusal), or the refusal the route answers with.
 */
export async function verifyAutomaticDispatch(
  env: Bindings,
  a: {
    dispatchId: number;
    token: string;
    datasetId: string;
    upstreamDs: string;
    fromTag: string;
    toTag: string;
  },
): Promise<{ dispatch: DispatchRow } | RepullRefusal> {
  const secret = env.PRESCREEN_CALLBACK_SECRET;
  if (!secret) {
    return {
      status: 503,
      code: "dispatch-unconfigured",
      message: "The Worker has no callback secret, so no dispatch token can be verified.",
    };
  }
  const row = await env.DB.prepare(DISPATCH_BY_ID_SQL).bind(a.dispatchId).first<DispatchRow>();
  if (!row || row.nonce === null) return dispatchTokenRefusal();
  const ok = await verifyRepullDispatchToken(
    a.token,
    { dispatchId: row.id, datasetId: row.dataset_id, nonce: row.nonce },
    secret,
  );
  if (!ok) return dispatchTokenRefusal();
  if (
    row.kind !== "open" ||
    row.dataset_id !== a.datasetId ||
    row.upstream_ds !== a.upstreamDs ||
    normalizeUpstreamTag(row.from_tag) !== normalizeUpstreamTag(a.fromTag) ||
    normalizeUpstreamTag(row.to_tag) !== normalizeUpstreamTag(a.toTag)
  ) {
    return {
      status: 409,
      code: "dispatch-mismatch",
      message: `Re-pull dispatch #${row.id} was not made for this plan: an automatic create takes the dataset, the upstream dataset and both tags its dispatch names.`,
    };
  }
  return { dispatch: row };
}

/**
 * Link a dispatch to the re-pull its run created or continues, once and only while it is still
 * live (`?1` re-pull, `?2` dispatch, `?3` the nonce that verified). A dispatch that ended between
 * the create's check and this write (the watchdog, a report) links nothing: zero rows changed is
 * a refusal, and the caller answers {@link dispatchTokenRefusal}.
 */
export const DISPATCH_LINK_SQL = `UPDATE upstream_repull_dispatches SET repull_id = ?1
  WHERE id = ?2 AND nonce = ?3 AND status IN (${LIVE_LIST}) AND kind = 'open' AND repull_id IS NULL`;

/**
 * The same link, for the batch that inserts the re-pull: the row is found by its key, never by
 * `last_insert_rowid()`, which the audit insert in the same batch moves. `?1` dataset, `?2`
 * to_tag, `?3` attempt, `?4` dispatch, `?5` the nonce that verified. It is followed in the batch
 * by {@link DISPATCH_LINK_GUARD_SQL}.
 */
export const DISPATCH_LINK_BY_KEY_SQL = `UPDATE upstream_repull_dispatches
  SET repull_id = (SELECT id FROM upstream_repulls WHERE dataset_id = ?1 AND to_tag = ?2 AND attempt = ?3)
  WHERE id = ?4 AND nonce = ?5 AND status IN (${LIVE_LIST}) AND kind = 'open' AND repull_id IS NULL`;

/**
 * The last statement of the create's batch: when the link before it changed no row (the dispatch
 * ended after the check), it raises SQLite's integer overflow (`abs` of the smallest integer), the
 * batch rolls back, and the create writes nothing. `changes()` is the link's count: 0 gives
 * -9223372036854775808, 1 gives -9223372036854775807, which `abs` takes.
 */
export const DISPATCH_LINK_GUARD_SQL = "SELECT abs(-9223372036854775807 - 1 + changes()) AS linked";

/** Whether a batch failed on {@link DISPATCH_LINK_GUARD_SQL}: the dispatch ended before the link. */
export const looksDispatchEnded = (err: unknown) => /integer overflow/i.test(String(err));

// ----------------------------------------------------------------------------
// The run's report
// ----------------------------------------------------------------------------

/** The callback's body. Strict: an unknown field is refused, and nothing here is echoed back. */
export const repullStateSchema = z
  .object({
    dispatch_id: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    dataset_id: z.string().regex(/^on\d{6}$/),
    phase: z.enum(DISPATCH_PHASES),
    code: z.enum(DISPATCH_CODES).optional(),
    repull_id: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
    workflow_run_url: z.string().max(200).regex(DISPATCH_RUN_URL_RE).optional(),
  })
  .strict()
  .superRefine((b, ctx) => {
    const ends = b.phase === "refused" || b.phase === "failed";
    if (ends !== (b.code !== undefined)) {
      ctx.addIssue({
        code: "custom",
        path: ["code"],
        message: "a code goes with refused or failed, and only with them",
      });
    }
    if ((b.phase === "opened") !== (b.repull_id !== undefined)) {
      ctx.addIssue({
        code: "custom",
        path: ["repull_id"],
        message: "repull_id goes with opened, and only with it",
      });
    }
  });

export type RepullStateBody = z.infer<typeof repullStateSchema>;

/** The callback's answers: fixed words, never a value from the request or the row. */
export type ReportOutcome =
  | { status: 200; code: "stored" }
  | { status: 400; code: "invalid-body" }
  | { status: 401; code: "invalid-token" }
  | { status: 403; code: "auto-production-only" }
  | {
      status: 409;
      code:
        | "already-started"
        | "kind-mismatch"
        | "repull-mismatch"
        | "repull-not-ready"
        | "stale-dispatch";
    }
  | { status: 503; code: "dispatch-unconfigured" };

/**
 * Store a run's report. Exact production only. The dispatch is read by id, and every refusal of
 * the token is one answer (`invalid-token`), whether the dispatch does not exist, belongs to
 * another dataset, has ended (its nonce is gone) or the token does not verify, so the door does
 * not say which dispatches exist. The edges:
 *  - `dispatched -> started`, once; a second `started` is `already-started`;
 *  - live -> `opened`, for an `open` dispatch whose linked re-pull is the one named, automatic and
 *    at `pr_open` or later;
 *  - live -> `finished`, for a `finish` dispatch whose re-pull is `complete`;
 *  - live -> `refused` or `failed`, with a code from DISPATCH_CODES.
 * Every edge but `started` clears the nonce. The switches are not read: a run that was dispatched
 * before they were turned off must still be able to say how it ended. No mail, ever.
 */
export async function storeDispatchReport(
  env: Bindings,
  token: string,
  raw: unknown,
): Promise<ReportOutcome> {
  if (!isExactProduction(env)) return { status: 403, code: "auto-production-only" };
  const parsed = repullStateSchema.safeParse(raw);
  if (!parsed.success) return { status: 400, code: "invalid-body" };
  const body = parsed.data;
  const secret = env.PRESCREEN_CALLBACK_SECRET;
  if (!secret) return { status: 503, code: "dispatch-unconfigured" };

  const db = env.DB;
  const row = await db.prepare(DISPATCH_BY_ID_SQL).bind(body.dispatch_id).first<DispatchRow>();
  if (!row || row.dataset_id !== body.dataset_id || row.nonce === null) {
    return { status: 401, code: "invalid-token" };
  }
  const verified = await verifyRepullDispatchToken(
    token,
    { dispatchId: row.id, datasetId: row.dataset_id, nonce: row.nonce },
    secret,
  );
  if (!verified) return { status: 401, code: "invalid-token" };

  if (body.phase === "started" && row.status === "started") {
    return { status: 409, code: "already-started" };
  }
  if (
    (body.phase === "opened" && row.kind !== "open") ||
    (body.phase === "finished" && row.kind !== "finish")
  ) {
    return { status: 409, code: "kind-mismatch" };
  }
  if (body.phase === "opened" && body.repull_id !== row.repull_id) {
    return { status: 409, code: "repull-mismatch" };
  }

  const res = await db
    .prepare(DISPATCH_REPORT_SQL[body.phase])
    .bind(
      row.id,
      row.nonce,
      row.status,
      body.code ?? null,
      body.workflow_run_url ?? null,
      body.repull_id ?? null,
    )
    .run();
  if ((res.meta?.changes ?? 0) > 0) return { status: 200, code: "stored" };
  // Nothing applied: either the dispatch moved since it was read (another report, the watchdog),
  // or the re-pull the report names is not where the edge needs it.
  const after = await db.prepare(DISPATCH_BY_ID_SQL).bind(row.id).first<DispatchRow>();
  if (after && after.status === row.status && after.nonce === row.nonce) {
    return { status: 409, code: "repull-not-ready" };
  }
  return { status: 409, code: "stale-dispatch" };
}

// ----------------------------------------------------------------------------
// The watchdog
// ----------------------------------------------------------------------------

/**
 * End every live dispatch older than {@link DISPATCH_DEADLINE_HOURS} as `unreported`, with one
 * audit row when it marked any. Exact production only (null otherwise, with nothing read or
 * written). It does not read the switches: turning them off must not strand a live row, whose
 * nonce would otherwise hold the dataset's one live slot for good.
 */
export async function sweepUnreportedDispatches(env: Bindings): Promise<{ marked: number } | null> {
  if (!isExactProduction(env)) return null;
  const db = env.DB;
  const [update] = await db.batch([
    db.prepare(DISPATCH_UNREPORTED_SQL),
    db.prepare(AUDIT_DISPATCHES_UNREPORTED_SQL),
  ]);
  // An absent count is not zero (ADR 0053): a sweep that cannot say what it marked has not said
  // that it marked nothing, and the audit row it wrote may hold a count the caller never sees.
  const marked = update?.meta?.changes;
  if (typeof marked !== "number") {
    throw new Error("sweepUnreportedDispatches: the database did not report how many it marked");
  }
  return { marked };
}
