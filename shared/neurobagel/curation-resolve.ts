/**
 * What becomes of a curation entry when a dataset is converted (epic #1586, phase 5; ADR 0083).
 *
 * The transform hands this module the entry and the dataset's two documents and gets back one of
 * four outcomes (applied, stale, invalid, unused), the flag that says so, the columns to apply
 * (only for `applied`), and the variables the entry names when it was NOT applied: those have
 * their mechanical mapping withheld, because an entry may exist only to withdraw a claim the
 * mechanical rule would make, and one that goes stale must lose claims, never make a false one.
 * It also turns an outcome into the report's `curation` section, which holds counts and
 * enumerated values only.
 * Kept out of transform.ts so that function stays about the conversion.
 *
 * Pure: no I/O.
 */

import {
  type BoundCuration,
  type CurationDocuments,
  type StaleFile,
  bindCuration,
  kindsOf,
} from "./curation-bind";
import { isLoaded } from "./curation-loaded";
import { type CurationEntry, type CurationKind, kindCounts } from "./curation-types";
import type { CurationReport, WithheldCounts } from "./report";

/** What became of an entry, before the counts the report adds to it. */
export type CurationOutcome =
  | { status: "applied" }
  | { status: "stale"; stale_files: StaleFile[] }
  | { status: "invalid"; problems: number }
  | { status: "unused" };

export interface ResolvedCuration {
  outcome: CurationOutcome;
  /** The flag the report carries for this outcome, or null for `applied`. */
  flag: "curation_stale" | "curation_invalid" | "curation_unused" | null;
  /** The columns to apply: present only when the entry was applied. */
  applied: BoundCuration | null;
  /** The variables an entry that was not applied names; empty when it was applied. */
  namedByUnapplied: ReadonlySet<CurationKind>;
}

/** Why an entry may not be used for this dataset at all, or null. */
export function curationRefusal(
  entry: CurationEntry,
  datasetId: string,
): { code: "curation_not_loaded" | "curation_dataset_mismatch"; message: string } | null {
  if (!isLoaded(entry)) {
    return {
      code: "curation_not_loaded",
      message:
        "the curation entry did not come from parseCuration, so its terms were never checked",
    };
  }
  if (entry.datasetId !== datasetId) {
    return {
      code: "curation_dataset_mismatch",
      message: `the curation entry is for ${entry.datasetId} but this is ${datasetId}`,
    };
  }
  return null;
}

/**
 * Bind `entry` to the documents and decide its outcome.
 * `phenotypeUsable` is whether the table's participants are the graph's; an entry that fits a table
 * whose participants are not is `unused`.
 */
export async function resolveCuration(
  entry: CurationEntry,
  documents: CurationDocuments,
  phenotypeUsable: boolean,
): Promise<ResolvedCuration> {
  const bound = await bindCuration(entry, documents);
  const named = new Set(kindsOf(entry));
  if (bound.status === "stale") {
    return {
      outcome: { status: "stale", stale_files: bound.staleFiles },
      flag: "curation_stale",
      applied: null,
      namedByUnapplied: named,
    };
  }
  if (bound.status === "invalid") {
    return {
      outcome: { status: "invalid", problems: bound.problems.length },
      flag: "curation_invalid",
      applied: null,
      namedByUnapplied: named,
    };
  }
  if (!phenotypeUsable) {
    // The table fits, but none of its participants are the graph's: nothing to attach it to.
    return {
      outcome: { status: "unused" },
      flag: "curation_unused",
      applied: null,
      namedByUnapplied: named,
    };
  }
  return {
    outcome: { status: "applied" },
    flag: null,
    applied: bound.bound,
    namedByUnapplied: new Set(),
  };
}

/** The report's account of an entry: counts and enumerated values only, never a name or a cell. */
export function curationReportFor(
  entry: CurationEntry,
  outcome: CurationOutcome,
  participantsWith: Record<CurationKind, number>,
  withheld: WithheldCounts,
): CurationReport {
  const declared = kindCounts();
  for (const column of entry.columns) declared[column.kind]++;
  const common = { review: entry.evidence.review, declared };
  const notApplied = {
    columns_applied: 0 as const,
    columns_skipped: entry.columns.length,
    withheld,
  };
  switch (outcome.status) {
    case "applied":
      return {
        ...common,
        status: "applied",
        columns_applied: entry.columns.length,
        columns_skipped: 0,
        participants_with: participantsWith,
      };
    case "stale":
      return { ...common, ...notApplied, status: "stale", stale_files: outcome.stale_files };
    case "invalid":
      return { ...common, ...notApplied, status: "invalid", problems: outcome.problems };
    case "unused":
      return { ...common, ...notApplied, status: "unused" };
  }
}
