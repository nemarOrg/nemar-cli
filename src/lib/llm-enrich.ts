/**
 * LLM-based metadata enrichment via Claude Platform on AWS (CLI-side)
 *
 * Extracts structured v2 metadata from README.md and BIDS dataset_description.json
 * for populating DataCite DOI records. Used by `nemar admin doi enrich`.
 *
 * Uses the Anthropic-operated Messages API billed through AWS Marketplace
 * (NOT Bedrock). Requires ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL, and
 * ANTHROPIC_WORKSPACE_ID; requests without the anthropic-workspace-id
 * header are rejected by the endpoint.
 */

import {
  type FundingReferenceEntry,
  type RelatedIdentifierEntry,
  type StructuredKeyword,
  isValidRelationType,
} from "../../shared/datacite-constants.js";

/** v2 LLM enrichment result (snake_case, structured fields). */
export interface LlmEnrichmentResult {
  description?: string;
  methods_description?: string;
  keywords?: StructuredKeyword[];
  funding_references?: FundingReferenceEntry[];
  related_identifiers?: RelatedIdentifierEntry[];
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
- keywords: 3-8 domain-specific terms. Include modality (EEG, MEG, etc.) if applicable. Use subject_scheme "MeSH" ONLY when the term is a valid MeSH descriptor. Do NOT use "LCSH" or any other scheme.
- funding_references: Parse funding strings into structured format. Common funders: NIH, NSF, ERC, DFG. Use funder_name (not funderName).
- related_identifiers: Only include actual DOIs (10.XXXX/...) with identifier_type "DOI". Common relation_type values:
  IsCitedBy, Cites, IsSupplementTo, IsSupplementedBy, References, IsReferencedBy,
  IsDescribedBy, Describes, IsVersionOf, HasVersion, IsPartOf, HasPart
- Omit any field where you have no information. Return {} if nothing can be extracted.
- Do NOT hallucinate DOIs or funding numbers.`;

/**
 * Extract structured metadata from README content and BIDS description using an LLM.
 *
 * @param readmeContent - Raw README.md content
 * @param bidsDescription - Parsed dataset_description.json
 * @param apiKey - Claude Platform on AWS key (from env ANTHROPIC_API_KEY or config)
 * @returns Extracted metadata in v2 format, or empty object if LLM is unavailable
 */
export async function enrichFromReadme(
  readmeContent: string,
  bidsDescription: Record<string, unknown>,
  apiKey?: string,
): Promise<LlmEnrichmentResult> {
  const key = apiKey || process.env.ANTHROPIC_API_KEY;
  const baseUrl = process.env.ANTHROPIC_BASE_URL;
  const workspaceId = process.env.ANTHROPIC_WORKSPACE_ID;
  if (!key || !baseUrl || !workspaceId) {
    console.warn(
      "[llm-enrich] ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL / ANTHROPIC_WORKSPACE_ID not configured. Skipping LLM enrichment.",
    );
    return {};
  }

  // Truncate README to avoid token limits (keep first ~8000 chars)
  const truncatedReadme =
    readmeContent.length > 8000 ? `${readmeContent.slice(0, 8000)}\n[truncated]` : readmeContent;

  const userPrompt = `## BIDS dataset_description.json
\`\`\`json
${JSON.stringify(bidsDescription, null, 2)}
\`\`\`

## README.md
${truncatedReadme}`;

  const response = await fetch(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers: {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "anthropic-workspace-id": workspaceId,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      // Exact model ID; the API has no rolling "latest" alias. max_tokens
      // leaves headroom for adaptive thinking, which counts toward the cap.
      model: "claude-sonnet-5",
      max_tokens: 4000,
      system: SYSTEM_PROMPT,
      output_config: { effort: "low" },
      messages: [{ role: "user", content: userPrompt }],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Claude API error (${response.status}): ${errorText}`);
  }

  const data = (await response.json()) as {
    content?: Array<{ type?: string; text?: string }>;
  };

  const content = data.content?.find((block) => block.type === "text")?.text;
  if (!content) {
    throw new Error("No content in LLM response");
  }

  // Extract JSON from response (may be wrapped in markdown code block)
  const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, content];
  const jsonStr = (jsonMatch[1] || content).trim();

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(jsonStr) as Record<string, unknown>;
  } catch (parseErr) {
    throw new Error(
      `LLM returned invalid JSON: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`,
    );
  }
  return validateLlmResult(parsed);
}

/**
 * Validate and clean the LLM response to match v2 schema.
 */
export function validateLlmResult(raw: Record<string, unknown>): LlmEnrichmentResult {
  const result: LlmEnrichmentResult = {};

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
          // Only preserve MeSH scheme; strip all others (LCSH, etc.)
          if (typeof obj.subject_scheme === "string" && obj.subject_scheme === "MeSH") {
            entry.subject_scheme = obj.subject_scheme;
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
