/**
 * The Neurobagel data dictionary and dataset description this transform emits.
 *
 * Both are the exact input documents `bagel pheno` takes
 * (`--dictionary` and `--dataset-description`), which is what lets the real
 * Neurobagel CLI act as an oracle for the graph the transform builds:
 * `bagel pheno --pheno participants.tsv --dictionary <id>_annotated.json
 * --dataset-description <id>_dataset_description.json` must describe the same
 * phenotypes as the JSON-LD.
 * They are also the pair a Neurobagel node in catalog mode reads, named with
 * the suffixes its loader expects (`_annotated.json`, `_dataset_description.json`).
 *
 * Column descriptions are constants written here, never depositor text.
 * The only text a depositor wrote that reaches a dictionary is a raw CELL VALUE, in
 * two places: the keys of `Levels` (the spellings of male, female and control the
 * rules mapped) and the `MissingValues` entries for cells the rules could not map
 * (a stray `x` in an age column, a free-text sex).
 * `bagel pheno` needs those values spelled exactly, so they cannot be redacted; they
 * are values of the columns that become graph attributes, never a column name other
 * than the one annotated, an identity field or a description.
 * The dictionary is written to the private artifact store, not served.
 *
 * Pure: no I/O.
 */

import { type CanonicalJsonValue, byCodeUnit } from "./canonical-json";
import type { AgeMapping, ColumnOutcome, SexMapping } from "./participants";
import { type VocabTerm, variableTerm } from "./vocab";

/** A column whose values mean diagnoses: the mechanical group column, or a curated column. */
export interface DiagnosisColumn {
  column: string;
  /** Raw cell value to the diagnosis term it means. */
  levels: Map<string, VocabTerm>;
  missingValues: string[];
  description: string;
}

/** A column that is an item of an assessment tool (curated only). */
export interface AssessmentColumn {
  column: string;
  tool: VocabTerm;
  missingValues: string[];
}

export interface DictionaryColumns {
  /** The participants.tsv column holding participant ids (always `participant_id`). */
  participantColumn: string;
  age: ColumnOutcome<AgeMapping>;
  sex: ColumnOutcome<SexMapping>;
  /** Every column about Diagnosis; a participant's diagnoses are the terms of all of them. */
  diagnoses: DiagnosisColumn[];
  assessments: AssessmentColumn[];
}

/** The description of the mechanical group column: only healthy control is mapped. */
export const GROUP_DESCRIPTION =
  "Participant group; only healthy control values are mapped to a diagnosis term.";
/** The description of a diagnosis column a reviewed curation entry maps. */
export const CURATED_DIAGNOSIS_DESCRIPTION =
  "Participant group or diagnosis; values are mapped to diagnosis terms by a reviewed curation entry.";
const ASSESSMENT_DESCRIPTION =
  "Item of an assessment tool; only whether it was recorded is used, as mapped by a reviewed curation entry.";

const term = (id: string): CanonicalJsonValue => {
  const t = variableTerm(id);
  return { Label: t.label, TermURL: t.identifier };
};

/**
 * The data dictionary: one entry per annotated column.
 * Unannotated columns are left out; `bagel pheno` only requires that every
 * annotated column exists in the table.
 */
export function buildDictionary(columns: DictionaryColumns): Record<string, CanonicalJsonValue> {
  const dictionary: Record<string, CanonicalJsonValue> = {
    [columns.participantColumn]: {
      Annotations: { IsAbout: term("ParticipantID"), VariableType: "Identifier" },
      Description: "Participant identifier, as in participants.tsv.",
    },
  };

  const age = columns.age;
  if (age.status === "mapped") {
    dictionary[age.column] = {
      Annotations: {
        Format: { Label: age.formatTerm.label, TermURL: age.formatTerm.identifier },
        IsAbout: term("Age"),
        MissingValues: age.missingValues,
        ValueRange: { Max: age.valueRange.max, Min: age.valueRange.min },
        VariableType: "Continuous",
      },
      Description: "Age of the participant.",
      Units: "years",
    };
  }

  const sex = columns.sex;
  if (sex.status === "mapped") {
    const levels = [...sex.levels.entries()].sort(([a], [b]) => byCodeUnit(a, b));
    dictionary[sex.column] = {
      Annotations: {
        IsAbout: term("Sex"),
        Levels: Object.fromEntries(
          levels.map(([raw, t]) => [raw, { Label: t.label, TermURL: t.identifier }]),
        ),
        MissingValues: sex.missingValues,
        VariableType: "Categorical",
      },
      Description: "Sex of the participant.",
      Levels: Object.fromEntries(levels.map(([raw, t]) => [raw, t.label])),
    };
  }

  for (const diagnosis of columns.diagnoses) {
    const levels = [...diagnosis.levels.entries()].sort(([a], [b]) => byCodeUnit(a, b));
    dictionary[diagnosis.column] = {
      Annotations: {
        IsAbout: term("Diagnosis"),
        Levels: Object.fromEntries(
          levels.map(([raw, t]) => [raw, { Label: t.label, TermURL: t.identifier }]),
        ),
        MissingValues: diagnosis.missingValues,
        VariableType: "Categorical",
      },
      Description: diagnosis.description,
      Levels: Object.fromEntries(levels.map(([raw, t]) => [raw, t.label])),
    };
  }

  for (const assessment of columns.assessments) {
    dictionary[assessment.column] = {
      Annotations: {
        IsAbout: term("Assessment"),
        IsPartOf: { Label: assessment.tool.label, TermURL: assessment.tool.identifier },
        MissingValues: assessment.missingValues,
        VariableType: "Collection",
      },
      Description: ASSESSMENT_DESCRIPTION,
    };
  }
  return dictionary;
}

export interface DatasetDescriptionFields {
  name: string;
  authors: string[];
  keywords: string[];
  referencesAndLinks: string[];
  repositoryUrl: string;
  accessInstructions: string;
  accessLink: string;
  participantCount: number;
}

/**
 * The dataset description.
 * `AccessEmail` is never present: NEMAR does not hand a contact address to a
 * federation node.
 * `ParticipantCount` is read by a catalog-mode node and ignored by `bagel`.
 */
export function buildDatasetDescription(
  fields: DatasetDescriptionFields,
): Record<string, CanonicalJsonValue> {
  return {
    AccessInstructions: fields.accessInstructions,
    AccessLink: fields.accessLink,
    AccessType: "public",
    Authors: fields.authors,
    Keywords: fields.keywords,
    Name: fields.name,
    ParticipantCount: fields.participantCount,
    ReferencesAndLinks: fields.referencesAndLinks,
    RepositoryURL: fields.repositoryUrl,
  };
}
