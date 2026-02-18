/**
 * Shared DataCite constants used by both backend and CLI.
 *
 * This file has ZERO dependencies so it can be imported from any context.
 */

/** DataCite kernel-4.6 relation types (complete set of 38). */
export const VALID_RELATION_TYPES = [
  "IsCitedBy",
  "Cites",
  "IsSupplementTo",
  "IsSupplementedBy",
  "IsContinuedBy",
  "Continues",
  "IsDescribedBy",
  "Describes",
  "HasMetadata",
  "IsMetadataFor",
  "HasVersion",
  "IsVersionOf",
  "IsNewVersionOf",
  "IsPreviousVersionOf",
  "IsPartOf",
  "HasPart",
  "IsReferencedBy",
  "References",
  "IsDocumentedBy",
  "Documents",
  "IsCompiledBy",
  "Compiles",
  "IsVariantFormOf",
  "IsOriginalFormOf",
  "IsIdenticalTo",
  "IsCollectedBy",
  "Collects",
  "IsRequiredBy",
  "Requires",
  "IsObsoletedBy",
  "Obsoletes",
  "IsDerivedFrom",
  "IsSourceOf",
  "IsReviewedBy",
  "Reviews",
  "IsPublishedIn",
  "HasTranslation",
  "IsTranslationOf",
] as const;

export type RelationType = (typeof VALID_RELATION_TYPES)[number];

const RELATION_TYPE_SET = new Set<string>(VALID_RELATION_TYPES);

export function isValidRelationType(value: string): value is RelationType {
  return RELATION_TYPE_SET.has(value);
}

/**
 * v1.0 nemar_metadata.json schema (camelCase, legacy).
 * Stored at repo root as `nemar_metadata.json`.
 */
export interface NemarMetadataV1 {
  version: "1.0";
  description?: string;
  methodsDescription?: string;
  keywords?: string[];
  relatedDois?: Array<{ doi: string; relationType: string }>;
  authors?: Record<string, { orcid?: string; affiliation?: string }>;
  fundingReferences?: Array<{ funderName: string; awardNumber?: string; awardTitle?: string }>;
  collectionDates?: string;
  geoLocation?: string;
  sizes?: string[];
  formats?: string[];
}

// ---- Structured sub-types for v2.0 (aligned with neuroschema v0.3.0) ----

export interface StructuredKeyword {
  term: string;
  subject_scheme?: string;
  scheme_uri?: string;
  value_uri?: string;
  classification_code?: string;
}

export interface RelatedIdentifierEntry {
  identifier: string;
  identifier_type:
    | "DOI"
    | "URL"
    | "ARK"
    | "arXiv"
    | "PMID"
    | "ISBN"
    | "ISSN"
    | "URN"
    | "Handle"
    | "EAN13"
    | "EISSN"
    | "ISTC"
    | "LISSN"
    | "LSID"
    | "PURL"
    | "UPC"
    | "w3id"
    | "bibcode"
    | "IGSN"
    | "GND"
    | "RRID";
  relation_type: string;
  resource_type_general?: string;
}

export interface FundingReferenceEntry {
  funder_name: string;
  funder_identifier?: string;
  funder_identifier_type?: "Crossref Funder ID" | "GRID" | "ISNI" | "ROR" | "Other";
  award_number?: string;
  award_title?: string;
  award_uri?: string;
}

export interface ContributorEntry {
  name: string;
  name_type?: "Personal" | "Organizational";
  given_name?: string;
  family_name?: string;
  orcid?: string;
  contributor_type: string;
  affiliations?: Array<{ name: string; identifier?: string; scheme?: string }>;
}

export interface StructuredDate {
  date: string;
  date_type: string;
  date_information?: string;
}

export interface GeoLocationEntry {
  place?: string;
  point?: { latitude: number; longitude: number };
}

export interface AuthorEnrichmentV2 {
  orcid?: string;
  affiliations?: Array<{ name: string; identifier?: string; scheme?: string }>;
}

/**
 * v2.0 nemar_metadata.json schema (snake_case, aligned with neuroschema v0.3.0).
 * Stored at `.nemar/metadata.json`.
 */
export type PipelineStage = "seeded" | "enriched" | "validated";

const VALID_PIPELINE_STAGES = new Set<string>(["seeded", "enriched", "validated"]);

export function isValidPipelineStage(value: string): value is PipelineStage {
  return VALID_PIPELINE_STAGES.has(value);
}

export interface NemarMetadataV2 {
  version: "2.0";
  pipeline_stage?: PipelineStage;
  title?: string;
  description?: string;
  methods_description?: string;
  license?: string;
  dataset_type?: string;
  keywords?: StructuredKeyword[];
  related_identifiers?: RelatedIdentifierEntry[];
  authors?: Record<string, AuthorEnrichmentV2>;
  funding_references?: FundingReferenceEntry[];
  contributors?: ContributorEntry[];
  dates?: StructuredDate[];
  geo_locations?: GeoLocationEntry[];
  resource_type_general?: string;
  /** Modality-specific type, e.g. "EEG", "EMG", "fMRI" */
  resource_type_specific?: string;
  /** Detected BIDS datatype directories, e.g. ["eeg"], ["emg", "beh"] */
  modalities?: string[];
  sizes?: string[];
  formats?: string[];
}

/** Union of both versions. */
export type NemarMetadata = NemarMetadataV1 | NemarMetadataV2;
