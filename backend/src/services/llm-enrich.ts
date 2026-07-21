/**
 * Backend LLM-based metadata enrichment service (Workers-compatible)
 *
 * Extracts structured v2 metadata from README.md and BIDS dataset_description.json
 * using OpenRouter API. Designed for server-side use in Cloudflare Workers webhooks.
 */

import {
  type AuthorEnrichmentV2,
  type FundingReferenceEntry,
  type NemarMetadataV2,
  type RelatedIdentifierEntry,
  type StructuredKeyword,
  datasetLandingUrl,
  isValidRelationType,
} from "../../../shared/datacite-constants.js";

import { detectModalitiesFromTree, mapModalityToResourceType } from "./datacite.js";

/** Result of LLM enrichment (v2 format fields only). */
export interface LlmEnrichmentResultV2 {
  description?: string;
  methods_description?: string;
  keywords?: StructuredKeyword[];
  funding_references?: FundingReferenceEntry[];
  related_identifiers?: RelatedIdentifierEntry[];
}

const README_MAX_LENGTH = 8000;

/** Truncate README content to stay within LLM token limits. */
function truncateReadme(content: string): string {
  if (content.length <= README_MAX_LENGTH) return content;
  return `${content.slice(0, README_MAX_LENGTH)}\n[truncated]`;
}

interface OpenRouterResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

/**
 * Call OpenRouter and extract a parsed JSON object from the response.
 *
 * Handles markdown code block unwrapping and JSON parsing.
 * Throws on HTTP errors, missing content, or invalid JSON.
 */
async function callOpenRouter(
  systemPrompt: string,
  userPrompt: string,
  apiKey: string,
  maxTokens = 2000,
): Promise<Record<string, unknown>> {
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "anthropic/claude-haiku-4.5",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.1,
      max_tokens: maxTokens,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenRouter API error (${response.status}): ${errorText}`);
  }

  const data = (await response.json()) as OpenRouterResponse;
  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("No content in LLM response");
  }

  // Extract JSON from response (may be wrapped in markdown code block)
  const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, content];
  const jsonStr = (jsonMatch[1] || content).trim();

  try {
    return JSON.parse(jsonStr) as Record<string, unknown>;
  } catch (parseErr) {
    throw new Error(
      `LLM returned invalid JSON: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`,
    );
  }
}

const SYSTEM_PROMPT = `You are a metadata extraction assistant for neuroimaging datasets.
Given a README and BIDS dataset description, extract structured metadata for a DataCite DOI record.

Return ONLY valid JSON with these optional fields:
{
  "description": "A concise abstract (2-4 sentences) describing the dataset's content, purpose, and scientific context.",
  "methods_description": "A brief description of data collection methods if mentioned in the README.",
  "keywords": [{"term": "EEG", "subject_scheme": "MeSH"}, {"term": "motor imagery"}],
  "funding_references": [{"funder_name": "NIH", "award_number": "R01-MH123456", "award_title": "optional title"}],
  "related_identifiers": [{"identifier": "10.1234/example", "identifier_type": "DOI", "relation_type": "IsSupplementTo"}]
}

Rules:
- description: Write a scholarly abstract. Do not copy verbatim from README.
- methods_description: Only include if methods/acquisition details are described.
- keywords: 3-8 domain-specific terms. Include modality (EEG, MEG, etc.) if applicable. Use subject_scheme "MeSH" ONLY when you are confident the term is a real MeSH descriptor. Do NOT use "LCSH" or any other scheme. Terms that are not MeSH descriptors should have no subject_scheme.
- funding_references: Parse funding strings into structured format. Common funders: NIH, NSF, ERC, DFG. Use funder_name (not funderName).
- related_identifiers: Only include actual DOIs (10.XXXX/...) with identifier_type "DOI". Common relation_type values:
  IsCitedBy, Cites, IsSupplementTo, IsSupplementedBy, References, IsReferencedBy,
  IsDescribedBy, Describes, IsVersionOf, HasVersion, IsPartOf, HasPart
- Omit any field where you have no information. Return {} if nothing can be extracted.
- Do NOT hallucinate DOIs or funding numbers.`;

/**
 * Extract structured v2 metadata from README and BIDS description using an LLM.
 *
 * @param readmeContent - Raw README.md content
 * @param bidsDescription - Parsed dataset_description.json
 * @param apiKey - OpenRouter API key
 * @returns Extracted metadata in v2 format
 */
export async function enrichFromReadme(
  readmeContent: string,
  bidsDescription: Record<string, unknown>,
  apiKey: string,
): Promise<LlmEnrichmentResultV2> {
  const userPrompt = `## BIDS dataset_description.json
\`\`\`json
${JSON.stringify(bidsDescription, null, 2)}
\`\`\`

## README.md
${truncateReadme(readmeContent)}`;

  const parsed = await callOpenRouter(SYSTEM_PROMPT, userPrompt, apiKey);
  return validateLlmResultV2(parsed);
}

/**
 * Validate and clean the LLM response to match v2 schema.
 */
export function validateLlmResultV2(raw: Record<string, unknown>): LlmEnrichmentResultV2 {
  const result: LlmEnrichmentResultV2 = {};

  if (typeof raw.description === "string" && raw.description) {
    result.description = raw.description;
  }

  if (typeof raw.methods_description === "string" && raw.methods_description) {
    result.methods_description = raw.methods_description;
  }

  // Keywords: accept array of objects with term field, or plain strings
  if (Array.isArray(raw.keywords)) {
    const kw: StructuredKeyword[] = [];
    for (const k of raw.keywords) {
      if (typeof k === "string" && k) {
        kw.push({ term: k });
      } else if (k && typeof k === "object") {
        const obj = k as Record<string, unknown>;
        if (typeof obj.term === "string" && obj.term) {
          const entry: StructuredKeyword = { term: obj.term };
          // Only accept MeSH as subject_scheme; strip all others
          if (typeof obj.subject_scheme === "string" && obj.subject_scheme === "MeSH") {
            entry.subject_scheme = "MeSH";
            if (typeof obj.scheme_uri === "string") entry.scheme_uri = obj.scheme_uri;
            if (typeof obj.value_uri === "string") entry.value_uri = obj.value_uri;
          }
          kw.push(entry);
        }
      }
    }
    if (kw.length > 0) result.keywords = kw;
  }

  // Funding references
  if (Array.isArray(raw.funding_references)) {
    const funds: FundingReferenceEntry[] = [];
    for (const f of raw.funding_references) {
      if (!f || typeof f !== "object") continue;
      const obj = f as Record<string, unknown>;
      if (typeof obj.funder_name !== "string") continue;
      const entry: FundingReferenceEntry = { funder_name: obj.funder_name };
      if (typeof obj.award_number === "string") entry.award_number = obj.award_number;
      if (typeof obj.award_title === "string") entry.award_title = obj.award_title;
      if (typeof obj.funder_identifier === "string")
        entry.funder_identifier = obj.funder_identifier;
      if (typeof obj.funder_identifier_type === "string") {
        const validTypes = ["Crossref Funder ID", "GRID", "ISNI", "ROR", "Other"] as const;
        if ((validTypes as readonly string[]).includes(obj.funder_identifier_type)) {
          entry.funder_identifier_type =
            obj.funder_identifier_type as FundingReferenceEntry["funder_identifier_type"];
        }
      }
      funds.push(entry);
    }
    if (funds.length > 0) result.funding_references = funds;
  }

  // Related identifiers
  if (Array.isArray(raw.related_identifiers)) {
    const doiPattern = /^10\.\d{4,}\/.+$/;
    const rels: RelatedIdentifierEntry[] = [];
    for (const r of raw.related_identifiers) {
      if (!r || typeof r !== "object") continue;
      const obj = r as Record<string, unknown>;
      if (
        typeof obj.identifier === "string" &&
        typeof obj.relation_type === "string" &&
        isValidRelationType(obj.relation_type) &&
        doiPattern.test(obj.identifier)
      ) {
        rels.push({
          identifier: obj.identifier,
          identifier_type: "DOI",
          relation_type: obj.relation_type,
        });
      }
    }
    if (rels.length > 0) result.related_identifiers = rels;
  }

  return result;
}

/**
 * Stage 1: Seed metadata from BIDS dataset_description.json (no LLM call).
 *
 * Deterministically extracts all available metadata:
 * - All authors (even without ORCIDs), preserving existing enrichment
 * - SourceDatasets -> related_identifiers with IsDerivedFrom
 * - Funding strings -> funding_references (raw; LLM will parse better in stage 2)
 * - ReferencesAndLinks -> related_identifiers (DOIs mapped to "References"; non-DOI URLs ignored)
 * - DatasetType -> resource_type_general
 * - Dataset platform URLs (GitHub, NEMAR) -> related_identifiers with "IsDescribedBy"
 */
export function seedFromBids(
  bidsDescription: Record<string, unknown>,
  existing: NemarMetadataV2 | null,
  datasetId?: string,
  treePaths?: string[],
  // Landing-URL base for the NEMAR IsDescribedBy related identifier (epic #923).
  // Omitted -> prod nemar.org (via datasetLandingUrl default), so the pure seed
  // stays env-agnostic; enrichDataset passes the resolved staging base.
  landingBaseUrl?: string,
): NemarMetadataV2 {
  const seeded: NemarMetadataV2 = {
    version: "2.0",
    pipeline_stage: "seeded",
    ...(existing
      ? { ...existing, version: "2.0" as const, pipeline_stage: "seeded" as const }
      : {}),
  };

  // Authors: include ALL from BIDS, preserve existing ORCIDs/affiliations
  if (Array.isArray(bidsDescription.Authors)) {
    const authors: Record<string, AuthorEnrichmentV2> = { ...(existing?.authors || {}) };
    for (const author of bidsDescription.Authors) {
      if (typeof author === "string" && author) {
        // Only add if not already present (preserve existing enrichment)
        if (!authors[author]) {
          authors[author] = {};
        }
      }
    }
    if (Object.keys(authors).length > 0) seeded.authors = authors;
  }

  const doiPattern = /^10\.\d{4,}\/.+$/;

  // Collect SourceDatasets DOIs first so we can clean stale entries
  const sourceDatasetDois = new Set<string>();
  if (Array.isArray(bidsDescription.SourceDatasets)) {
    for (const src of bidsDescription.SourceDatasets) {
      if (!src || typeof src !== "object") continue;
      const obj = src as Record<string, unknown>;
      let doi = typeof obj.DOI === "string" ? obj.DOI.replace(/^doi:/, "") : "";
      if (!doi && typeof obj.URL === "string") {
        const urlDoi = obj.URL.match(/(?:doi\.org\/|doi:)(10\.\d{4,}\/.+)/);
        if (urlDoi) doi = urlDoi[1];
      }
      if (doi && doiPattern.test(doi)) sourceDatasetDois.add(doi);
    }
  }

  // Start from existing entries, but remove any that conflict with SourceDatasets
  // (e.g. a previous LLM run may have added IsVersionOf for a SourceDataset DOI),
  // and drop the retired legacy NEMAR landing URL so re-enrichment REPLACES it
  // with the canonical datasetLandingUrl below (epic #837) rather than letting
  // the old `dataexplorer/detail` and new `/dataset/` IsDescribedBy URLs accumulate.
  const relatedIds: RelatedIdentifierEntry[] = (existing?.related_identifiers || []).filter(
    (r) =>
      !r.identifier.includes("nemar.org/dataexplorer/") &&
      (!sourceDatasetDois.has(r.identifier) || r.relation_type === "IsDerivedFrom"),
  );

  // SourceDatasets -> IsDerivedFrom
  for (const doi of sourceDatasetDois) {
    const alreadyExists = relatedIds.some(
      (r) => r.identifier === doi && r.relation_type === "IsDerivedFrom",
    );
    if (!alreadyExists) {
      relatedIds.push({
        identifier: doi,
        identifier_type: "DOI",
        relation_type: "IsDerivedFrom",
      });
    }
  }

  // ReferencesAndLinks -> related_identifiers
  if (Array.isArray(bidsDescription.ReferencesAndLinks)) {
    for (const ref of bidsDescription.ReferencesAndLinks) {
      if (typeof ref !== "string" || !ref) continue;
      // Extract DOI from URL or raw DOI string
      const doiMatch = ref.match(/(?:doi\.org\/|^)(10\.\d{4,}\/.+)/);
      if (doiMatch) {
        const doi = doiMatch[1];
        const alreadyExists = relatedIds.some((r) => r.identifier === doi);
        if (!alreadyExists) {
          relatedIds.push({
            identifier: doi,
            identifier_type: "DOI",
            relation_type: "References",
          });
        }
      }
    }
  }

  if (relatedIds.length > 0) seeded.related_identifiers = relatedIds;

  // Funding -> funding_references (raw BIDS strings; LLM will parse better in stage 2)
  // Start fresh from BIDS to avoid carrying stale LLM-parsed duplicates from prior runs.
  const fundingRefs: FundingReferenceEntry[] = [];
  if (Array.isArray(bidsDescription.Funding)) {
    for (const f of bidsDescription.Funding) {
      if (typeof f !== "string" || !f) continue;
      fundingRefs.push({ funder_name: f });
    }
  }
  if (fundingRefs.length > 0) seeded.funding_references = fundingRefs;

  // Title from BIDS Name
  if (typeof bidsDescription.Name === "string" && bidsDescription.Name) {
    seeded.title = bidsDescription.Name;
  }

  // License from BIDS License
  if (typeof bidsDescription.License === "string" && bidsDescription.License) {
    seeded.license = bidsDescription.License;
  }

  // DatasetType (raw/derivative) and resource_type_general
  if (typeof bidsDescription.DatasetType === "string") {
    seeded.dataset_type = bidsDescription.DatasetType;
    seeded.resource_type_general = "Dataset";
  }

  // Detect modalities from repo tree (e.g. eeg, emg, func)
  if (treePaths && treePaths.length > 0) {
    const modalities = detectModalitiesFromTree(treePaths);
    if (modalities.length > 0) {
      seeded.modalities = modalities;
      seeded.resource_type_specific = mapModalityToResourceType(modalities);
    }
  }

  // Dataset URLs: GitHub repo and NEMAR landing page
  if (datasetId) {
    const githubUrl = `https://github.com/nemarDatasets/${datasetId}`;
    if (!relatedIds.some((r) => r.identifier === githubUrl)) {
      relatedIds.push({
        identifier: githubUrl,
        identifier_type: "URL",
        relation_type: "IsDescribedBy",
      });
    }
    const nemarUrl = datasetLandingUrl(datasetId, landingBaseUrl);
    if (!relatedIds.some((r) => r.identifier === nemarUrl)) {
      relatedIds.push({
        identifier: nemarUrl,
        identifier_type: "URL",
        relation_type: "IsDescribedBy",
      });
    }
    // Ensure related_identifiers is set even if only URLs were added
    if (relatedIds.length > 0) seeded.related_identifiers = relatedIds;
  }

  return seeded;
}

/**
 * Merge LLM enrichment results into a seeded NemarMetadataV2 object.
 *
 * Additive merge for related_identifiers and funding_references:
 * - BIDS-seeded IsDerivedFrom entries are preserved
 * - LLM adds new entries; duplicates are removed
 *
 * LLM overwrites: description, methods_description, keywords (LLM's domain).
 * Authors are never touched by the LLM.
 */
export function mergeWithExisting(
  existing: NemarMetadataV2 | null,
  llmResult: LlmEnrichmentResultV2,
): NemarMetadataV2 {
  const merged: NemarMetadataV2 = {
    version: "2.0",
    ...(existing ? { ...existing, version: "2.0" as const } : {}),
    pipeline_stage: "enriched",
  };

  // LLM fields overwrite (these are the LLM's domain)
  if (llmResult.description) merged.description = llmResult.description;
  if (llmResult.methods_description) merged.methods_description = llmResult.methods_description;
  if (llmResult.keywords) merged.keywords = llmResult.keywords;

  // Funding merge: LLM-parsed entries replace BIDS raw strings when the award number
  // from the LLM entry appears inside a raw BIDS funder_name string.
  if (llmResult.funding_references) {
    const existingFunds = [...(existing?.funding_references || [])];
    const allFunds: FundingReferenceEntry[] = [];

    for (const ef of existingFunds) {
      // Check if LLM provided a parsed version of this raw BIDS string
      const hasLlmReplacement =
        ef.award_number === undefined &&
        llmResult.funding_references.some(
          (lf) => lf.award_number && ef.funder_name.includes(lf.award_number),
        );
      if (!hasLlmReplacement) allFunds.push(ef);
    }
    for (const newFund of llmResult.funding_references) {
      // Deduplicate: match by exact (funder_name + award_number) or by award_number alone
      // (LLM may normalize funder names differently than BIDS)
      const isDuplicate = allFunds.some(
        (f) =>
          (f.funder_name === newFund.funder_name &&
            (f.award_number || "") === (newFund.award_number || "")) ||
          (newFund.award_number && f.award_number === newFund.award_number),
      );
      if (!isDuplicate) allFunds.push(newFund);
    }
    merged.funding_references = allFunds;
  }

  // Related identifiers merge: BIDS-seeded entries take priority for the same identifier.
  // If BIDS seeds "IsDerivedFrom" for a DOI, drop any LLM entry for the same DOI
  // (the LLM often misclassifies SourceDatasets as "IsVersionOf").
  if (llmResult.related_identifiers) {
    const existingRels = existing?.related_identifiers || [];
    const seededIdentifiers = new Set(existingRels.map((r) => r.identifier));
    const allRels = [...existingRels];
    for (const newRel of llmResult.related_identifiers) {
      // Skip LLM entries for identifiers already seeded from BIDS
      if (seededIdentifiers.has(newRel.identifier)) continue;
      const key = `${newRel.identifier}|${newRel.relation_type}`;
      const exists = allRels.some((r) => `${r.identifier}|${r.relation_type}` === key);
      if (!exists) allRels.push(newRel);
    }
    merged.related_identifiers = allRels;
  }

  // Preserve existing authors (ORCIDs, affiliations) -- LLM does not touch these
  if (existing?.authors) {
    merged.authors = existing.authors;
  }

  return merged;
}

// ---- Stage 2b: MeSH term validation (NLM API) ----

const MESH_LOOKUP_URL = "https://id.nlm.nih.gov/mesh/lookup/descriptor";

interface MeshLookupResult {
  resource: string;
  label: string;
}

/**
 * Query the NLM MeSH API with a given match strategy.
 * Returns the first result or null. API failures are non-fatal but logged.
 */
async function queryMesh(
  term: string,
  matchType: "exact" | "contains",
): Promise<{ label: string; uri: string } | null> {
  const url = `${MESH_LOOKUP_URL}?label=${encodeURIComponent(term)}&match=${matchType}&limit=1`;
  try {
    const resp = await fetch(url, { headers: { Accept: "application/json" } });
    if (!resp.ok) {
      console.warn(`[mesh] ${matchType} lookup for "${term}" returned HTTP ${resp.status}`);
      return null;
    }
    const results = (await resp.json()) as MeshLookupResult[];
    if (results.length > 0) {
      return { label: results[0].label, uri: results[0].resource };
    }
  } catch (err) {
    console.warn(
      `[mesh] ${matchType} lookup failed for "${term}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return null;
}

/**
 * Validate a single term against the NLM MeSH API.
 * Tries exact match first, then falls back to contains match.
 * Returns the canonical MeSH label and URI if found, null otherwise.
 */
async function lookupMeshTerm(term: string): Promise<{ label: string; uri: string } | null> {
  return (await queryMesh(term, "exact")) ?? (await queryMesh(term, "contains"));
}

export interface MeshValidationLog {
  term: string;
  original_scheme: string;
  action: "confirmed" | "corrected" | "scheme_removed";
  mesh_label?: string;
  mesh_uri?: string;
}

/**
 * Stage 2b: Validate keywords tagged with subject_scheme "MeSH" against the NLM API.
 *
 * For each keyword with subject_scheme "MeSH":
 * - If exact match found: keep scheme, add value_uri, use canonical label
 * - If contains match found: correct to the canonical MeSH term
 * - If no match: strip the subject_scheme (keep as plain keyword)
 *
 * Returns the updated metadata and a log of actions taken.
 */
export async function validateMeshTerms(
  metadata: NemarMetadataV2,
): Promise<{ metadata: NemarMetadataV2; log: MeshValidationLog[] }> {
  if (!metadata.keywords || metadata.keywords.length === 0) {
    return { metadata, log: [] };
  }

  const log: MeshValidationLog[] = [];
  const updatedKeywords: StructuredKeyword[] = [];

  for (const kw of metadata.keywords) {
    // Strip any non-MeSH scheme (e.g. LCSH)
    if (kw.subject_scheme && kw.subject_scheme !== "MeSH") {
      updatedKeywords.push({ term: kw.term });
      log.push({
        term: kw.term,
        original_scheme: kw.subject_scheme,
        action: "scheme_removed",
      });
      continue;
    }
    if (!kw.subject_scheme) {
      updatedKeywords.push(kw);
      continue;
    }

    const result = await lookupMeshTerm(kw.term);

    if (result && result.label.toLowerCase() === kw.term.toLowerCase()) {
      // Exact match: confirm and add URI
      updatedKeywords.push({
        ...kw,
        term: result.label,
        value_uri: result.uri,
      });
      log.push({
        term: kw.term,
        original_scheme: "MeSH",
        action: "confirmed",
        mesh_label: result.label,
        mesh_uri: result.uri,
      });
    } else if (result) {
      // Close match: correct to canonical MeSH term
      updatedKeywords.push({
        term: result.label,
        subject_scheme: "MeSH",
        scheme_uri: "https://id.nlm.nih.gov/mesh/",
        value_uri: result.uri,
      });
      log.push({
        term: kw.term,
        original_scheme: "MeSH",
        action: "corrected",
        mesh_label: result.label,
        mesh_uri: result.uri,
      });
    } else {
      // No match: strip scheme, keep as plain keyword
      updatedKeywords.push({ term: kw.term });
      log.push({
        term: kw.term,
        original_scheme: "MeSH",
        action: "scheme_removed",
      });
    }
  }

  return {
    metadata: { ...metadata, keywords: updatedKeywords },
    log,
  };
}

// ---- Stage 3: LLM Validation ----

export interface ValidationCriterion {
  confidence: number;
  pass: boolean;
  issues: string[];
  suggestions?: string[];
}

export interface ValidationResult {
  valid: boolean;
  criteria: {
    author_completeness: ValidationCriterion;
    related_identifiers: ValidationCriterion;
    description_accuracy: ValidationCriterion;
    keyword_relevance: ValidationCriterion;
    funding_accuracy: ValidationCriterion;
    data_type: ValidationCriterion;
  };
  blocking_issues: string[];
  warnings: string[];
}

const VALIDATION_PROMPT = `You are a metadata validation specialist for neuroimaging dataset DOI records.
You will receive a dataset's metadata file (.nemar/metadata.json), its README.md,
and its BIDS dataset_description.json. Your job is to validate the metadata for
accuracy, completeness, and correctness before a permanent DOI is minted.

## Validation Criteria

Rate each criterion from 0-100 confidence that the metadata is CORRECT:

### 1. Author Completeness (weight: high)
- Are ALL authors from dataset_description.json present in the metadata?
- Are there authors mentioned in the README who are missing?
- Do author names match between sources?

### 2. Related Identifier Accuracy (weight: high)
- Is each relation type correct?
  - IsDerivedFrom: this dataset was created from that source
  - IsVersionOf: this is a newer version of the same dataset
  - IsDescribedBy: a paper/page that describes this dataset (also valid for GitHub repo and NEMAR landing page URLs)
  - IsSupplementTo: this dataset supplements a publication
  - References: general citation
- Are the DOIs valid identifiers?
- Cross-check: does dataset_description.json have SourceDatasets that should be IsDerivedFrom?
- NOTE: GitHub repo URLs (github.com/nemarDatasets/...) and NEMAR landing page URLs (nemar.org/dataset/...) with relation type IsDescribedBy are CORRECT and should NOT be flagged as issues.

### 3. Description Accuracy (weight: medium)
- Does the abstract accurately describe the dataset content?
- Are claims in the description supported by the README?
- Is the methods description technically accurate?

### 4. Keyword Relevance (weight: medium)
- Do keywords accurately describe the dataset?
- Are subject scheme assignments correct (e.g., MeSH terms are real MeSH terms)?
- Are there obvious missing keywords?

### 5. Funding Accuracy (weight: medium)
- Are funder names real organizations?
- Do award numbers appear in the README or BIDS description?
- Are there funding sources mentioned in README but missing from metadata?

### 6. Data Type Correctness (weight: low)
- Is the resource_type_general field correct?
- Does it match DatasetType in dataset_description.json if present?

## Output Format

Return ONLY valid JSON:
{
  "overall_pass": true/false,
  "criteria": {
    "author_completeness": {
      "confidence": 0-100,
      "pass": true/false,
      "issues": ["specific issue"],
      "suggestions": ["specific suggestion"]
    },
    "related_identifiers": { ... },
    "description_accuracy": { ... },
    "keyword_relevance": { ... },
    "funding_accuracy": { ... },
    "data_type": { ... }
  },
  "blocking_issues": ["list of issues that MUST be fixed before DOI minting"],
  "warnings": ["list of issues that SHOULD be fixed but are not blocking"]
}

Only set overall_pass to false if there are blocking_issues.
Blocking issues: missing authors, incorrect relation types, factually wrong description.
Warnings: missing keywords, imprecise descriptions, unconfirmed funding details.`;

/**
 * Stage 3: Validate enriched metadata using an LLM judge.
 *
 * Sends metadata + README + BIDS description to OpenRouter for review.
 * If validation passes, pipeline_stage advances to "validated".
 */
export async function validateMetadata(
  metadata: NemarMetadataV2,
  readmeContent: string,
  bidsDescription: Record<string, unknown>,
  apiKey: string,
): Promise<{ metadata: NemarMetadataV2; validation: ValidationResult }> {
  const userPrompt = `## .nemar/metadata.json
\`\`\`json
${JSON.stringify(metadata, null, 2)}
\`\`\`

## BIDS dataset_description.json
\`\`\`json
${JSON.stringify(bidsDescription, null, 2)}
\`\`\`

## README.md
${truncateReadme(readmeContent)}`;

  const parsed = await callOpenRouter(VALIDATION_PROMPT, userPrompt, apiKey, 3000);
  const validation = parseValidationResult(parsed);
  const updatedMetadata: NemarMetadataV2 = {
    ...metadata,
    pipeline_stage: validation.valid ? "validated" : "enriched",
  };

  return { metadata: updatedMetadata, validation };
}

/**
 * Stage 3b: Correct enriched metadata based on validation feedback.
 *
 * Sends the current metadata, blocking issues, and source material back to the
 * LLM to fix specific problems identified by the validator. Returns corrected
 * LLM enrichment fields that can be merged back into the metadata.
 */
export async function correctFromFeedback(
  metadata: NemarMetadataV2,
  blockingIssues: string[],
  warnings: string[],
  readmeContent: string,
  bidsDescription: Record<string, unknown>,
  apiKey: string,
): Promise<LlmEnrichmentResultV2> {
  const correctionPrompt = `You are a metadata correction assistant for neuroimaging datasets.
A validation judge has reviewed the metadata and found issues that need to be fixed.
Your job is to produce CORRECTED metadata fields that address the blocking issues.

IMPORTANT:
- Only return fields that need correction. Do NOT return unchanged fields.
- Do NOT modify authors (those are locked from BIDS).
- Do NOT modify related_identifiers that were seeded from BIDS (IsDerivedFrom entries, GitHub/NEMAR URLs).
- Focus on fixing the blocking issues. Warnings are optional to address.

Return ONLY valid JSON with the corrected fields (same schema as enrichment):
{
  "description": "corrected abstract if needed",
  "methods_description": "corrected methods if needed",
  "keywords": [{"term": "...", "subject_scheme": "..."}],
  "funding_references": [{"funder_name": "...", "award_number": "..."}],
  "related_identifiers": [{"identifier": "...", "identifier_type": "DOI", "relation_type": "..."}]
}`;

  const numberedList = (items: string[]): string =>
    items.map((item, idx) => `${idx + 1}. ${item}`).join("\n");

  const userPrompt = `## Current metadata
\`\`\`json
${JSON.stringify(metadata, null, 2)}
\`\`\`

## BLOCKING ISSUES (must fix)
${numberedList(blockingIssues)}

## WARNINGS (optional to fix)
${numberedList(warnings)}

## BIDS dataset_description.json
\`\`\`json
${JSON.stringify(bidsDescription, null, 2)}
\`\`\`

## README.md
${truncateReadme(readmeContent)}`;

  const parsed = await callOpenRouter(correctionPrompt, userPrompt, apiKey, 3000);
  return validateLlmResultV2(parsed);
}

/**
 * Parse and validate the LLM judge response into a typed ValidationResult.
 */
export function parseValidationResult(raw: Record<string, unknown>): ValidationResult {
  const defaultCriterion: ValidationCriterion = {
    confidence: 0,
    pass: false,
    issues: [],
  };

  function parseCriterion(val: unknown): ValidationCriterion {
    if (!val || typeof val !== "object") return { ...defaultCriterion };
    const obj = val as Record<string, unknown>;
    return {
      confidence: typeof obj.confidence === "number" ? obj.confidence : 0,
      pass: typeof obj.pass === "boolean" ? obj.pass : false,
      issues: Array.isArray(obj.issues)
        ? obj.issues.filter((i): i is string => typeof i === "string")
        : [],
      suggestions: Array.isArray(obj.suggestions)
        ? obj.suggestions.filter((s): s is string => typeof s === "string")
        : undefined,
    };
  }

  const criteria = raw.criteria as Record<string, unknown> | undefined;
  const parsedCriteria = {
    author_completeness: parseCriterion(criteria?.author_completeness),
    related_identifiers: parseCriterion(criteria?.related_identifiers),
    description_accuracy: parseCriterion(criteria?.description_accuracy),
    keyword_relevance: parseCriterion(criteria?.keyword_relevance),
    funding_accuracy: parseCriterion(criteria?.funding_accuracy),
    data_type: parseCriterion(criteria?.data_type),
  };

  const blockingIssues = Array.isArray(raw.blocking_issues)
    ? raw.blocking_issues.filter((i): i is string => typeof i === "string")
    : [];

  const warnings = Array.isArray(raw.warnings)
    ? raw.warnings.filter((w): w is string => typeof w === "string")
    : [];

  // If overall_pass is missing AND no criteria were populated, treat as failed
  // (the LLM returned a malformed response that should not be trusted as approval)
  const hasCriteria = criteria != null && Object.keys(criteria).length > 0;
  const valid =
    typeof raw.overall_pass === "boolean"
      ? raw.overall_pass
      : hasCriteria
        ? blockingIssues.length === 0
        : false;

  return {
    valid,
    criteria: parsedCriteria,
    blocking_issues: blockingIssues,
    warnings,
  };
}
