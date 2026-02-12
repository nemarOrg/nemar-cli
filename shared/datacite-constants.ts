/**
 * Shared DataCite constants used by both backend and CLI.
 *
 * This file has ZERO dependencies so it can be imported from any context.
 */

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
] as const;

export type RelationType = (typeof VALID_RELATION_TYPES)[number];

const RELATION_TYPE_SET = new Set<string>(VALID_RELATION_TYPES);

export function isValidRelationType(value: string): value is RelationType {
  return RELATION_TYPE_SET.has(value);
}

/**
 * Canonical nemar_metadata.json schema (used by both CLI enrichment and backend DOI minting).
 */
export interface NemarMetadata {
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
