/**
 * Automatic OpenNeuro import — the paced engine (epic #775, Phase 2).
 *
 * A prod-only cron (every ~30 min) calls autoImportTick, which imports ONE new
 * in-scope OpenNeuro dataset roughly every 90 min: gate -> discover + dedup
 * (Phase 1, zero GitHub calls) -> pick one resiliently -> dispatch
 * onboard-openneuro. Owner-locked: import AND publish (no review gate), one
 * dataset / ~90 min. Behind AUTO_IMPORT_ENABLED so it ships dark.
 */

import type { Bindings } from "../types/bindings";
import { triggerOpenNeuroOnboard } from "./github";
import { getDatasetsToken } from "./github-auth";
import {
  type DiscoveredDataset,
  diffNewDatasets,
  discoverOpenNeuroDatasets,
  getActiveImportSourceIds,
  getImportedSourceIds,
} from "./openneuro-discovery";

/** The cron schedule that drives the tick (must match wrangler-sccn.toml). */
export const AUTO_IMPORT_CRON = "*/30 * * * *";
/**
 * Default pace (minutes) when the AUTO_IMPORT_MIN_INTERVAL_MIN macro is unset or
 * invalid. 25 is just UNDER the 30-min cron tick so each tick clears the gate
 * (a dispatch lands a few seconds after a tick -> the next tick is ~30 min later
 * -> >= 25 -> fires) for a ~30-min cadence; a flat 30 would slip to ~60 on tick
 * alignment. Faster than the original 90 is safe: discovery + dedup are D1-only
 * (no GitHub on the check), so the rate limit that motivated the slow pace doesn't
 * apply. RAISE the macro to slow imports down live (no deploy) if a run misbehaves.
 */
const DEFAULT_MIN_INTERVAL_MIN = 25;

/**
 * Resolve the dispatch gate (ms) from the AUTO_IMPORT_MIN_INTERVAL_MIN env macro,
 * falling back to the default. Tunable at runtime so the pace can be retuned (or
 * throttled back) without a code change. Exported for testing.
 */
export function resolveMinIntervalMs(env: Pick<Bindings, "AUTO_IMPORT_MIN_INTERVAL_MIN">): number {
  const raw = Number(env.AUTO_IMPORT_MIN_INTERVAL_MIN);
  const minutes = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MIN_INTERVAL_MIN;
  return minutes * 60 * 1000;
}
/** Bounded retries: after this many auto-dispatches a failed dataset is parked. */
const MAX_AUTO_ATTEMPTS = 3;
/** Backoff before re-picking a freshly-failed dataset. */
const RETRY_BACKOFF_MS = 6 * 60 * 60 * 1000;

/** ds###### -> on###### (replicates src/lib/import-openneuro mapDatasetId; the CLI lib isn't importable from the Worker). */
export function mapToNemarId(openneuroId: string): string | null {
  const m = openneuroId.match(/^ds(\d{6})$/);
  return m ? `on${m[1]}` : null;
}

/**
 * Parse a SQLite `datetime('now')` value ("YYYY-MM-DD HH:MM:SS", UTC, no zone)
 * or an ISO string to epoch ms. Returns null if unparseable. SQLite's space-
 * separated, zone-less form is parsed as LOCAL time by Date.parse, so normalise
 * to ISO-UTC first.
 */
export function parseSqliteUtc(ts: string | null | undefined): number | null {
  if (!ts) return null;
  const iso = ts.includes("T") ? ts : `${ts.replace(" ", "T")}Z`;
  const ms = Date.parse(iso.endsWith("Z") || /[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}Z`);
  return Number.isNaN(ms) ? null : ms;
}

/** ~90-min gate decision. Pure so the cadence is unit-testable. */
export function decideAutoImportGate(args: {
  lastDispatchAt: string | null;
  now: number;
  minIntervalMs: number;
}): { proceed: boolean; reason: string } {
  if (!args.lastDispatchAt) return { proceed: true, reason: "never dispatched" };
  const last = parseSqliteUtc(args.lastDispatchAt);
  if (last === null) return { proceed: true, reason: "unparseable last-dispatch timestamp" };
  const elapsedMin = Math.round((args.now - last) / 60000);
  if (args.now - last >= args.minIntervalMs) {
    return { proceed: true, reason: `${elapsedMin} min since last dispatch` };
  }
  return {
    proceed: false,
    reason: `only ${elapsedMin} min since last dispatch (< ${Math.round(args.minIntervalMs / 60000)})`,
  };
}

/** Prior-failed-import info for a candidate, keyed by OpenNeuro id (ds######). */
export type FailedJobInfo = Map<string, { autoAttempts: number; updatedAt: string }>;

/**
 * Pick the next dataset to import. `candidates` is the Phase-1 diff (already
 * minus imported / in-flight / quarantined / rolled_back); some carry a prior
 * `failed` import_jobs row in `jobInfo`. Resilience (#775): exclude a failed
 * candidate that has exhausted retries or is still in backoff; order fresh-first
 * then oldest-failed, so failures rotate to the back and the trickle never wedges
 * on one bad dataset. Pure -> exhaustively unit-tested.
 */
export function pickNextDataset(
  candidates: DiscoveredDataset[],
  jobInfo: FailedJobInfo,
  opts: { maxAttempts: number; backoffMs: number; now: number },
): DiscoveredDataset | null {
  const eligible = candidates
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => {
      const j = jobInfo.get(c.id);
      if (!j) return true; // fresh
      if (j.autoAttempts >= opts.maxAttempts) return false; // bounded retries -> park
      const failedAt = parseSqliteUtc(j.updatedAt);
      if (failedAt !== null && failedAt + opts.backoffMs > opts.now) return false; // backoff
      return true;
    });
  eligible.sort((a, b) => {
    const ja = jobInfo.get(a.c.id);
    const jb = jobInfo.get(b.c.id);
    if (!ja && jb) return -1; // fresh before failed
    if (ja && !jb) return 1;
    if (ja && jb) {
      const cmp = (parseSqliteUtc(ja.updatedAt) ?? 0) - (parseSqliteUtc(jb.updatedAt) ?? 0);
      if (cmp !== 0) return cmp; // oldest failure first
    }
    return a.i - b.i; // stable: discovered order
  });
  return eligible[0]?.c ?? null;
}

async function loadFailedJobInfo(db: D1Database): Promise<FailedJobInfo> {
  const rows = await db
    .prepare(
      "SELECT source_id, auto_attempts, updated_at FROM import_jobs WHERE status = 'failed' AND source_id IS NOT NULL",
    )
    .all<{ source_id: string; auto_attempts: number | null; updated_at: string }>();
  if (!rows.results) {
    // A null results set (D1 anomaly) would make every retry-capped dataset look
    // fresh and bypass the bounded-retry cap -- abort the tick instead (#780 review).
    throw new Error("[auto-import] loadFailedJobInfo: D1 returned null results");
  }
  const map: FailedJobInfo = new Map();
  for (const r of rows.results) {
    map.set(r.source_id, { autoAttempts: r.auto_attempts ?? 0, updatedAt: r.updated_at });
  }
  return map;
}

/**
 * One auto-import tick. No-op unless AUTO_IMPORT_ENABLED='true' and ~90 min have
 * passed since the last dispatch (gate checked FIRST so the OpenNeuro scan only
 * runs every ~90 min). Dispatches one dataset and records it in audit_log (which
 * is both the gate source and the Phase-3 activity feed).
 */
/** Gate-source query: the last auto-import dispatch time (audit_log.timestamp,
 *  NOT created_at -- the column is `timestamp` since migration 0001). Exported
 *  so a test runs the real SQL and locks the column name. */
export const AUTO_IMPORT_GATE_QUERY =
  "SELECT timestamp FROM audit_log WHERE action = 'auto_import_dispatch' ORDER BY id DESC LIMIT 1";

export async function autoImportTick(env: Bindings): Promise<void> {
  if (env.AUTO_IMPORT_ENABLED !== "true") {
    console.log("[auto-import] disabled (AUTO_IMPORT_ENABLED != 'true'); skipping");
    return;
  }
  const now = Date.now();

  const last = await env.DB.prepare(AUTO_IMPORT_GATE_QUERY).first<{ timestamp: string }>();
  const gate = decideAutoImportGate({
    lastDispatchAt: last?.timestamp ?? null,
    now,
    minIntervalMs: resolveMinIntervalMs(env),
  });
  if (!gate.proceed) {
    console.log(`[auto-import] gated: ${gate.reason}`);
    return;
  }
  if (gate.reason.startsWith("unparseable")) {
    // Fail-open is deliberate (don't stall forever), but an unparseable
    // last-dispatch timestamp is a data anomaly worth surfacing at error level.
    console.error(`[auto-import] ${gate.reason} (last="${last?.timestamp}"); proceeding`);
  }

  const discovered = await discoverOpenNeuroDatasets();
  const imported = await getImportedSourceIds(env.DB);
  const { inFlight, terminal } = await getActiveImportSourceIds(env.DB);
  const candidates = diffNewDatasets(discovered, imported, inFlight, terminal);
  const jobInfo = await loadFailedJobInfo(env.DB);

  const picked = pickNextDataset(candidates, jobInfo, {
    maxAttempts: MAX_AUTO_ATTEMPTS,
    backoffMs: RETRY_BACKOFF_MS,
    now,
  });
  if (!picked) {
    console.log(
      `[auto-import] nothing to import (discovered=${discovered.length} candidates=${candidates.length})`,
    );
    return;
  }

  const datasetId = mapToNemarId(picked.id);
  if (!datasetId) {
    console.error(`[auto-import] unexpected OpenNeuro id shape: ${picked.id}; skipping`);
    return;
  }

  const priorAttempts = jobInfo.get(picked.id)?.autoAttempts ?? 0;

  // RESERVE THE SLOT BEFORE DISPATCHING. Writing the audit_log gate row first
  // means a failure anywhere after this can't let the next tick (30 min) re-pick
  // the same dataset before its import registers as in-flight -- which would
  // double-dispatch and, since we auto-publish, risk a duplicate version DOI. If
  // the gate write itself throws we never dispatch (the tick aborts loudly). If
  // the gate is set but the dispatch fails, the dataset simply waits for the next
  // ~90-min window. (#780 review)
  await env.DB.prepare(
    "INSERT INTO audit_log (action, resource_id, details) VALUES ('auto_import_dispatch', ?, ?)",
  )
    .bind(
      picked.id,
      JSON.stringify({
        dataset_id: datasetId,
        modalities: picked.modalities,
        attempt: priorAttempts + 1,
        candidates: candidates.length,
      }),
    )
    .run();

  // Bump the bounded-retry counter for a re-dispatched failed dataset (survives
  // the workflow's preparing-upsert, which doesn't touch this column). A 0-row
  // no-op means the cap wouldn't advance -- surface it.
  if (jobInfo.has(picked.id)) {
    const upd = await env.DB.prepare(
      "UPDATE import_jobs SET auto_attempts = auto_attempts + 1, updated_at = datetime('now') WHERE dataset_id = ?",
    )
      .bind(datasetId)
      .run();
    if ((upd.meta.changes ?? 0) === 0) {
      console.error(
        `[auto-import] auto_attempts UPDATE matched 0 rows for ${datasetId} (${picked.id}); retry cap may not advance`,
      );
    }
  }

  const token = await getDatasetsToken(env);
  await triggerOpenNeuroOnboard(picked.id, token);
  console.log(
    `[auto-import] dispatched ${picked.id} -> ${datasetId} (attempt ${priorAttempts + 1}, ${candidates.length} candidates)`,
  );
}
