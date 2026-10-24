/**
 * What the stale OpenNeuro mirrors would cost to re-pull (epic #1046 phase 4c, #1910; ADR 0111,
 * Phase 4c amendment). `nemar admin upstream-status --measure` runs this on the administrator's
 * machine after the staleness pass: for each stale mirror it reads OpenNeuro's file listings at
 * the recorded and the latest tag, summarizes the delta, and adds the deltas up next to the DOI
 * volume estimate.
 *
 * WHAT IT MEASURES, AND ITS TWO LIMITS. The delta is UPSTREAM'S between the two tags, not NEMAR's
 * tree: NEMAR's own corrections, its scrubs and its annex policy are not in it. And a recorded tag
 * with basis `doi` is a declaration, not a tree comparison (ADR 0111, "What `doi` means"): early
 * imports cloned the default HEAD, so a delta measured from a wrong declaration is wrong. The
 * conflict and unexplained-path counts belong to Phase 5's plan (`nemar admin repull plan`), not
 * here.
 *
 * UNKNOWN IS NEVER ZERO (ADR 0053, ADR 0054). A delta that could not be read is `null` with its
 * reason, counted in `delta_unknown`; a stale mirror that was not measured (`--measure-limit`) is
 * counted in `not_measured`; and `bytes_to_copy` is `null` while either is nonzero, with the sum
 * over what is known beside it as `bytes_to_copy_known` ("at least").
 *
 * Read-only: it writes nothing, to NEMAR or to OpenNeuro.
 */

import {
  type DoiVolume,
  STALE_STATES,
  type SnapshotDelta,
  type UpstreamStatusRow,
  estimateRepullDoiVolume,
  summarizeSnapshotDelta,
} from "../../shared/upstream-staleness.js";
import { OPENNEURO_GRAPHQL_URL, fetchSnapshotFilePair } from "./openneuro.js";

/**
 * ADR 0111's `REPULL_DAILY_OPEN_CAP` default: the re-pull pull requests the automatic path opens
 * in a day. The catch-up estimate divides by it; the owner may set another cap later.
 */
export const REPULL_DAILY_OPEN_CAP = 2;

export interface DeltaMeasurement {
  dataset_id: string;
  ds: string | null;
  from_tag: string | null;
  to_tag: string | null;
  /** Null when the listings could not be read; `reason` says why. Never an all-zero delta. */
  delta: SnapshotDelta | null;
  reason: string | null;
}

export interface MeasurementTotals {
  /** Stale mirrors in the pass. */
  stale: number;
  measured: number;
  /** Stale mirrors left out by `--measure-limit`. */
  not_measured: number;
  /** Measured, and no annexed file was added, changed or deleted. */
  metadata_only: number;
  data_changing: number;
  /** Stale mirrors whose listings could not be read. */
  delta_unknown: number;
  /** Over the measured deltas only: at least these. */
  files_added: number;
  files_changed: number;
  files_deleted: number;
  /** Null while any delta or any new key's size is unknown or not measured. */
  bytes_to_copy: number | null;
  /** The sum over the deltas that are known: "at least". */
  bytes_to_copy_known: number;
  /** ceil(catch_up / REPULL_DAILY_OPEN_CAP). */
  catch_up_days: number;
}

export interface Measurement {
  measured_at: string;
  endpoint: string;
  deltas: DeltaMeasurement[];
  totals: MeasurementTotals;
  doi_volume: DoiVolume;
}

export interface MeasureOptions {
  /** Measure at most this many stale mirrors, in dataset order. Default: all. */
  limit?: number;
  graphqlUrl?: string;
  /** Pause between mirrors, to read OpenNeuro politely. Default 500 ms. */
  pauseMs?: number;
  timeoutMs?: number;
  now?: () => number;
}

/** The rows a measurement covers: stale, in dataset order. */
export function staleRowsOf(rows: readonly UpstreamStatusRow[]): UpstreamStatusRow[] {
  return rows
    .filter((r) => (STALE_STATES as readonly string[]).includes(r.state))
    .sort((a, b) => (a.dataset_id < b.dataset_id ? -1 : a.dataset_id > b.dataset_id ? 1 : 0));
}

export function totalsOf(
  deltas: readonly DeltaMeasurement[],
  stale: number,
  catchUp: number,
): MeasurementTotals {
  let metadataOnly = 0;
  let dataChanging = 0;
  let unknown = 0;
  let added = 0;
  let changed = 0;
  let deleted = 0;
  let bytesKnown = 0;
  let bytesUnknown = false;
  for (const m of deltas) {
    const d = m.delta;
    if (d === null) {
      unknown++;
      continue;
    }
    if (d.data_changing) dataChanging++;
    else metadataOnly++;
    added += d.added;
    changed += d.changed;
    deleted += d.deleted;
    if (d.bytes_to_copy === null) bytesUnknown = true;
    else bytesKnown += d.bytes_to_copy;
  }
  const notMeasured = Math.max(0, stale - deltas.length);
  return {
    stale,
    measured: deltas.length - unknown,
    not_measured: notMeasured,
    metadata_only: metadataOnly,
    data_changing: dataChanging,
    delta_unknown: unknown,
    files_added: added,
    files_changed: changed,
    files_deleted: deleted,
    bytes_to_copy: unknown > 0 || notMeasured > 0 || bytesUnknown ? null : bytesKnown,
    bytes_to_copy_known: bytesKnown,
    catch_up_days: Math.ceil(catchUp / REPULL_DAILY_OPEN_CAP),
  };
}

/**
 * Measure the stale rows of a pass. Sequential, with a pause between mirrors; a failure for one
 * mirror leaves its delta null with the reason and the run continues.
 */
export async function measureStaleMirrors(
  rows: readonly UpstreamStatusRow[],
  options: MeasureOptions = {},
): Promise<Measurement> {
  const now = options.now ?? Date.now;
  const stale = staleRowsOf(rows);
  const chosen = options.limit === undefined ? stale : stale.slice(0, options.limit);
  const deltas: DeltaMeasurement[] = [];
  for (const [i, row] of chosen.entries()) {
    if (i > 0) await new Promise((resolve) => setTimeout(resolve, options.pauseMs ?? 500));
    const from = row.recorded?.tag ?? null;
    const to = row.upstream?.latest_tag ?? null;
    const base = { dataset_id: row.dataset_id, ds: row.ds, from_tag: from, to_tag: to };
    if (row.ds === null || from === null || to === null) {
      deltas.push({ ...base, delta: null, reason: "the row does not name both tags" });
      continue;
    }
    const pair = await fetchSnapshotFilePair(row.ds, from, to, {
      graphqlUrl: options.graphqlUrl ?? OPENNEURO_GRAPHQL_URL,
      timeoutMs: options.timeoutMs,
    });
    if (!pair.ok) {
      deltas.push({ ...base, delta: null, reason: pair.error });
      continue;
    }
    deltas.push({ ...base, delta: summarizeSnapshotDelta(pair.from, pair.to), reason: null });
  }
  const doiVolume = estimateRepullDoiVolume(rows, now());
  return {
    measured_at: new Date(now()).toISOString(),
    endpoint: options.graphqlUrl ?? OPENNEURO_GRAPHQL_URL,
    deltas,
    totals: totalsOf(deltas, stale.length, doiVolume.catch_up),
    doi_volume: doiVolume,
  };
}

function human(bytes: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return unit === 0 ? `${bytes} B` : `${value.toFixed(1)} ${units[unit]}`;
}

function bytesLine(t: MeasurementTotals): string {
  if (t.bytes_to_copy !== null) {
    return `Bytes to copy: ${t.bytes_to_copy} (${human(t.bytes_to_copy)})`;
  }
  return `Bytes to copy: unknown; at least ${t.bytes_to_copy_known} (${human(t.bytes_to_copy_known)}) from the deltas that were read`;
}

/** The human block, as lines; `list` bounds the per-mirror lines. */
export function renderMeasurement(m: Measurement, list: number): string[] {
  const t = m.totals;
  const v = m.doi_volume;
  const lines: string[] = [];
  lines.push(`Measurement of ${t.stale} stale mirror(s), read from OpenNeuro at ${m.measured_at}:`);
  lines.push(
    `  Measured ${t.measured}: metadata-only ${t.metadata_only}, data-changing ${t.data_changing}; delta unknown ${t.delta_unknown}; not measured ${t.not_measured}.`,
  );
  const atLeast =
    t.delta_unknown > 0 || t.not_measured > 0 ? " (at least: not every delta was read)" : "";
  lines.push(
    `  Files added ${t.files_added}, changed ${t.files_changed}, deleted ${t.files_deleted}${atLeast}.`,
  );
  lines.push(`  ${bytesLine(t)}.`);
  lines.push("");
  lines.push(
    `  DOI volume. Catch-up: ${v.catch_up} re-pull(s), up to ${v.upper_bound_with_patches.catch_up} DOIs with N.0.1 patches.`,
  );
  lines.push(
    `  Trailing ${v.window_days} days of upstream churn over ${v.mirrors_counted} mirror(s): ${v.per_snapshot} under one re-pull per snapshot, ${v.at_most_every_30_days} under at most one per 30 days, busiest day ${v.busiest_day}; with patches at most ${v.upper_bound_with_patches.per_snapshot} and ${v.upper_bound_with_patches.at_most_every_30_days}.`,
  );
  if (v.snapshots_with_unreadable_dates > 0) {
    lines.push(
      `  ${v.snapshots_with_unreadable_dates} snapshot(s) had an unreadable creation date and are left out of those figures.`,
    );
  }
  lines.push(
    `  At REPULL_DAILY_OPEN_CAP=${REPULL_DAILY_OPEN_CAP} the catch-up takes ${t.catch_up_days} day(s).`,
  );
  if (m.deltas.length > 0) {
    lines.push("");
    for (const d of m.deltas.slice(0, list)) {
      const head = `  ${d.dataset_id}  ${d.ds ?? "-"}  ${d.from_tag ?? "?"} -> ${d.to_tag ?? "?"}`;
      if (d.delta === null) {
        lines.push(`${head}  delta unknown: ${d.reason ?? "no reason given"}`);
        continue;
      }
      const x = d.delta;
      const kind = x.data_changing ? "data-changing" : "metadata-only";
      const bytes = x.bytes_to_copy === null ? "size unknown" : human(x.bytes_to_copy);
      lines.push(
        `${head}  ${kind}  +${x.added} ~${x.changed} -${x.deleted} files, ${x.new_keys} new key(s), ${bytes}`,
      );
    }
    if (m.deltas.length > list) lines.push(`  ... and ${m.deltas.length - list} more`);
  }
  lines.push("");
  lines.push(
    "  Limit: the delta is upstream's between the two tags, not NEMAR's tree; NEMAR's own corrections, scrubs and annex policy are not in it.",
  );
  lines.push(
    "  Limit: a tag recorded with basis doi is a declaration, not a tree comparison (ADR 0111, What `doi` means).",
  );
  lines.push(
    "  Not measured here: conflict and unexplained-path counts come from Phase 5's plan, `nemar admin repull plan`.",
  );
  return lines;
}
