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

import type { Bindings } from "../types/bindings.js";
import { isNonProductionEnv } from "./environment.js";
import { type CurationResolver, defaultCurationResolver } from "./neurobagel-curation.js";
import {
  LEDGER_ACTIONS,
  currentSignature,
  hasCompleteSet,
  loadPlanRows,
  readLedger,
} from "./neurobagel-plan.js";
import { META, buildIndexDocument, listStore, readStoredIndex } from "./neurobagel-store.js";
import {
  LOADER_TOTAL_CAP_BYTES,
  RECONCILE_HARD_LIMIT,
  neurobagelWriterMode,
  reconcileLimit,
} from "./neurobagel-writer.js";

export interface RunSummary {
  at: string;
  trigger: string;
  summary: Record<string, unknown>;
}

export interface NeurobagelStatus {
  environment: string | null;
  writer: { mode: "enabled" | "disabled" | "store_unconfigured" };
  /** Booleans only: the secret is never read back. */
  read_route: { token_configured: boolean };
  limits: { reconcile_max: number; hard_max: number };
  /** Everything below is null when it could not be determined, never zero. */
  counts: {
    eligible: number | null;
    written: number | null;
    missing: number | null;
    stale: number | null;
    incomplete: number | null;
    /** In the store but no longer eligible: waiting to be deleted. */
    residue: number | null;
  };
  store: {
    configured: boolean;
    objects: number | null;
    unexpected_objects: number | null;
    total_bytes: number | null;
    over_loader_cap: boolean | null;
  };
  index: {
    present: boolean | null;
    generated_at: string | null;
    entries: number | null;
    matches_store: boolean | null;
  };
  last_run: RunSummary | null;
  last_reconcile: RunSummary | null;
  needs_review: {
    id: string;
    source: "report" | "refusal";
    flags?: string[];
    code?: string;
  }[];
  /** A count, never an identifier. */
  anonymity_findings: number | null;
  warnings: string[];
}

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
