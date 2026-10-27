/**
 * What the automatic re-pull shows about itself (epic #1046 phase 7, #1913; ADR 0111, the Phase 7h
 * slice): the switches an administrator reads, the scheduler's row, a dispatch as the admin list
 * shows it, and the week of re-pull activity the weekly import report counts. Types, one word and
 * the one rule for printing a stored word ({@link publicWord}), so the Worker, the CLI and the
 * tests read one declaration of what crosses the wire.
 *
 * Counts and fixed words, never a dataset. The weekly facts are rendered into a report filed on a
 * public-facing repository, so they hold no identifier, and a word that is not on a closed list
 * (or that names anonymity) is counted under {@link OTHER_WORD} instead of being printed.
 */

import {
  type DispatchKind,
  type DispatchRow,
  type DispatchStatus,
  REPULL_HOLD_REASONS,
  REPULL_SCHEDULER_OUTCOMES,
  isDispatchCode,
} from "./repull-state.js";

/** A cap as the Worker reads it: how, and what it comes to. `unreadable` reads 0. */
export interface RepullCapReading {
  value: number;
  /** `default` when absent, `set` when read, `unreadable` when set to anything else. */
  source: "default" | "set" | "unreadable";
}

/** What the Worker reads of the switches and caps. It holds no secret and no binding value. */
export interface RepullSwitchesReport {
  environment_is_production: boolean;
  auto_repull_enabled: boolean;
  auto_repull_merge_enabled: boolean;
  open_cap: RepullCapReading;
  merge_cap: RepullCapReading;
}

/**
 * The scheduler's one row (`upstream_repull_scheduler`), without its cursor, which is a dataset id.
 * A NULL time means nothing has stamped it yet, which is not the same as not having read it.
 */
export interface RepullSchedulerRow {
  /** The daily tick's last run, stamped whether or not it dispatched anything. */
  last_tick_at: string | null;
  /** What that tick concluded (`REPULL_SCHEDULER_OUTCOMES`). */
  last_outcome: string | null;
  /** The 30-minute advance tick's last run that could list its rows. */
  last_advance_at: string | null;
}

/** A dispatch as the admin list shows it: every column but the one-shot nonce. */
export type DispatchView = Omit<DispatchRow, "nonce">;

/** Counts by a fixed word. A word not on the closed list is counted under {@link OTHER_WORD}. */
export type WordCounts = Record<string, number>;

/** Where a word the report must not print goes: not on its closed list, or one that names anonymity. */
export const OTHER_WORD = "other";

/** The closed lists a stored word belongs to: a dispatch's code, a hold's reason, a scheduler outcome. */
export type WordList = "code" | "hold" | "outcome";

/** A word that names anonymity is never printed in a public report, whatever list it is on. */
const WITHHELD_WORD = /anonym/i;

const WORD_LISTS: Record<WordList, (word: string) => boolean> = {
  code: isDispatchCode,
  hold: (word) => (REPULL_HOLD_REASONS as readonly string[]).includes(word),
  outcome: (word) => (REPULL_SCHEDULER_OUTCOMES as readonly string[]).includes(word),
};

/**
 * The word a public report may print for a stored one: itself when it is on `list` and does not
 * name anonymity, {@link OTHER_WORD} otherwise (an unlisted word, a dataset id, an absent one).
 * The database checks only the SHAPE of a word and a dataset id has that shape, so the list is what
 * keeps one out of a report filed on a public-facing repository. The counts are made with this
 * rule and the report is written with it again, one function, so a fact that holds an identifier
 * where a word should be does not reach the repository by either road.
 */
export function publicWord(word: string | null | undefined, list: WordList): string {
  return typeof word === "string" && WORD_LISTS[list](word) && !WITHHELD_WORD.test(word)
    ? word
    : OTHER_WORD;
}

/**
 * The automatic re-pull's week as counted from the database (the weekly report's section, before
 * the switches and the scheduler are laid beside it). A count is a number: a read that failed makes
 * the whole of it unknown, which the report says (ADR 0054), never zero.
 */
export interface RepullWeek {
  /** The window these counts cover, SQLite UTC: `from` inclusive, `to` exclusive. */
  window: { from: string; to: string };
  /** Dispatches SENT in the window, counted by the state they are in when the report is made. */
  dispatches: {
    sent: number;
    by_kind: Record<DispatchKind, number>;
    by_status: Record<DispatchStatus, number>;
    /** The words of the dispatches that ended `refused`, `failed` or `dispatch_failed`. */
    by_word: { refused: WordCounts; failed: WordCounts; dispatch_failed: WordCounts };
  };
  /** The open automatic re-pulls when the report is made, and why the held ones wait. */
  open_automatic: { total: number; held: number; holds: WordCounts };
  /** Open re-pulls of any origin holding a claim to merge that is over an hour old, unresolved. */
  held_claims: number;
  /**
   * The merges recorded in the window, by who held the claim to merge: the Worker (the system
   * user), an administrator's tool, or none (merged outside NEMAR's tools). `unattributed` is a
   * merge that records a claim whose claimant the audit log does not hold.
   */
  merged: { worker: number; administrator: number; outside_tool: number; unattributed: number };
  /** Re-pulls that ended `failed` in the window, of any origin. */
  ended_failed: number;
}

/** The weekly report's re-pull facts: the week, the switches in force, the scheduler, and why a person should look. */
export interface RepullWeekFacts extends RepullWeek {
  switches: RepullSwitchesReport;
  /** Null when the scheduler's row is absent: unknown, not "never". */
  scheduler: RepullSchedulerRow | null;
  /**
   * Why this part of the week needs a person, one phrase each, in the order the headline lists
   * them. Fixed phrases and counts only. The shared attention rule adds them to the headline and
   * to `nemar admin import-weekly`'s exit code, so the two cannot disagree about a week.
   */
  attention: string[];
}
