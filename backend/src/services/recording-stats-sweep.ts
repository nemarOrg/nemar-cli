/**
 * Dataset-level recording-stats backfill sweep (epic #1144 Phase 2, issue
 * #1146). Shared by `POST /admin/datasets/recording-stats-sweep` and the
 * daily cron so the two callers can never drift -- mirrors
 * services/availability-report.ts's runAvailabilityReportSweep.
 *
 * The cap/idempotent-stamp/direct-write shape is modelled on
 * channel-montage-sweep (routes/admin/datasets-lifecycle.ts). The per-error
 * handling is NOT: channel-montage-sweep writes its two probed columns on
 * every outcome including failure, which is safe there because it is a
 * genuine one-time backfill (a probed row is never re-nulled). This sweep is
 * re-armed by the zarr-ready callback on every reconversion (migration
 * 0070's recording_stats_at comment), so a candidate can legitimately arrive
 * here with real prior stats already in its columns -- an unconditional
 * write-on-any-outcome would let a transient S3 error destroy them. Instead
 * this mirrors zarr-sweep's three-way handling just above in
 * datasets-lifecycle.ts (throw -> stays a candidate; absent -> stamped but
 * untouched otherwise) plus availability-report.ts's "stamp only on
 * success" principle for the stat columns themselves.
 */

import { getS3Config } from "../routes/admin/shared.js";
import type { Bindings } from "../types/bindings.js";
import { isNonProductionEnv } from "./environment.js";
import { type RecordingStats, getZarrIndex } from "./s3.js";

/**
 * Candidates: active datasets whose zarr conversion is known-ready but whose
 * recording stats have never been computed. zarr_status='ready' is expected
 * to mean an index.json exists, so every GET the sweep issues is expected to
 * hit -- no wasted GETs on the ~8% of the catalog without one (issue #1146:
 * 92% of the catalog has an index). "Expected to", not "guaranteed": the
 * loop below explicitly handles the case where that expectation doesn't
 * hold (a null read on a zarr_status='ready' row). No visibility
 * restriction: duration is a catalog fact, and a private dataset should
 * carry it before it ever goes public. No is_sandbox exclusion either
 * (unlike channel-montage-sweep / zarr-sweep): the published xx0999NN
 * exemplar-fleet copies are legitimate catalog entries that should carry
 * duration too.
 */
export const RECORDING_STATS_SWEEP_CANDIDATE_SQL = `SELECT dataset_id FROM datasets
   WHERE status = 'active'
     AND zarr_status = 'ready'
     AND json_extract(sweep_stamps, '$.recording_stats_at') IS NULL
   ORDER BY dataset_id
   LIMIT ?`;

export const RECORDING_STATS_SWEEP_REMAINING_SQL = `SELECT COUNT(*) AS n FROM datasets
   WHERE status = 'active'
     AND zarr_status = 'ready'
     AND json_extract(sweep_stamps, '$.recording_stats_at') IS NULL`;

/**
 * The per-candidate write on a SUCCESSFUL index read, exported so a test can
 * exercise the exact SQL text (bind order: the 8 stat columns in
 * RecordingStats field order, then dataset_id) instead of a hand-copy that
 * could silently drift. Writes DIRECTLY (no updated_at bump) so a
 * ~660-dataset backfill does not bump updated_at/metadata_updated_at
 * catalog-wide -- same reasoning as channel-montage-sweep at
 * datasets-lifecycle.ts:351.
 *
 * Called ONLY when a real `RecordingStats` bag is in hand (see
 * runRecordingStatsSweep) -- never with a null/failed probe. An absent index
 * or a thrown fetch uses RECORDING_STATS_SWEEP_STAMP_ONLY_SQL instead, which
 * does not touch these 8 columns at all, so a transient failure can never
 * overwrite prior good values with NULL.
 */
export const RECORDING_STATS_SWEEP_WRITE_SQL = `UPDATE datasets
   SET total_recording_duration = ?,
       recording_duration_min = ?,
       recording_duration_max = ?,
       recording_count = ?,
       recordings_unavailable = ?,
       recordings_measured = ?,
       channel_count_min = ?,
       channel_count_max = ?,
       sweep_stamps = json_set(COALESCE(sweep_stamps, '{}'), '$.recording_stats_at', datetime('now'))
   WHERE dataset_id = ?`;

/**
 * Stamp `recording_stats_at` ONLY -- every stat column is left exactly as it
 * was. Used when the index read for a `zarr_status='ready'` candidate comes
 * back absent (404/403): the sweep still needs to converge (this row must
 * stop being re-selected every invocation), but absence is not evidence the
 * dataset has zero/unknown stats -- it may be mid-reconversion, in which
 * case a FUTURE zarr-ready 'ready' callback re-nulls the stamp and the next
 * sweep picks it up for real. For a never-swept candidate the 8 columns stay
 * NULL (nothing to protect); for a reconverted one, prior good values
 * survive untouched.
 */
export const RECORDING_STATS_SWEEP_STAMP_ONLY_SQL = `UPDATE datasets
   SET sweep_stamps = json_set(COALESCE(sweep_stamps, '{}'), '$.recording_stats_at', datetime('now'))
   WHERE dataset_id = ?`;

/**
 * `?reset=1`: clear the stamp + every stat column so a corrected aggregator
 * can re-sweep from scratch. Exported (not inlined in the route) for the
 * same reason as the other sweep SQL: a test imports this exact string
 * instead of a hand-copy that a future edit to the real reset could
 * silently outrun.
 */
export const RECORDING_STATS_SWEEP_RESET_SQL = `UPDATE datasets
   SET sweep_stamps = json_remove(sweep_stamps, '$.recording_stats_at'),
       total_recording_duration = NULL,
       recording_duration_min = NULL,
       recording_duration_max = NULL,
       recording_count = NULL,
       recordings_unavailable = NULL,
       recordings_measured = NULL,
       channel_count_min = NULL,
       channel_count_max = NULL
   WHERE json_extract(sweep_stamps, '$.recording_stats_at') IS NOT NULL`;

/** Positional bind values for RECORDING_STATS_SWEEP_WRITE_SQL's 8 stat
 *  placeholders + trailing dataset_id. */
export type RecordingStatsWriteBindings = [
  totalRecordingDuration: number | null,
  recordingDurationMin: number | null,
  recordingDurationMax: number | null,
  recordingCount: number | null,
  recordingsUnavailable: number | null,
  recordingsMeasured: number | null,
  channelCountMin: number | null,
  channelCountMax: number | null,
  datasetId: string,
];

/**
 * Bind values for RECORDING_STATS_SWEEP_WRITE_SQL from a REAL stats bag.
 * `stats` is intentionally non-nullable: the write path only ever runs on a
 * successful index read (see runRecordingStatsSweep), so there is no "failed
 * probe" case for this function to paper over with `?? null` any more --
 * that silent all-NULL fallback was the C1 data-loss bug.
 */
export function recordingStatsWriteBindings(
  stats: RecordingStats,
  datasetId: string,
): RecordingStatsWriteBindings {
  return [
    stats.totalRecordingDuration,
    stats.recordingDurationMin,
    stats.recordingDurationMax,
    stats.recordingCount,
    stats.recordingsUnavailable,
    stats.recordingsMeasured,
    stats.channelCountMin,
    stats.channelCountMax,
    datasetId,
  ];
}

/** Hard ceiling on candidates per invocation. One signed GET each
 *  (getZarrIndex) -- looser than the montage sweep's 15/30 since there is no
 *  GitHub call in the loop. */
export const RECORDING_STATS_SWEEP_MAX = 200;

export interface RecordingStatsSweepResult {
  processed: number;
  measured: number;
  unmeasured: number;
  errors: { dataset_id: string; error: string }[];
  /** Candidates still unstamped after this run; null if the count query failed. */
  remaining: number | null;
}

/**
 * Run one bounded pass of the recording-stats sweep: take up to `limit`
 * unstamped candidates and, for each, fetch its zarr index and react
 * per-outcome:
 *
 *  - THROW (S3/infra error): record the error, write NOTHING, `continue`.
 *    The row stays a candidate for the next run -- exactly zarr-sweep's
 *    handling of the identical case just above in datasets-lifecycle.ts
 *    ("keeps the row a candidate for the next run, not mis-stamped absent").
 *  - ABSENT (index.json 404/403 on a zarr_status='ready' row): record the
 *    inconsistency, then RECORDING_STATS_SWEEP_STAMP_ONLY_SQL -- the
 *    timestamp only, so the sweep converges, but every stat column is left
 *    untouched (NULL for a first-time candidate; real numbers for a
 *    reconverted one, which must survive).
 *  - SUCCESS: RECORDING_STATS_SWEEP_WRITE_SQL writes all 8 stat columns +
 *    the stamp together.
 *
 * `getZarrIndex` distinguishes these at the type level (throws vs. returns
 * null vs. returns a real ZarrIndexInfo) -- collapsing throw and absent into
 * one "stats = null, write anyway" branch was the C1 bug this three-way
 * split fixes: a transient S3 blip during a reconversion sweep must never
 * destroy stats a PRIOR successful sweep already computed, and must not
 * remove the row from candidacy in a way only `?reset=1` (which clears the
 * ENTIRE catalog) can recover from.
 *
 * `fetchIndex` defaults to the real `getZarrIndex` and exists so a test can
 * drive this exact function -- the entry point both real callers (the admin
 * route and the daily cron) use -- against a real D1 with the one true
 * network boundary substituted, instead of re-implementing this loop's
 * control flow at the test level.
 *
 * Throws only if the candidate query itself fails (e.g. migration 0070 not
 * applied). Per-dataset failures are collected into `errors`, never thrown.
 */
export async function runRecordingStatsSweep(
  env: Bindings,
  opts?: { limit?: number; fetchIndex?: typeof getZarrIndex },
): Promise<RecordingStatsSweepResult> {
  const requested = opts?.limit ?? RECORDING_STATS_SWEEP_MAX;
  const limit = Math.min(Math.max(requested, 1), RECORDING_STATS_SWEEP_MAX);
  const fetchIndex = opts?.fetchIndex ?? getZarrIndex;

  const rows = await env.DB.prepare(RECORDING_STATS_SWEEP_CANDIDATE_SQL)
    .bind(limit)
    .all<{ dataset_id: string }>();
  const candidates = rows.results ?? [];

  const s3 = getS3Config(env);
  let measured = 0;
  let unmeasured = 0;
  const errors: { dataset_id: string; error: string }[] = [];

  for (const { dataset_id } of candidates) {
    // ONE signed GET of <id>/zarr/index.json. A throw keeps the row a
    // candidate for the next run (no write at all) -- see the module/
    // function doc comments for why this must not fall through to a write.
    let index: Awaited<ReturnType<typeof getZarrIndex>>;
    try {
      index = await fetchIndex(s3, dataset_id);
    } catch (err) {
      errors.push({
        dataset_id,
        error: `s3: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }

    try {
      if (index) {
        const stats: RecordingStats = index.recordingStats;
        if (stats.recordingsMeasured > 0) measured++;
        else unmeasured++;
        await env.DB.prepare(RECORDING_STATS_SWEEP_WRITE_SQL)
          .bind(...recordingStatsWriteBindings(stats, dataset_id))
          .run();
      } else {
        // zarr_status='ready' is expected to mean an index exists; a null
        // read here is an inconsistency worth surfacing, not a silent skip
        // -- but it is NOT a reason to erase prior good stats (a
        // reconversion in progress can legitimately have its index briefly
        // missing). Stamp-only: see RECORDING_STATS_SWEEP_STAMP_ONLY_SQL.
        errors.push({ dataset_id, error: "zarr_status=ready but index.json is absent" });
        await env.DB.prepare(RECORDING_STATS_SWEEP_STAMP_ONLY_SQL).bind(dataset_id).run();
      }
    } catch (err) {
      errors.push({
        dataset_id,
        error: `d1 write: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  const remainingRow = await env.DB.prepare(RECORDING_STATS_SWEEP_REMAINING_SQL)
    .first<{ n: number }>()
    .catch(() => null);

  return {
    processed: candidates.length,
    measured,
    unmeasured,
    errors,
    remaining: remainingRow?.n ?? null,
  };
}

/**
 * Cron-only wrapper (issue #1166, Option 2). `runRecordingStatsSweep` itself
 * stays UNGUARDED on purpose: `POST /admin/datasets/recording-stats-sweep`
 * calls it directly and is not environment-gated, so staging keeps its admin
 * backfill. Unlike its two sibling sweeps, this one really does reach the
 * exemplar fleet: its candidate SQL has no `is_sandbox` filter at all (see
 * the note on RECORDING_STATS_SWEEP_CANDIDATE_SQL), so it needs no
 * `is_exemplar` carve-out and is unaffected by issue #1168. Only the
 * recurring daily-cron caller needs
 * the production fence, so the guard lives here instead of inside the sweep
 * -- guarding the sweep itself would quietly take the admin route down
 * outside production too.
 *
 * Returns `null` when skipped so the `scheduled()` call site can tell "ran
 * with nothing to do" (a real result with `processed: 0`) apart from "did not
 * run at all". The call site's `if (!r) return` is what acts on that. Without
 * it the summary line would not be "fabricated" -- its own
 * `processed > 0 || remaining > 0` gate already suppresses an all-zero
 * result -- the failure is that reading `r.processed` off `null` throws, and
 * the chained `.catch()` then reports a skipped run as a crashed one
 * ("sweep failed: TypeError"). #1167 review, finding 2.
 */
export async function runRecordingStatsSweepCron(
  env: Bindings,
): Promise<RecordingStatsSweepResult | null> {
  if (isNonProductionEnv(env)) {
    console.log("[recording-stats-sweep] skipped (non-production)");
    return null;
  }
  return runRecordingStatsSweep(env);
}
