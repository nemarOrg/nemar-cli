/**
 * LLM-based metadata enrichment using OpenRouter API
 *
 * Extracts structured metadata from README.md and BIDS dataset_description.json
 * for populating DataCite DOI records. Runs CLI-side (not in Cloudflare Workers).
 */

export interface LlmEnrichmentResult {
  description?: string;
  methodsDescription?: string;
  keywords?: string[];
  fundingReferences?: Array<{
    funderName: string;
    awardNumber?: string;
    awardTitle?: string;
  }>;
  relatedDois?: Array<{ doi: string; relationType: string }>;
}

const SYSTEM_PROMPT = `You are a metadata extraction assistant for neuroimaging datasets.
Given a README and BIDS dataset description, extract structured metadata for a DataCite DOI record.

Return ONLY valid JSON with these optional fields:
{
  "description": "A concise abstract (2-4 sentences) describing the dataset's content, purpose, and scientific context.",
  "methodsDescription": "A brief description of data collection methods if mentioned in the README.",
  "keywords": ["keyword1", "keyword2"],
  "fundingReferences": [{"funderName": "NIH", "awardNumber": "R01-MH123456", "awardTitle": "optional title"}],
  "relatedDois": [{"doi": "10.1234/example", "relationType": "IsSupplementTo"}]
}

Rules:
- description: Write a scholarly abstract. Do not copy verbatim from README.
- methodsDescription: Only include if methods/acquisition details are described.
- keywords: 3-8 domain-specific terms. Include modality (EEG, MEG, etc.) if applicable.
- fundingReferences: Parse funding strings into structured format. Common funders: NIH, NSF, ERC, DFG.
- relatedDois: Only include actual DOIs (10.XXXX/...). Valid relationType values:
  IsCitedBy, Cites, IsSupplementTo, IsSupplementedBy, References, IsReferencedBy,
  IsDescribedBy, Describes, IsVersionOf, HasVersion, IsPartOf, HasPart
- Omit any field where you have no information. Return {} if nothing can be extracted.
- Do NOT hallucinate DOIs or funding numbers.`;

/**
 * Extract structured metadata from README content and BIDS description using an LLM.
 *
 * @param readmeContent - Raw README.md content
 * @param bidsDescription - Parsed dataset_description.json
 * @param apiKey - OpenRouter API key (from env OPENROUTER_API_KEY or config)
 * @returns Extracted metadata, or empty object if LLM is unavailable
 */
export async function enrichFromReadme(
  readmeContent: string,
  bidsDescription: Record<string, unknown>,
  apiKey?: string,
): Promise<LlmEnrichmentResult> {
  const key = apiKey || process.env.OPENROUTER_API_KEY;
  if (!key) {
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

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "anthropic/claude-haiku-4-5-20251001",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.1,
      max_tokens: 2000,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenRouter API error (${response.status}): ${errorText}`);
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };

  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("No content in LLM response");
  }

  // Extract JSON from response (may be wrapped in markdown code block)
  const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, content];
  const jsonStr = (jsonMatch[1] || content).trim();

  const parsed = JSON.parse(jsonStr) as Record<string, unknown>;
  return validateLlmResult(parsed);
}

/**
 * Validate and clean the LLM response to match the expected schema.
 */
function validateLlmResult(raw: Record<string, unknown>): LlmEnrichmentResult {
  const result: LlmEnrichmentResult = {};

  if (typeof raw.description === "string" && raw.description) {
    result.description = raw.description;
  }

  if (typeof raw.methodsDescription === "string" && raw.methodsDescription) {
    result.methodsDescription = raw.methodsDescription;
  }

  if (Array.isArray(raw.keywords)) {
    const kw = raw.keywords.filter((k): k is string => typeof k === "string");
    if (kw.length > 0) result.keywords = kw;
  }

  if (Array.isArray(raw.fundingReferences)) {
    const funds = raw.fundingReferences.filter(
      (f): f is { funderName: string; awardNumber?: string; awardTitle?: string } =>
        !!f &&
        typeof f === "object" &&
        typeof (f as Record<string, unknown>).funderName === "string",
    );
    if (funds.length > 0) result.fundingReferences = funds;
  }

  if (Array.isArray(raw.relatedDois)) {
    const doiPattern = /^10\.\d{4,}\/.+$/;
    const rels = raw.relatedDois.filter(
      (r): r is { doi: string; relationType: string } =>
        !!r &&
        typeof r === "object" &&
        typeof (r as Record<string, unknown>).doi === "string" &&
        doiPattern.test((r as Record<string, unknown>).doi as string) &&
        typeof (r as Record<string, unknown>).relationType === "string",
    );
    if (rels.length > 0) result.relatedDois = rels;
  }

  return result;
}
