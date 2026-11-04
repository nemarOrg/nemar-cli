/**
 * Aggregating and rendering the upstream staleness report across pages (epic #1046 phase 4b,
 * #1910; ADR 0111, Phase 4a amendment).
 *
 * Pure: `nemar admin upstream-status` fetches the pages, this decides what they add up to.
 *
 * AGGREGATION IS THE CALLER'S JOB. A page's `counts` are for that page; the totals here are
 * recounted from the DEDUPED rows with the shared `countUpstreamStates`, never by adding page
 * counts, so a row that appeared on two pages cannot be counted twice.
 *
 * A 200 IS NOT PROOF THAT EVERYTHING WAS COMPARED. The pass "could not see" (exit 2) when any
 * row is `unchecked`, any page was a 502, any page lists a problem in `errors[]`, the walk stopped
 * before the end, or the population changed while it ran. Stale mirrors alone are a finding, not a
 * failure: exit 0. An `unknown` row is by definition not compared; a per-alias OpenNeuro failure
 * on one leaves it `unknown` with `unchecked` at 0 and `errors[]` empty (`errors[]` carries
 * batch-level failures only), so the rendering says "not compared" and its reason names why.
 */

import {
  type AnomalyKind,
  STALE_STATES,
  UPSTREAM_STATES,
  type UpstreamState,
  type UpstreamStateCounts,
  type UpstreamStatusPage,
  type UpstreamStatusRow,
  countUpstreamStates,
} from "../../shared/upstream-staleness.js";

/** What part of the fleet the walk was asked to cover. */
export type PassScope = "fleet" | "after" | "dataset";

export interface PassSummary {
  /** Distinct mirrors examined. */
  examined: number;
  population: {
    /** `population_total` on the first page. */
    start: number;
    /** `population_total` on the last page. */
    end: number;
    withdrawn: number;
    excluded_unmanaged: number;
  };
  /** Recounted from `rows`. */
  counts: UpstreamStateCounts;
  rows: UpstreamStatusRow[];
  /** Batch-level problems from every page, plus a refused page's own message. */
  errors: string[];
  /** The walk reached the end of the cursor (or the one dataset answered) and nothing disagreed. */
  complete: boolean;
  /** Why the pass could not see everything; empty means every mirror it reached was compared. */
  could_not_see: string[];
}

export interface PassInput {
  pages: readonly UpstreamStatusPage[];
  scope: PassScope;
  /** The walk stopped at `--max-pages` with more to read. */
  maxPagesReached: boolean;
  /** The walk stopped at a refused (502) page. */
  stoppedAtRefusal?: boolean;
}

export function summarizePass(input: PassInput): PassSummary {
  const { pages } = input;
  const byId = new Map<string, UpstreamStatusRow>();
  const errors: string[] = [];
  const reasons: string[] = [];
  for (const page of pages) {
    for (const row of page.rows) byId.set(row.dataset_id, row);
    errors.push(...page.errors);
    if (!page.ok) {
      const why = page.error ?? "OpenNeuro could not be read";
      errors.push(why);
      reasons.push(`a page was refused (HTTP 502): ${why}`);
    }
  }
  const rows = [...byId.values()];
  const counts = countUpstreamStates(rows);
  const first = pages[0];
  const last = pages[pages.length - 1];
  const population = {
    start: first?.population_total ?? 0,
    end: last?.population_total ?? 0,
    withdrawn: last?.withdrawn ?? 0,
    excluded_unmanaged: last?.excluded_unmanaged ?? 0,
  };

  if (counts.states.unchecked > 0) {
    reasons.push(`${counts.states.unchecked} mirror(s) could not be compared with OpenNeuro`);
  }
  const batchErrors = pages.reduce((n, p) => n + p.errors.length, 0);
  if (batchErrors > 0) reasons.push(`OpenNeuro reported ${batchErrors} problem(s) (see errors)`);
  if (input.maxPagesReached) reasons.push("stopped at --max-pages before the end of the fleet");
  const lastPageHasMore = last !== undefined && last.next_cursor !== null;
  if (lastPageHasMore && !input.maxPagesReached && !input.stoppedAtRefusal) {
    reasons.push("the walk ended before the last page");
  }
  if (input.scope === "fleet") {
    if (population.start !== population.end) {
      reasons.push(
        `the population changed during the pass (${population.start} at the start, ${population.end} at the end); rerun`,
      );
    } else if (rows.length !== population.end) {
      reasons.push(
        `${rows.length} mirror(s) were examined but the population is ${population.end}; the fleet changed during the pass, rerun`,
      );
    }
  }
  if (input.scope === "dataset" && rows.length !== 1) {
    reasons.push("the dataset did not answer with exactly one row");
  }
  if (pages.length === 0) reasons.push("no page was read");

  return {
    examined: rows.length,
    population,
    counts,
    rows,
    errors,
    complete: reasons.length === 0 && !lastPageHasMore,
    could_not_see: reasons,
  };
}

/** The process exit code the summary calls for: 2 when the pass could not see, else 0. */
export function exitCodeOf(summary: PassSummary): 0 | 2 {
  return summary.could_not_see.length > 0 ? 2 : 0;
}

const MEANING: Record<UpstreamState, string> = {
  current: "at upstream's latest snapshot",
  stale_ready: "upstream is newer and the tag is on the GitHub mirror",
  mirror_lag: "upstream is newer; the tag is not on the GitHub mirror yet",
  stale_unverified: "upstream is newer; the GitHub mirror could not be checked",
  anomaly: "upstream and NEMAR disagree in a way that needs a look (kinds below)",
  unknown: "upstream tag unknown; NOT compared, so not verified clean",
  not_examined: "never examined for its tag; run nemar admin upstream-backfill",
  unpublished: "no NEMAR version yet",
  in_progress: "an import is running",
  parked: "parked (blocklisted, quarantined or rolled back)",
  unchecked: "could not be compared: OpenNeuro did not answer",
};

/** States whose rows are listed by name. */
const LISTED: readonly UpstreamState[] = [...STALE_STATES, "anomaly", "unchecked"];

export function renderRow(row: UpstreamStatusRow): string {
  const recorded = row.recorded?.tag ?? "?";
  const latest = row.upstream?.latest_tag ?? "?";
  return `${row.dataset_id}  ${row.ds ?? "-"}  ${recorded} -> ${latest}  ${row.reason}`;
}

/** The human report as lines; `list` bounds the rows printed per state. */
export function renderReport(summary: PassSummary, list: number): string[] {
  const lines: string[] = [];
  const { population, counts } = summary;
  lines.push(
    `Examined ${summary.examined} of ${population.end} managed OpenNeuro mirrors ` +
      `(${population.withdrawn} withdrawn and ${population.excluded_unmanaged} unmanaged on###### rows not compared).`,
  );
  lines.push("");
  const width = Math.max(...UPSTREAM_STATES.map((s) => s.length));
  for (const state of UPSTREAM_STATES) {
    lines.push(
      `  ${state.padEnd(width)}  ${String(counts.states[state]).padStart(5)}  ${MEANING[state]}`,
    );
  }
  const kinds = (Object.entries(counts.anomalies) as [AnomalyKind, number][]).filter(
    ([, n]) => n > 0,
  );
  if (kinds.length > 0) {
    lines.push("");
    lines.push(`Anomalies: ${kinds.map(([k, n]) => `${k}=${n}`).join(", ")}`);
  }
  lines.push("");
  lines.push(`Stale in total: ${counts.stale}`);
  lines.push(
    `Unknown tag and probably stale by date: ${counts.probably_stale} (display only, not stale)`,
  );
  if (counts.states.unknown > 0) {
    lines.push(
      `${counts.states.unknown} mirror(s) have an unknown tag: they were not compared, whatever the lines above say about OpenNeuro.`,
    );
  }
  for (const state of LISTED) {
    const rows = summary.rows.filter((r) => r.state === state);
    if (rows.length === 0) continue;
    lines.push("");
    lines.push(`${state} (${rows.length}):`);
    for (const row of rows.slice(0, list)) lines.push(`  ${renderRow(row)}`);
    if (rows.length > list) lines.push(`  ... and ${rows.length - list} more`);
  }
  if (summary.errors.length > 0) {
    lines.push("");
    lines.push("Problems reported by the API:");
    for (const e of summary.errors) lines.push(`  ${e}`);
  }
  return lines;
}
