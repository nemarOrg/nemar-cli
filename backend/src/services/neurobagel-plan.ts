/**
 * What a Neurobagel writer run reads from D1, and the order it does its work in
 * (epic #1586, phase 4; ADR 0084). Reads only: nothing here writes the store, and
 * the one thing it writes to D1 is the findings ledger in `audit_log`.
 *
 * ONE QUERY finds the eligible datasets with the cheap fields every signature is
 * built from; no enrichment document is read. The dataset's `concept_doi` is only
 * ever read through the blinded projection (`CONCEPT_DOI_SQL`), though this feature
 * has no reason to publish it for a dataset that is anonymous: eligibility already
 * excludes those, and the projection is the belt for the braces.
 *
 * THE ORDER OF WORK (a tick examines at most N datasets, so the order is what makes
 * progress across ticks):
 *   1. missing   eligible, with no complete artifact set in the store: by id.
 *   2. stale     a stored signature that is not the current one: by id.
 *   3. rotation  the rest, a window that moves by N each UTC day. This is the only way a
 *                rewrite of a manifest with no D1 change is found, and it is what the daily
 *                reconcile is for.
 * A dataset that is missing or stale but whose ledger shows a STANDING REFUSAL recorded
 * against its current signature is PARKED: it joins the rotation instead of the first two
 * classes. Without that, a dataset refused for ever (no manifest, a document over the
 * loader's cap) is "missing" on every tick, sorts by id ahead of the healthy ones, and
 * takes a slot of every tick for ever; enough of them and a healthy dataset is never
 * examined. A parked dataset is still re-examined, on the rotation's cadence, and at once
 * when its row changes (its signature then no longer matches the one the refusal named).
 *
 * THE GUARANTEE, stated exactly: when no dataset is missing or stale, every one is
 * examined within ceil(eligible / N) days. Missing or stale work takes slots first, so
 * while there is any the rotation's window is narrower than N and a full cycle takes
 * longer; the order is still deterministic, and nothing is examined twice in a day.
 * The order is a function of the inputs and the date, never of a clock inside the
 * loop, so a test (and a person) can say what a tick will do.
 */

import { auditLogStatement } from "../db/audit-log.js";
import { CONCEPT_DOI_SQL } from "./anonymity.js";
import {
  type FederationRow,
  NEUROBAGEL_ELIGIBLE_SQL,
  NEUROBAGEL_ROW_COLUMNS,
  isFederationEligible,
} from "./neurobagel-eligibility.js";
import { cheapSignature } from "./neurobagel-fingerprint.js";
import { META, type StoredDataset } from "./neurobagel-store.js";

/** An eligible dataset with the cheap fields. */
export interface PlanRow extends FederationRow {
  name: string | null;
  subject_count: number | null;
  license: string | null;
  /** The blinded projection, never the raw column. */
  concept_doi: string | null;
  enrichment_length: number | null;
  latest_version: string | null;
}

const PLAN_SELECT = `SELECT ${NEUROBAGEL_ROW_COLUMNS},
    d.name, d.subject_count, d.license, ${CONCEPT_DOI_SQL} AS concept_doi,
    length(d.enrichment_json) AS enrichment_length,
    (SELECT dv.version FROM dataset_versions dv
      WHERE dv.dataset_id = d.dataset_id
      ORDER BY dv.created_at DESC, dv.id DESC LIMIT 1) AS latest_version
  FROM datasets d`;

/** Every eligible dataset, in id order, with the cheap fields. */
export const NEUROBAGEL_PLAN_ROWS_SQL = `${PLAN_SELECT}
 WHERE ${NEUROBAGEL_ELIGIBLE_SQL}
 ORDER BY d.dataset_id`;

/** The same, for the named datasets only: bind a JSON array of ids. */
export const NEUROBAGEL_PLAN_ROWS_FOR_SQL = `${PLAN_SELECT}
 WHERE ${NEUROBAGEL_ELIGIBLE_SQL}
   AND d.dataset_id IN (SELECT value FROM json_each(?))
 ORDER BY d.dataset_id`;

/**
 * The eligible rows, each re-confirmed in TypeScript. A row the SQL returned and the check
 * refuses is dropped and counted. With `ids`, only those datasets are read: a hook for one
 * dataset has no business reading, signing and hashing the whole catalog.
 */
export async function loadPlanRows(
  db: D1Database,
  ids?: readonly string[],
): Promise<{ rows: PlanRow[]; refusedByRecheck: number }> {
  const result =
    ids === undefined
      ? await db.prepare(NEUROBAGEL_PLAN_ROWS_SQL).all<PlanRow>()
      : await db
          .prepare(NEUROBAGEL_PLAN_ROWS_FOR_SQL)
          .bind(JSON.stringify([...ids]))
          .all<PlanRow>();
  const rows: PlanRow[] = [];
  let refusedByRecheck = 0;
  for (const row of result.results ?? []) {
    if (isFederationEligible(row)) rows.push(row);
    else refusedByRecheck++;
  }
  return { rows, refusedByRecheck };
}

/** Why a dataset is in the work list. */
export type WorkClass = "requested" | "missing" | "stale" | "rotation";

export interface PlannedWork {
  id: string;
  class: WorkClass;
}

/** Has a COMPLETE set: a stamped JSON-LD and both companions. */
export function hasCompleteSet(stored: StoredDataset | undefined): boolean {
  return Boolean(stored?.jsonld?.meta[META.fingerprint] && stored.dictionary && stored.description);
}

/** What a signature reads: a plan row, or the writer's own re-read of one dataset. */
export type SignatureSource = Pick<
  PlanRow,
  | "dataset_id"
  | "name"
  | "subject_count"
  | "license"
  | "concept_doi"
  | "enrichment_length"
  | "latest_version"
>;

/**
 * The signature every row would carry if it were rewritten now. The writer stamps one
 * built from the SAME read its fingerprint comes from, never from the plan's earlier row:
 * a row edited between the two would otherwise carry a signature of a state it was not
 * built from, and read as stale forever.
 */
export async function currentSignature(
  row: SignatureSource,
  curationHash: string | null,
): Promise<string> {
  return cheapSignature(
    {
      dataset_id: row.dataset_id,
      name: row.name,
      subject_count: row.subject_count,
      license: row.license,
      concept_doi: row.concept_doi,
      latest_version: row.latest_version,
    },
    row.enrichment_length ?? 0,
    curationHash,
  );
}

/** The UTC day number, which moves the rotation window. */
export function utcDay(now: Date): number {
  return Math.floor(now.getTime() / 86_400_000);
}

/**
 * Choose what this run examines.
 *
 * `requested` ids (an admin's list, or a hook's one dataset) are examined first, in
 * the order given and then by id, and are bounded by `limit` like everything else.
 * Without a list: missing, then stale, then the rotation window.
 */
export function planWork(args: {
  rows: readonly PlanRow[];
  stored: ReadonlyMap<string, StoredDataset>;
  signatures: ReadonlyMap<string, string>;
  limit: number;
  day: number;
  requested?: readonly string[];
  /** Datasets with a standing refusal against their current signature ({@link standingRefusals}). */
  parked?: ReadonlySet<string>;
}): {
  work: PlannedWork[];
  eligible: number;
  unexamined: number;
  missing: number;
  stale: number;
  parked: number;
} {
  const { rows, stored, signatures, limit, day, requested, parked: standing } = args;
  const ids = rows.map((r) => r.dataset_id);
  const eligibleSet = new Set(ids);

  const missing: string[] = [];
  const stale: string[] = [];
  const rest: string[] = [];
  let parkedCount = 0;
  for (const id of ids) {
    const s = stored.get(id);
    const incomplete = !hasCompleteSet(s);
    const isStale = !incomplete && s?.jsonld?.meta[META.signature] !== signatures.get(id);
    if ((incomplete || isStale) && standing?.has(id)) {
      // Refused, and nothing it is built from has changed since: the rotation's business.
      rest.push(id);
      parkedCount++;
    } else if (incomplete) missing.push(id);
    else if (isStale) stale.push(id);
    else rest.push(id);
  }
  rest.sort();

  let work: PlannedWork[];
  if (requested !== undefined) {
    const wanted = [...new Set(requested)].filter((id) => eligibleSet.has(id)).sort();
    work = wanted.map((id) => ({ id, class: "requested" as const }));
  } else {
    work = [
      ...missing.map((id) => ({ id, class: "missing" as const })),
      ...stale.map((id) => ({ id, class: "stale" as const })),
    ];
    if (rest.length > 0) {
      const start = (day * Math.max(1, limit)) % rest.length;
      for (let i = 0; i < rest.length; i++) {
        work.push({ id: rest[(start + i) % rest.length] as string, class: "rotation" });
      }
    }
  }
  const taken = work.slice(0, Math.max(0, limit));
  return {
    work: taken,
    eligible: ids.length,
    unexamined: Math.max(0, work.length - taken.length),
    missing: missing.length,
    stale: stale.length,
    parked: parkedCount,
  };
}

/**
 * The datasets whose ledger entry is a refusal recorded against the signature they have
 * now: nothing the writer reads has changed, so examining them again would only refuse
 * them again. A transient failure is never in the ledger, so it is never parked.
 */
export function standingRefusals(
  ledger: ReadonlyMap<string, LedgerEntry>,
  signatures: ReadonlyMap<string, string>,
  now: Date,
  windowMs: number = PARK_WINDOW_MS,
): Set<string> {
  const parked = new Set<string>();
  for (const [id, entry] of ledger) {
    if (entry.label.state !== "refused" || !entry.label.sig) continue;
    if (entry.label.sig !== signatures.get(id)) continue;
    // A refusal parks a dataset for a bounded time, not for ever: nothing may hide one
    // for more than the window (plus the interval to the next tick), whatever the code.
    if (ageMs(entry.at, now) >= windowMs) continue;
    parked.add(id);
  }
  return parked;
}

/**
 * How long a standing refusal keeps a dataset out of the first two classes. After it the
 * dataset is examined again, and a refusal that stands is RE-RECORDED (a fresh ledger row,
 * so the next window starts), so a dataset costs one slot a window while it stays refused.
 * A day: a refusal that stands for more than that is a finding for a person, and the cost
 * of examining one dataset a day is a few operations.
 */
export const PARK_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Milliseconds from a ledger row's timestamp (SQLite `YYYY-MM-DD HH:MM:SS`, UTC, or ISO) to `now`. */
export function ageMs(at: string, now: Date): number {
  const iso = /[zZ]|[+-]\d\d:?\d\d$/.test(at) ? at : `${at.replace(" ", "T")}Z`;
  const t = Date.parse(iso);
  // An unreadable timestamp is as old as it can be: it parks nothing.
  return Number.isNaN(t) ? Number.POSITIVE_INFINITY : now.getTime() - t;
}

// ----------------------------------------------------------------------------
// The findings ledger: audit_log rows, written on a CHANGE of state only.
// ----------------------------------------------------------------------------

export const LEDGER_ACTIONS = {
  refused: "neurobagel_refused",
  cleared: "neurobagel_cleared",
  anonymity: "neurobagel_anonymity_finding",
  run: "neurobagel_run",
} as const;

export type LedgerLabel =
  | {
      state: "refused";
      code: string;
      /**
       * The dataset's cheap signature when it was refused. A refusal recorded against the
       * signature the row has NOW is standing (nothing the writer reads has changed); one
       * recorded against another is not, and the dataset is examined again.
       */
      sig?: string;
    }
  | { state: "anonymity" }
  | { state: "clear" };

export interface LedgerEntry {
  dataset_id: string;
  label: LedgerLabel;
  at: string;
}

interface LedgerRow {
  id: number;
  action: string;
  resource_id: string | null;
  details: string | null;
  timestamp: string;
}

/**
 * The latest ledger state of every dataset that has one. Only TRANSITIONS are
 * recorded, so this is a short table however long the system runs: a dataset that
 * stays refused is one row, not one per day.
 */
export async function readLedger(db: D1Database): Promise<Map<string, LedgerEntry>> {
  const result = await db
    .prepare(
      `SELECT id, action, resource_id, details, timestamp
         FROM audit_log
        WHERE action IN (?, ?, ?)
        ORDER BY id`,
    )
    .bind(LEDGER_ACTIONS.refused, LEDGER_ACTIONS.cleared, LEDGER_ACTIONS.anonymity)
    .all<LedgerRow>();
  const out = new Map<string, LedgerEntry>();
  for (const row of result.results ?? []) {
    if (!row.resource_id) continue;
    let label: LedgerLabel;
    if (row.action === LEDGER_ACTIONS.cleared) label = { state: "clear" };
    else if (row.action === LEDGER_ACTIONS.anonymity) label = { state: "anonymity" };
    else {
      let code = "unknown";
      let sig: string | undefined;
      try {
        const parsed = JSON.parse(row.details ?? "{}") as { code?: unknown; sig?: unknown };
        if (typeof parsed.code === "string") code = parsed.code;
        if (typeof parsed.sig === "string") sig = parsed.sig;
      } catch {
        // a damaged row still means "refused"
      }
      label = { state: "refused", code, ...(sig ? { sig } : {}) };
    }
    out.set(row.resource_id, { dataset_id: row.resource_id, label, at: row.timestamp });
  }
  return out;
}

function sameLabel(a: LedgerLabel | undefined, b: LedgerLabel): boolean {
  if (!a) return b.state === "clear";
  if (a.state !== b.state) return false;
  // A refusal is the same finding only for the same code against the same signature: the
  // same code after the row changed is a new fact, and the parking decision reads it.
  return a.state === "refused" && b.state === "refused"
    ? a.code === b.code && a.sig === b.sig
    : true;
}

/**
 * Record a dataset's state if it CHANGED. Returns whether a row was written.
 *
 * The anonymity-class label goes to the audit log and nowhere else: no GitHub issue
 * (`nemarDatasets` is public-facing, ADR 0067) and no mail.
 */
export async function recordLedgerState(
  db: D1Database,
  ledger: Map<string, LedgerEntry>,
  datasetId: string,
  label: LedgerLabel,
  detail: Record<string, string | number | boolean | null> = {},
  reconfirm?: { now: Date; windowMs: number },
): Promise<boolean> {
  const previous = ledger.get(datasetId);
  // A refusal that stands is written AGAIN once its parking window is spent, so the next
  // window starts from a fresh row. One row per standing refusal per window, and no more.
  const spent =
    reconfirm !== undefined &&
    label.state === "refused" &&
    previous !== undefined &&
    ageMs(previous.at, reconfirm.now) >= reconfirm.windowMs;
  if (sameLabel(previous?.label, label) && !spent) return false;
  const action =
    label.state === "refused"
      ? LEDGER_ACTIONS.refused
      : label.state === "anonymity"
        ? LEDGER_ACTIONS.anonymity
        : LEDGER_ACTIONS.cleared;
  const details =
    label.state === "refused"
      ? { code: label.code, ...(label.sig ? { sig: label.sig } : {}), ...detail }
      : detail;
  await auditLogStatement(db, {
    userId: null,
    action,
    resourceType: "dataset",
    resourceId: datasetId,
    details: JSON.stringify(details),
  }).run();
  ledger.set(datasetId, { dataset_id: datasetId, label, at: new Date().toISOString() });
  return true;
}
