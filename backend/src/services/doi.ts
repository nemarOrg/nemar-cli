/**
 * DOI provider dispatch layer
 *
 * Routes DOI operations to EZID or Zenodo based on the provider setting.
 * Each dataset has its own doi_provider; existing Zenodo datasets keep working.
 */

import type { BidsDatasetDescription, DataCiteEnrichment } from "./datacite";
import { bidsToDataCite, buildDataCiteXml } from "./datacite";
import {
  type EzidAuth,
  PRODUCTION_SHOULDER,
  TEST_SHOULDER,
  extractDoi,
  getDoiUrl,
  makePublic,
  mintIdentifier,
  updateIdentifier,
} from "./ezid";
import {
  type ZenodoMetadata,
  createDeposition,
  formatRecordUrl,
  getPrereservedDoi,
} from "./zenodo";

export type DoiProvider = "ezid" | "zenodo";

export interface DoiResult {
  doi: string;
  provider: DoiProvider;
  /** Provider-specific record ID (EZID identifier or Zenodo deposition ID) */
  providerRecordId: string;
  /** EZID status or "draft" for Zenodo */
  status: string;
}

export interface CreateConceptDoiOptions {
  provider: DoiProvider;
  datasetId: string;
  datasetName: string;
  datasetDescription?: string | null;
  githubRepo?: string | null;
  /** BIDS dataset_description.json content */
  bidsDescription?: BidsDatasetDescription | Record<string, unknown>;
  /** Uploader's ORCID for auto-injection into creators */
  uploaderOrcid?: string;
  /** Uploader's name (used as fallback creator) */
  uploaderName: string;
  sandbox?: boolean;
}

export interface EzidEnv {
  EZID_USERNAME: string;
  EZID_PASSWORD: string;
}

export interface ZenodoEnv {
  ZENODO_API_KEY: string;
  ZENODO_SANDBOX_API_KEY?: string;
}

/**
 * Create a concept DOI via the specified provider.
 *
 * For EZID: reads BIDS metadata, builds DataCite XML, mints reserved identifier.
 * For Zenodo: creates a deposition with pre-reserved DOI.
 */
export async function createConceptDoi(
  options: CreateConceptDoiOptions,
  env: EzidEnv & ZenodoEnv,
): Promise<DoiResult> {
  if (options.provider === "ezid") {
    return createEzidConceptDoi(options, env);
  }
  return createZenodoConceptDoi(options, env);
}

async function createEzidConceptDoi(
  options: CreateConceptDoiOptions,
  env: EzidEnv,
): Promise<DoiResult> {
  const auth: EzidAuth = {
    username: env.EZID_USERNAME,
    password: env.EZID_PASSWORD,
  };

  const shoulder = options.sandbox ? TEST_SHOULDER : PRODUCTION_SHOULDER;

  // Build enrichment with uploader ORCID
  const enrichment: DataCiteEnrichment = {};
  if (options.uploaderOrcid && options.bidsDescription) {
    const authors = options.bidsDescription.Authors;
    const authorList: string[] = Array.isArray(authors)
      ? authors.filter((a): a is string => typeof a === "string")
      : [];

    // If the uploader appears in the author list, attach their ORCID
    // Otherwise, we add it as a general enrichment
    if (authorList.length > 0) {
      enrichment.authors = {};
      // Try to match uploader name to an author entry
      for (const author of authorList) {
        if (author.toLowerCase().includes(options.uploaderName.toLowerCase())) {
          enrichment.authors[author] = { orcid: options.uploaderOrcid };
          break;
        }
      }
    }
  }

  if (options.datasetDescription) {
    enrichment.description = options.datasetDescription;
  }

  // Use a placeholder DOI for initial XML (will be replaced after mint)
  const placeholderDoi = "10.0000/placeholder";
  const bids = options.bidsDescription || { Name: options.datasetName };
  const metadata = bidsToDataCite(options.datasetId, placeholderDoi, bids, enrichment);

  // Mint the identifier
  const dataciteXml = buildDataCiteXml(metadata);
  const target = options.githubRepo
    ? `https://github.com/${options.githubRepo}`
    : `https://nemar.org/dataexplorer/detail?dataset_id=${options.datasetId}`;

  const identifier = await mintIdentifier(auth, {
    shoulder,
    status: "reserved",
    target,
    dataciteXml,
  });

  // Update the XML with the actual DOI
  const actualDoi = extractDoi(identifier.identifier);
  const updatedMetadata = bidsToDataCite(options.datasetId, actualDoi, bids, enrichment);
  const updatedXml = buildDataCiteXml(updatedMetadata);
  await updateIdentifier(auth, identifier.identifier, { dataciteXml: updatedXml });

  return {
    doi: actualDoi,
    provider: "ezid",
    providerRecordId: identifier.identifier,
    status: identifier.status,
  };
}

async function createZenodoConceptDoi(
  options: CreateConceptDoiOptions,
  env: ZenodoEnv,
): Promise<DoiResult> {
  const zenodoToken = options.sandbox ? env.ZENODO_SANDBOX_API_KEY : env.ZENODO_API_KEY;
  if (!zenodoToken) {
    throw new Error(
      options.sandbox ? "Zenodo sandbox API key not configured" : "Zenodo API key not configured",
    );
  }

  const metadata: ZenodoMetadata = {
    title: `${options.datasetName} - BIDS Dataset`,
    description: options.datasetDescription || `BIDS-formatted dataset: ${options.datasetName}`,
    creators: [{ name: options.uploaderName }],
    keywords: ["BIDS", "neuroscience", "neuroimaging", "NEMAR"],
    license: "cc-by-nc-4.0",
    related_identifiers: options.githubRepo
      ? [
          {
            identifier: `https://github.com/${options.githubRepo}`,
            relation: "isSupplementTo",
            resource_type: "dataset",
          },
        ]
      : undefined,
  };

  const deposition = await createDeposition(metadata, zenodoToken, options.sandbox);
  const conceptDoi = getPrereservedDoi(deposition);
  if (!conceptDoi) {
    throw new Error("Zenodo did not return a pre-reserved DOI");
  }

  return {
    doi: conceptDoi,
    provider: "zenodo",
    providerRecordId: deposition.id.toString(),
    status: "draft",
  };
}

/**
 * Create a version DOI via EZID.
 * Mints a new DOI with IsVersionOf relation to the concept DOI.
 */
export async function createEzidVersionDoi(
  env: EzidEnv,
  opts: {
    datasetId: string;
    conceptIdentifier: string;
    version: string;
    bidsDescription: BidsDatasetDescription | Record<string, unknown>;
    githubRepo: string;
    sandbox?: boolean;
    enrichment?: DataCiteEnrichment;
  },
): Promise<DoiResult> {
  const auth: EzidAuth = {
    username: env.EZID_USERNAME,
    password: env.EZID_PASSWORD,
  };

  const shoulder = opts.sandbox ? TEST_SHOULDER : PRODUCTION_SHOULDER;
  const conceptDoi = extractDoi(opts.conceptIdentifier);

  // Build enrichment with version relation
  const enrichment: DataCiteEnrichment = {
    ...opts.enrichment,
    relatedDois: [
      ...(opts.enrichment?.relatedDois || []),
      { doi: conceptDoi, relationType: "IsVersionOf" },
    ],
  };

  // Use placeholder, then update after mint
  const placeholderDoi = "10.0000/placeholder";
  const metadata = bidsToDataCite(opts.datasetId, placeholderDoi, opts.bidsDescription, enrichment);
  metadata.version = opts.version;

  const dataciteXml = buildDataCiteXml(metadata);
  const releaseUrl = `https://github.com/${opts.githubRepo}/releases/tag/v${opts.version}`;

  const identifier = await mintIdentifier(auth, {
    shoulder,
    status: "reserved",
    target: releaseUrl,
    dataciteXml,
  });

  // Update XML with actual DOI
  const actualDoi = extractDoi(identifier.identifier);
  const updatedMetadata = bidsToDataCite(
    opts.datasetId,
    actualDoi,
    opts.bidsDescription,
    enrichment,
  );
  updatedMetadata.version = opts.version;
  const updatedXml = buildDataCiteXml(updatedMetadata);
  await updateIdentifier(auth, identifier.identifier, { dataciteXml: updatedXml });

  // Make the version DOI public
  await makePublic(auth, identifier.identifier, releaseUrl);

  // Update the concept DOI's XML to include HasVersion relation
  const conceptBids = opts.bidsDescription;
  const conceptEnrichment: DataCiteEnrichment = {
    relatedDois: [{ doi: actualDoi, relationType: "HasVersion" }],
  };
  const conceptMetadata = bidsToDataCite(opts.datasetId, conceptDoi, conceptBids, conceptEnrichment);
  const conceptXml = buildDataCiteXml(conceptMetadata);
  await updateIdentifier(auth, opts.conceptIdentifier, { dataciteXml: conceptXml });

  return {
    doi: actualDoi,
    provider: "ezid",
    providerRecordId: identifier.identifier,
    status: "public",
  };
}
