/**
 * Dataset-level recording-stats backfill sweep (epic #1144 Phase 2, issue
 * #1146). Shared by `POST /admin/datasets/recording-stats-sweep` and the
 * daily cron so the two callers can never drift -- mirrors
 * services/availability-report.ts's runAvailabilityReportSweep.
 *
 * Modelled on channel-montage-sweep (routes/admin/datasets-lifecycle.ts):
 * bounded per invocation, idempotent via a checked-at stamp, writes columns
 * directly (no updated_at bump).
 */

import { getS3Config } from "../routes/admin/shared.js";
import type { Bindings } from "../types/bindings.js";
import { type RecordingStats, getZarrIndex } from "./s3.js";

/**
 * Candidates: active datasets whose zarr conversion is known-ready but whose
 * recording stats have never been computed. zarr_status='ready' guarantees
 * an index.json exists, so every GET the sweep issues is expected to hit --
 * no wasted GETs on the ~12% of the catalog without one. No visibility
 * restriction: duration is a catalog fact, and a private dataset should
 * carry it before it ever goes public. No is_sandbox exclusion either
 * (unlike channel-montage-sweep / zarr-sweep): the published xx0999NN
 * exemplar-fleet copies are legitimate catalog entries that should carry
 * duration too.
 */
export const RECORDING_STATS_SWEEP_CANDIDATE_SQL = `SELECT dataset_id FROM datasets
   WHERE status = 'active'
     AND zarr_status = 'ready'
     AND recording_stats_at IS NULL
   ORDER BY dataset_id
   LIMIT ?`;

export const RECORDING_STATS_SWEEP_REMAINING_SQL = `SELECT COUNT(*) AS n FROM datasets
   WHERE status = 'active'
     AND zarr_status = 'ready'
     AND recording_stats_at IS NULL`;

/**
 * The per-candidate write, exported so a test can exercise the exact SQL
 * text (bind order: the 8 stat columns in RecordingStats field order, then
 * dataset_id) instead of a hand-copy that could silently drift. Writes
 * DIRECTLY (no updated_at bump) so a ~660-dataset backfill does not bump
 * updated_at/metadata_updated_at catalog-wide -- same reasoning as
 * channel-montage-sweep at datasets-lifecycle.ts:351.
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
       recording_stats_at = datetime('now')
   WHERE dataset_id = ?`;

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

/** Bind values for RECORDING_STATS_SWEEP_WRITE_SQL from a (possibly null,
 *  on a failed probe) stats bag. */
export function recordingStatsWriteBindings(
  stats: RecordingStats | null,
  datasetId: string,
): RecordingStatsWriteBindings {
  return [
    stats?.totalRecordingDuration ?? null,
    stats?.recordingDurationMin ?? null,
    stats?.recordingDurationMax ?? null,
    stats?.recordingCount ?? null,
    stats?.recordingsUnavailable ?? null,
    stats?.recordingsMeasured ?? null,
    stats?.channelCountMin ?? null,
    stats?.channelCountMax ?? null,
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
 * unstamped candidates, fetch each one's zarr index, aggregate its recording
 * stats, and stamp `recording_stats_at` regardless of outcome.
 *
 * Marks checked even on an S3/index error (mirrors channel-montage-sweep's
 * handling of a probe miss) so a failing dataset is not retried forever; a
 * brand-new candidate row has no prior good values to protect, so writing
 * NULL on failure loses nothing.
 *
 * Throws only if the candidate query itself fails (e.g. migration 0070 not
 * applied). Per-dataset failures are collected into `errors`, never thrown.
 */
export async function runRecordingStatsSweep(
  env: Bindings,
  opts?: { limit?: number },
): Promise<RecordingStatsSweepResult> {
  const requested = opts?.limit ?? RECORDING_STATS_SWEEP_MAX;
  const limit = Math.min(Math.max(requested, 1), RECORDING_STATS_SWEEP_MAX);

  const rows = await env.DB.prepare(RECORDING_STATS_SWEEP_CANDIDATE_SQL)
    .bind(limit)
    .all<{ dataset_id: string }>();
  const candidates = rows.results ?? [];

  const s3 = getS3Config(env);
  let measured = 0;
  let unmeasured = 0;
  const errors: { dataset_id: string; error: string }[] = [];

  for (const { dataset_id } of candidates) {
    let stats: RecordingStats | null = null;
    try {
      const index = await getZarrIndex(s3, dataset_id);
      if (index) {
        stats = index.recordingStats;
        if (stats.recordingsMeasured > 0) measured++;
        else unmeasured++;
      } else {
        // zarr_status='ready' implies an index should exist; a null read
        // here (404/403) is an inconsistency worth surfacing, not a silent
        // skip.
        errors.push({ dataset_id, error: "zarr_status=ready but index.json is absent" });
      }
    } catch (err) {
      errors.push({
        dataset_id,
        error: `s3: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    try {
      await env.DB.prepare(RECORDING_STATS_SWEEP_WRITE_SQL)
        .bind(...recordingStatsWriteBindings(stats, dataset_id))
        .run();
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
