/**
 * Dataset-level BIDS signal-defaults backfill sweep (epic #1144 Phase 2b,
 * issue #1153). Shared by `POST /admin/datasets/signal-defaults-sweep` (and
 * any future caller) so the candidate query and the outcome handling can
 * never drift -- mirrors services/recording-stats-sweep.ts's
 * runRecordingStatsSweep, which this sweep's three-way branch is modelled on
 * directly (read that file's module doc for the full rationale; summarized
 * here for this sweep's specifics).
 *
 * THROW (GitHub/infra error from getBidsTreeStats itself, e.g. a failed
 * subject-subtree fetch): record the error, write NOTHING, `continue`. The
 * row stays a candidate for the next run.
 *
 * PROBE ERROR (getBidsTreeStats returned SUCCESSFULLY, but its secondary
 * channel/signal-defaults probe swallowed a transport failure internally --
 * see bids-tree.ts's `probeChannelMontage`, ADR 0005: transport failures
 * must stay fatal, only authoritative absence is permanent). Surfaced via
 * `stats.channelMontageProbeError` and handled IDENTICALLY to THROW: no
 * write, `continue`, row stays a candidate. Without this check a network
 * blip reads as "no sidecar" and gets permanently stamped -- the exact
 * disguised-absence bug PR review caught (#1162 review, C2).
 *
 * NO SIDECAR (the probe ran to completion, no transport error, but found no
 * usable `*_eeg.json` key -- a non-BIDS repo, a repo with no EEG sidecar, or
 * a sidecar that parsed to nothing): SIGNAL_DEFAULTS_SWEEP_STAMP_ONLY_SQL
 * stamps `signal_defaults_at` only, so the sweep converges, but the four
 * value columns are left exactly as they were (NULL for a never-swept row,
 * real values for one a prior reindex already populated -- see
 * dataset-reindex.ts's note on why reindex writes the value columns without
 * touching this stamp).
 *
 * SUCCESS (at least one of the four keys parsed): SIGNAL_DEFAULTS_SWEEP_WRITE_SQL
 * COALESCE-writes all four columns (see the SQL's own doc comment for why
 * this must be COALESCE, not a direct SET) + the stamp together.
 *
 * Collapsing throw/probe-error and no-sidecar into one unconditional
 * non-COALESCE write was exactly the C1 bug class the sibling
 * recording-stats sweep fixed (destroyed prior good values on a transient
 * failure); this sweep starts from that fixed shape rather than
 * re-deriving it.
 */

import type { Bindings } from "../types/bindings";
import { isNonProductionEnv } from "./environment";
import { getBidsTreeStats } from "./github";
import { getDatasetsToken } from "./github-auth";

/**
 * Candidates: active datasets with a GitHub repo whose signal defaults have
 * never been computed. `is_sandbox` excluded (matches channel-montage-sweep
 * / hed-sweep, both cited as this sweep's model): prod sandbox (`xx*`)
 * datasets churn continuously (14-day cron cleanup, AGENTS.md's dataset ID
 * bands), and unlike recording-stats-sweep's one cheap signed S3 GET, a
 * candidate here costs a full GitHub tree walk (root tree + up to 25
 * subject subtrees + up to 2 blobs) against a tight 15/30 budget --
 * burning that budget on rows that will be deleted before anyone reads
 * their signal_defaults is wasted work recording-stats-sweep's own
 * documented exception doesn't have to worry about. No modality filter
 * (unlike channel-montage-sweep, which restricts to `modalities LIKE
 * '%eeg%'`): getBidsTreeStats's `*_eeg.json` probe is itself the modality
 * gate -- a non-EEG dataset simply yields no sidecar and is stamped via the
 * no-sidecar branch, exactly like hed-sweep's no-modality-filter reasoning.
 */
export const SIGNAL_DEFAULTS_SWEEP_CANDIDATE_SQL = `SELECT dataset_id, github_repo FROM datasets
   WHERE status = 'active'
     AND github_repo IS NOT NULL
     AND (is_sandbox = 0 OR is_sandbox IS NULL)
     AND json_extract(sweep_stamps, '$.signal_defaults_at') IS NULL
   ORDER BY dataset_id
   LIMIT ?`;

export const SIGNAL_DEFAULTS_SWEEP_REMAINING_SQL = `SELECT COUNT(*) AS n FROM datasets
   WHERE status = 'active'
     AND github_repo IS NOT NULL
     AND (is_sandbox = 0 OR is_sandbox IS NULL)
     AND json_extract(sweep_stamps, '$.signal_defaults_at') IS NULL`;

/**
 * The per-candidate write on a probe that found at least one usable key.
 * Exported so a test can drive the exact SQL text instead of a hand-copy
 * that could silently drift (`.rules/testing.md`'s "never hand-copy a SQL
 * statement" rule). Bind order: the 4 value columns, then dataset_id.
 *
 * COALESCE, not a direct SET (#1162 review, C1): `found` is an OR across
 * four independent keys, so a probe that reads only `SamplingFrequency`
 * still takes this branch -- a direct SET would null the other three even
 * when a PRIOR reindex (which does NOT stamp signal_defaults_at, so the row
 * stays a sweep candidate across many reindex cycles) already wrote real
 * values for them. Once nulled here, nothing re-arms the stamp -- the row
 * is written once, permanently, since `?reset=1` is catalog-wide, not
 * per-row. A direct SET is only actually safe if a "successful" probe is
 * guaranteed to mean "this sidecar authoritatively declares (or omits)
 * every key" -- and it is not: `probeChannelMontage` can swallow a
 * transport failure on ONE of its two blob fetches and still return
 * partial data for the other (see the module doc's PROBE ERROR case,
 * though that case is now caught before reaching this write at all). Two
 * writers disagreeing on the same four columns (this one direct-SET,
 * writeDatasetMetadataColumns COALESCE) was also its own smell.
 */
export const SIGNAL_DEFAULTS_SWEEP_WRITE_SQL = `UPDATE datasets
   SET sampling_frequency = COALESCE(?, sampling_frequency),
       power_line_frequency = COALESCE(?, power_line_frequency),
       eeg_reference = COALESCE(?, eeg_reference),
       placement_scheme = COALESCE(?, placement_scheme),
       sweep_stamps = json_set(COALESCE(sweep_stamps, '{}'), '$.signal_defaults_at', datetime('now'))
   WHERE dataset_id = ?`;

/**
 * Stamp `signal_defaults_at` ONLY -- every value column is left exactly as
 * it was. Used when the probe ran to completion, with no transport error,
 * but found no usable sidecar key.
 */
export const SIGNAL_DEFAULTS_SWEEP_STAMP_ONLY_SQL = `UPDATE datasets
   SET sweep_stamps = json_set(COALESCE(sweep_stamps, '{}'), '$.signal_defaults_at', datetime('now'))
   WHERE dataset_id = ?`;

/**
 * `?reset=1`: clear the stamp + every value column so a corrected parser can
 * re-sweep from scratch. Exported for the same hand-copy reason as the other
 * sweep SQL above.
 */
export const SIGNAL_DEFAULTS_SWEEP_RESET_SQL = `UPDATE datasets
   SET sweep_stamps = json_remove(sweep_stamps, '$.signal_defaults_at'),
       sampling_frequency = NULL,
       power_line_frequency = NULL,
       eeg_reference = NULL,
       placement_scheme = NULL
   WHERE json_extract(sweep_stamps, '$.signal_defaults_at') IS NOT NULL`;

/** Positional bind values for SIGNAL_DEFAULTS_SWEEP_WRITE_SQL's 4 value
 *  placeholders + trailing dataset_id. */
export type SignalDefaultsWriteBindings = [
  samplingFrequency: number | null,
  powerLineFrequency: number | null,
  eegReference: string | null,
  placementScheme: string | null,
  datasetId: string,
];

/** Bind values for SIGNAL_DEFAULTS_SWEEP_WRITE_SQL from a real probe result.
 *  `stats` is intentionally the same shape getBidsTreeStats returns -- no
 *  intermediate "found" bag -- so there is nothing here to transpose. */
export function signalDefaultsWriteBindings(
  stats: {
    samplingFrequency?: number;
    powerLineFrequency?: number;
    eegReference?: string;
    placementScheme?: string;
  },
  datasetId: string,
): SignalDefaultsWriteBindings {
  return [
    stats.samplingFrequency ?? null,
    stats.powerLineFrequency ?? null,
    stats.eegReference ?? null,
    stats.placementScheme ?? null,
    datasetId,
  ];
}

/** Default candidates per invocation. Tighter than recording-stats-sweep's
 *  200: this hits the GitHub API (getBidsTreeStats: root tree + up to 25
 *  subject subtrees + up to 2 sidecar blobs per dataset) rather than one
 *  signed S3 GET -- same cap as channel-montage-sweep / hed-sweep. */
export const SIGNAL_DEFAULTS_SWEEP_DEFAULT = 15;
/** Hard ceiling on candidates per invocation, regardless of a larger
 *  requested `?limit=`. */
export const SIGNAL_DEFAULTS_SWEEP_MAX = 30;

export interface SignalDefaultsSweepResult {
  processed: number;
  /** Candidates whose probe found at least one usable sidecar key and
   *  wrote the value columns. */
  populated: number;
  /** Candidates whose probe ran to completion (no transport error) but
   *  found nothing to write (stamped only; prior values, if any, are
   *  untouched). */
  noData: number;
  errors: { dataset_id: string; error: string }[];
  /** Candidates still unstamped after this run; null if the count query failed. */
  remaining: number | null;
}

/**
 * Run one bounded pass of the signal-defaults sweep: take up to `limit`
 * unstamped candidates and, for each, probe its GitHub repo's BIDS tree and
 * react per-outcome (see the module doc for the full branch split).
 *
 * `fetchStats` defaults to the real `getBidsTreeStats` and exists so a test
 * can drive this exact function -- the entry point the real route uses --
 * against a real D1 with the one true network boundary substituted, instead
 * of re-implementing this loop's control flow at the test level.
 *
 * `pat` lets a test skip the real GitHub App token mint entirely; real
 * callers never pass it, so `getDatasetsToken` resolves a real token --
 * lazily, and only when there is at least one real candidate, mirroring
 * recording-stats-sweep's no-wasted-network-call reasoning (there: no
 * wasted S3 GETs on an empty batch; here: no wasted token mint).
 *
 * A GitHub-auth failure (missing/invalid App credentials) is caught here,
 * NOT allowed to propagate to the caller (#1162 review, I5): the ROUTE's
 * own catch assumes any throw out of this function means the candidate
 * query failed (its 500 hint literally says "is migration 0072 applied?"),
 * which was already false for an auth failure before this fix -- a
 * transient credential issue would have been misdiagnosed as a missing
 * migration. Instead this returns normally with a single batch-level entry
 * in `errors` (dataset_id: "*") and every candidate left untouched
 * (`processed: 0`), so the caller gets an honest, recoverable signal.
 *
 * Throws only if the candidate query itself fails (e.g. migration 0072 not
 * applied). Per-dataset failures are collected into `errors`, never thrown.
 */
export async function runSignalDefaultsSweep(
  env: Bindings,
  opts?: {
    limit?: number;
    fetchStats?: typeof getBidsTreeStats;
    pat?: string;
  },
): Promise<SignalDefaultsSweepResult> {
  const requested = opts?.limit ?? SIGNAL_DEFAULTS_SWEEP_DEFAULT;
  const limit = Math.min(Math.max(requested, 1), SIGNAL_DEFAULTS_SWEEP_MAX);
  const fetchStats = opts?.fetchStats ?? getBidsTreeStats;

  const rows = await env.DB.prepare(SIGNAL_DEFAULTS_SWEEP_CANDIDATE_SQL)
    .bind(limit)
    .all<{ dataset_id: string; github_repo: string }>();
  const candidates = rows.results ?? [];

  let pat = opts?.pat ?? null;
  if (candidates.length > 0 && pat === null) {
    try {
      pat = await getDatasetsToken(env);
    } catch (err) {
      // See the function doc: an auth failure is NOT a candidate-query
      // failure, so it must not be allowed to propagate to the route's
      // migration-hinting catch. Every candidate stays untouched.
      const remainingOnAuthFailure = await env.DB.prepare(SIGNAL_DEFAULTS_SWEEP_REMAINING_SQL)
        .first<{ n: number }>()
        .catch(() => null);
      return {
        processed: 0,
        populated: 0,
        noData: 0,
        errors: [
          {
            dataset_id: "*",
            error: `github-auth: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        remaining: remainingOnAuthFailure?.n ?? null,
      };
    }
  }

  let populated = 0;
  let noData = 0;
  const errors: { dataset_id: string; error: string }[] = [];

  for (const { dataset_id, github_repo } of candidates) {
    const repoName = github_repo.split("/")[1] ?? github_repo;

    // ONE getBidsTreeStats call. A throw keeps the row a candidate for the
    // next run (no write at all) -- see the module doc for why this must
    // not fall through to a write.
    let stats: Awaited<ReturnType<typeof getBidsTreeStats>>;
    try {
      stats = await fetchStats(repoName, "main", pat as string);
    } catch (err) {
      errors.push({
        dataset_id,
        error: `github: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }

    // A transport failure the secondary channel/signal-defaults probe
    // swallowed internally (bids-tree.ts's probeChannelMontage) surfaces
    // HERE, not as a throw -- getBidsTreeStats itself succeeded (modalities
    // etc. are trustworthy). Treat it exactly like THROW: no write, stays a
    // candidate. Without this, a network blip during the probe reads as
    // "no sidecar" and gets permanently stamped by the branch below (#1162
    // review, C2; see ADR 0005: transport failures stay fatal).
    if (stats.channelMontageProbeError) {
      errors.push({ dataset_id, error: `probe: ${stats.channelMontageProbeError}` });
      continue;
    }

    const found =
      stats.samplingFrequency != null ||
      stats.powerLineFrequency != null ||
      stats.eegReference != null ||
      stats.placementScheme != null;

    try {
      if (found) {
        await env.DB.prepare(SIGNAL_DEFAULTS_SWEEP_WRITE_SQL)
          .bind(...signalDefaultsWriteBindings(stats, dataset_id))
          .run();
        populated++;
      } else {
        await env.DB.prepare(SIGNAL_DEFAULTS_SWEEP_STAMP_ONLY_SQL).bind(dataset_id).run();
        noData++;
      }
    } catch (err) {
      errors.push({
        dataset_id,
        error: `d1 write: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  const remainingRow = await env.DB.prepare(SIGNAL_DEFAULTS_SWEEP_REMAINING_SQL)
    .first<{ n: number }>()
    .catch(() => null);

  return {
    processed: candidates.length,
    populated,
    noData,
    errors,
    remaining: remainingRow?.n ?? null,
  };
}

/**
 * Cron-only wrapper (issue #1166, Option 2). `runSignalDefaultsSweep` itself
 * stays UNGUARDED on purpose: `POST /admin/datasets/signal-defaults-sweep`
 * calls it directly and is not environment-gated, so an operator can still
 * drive a backfill outside production. Note the fleet is NOT what that
 * reaches: this sweep's candidate SQL filters `is_sandbox` without the
 * `is_exemplar = 1` carve-out (issue #1168), and exemplars are inserted
 * `is_sandbox = 1`, so on staging the only candidate is `nm099999`.
 * Only the recurring daily-cron caller needs
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
export async function runSignalDefaultsSweepCron(
  env: Bindings,
): Promise<SignalDefaultsSweepResult | null> {
  if (isNonProductionEnv(env)) {
    console.log("[signal-defaults-sweep] skipped (non-production)");
    return null;
  }
  return runSignalDefaultsSweep(env);
}
