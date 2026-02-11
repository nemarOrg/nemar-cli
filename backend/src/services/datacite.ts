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
  contributorType: string;
  nameType?: "Personal" | "Organizational";
  affiliation?: string;
}

export interface DataCiteDate {
  date: string; // ISO 8601 date or range (YYYY-MM-DD or YYYY-MM-DD/YYYY-MM-DD)
  dateType: string;
}

export interface DataCiteRelatedIdentifier {
  identifier: string;
  relatedIdentifierType: "DOI" | "URL" | "ARK" | "arXiv" | "PMID";
  relationType: string;
}

export interface DataCiteRights {
  rights: string;
  rightsURI: string;
  rightsIdentifier?: string;
  rightsIdentifierScheme?: string;
}

export interface DataCiteDescription {
  description: string;
  descriptionType: "Abstract" | "Methods" | "SeriesInformation" | "TableOfContents" | "TechnicalInfo" | "Other";
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
  resourceTypeGeneral: string;
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
export interface DataCiteEnrichment {
  orcids?: Record<string, string>; // author name -> ORCID
  affiliations?: Record<string, string>; // author name -> affiliation
  rors?: Record<string, string>; // affiliation -> ROR
  keywords?: string[];
  relatedDois?: Array<{ doi: string; relationType?: string }>;
  fundingInfo?: DataCiteFundingReference[];
  description?: string;
  methodsDescription?: string;
  collectionDates?: string; // ISO 8601 date range
  geoLocation?: string;
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
 */
export function buildDataCiteXml(metadata: DataCiteMetadata): string {
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
// BIDS to DataCite mapping
// ---------------------------------------------------------------------------

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
 */
export function bidsToDataCite(
  datasetId: string,
  doi: string,
  bidsDescription: Record<string, unknown>,
  enrichment?: DataCiteEnrichment,
): DataCiteMetadata {
  // Parse creators from BIDS Authors
  const authors = (bidsDescription.Authors as string[]) || [];
  const creators: DataCiteCreator[] = authors.map((author) => {
    const parsed = parseAuthorName(author);
    const creator: DataCiteCreator = {
      name: parsed.name,
      givenName: parsed.givenName,
      familyName: parsed.familyName,
    };
    // Apply enrichment
    if (enrichment?.orcids?.[author]) {
      creator.orcid = enrichment.orcids[author];
    }
    if (enrichment?.affiliations?.[author]) {
      creator.affiliation = enrichment.affiliations[author];
      if (enrichment.rors?.[creator.affiliation]) {
        creator.ror = enrichment.rors[creator.affiliation];
      }
    }
    return creator;
  });

  // Ensure at least one creator
  if (creators.length === 0) {
    creators.push({ name: "(:unav)" });
  }

  // Titles
  const title = (bidsDescription.Name as string) || datasetId;

  // License
  const licenseStr = bidsDescription.License as string | undefined;
  const rights = mapLicense(licenseStr);

  // Version
  const version = bidsDescription.Version as string | undefined;

  // Modality-specific resource type
  const modality = bidsDescription.DatasetType as string | undefined;
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
  if (bidsDescription.HowToAcknowledge) {
    descriptions.push({
      description: bidsDescription.HowToAcknowledge as string,
      descriptionType: "Other",
    });
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
  const refs = bidsDescription.ReferencesAndLinks as string[] | undefined;
  if (refs) {
    for (const ref of refs) {
      if (ref.match(/^10\.\d{4,}/)) {
        relatedIdentifiers.push({
          identifier: ref,
          relatedIdentifierType: "DOI",
          relationType: "References",
        });
      }
    }
  }

  // Subjects/keywords
  const subjects: string[] = enrichment?.keywords || [];
  // Add modality-based subjects
  if (modality) {
    const mod = Array.isArray(modality) ? modality : [modality];
    for (const m of mod) {
      if (!subjects.includes(m.toUpperCase())) {
        subjects.push(m.toUpperCase());
      }
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
  } else if (bidsDescription.Funding) {
    const funding = bidsDescription.Funding as string[];
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
    sizes: undefined, // Set by caller with actual dataset stats
    formats: undefined, // Set by caller based on file types
    version,
    rights: rights ? [rights] : undefined,
    fundingReferences: fundingReferences.length > 0 ? fundingReferences : undefined,
  };
}
