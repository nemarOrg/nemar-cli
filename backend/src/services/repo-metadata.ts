/**
 * Repository metadata reading helpers
 *
 * Extracts common patterns for reading BIDS and NEMAR metadata
 * from GitHub repository trees.
 */

import type { DataCiteEnrichment } from "./datacite.js";
import { nemarMetadataToEnrichment, parseNemarMetadata } from "./datacite.js";
import { getBlobContent, getTreeAtRef } from "./github.js";

/**
 * Extract the repo name (e.g., "nm000104") from a "org/repo" string.
 * Returns null if the format is invalid.
 */
export function extractRepoName(githubRepo: string): string | null {
  const parts = githubRepo.split("/");
  if (parts.length !== 2 || !parts[1]) return null;
  return parts[1];
}

/**
 * Extract the error message from an unknown thrown value.
 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface BidsMetadataResult {
  bidsDescription: Record<string, unknown>;
  warning?: string;
}

/**
 * Read and parse dataset_description.json from a GitHub repo tree.
 * Returns a default object with the dataset name if reading fails.
 */
export async function readBidsDescription(
  repoName: string,
  pat: string,
  fallbackName?: string,
  ref = "main",
): Promise<BidsMetadataResult> {
  const result: BidsMetadataResult = {
    bidsDescription: fallbackName ? { Name: fallbackName } : {},
  };

  try {
    const tree = await getTreeAtRef(repoName, ref, pat);
    const descFile = tree.find((f) => f.path === "dataset_description.json");
    if (!descFile) return result;

    const content = await getBlobContent(repoName, descFile.sha, pat);
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      result.bidsDescription = parsed as Record<string, unknown>;
    } else {
      result.warning = "dataset_description.json is not a JSON object; using fallback metadata";
    }
  } catch (error) {
    result.warning = `Could not read BIDS metadata: ${errorMessage(error)}`;
  }

  return result;
}

export interface RepoMetadataResult {
  bidsDescription: Record<string, unknown>;
  enrichment?: DataCiteEnrichment;
  warnings: string[];
}

/**
 * Read both dataset_description.json and nemar_metadata.json from a GitHub repo.
 * Combines them into BIDS description and DataCite enrichment.
 * Returns warnings for any non-fatal errors encountered.
 */
export async function readRepoMetadata(
  repoName: string,
  pat: string,
  baseEnrichment?: DataCiteEnrichment,
  fallbackName?: string,
  ref = "main",
): Promise<RepoMetadataResult> {
  const warnings: string[] = [];
  let bidsDescription: Record<string, unknown> = fallbackName ? { Name: fallbackName } : {};
  let enrichment = baseEnrichment;

  try {
    const tree = await getTreeAtRef(repoName, ref, pat);

    // Read dataset_description.json
    const descFile = tree.find((f) => f.path === "dataset_description.json");
    if (descFile) {
      const content = await getBlobContent(repoName, descFile.sha, pat);
      const parsed = JSON.parse(content);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        bidsDescription = parsed as Record<string, unknown>;
      }
    }

    // Read nemar_metadata.json for rich enrichment
    const nemarMetaFile = tree.find((f) => f.path === "nemar_metadata.json");
    if (nemarMetaFile) {
      try {
        const nemarContent = await getBlobContent(repoName, nemarMetaFile.sha, pat);
        const nemarParsed = parseNemarMetadata(JSON.parse(nemarContent));
        if (nemarParsed) {
          enrichment = nemarMetadataToEnrichment(nemarParsed, enrichment);
        }
      } catch (nemarErr) {
        warnings.push(`nemar_metadata.json enrichment skipped: ${errorMessage(nemarErr)}`);
      }
    }
  } catch (error) {
    warnings.push(
      `BIDS metadata unavailable: ${errorMessage(error)}. DOI minted with minimal metadata.`,
    );
  }

  return { bidsDescription, enrichment, warnings };
}
