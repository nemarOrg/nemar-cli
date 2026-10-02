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
 * Column descriptions are constants written here, never depositor text:
 * nothing a depositor wrote is copied into an artifact except the cell values
 * that become graph attributes.
 *
 * Pure: no I/O.
 */

import type { CanonicalJsonValue } from "./canonical-json";
import {
  type AgeMapping,
  type ColumnOutcome,
  type GroupMapping,
  HEALTHY_CONTROL,
  type SexMapping,
} from "./participants";
import { variableTerm } from "./vocab";

export interface DictionaryColumns {
  /** The participants.tsv column holding participant ids (always `participant_id`). */
  participantColumn: string;
  age: ColumnOutcome<AgeMapping>;
  sex: ColumnOutcome<SexMapping>;
  group: ColumnOutcome<GroupMapping>;
}

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
    const levels = [...sex.levels.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
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

  const group = columns.group;
  if (group.status === "mapped") {
    const levels = [...group.levels].sort();
    dictionary[group.column] = {
      Annotations: {
        IsAbout: term("Diagnosis"),
        Levels: Object.fromEntries(
          levels.map((raw) => [
            raw,
            { Label: HEALTHY_CONTROL.label, TermURL: HEALTHY_CONTROL.identifier },
          ]),
        ),
        MissingValues: group.missingValues,
        VariableType: "Categorical",
      },
      Description: "Participant group; only healthy control values are mapped to a diagnosis term.",
      Levels: Object.fromEntries(levels.map((raw) => [raw, HEALTHY_CONTROL.label])),
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
