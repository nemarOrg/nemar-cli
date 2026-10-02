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
 *   3. rotation  the rest, a window that moves by N each UTC day, so every dataset
 *                is examined within ceil(eligible / N) days even when nothing is
 *                known to have changed. This is the only way a rewrite of a manifest
 *                with no D1 change is found, and it is what the daily reconcile is for.
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
}): { work: PlannedWork[]; eligible: number; unexamined: number; missing: number; stale: number } {
  const { rows, stored, signatures, limit, day, requested } = args;
  const ids = rows.map((r) => r.dataset_id);
  const eligibleSet = new Set(ids);

  const missing: string[] = [];
  const stale: string[] = [];
  const rest: string[] = [];
  for (const id of ids) {
    const s = stored.get(id);
    if (!hasCompleteSet(s)) missing.push(id);
    else if (s?.jsonld?.meta[META.signature] !== signatures.get(id)) stale.push(id);
    else rest.push(id);
  }

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
  };
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
  | { state: "refused"; code: string }
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
      try {
        const parsed = JSON.parse(row.details ?? "{}") as { code?: unknown };
        if (typeof parsed.code === "string") code = parsed.code;
      } catch {
        // a damaged row still means "refused"
      }
      label = { state: "refused", code };
    }
    out.set(row.resource_id, { dataset_id: row.resource_id, label, at: row.timestamp });
  }
  return out;
}

function sameLabel(a: LedgerLabel | undefined, b: LedgerLabel): boolean {
  if (!a) return b.state === "clear";
  if (a.state !== b.state) return false;
  return a.state === "refused" && b.state === "refused" ? a.code === b.code : true;
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
): Promise<boolean> {
  if (sameLabel(ledger.get(datasetId)?.label, label)) return false;
  const action =
    label.state === "refused"
      ? LEDGER_ACTIONS.refused
      : label.state === "anonymity"
        ? LEDGER_ACTIONS.anonymity
        : LEDGER_ACTIONS.cleared;
  const details = label.state === "refused" ? { code: label.code, ...detail } : detail;
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
