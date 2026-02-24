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
  type EzidIdentifier,
  type EzidStatus,
  PRODUCTION_SHOULDER,
  TEST_SHOULDER,
  createIdentifier,
  extractDoi,
  getIdentifier,
  makePublic,
  updateIdentifier,
} from "./ezid";
import { type ZenodoMetadata, createDeposition, getPrereservedDoi } from "./zenodo";

export type DoiProvider = "ezid" | "zenodo";

/** Parse and validate a doi_provider value from the database.
 *  Throws on non-null unrecognized values (data integrity issue).
 *  Returns fallback only when raw is null/undefined (no provider configured yet). */
export function parseDoiProvider(
  raw: string | null | undefined,
  fallback: DoiProvider = "ezid",
): DoiProvider {
  if (raw === "ezid" || raw === "zenodo") return raw;
  if (raw != null) {
    throw new Error(`Unknown doi_provider "${raw}". Expected "ezid" or "zenodo".`);
  }
  return fallback;
}

export type { EzidStatus };

/** Discriminated union: EZID has a lifecycle (reserved/public/unavailable) while Zenodo concept depositions remain "draft" until published. */
export type DoiResult = (
  | { doi: string; provider: "ezid"; providerRecordId: string; status: EzidStatus }
  | { doi: string; provider: "zenodo"; providerRecordId: string; status: "draft" }
) & {
  /** Non-fatal warnings (e.g., concept DOI update failed after version was published) */
  warnings?: string[];
};

export interface CreateConceptDoiOptions {
  provider: DoiProvider;
  datasetId: string;
  datasetName: string;
  datasetDescription?: string | null;
  githubRepo?: string | null;
  /** BIDS dataset_description.json content */
  bidsDescription?: BidsDatasetDescription | Record<string, unknown>;
  /** Pre-built enrichment from .nemar/metadata.json (if available) */
  enrichment?: DataCiteEnrichment;
  /** Uploader's ORCID for auto-injection into creators */
  uploaderOrcid?: string;
  /** Uploader's name (used for ORCID matching against BIDS authors, and as Zenodo creator) */
  uploaderName: string;
  sandbox?: boolean;
}

export interface EzidEnv {
  EZID_USERNAME: string;
  EZID_PASSWORD: string;
  EZID_SANDBOX_USERNAME?: string;
  EZID_SANDBOX_PASSWORD?: string;
}

export interface ZenodoEnv {
  ZENODO_API_KEY: string;
  ZENODO_SANDBOX_API_KEY?: string;
}

/**
 * Build DataCite enrichment with ORCID matched to a BIDS author entry.
 * Matches the uploader name against the BIDS Authors list (case-insensitive substring).
 */
export function buildOrcidEnrichment(
  bidsDescription?: BidsDatasetDescription | Record<string, unknown>,
  uploaderName?: string,
  uploaderOrcid?: string,
): DataCiteEnrichment {
  if (!uploaderOrcid || !bidsDescription || !uploaderName) {
    return {};
  }

  const authors = bidsDescription.Authors;
  if (!Array.isArray(authors)) return {};

  const authorList = authors.filter((a): a is string => typeof a === "string");
  const uploaderLower = uploaderName.toLowerCase();

  const matched = authorList.find((a) => a.toLowerCase().includes(uploaderLower));
  if (!matched) return {};

  return { authors: { [matched]: { orcid: uploaderOrcid } } };
}

/**
 * Create a concept DOI via the specified provider.
 *
 * For EZID: builds DataCite XML from provided BIDS metadata, mints reserved identifier.
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

/** Resolve EZID credentials based on sandbox flag. Throws if the requested credentials are missing. */
export function resolveEzidAuth(env: EzidEnv, sandbox?: boolean): EzidAuth {
  if (sandbox) {
    if (!env.EZID_SANDBOX_USERNAME || !env.EZID_SANDBOX_PASSWORD) {
      throw new Error(
        "EZID sandbox credentials not configured. Set EZID_SANDBOX_USERNAME and EZID_SANDBOX_PASSWORD.",
      );
    }
    return { username: env.EZID_SANDBOX_USERNAME, password: env.EZID_SANDBOX_PASSWORD };
  }
  if (!env.EZID_USERNAME || !env.EZID_PASSWORD) {
    throw new Error(
      "EZID credentials not configured. Set EZID_USERNAME and EZID_PASSWORD secrets.",
    );
  }
  return { username: env.EZID_USERNAME, password: env.EZID_PASSWORD };
}

function resolveShoulder(sandbox?: boolean): string {
  return sandbox ? TEST_SHOULDER : PRODUCTION_SHOULDER;
}

/** Build deterministic concept DOI identifier from dataset ID. */
export function buildConceptIdentifier(datasetId: string, sandbox?: boolean): string {
  return `${resolveShoulder(sandbox)}${datasetId.toUpperCase()}`;
}

/** Build deterministic version DOI identifier from dataset ID and version. */
export function buildVersionIdentifier(
  datasetId: string,
  version: string,
  sandbox?: boolean,
): string {
  return `${resolveShoulder(sandbox)}${datasetId.toUpperCase()}.V${version.toUpperCase()}`;
}

async function createEzidConceptDoi(
  options: CreateConceptDoiOptions,
  env: EzidEnv,
): Promise<DoiResult> {
  const auth = resolveEzidAuth(env, options.sandbox);

  // Use pre-built enrichment from .nemar/metadata.json when available,
  // otherwise fall back to minimal ORCID-only enrichment
  const enrichment: DataCiteEnrichment = options.enrichment
    ? { ...options.enrichment }
    : buildOrcidEnrichment(options.bidsDescription, options.uploaderName, options.uploaderOrcid);

  // Use enriched description if available, otherwise fall back to request/database
  if (!enrichment.description && options.datasetDescription) {
    enrichment.description = options.datasetDescription;
  }

  // Deterministic DOI: doi:10.82901/NEMAR.NM000104
  const fullIdentifier = buildConceptIdentifier(options.datasetId, options.sandbox);
  const doi = extractDoi(fullIdentifier);

  const bids = options.bidsDescription || { Name: options.datasetName };
  const metadata = bidsToDataCite(options.datasetId, doi, bids, enrichment);
  const dataciteXml = buildDataCiteXml(metadata);

  // DOI landing page: always the NEMAR website (not GitHub)
  const target = `https://nemar.org/dataexplorer/detail?dataset_id=${options.datasetId}`;

  let identifier: EzidIdentifier;
  try {
    identifier = await createIdentifier(auth, fullIdentifier, {
      status: "reserved",
      target,
      dataciteXml,
    });
  } catch (error) {
    // Idempotency: if admin retries after a timeout, the DOI may already exist
    if (error instanceof Error && error.message.includes("already exists")) {
      identifier = await getIdentifier(auth, fullIdentifier);
    } else {
      throw error;
    }
  }

  return {
    doi,
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
 * Mints a new DOI with IsVersionOf relation to the concept DOI,
 * immediately makes it public, and updates the concept DOI to
 * include HasVersion back-references to all versions.
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
    /** Previously published version DOIs to preserve in concept HasVersion relations */
    existingVersionDois?: string[];
  },
): Promise<DoiResult> {
  const auth = resolveEzidAuth(env, opts.sandbox);
  const conceptDoi = extractDoi(opts.conceptIdentifier);

  // Build enrichment with version relation
  const enrichment: DataCiteEnrichment = {
    ...opts.enrichment,
    relatedDois: [
      ...(opts.enrichment?.relatedDois || []),
      { doi: conceptDoi, relationType: "IsVersionOf" },
    ],
  };

  // Deterministic DOI: doi:10.82901/NEMAR.NM000104.V1.0.0
  const fullIdentifier = buildVersionIdentifier(opts.datasetId, opts.version, opts.sandbox);
  const doi = extractDoi(fullIdentifier);

  const metadata = bidsToDataCite(opts.datasetId, doi, opts.bidsDescription, enrichment);
  metadata.version = opts.version;
  const dataciteXml = buildDataCiteXml(metadata);

  // Version DOI landing page: NEMAR website with version param (not GitHub release)
  const target = `https://nemar.org/dataexplorer/detail?dataset_id=${opts.datasetId}&version=${opts.version}`;

  let identifier: EzidIdentifier;
  try {
    identifier = await createIdentifier(auth, fullIdentifier, {
      status: "reserved",
      target,
      dataciteXml,
    });
  } catch (error) {
    // Idempotency: if webhook retries after a timeout, the DOI may already exist
    if (!(error instanceof Error && error.message.includes("already exists"))) {
      throw error;
    }
    // Fetch existing identifier and return early
    identifier = await getIdentifier(auth, fullIdentifier);
    return {
      doi,
      provider: "ezid",
      providerRecordId: identifier.identifier,
      status: identifier.status,
    };
  }

  // Make the version DOI public
  await makePublic(auth, identifier.identifier, target);

  // Update the concept DOI's XML to include HasVersion relation.
  // Non-fatal: the version DOI is already public at this point, so we log but
  // do not throw if the concept update fails.
  const warnings: string[] = [];
  try {
    // Include all version DOIs (existing + new) so we don't overwrite previous HasVersion relations
    const allVersionDois = [
      ...(opts.existingVersionDois || []).map((d) => ({
        doi: d,
        relationType: "HasVersion" as const,
      })),
      { doi, relationType: "HasVersion" as const },
    ];
    const conceptEnrichment: DataCiteEnrichment = {
      relatedDois: allVersionDois,
    };
    const conceptMetadata = bidsToDataCite(
      opts.datasetId,
      conceptDoi,
      opts.bidsDescription,
      conceptEnrichment,
    );
    const conceptXml = buildDataCiteXml(conceptMetadata);
    await updateIdentifier(auth, opts.conceptIdentifier, { dataciteXml: conceptXml });
  } catch (conceptUpdateError) {
    const msg = `Version DOI ${doi} is public but concept DOI update failed: ${conceptUpdateError instanceof Error ? conceptUpdateError.message : String(conceptUpdateError)}`;
    console.error(`[doi] ${msg}`);
    warnings.push(msg);
  }

  return {
    doi,
    provider: "ezid",
    providerRecordId: fullIdentifier,
    status: "public",
    ...(warnings.length > 0 && { warnings }),
  };
}
