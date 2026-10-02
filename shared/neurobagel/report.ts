/**
 * The shape of `<id>.report.json`.
 *
 * The report holds counts and flags only, never a participant id or a participant's
 * value, so it is safe to log and to store next to the artifacts.
 * It is typed here so the writer that stores it and the sweep that reads it use the
 * fields by name instead of parsing the text blind; `buildNeurobagelArtifacts`
 * returns this object and also writes its canonical JSON as one of the files.
 *
 * Types only: no code, no I/O.
 */

import type { ColumnCounts } from "./participants";

/**
 * What became of one of the mapped columns (age, sex, group).
 * `needs_curation` means the column exists and the rules could not map it, so it is
 * left out until a reviewer annotates it.
 */
export type ColumnReport =
  | { status: "absent" }
  | { status: "all_missing" }
  | { status: "needs_curation"; reason: string; counts: ColumnCounts }
  | { status: "mapped"; counts: ColumnCounts };

/** `ids_do_not_join`: the table and the bids index share no participant id, so the table is not used. */
export type TableStatus = "ok" | "absent" | "malformed" | "no_participant_id" | "ids_do_not_join";

export type NeurobagelReport = {
  report_version: 1;
  transform_version: number;
  dataset_id: string;
  columns: { age: ColumnReport; group: ColumnReport; sex: ColumnReport };
  /** Sorted. The writer surfaces `partial_join` and `bids_index_empty_fell_back_to_table`. */
  flags: string[];
  graph: {
    acquisitions: number;
    imaging_sessions: number;
    phenotypic_sessions: number;
    subjects: number;
  };
  imaging: {
    /** BIDS datatype directory to the subjects that have it, for datatypes with no Neurobagel term. */
    datatypes_dropped_subjects: Record<string, number>;
    datatypes_mapped_subjects: Record<string, number>;
    mapped_datatypes_supported: string[];
    /**
     * How the imaging sessions of subjects with a mapped datatype were placed:
     * `recorded`, `single_session`, `unknown`, `unreadable` or `inconsistent` (see jsonld.ts).
     */
    session_pairing_subjects: Record<string, number>;
  };
  participant_count: {
    bids_index: number;
    declared: number | null;
    graph: number;
    participants_tsv: number;
    /** The count the dataset description carries (`ParticipantCount`). */
    used: number;
    used_from: "demographics" | "bids_index" | "participants_tsv";
  };
  participants_json: { status: "present" | "absent" | "unreadable" };
  participants_tsv: {
    bom_stripped: boolean;
    /** Subjects whose duplicate rows disagree: their phenotype is dropped. */
    conflicting_ids: number;
    /** Rows that repeat an id already seen (identical or not). */
    duplicate_ids: number;
    ids_prefixed: number;
    rows: number;
    rows_without_id: number;
    status: TableStatus;
  };
  session_label_used_for_phenotype: string;
  /**
   * Where the graph's subjects came from and how the table's ids met the index's.
   * The graph holds the subjects of the bids index (those with data at NEMAR);
   * `table_only` counts table rows for participants with no data, left out of the graph.
   * No join is guessed: ids meet by exact equality after `sub-` is added.
   */
  subjects: {
    graph: number;
    index_without_row: number;
    joined: number;
    source: "bids_index" | "participants_tsv";
    table_only: number;
  };
  vocabulary: { bagel: string; communities_commit: string };
};
