/**
 * The transform checks its own output before returning it.
 *
 * Neurobagel's federation API does not catch a record a node returns that fails
 * its response model, so one malformed record can fail a federated query for
 * every user; the epic therefore treats an invalid artifact as a bug to stop
 * at the source rather than something a consumer will tolerate.
 * These checks mirror Neurobagel's pydantic models (`bagel.models`,
 * `bagel.dictionary_models`, `bagel.dataset_description_model`) strictly,
 * since the models forbid extra keys, and add the one check the models cannot
 * make: every controlled term must exist in the pinned vocabulary.
 * They are an independent second opinion to the JSON Schemas generated from the
 * real models and to the real `bagel`, both exercised by the tests; none of the
 * three replaces another.
 *
 * Pure: no I/O.
 */

import { z } from "zod";
import { type CanonicalJsonValue, byCodeUnit, canonicalJson } from "./canonical-json";
import { AGE_MAX_YEARS, AGE_MIN_YEARS } from "./participants";
import { MAPPED_DATATYPES, VOCAB } from "./vocab";

const UUID_IDENTIFIER = /^nb:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const identifier = z.string().regex(UUID_IDENTIFIER);

const sexIdentifiers = new Set(Object.values(VOCAB.sex).map((t) => t.identifier));
const modalityIdentifiers = new Set(
  MAPPED_DATATYPES.map((d) => VOCAB.imaging_modalities[d]?.identifier).filter(
    (i): i is string => i !== undefined,
  ),
);
const diagnosisIdentifiers = new Set([VOCAB.healthy_control.identifier]);
const ageFormatIdentifiers = new Set(Object.values(VOCAB.age_formats).map((t) => t.identifier));
const variableIdentifiers = new Set(Object.values(VOCAB.variables).map((t) => t.identifier));

/** A controlled-term node: only the identifier and the schema key, identifier from a pinned set. */
const termNode = (schemaKey: string, allowed: Set<string>) =>
  z
    .object({
      identifier: z.string().refine((v) => allowed.has(v), "term is not in the pinned vocabulary"),
      schemaKey: z.literal(schemaKey),
    })
    .strict();

const httpUrl = z.string().refine((value) => {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}, "not an http(s) URL");

const phenotypicSession = z
  .object({
    hasAge: z.number().min(AGE_MIN_YEARS).max(AGE_MAX_YEARS).optional(),
    hasDiagnosis: z.array(termNode("Diagnosis", diagnosisIdentifiers)).min(1).optional(),
    hasLabel: z.string().min(1),
    hasSex: termNode("Sex", sexIdentifiers).optional(),
    identifier,
    schemaKey: z.literal("PhenotypicSession"),
  })
  .strict();

const acquisition = z
  .object({
    hasContrastType: termNode("Image", modalityIdentifiers),
    identifier,
    schemaKey: z.literal("Acquisition"),
  })
  .strict();

const imagingSession = z
  .object({
    hasAcquisition: z.array(acquisition).min(1),
    hasLabel: z.string().min(1),
    identifier,
    schemaKey: z.literal("ImagingSession"),
  })
  .strict();

const subject = z
  .object({
    hasLabel: z.string().min(1),
    hasSession: z.array(z.union([phenotypicSession, imagingSession])).min(1),
    identifier,
    schemaKey: z.literal("Subject"),
  })
  .strict();

const dataset = z
  .object({
    "@context": z.record(z.string(), z.unknown()),
    hasAccessInstructions: z.string().min(1),
    hasAccessLink: httpUrl,
    hasAccessType: z.literal("public"),
    hasAuthors: z.array(z.string().min(1)).min(1).optional(),
    hasKeywords: z.array(z.string().min(1)).min(1).optional(),
    hasLabel: z.string().min(1),
    hasReferencesAndLinks: z.array(z.string().min(1)).min(1),
    hasRepositoryURL: httpUrl,
    hasSamples: z.array(subject).min(1),
    identifier,
    schemaKey: z.literal("Dataset"),
  })
  .strict();

function collectIdentifiers(node: unknown, into: string[]): void {
  if (Array.isArray(node)) {
    for (const item of node) collectIdentifiers(item, into);
  } else if (node !== null && typeof node === "object") {
    const record = node as Record<string, unknown>;
    // Only NODE identifiers must be unique: a term node (Sex, Diagnosis, Image) is a
    // reference to a vocabulary entry and legitimately repeats across the graph.
    const key = record.schemaKey;
    if (
      typeof record.identifier === "string" &&
      key !== "Sex" &&
      key !== "Diagnosis" &&
      key !== "Image"
    ) {
      into.push(record.identifier);
    }
    for (const value of Object.values(record)) collectIdentifiers(value, into);
  }
}

const issuesOf = (error: z.ZodError): string[] =>
  error.issues.slice(0, 20).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);

/** Problems with a graph-mode JSON-LD document (empty means valid). */
export function validateGraphDocument(document: CanonicalJsonValue): string[] {
  // Round-trip through the writer so JsonFloat becomes the number the file will hold.
  const parsed: unknown = JSON.parse(canonicalJson(document));
  const result = dataset.safeParse(parsed);
  if (!result.success) return issuesOf(result.error);

  const problems: string[] = [];
  if (
    JSON.stringify(sortKeys(result.data["@context"])) !== JSON.stringify(sortKeys(VOCAB.context))
  ) {
    problems.push("@context is not the pinned bagel context");
  }
  const ids: string[] = [];
  collectIdentifiers(result.data, ids);
  if (new Set(ids).size !== ids.length) problems.push("an identifier appears on two nodes");
  const labels = result.data.hasSamples.map((s) => s.hasLabel);
  if (new Set(labels).size !== labels.length) problems.push("two subjects share a label");
  return problems;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort(byCodeUnit)
        .map((k) => [k, sortKeys(record[k])]),
    );
  }
  return value;
}

const uniqueStrings = z
  .array(z.string())
  .refine((values) => new Set(values).size === values.length, "values are not unique");

const dictTerm = (allowed: Set<string>) =>
  z
    .object({
      Label: z.string(),
      TermURL: z.string().refine((v) => allowed.has(v), "term is not in the pinned vocabulary"),
    })
    .strict();

const identifierAnnotations = z
  .object({
    IsAbout: dictTerm(variableIdentifiers),
    VariableType: z.literal("Identifier"),
  })
  .strict();

const continuousAnnotations = z
  .object({
    Format: dictTerm(ageFormatIdentifiers),
    IsAbout: dictTerm(variableIdentifiers),
    MissingValues: uniqueStrings,
    ValueRange: z.object({ Max: z.number(), Min: z.number() }).strict().optional(),
    VariableType: z.literal("Continuous"),
  })
  .strict();

const categoricalAnnotations = (allowed: Set<string>) =>
  z
    .object({
      IsAbout: dictTerm(variableIdentifiers),
      Levels: z.record(z.string(), dictTerm(allowed)),
      MissingValues: uniqueStrings,
      VariableType: z.literal("Categorical"),
    })
    .strict();

const dictionaryColumn = z.union([
  z.object({ Annotations: identifierAnnotations, Description: z.string() }).strict(),
  z
    .object({
      Annotations: continuousAnnotations,
      Description: z.string(),
      Units: z.string(),
    })
    .strict(),
  z
    .object({
      Annotations: categoricalAnnotations(sexIdentifiers),
      Description: z.string(),
      Levels: z.record(z.string(), z.string()),
    })
    .strict(),
  z
    .object({
      Annotations: categoricalAnnotations(diagnosisIdentifiers),
      Description: z.string(),
      Levels: z.record(z.string(), z.string()),
    })
    .strict(),
]);

/** Problems with a data dictionary (empty means valid). */
export function validateDictionary(dictionary: CanonicalJsonValue): string[] {
  const parsed: unknown = JSON.parse(canonicalJson(dictionary));
  const result = z.record(z.string(), dictionaryColumn).safeParse(parsed);
  if (!result.success) return issuesOf(result.error);

  const problems: string[] = [];
  const entries = Object.entries(result.data);
  const about = (std: string) =>
    entries.filter(([, c]) => c.Annotations.IsAbout.TermURL === std).length;
  if (about("nb:ParticipantID") !== 1)
    problems.push("exactly one participant id column is required");
  for (const std of ["nb:Age", "nb:Sex"]) {
    if (about(std) > 1) problems.push(`more than one column about ${std}`);
  }
  for (const [name, column] of entries) {
    const a = column.Annotations;
    if ("Levels" in a) {
      // A level that is also a declared missing value would be read both ways.
      for (const level of Object.keys(a.Levels)) {
        if (a.MissingValues.includes(level))
          problems.push(`${name}: "${level}" is a level and a missing value`);
      }
      const bids = "Levels" in column ? Object.keys(column.Levels) : [];
      for (const level of bids) {
        if (!(level in a.Levels) && !a.MissingValues.includes(level)) {
          problems.push(`${name}: BIDS level "${level}" is not annotated`);
        }
      }
    }
  }
  return problems;
}

const datasetDescription = z
  .object({
    AccessInstructions: z.string().min(1),
    AccessLink: httpUrl,
    AccessType: z.literal("public"),
    Authors: z.array(z.string()),
    Keywords: z.array(z.string()),
    Name: z.string().trim().min(1),
    ParticipantCount: z.number().int().positive(),
    ReferencesAndLinks: z.array(z.string()).min(1),
    RepositoryURL: httpUrl,
  })
  .strict();

/** Problems with a dataset description (empty means valid). */
export function validateDatasetDescription(description: CanonicalJsonValue): string[] {
  const result = datasetDescription.safeParse(JSON.parse(canonicalJson(description)));
  return result.success ? [] : issuesOf(result.error);
}
