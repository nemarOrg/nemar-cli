/**
 * A quiet week of the automatic re-pull, as the weekly report's facts carry it (epic #1046 phase 7,
 * #1913): the switches off, the scheduler stamped, nothing dispatched, held or merged. A suite
 * lays what it is about on top, so a fixture says only what differs from a week with nothing to do.
 */

import type { RepullWeekFacts } from "../../../shared/repull-observability";
import { DISPATCH_STATUSES, type DispatchStatus } from "../../../shared/repull-state";

export function zeroStatuses(): Record<DispatchStatus, number> {
  return Object.fromEntries(DISPATCH_STATUSES.map((s) => [s, 0])) as Record<DispatchStatus, number>;
}

export function repullWeekFacts(over: Partial<RepullWeekFacts> = {}): RepullWeekFacts {
  return {
    window: { from: "2026-09-02 03:00:00", to: "2026-09-09 03:00:00" },
    dispatches: {
      sent: 0,
      by_kind: { open: 0, finish: 0 },
      by_status: zeroStatuses(),
      by_word: { refused: {}, failed: {}, dispatch_failed: {} },
    },
    open_automatic: { total: 0, held: 0, holds: {} },
    held_claims: 0,
    merged: { worker: 0, administrator: 0, outside_tool: 0, unattributed: 0 },
    ended_failed: 0,
    switches: {
      environment_is_production: true,
      auto_repull_enabled: false,
      auto_repull_merge_enabled: false,
      open_cap: { value: 2, source: "default" },
      merge_cap: { value: 5, source: "default" },
    },
    scheduler: {
      last_tick_at: "2026-09-09 03:00:01",
      last_outcome: "switch-off",
      last_advance_at: "2026-09-09 02:30:02",
    },
    attention: [],
    ...over,
  };
}
