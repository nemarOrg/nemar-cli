/**
 * DataCite XML builder
 *
 * Generates DataCite kernel-4.6 XML metadata for NEMAR datasets.
 * Maps BIDS dataset_description.json fields to 19 of 20 DataCite properties
 * (RelatedItems excluded as it duplicates RelatedIdentifiers for our use case).
 *
 * Designed to produce maximally populated scholarly records, unlike
 * OpenNeuro/Zenodo which leave most optional fields empty.
 */

import {
  type NemarMetadata,
  type NemarMetadataV1,
  type NemarMetadataV2,
  type RelationType,
  VALID_RELATION_TYPES,
  isValidPipelineStage,
  isValidRelationType,
} from "../../../shared/datacite-constants.js";

export {
  type NemarMetadata,
  type NemarMetadataV1,
  type NemarMetadataV2,
  type RelationType,
  VALID_RELATION_TYPES,
  isValidRelationType,
};

// ---------------------------------------------------------------------------
// DataCite controlled vocabularies (kernel-4.6 schema)
// ---------------------------------------------------------------------------

/** DataCite kernel-4.6 resource type general values (complete set of 32). */
export type ResourceTypeGeneral =
  | "Audiovisual"
  | "Award"
  | "Book"
  | "BookChapter"
  | "Collection"
  | "ComputationalNotebook"
  | "ConferencePaper"
  | "ConferenceProceeding"
  | "DataPaper"
  | "Dataset"
  | "Dissertation"
  | "Event"
  | "Image"
  | "Instrument"
  | "InteractiveResource"
  | "Journal"
  | "JournalArticle"
  | "Model"
  | "OutputManagementPlan"
  | "PeerReview"
  | "PhysicalObject"
  | "Preprint"
  | "Project"
  | "Report"
  | "Service"
  | "Software"
  | "Sound"
  | "Standard"
  | "StudyRegistration"
  | "Text"
  | "Workflow"
  | "Other";

export type ContributorType =
  | "ContactPerson"
  | "DataCollector"
  | "DataCurator"
  | "DataManager"
  | "Distributor"
  | "Editor"
  | "HostingInstitution"
  | "Producer"
  | "ProjectLeader"
  | "ProjectManager"
  | "ProjectMember"
  | "RegistrationAgency"
  | "RegistrationAuthority"
  | "RelatedPerson"
  | "Researcher"
  | "ResearchGroup"
  | "RightsHolder"
  | "Sponsor"
  | "Supervisor"
  | "Translator"
  | "WorkPackageLeader"
  | "Other";

/** DataCite kernel-4.6 date types (complete set of 12, includes new Coverage). */
export type DateType =
  | "Accepted"
  | "Available"
  | "Collected"
  | "Copyrighted"
  | "Coverage"
  | "Created"
  | "Issued"
  | "Other"
  | "Submitted"
  | "Updated"
  | "Valid"
  | "Withdrawn";

// RelationType, VALID_RELATION_TYPES, and isValidRelationType are re-exported
// from shared/datacite-constants.ts above.

export type DescriptionType =
  | "Abstract"
  | "Methods"
  | "SeriesInformation"
  | "TableOfContents"
  | "TechnicalInfo"
  | "Other";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DataCiteCreator {
  name: string; // "Last, First" format
  nameType?: "Personal" | "Organizational";
  givenName?: string;
  familyName?: string;
  orcid?: string;
  affiliation?: string;
  ror?: string; // ROR identifier for affiliation
}

export interface DataCiteContributor {
  name: string;
  contributorType: ContributorType;
  nameType?: "Personal" | "Organizational";
  orcid?: string;
  affiliation?: string;
}

export interface DataCiteDate {
  date: string; // ISO 8601 date or range (YYYY-MM-DD or YYYY-MM-DD/YYYY-MM-DD)
  dateType: DateType;
  dateInformation?: string;
}

export interface DataCiteRelatedIdentifier {
  identifier: string;
  relatedIdentifierType:
    | "DOI"
    | "URL"
    | "ARK"
    | "arXiv"
    | "PMID"
    | "ISBN"
    | "ISSN"
    | "URN"
    | "Handle";
  relationType: RelationType;
  resourceTypeGeneral?: ResourceTypeGeneral;
}

export interface DataCiteRights {
  rights: string;
  rightsURI: string;
  rightsIdentifier?: string;
  rightsIdentifierScheme?: string;
}

export interface DataCiteDescription {
  description: string;
  descriptionType: DescriptionType;
}

export interface DataCiteFundingReference {
  funderName: string;
  funderIdentifier?: string;
  funderIdentifierType?: string;
  awardNumber?: string;
  awardTitle?: string;
  awardURI?: string;
}

export interface DataCiteSubject {
  value: string;
  subjectScheme?: string;
  schemeURI?: string;
  valueURI?: string;
  classificationCode?: string;
}

export interface DataCiteGeoLocation {
  place?: string;
  point?: { latitude: number; longitude: number };
}

export interface DataCiteMetadata {
  // Mandatory
  identifier: string; // DOI value without "doi:" prefix
  creators: DataCiteCreator[];
  titles: string[];
  publisher: string;
  publisherIdentifier?: string;
  publisherIdentifierScheme?: string;
  publicationYear: number;
  resourceTypeGeneral: ResourceTypeGeneral;
  resourceTypeSpecific?: string;

  // Recommended
  subjects?: DataCiteSubject[];
  contributors?: DataCiteContributor[];
  dates?: DataCiteDate[];
  relatedIdentifiers?: DataCiteRelatedIdentifier[];
  descriptions?: DataCiteDescription[];
  geoLocations?: DataCiteGeoLocation[];

  // Optional
  language?: string;
  alternateIdentifiers?: Array<{ identifier: string; type: string }>;
  sizes?: string[];
  formats?: string[];
  version?: string;
  rights?: DataCiteRights[];
  fundingReferences?: DataCiteFundingReference[];
}

/**
 * Extended metadata not available from BIDS, provided by user enrichment.
 */
export interface AuthorEnrichment {
  orcid?: string;
  affiliation?: string;
  ror?: string; // ROR identifier for the affiliation
}

export interface DataCiteEnrichment {
  /** Per-author metadata, keyed by author name as it appears in BIDS Authors. */
  authors?: Record<string, AuthorEnrichment>;
  keywords?: DataCiteSubject[];
  relatedDois?: Array<{
    doi: string;
    relationType?: RelationType;
    identifierType?: "DOI" | "URL" | "URN";
  }>;
  fundingInfo?: DataCiteFundingReference[];
  description?: string;
  methodsDescription?: string;
  collectionDates?: string; // ISO 8601 date range
  geoLocation?: string;
  sizes?: string[];
  formats?: string[];
  /** Uploader username; added as DataCurator contributor when not in BIDS Authors. */
  uploaderName?: string;
  /** Uploader ORCID; attached to contributor entry if present. */
  uploaderOrcid?: string;
}

// ---------------------------------------------------------------------------
// DOI / identifier normalization helpers
// ---------------------------------------------------------------------------

/**
 * Strip common DOI prefixes to get the bare DOI (e.g., "10.1234/foo").
 * Handles "doi:", "https://doi.org/", "http://dx.doi.org/" prefixes.
 */
export function normalizeDoi(id: string): string {
  return id.replace(/^(doi:|https?:\/\/(dx\.)?doi\.org\/)/i, "").trim();
}

/**
 * Detect the DataCite identifier type from the identifier string.
 */
export function detectIdentifierType(id: string): "DOI" | "URL" | "URN" {
  if (id.startsWith("http://") || id.startsWith("https://")) return "URL";
  if (id.startsWith("urn:")) return "URN";
  return "DOI";
}

/**
 * Build a normalized key for deduplicating related identifiers.
 * DOIs are normalized (prefix stripped); URLs are compared as-is.
 */
function normalizeIdentifierKey(identifier: string, relationType: string): string {
  // Always try normalizeDoi first -- handles both bare DOIs and doi.org URLs
  const stripped = normalizeDoi(identifier);
  const normalized = stripped !== identifier.trim() ? stripped : identifier;
  return `${normalized.toLowerCase()}|${relationType}`;
}

// ---------------------------------------------------------------------------
// NemarMetadata: canonical enrichment file format (nemar_metadata.json)
// ---------------------------------------------------------------------------

// NemarMetadata is re-exported from shared/datacite-constants.ts above.

/**
 * Parse raw JSON into a validated NemarMetadata object (v1.0 or v2.0).
 * Returns null for non-object input or unrecognized versions.
 * Ignores unknown fields; returns partial data for partially valid input.
 */
export function parseNemarMetadata(raw: unknown): NemarMetadata | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;

  const obj = raw as Record<string, unknown>;

  if (obj.version === "2.0") return parseNemarMetadataV2(obj);
  if (obj.version === "1.0" || obj.version === undefined) return parseNemarMetadataV1(obj);
  return null;
}

function parseNemarMetadataV1(obj: Record<string, unknown>): NemarMetadataV1 {
  const result: NemarMetadataV1 = { version: "1.0" };

  // Authors
  if (obj.authors && typeof obj.authors === "object" && !Array.isArray(obj.authors)) {
    const authors: Record<string, { orcid?: string; affiliation?: string }> = {};
    for (const [name, val] of Object.entries(obj.authors as Record<string, unknown>)) {
      if (val && typeof val === "object" && !Array.isArray(val)) {
        const entry = val as Record<string, unknown>;
        const parsed: { orcid?: string; affiliation?: string } = {};
        if (typeof entry.orcid === "string") parsed.orcid = entry.orcid;
        if (typeof entry.affiliation === "string") parsed.affiliation = entry.affiliation;
        if (parsed.orcid || parsed.affiliation) authors[name] = parsed;
      }
    }
    if (Object.keys(authors).length > 0) result.authors = authors;
  }

  // Keywords
  if (Array.isArray(obj.keywords)) {
    const kw = obj.keywords.filter((k): k is string => typeof k === "string");
    if (kw.length > 0) result.keywords = kw;
  }

  // Related DOIs (validate relationType at parse time)
  if (Array.isArray(obj.relatedDois)) {
    const rels = obj.relatedDois.filter((r): r is { doi: string; relationType: string } => {
      if (!r || typeof r !== "object") return false;
      const entry = r as Record<string, unknown>;
      return (
        typeof entry.doi === "string" &&
        typeof entry.relationType === "string" &&
        isValidRelationType(entry.relationType as string)
      );
    });
    if (rels.length > 0) result.relatedDois = rels;
  }

  // Funding references
  if (Array.isArray(obj.fundingReferences)) {
    const funds = obj.fundingReferences.filter(
      (f): f is { funderName: string; awardNumber?: string; awardTitle?: string } =>
        !!f &&
        typeof f === "object" &&
        typeof (f as Record<string, unknown>).funderName === "string",
    );
    if (funds.length > 0) result.fundingReferences = funds;
  }

  // Description
  if (typeof obj.description === "string" && obj.description) {
    result.description = obj.description;
  }

  // Methods description
  if (typeof obj.methodsDescription === "string" && obj.methodsDescription) {
    result.methodsDescription = obj.methodsDescription;
  }

  // Collection dates and geo location
  if (typeof obj.collectionDates === "string" && obj.collectionDates) {
    result.collectionDates = obj.collectionDates;
  }
  if (typeof obj.geoLocation === "string" && obj.geoLocation) {
    result.geoLocation = obj.geoLocation;
  }

  // Sizes
  if (Array.isArray(obj.sizes)) {
    const sizes = obj.sizes.filter((s): s is string => typeof s === "string");
    if (sizes.length > 0) result.sizes = sizes;
  }

  // Formats
  if (Array.isArray(obj.formats)) {
    const formats = obj.formats.filter((f): f is string => typeof f === "string");
    if (formats.length > 0) result.formats = formats;
  }

  return result;
}

function parseNemarMetadataV2(obj: Record<string, unknown>): NemarMetadataV2 {
  const result: NemarMetadataV2 = { version: "2.0" };

  // Pipeline stage
  if (typeof obj.pipeline_stage === "string" && isValidPipelineStage(obj.pipeline_stage)) {
    result.pipeline_stage = obj.pipeline_stage;
  }

  // Title
  if (typeof obj.title === "string" && obj.title) {
    result.title = obj.title;
  }

  // Description
  if (typeof obj.description === "string" && obj.description) {
    result.description = obj.description;
  }
  if (typeof obj.methods_description === "string" && obj.methods_description) {
    result.methods_description = obj.methods_description;
  }

  // License
  if (typeof obj.license === "string" && obj.license) {
    result.license = obj.license;
  }

  // Dataset type (raw/derivative)
  if (typeof obj.dataset_type === "string" && obj.dataset_type) {
    result.dataset_type = obj.dataset_type;
  }

  // Authors (keyed by display name, with optional ORCID and affiliations)
  if (obj.authors && typeof obj.authors === "object" && !Array.isArray(obj.authors)) {
    const authors: Record<
      string,
      {
        orcid?: string;
        affiliations?: Array<{ name: string; identifier?: string; scheme?: string }>;
      }
    > = {};
    for (const [name, val] of Object.entries(obj.authors as Record<string, unknown>)) {
      if (val && typeof val === "object" && !Array.isArray(val)) {
        const entry = val as Record<string, unknown>;
        const parsed: {
          orcid?: string;
          affiliations?: Array<{ name: string; identifier?: string; scheme?: string }>;
        } = {};
        if (typeof entry.orcid === "string") parsed.orcid = entry.orcid;
        if (Array.isArray(entry.affiliations)) {
          parsed.affiliations = entry.affiliations.filter(
            (a) =>
              !!a &&
              typeof a === "object" &&
              typeof (a as Record<string, unknown>).name === "string",
          );
        }
        authors[name] = parsed;
      }
    }
    if (Object.keys(authors).length > 0) result.authors = authors;
  }

  // Structured keywords
  if (Array.isArray(obj.keywords)) {
    result.keywords = obj.keywords.filter(
      (k): k is { term: string } =>
        !!k && typeof k === "object" && typeof (k as Record<string, unknown>).term === "string",
    );
  }

  // Related identifiers (full typed)
  if (Array.isArray(obj.related_identifiers)) {
    result.related_identifiers = obj.related_identifiers.filter((r) => {
      if (!r || typeof r !== "object") return false;
      const entry = r as Record<string, unknown>;
      return typeof entry.identifier === "string" && typeof entry.relation_type === "string";
    });
  }

  // Funding references
  if (Array.isArray(obj.funding_references)) {
    result.funding_references = obj.funding_references.filter(
      (f) =>
        !!f &&
        typeof f === "object" &&
        typeof (f as Record<string, unknown>).funder_name === "string",
    );
  }

  // Contributors
  if (Array.isArray(obj.contributors)) {
    result.contributors = obj.contributors.filter(
      (c) =>
        !!c && typeof c === "object" && typeof (c as Record<string, unknown>).name === "string",
    );
  }

  // Dates
  if (Array.isArray(obj.dates)) {
    result.dates = obj.dates.filter(
      (d) =>
        !!d && typeof d === "object" && typeof (d as Record<string, unknown>).date === "string",
    );
  }

  // Geo locations (require at least place or valid point)
  if (Array.isArray(obj.geo_locations)) {
    result.geo_locations = obj.geo_locations.filter((g) => {
      if (!g || typeof g !== "object") return false;
      const loc = g as Record<string, unknown>;
      const hasPlace = typeof loc.place === "string" && loc.place.length > 0;
      const hasPoint =
        loc.point &&
        typeof loc.point === "object" &&
        typeof (loc.point as Record<string, unknown>).latitude === "number" &&
        typeof (loc.point as Record<string, unknown>).longitude === "number";
      return hasPlace || hasPoint;
    });
  }

  // Resource types
  if (typeof obj.resource_type_general === "string" && obj.resource_type_general) {
    result.resource_type_general = obj.resource_type_general;
  }
  if (typeof obj.resource_type_specific === "string" && obj.resource_type_specific) {
    result.resource_type_specific = obj.resource_type_specific;
  }

  // Modalities (detected BIDS datatype directories)
  if (Array.isArray(obj.modalities)) {
    result.modalities = obj.modalities.filter((m): m is string => typeof m === "string");
  }

  // Sizes and formats
  if (Array.isArray(obj.sizes)) {
    result.sizes = obj.sizes.filter((s): s is string => typeof s === "string");
  }
  if (Array.isArray(obj.formats)) {
    result.formats = obj.formats.filter((f): f is string => typeof f === "string");
  }

  return result;
}

/**
 * Convert NemarMetadata (v1.0 or v2.0) to DataCiteEnrichment for use with bidsToDataCite.
 * Merges with an existing enrichment (e.g., from auto-ORCID injection).
 * Merge semantics: authors merged (NemarMetadata overrides per-key),
 * keywords merged and deduplicated, funding merged and deduplicated,
 * related DOIs merged and deduplicated by doi+relationType,
 * description/methods/sizes/formats overwritten by NemarMetadata.
 */
export function nemarMetadataToEnrichment(
  nemarMeta: NemarMetadata,
  base?: DataCiteEnrichment,
): DataCiteEnrichment {
  if (nemarMeta.version === "2.0") {
    return nemarMetadataV2ToEnrichment(nemarMeta, base);
  }
  return nemarMetadataV1ToEnrichment(nemarMeta, base);
}

function nemarMetadataV1ToEnrichment(
  nemarMeta: NemarMetadataV1,
  base?: DataCiteEnrichment,
): DataCiteEnrichment {
  const enrichment: DataCiteEnrichment = { ...base };

  // Authors: NemarMetadata authors override base
  if (nemarMeta.authors) {
    enrichment.authors = { ...enrichment.authors, ...nemarMeta.authors };
  }

  // Keywords: merge, deduplicate (V1 has plain strings, wrap as DataCiteSubject)
  if (nemarMeta.keywords) {
    const existing = enrichment.keywords || [];
    const seen = new Set(existing.map((s) => s.value));
    const merged = [...existing];
    for (const kw of nemarMeta.keywords) {
      if (!seen.has(kw)) {
        seen.add(kw);
        merged.push({ value: kw });
      }
    }
    enrichment.keywords = merged;
  }

  // Related DOIs: merge and deduplicate with normalization
  if (nemarMeta.relatedDois) {
    const existing = enrichment.relatedDois || [];
    const seen = new Set(existing.map((r) => normalizeIdentifierKey(r.doi, r.relationType || "")));
    const newRels = nemarMeta.relatedDois
      .filter((r) => isValidRelationType(r.relationType))
      .map((r) => ({
        doi: normalizeDoi(r.doi),
        relationType: r.relationType as RelationType,
        identifierType: detectIdentifierType(r.doi) as "DOI" | "URL" | "URN",
      }))
      .filter((r) => {
        const key = normalizeIdentifierKey(r.doi, r.relationType || "");
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    enrichment.relatedDois = [...existing, ...newRels];
  }

  // Funding: merge and deduplicate by funderName+awardNumber
  if (nemarMeta.fundingReferences) {
    const existing = enrichment.fundingInfo || [];
    const seen = new Set(existing.map((f) => `${f.funderName}|${f.awardNumber || ""}`));
    const newFunds = nemarMeta.fundingReferences
      .map((f) => ({
        funderName: f.funderName,
        awardNumber: f.awardNumber,
        awardTitle: f.awardTitle,
      }))
      .filter((f) => {
        const key = `${f.funderName}|${f.awardNumber || ""}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    enrichment.fundingInfo = [...existing, ...newFunds];
  }

  // Description
  if (nemarMeta.description) enrichment.description = nemarMeta.description;
  if (nemarMeta.methodsDescription) enrichment.methodsDescription = nemarMeta.methodsDescription;

  // Collection dates and geo location
  if (nemarMeta.collectionDates) enrichment.collectionDates = nemarMeta.collectionDates;
  if (nemarMeta.geoLocation) enrichment.geoLocation = nemarMeta.geoLocation;

  // Sizes and formats
  if (nemarMeta.sizes) enrichment.sizes = nemarMeta.sizes;
  if (nemarMeta.formats) enrichment.formats = nemarMeta.formats;

  return enrichment;
}

function nemarMetadataV2ToEnrichment(
  nemarMeta: NemarMetadataV2,
  base?: DataCiteEnrichment,
): DataCiteEnrichment {
  const enrichment: DataCiteEnrichment = { ...base };

  // Authors: convert v2 affiliations[] to v1 affiliation string
  if (nemarMeta.authors) {
    const baseAuthors = enrichment.authors || {};
    for (const [name, data] of Object.entries(nemarMeta.authors)) {
      baseAuthors[name] = {
        orcid: data.orcid || baseAuthors[name]?.orcid,
        affiliation: data.affiliations?.[0]?.name || baseAuthors[name]?.affiliation,
        ror: data.affiliations?.[0]?.identifier || baseAuthors[name]?.ror,
      };
    }
    enrichment.authors = baseAuthors;
  }

  // Keywords: preserve structured scheme info (MeSH etc.)
  if (nemarMeta.keywords) {
    const existing = enrichment.keywords || [];
    const seen = new Set(existing.map((s) => s.value));
    const merged = [...existing];
    for (const kw of nemarMeta.keywords) {
      if (!seen.has(kw.term)) {
        seen.add(kw.term);
        merged.push({
          value: kw.term,
          subjectScheme: kw.subject_scheme,
          schemeURI: kw.scheme_uri,
          valueURI: kw.value_uri,
          classificationCode: kw.classification_code,
        });
      }
    }
    enrichment.keywords = merged;
  }

  // Related identifiers: carry identifier_type, normalize DOIs
  if (nemarMeta.related_identifiers) {
    const existing = [...(enrichment.relatedDois || [])];
    const seen = new Set(existing.map((r) => normalizeIdentifierKey(r.doi, r.relationType || "")));
    for (const ri of nemarMeta.related_identifiers) {
      if (isValidRelationType(ri.relation_type)) {
        const idType =
          ri.identifier_type === "URL" || ri.identifier_type === "URN"
            ? ri.identifier_type
            : detectIdentifierType(ri.identifier);
        const normalized = idType === "DOI" ? normalizeDoi(ri.identifier) : ri.identifier;
        const key = normalizeIdentifierKey(normalized, ri.relation_type);
        if (!seen.has(key)) {
          seen.add(key);
          existing.push({
            doi: normalized,
            relationType: ri.relation_type as RelationType,
            identifierType: idType as "DOI" | "URL" | "URN",
          });
        }
      }
    }
    enrichment.relatedDois = existing;
  }

  // Funding references
  if (nemarMeta.funding_references) {
    const existing = [...(enrichment.fundingInfo || [])];
    const seen = new Set(existing.map((f) => `${f.funderName}|${f.awardNumber || ""}`));
    for (const fr of nemarMeta.funding_references) {
      const key = `${fr.funder_name}|${fr.award_number || ""}`;
      if (!seen.has(key)) {
        seen.add(key);
        existing.push({
          funderName: fr.funder_name,
          funderIdentifier: fr.funder_identifier,
          funderIdentifierType: fr.funder_identifier_type,
          awardNumber: fr.award_number,
          awardTitle: fr.award_title,
          awardURI: fr.award_uri,
        });
      }
    }
    enrichment.fundingInfo = existing;
  }

  // Description
  if (nemarMeta.description) enrichment.description = nemarMeta.description;
  if (nemarMeta.methods_description) enrichment.methodsDescription = nemarMeta.methods_description;

  // Dates -> collectionDates (take first Collected date)
  if (nemarMeta.dates) {
    const collected = nemarMeta.dates.find((d) => d.date_type === "Collected");
    if (collected) enrichment.collectionDates = collected.date;
  }

  // Geo locations -> geoLocation (take first place)
  if (nemarMeta.geo_locations && nemarMeta.geo_locations.length > 0) {
    enrichment.geoLocation = nemarMeta.geo_locations[0].place || undefined;
  }

  // Sizes and formats
  if (nemarMeta.sizes) enrichment.sizes = nemarMeta.sizes;
  if (nemarMeta.formats) enrichment.formats = nemarMeta.formats;

  return enrichment;
}

// ---------------------------------------------------------------------------
// XML building
// ---------------------------------------------------------------------------

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function buildCreatorXml(creator: DataCiteCreator): string {
  const nameType = creator.nameType || "Personal";
  let xml = "    <creator>\n";
  xml += `      <creatorName nameType="${nameType}">${escapeXml(creator.name)}</creatorName>\n`;

  if (creator.givenName) {
    xml += `      <givenName>${escapeXml(creator.givenName)}</givenName>\n`;
  }
  if (creator.familyName) {
    xml += `      <familyName>${escapeXml(creator.familyName)}</familyName>\n`;
  }
  if (creator.orcid) {
    xml += `      <nameIdentifier nameIdentifierScheme="ORCID" schemeURI="https://orcid.org">${escapeXml(creator.orcid)}</nameIdentifier>\n`;
  }
  if (creator.affiliation) {
    const rorAttr = creator.ror
      ? ` affiliationIdentifier="${escapeXml(creator.ror)}" affiliationIdentifierScheme="ROR"`
      : "";
    xml += `      <affiliation${rorAttr}>${escapeXml(creator.affiliation)}</affiliation>\n`;
  }

  xml += "    </creator>";
  return xml;
}

function buildContributorXml(contributor: DataCiteContributor): string {
  const nameType = contributor.nameType || "Personal";
  let xml = `    <contributor contributorType="${escapeXml(contributor.contributorType)}">\n`;
  xml += `      <contributorName nameType="${nameType}">${escapeXml(contributor.name)}</contributorName>\n`;
  if (contributor.orcid) {
    xml += `      <nameIdentifier nameIdentifierScheme="ORCID" schemeURI="https://orcid.org">${escapeXml(contributor.orcid)}</nameIdentifier>\n`;
  }
  if (contributor.affiliation) {
    xml += `      <affiliation>${escapeXml(contributor.affiliation)}</affiliation>\n`;
  }
  xml += "    </contributor>";
  return xml;
}

/**
 * Build a complete DataCite kernel-4 XML document from metadata.
 * Validates mandatory fields before generating XML.
 */
export function buildDataCiteXml(metadata: DataCiteMetadata): string {
  // Validate mandatory DataCite fields
  if (!metadata.identifier) {
    throw new Error("DataCite XML: identifier is required");
  }
  if (!metadata.creators || metadata.creators.length === 0) {
    throw new Error("DataCite XML: at least one creator is required");
  }
  if (!metadata.titles || metadata.titles.length === 0) {
    throw new Error("DataCite XML: at least one title is required");
  }
  if (!metadata.publisher) {
    throw new Error("DataCite XML: publisher is required");
  }
  if (!Number.isFinite(metadata.publicationYear)) {
    throw new Error("DataCite XML: publicationYear must be a valid number");
  }

  const lines: string[] = [];

  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push(
    '<resource xmlns="http://datacite.org/schema/kernel-4" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://datacite.org/schema/kernel-4 http://schema.datacite.org/meta/kernel-4/metadata.xsd">',
  );

  // 1. Identifier
  lines.push(`  <identifier identifierType="DOI">${escapeXml(metadata.identifier)}</identifier>`);

  // 2. Creators
  //
  // Issue #459: DataCite kernel-4 enforces `minLength=1` on `<creatorName>`.
  // A creator object with an empty / whitespace `name` would emit
  // `<creatorName/>` and trip EZID's XSD validation, taking the whole
  // identifier down. The validation at the top of this function already
  // requires at least one creator; the filter here just protects callers
  // who pre-populated `creators` and whose pipeline produced a junk entry.
  const validCreators = metadata.creators.filter(
    (c) => typeof c.name === "string" && c.name.trim().length > 0,
  );
  if (validCreators.length === 0) {
    throw new Error("DataCite XML: at least one creator with a non-empty name is required");
  }
  lines.push("  <creators>");
  for (const creator of validCreators) {
    lines.push(buildCreatorXml(creator));
  }
  lines.push("  </creators>");

  // 3. Titles
  lines.push("  <titles>");
  for (const title of metadata.titles) {
    lines.push(`    <title>${escapeXml(title)}</title>`);
  }
  lines.push("  </titles>");

  // 4. Publisher
  const pubAttrs: string[] = [];
  if (metadata.publisherIdentifier) {
    pubAttrs.push(`publisherIdentifier="${escapeXml(metadata.publisherIdentifier)}"`);
  }
  if (metadata.publisherIdentifierScheme) {
    pubAttrs.push(`publisherIdentifierScheme="${escapeXml(metadata.publisherIdentifierScheme)}"`);
  }
  const pubAttrStr = pubAttrs.length > 0 ? ` ${pubAttrs.join(" ")}` : "";
  lines.push(`  <publisher${pubAttrStr}>${escapeXml(metadata.publisher)}</publisher>`);

  // 5. PublicationYear
  lines.push(`  <publicationYear>${metadata.publicationYear}</publicationYear>`);

  // 6. Subjects
  if (metadata.subjects && metadata.subjects.length > 0) {
    lines.push("  <subjects>");
    for (const subject of metadata.subjects) {
      const attrs: string[] = [];
      if (subject.subjectScheme) {
        attrs.push(`subjectScheme="${escapeXml(subject.subjectScheme)}"`);
      }
      if (subject.schemeURI) {
        attrs.push(`schemeURI="${escapeXml(subject.schemeURI)}"`);
      }
      if (subject.valueURI) {
        attrs.push(`valueURI="${escapeXml(subject.valueURI)}"`);
      }
      if (subject.classificationCode) {
        attrs.push(`classificationCode="${escapeXml(subject.classificationCode)}"`);
      }
      const attrStr = attrs.length > 0 ? ` ${attrs.join(" ")}` : "";
      lines.push(`    <subject${attrStr}>${escapeXml(subject.value)}</subject>`);
    }
    lines.push("  </subjects>");
  }

  // 7. Contributors
  // Issue #459 defense: same `minLength=1` constraint on
  // `<contributorName>`; drop entries with an empty/whitespace name.
  if (metadata.contributors && metadata.contributors.length > 0) {
    const validContributors = metadata.contributors.filter(
      (c) => typeof c.name === "string" && c.name.trim().length > 0,
    );
    if (validContributors.length > 0) {
      lines.push("  <contributors>");
      for (const contributor of validContributors) {
        lines.push(buildContributorXml(contributor));
      }
      lines.push("  </contributors>");
    }
  }

  // 8. Dates
  if (metadata.dates && metadata.dates.length > 0) {
    lines.push("  <dates>");
    for (const date of metadata.dates) {
      const infoAttr = date.dateInformation
        ? ` dateInformation="${escapeXml(date.dateInformation)}"`
        : "";
      lines.push(
        `    <date dateType="${escapeXml(date.dateType)}"${infoAttr}>${escapeXml(date.date)}</date>`,
      );
    }
    lines.push("  </dates>");
  }

  // 9. Language
  if (metadata.language) {
    lines.push(`  <language>${escapeXml(metadata.language)}</language>`);
  }

  // 10. ResourceType
  const specificType = metadata.resourceTypeSpecific || metadata.resourceTypeGeneral;
  lines.push(
    `  <resourceType resourceTypeGeneral="${escapeXml(metadata.resourceTypeGeneral)}">${escapeXml(specificType)}</resourceType>`,
  );

  // 11. AlternateIdentifiers
  if (metadata.alternateIdentifiers && metadata.alternateIdentifiers.length > 0) {
    lines.push("  <alternateIdentifiers>");
    for (const alt of metadata.alternateIdentifiers) {
      lines.push(
        `    <alternateIdentifier alternateIdentifierType="${escapeXml(alt.type)}">${escapeXml(alt.identifier)}</alternateIdentifier>`,
      );
    }
    lines.push("  </alternateIdentifiers>");
  }

  // 12. RelatedIdentifiers
  if (metadata.relatedIdentifiers && metadata.relatedIdentifiers.length > 0) {
    lines.push("  <relatedIdentifiers>");
    for (const rel of metadata.relatedIdentifiers) {
      const rtgAttr = rel.resourceTypeGeneral
        ? ` resourceTypeGeneral="${escapeXml(rel.resourceTypeGeneral)}"`
        : "";
      lines.push(
        `    <relatedIdentifier relatedIdentifierType="${escapeXml(rel.relatedIdentifierType)}" relationType="${escapeXml(rel.relationType)}"${rtgAttr}>${escapeXml(rel.identifier)}</relatedIdentifier>`,
      );
    }
    lines.push("  </relatedIdentifiers>");
  }

  // 13. Sizes
  if (metadata.sizes && metadata.sizes.length > 0) {
    lines.push("  <sizes>");
    for (const size of metadata.sizes) {
      lines.push(`    <size>${escapeXml(size)}</size>`);
    }
    lines.push("  </sizes>");
  }

  // 14. Formats
  if (metadata.formats && metadata.formats.length > 0) {
    lines.push("  <formats>");
    for (const format of metadata.formats) {
      lines.push(`    <format>${escapeXml(format)}</format>`);
    }
    lines.push("  </formats>");
  }

  // 15. Version
  if (metadata.version) {
    lines.push(`  <version>${escapeXml(metadata.version)}</version>`);
  }

  // 16. Rights
  if (metadata.rights && metadata.rights.length > 0) {
    lines.push("  <rightsList>");
    for (const right of metadata.rights) {
      const attrs: string[] = [];
      attrs.push(`rightsURI="${escapeXml(right.rightsURI)}"`);
      if (right.rightsIdentifier) {
        attrs.push(`rightsIdentifier="${escapeXml(right.rightsIdentifier)}"`);
      }
      if (right.rightsIdentifierScheme) {
        attrs.push(`rightsIdentifierScheme="${escapeXml(right.rightsIdentifierScheme)}"`);
      }
      lines.push(`    <rights ${attrs.join(" ")}>${escapeXml(right.rights)}</rights>`);
    }
    lines.push("  </rightsList>");
  }

  // 17. Descriptions
  if (metadata.descriptions && metadata.descriptions.length > 0) {
    lines.push("  <descriptions>");
    for (const desc of metadata.descriptions) {
      lines.push(
        `    <description descriptionType="${escapeXml(desc.descriptionType)}">${escapeXml(desc.description)}</description>`,
      );
    }
    lines.push("  </descriptions>");
  }

  // 18. GeoLocations
  if (metadata.geoLocations && metadata.geoLocations.length > 0) {
    lines.push("  <geoLocations>");
    for (const loc of metadata.geoLocations) {
      lines.push("    <geoLocation>");
      if (loc.place) {
        lines.push(`      <geoLocationPlace>${escapeXml(loc.place)}</geoLocationPlace>`);
      }
      if (loc.point) {
        lines.push("      <geoLocationPoint>");
        lines.push(`        <pointLongitude>${loc.point.longitude}</pointLongitude>`);
        lines.push(`        <pointLatitude>${loc.point.latitude}</pointLatitude>`);
        lines.push("      </geoLocationPoint>");
      }
      lines.push("    </geoLocation>");
    }
    lines.push("  </geoLocations>");
  }

  // 19. FundingReferences
  //
  // Issue #459: the kernel-4 XSD enforces `minLength=1` on `<funderName>`,
  // so any entry whose normalized funderName is empty must be dropped
  // before emitting. BIDS `Funding` is free-form and has historically
  // included blank strings. Filter at the XML builder so a direct caller
  // (not via `bidsToDataCite`) can't bypass the source-side filter.
  if (metadata.fundingReferences && metadata.fundingReferences.length > 0) {
    const validFunders = metadata.fundingReferences.filter(
      (f) => typeof f.funderName === "string" && f.funderName.trim().length > 0,
    );
    if (validFunders.length > 0) {
      lines.push("  <fundingReferences>");
      for (const fund of validFunders) {
        lines.push("    <fundingReference>");
        lines.push(`      <funderName>${escapeXml(fund.funderName.trim())}</funderName>`);
        if (fund.funderIdentifier) {
          const typeAttr = fund.funderIdentifierType
            ? ` funderIdentifierType="${escapeXml(fund.funderIdentifierType)}"`
            : "";
          lines.push(
            `      <funderIdentifier${typeAttr}>${escapeXml(fund.funderIdentifier)}</funderIdentifier>`,
          );
        }
        if (typeof fund.awardNumber === "string" && fund.awardNumber.trim().length > 0) {
          const uriAttr = fund.awardURI ? ` awardURI="${escapeXml(fund.awardURI)}"` : "";
          lines.push(
            `      <awardNumber${uriAttr}>${escapeXml(fund.awardNumber.trim())}</awardNumber>`,
          );
        }
        if (typeof fund.awardTitle === "string" && fund.awardTitle.trim().length > 0) {
          lines.push(`      <awardTitle>${escapeXml(fund.awardTitle.trim())}</awardTitle>`);
        }
        lines.push("    </fundingReference>");
      }
      lines.push("  </fundingReferences>");
    }
  }

  // 20. RelatedItems - omitted for now; handled when needed via relatedIdentifiers

  lines.push("</resource>");

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// BIDS types and mapping
// ---------------------------------------------------------------------------

/** Fields from BIDS dataset_description.json used for DataCite mapping. */
export interface BidsDatasetDescription {
  Name?: string;
  Authors?: string[];
  License?: string;
  Version?: string;
  DatasetType?: string;
  BIDSVersion?: string;
  HowToAcknowledge?: string;
  ReferencesAndLinks?: string[];
  Funding?: string[];
  SourceDatasets?: Array<{
    DOI?: string;
    URL?: string;
    Version?: string;
  }>;
}

/**
 * Detect recording modalities from BIDS file paths.
 * Scans for datatype directories (eeg/, meg/, emg/, func/, ieeg/, etc.)
 * in the standard BIDS structure: sub-XX/[ses-XX/]datatype/.
 */
/** BIDS raw datatype directory names (the modality facets we surface). */
export const BIDS_DATATYPES = new Set([
  "eeg",
  "meg",
  "ieeg",
  "emg",
  "func",
  "anat",
  "dwi",
  "fmap",
  "perf",
  "pet",
  "micr",
  "nirs",
  "motion",
  "beh",
]);

/**
 * Top-level directories that hold non-raw data. A datatype-named folder inside
 * any of these is NOT a dataset modality: `sourcedata/emg/` is raw vendor
 * material, a `derivatives/fmriprep/sub-<id>/func/` folder is computed output,
 * `code/` is scripts. Counting them produced phantom modalities (#820: on002094
 * reported `emg` solely from `sourcedata/emg/`).
 */
const NON_RAW_TOP_DIRS = new Set(["derivatives", "sourcedata", "code"]);

/**
 * True when `parts[i]` is a BIDS datatype directory in valid raw position:
 * directly under a `sub-<label>` or `ses-<label>` segment, and not under a
 * non-raw top-level dir. This is the BIDS spec layout
 * `sub-<label>/[ses-<label>/]<datatype>/`, so it rejects both the false
 * positives above and stray matches like a subject literally named `sub-emg`
 * (the segment must equal the datatype exactly). Shared by the path-list and
 * the tree-walk detectors so they agree.
 */
export function isDatatypeInBidsPosition(parts: string[], i: number): boolean {
  if (!BIDS_DATATYPES.has(parts[i])) return false;
  if (NON_RAW_TOP_DIRS.has(parts[0])) return false;
  const parent = parts[i - 1];
  return parent !== undefined && (parent.startsWith("sub-") || parent.startsWith("ses-"));
}

/**
 * Detect dataset modalities from a list of file paths. Only counts a datatype
 * directory in valid raw BIDS position (see {@link isDatatypeInBidsPosition}),
 * so `sourcedata/`/`derivatives/`/`code/` folders don't create phantom
 * modalities (#820). Note: when `paths` comes from a truncated git tree the
 * raw `sub-*` paths may be missing entirely; callers that need
 * truncation-immune results use `getBidsTreeStats` (services/github/bids-tree.ts) instead.
 */
export function detectModalitiesFromTree(paths: string[]): string[] {
  const found = new Set<string>();
  for (const p of paths) {
    const parts = p.split("/");
    for (let i = 1; i < parts.length; i++) {
      if (isDatatypeInBidsPosition(parts, i)) found.add(parts[i]);
    }
  }
  return [...found];
}

/**
 * Parse a "Last, First" author string into structured name parts.
 */
export function parseAuthorName(author: string): {
  name: string;
  givenName?: string;
  familyName?: string;
} {
  const parts = author.split(",").map((s) => s.trim());
  if (parts.length >= 2) {
    return {
      name: author,
      familyName: parts[0],
      givenName: parts.slice(1).join(", "),
    };
  }
  // No comma; could be "First Last" or organizational name
  return { name: author };
}

/**
 * Map a BIDS license string to DataCite rights.
 */
export function mapLicense(license: string | undefined): DataCiteRights | null {
  if (!license) return null;

  const normalized = license.toUpperCase().replace(/\s+/g, "-").replace(/--+/g, "-");
  const licenseMap: Record<string, { rights: string; uri: string; spdx: string }> = {
    "CC-BY-4.0": {
      rights: "Creative Commons Attribution 4.0 International",
      uri: "https://creativecommons.org/licenses/by/4.0/",
      spdx: "CC-BY-4.0",
    },
    "CC-BY-NC-4.0": {
      rights: "Creative Commons Attribution-NonCommercial 4.0 International",
      uri: "https://creativecommons.org/licenses/by-nc/4.0/",
      spdx: "CC-BY-NC-4.0",
    },
    "CC-BY-SA-4.0": {
      rights: "Creative Commons Attribution-ShareAlike 4.0 International",
      uri: "https://creativecommons.org/licenses/by-sa/4.0/",
      spdx: "CC-BY-SA-4.0",
    },
    "CC-BY-NC-SA-4.0": {
      rights: "Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International",
      uri: "https://creativecommons.org/licenses/by-nc-sa/4.0/",
      spdx: "CC-BY-NC-SA-4.0",
    },
    "CC-BY-ND-4.0": {
      rights: "Creative Commons Attribution-NoDerivatives 4.0 International",
      uri: "https://creativecommons.org/licenses/by-nd/4.0/",
      spdx: "CC-BY-ND-4.0",
    },
    "CC-BY-NC-ND-4.0": {
      rights: "Creative Commons Attribution-NonCommercial-NoDerivatives 4.0 International",
      uri: "https://creativecommons.org/licenses/by-nc-nd/4.0/",
      spdx: "CC-BY-NC-ND-4.0",
    },
    "CC0-1.0": {
      rights: "CC0 1.0 Universal",
      uri: "https://creativecommons.org/publicdomain/zero/1.0/",
      spdx: "CC0-1.0",
    },
    CC0: {
      rights: "CC0 1.0 Universal",
      uri: "https://creativecommons.org/publicdomain/zero/1.0/",
      spdx: "CC0-1.0",
    },
    // Public domain aliases
    "PUBLIC-DOMAIN": {
      rights: "Public Domain",
      uri: "https://creativecommons.org/publicdomain/zero/1.0/",
      spdx: "CC0-1.0",
    },
    PD: {
      rights: "Public Domain",
      uri: "https://creativecommons.org/publicdomain/zero/1.0/",
      spdx: "CC0-1.0",
    },
    "PDDL-1.0": {
      rights: "Open Data Commons Public Domain Dedication and License",
      uri: "https://opendatacommons.org/licenses/pddl/1-0/",
      spdx: "PDDL-1.0",
    },
    PDDL: {
      rights: "Open Data Commons Public Domain Dedication and License",
      uri: "https://opendatacommons.org/licenses/pddl/1-0/",
      spdx: "PDDL-1.0",
    },
    "ODC-BY-1.0": {
      rights: "Open Data Commons Attribution License v1.0",
      uri: "https://opendatacommons.org/licenses/by/1.0/",
      spdx: "ODC-By-1.0",
    },
    "ODC-BY": {
      rights: "Open Data Commons Attribution License v1.0",
      uri: "https://opendatacommons.org/licenses/by/1.0/",
      spdx: "ODC-By-1.0",
    },
    "ODBL-1.0": {
      rights: "Open Data Commons Open Database License v1.0",
      uri: "https://opendatacommons.org/licenses/odbl/1.0/",
      spdx: "ODbL-1.0",
    },
    ODBL: {
      rights: "Open Data Commons Open Database License v1.0",
      uri: "https://opendatacommons.org/licenses/odbl/1.0/",
      spdx: "ODbL-1.0",
    },
  };

  const match = licenseMap[normalized];
  if (match) {
    return {
      rights: match.rights,
      rightsURI: match.uri,
      rightsIdentifier: match.spdx,
      rightsIdentifierScheme: "SPDX",
    };
  }

  // Unknown license; include as free text
  return { rights: license, rightsURI: "" };
}

/**
 * Map a recording modality to a DataCite resource type specific string.
 */
export function mapModalityToResourceType(modality: string | string[] | undefined): string {
  if (!modality) return "Dataset";

  const mod = Array.isArray(modality) ? modality[0] : modality;
  const map: Record<string, string> = {
    eeg: "EEG Dataset",
    meg: "MEG Dataset",
    ieeg: "iEEG Dataset",
    emg: "EMG Dataset",
    func: "fMRI Dataset",
    fmri: "fMRI Dataset",
    bold: "fMRI Dataset",
    anat: "Structural MRI Dataset",
    dwi: "Diffusion MRI Dataset",
    pet: "PET Dataset",
    nirs: "fNIRS Dataset",
    perf: "Perfusion MRI Dataset",
    motion: "Motion Dataset",
  };

  return map[mod.toLowerCase()] || "Neuroimaging Dataset";
}

/**
 * Convert BIDS dataset_description.json and optional enrichment data
 * into a full DataCiteMetadata object.
 *
 * Accepts either a typed BidsDatasetDescription or Record<string, unknown>
 * for flexibility with raw JSON.
 */
export function bidsToDataCite(
  datasetId: string,
  doi: string,
  bidsDescription: BidsDatasetDescription | Record<string, unknown>,
  enrichment?: DataCiteEnrichment,
  options?: { modalities?: string[] },
): DataCiteMetadata {
  // Safely coerce fields from potentially untyped input.
  //
  // Issue #459: DataCite kernel-4 enforces `minLength=1` on `<creatorName>`.
  // BIDS `Authors` is a free-form array; if any entry is empty or whitespace
  // it must be dropped before reaching the XML builder, otherwise EZID
  // rejects the document entirely.
  const rawAuthors = bidsDescription.Authors;
  const authorList: string[] = Array.isArray(rawAuthors)
    ? rawAuthors.filter((a): a is string => typeof a === "string" && a.trim().length > 0)
    : typeof rawAuthors === "string" && rawAuthors.trim().length > 0
      ? [rawAuthors]
      : [];

  // Parse creators from BIDS Authors
  const creators: DataCiteCreator[] = authorList.map((author) => {
    const parsed = parseAuthorName(author);
    const creator: DataCiteCreator = {
      name: parsed.name,
      givenName: parsed.givenName,
      familyName: parsed.familyName,
    };
    // Apply per-author enrichment
    const authorData = enrichment?.authors?.[author];
    if (authorData) {
      if (authorData.orcid) creator.orcid = authorData.orcid;
      if (authorData.affiliation) creator.affiliation = authorData.affiliation;
      if (authorData.ror) creator.ror = authorData.ror;
    }
    return creator;
  });

  // Ensure at least one creator
  if (creators.length === 0) {
    creators.push({ name: "(:unav)" });
  }

  // Titles
  const rawName = bidsDescription.Name;
  const title = (typeof rawName === "string" ? rawName : undefined) || datasetId;

  // License
  const rawLicense = bidsDescription.License;
  const licenseStr = typeof rawLicense === "string" ? rawLicense : undefined;
  const rights = mapLicense(licenseStr);

  // Version
  const rawVersion = bidsDescription.Version;
  const version = typeof rawVersion === "string" ? rawVersion : undefined;

  // Modality-specific resource type (from detected BIDS datatypes, not DatasetType)
  const modalities = options?.modalities;
  const resourceTypeSpecific = mapModalityToResourceType(modalities);

  // Dates
  const dates: DataCiteDate[] = [
    { date: new Date().toISOString().split("T")[0], dateType: "Issued" },
  ];
  if (enrichment?.collectionDates) {
    dates.push({ date: enrichment.collectionDates, dateType: "Collected" });
  }

  // Descriptions
  const descriptions: DataCiteDescription[] = [];
  if (enrichment?.description) {
    descriptions.push({ description: enrichment.description, descriptionType: "Abstract" });
  }
  const rawAck = bidsDescription.HowToAcknowledge;
  if (typeof rawAck === "string" && rawAck) {
    descriptions.push({ description: rawAck, descriptionType: "Other" });
  }

  // Related identifiers (with normalized deduplication)
  const relatedIdentifiers: DataCiteRelatedIdentifier[] = [];
  const seenIds = new Set<string>();

  // Helper to add a related identifier with dedup
  const addRelatedId = (
    identifier: string,
    idType: "DOI" | "URL" | "URN",
    relationType: RelationType,
  ) => {
    const normalizedId = idType === "DOI" ? normalizeDoi(identifier) : identifier;
    if (!normalizedId) return; // Skip empty identifiers
    const key = `${normalizedId.toLowerCase()}|${relationType}`;
    if (seenIds.has(key)) return;
    seenIds.add(key);
    relatedIdentifiers.push({
      identifier: normalizedId,
      relatedIdentifierType: idType,
      relationType,
    });
  };

  // From enrichment (metadata.json data)
  if (enrichment?.relatedDois) {
    for (const rel of enrichment.relatedDois) {
      const idType = rel.identifierType || detectIdentifierType(rel.doi);
      addRelatedId(rel.doi, idType, rel.relationType || "IsSupplementTo");
    }
  }

  // BIDS ReferencesAndLinks (DOIs and URLs)
  const rawRefs = bidsDescription.ReferencesAndLinks;
  const refs = Array.isArray(rawRefs)
    ? rawRefs.filter((r): r is string => typeof r === "string")
    : [];
  for (const ref of refs) {
    // Detect if this is a DOI URL (https://doi.org/10.xxx)
    const doiMatch = ref.match(/^https?:\/\/(dx\.)?doi\.org\/(10\.\d{4,}\/.+)$/i);
    if (doiMatch) {
      addRelatedId(doiMatch[2], "DOI", "References");
    } else if (ref.match(/^10\.\d{4,}/)) {
      addRelatedId(ref, "DOI", "References");
    } else if (ref.startsWith("https://") || ref.startsWith("http://")) {
      addRelatedId(ref, "URL", "References");
    }
  }

  // BIDS SourceDatasets -> IsDerivedFrom relations
  const rawSources = (bidsDescription as Record<string, unknown>).SourceDatasets;
  if (Array.isArray(rawSources)) {
    for (const source of rawSources) {
      if (!source || typeof source !== "object") continue;
      const s = source as Record<string, unknown>;
      if (typeof s.DOI === "string" && s.DOI) {
        addRelatedId(s.DOI, "DOI", "IsDerivedFrom");
      }
      if (typeof s.URL === "string" && s.URL) {
        // Skip URL if it's a doi.org URL (already handled via DOI field)
        const doiMatch = (s.URL as string).match(/^https?:\/\/(dx\.)?doi\.org\/(10\.\d{4,}\/.+)$/i);
        if (doiMatch) {
          addRelatedId(doiMatch[2], "DOI", "IsDerivedFrom");
        } else {
          addRelatedId(s.URL as string, "URL", "IsDerivedFrom");
        }
      }
    }
  }

  // Subjects/keywords (now structured with scheme info)
  const subjectValues = new Set<string>();
  const subjects: DataCiteSubject[] = [];
  if (enrichment?.keywords) {
    for (const kw of enrichment.keywords) {
      if (!subjectValues.has(kw.value)) {
        subjectValues.add(kw.value);
        subjects.push(kw);
      }
    }
  }
  // Add modality-based subjects from detected datatypes
  if (modalities && modalities.length > 0) {
    for (const mod of modalities) {
      const upper = mod.toUpperCase();
      if (!subjectValues.has(upper)) {
        subjectValues.add(upper);
        subjects.push({ value: upper });
      }
    }
  }
  if (!subjectValues.has("BIDS")) {
    subjects.push({ value: "BIDS" });
  }
  if (!subjectValues.has("neuroscience")) {
    subjects.push({ value: "neuroscience" });
  }

  // Contributors: NEMAR as hosting institution
  const contributors: DataCiteContributor[] = [
    {
      name: "NEMAR (Neuroelectromagnetic Data Archive and Tools Resource)",
      contributorType: "HostingInstitution",
      nameType: "Organizational",
    },
  ];

  // Add uploader as DataCurator if not already listed as an author.
  // uploaderName is a NEMAR username (not a formal name), so we use it as-is.
  // Issue #459 defense: only attach the contributor when the name is
  // non-empty; otherwise the XML builder would emit `<contributorName/>`
  // and EZID would reject the document.
  if (enrichment?.uploaderName && enrichment.uploaderName.trim().length > 0) {
    const trimmedUploaderName = enrichment.uploaderName.trim();
    const uploaderLower = trimmedUploaderName.toLowerCase();
    // Word-boundary match to avoid false positives (e.g., "li" matching "Elizabeth")
    const boundary = new RegExp(
      `\\b${uploaderLower.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
      "i",
    );
    const isAuthor = creators.some((c) => boundary.test(c.name));
    if (!isAuthor) {
      contributors.push({
        name: trimmedUploaderName,
        contributorType: "DataCurator",
        nameType: "Personal",
        ...(enrichment.uploaderOrcid && { orcid: enrichment.uploaderOrcid }),
      });
    }
  }

  // Alternate identifiers
  const alternateIdentifiers = [{ identifier: datasetId, type: "NEMAR" }];

  // Funding
  //
  // Issue #459: EZID's DataCite XML schema enforces `minLength=1` on
  // `<funderName>`. BIDS `Funding` is a free-form string array, so it is
  // legal upstream to record `[""]`, `["  "]`, or `["NIH", ""]`. Emitting
  // those verbatim produces `<funderName/>` and EZID rejects the entire
  // identifier. Filter out any entry whose trimmed funderName is empty
  // before it can reach the XML builder.
  const fundingReferences: DataCiteFundingReference[] = [];
  if (enrichment?.fundingInfo) {
    for (const f of enrichment.fundingInfo) {
      if (typeof f.funderName === "string" && f.funderName.trim().length > 0) {
        fundingReferences.push(f);
      }
    }
  } else {
    const rawFunding = bidsDescription.Funding;
    const funding = Array.isArray(rawFunding)
      ? rawFunding.filter((f): f is string => typeof f === "string" && f.trim().length > 0)
      : [];
    for (const f of funding) {
      fundingReferences.push({ funderName: f.trim() });
    }
  }

  // GeoLocations
  const geoLocations: DataCiteGeoLocation[] = [];
  if (enrichment?.geoLocation) {
    geoLocations.push({ place: enrichment.geoLocation });
  }

  return {
    identifier: doi,
    creators,
    titles: [title],
    publisher: "NEMAR (Neuroelectromagnetic Data Archive and Tools Resource)",
    publisherIdentifier: "https://ror.org/0168r3w48",
    publisherIdentifierScheme: "ROR",
    publicationYear: new Date().getFullYear(),
    resourceTypeGeneral: "Dataset",
    resourceTypeSpecific,
    subjects: subjects.length > 0 ? subjects : undefined,
    contributors,
    dates,
    relatedIdentifiers: relatedIdentifiers.length > 0 ? relatedIdentifiers : undefined,
    descriptions: descriptions.length > 0 ? descriptions : undefined,
    geoLocations: geoLocations.length > 0 ? geoLocations : undefined,
    language: "en",
    alternateIdentifiers,
    sizes: enrichment?.sizes,
    formats: enrichment?.formats,
    version,
    rights: rights ? [rights] : undefined,
    fundingReferences: fundingReferences.length > 0 ? fundingReferences : undefined,
  };
}
