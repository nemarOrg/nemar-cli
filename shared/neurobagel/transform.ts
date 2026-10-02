/**
 * NEMAR to Neurobagel: one pure transform over the documents the data plane
 * already serves.
 *
 *   metadata.json + participants.tsv + participants.json
 *     -> <id>.jsonld                    graph-mode JSON-LD, what a stock node loads
 *     -> <id>_annotated.json            the data dictionary (input of `bagel pheno`)
 *     -> <id>_dataset_description.json  the dataset description (input of `bagel pheno`)
 *     -> <id>.report.json               counts only, never a participant value
 *
 * Rules that matter more than the mapping details:
 *   - Identity (name, authors, keywords, DOI) comes ONLY from metadata.json.
 *     The backend writes and blinds that file; a depositor's files cannot be
 *     blinded (ADR 0065, ADR 0067).
 *   - The transform REFUSES any input whose `anonymous` is not exactly false.
 *     A missing value is unknown, and unknown is not false.
 *     This is a backstop: whether a dataset is eligible at all is decided
 *     from the database row by the writer, never from this document.
 *   - The graph holds the subjects of the bids index, the participants that have
 *     data at NEMAR. Table rows for participants with no data are counted and left
 *     out; no join of mismatched ids is guessed.
 *   - A fact the rules cannot establish is left out and counted, never guessed
 *     (see participants.ts). EMG is never mapped to EEG.
 *     A reviewed curation entry (curation.ts, ADR 0083) can supply what the rules
 *     leave out. It is applied only if the two participants documents are the bytes
 *     it pinned and it fits them, and only to the graph's participants. Otherwise it
 *     is skipped whole, with a flag, and the variables it names are WITHHELD: their
 *     mechanical mapping is held back too, because an entry may exist to withdraw a
 *     claim the rules would make, and one that goes stale must lose claims, never
 *     make a false one. The variables it does not name ship as without an entry.
 *   - Output is byte-stable: same input, same bytes (canonical-json.ts), and
 *     identifiers are derived from names (identifiers.ts).
 *   - The output is validated before it is returned (validate-output.ts).
 *
 * Pure: no I/O, no network, no clock, no randomness.
 */

import { type CanonicalJsonValue, byCodeUnit, canonicalJson } from "./canonical-json";
import type { BoundCuration } from "./curation-bind";
import { curationRefusal, curationReportFor, resolveCuration } from "./curation-resolve";
import { type CurationKind, kindCounts } from "./curation-types";
import {
  CURATED_DIAGNOSIS_DESCRIPTION,
  type DiagnosisColumn,
  GROUP_DESCRIPTION,
  buildDatasetDescription,
  buildDictionary,
} from "./dictionary";
import {
  type NemarMetadata,
  type NeurobagelInput,
  type ParticipantsJson,
  metadataSchema,
  participantsJsonSchema,
} from "./input-schema";
import {
  type DatasetModel,
  type SubjectModel,
  UNNAMED_SESSION_LABEL,
  buildJsonLd,
  imagingSessionsFor,
} from "./jsonld";
import {
  type AgeMapping,
  type ColumnCounts,
  type ColumnOutcome,
  HEALTHY_CONTROL,
  STANDARD_MISSING_VALUES,
  type SexMapping,
  ageUnitsIn,
  mapAgeColumn,
  mapGroupColumn,
  mapSexColumn,
} from "./participants";
import type {
  ColumnReport,
  CurationReport,
  NeurobagelReport,
  TableStatus,
  WithheldCounts,
} from "./report";
import { parseTsv } from "./tsv";
import {
  validateDatasetDescription,
  validateDictionary,
  validateGraphDocument,
} from "./validate-output";
import { NEUROBAGEL_TRANSFORM_VERSION } from "./version";
import { MAPPED_DATATYPES, VOCAB, type VocabTerm, modalityTermForDatatype } from "./vocab";

export type RefusalCode =
  | "anonymous_not_false"
  | "invalid_metadata"
  | "dataset_id_mismatch"
  | "no_subjects"
  | "curation_not_loaded"
  | "curation_dataset_mismatch"
  | "output_invalid";

/** The transform declined to produce artifacts. `code` is stable; `message` is for a person. */
export class NeurobagelRefusal extends Error {
  constructor(
    readonly code: RefusalCode,
    message: string,
  ) {
    super(message);
    this.name = "NeurobagelRefusal";
  }
}

export interface NeurobagelArtifacts {
  datasetId: string;
  /** File name to file text, exactly the bytes to store; names come from {@link artifactFileNames}. */
  files: Record<string, string>;
  /** The typed view of `files[<id>.report.json]`. */
  report: NeurobagelReport;
}

/** The names of the four files `buildNeurobagelArtifacts` returns for a dataset. */
export function artifactFileNames(datasetId: string): {
  jsonld: string;
  dictionary: string;
  datasetDescription: string;
  report: string;
} {
  return {
    jsonld: `${datasetId}.jsonld`,
    dictionary: `${datasetId}_annotated.json`,
    datasetDescription: `${datasetId}_dataset_description.json`,
    report: `${datasetId}.report.json`,
  };
}

const DOI_RE = /^10\.\d{4,9}\/\S+$/;
const PARTICIPANT_COLUMN = "participant_id";

/** Datatype keys in the report must be plain directory names, never free text. */
const REPORTABLE_DATATYPE = /^[a-z0-9]{1,24}$/;

// Maps, not objects: a datatype directory may be named `constructor`, and an object
// would find Object's member there instead of a count.
function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function sortedRecord(map: Map<string, number>): Record<string, number> {
  return Object.fromEntries([...map.entries()].sort(([a], [b]) => byCodeUnit(a, b)));
}

function columnReport(outcome: ColumnOutcome<object>): ColumnReport {
  switch (outcome.status) {
    case "absent":
      return { status: "absent" };
    case "all_missing":
      return { status: "all_missing" };
    case "curation":
      return { counts: { ...outcome.counts }, reason: outcome.reason, status: "needs_curation" };
    case "mapped":
      return { counts: { ...outcome.counts }, status: "mapped" };
  }
}

/** Index of the first header cell that names `wanted` (case-insensitive, surrounding space ignored). */
function findColumn(header: string[], wanted: string): number {
  return header.findIndex((h) => h.trim().toLowerCase() === wanted);
}

/** `001` and `sub-001` name one subject; the graph and the bids index use the prefixed form. */
function normalizeParticipantId(raw: string): { id: string; prefixed: boolean } {
  return raw.startsWith("sub-")
    ? { id: raw, prefixed: false }
    : { id: `sub-${raw}`, prefixed: true };
}

interface TableRead {
  status: Exclude<TableStatus, "ids_do_not_join">;
  bomStripped: boolean;
  header: string[];
  idColumn: number;
  /** One row per participant whose rows agree: the table's phenotype. */
  rows: Map<string, string[]>;
  /** Every participant the table names, including those whose duplicate rows disagree. */
  ids: Set<string>;
  rowCount: number;
  rowsWithoutId: number;
  /** Rows that repeat an id already seen. */
  duplicates: number;
  /** Participants whose duplicate rows disagree; their phenotype is dropped. */
  conflicting: number;
  prefixed: number;
}

/**
 * Whether two rows say the same thing about a participant: every cell but the id cell.
 * `sub-01` and `01` name one participant, so two rows that differ only in how the id is
 * spelled are the same row.
 */
const sameRow = (a: string[], b: string[], idColumn: number): boolean =>
  a.length === b.length && a.every((cell, i) => i === idColumn || cell === b[i]);

/**
 * Read participants.tsv into one phenotype row per participant.
 * A participant listed twice with identical rows is one participant; listed twice
 * with rows that disagree, no row can be taken as the truth, so the participant
 * stays (the table does name them) but carries no phenotype.
 */
function readTable(text: string | null, flags: Set<string>): TableRead {
  const empty: TableRead = {
    status: "absent",
    bomStripped: false,
    header: [],
    idColumn: -1,
    rows: new Map(),
    ids: new Set(),
    rowCount: 0,
    rowsWithoutId: 0,
    duplicates: 0,
    conflicting: 0,
    prefixed: 0,
  };
  if (text === null) {
    flags.add("participants_tsv_absent");
    return empty;
  }
  const parsed = parseTsv(text);
  if (!parsed.ok) {
    flags.add("participants_tsv_malformed");
    return { ...empty, status: "malformed" };
  }
  const read: TableRead = {
    ...empty,
    bomStripped: parsed.bomStripped,
    header: parsed.table.header,
  };
  if (read.bomStripped) flags.add("bom_stripped");
  read.idColumn = read.header.indexOf(PARTICIPANT_COLUMN);
  if (read.idColumn === -1) {
    flags.add("participants_tsv_no_participant_id");
    return { ...read, status: "no_participant_id" };
  }
  read.status = "ok";
  read.rowCount = parsed.table.rows.length;
  const first = new Map<string, string[]>();
  const conflicting = new Set<string>();
  for (const row of parsed.table.rows) {
    const raw = row[read.idColumn];
    if (raw.trim() === "") {
      read.rowsWithoutId++;
      continue;
    }
    const { id, prefixed } = normalizeParticipantId(raw);
    const seen = first.get(id);
    if (seen !== undefined) {
      read.duplicates++;
      if (!sameRow(seen, row, read.idColumn)) conflicting.add(id);
      continue;
    }
    if (prefixed) read.prefixed++;
    read.ids.add(id);
    first.set(id, row);
  }
  for (const [id, row] of first) if (!conflicting.has(id)) read.rows.set(id, row);
  read.conflicting = conflicting.size;
  if (read.prefixed > 0) flags.add("participant_ids_prefixed");
  if (read.duplicates > 0) flags.add("duplicate_participant_ids");
  if (read.conflicting > 0) flags.add("conflicting_duplicate_participant_ids");
  return read;
}

function readParticipantsJson(
  text: string | null,
  flags: Set<string>,
): { status: "present" | "absent" | "unreadable"; value: ParticipantsJson | null } {
  if (text === null) {
    flags.add("participants_json_absent");
    return { status: "absent", value: null };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    flags.add("participants_json_unreadable");
    return { status: "unreadable", value: null };
  }
  const checked = participantsJsonSchema.safeParse(parsed);
  if (!checked.success) {
    flags.add("participants_json_unreadable");
    return { status: "unreadable", value: null };
  }
  return { status: "present", value: checked.data };
}

export async function buildNeurobagelArtifacts(
  input: NeurobagelInput,
): Promise<NeurobagelArtifacts> {
  // 1. The anonymity backstop runs on the RAW value, before anything is parsed or read.
  const rawMetadata = input.metadata;
  if (
    typeof rawMetadata !== "object" ||
    rawMetadata === null ||
    (rawMetadata as Record<string, unknown>).anonymous !== false
  ) {
    throw new NeurobagelRefusal(
      "anonymous_not_false",
      "metadata.json does not say anonymous: false, so the dataset is not eligible",
    );
  }

  // 2. Identity, from metadata.json only.
  const parsedMetadata = metadataSchema.safeParse(rawMetadata);
  if (!parsedMetadata.success) {
    const first = parsedMetadata.error.issues[0];
    throw new NeurobagelRefusal(
      "invalid_metadata",
      `metadata.json is not a usable neuroschema dataset: ${first?.path.join(".")}: ${first?.message}`,
    );
  }
  const metadata: NemarMetadata = parsedMetadata.data;
  const datasetId = metadata.dataset_id;
  if (input.expectedDatasetId !== datasetId) {
    throw new NeurobagelRefusal(
      "dataset_id_mismatch",
      `expected ${input.expectedDatasetId} but metadata.json is for ${datasetId}`,
    );
  }

  const flags = new Set<string>();

  const trimmedName = metadata.name.trim();
  if (trimmedName === "") flags.add("name_fell_back_to_dataset_id");
  const name = trimmedName === "" ? datasetId : trimmedName;

  const authors = metadata.authors.map((a) => a.name.trim()).filter((n) => n !== "");
  const keywords = [
    ...new Set(metadata.keywords.map((k) => k.term.trim()).filter((t) => t !== "")),
  ];

  const pageUrl = `https://nemar.org/dataset/${datasetId}`;
  const referencesAndLinks = [pageUrl];
  const doi = metadata.external_links?.dataset_doi?.trim();
  if (doi) {
    if (DOI_RE.test(doi)) referencesAndLinks.push(`https://doi.org/${doi}`);
    else flags.add("dataset_doi_unusable");
  }
  const latestVersion = metadata.provenance?.latest_snapshot?.trim() || null;
  const license = metadata.license?.trim() || null;
  const licenseSentence = license ? `License: ${license}. ` : "";
  const versionSuffix = latestVersion ? ` (latest version ${latestVersion}).` : ".";
  const accessInstructions = `Public access. ${licenseSentence}Browse and download at ${pageUrl}${versionSuffix}`;

  // 3. The documents about participants.
  const table = readTable(input.participantsTsv, flags);
  const participantsJson = readParticipantsJson(input.participantsJson, flags);

  // 4. Subjects. The graph holds the subjects of the bids index: the participants that
  // have data at NEMAR. A table row for a participant with no data is counted and left
  // out. Ids meet by exact equality (after `sub-` is added); a near miss is never joined.
  const index = metadata.extensions?.nemar?.bids_index?.subjects ?? {};
  const indexIds = Object.keys(index).sort(byCodeUnit);
  const indexSet = new Set(indexIds);
  const tableUsable = table.status === "ok";
  const sharedWithIndex = tableUsable ? [...table.ids].filter((id) => indexSet.has(id)).length : 0;

  let tableStatus: TableStatus = table.status;
  let source: "bids_index" | "participants_tsv" = "bids_index";
  let graphIds = indexIds;
  if (indexIds.length === 0) {
    // No subject has data in the index: the table is the only list of subjects there is.
    source = "participants_tsv";
    graphIds = tableUsable ? [...table.ids].sort(byCodeUnit) : [];
    if (graphIds.length > 0) flags.add("bids_index_empty_fell_back_to_table");
  } else if (tableUsable && table.ids.size > 0 && sharedWithIndex === 0) {
    // Two id spaces with nothing in common: the table's phenotype cannot be attributed to
    // any subject, so the table is not used.
    tableStatus = "ids_do_not_join";
    flags.add("participant_ids_do_not_join_bids_index");
  } else if (
    tableUsable &&
    sharedWithIndex > 0 &&
    sharedWithIndex < table.ids.size &&
    sharedWithIndex < indexIds.length
  ) {
    // Ids are left over on BOTH sides: a renamed participant would look exactly like this.
    // The counts are in the report; nothing is guessed.
    flags.add("partial_join");
  }
  if (graphIds.length === 0) {
    throw new NeurobagelRefusal("no_subjects", `${datasetId} has no subjects in any input`);
  }
  // What became of the table's rows: those in the graph, those left out, and the graph's
  // subjects with no row.
  const inGraph = new Set(graphIds);
  const joined =
    tableStatus === "ids_do_not_join" || !tableUsable
      ? 0
      : [...table.ids].filter((id) => inGraph.has(id)).length;
  const tableOnly = tableUsable ? table.ids.size - joined : 0;
  const indexWithoutRow = tableUsable ? graphIds.length - joined : 0;
  const phenotypeUsable = tableStatus === "ok";
  // Only the participants that are in the graph and have a row inform a column.
  const phenotypeIds = phenotypeUsable ? graphIds.filter((id) => table.rows.has(id)) : [];

  // 5. Column mapping, over the graph's participants only.
  const cellsOf = (column: number): string[] =>
    phenotypeIds.map((id) => table.rows.get(id)?.[column] ?? "");
  const columnIndex = {
    age: phenotypeUsable ? findColumn(table.header, "age") : -1,
    sex: phenotypeUsable ? findColumn(table.header, "sex") : -1,
    group: phenotypeUsable ? findColumn(table.header, "group") : -1,
  };
  const mechanicalAge: ColumnOutcome<AgeMapping> =
    columnIndex.age === -1
      ? { status: "absent" }
      : mapAgeColumn(
          table.header[columnIndex.age],
          cellsOf(columnIndex.age),
          ageUnitsIn(participantsJson.value, table.header[columnIndex.age]),
        );
  const mechanicalSex: ColumnOutcome<SexMapping> =
    columnIndex.sex === -1
      ? { status: "absent" }
      : mapSexColumn(table.header[columnIndex.sex], cellsOf(columnIndex.sex));
  const mechanicalGroup =
    columnIndex.group === -1
      ? ({ status: "absent" } as const)
      : mapGroupColumn(table.header[columnIndex.group], cellsOf(columnIndex.group));

  // 5b. A reviewed curation entry, if the caller has one for this dataset.
  // It replaces the mechanical rule for the variables it curates, applies only to the participants
  // of the graph, and is skipped whole when it does not fit the documents in hand.
  // An entry that is NOT applied still names variables, and some entries exist only to withdraw
  // what the mechanical rule would claim (a `Control` that is an intervention arm, not a healthy
  // control): for those variables the mechanical mapping is withheld too, so that an entry that
  // goes stale loses claims and never makes a false one.
  const curationEntry = input.curation ?? null;
  const refusal = curationEntry === null ? null : curationRefusal(curationEntry, datasetId);
  if (refusal !== null) throw new NeurobagelRefusal(refusal.code, refusal.message);
  const resolved =
    curationEntry === null
      ? null
      : await resolveCuration(
          curationEntry,
          { participantsTsv: input.participantsTsv, participantsJson: input.participantsJson },
          phenotypeUsable,
        );
  if (resolved?.flag) flags.add(resolved.flag);
  const applied: BoundCuration | null = resolved?.applied ?? null;
  const curationOutcome = resolved?.outcome ?? null;
  const namedByUnappliedEntry: ReadonlySet<CurationKind> = resolved?.namedByUnapplied ?? new Set();

  const curatedCounts = (
    column: number,
    mapped: (cell: string) => boolean,
    missing: readonly string[],
  ) => {
    const cells = cellsOf(column);
    const counts: ColumnCounts = {
      cells: cells.length,
      missing: cells.filter((c) => missing.includes(c)).length,
      unmappable: 0,
      mapped: cells.filter(mapped).length,
    };
    return counts;
  };

  // The variable's final outcome: the curated column where there is one, else the mechanical rule,
  // unless an entry that did not apply names the variable (then nothing is claimed for it).
  const withheldFor = (kind: CurationKind): boolean => namedByUnappliedEntry.has(kind);
  let ageColumn = columnIndex.age;
  let ageOutcome: ColumnOutcome<AgeMapping> = withheldFor("age")
    ? { status: "absent" }
    : mechanicalAge;
  if (applied?.age) {
    const { index, name, mapping } = applied.age;
    ageColumn = index;
    ageOutcome = {
      ...mapping,
      status: "mapped",
      column: name,
      counts: curatedCounts(index, (c) => mapping.ageOf(c) !== null, mapping.missingValues),
    };
  }
  let sexColumn = columnIndex.sex;
  let sexOutcome: ColumnOutcome<SexMapping> = withheldFor("sex")
    ? { status: "absent" }
    : mechanicalSex;
  if (applied?.sex) {
    const { index, name, mapping } = applied.sex;
    sexColumn = index;
    sexOutcome = {
      ...mapping,
      status: "mapped",
      column: name,
      counts: curatedCounts(index, (c) => mapping.levels.has(c), mapping.missingValues),
    };
  }

  // Every column about Diagnosis: the mechanical group column (unless a curated column is that
  // column, which replaces it) and the curated ones.
  const curatedDiagnoses = applied?.diagnoses ?? [];
  const curatedGroup = curatedDiagnoses.find((d) => d.index === columnIndex.group);
  const groupIsCurated = curatedGroup !== undefined;
  const diagnosisColumns: (DiagnosisColumn & { index: number; curated: boolean })[] = [];
  if (mechanicalGroup.status === "mapped" && !groupIsCurated && !withheldFor("diagnosis")) {
    diagnosisColumns.push({
      column: mechanicalGroup.column,
      curated: false,
      description: GROUP_DESCRIPTION,
      index: columnIndex.group,
      levels: new Map([...mechanicalGroup.levels].map((raw) => [raw, HEALTHY_CONTROL])),
      missingValues: mechanicalGroup.missingValues,
    });
  }
  for (const d of curatedDiagnoses) {
    diagnosisColumns.push({
      column: d.name,
      curated: true,
      description: CURATED_DIAGNOSIS_DESCRIPTION,
      index: d.index,
      levels: d.levels,
      missingValues: d.missingValues,
    });
  }
  diagnosisColumns.sort((a, b) => byCodeUnit(a.column, b.column));
  const assessmentColumns = [...(applied?.assessments ?? [])].sort((a, b) =>
    byCodeUnit(a.name, b.name),
  );

  /** What the mechanical rule found, or that it found something and an entry made it be withheld. */
  const mechanicalReport = (
    outcome: Parameters<typeof columnReport>[0],
    kind: CurationKind,
  ): ColumnReport =>
    withheldFor(kind) && outcome.status === "mapped"
      ? { status: "withheld", counts: { ...outcome.counts } }
      : columnReport(outcome);
  const ageReport: ColumnReport = applied?.age
    ? { status: "curated", counts: (ageOutcome as { counts: ColumnCounts }).counts }
    : mechanicalReport(mechanicalAge, "age");
  const sexReport: ColumnReport = applied?.sex
    ? { status: "curated", counts: (sexOutcome as { counts: ColumnCounts }).counts }
    : mechanicalReport(mechanicalSex, "sex");
  const groupReport: ColumnReport =
    curatedGroup === undefined
      ? mechanicalReport(mechanicalGroup, "diagnosis")
      : {
          status: "curated",
          counts: curatedCounts(
            columnIndex.group,
            (c) => curatedGroup.levels.has(c),
            curatedGroup.missingValues,
          ),
        };

  const dictionaryColumns = {
    participantColumn: PARTICIPANT_COLUMN,
    age: ageOutcome,
    sex: sexOutcome,
    diagnoses: diagnosisColumns,
    assessments: assessmentColumns.map((a) => ({
      column: a.name,
      tool: a.tool,
      missingValues: a.missingValues,
    })),
  };

  const withheld = {
    age: ageReport.status === "withheld" ? 1 : 0,
    diagnosis: groupReport.status === "withheld" ? 1 : 0,
    sex: sexReport.status === "withheld" ? 1 : 0,
  };
  if (withheld.age + withheld.diagnosis + withheld.sex > 0) flags.add("curation_withheld");
  if (ageReport.status === "needs_curation") flags.add("age_column_needs_curation");
  if (sexReport.status === "needs_curation") flags.add("sex_column_needs_curation");
  if (groupReport.status === "needs_curation") flags.add("group_column_needs_curation");
  if (ageOutcome.status === "mapped" && ageOutcome.unitsAssumed) {
    flags.add("age_units_assumed_years");
  }
  // `gender` is not `sex`: left alone and reported so a curator can see it exists, unless a
  // reviewed entry already says which column holds sex.
  const genderOnly =
    phenotypeUsable &&
    findColumn(table.header, "gender") !== -1 &&
    columnIndex.sex === -1 &&
    sexOutcome.status !== "mapped";
  if (genderOnly) flags.add("gender_column_needs_curation");

  const dataColumns = table.header
    .map((_, i) => i)
    .filter((i) => i !== table.idColumn)
    .map((i) => cellsOf(i));
  if (
    phenotypeIds.length > 0 &&
    dataColumns.length > 0 &&
    dataColumns.every((cells) => cells.every((c) => STANDARD_MISSING_VALUES.includes(c)))
  ) {
    flags.add("participants_tsv_placeholder");
  }

  // 6. Per-subject model.
  const mappedDatatypeSubjects = new Map<string, number>();
  const droppedDatatypeSubjects = new Map<string, number>();
  const pairingBasis = new Map<string, number>();
  const curatedWith = kindCounts();
  const subjects: SubjectModel[] = graphIds.map((label) => {
    const row = phenotypeUsable ? table.rows.get(label) : undefined;
    const phenotype: SubjectModel["phenotype"] = {
      age: null,
      sex: null,
      diagnoses: [],
      assessments: [],
    };
    if (row !== undefined) {
      if (ageOutcome.status === "mapped") phenotype.age = ageOutcome.ageOf(row[ageColumn]);
      if (sexOutcome.status === "mapped") {
        phenotype.sex = sexOutcome.levels.get(row[sexColumn]) ?? null;
      }
      const seen = new Set<string>();
      let curatedDiagnosis = false;
      for (const column of diagnosisColumns) {
        const t = column.levels.get(row[column.index]);
        if (t === undefined || seen.has(t.identifier)) continue;
        seen.add(t.identifier);
        phenotype.diagnoses.push(t);
        if (column.curated) curatedDiagnosis = true;
      }
      const tools = new Map<string, VocabTerm>();
      for (const column of assessmentColumns) {
        if (!column.missingValues.includes(row[column.index])) {
          tools.set(column.tool.identifier, column.tool);
        }
      }
      phenotype.assessments = [...tools.values()].sort((a, b) =>
        byCodeUnit(a.identifier, b.identifier),
      );
      if (applied?.age && phenotype.age !== null) curatedWith.age++;
      if (applied?.sex && phenotype.sex !== null) curatedWith.sex++;
      if (curatedDiagnosis) curatedWith.diagnosis++;
      if (phenotype.assessments.length > 0) curatedWith.assessment++;
    }

    const node = index[label];
    let imaging: SubjectModel["imaging"] = [];
    if (node !== undefined) {
      const datatypes = Object.keys(node.modalities);
      for (const d of datatypes) {
        if (modalityTermForDatatype(d) !== null) bump(mappedDatatypeSubjects, d);
        else bump(droppedDatatypeSubjects, REPORTABLE_DATATYPE.test(d) ? d : "other");
      }
      const placed = imagingSessionsFor({
        sessions: node.sessions,
        datatypes,
        sessionModalities: node.session_modalities,
      });
      imaging = placed.sessions;
      // A subject with nothing to place says nothing about how the index pairs sessions.
      if (placed.basis !== "none") bump(pairingBasis, placed.basis);
    }
    return { label, phenotype, imaging };
  });
  if (pairingBasis.get("unknown")) flags.add("session_pairing_unknown");
  if (pairingBasis.get("unreadable")) flags.add("session_modalities_unreadable");
  if (pairingBasis.get("inconsistent")) flags.add("session_modalities_inconsistent");
  if (mappedDatatypeSubjects.size === 0) flags.add("no_mapped_datatypes");

  // 7. The count the catalog description carries: what the dataset declares, else the
  // subjects of the graph, which is the index (or, with no index, the table).
  const declaredCount = metadata.demographics?.subjects_count ?? null;
  const declaredUsable = declaredCount !== null && declaredCount > 0;
  const participantCount = declaredUsable ? declaredCount : graphIds.length;
  const countSource = declaredUsable ? "demographics" : source;
  if (participantCount !== graphIds.length) flags.add("participant_count_disagrees");

  // 8. Build.
  const model: DatasetModel = {
    datasetId,
    name,
    authors,
    keywords,
    referencesAndLinks,
    repositoryUrl: `https://data.nemar.org/${datasetId}/`,
    accessInstructions,
    accessLink: pageUrl,
    subjects,
  };
  const graph = await buildJsonLd(model);
  const dictionary = buildDictionary(dictionaryColumns);
  const description = buildDatasetDescription({
    name,
    authors,
    keywords,
    referencesAndLinks,
    repositoryUrl: model.repositoryUrl,
    accessInstructions,
    accessLink: pageUrl,
    participantCount,
  });

  // The terms a reviewed entry adds are the only diagnosis and assessment terms beyond healthy
  // control that this dataset's output may carry.
  const curated = {
    diagnosis: curatedDiagnoses.flatMap((d) => [...d.levels.values()].map((t) => t.identifier)),
    assessment: assessmentColumns.map((a) => a.tool.identifier),
  };
  const problems = [
    ...validateGraphDocument(graph.document, curated).map((p) => `jsonld ${p}`),
    ...validateDictionary(dictionary, curated).map((p) => `dictionary ${p}`),
    ...validateDatasetDescription(description).map((p) => `dataset description ${p}`),
  ];
  if (problems.length > 0) {
    throw new NeurobagelRefusal(
      "output_invalid",
      `${datasetId}: the transform produced invalid output (a bug): ${problems.slice(0, 5).join("; ")}`,
    );
  }

  const report: NeurobagelReport = {
    columns: { age: ageReport, group: groupReport, sex: sexReport },
    ...(curationEntry === null || curationOutcome === null
      ? {}
      : {
          curation: curationReportFor(curationEntry, curationOutcome, curatedWith, withheld),
        }),
    dataset_id: datasetId,
    flags: [...flags].sort(byCodeUnit),
    graph: {
      acquisitions: graph.counts.acquisitions,
      imaging_sessions: graph.counts.imagingSessions,
      phenotypic_sessions: graph.counts.phenotypicSessions,
      subjects: graph.counts.subjects,
    },
    imaging: {
      datatypes_dropped_subjects: sortedRecord(droppedDatatypeSubjects),
      datatypes_mapped_subjects: sortedRecord(mappedDatatypeSubjects),
      mapped_datatypes_supported: [...MAPPED_DATATYPES],
      session_pairing_subjects: sortedRecord(pairingBasis),
    },
    participant_count: {
      bids_index: indexIds.length,
      declared: declaredCount,
      graph: graphIds.length,
      participants_tsv: table.ids.size,
      used: participantCount,
      used_from: countSource,
    },
    participants_json: { status: participantsJson.status },
    participants_tsv: {
      bom_stripped: table.bomStripped,
      conflicting_ids: table.conflicting,
      duplicate_ids: table.duplicates,
      ids_prefixed: table.prefixed,
      rows: table.rowCount,
      rows_without_id: table.rowsWithoutId,
      status: tableStatus,
    },
    report_version: 1,
    session_label_used_for_phenotype: UNNAMED_SESSION_LABEL,
    subjects: {
      graph: graphIds.length,
      index_without_row: indexWithoutRow,
      joined,
      source,
      table_only: tableOnly,
    },
    transform_version: NEUROBAGEL_TRANSFORM_VERSION,
    vocabulary: {
      bagel: VOCAB.bagel_version,
      communities_commit: VOCAB.pins.communities.commit,
    },
  };

  const names = artifactFileNames(datasetId);
  return {
    datasetId,
    files: {
      [names.jsonld]: canonicalJson(graph.document),
      [names.report]: canonicalJson(report),
      [names.dictionary]: canonicalJson(dictionary),
      [names.datasetDescription]: canonicalJson(description),
    },
    report,
  };
}
