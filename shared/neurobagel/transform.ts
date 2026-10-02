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
 *   - A fact the rules cannot establish is left out and counted, never guessed
 *     (see participants.ts). EMG is never mapped to EEG.
 *   - Output is byte-stable: same input, same bytes (canonical-json.ts), and
 *     identifiers are derived from names (identifiers.ts).
 *   - The output is validated before it is returned (validate-output.ts).
 *
 * Pure: no I/O, no network, no clock, no randomness.
 */

import { type CanonicalJsonValue, canonicalJson } from "./canonical-json";
import { type DictionaryColumns, buildDatasetDescription, buildDictionary } from "./dictionary";
import {
  type NemarMetadata,
  type NeurobagelInput,
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
  type ColumnOutcome,
  HEALTHY_CONTROL,
  mapAgeColumn,
  mapGroupColumn,
  mapSexColumn,
} from "./participants";
import { parseTsv } from "./tsv";
import {
  validateDatasetDescription,
  validateDictionary,
  validateGraphDocument,
} from "./validate-output";
import { NEUROBAGEL_TRANSFORM_VERSION } from "./version";
import { MAPPED_DATATYPES, VOCAB, modalityTermForDatatype } from "./vocab";

export type RefusalCode =
  | "anonymous_not_false"
  | "invalid_metadata"
  | "dataset_id_mismatch"
  | "no_subjects"
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

export interface TransformOptions {
  /** When set, the metadata's own dataset_id must equal it (guards against mixed-up documents). */
  expectedDatasetId?: string;
}

export interface NeurobagelArtifacts {
  datasetId: string;
  /** File name to file text, exactly the bytes to store. */
  files: Record<string, string>;
  /** The same four documents by role. */
  jsonld: string;
  dictionary: string;
  datasetDescription: string;
  report: string;
}

type TableStatus = "ok" | "absent" | "malformed" | "no_participant_id" | "ids_do_not_join";

const DOI_RE = /^10\.\d{4,9}\/\S+$/;
const PARTICIPANT_COLUMN = "participant_id";

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

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

function columnReport(outcome: ColumnOutcome<object>): CanonicalJsonValue {
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

function ageUnitsOf(participantsJson: Record<string, unknown> | null, column: string): unknown {
  if (participantsJson === null) return undefined;
  const entry = participantsJson[column];
  if (entry === null || typeof entry !== "object") return undefined;
  return (entry as Record<string, unknown>).Units;
}

/** `001` and `sub-001` name one subject; the graph and the bids index use the prefixed form. */
function normalizeParticipantId(raw: string): { id: string; prefixed: boolean } {
  return raw.startsWith("sub-")
    ? { id: raw, prefixed: false }
    : { id: `sub-${raw}`, prefixed: true };
}

export async function buildNeurobagelArtifacts(
  input: NeurobagelInput,
  options: TransformOptions = {},
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
  if (options.expectedDatasetId !== undefined && options.expectedDatasetId !== datasetId) {
    throw new NeurobagelRefusal(
      "dataset_id_mismatch",
      `expected ${options.expectedDatasetId} but metadata.json is for ${datasetId}`,
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

  // 3. The phenotype table.
  let tableStatus: TableStatus = "absent";
  let bomStripped = false;
  let header: string[] = [];
  const rowsById = new Map<string, string[]>();
  let rowCount = 0;
  let rowsWithoutId = 0;
  let duplicateIds = 0;
  let prefixedIds = 0;
  let idColumnIndex = -1;

  if (input.participantsTsv === null) {
    flags.add("participants_tsv_absent");
  } else {
    const parsed = parseTsv(input.participantsTsv);
    if (!parsed.ok) {
      tableStatus = "malformed";
      flags.add("participants_tsv_malformed");
    } else {
      bomStripped = parsed.bomStripped;
      if (bomStripped) flags.add("bom_stripped");
      header = parsed.table.header;
      idColumnIndex = header.indexOf(PARTICIPANT_COLUMN);
      if (idColumnIndex === -1) {
        tableStatus = "no_participant_id";
        flags.add("participants_tsv_no_participant_id");
      } else {
        tableStatus = "ok";
        rowCount = parsed.table.rows.length;
        for (const row of parsed.table.rows) {
          const raw = row[idColumnIndex];
          if (raw.trim() === "") {
            rowsWithoutId++;
            continue;
          }
          const { id, prefixed } = normalizeParticipantId(raw);
          if (rowsById.has(id)) {
            duplicateIds++;
            continue;
          }
          if (prefixed) prefixedIds++;
          rowsById.set(id, row);
        }
        if (prefixedIds > 0) flags.add("participant_ids_prefixed");
        if (duplicateIds > 0) flags.add("duplicate_participant_ids");
      }
    }
  }

  let participantsJson: Record<string, unknown> | null = null;
  let participantsJsonStatus: "present" | "absent" | "unreadable" = "absent";
  if (input.participantsJson === null) {
    flags.add("participants_json_absent");
  } else {
    const parsedJson = participantsJsonSchema.safeParse(input.participantsJson);
    if (parsedJson.success) {
      participantsJson = parsedJson.data;
      participantsJsonStatus = "present";
    } else {
      participantsJsonStatus = "unreadable";
      flags.add("participants_json_unreadable");
    }
  }

  // 4. Subjects: the bids index gives structure, the table gives phenotype.
  const index = metadata.extensions?.nemar?.bids_index?.subjects ?? {};
  const indexIds = Object.keys(index).sort(byCodeUnit);
  const tableIds = [...rowsById.keys()];
  const joined = tableIds.filter((id) => id in index).length;
  if (tableStatus === "ok" && indexIds.length > 0 && tableIds.length > 0 && joined === 0) {
    // Two id spaces with nothing in common: the table's phenotype cannot be attributed to
    // any subject that has data, and a union would double the dataset's subject count.
    tableStatus = "ids_do_not_join";
    flags.add("participant_ids_do_not_join_bids_index");
  }
  const phenotypeUsable = tableStatus === "ok";
  const usableIds = phenotypeUsable ? tableIds : [];
  const subjectIds = [...new Set([...usableIds, ...indexIds])].sort(byCodeUnit);
  if (subjectIds.length === 0) {
    throw new NeurobagelRefusal("no_subjects", `${datasetId} has no subjects in any input`);
  }

  // 5. Column mapping.
  const cellsOf = (column: number): string[] =>
    usableIds.map((id) => rowsById.get(id)?.[column] ?? "");
  const columnIndex = {
    age: phenotypeUsable ? findColumn(header, "age") : -1,
    sex: phenotypeUsable ? findColumn(header, "sex") : -1,
    group: phenotypeUsable ? findColumn(header, "group") : -1,
  };
  const outcomes: DictionaryColumns = {
    participantColumn: PARTICIPANT_COLUMN,
    age:
      columnIndex.age === -1
        ? { status: "absent" }
        : mapAgeColumn(
            header[columnIndex.age],
            cellsOf(columnIndex.age),
            ageUnitsOf(participantsJson, header[columnIndex.age]),
          ),
    sex:
      columnIndex.sex === -1
        ? { status: "absent" }
        : mapSexColumn(header[columnIndex.sex], cellsOf(columnIndex.sex)),
    group:
      columnIndex.group === -1
        ? { status: "absent" }
        : mapGroupColumn(header[columnIndex.group], cellsOf(columnIndex.group)),
  };
  for (const key of ["age", "sex", "group"] as const) {
    if (outcomes[key].status === "curation") flags.add(`${key}_column_needs_curation`);
  }
  if (outcomes.age.status === "mapped" && outcomes.age.unitsAssumed) {
    flags.add("age_units_assumed_years");
  }
  // `gender` is not `sex`: left alone and reported so a curator can see it exists.
  const genderOnly =
    phenotypeUsable && findColumn(header, "gender") !== -1 && columnIndex.sex === -1;
  if (genderOnly) flags.add("gender_column_needs_curation");

  const dataColumns = header
    .map((_, i) => i)
    .filter((i) => i !== idColumnIndex)
    .map((i) => cellsOf(i));
  if (
    phenotypeUsable &&
    dataColumns.length > 0 &&
    dataColumns.every((cells) => cells.every((c) => ["", "n/a", "N/A", "NA"].includes(c)))
  ) {
    flags.add("participants_tsv_placeholder");
  }

  // 6. Per-subject model.
  const mappedDatatypeSubjects = new Map<string, number>();
  const droppedDatatypeSubjects = new Map<string, number>();
  const pairingBasis = new Map<string, number>();
  const subjects: SubjectModel[] = subjectIds.map((label) => {
    const row = rowsById.get(label);
    const phenotype: SubjectModel["phenotype"] = { age: null, sex: null, diagnoses: [] };
    if (row !== undefined && phenotypeUsable) {
      if (outcomes.age.status === "mapped")
        phenotype.age = outcomes.age.ageOf(row[columnIndex.age]);
      if (outcomes.sex.status === "mapped") {
        phenotype.sex = outcomes.sex.levels.get(row[columnIndex.sex]) ?? null;
      }
      if (outcomes.group.status === "mapped" && outcomes.group.levels.has(row[columnIndex.group])) {
        phenotype.diagnoses = [HEALTHY_CONTROL];
      }
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

  // 7. Counts that reach the catalog description.
  const declaredCount = metadata.demographics?.subjects_count ?? null;
  const participantCount =
    declaredCount !== null && declaredCount > 0 ? declaredCount : subjectIds.length;
  const countSource =
    declaredCount !== null && declaredCount > 0
      ? "demographics"
      : indexIds.length > 0
        ? "bids_index"
        : "participants_tsv";
  if (participantCount !== subjectIds.length) flags.add("participant_count_disagrees");

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
  const dictionary = buildDictionary(outcomes);
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

  const problems = [
    ...validateGraphDocument(graph.document).map((p) => `jsonld ${p}`),
    ...validateDictionary(dictionary).map((p) => `dictionary ${p}`),
    ...validateDatasetDescription(description).map((p) => `dataset description ${p}`),
  ];
  if (problems.length > 0) {
    throw new NeurobagelRefusal(
      "output_invalid",
      `${datasetId}: the transform produced invalid output (a bug): ${problems.slice(0, 5).join("; ")}`,
    );
  }

  const report: CanonicalJsonValue = {
    columns: {
      age: columnReport(outcomes.age),
      group: columnReport(outcomes.group),
      sex: columnReport(outcomes.sex),
    },
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
      graph: subjectIds.length,
      participants_tsv: tableIds.length,
      used: participantCount,
      used_from: countSource,
    },
    participants_json: { status: participantsJsonStatus },
    participants_tsv: {
      bom_stripped: bomStripped,
      duplicate_ids: duplicateIds,
      ids_prefixed: prefixedIds,
      rows: rowCount,
      rows_without_id: rowsWithoutId,
      status: tableStatus,
    },
    report_version: 1,
    session_label_used_for_phenotype: UNNAMED_SESSION_LABEL,
    transform_version: NEUROBAGEL_TRANSFORM_VERSION,
    vocabulary: {
      bagel: VOCAB.bagel_version,
      communities_commit: VOCAB.pins.communities.commit,
    },
  };

  const jsonld = canonicalJson(graph.document);
  const dictionaryText = canonicalJson(dictionary);
  const descriptionText = canonicalJson(description);
  const reportText = canonicalJson(report);
  return {
    datasetId,
    datasetDescription: descriptionText,
    dictionary: dictionaryText,
    files: {
      [`${datasetId}.jsonld`]: jsonld,
      [`${datasetId}.report.json`]: reportText,
      [`${datasetId}_annotated.json`]: dictionaryText,
      [`${datasetId}_dataset_description.json`]: descriptionText,
    },
    jsonld,
    report: reportText,
  };
}
