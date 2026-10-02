/**
 * The types of a reviewed curation entry (epic #1586, phase 5; ADR 0083).
 *
 * Types and the list of kinds: no logic, no vocabulary.
 * They are split from the loader (`curation.ts`) so that the transform and the
 * binder can name an entry without importing the full diagnosis and assessment
 * vocabularies, which only the loader needs.
 */

import type { AgeFormatId } from "./participants";
import type { VocabTerm } from "./vocab";

/** The kinds of column a curation entry may carry, in the order the report lists them. */
export const CURATION_KINDS = ["age", "assessment", "diagnosis", "sex"] as const;
export type CurationKind = (typeof CURATION_KINDS)[number];

/**
 * Who looked at the entry.
 *   author              the author of the change; not a domain expert
 *   domain_expert       a person with expertise in the condition or instrument the entry names
 *   upstream_community  copied from Neurobagel's published OpenNeuro annotations, which their
 *                       community reviewed; NEMAR has not reviewed it beyond the loader's checks
 */
export type CurationReview = "author" | "domain_expert" | "upstream_community";

export interface CurationEvidence {
  /** Where the annotations came from, in words a reviewer can follow. */
  source: string;
  /** Who reviewed them. */
  reviewer: string;
  review: CurationReview;
  /** Calendar date of the review, `YYYY-MM-DD`. */
  date: string;
}

/**
 * The git blob SHA-1 of the exact bytes the entry was reviewed against.
 * For a git-tracked file this is the data plane's `git:` entity tag (ADR 0066).
 * `participantsJson` is `null` when the dataset has no participants.json, which the entry then
 * pins as absent.
 */
export interface CurationPins {
  participantsTsv: string;
  participantsJson: string | null;
}

interface CuratedColumnBase {
  /** The participants.tsv column, spelled exactly as in its header. */
  name: string;
  /** Raw cell values that mean "not recorded" in this column. */
  missingValues: string[];
}

export type CuratedColumn =
  | (CuratedColumnBase & {
      kind: "sex";
      /** Raw cell value to the sex term it means, sorted by raw value. */
      levels: Map<string, VocabTerm>;
    })
  | (CuratedColumnBase & {
      kind: "diagnosis";
      /** Raw cell value to the diagnosis term it means, sorted by raw value. */
      levels: Map<string, VocabTerm>;
    })
  | (CuratedColumnBase & {
      kind: "age";
      format: AgeFormatId;
      formatTerm: VocabTerm;
      /** The range the reviewer recorded; checked against the table, never trusted. */
      valueRange: { min: number; max: number } | null;
    })
  | (CuratedColumnBase & {
      kind: "assessment";
      /** The assessment tool the column is an item of. */
      tool: VocabTerm;
    });

export interface CurationEntry {
  datasetId: string;
  evidence: CurationEvidence;
  pins: CurationPins;
  /** Sorted by column name; at most one `sex` and one `age` column. */
  columns: CuratedColumn[];
}

/** A loaded `curation.json`: its entries by dataset id. */
export interface CurationFile {
  entries: Map<string, CurationEntry>;
}
