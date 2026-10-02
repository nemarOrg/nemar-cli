/**
 * The Neurobagel writer's status (epic #1586, phase 4): what an operator reads to
 * answer "is the store right, and is anything waiting on a person?".
 *
 * READ-ONLY. It writes nothing to the bucket or to D1. Every section that cannot be
 * answered is `null` with a warning, never zero: an unreadable store is not an empty
 * one (ADR 0054). Nothing here carries participant data, and the anonymity-class
 * findings are a COUNT only, never an identifier: "this dataset's data said it was
 * anonymous" is a fact about a person being concealed (ADR 0067).
 */

import type {
  NeurobagelRunSummary,
  NeurobagelStatus,
} from "../../../shared/contract/neurobagel-admin.js";
import type { Bindings } from "../types/bindings.js";
import { isNonProductionEnv } from "./environment.js";
import { type CurationResolver, defaultCurationResolver } from "./neurobagel-curation.js";
import {
  LEDGER_ACTIONS,
  currentSignature,
  hasCompleteSet,
  ledgerTime,
  loadPlanRows,
  readLedger,
} from "./neurobagel-plan.js";
import {
  META,
  NEUROBAGEL_INDEX_KEY,
  buildIndexDocument,
  listStore,
  readStoredIndex,
} from "./neurobagel-store.js";
import { readLatestVerification } from "./neurobagel-verify.js";
import {
  LOADER_TOTAL_CAP_BYTES,
  RECONCILE_HARD_LIMIT,
  neurobagelWriterMode,
  reconcileLimit,
} from "./neurobagel-writer.js";

export type { NeurobagelStatus };
type RunSummary = NeurobagelRunSummary;

async function lastRuns(
  db: D1Database,
): Promise<{ last: RunSummary | null; reconcile: RunSummary | null }> {
  const result = await db
    .prepare(
      `SELECT resource_id, details, timestamp
         FROM audit_log
        WHERE action = ?
        ORDER BY id DESC
        LIMIT 50`,
    )
    .bind(LEDGER_ACTIONS.run)
    .all<{ resource_id: string | null; details: string | null; timestamp: string }>();
  let last: RunSummary | null = null;
  let reconcile: RunSummary | null = null;
  for (const row of result.results ?? []) {
    let summary: Record<string, unknown> = {};
    try {
      summary = JSON.parse(row.details ?? "{}") as Record<string, unknown>;
    } catch {
      // a damaged row is still a run that happened
    }
    const entry = { at: row.timestamp, trigger: row.resource_id ?? "unknown", summary };
    last ??= entry;
    if (entry.trigger === "cron") {
      reconcile ??= entry;
      break;
    }
  }
  return { last, reconcile };
}

export async function neurobagelStatus(
  env: Bindings,
  now: Date = new Date(),
  curation: CurationResolver = defaultCurationResolver,
): Promise<NeurobagelStatus> {
  const warnings: string[] = [];
  const status: NeurobagelStatus = {
    environment: env.ENVIRONMENT ?? null,
    writer: { mode: neurobagelWriterMode(env) },
    read_route: { token_configured: Boolean(env.NEUROBAGEL_READ_TOKEN) },
    limits: { reconcile_max: reconcileLimit(env), hard_max: RECONCILE_HARD_LIMIT },
    counts: {
      eligible: null,
      written: null,
      missing: null,
      stale: null,
      incomplete: null,
      residue: null,
    },
    store: {
      configured: Boolean(env.NEUROBAGEL),
      objects: null,
      unexpected_objects: null,
      total_bytes: null,
      over_loader_cap: null,
    },
    index: { present: null, generated_at: null, entries: null, matches_store: null },
    last_run: null,
    last_reconcile: null,
    needs_review: [],
    anonymity_findings: null,
    verification: null,
    warnings,
  };

  // D1: who is eligible.
  let rows: Awaited<ReturnType<typeof loadPlanRows>>["rows"] = [];
  try {
    rows = (await loadPlanRows(env.DB)).rows;
    status.counts.eligible = rows.length;
  } catch (err) {
    warnings.push(
      `eligible datasets could not be read: ${err instanceof Error ? err.message : err}`,
    );
  }
  const eligibleIds = new Set(rows.map((r) => r.dataset_id));

  // The ledger: refusals that stand, and the anonymity-class count.
  let ledger: Awaited<ReturnType<typeof readLedger>> | null = null;
  try {
    ledger = await readLedger(env.DB);
    status.anonymity_findings = [...ledger.values()].filter(
      (e) => e.label.state === "anonymity",
    ).length;
  } catch (err) {
    warnings.push(
      `the findings ledger could not be read: ${err instanceof Error ? err.message : err}`,
    );
  }
  try {
    const runs = await lastRuns(env.DB);
    status.last_run = runs.last;
    status.last_reconcile = runs.reconcile;
  } catch (err) {
    warnings.push(`the run history could not be read: ${err instanceof Error ? err.message : err}`);
  }

  // The latest verification sweep. No row is "never ran", which the CLI says plainly; an
  // unreadable row is a warning, not a healthy one.
  try {
    const latest = await readLatestVerification(env.DB);
    if (latest.kind === "ok") status.verification = latest.verification;
    else if (latest.kind === "unreadable") {
      warnings.push("the latest verification heartbeat could not be read as one");
    }
  } catch (err) {
    warnings.push(
      `the verification record could not be read: ${err instanceof Error ? err.message : err}`,
    );
  }

  // The store.
  if (env.NEUROBAGEL) {
    try {
      const listing = await listStore(env.NEUROBAGEL);
      status.store.objects = listing.objects;
      status.store.unexpected_objects = listing.unexpected.length;
      let total = 0;
      let written = 0;
      let incomplete = 0;
      let residue = 0;
      let missing = 0;
      let stale = 0;
      for (const stored of listing.datasets.values()) {
        for (const kind of ["jsonld", "dictionary", "description"] as const) {
          total += stored[kind]?.size ?? 0;
        }
        if (!eligibleIds.has(stored.id)) residue++;
        else if (hasCompleteSet(stored)) written++;
        else incomplete++;
      }
      status.store.total_bytes = total;
      status.store.over_loader_cap = total > LOADER_TOTAL_CAP_BYTES;
      status.counts.written = status.counts.eligible === null ? null : written;
      status.counts.incomplete = incomplete;
      status.counts.residue = residue;

      if (status.counts.eligible !== null) {
        for (const row of rows) {
          const stored = listing.datasets.get(row.dataset_id);
          if (!hasCompleteSet(stored)) {
            missing++;
            continue;
          }
          const sig = await currentSignature(
            row,
            // Curation hashes join the signature only when a resolver says so; the
            // status of a dataset whose lookup fails is "stale" (it will be examined).
            await curation(row.dataset_id).then((r) => (r.kind === "entry" ? r.hash : null)),
          );
          if (stored?.jsonld?.meta[META.signature] !== sig) stale++;
          const flags = (stored?.jsonld?.meta[META.flags] ?? "").split(",").filter(Boolean);
          if (flags.length > 0) {
            status.needs_review.push({ id: row.dataset_id, source: "report", flags });
          }
        }
        status.counts.missing = missing;
        status.counts.stale = stale;
      }

      const index = await readStoredIndex(env.NEUROBAGEL);
      status.index.present = index.etag !== null;
      status.index.generated_at = index.document?.generated_at ?? null;
      status.index.entries = index.document?.datasets.length ?? null;
      if (status.counts.eligible !== null) {
        const built = await buildIndexDocument(
          listing,
          eligibleIds,
          index.document,
          now.toISOString(),
        );
        status.index.matches_store = !built.changed;
      }
    } catch (err) {
      warnings.push(`the store could not be read: ${err instanceof Error ? err.message : err}`);
    }
  } else {
    warnings.push("store_unconfigured: no NEUROBAGEL bucket is bound");
  }

  if (ledger) {
    for (const entry of ledger.values()) {
      if (entry.label.state === "refused" && eligibleIds.has(entry.dataset_id)) {
        status.needs_review.push({
          id: entry.dataset_id,
          source: "refusal",
          code: entry.label.code,
          // Since when it has stood: a refusal that has stood for days is not a blip. The
          // ledger re-records a standing refusal once a day, so this is the LAST day it was
          // confirmed, and the age to read it by is "at least this long".
          since: ledgerTime(entry.at)?.toISOString() ?? entry.at,
        });
      }
    }
  }
  status.needs_review.sort((a, b) => a.id.localeCompare(b.id));

  if (!isNonProductionEnv(env) && status.writer.mode === "enabled" && !env.NEUROBAGEL_READ_TOKEN) {
    warnings.push(
      "the writer is enabled but NEUROBAGEL_READ_TOKEN is unset: the node cannot read the store",
    );
  }
  return status;
}

const DATASET_ID_IN_TEXT = /\b(?:nm|on)\d{6}\b/g;

/**
 * Every dataset id the store holds ANYTHING for, for the anonymity sweep (ADR 0067's
 * amendment): an id named by any object key, and any id written anywhere in the index, so an
 * entry the writer did not stamp, an object it does not recognise and an index it cannot parse
 * are all found. Null when no bucket is bound, which means there is no store to hold a deposit.
 * READ-ONLY, and a failed read THROWS: "could not look" must never read as "nothing there".
 */
export async function readStoreDatasetIds(
  env: Pick<Bindings, "NEUROBAGEL">,
): Promise<Set<string> | null> {
  if (!env.NEUROBAGEL) return null;
  const listing = await listStore(env.NEUROBAGEL);
  const ids = new Set(listing.datasets.keys());
  for (const key of listing.unexpected) {
    for (const m of key.matchAll(DATASET_ID_IN_TEXT)) ids.add(m[0]);
  }
  const index = await env.NEUROBAGEL.get(NEUROBAGEL_INDEX_KEY);
  if (index) {
    for (const m of (await index.text()).matchAll(DATASET_ID_IN_TEXT)) ids.add(m[0]);
  }
  return ids;
}
