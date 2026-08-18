/**
 * Backend LLM-based metadata enrichment service (Workers-compatible)
 *
 * Extracts structured v2 metadata from README.md and BIDS dataset_description.json
 * using Claude on the Claude Platform on AWS (Anthropic-operated Messages API,
 * billed through the lab's AWS Marketplace allocation — NOT Amazon Bedrock).
 * Designed for server-side use in Cloudflare Workers webhooks.
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

/** Exact model ID — the Anthropic API has no rolling "latest" alias, so
 *  version bumps are a deliberate one-line change here. */
const CLAUDE_MODEL = "claude-sonnet-5";

/** Accumulated token usage across the LLM calls of one enrichment run,
 *  from the Messages API `usage` field. Feeds the cost estimate surfaced
 *  in the enrichment response body. */
export interface LlmUsage {
  calls: number;
  input_tokens: number;
  output_tokens: number;
}

/** Estimated cost in USD for accumulated usage at claude-sonnet-5 standard
 *  rates ($3 / $15 per MTok). Intro pricing through 2026-08-31 is lower, so
 *  this reads slightly conservative until then. */
export function estimateUsageCostUsd(usage: LlmUsage): number {
  const usd = (usage.input_tokens * 3 + usage.output_tokens * 15) / 1_000_000;
  return Math.round(usd * 10000) / 10000;
}

/** Connection settings for the Claude Platform on AWS Messages endpoint.
 *  All three are required: the endpoint rejects any request that lacks the
 *  `anthropic-workspace-id` header. */
export interface LlmClientConfig {
  /** Long-lived API key from AWS Console -> Claude Platform on AWS -> API keys. */
  apiKey: string;
  /** e.g. https://aws-external-anthropic.us-east-2.api.aws */
  baseUrl: string;
  /** Workspace ID (wrkspc_...) the key is authorized on. */
  workspaceId: string;
  /** Optional accumulator; each callClaude adds its response usage to it. */
  usage?: LlmUsage;
}

interface ClaudeMessagesResponse {
  content?: Array<{ type?: string; text?: string }>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

/**
 * Call the Claude Messages API and extract a parsed JSON object from the response.
 *
 * Handles markdown code block unwrapping and JSON parsing.
 * Throws on HTTP errors, missing content, or invalid JSON.
 *
 * maxTokens must leave headroom for adaptive thinking, which counts toward
 * the cap; effort is pinned low since these are mechanical extraction tasks.
 */
async function callClaude(
  systemPrompt: string,
  userPrompt: string,
  config: LlmClientConfig,
  maxTokens = 4000,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${config.baseUrl}/v1/messages`, {
    method: "POST",
    headers: {
      "x-api-key": config.apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-workspace-id": config.workspaceId,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: maxTokens,
      system: systemPrompt,
      output_config: { effort: "low" },
      messages: [{ role: "user", content: userPrompt }],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Claude API error (${response.status}): ${errorText}`);
  }

  const data = (await response.json()) as ClaudeMessagesResponse;
  if (config.usage && data.usage) {
    config.usage.calls += 1;
    config.usage.input_tokens += data.usage.input_tokens ?? 0;
    config.usage.output_tokens += data.usage.output_tokens ?? 0;
  }
  const content = data.content?.find((block) => block.type === "text")?.text;
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
- related_identifiers: Only include actual DOIs (10.XXXX/...) with identifier_type "DOI".
  The relation_type is CRITICAL for downstream citation attribution. Assign it by what the
  paper IS to THIS dataset, not by where the DOI appeared:
  * IsDescribedBy or IsSupplementTo: ONLY for a paper that introduces or describes THIS
    dataset's own data (its data paper / data descriptor). A dataset has at most one or two
    such papers.
  * References: everything this dataset merely uses or cites — shared paradigm/stimulus
    resources (e.g. ERP CORE), other datasets it reuses (e.g. HBN-EEG), standards and
    specification papers (e.g. BIDS, iEEG-BIDS), methods/analysis papers, and software
    papers (e.g. EEGLAB, MNE-Python, fMRIPrep). A paper describing a STANDARD or RESOURCE
    the dataset follows is NOT the dataset's data paper.
  * IsDerivedFrom: a source dataset this dataset was created from.
  * When unsure whether a paper is THIS dataset's own data paper, use References.
- Omit any field where you have no information. Return {} if nothing can be extracted.
- Do NOT hallucinate DOIs or funding numbers. Include a DOI ONLY when it appears verbatim
  in the README or dataset description. If a paper is cited without a DOI, OMIT it —
  NEVER construct or recall a DOI for a textual citation.`;

/**
 * Extract structured v2 metadata from README and BIDS description using an LLM.
 *
 * @param readmeContent - Raw README.md content
 * @param bidsDescription - Parsed dataset_description.json
 * @param config - Claude Platform on AWS connection settings
 * @returns Extracted metadata in v2 format
 */
export async function enrichFromReadme(
  readmeContent: string,
  bidsDescription: Record<string, unknown>,
  config: LlmClientConfig,
): Promise<LlmEnrichmentResultV2> {
  const userPrompt = `## BIDS dataset_description.json
\`\`\`json
${JSON.stringify(bidsDescription, null, 2)}
\`\`\`

## README.md
${truncateReadme(readmeContent)}`;

  const parsed = await callClaude(SYSTEM_PROMPT, userPrompt, config);
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
 * Drop DOI related_identifiers that do not appear in the dataset's source
 * material (README + dataset_description.json).
 *
 * LLMs sometimes fabricate plausible DOIs for papers the README cites only
 * as text (#826 diligence: on004100 got two invented 10.1093/brain/... DOIs,
 * one pointing at an unrelated glioblastoma paper). Every legitimate
 * related-identifier DOI in this pipeline originates from the README or the
 * BIDS description, so source presence is a safe, deterministic filter.
 * IsDerivedFrom entries (BIDS SourceDatasets, which may express the DOI as a
 * resolver URL) and URL entries are exempt. Applied to LLM output before
 * merging AND to carried-forward metadata, so past hallucinations self-heal
 * on re-enrichment.
 */
export function pruneUnsourcedDois<
  T extends { related_identifiers?: RelatedIdentifierEntry[] },
>(target: T, readmeContent: string, bidsDescription: Record<string, unknown>): T {
  if (!target.related_identifiers || target.related_identifiers.length === 0) return target;
  const sourceText = `${readmeContent}\n${JSON.stringify(bidsDescription)}`.toLowerCase();
  const kept = target.related_identifiers.filter(
    (r) =>
      r.identifier_type !== "DOI" ||
      r.relation_type === "IsDerivedFrom" ||
      sourceText.includes(r.identifier.toLowerCase()),
  );
  if (kept.length === target.related_identifiers.length) return target;
  return { ...target, related_identifiers: kept };
}

/**
 * Merge LLM enrichment results into a seeded NemarMetadataV2 object.
 *
 * related_identifiers: BIDS-seeded IsDerivedFrom entries and URL entries are
 * locked; other DOI entries are reclassifiable by the LLM (#826); new entries
 * are added with duplicates removed. funding_references merge additively with
 * LLM-parsed entries replacing matching raw BIDS strings.
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

  // Related identifiers merge. Two classes of existing entries are locked:
  // - IsDerivedFrom (seeded from BIDS SourceDatasets; the LLM often
  //   misclassifies these as "IsVersionOf")
  // - URL entries (the GitHub repo / NEMAR landing links)
  // Every other DOI entry is RECLASSIFIABLE: the LLM's relation_type replaces
  // the existing one in place (#826). This lets re-enrichment both upgrade a
  // data paper that ReferencesAndLinks seeded as mere "References" to
  // IsDescribedBy, and downgrade a standard/resource paper a prior run wrongly
  // tagged IsDescribedBy back to References.
  if (llmResult.related_identifiers) {
    const existingRels = existing?.related_identifiers || [];
    const allRels = existingRels.map((r) => ({ ...r }));
    for (const newRel of llmResult.related_identifiers) {
      const current = allRels.find((r) => r.identifier === newRel.identifier);
      if (current) {
        const locked = current.relation_type === "IsDerivedFrom" || current.identifier_type === "URL";
        if (!locked) current.relation_type = newRel.relation_type;
        continue;
      }
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
  - IsDescribedBy: a paper that introduces/describes THIS dataset's own data — its data
    paper (also valid for GitHub repo and NEMAR landing page URLs)
  - IsSupplementTo: this dataset supplements that publication (also a data-paper relation)
  - References: general citation — reused paradigm/stimulus resources (e.g. ERP CORE),
    standards/specification papers (e.g. BIDS, iEEG-BIDS), methods and software papers
    (e.g. EEGLAB, MNE-Python, fMRIPrep)
- FLAG as a blocking issue any DOI tagged IsDescribedBy/IsSupplementTo whose paper is a
  standard, shared resource, or method/software paper rather than this dataset's own data
  paper — and the reverse: this dataset's own data paper tagged as mere References.
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
 * Sends metadata + README + BIDS description to Claude for review.
 * If validation passes, pipeline_stage advances to "validated".
 */
export async function validateMetadata(
  metadata: NemarMetadataV2,
  readmeContent: string,
  bidsDescription: Record<string, unknown>,
  config: LlmClientConfig,
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

  const parsed = await callClaude(VALIDATION_PROMPT, userPrompt, config, 6000);
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
  config: LlmClientConfig,
): Promise<LlmEnrichmentResultV2> {
  const correctionPrompt = `You are a metadata correction assistant for neuroimaging datasets.
A validation judge has reviewed the metadata and found issues that need to be fixed.
Your job is to produce CORRECTED metadata fields that address the blocking issues.

IMPORTANT:
- Only return fields that need correction. Do NOT return unchanged fields.
- Do NOT modify authors (those are locked from BIDS).
- Do NOT modify IsDerivedFrom entries or GitHub/NEMAR URL entries in related_identifiers.
  You MAY reclassify other DOI relation_types — e.g. correct THIS dataset's own data paper
  to IsDescribedBy, or a standard/resource/software paper wrongly tagged IsDescribedBy
  back to References.
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

  const parsed = await callClaude(correctionPrompt, userPrompt, config, 6000);
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
