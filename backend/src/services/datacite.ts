/**
 * DataCite XML builder
 *
 * Generates DataCite kernel-4 XML metadata for NEMAR datasets.
 * Maps BIDS dataset_description.json fields to all 20 DataCite properties.
 *
 * Designed to produce maximally populated scholarly records, unlike
 * OpenNeuro/Zenodo which leave most optional fields empty.
 */

// ---------------------------------------------------------------------------
// DataCite controlled vocabularies (kernel-4 schema)
// ---------------------------------------------------------------------------

export type ResourceTypeGeneral =
  | "Audiovisual" | "Book" | "BookChapter" | "Collection"
  | "ComputationalNotebook" | "ConferencePaper" | "ConferenceProceeding"
  | "DataPaper" | "Dataset" | "Dissertation" | "Event" | "Image"
  | "InteractiveResource" | "Journal" | "JournalArticle" | "Model"
  | "OutputManagementPlan" | "PeerReview" | "PhysicalObject" | "Preprint"
  | "Report" | "Service" | "Software" | "Sound" | "Standard" | "Text"
  | "Workflow" | "Other";

export type ContributorType =
  | "ContactPerson" | "DataCollector" | "DataCurator" | "DataManager"
  | "Distributor" | "Editor" | "HostingInstitution" | "Producer"
  | "ProjectLeader" | "ProjectManager" | "ProjectMember"
  | "RegistrationAgency" | "RegistrationAuthority" | "RelatedPerson"
  | "Researcher" | "ResearchGroup" | "RightsHolder" | "Sponsor"
  | "Supervisor" | "WorkPackageLeader" | "Other";

export type DateType =
  | "Accepted" | "Available" | "Collected" | "Copyrighted" | "Created"
  | "Issued" | "Other" | "Submitted" | "Updated" | "Valid" | "Withdrawn";

const VALID_RELATION_TYPES = [
  "IsCitedBy", "Cites", "IsSupplementTo", "IsSupplementedBy",
  "IsContinuedBy", "Continues", "IsDescribedBy", "Describes",
  "HasMetadata", "IsMetadataFor", "HasVersion", "IsVersionOf",
  "IsNewVersionOf", "IsPreviousVersionOf", "IsPartOf", "HasPart",
  "IsReferencedBy", "References", "IsDocumentedBy", "Documents",
  "IsCompiledBy", "Compiles", "IsVariantFormOf", "IsOriginalFormOf",
  "IsIdenticalTo", "IsCollectedBy", "Collects", "IsRequiredBy",
  "Requires", "IsObsoletedBy", "Obsoletes",
] as const;

export type RelationType = (typeof VALID_RELATION_TYPES)[number];

const RELATION_TYPE_SET = new Set<string>(VALID_RELATION_TYPES);

export function isValidRelationType(value: string): value is RelationType {
  return RELATION_TYPE_SET.has(value);
}

export type DescriptionType =
  | "Abstract" | "Methods" | "SeriesInformation" | "TableOfContents"
  | "TechnicalInfo" | "Other";

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
  affiliation?: string;
}

export interface DataCiteDate {
  date: string; // ISO 8601 date or range (YYYY-MM-DD or YYYY-MM-DD/YYYY-MM-DD)
  dateType: DateType;
}

export interface DataCiteRelatedIdentifier {
  identifier: string;
  relatedIdentifierType: "DOI" | "URL" | "ARK" | "arXiv" | "PMID";
  relationType: RelationType;
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
}

export interface DataCiteMetadata {
  // Mandatory
  identifier: string; // DOI value without "doi:" prefix
  creators: DataCiteCreator[];
  titles: string[];
  publisher: string;
  publicationYear: number;
  resourceTypeGeneral: ResourceTypeGeneral;
  resourceTypeSpecific?: string;

  // Recommended
  subjects?: string[];
  contributors?: DataCiteContributor[];
  dates?: DataCiteDate[];
  relatedIdentifiers?: DataCiteRelatedIdentifier[];
  descriptions?: DataCiteDescription[];
  geoLocations?: string[];

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
  keywords?: string[];
  relatedDois?: Array<{ doi: string; relationType?: RelationType }>;
  fundingInfo?: DataCiteFundingReference[];
  description?: string;
  methodsDescription?: string;
  collectionDates?: string; // ISO 8601 date range
  geoLocation?: string;
  sizes?: string[];
  formats?: string[];
}

// ---------------------------------------------------------------------------
// NemarMetadata: canonical enrichment file format (nemar_metadata.json)
// ---------------------------------------------------------------------------

/**
 * Schema for nemar_metadata.json, the canonical enrichment file
 * stored in each dataset repo alongside dataset_description.json.
 */
export interface NemarMetadata {
  version: "1.0";
  authors?: Record<string, { orcid?: string; affiliation?: string }>;
  keywords?: string[];
  relatedDois?: Array<{ doi: string; relationType: string }>;
  fundingReferences?: Array<{
    funderName: string;
    awardNumber?: string;
    awardTitle?: string;
  }>;
  description?: string;
  methodsDescription?: string;
  sizes?: string[];
  formats?: string[];
}

/**
 * Parse raw JSON into a validated NemarMetadata object.
 * Returns null for non-object input or unrecognized versions.
 * Ignores unknown fields; returns partial data for partially valid input.
 */
export function parseNemarMetadata(raw: unknown): NemarMetadata | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;

  const obj = raw as Record<string, unknown>;

  // Reject unrecognized versions (future-proofing)
  if (obj.version !== undefined && obj.version !== "1.0") return null;

  const result: NemarMetadata = { version: "1.0" };

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
    const rels = obj.relatedDois.filter(
      (r): r is { doi: string; relationType: string } => {
        if (!r || typeof r !== "object") return false;
        const entry = r as Record<string, unknown>;
        return (
          typeof entry.doi === "string" &&
          typeof entry.relationType === "string" &&
          isValidRelationType(entry.relationType as string)
        );
      },
    );
    if (rels.length > 0) result.relatedDois = rels;
  }

  // Funding references
  if (Array.isArray(obj.fundingReferences)) {
    const funds = obj.fundingReferences.filter(
      (f): f is { funderName: string; awardNumber?: string; awardTitle?: string } =>
        !!f && typeof f === "object" && typeof (f as Record<string, unknown>).funderName === "string",
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

/**
 * Convert NemarMetadata to DataCiteEnrichment for use with bidsToDataCite.
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
  const enrichment: DataCiteEnrichment = { ...base };

  // Authors: NemarMetadata authors override base
  if (nemarMeta.authors) {
    enrichment.authors = { ...enrichment.authors, ...nemarMeta.authors };
  }

  // Keywords: merge, deduplicate
  if (nemarMeta.keywords) {
    const existing = enrichment.keywords || [];
    const merged = [...existing];
    for (const kw of nemarMeta.keywords) {
      if (!merged.includes(kw)) merged.push(kw);
    }
    enrichment.keywords = merged;
  }

  // Related DOIs: merge and deduplicate by doi+relationType
  if (nemarMeta.relatedDois) {
    const existing = enrichment.relatedDois || [];
    const seen = new Set(existing.map((r) => `${r.doi}|${r.relationType}`));
    const newRels = nemarMeta.relatedDois
      .filter((r) => isValidRelationType(r.relationType))
      .map((r) => ({
        doi: r.doi,
        relationType: r.relationType as RelationType,
      }))
      .filter((r) => {
        const key = `${r.doi}|${r.relationType}`;
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
  let xml = `    <creator>\n`;
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

  xml += `    </creator>`;
  return xml;
}

function buildContributorXml(contributor: DataCiteContributor): string {
  const nameType = contributor.nameType || "Personal";
  let xml = `    <contributor contributorType="${escapeXml(contributor.contributorType)}">\n`;
  xml += `      <contributorName nameType="${nameType}">${escapeXml(contributor.name)}</contributorName>\n`;
  if (contributor.affiliation) {
    xml += `      <affiliation>${escapeXml(contributor.affiliation)}</affiliation>\n`;
  }
  xml += `    </contributor>`;
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
  lines.push('<resource xmlns="http://datacite.org/schema/kernel-4" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://datacite.org/schema/kernel-4 http://schema.datacite.org/meta/kernel-4/metadata.xsd">');

  // 1. Identifier
  lines.push(`  <identifier identifierType="DOI">${escapeXml(metadata.identifier)}</identifier>`);

  // 2. Creators
  lines.push("  <creators>");
  for (const creator of metadata.creators) {
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
  lines.push(`  <publisher>${escapeXml(metadata.publisher)}</publisher>`);

  // 5. PublicationYear
  lines.push(`  <publicationYear>${metadata.publicationYear}</publicationYear>`);

  // 6. Subjects
  if (metadata.subjects && metadata.subjects.length > 0) {
    lines.push("  <subjects>");
    for (const subject of metadata.subjects) {
      lines.push(`    <subject subjectScheme="keyword">${escapeXml(subject)}</subject>`);
    }
    lines.push("  </subjects>");
  }

  // 7. Contributors
  if (metadata.contributors && metadata.contributors.length > 0) {
    lines.push("  <contributors>");
    for (const contributor of metadata.contributors) {
      lines.push(buildContributorXml(contributor));
    }
    lines.push("  </contributors>");
  }

  // 8. Dates
  if (metadata.dates && metadata.dates.length > 0) {
    lines.push("  <dates>");
    for (const date of metadata.dates) {
      lines.push(`    <date dateType="${escapeXml(date.dateType)}">${escapeXml(date.date)}</date>`);
    }
    lines.push("  </dates>");
  }

  // 9. Language
  if (metadata.language) {
    lines.push(`  <language>${escapeXml(metadata.language)}</language>`);
  }

  // 10. ResourceType
  const specificType = metadata.resourceTypeSpecific || metadata.resourceTypeGeneral;
  lines.push(`  <resourceType resourceTypeGeneral="${escapeXml(metadata.resourceTypeGeneral)}">${escapeXml(specificType)}</resourceType>`);

  // 11. AlternateIdentifiers
  if (metadata.alternateIdentifiers && metadata.alternateIdentifiers.length > 0) {
    lines.push("  <alternateIdentifiers>");
    for (const alt of metadata.alternateIdentifiers) {
      lines.push(`    <alternateIdentifier alternateIdentifierType="${escapeXml(alt.type)}">${escapeXml(alt.identifier)}</alternateIdentifier>`);
    }
    lines.push("  </alternateIdentifiers>");
  }

  // 12. RelatedIdentifiers
  if (metadata.relatedIdentifiers && metadata.relatedIdentifiers.length > 0) {
    lines.push("  <relatedIdentifiers>");
    for (const rel of metadata.relatedIdentifiers) {
      lines.push(`    <relatedIdentifier relatedIdentifierType="${escapeXml(rel.relatedIdentifierType)}" relationType="${escapeXml(rel.relationType)}">${escapeXml(rel.identifier)}</relatedIdentifier>`);
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
      lines.push(`    <description descriptionType="${escapeXml(desc.descriptionType)}">${escapeXml(desc.description)}</description>`);
    }
    lines.push("  </descriptions>");
  }

  // 18. GeoLocations
  if (metadata.geoLocations && metadata.geoLocations.length > 0) {
    lines.push("  <geoLocations>");
    for (const loc of metadata.geoLocations) {
      lines.push(`    <geoLocation>`);
      lines.push(`      <geoLocationPlace>${escapeXml(loc)}</geoLocationPlace>`);
      lines.push(`    </geoLocation>`);
    }
    lines.push("  </geoLocations>");
  }

  // 19. FundingReferences
  if (metadata.fundingReferences && metadata.fundingReferences.length > 0) {
    lines.push("  <fundingReferences>");
    for (const fund of metadata.fundingReferences) {
      lines.push("    <fundingReference>");
      lines.push(`      <funderName>${escapeXml(fund.funderName)}</funderName>`);
      if (fund.funderIdentifier) {
        const typeAttr = fund.funderIdentifierType
          ? ` funderIdentifierType="${escapeXml(fund.funderIdentifierType)}"`
          : "";
        lines.push(`      <funderIdentifier${typeAttr}>${escapeXml(fund.funderIdentifier)}</funderIdentifier>`);
      }
      if (fund.awardNumber) {
        lines.push(`      <awardNumber>${escapeXml(fund.awardNumber)}</awardNumber>`);
      }
      if (fund.awardTitle) {
        lines.push(`      <awardTitle>${escapeXml(fund.awardTitle)}</awardTitle>`);
      }
      lines.push("    </fundingReference>");
    }
    lines.push("  </fundingReferences>");
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
}

/**
 * Parse a "Last, First" author string into structured name parts.
 */
export function parseAuthorName(author: string): { name: string; givenName?: string; familyName?: string } {
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
    "CC-BY-4.0": { rights: "Creative Commons Attribution 4.0 International", uri: "https://creativecommons.org/licenses/by/4.0/", spdx: "CC-BY-4.0" },
    "CC-BY-NC-4.0": { rights: "Creative Commons Attribution-NonCommercial 4.0 International", uri: "https://creativecommons.org/licenses/by-nc/4.0/", spdx: "CC-BY-NC-4.0" },
    "CC-BY-SA-4.0": { rights: "Creative Commons Attribution-ShareAlike 4.0 International", uri: "https://creativecommons.org/licenses/by-sa/4.0/", spdx: "CC-BY-SA-4.0" },
    "CC-BY-NC-SA-4.0": { rights: "Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International", uri: "https://creativecommons.org/licenses/by-nc-sa/4.0/", spdx: "CC-BY-NC-SA-4.0" },
    "CC0-1.0": { rights: "CC0 1.0 Universal", uri: "https://creativecommons.org/publicdomain/zero/1.0/", spdx: "CC0-1.0" },
    CC0: { rights: "CC0 1.0 Universal", uri: "https://creativecommons.org/publicdomain/zero/1.0/", spdx: "CC0-1.0" },
    "PDDL-1.0": { rights: "Open Data Commons Public Domain Dedication and License", uri: "https://opendatacommons.org/licenses/pddl/1-0/", spdx: "PDDL-1.0" },
    PDDL: { rights: "Open Data Commons Public Domain Dedication and License", uri: "https://opendatacommons.org/licenses/pddl/1-0/", spdx: "PDDL-1.0" },
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
    fmri: "fMRI Dataset",
    bold: "fMRI Dataset",
    nirs: "fNIRS Dataset",
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
): DataCiteMetadata {
  // Safely coerce fields from potentially untyped input
  const rawAuthors = bidsDescription.Authors;
  const authorList: string[] = Array.isArray(rawAuthors)
    ? rawAuthors.filter((a): a is string => typeof a === "string")
    : typeof rawAuthors === "string"
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

  // Modality-specific resource type
  const rawModality = bidsDescription.DatasetType;
  const modality = typeof rawModality === "string" ? rawModality : undefined;
  const resourceTypeSpecific = mapModalityToResourceType(modality);

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
  if (enrichment?.methodsDescription) {
    descriptions.push({ description: enrichment.methodsDescription, descriptionType: "Methods" });
  }
  const rawAck = bidsDescription.HowToAcknowledge;
  if (typeof rawAck === "string" && rawAck) {
    descriptions.push({ description: rawAck, descriptionType: "Other" });
  }

  // Related identifiers
  const relatedIdentifiers: DataCiteRelatedIdentifier[] = [];
  if (enrichment?.relatedDois) {
    for (const rel of enrichment.relatedDois) {
      relatedIdentifiers.push({
        identifier: rel.doi,
        relatedIdentifierType: "DOI",
        relationType: rel.relationType || "IsSupplementTo",
      });
    }
  }
  // BIDS ReferencesAndLinks
  const rawRefs = bidsDescription.ReferencesAndLinks;
  const refs = Array.isArray(rawRefs) ? rawRefs.filter((r): r is string => typeof r === "string") : [];
  for (const ref of refs) {
    if (ref.match(/^10\.\d{4,}/)) {
      relatedIdentifiers.push({
        identifier: ref,
        relatedIdentifierType: "DOI",
        relationType: "References",
      });
    }
  }

  // Subjects/keywords
  const subjects: string[] = enrichment?.keywords ? [...enrichment.keywords] : [];
  // Add modality-based subjects
  if (modality) {
    if (!subjects.includes(modality.toUpperCase())) {
      subjects.push(modality.toUpperCase());
    }
  }
  if (!subjects.includes("BIDS")) {
    subjects.push("BIDS");
  }
  if (!subjects.includes("neuroscience")) {
    subjects.push("neuroscience");
  }

  // Contributors: NEMAR as hosting institution
  const contributors: DataCiteContributor[] = [
    {
      name: "NEMAR (Neuroelectromagnetic Data Archive and Tools Resource)",
      contributorType: "HostingInstitution",
      nameType: "Organizational",
    },
  ];

  // Alternate identifiers
  const alternateIdentifiers = [{ identifier: datasetId, type: "NEMAR" }];

  // Funding
  const fundingReferences: DataCiteFundingReference[] = [];
  if (enrichment?.fundingInfo) {
    fundingReferences.push(...enrichment.fundingInfo);
  } else {
    const rawFunding = bidsDescription.Funding;
    const funding = Array.isArray(rawFunding) ? rawFunding.filter((f): f is string => typeof f === "string") : [];
    for (const f of funding) {
      fundingReferences.push({ funderName: f });
    }
  }

  // GeoLocations
  const geoLocations: string[] = [];
  if (enrichment?.geoLocation) {
    geoLocations.push(enrichment.geoLocation);
  }

  return {
    identifier: doi,
    creators,
    titles: [title],
    publisher: "NEMAR (Neuroelectromagnetic Data Archive and Tools Resource)",
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
