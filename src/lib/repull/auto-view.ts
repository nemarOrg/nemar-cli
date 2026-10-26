/**
 * `nemar admin repull auto`: what the automatic re-pull says about itself (ADR 0111, the Phase 7h
 * slice; epic #1046 phase 7). The switches and both caps as the Worker reads them, the scheduler's
 * stamps, the open automatic re-pulls with the word each waits for, and the recent dispatches.
 *
 * An administrator's read: it names datasets and ids, which the weekly report on a public-facing
 * repository never does. It reads three routes, changes nothing, and shows an unknown as unknown:
 * a scheduler row the Worker could not find is "unknown", never "never", and a list of open
 * re-pulls that stopped before its end says so rather than counting what it read as all.
 */

import type {
  DispatchView,
  RepullCapReading,
  RepullSchedulerRow,
  RepullSwitchesReport,
} from "../../../shared/repull-observability.js";
import type { RepullRow } from "../../../shared/repull-state.js";
import { getRepullSwitches, listRepullDispatches, listRepulls } from "../api/repull.js";
import { clip, plain } from "../terminal-text.js";

/** The dispatches the command shows: one short page, the newest. */
export const AUTO_DISPATCHES_SHOWN = 20;
/** The pages of open re-pulls (50 each) the command reads before it says the list stopped. */
export const AUTO_OPEN_PAGES_MAX = 10;

/** Everything the command shows, as read. */
export interface AutoView {
  switches: RepullSwitchesReport;
  /** Null when the Worker found no scheduler row: unknown, not "never". */
  scheduler: RepullSchedulerRow | null;
  /** The open re-pulls whose origin is `automatic`, newest first. */
  open: RepullRow[];
  /** True when open re-pulls remained after the last page this read: `open` is not all of them. */
  openTruncated: boolean;
  /** The newest dispatches, newest first. */
  dispatches: DispatchView[];
  /** True when the page was full, so older dispatches exist (the count shown is not the total). */
  dispatchesFull: boolean;
}

/** Read the three routes. Any failure throws: a partial table would claim what was not read. */
export async function readAuto(): Promise<AutoView> {
  const { switches, scheduler } = await getRepullSwitches();
  const page = await listRepullDispatches({ limit: AUTO_DISPATCHES_SHOWN });
  const open: RepullRow[] = [];
  let after: number | undefined;
  let openTruncated = false;
  for (let pages = 1; ; pages++) {
    const res = await listRepulls({ open: true, limit: 50, after });
    open.push(...res.repulls.filter((r) => r.origin === "automatic"));
    if (res.next_after === null) break;
    if (pages >= AUTO_OPEN_PAGES_MAX) {
      openTruncated = true;
      break;
    }
    after = res.next_after;
  }
  return {
    switches,
    scheduler,
    open,
    openTruncated,
    dispatches: page.dispatches,
    dispatchesFull: page.next_after !== null,
  };
}

/** The JSON the command prints: the same facts, under the names the routes use. */
export function autoJson(v: AutoView): Record<string, unknown> {
  return {
    switches: v.switches,
    scheduler: v.scheduler,
    open_automatic: v.open,
    open_automatic_truncated: v.openTruncated,
    dispatches: v.dispatches,
    dispatches_next_after: v.dispatchesFull ? (v.dispatches.at(-1)?.id ?? null) : null,
  };
}

const when = (at: string | null): string => (at === null ? "never recorded" : `${plain(at)} UTC`);
const onOff = (on: boolean): string => (on ? "on" : "off");

function capText(c: RepullCapReading): string {
  return c.source === "unreadable"
    ? "unreadable, so it reads 0 (the binding is set to something the reader cannot take)"
    : `${c.value} (${c.source === "set" ? "set" : "the default"})`;
}

function schedulerLines(s: RepullSchedulerRow | null): string[] {
  if (s === null) {
    return [
      "  Unknown: the Worker found no scheduler row (migration 0112 inserts it), which is not the same as a scheduler that never ran.",
    ];
  }
  const outcome = s.last_outcome === null ? "" : `, concluded ${plain(s.last_outcome)}`;
  return [
    `  Daily tick last ran:    ${when(s.last_tick_at)}${outcome}`,
    `  Advance tick last ran:  ${when(s.last_advance_at)}`,
  ];
}

/** An open automatic re-pull in one line: what it is, where it is, and why it waits. */
function openLine(r: RepullRow): string {
  const held =
    r.hold_reason === null ? "" : `, held for ${plain(r.hold_reason)} since ${when(r.hold_since)}`;
  const claim =
    r.merge_claimed_at !== null && r.merge_sha === null
      ? `, claim to merge held since ${when(r.merge_claimed_at)}`
      : r.patch_merge_claimed_at !== null && r.patch_merge_sha === null
        ? `, N.0.1 claim to merge held since ${when(r.patch_merge_claimed_at)}`
        : "";
  const error = r.last_error === null ? "" : `; last error: ${clip(r.last_error, 100)}`;
  return `  #${r.id} ${plain(r.dataset_id)} v${plain(r.to_version)} ${r.status}${held}${claim}${error}`;
}

function dispatchLine(d: DispatchView): string {
  const code = d.code === null ? "" : ` ${plain(d.code)}`;
  const repull = d.repull_id === null ? "" : ` (re-pull #${d.repull_id})`;
  const run = d.workflow_run_url === null ? "" : ` ${plain(d.workflow_run_url)}`;
  return `  #${d.id} ${d.kind} ${plain(d.dataset_id)} ${d.status}${code}${repull} ${plain(d.dispatched_at)} UTC${run}`;
}

/** The text the command prints. */
export function autoLines(v: AutoView): string[] {
  const s = v.switches;
  const lines = [
    "Switches, as this Worker reads them",
    `  Production Worker:           ${s.environment_is_production ? "yes" : "no (a Worker that is not exactly production honors no switch)"}`,
    `  AUTO_REPULL_ENABLED:         ${onOff(s.auto_repull_enabled)}`,
    `  AUTO_REPULL_MERGE_ENABLED:   ${onOff(s.auto_repull_merge_enabled)}`,
    `  REPULL_DAILY_OPEN_CAP:       ${capText(s.open_cap)}`,
    `  REPULL_DAILY_MERGE_CAP:      ${capText(s.merge_cap)}`,
    "",
    "Scheduler",
    ...schedulerLines(v.scheduler),
    "",
  ];
  if (v.open.length === 0 && !v.openTruncated) {
    lines.push("Open automatic re-pulls: none");
  } else {
    lines.push(
      `Open automatic re-pulls: ${v.open.length}${v.openTruncated ? " (read so far)" : ""}`,
    );
    for (const r of v.open) lines.push(openLine(r));
    if (v.openTruncated) {
      lines.push(
        `  The list stopped after ${AUTO_OPEN_PAGES_MAX} pages of open re-pulls of every origin; more are open than are shown.`,
      );
    }
  }
  lines.push("");
  if (v.dispatches.length === 0) {
    lines.push("Recent dispatches: none");
  } else {
    lines.push(
      `Recent dispatches, newest first (${v.dispatches.length} shown${v.dispatchesFull ? "; older ones exist" : ""})`,
    );
    for (const d of v.dispatches) lines.push(dispatchLine(d));
  }
  lines.push("", "The week's counts, and what asks for attention: nemar admin import-weekly");
  return lines;
}
