/**
 * Lookup in the full pinned diagnosis and assessment vocabularies.
 *
 * The two files (about 700 KB and 150 KB) are generated with the rest of the snapshot by
 * scripts/neurobagel/generate-vocab.ts and hold one `identifier: label` pair per term.
 * Only the curation loader needs them whole, so only the loader imports this module; the
 * transform never does.
 *
 * Maps, not objects: an identifier read from a reviewed file must never find a member of
 * `Object.prototype`.
 *
 * Pure: no I/O.
 */

import type { VocabTerm } from "./vocab";
import assessmentJson from "./vocab/assessment-terms.json";
import diagnosisJson from "./vocab/diagnosis-terms.json";

function termsOf(json: Record<string, string>): Map<string, string> {
  return new Map(Object.entries(json));
}

const DIAGNOSIS = termsOf(diagnosisJson as Record<string, string>);
const ASSESSMENT = termsOf(assessmentJson as Record<string, string>);

const lookup = (terms: Map<string, string>, identifier: string): VocabTerm | null => {
  const label = terms.get(identifier);
  return label === undefined ? null : { identifier, label };
};

/** The diagnosis term with this identifier in the pinned vocabulary, or null. */
export const diagnosisTerm = (identifier: string): VocabTerm | null =>
  lookup(DIAGNOSIS, identifier);

/** The assessment tool with this identifier in the pinned vocabulary, or null. */
export const assessmentTerm = (identifier: string): VocabTerm | null =>
  lookup(ASSESSMENT, identifier);
