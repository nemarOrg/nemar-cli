/**
 * Auto-discover ORCIDs from DOIs referenced in dataset_description.json.
 *
 * Queries the DataCite public API (no auth) to resolve DOIs and extract
 * creator ORCIDs and affiliations, then matches them against the dataset's
 * BIDS Authors list by name.
 */

import type { AuthorEnrichmentV2 } from "../../shared/datacite-constants.js";
import { normalizeDoi, parseAuthorName } from "./datacite.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExtractedDoi {
  doi: string;
  source: "ReferencesAndLinks" | "SourceDatasets";
}

export interface DataCiteCreator {
  name: string;
  givenName?: string;
  familyName?: string;
  nameIdentifiers: Array<{
    nameIdentifier: string;
    nameIdentifierScheme: string;
  }>;
  affiliation: Array<{
    name: string;
    affiliationIdentifier?: string;
    affiliationIdentifierScheme?: string;
  }>;
}

export interface DataCiteDoiResult {
  doi: string;
  creators: DataCiteCreator[];
}

export type MatchConfidence = "exact" | "high" | "medium";

export interface NameMatchResult {
  bidsAuthor: string;
  matchedCreator: DataCiteCreator;
  confidence: MatchConfidence;
}

export interface OrcidDiscovery {
  orcid: string;
  affiliations?: Array<{ name: string; identifier?: string; scheme?: string }>;
  sourceDoi: string;
  confidence: MatchConfidence;
}

export interface OrcidDiscoveryResult {
  discoveries: Record<string, OrcidDiscovery>;
  unresolvedDois: string[];
  totalDoisQueried: number;
}

// ---------------------------------------------------------------------------
// DOI extraction from BIDS dataset_description.json
// ---------------------------------------------------------------------------

const DOI_PATTERN = /^10\.\d{4,}\/.+$/;

export function extractDoisFromBids(
  bidsDescription: Record<string, unknown>,
): ExtractedDoi[] {
  const dois: ExtractedDoi[] = [];
  const seen = new Set<string>();

  const addDoi = (doi: string, source: ExtractedDoi["source"]) => {
    const normalized = normalizeDoi(doi).trim();
    if (DOI_PATTERN.test(normalized) && !seen.has(normalized)) {
      seen.add(normalized);
      dois.push({ doi: normalized, source });
    }
  };

  // SourceDatasets[].DOI and SourceDatasets[].URL
  if (Array.isArray(bidsDescription.SourceDatasets)) {
    for (const src of bidsDescription.SourceDatasets) {
      if (!src || typeof src !== "object") continue;
      const obj = src as Record<string, unknown>;
      if (typeof obj.DOI === "string") {
        addDoi(obj.DOI, "SourceDatasets");
      } else if (typeof obj.URL === "string") {
        const m = obj.URL.match(/(?:doi\.org\/|doi:)(10\.\d{4,}\/.+)/);
        if (m) addDoi(m[1], "SourceDatasets");
      }
    }
  }

  // ReferencesAndLinks[]
  if (Array.isArray(bidsDescription.ReferencesAndLinks)) {
    for (const ref of bidsDescription.ReferencesAndLinks) {
      if (typeof ref !== "string" || !ref) continue;
      const m = ref.match(/(?:doi\.org\/|^)(10\.\d{4,}\/.+)/);
      if (m) addDoi(m[1], "ReferencesAndLinks");
    }
  }

  return dois;
}

// ---------------------------------------------------------------------------
// DataCite public API client
// ---------------------------------------------------------------------------

const DATACITE_API = "https://api.datacite.org/application/vnd.datacite.datacite+json";

export async function queryDataCiteDoi(
  doi: string,
): Promise<DataCiteDoiResult | null> {
  try {
    const response = await fetch(`${DATACITE_API}/${encodeURIComponent(doi)}`, {
      headers: { Accept: "application/vnd.datacite.datacite+json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return null;
    const data = (await response.json()) as {
      creators?: DataCiteCreator[];
    };
    return {
      doi,
      creators: Array.isArray(data.creators) ? data.creators : [],
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Name matching
// ---------------------------------------------------------------------------

function normalizeStr(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // strip accents
    .toLowerCase()
    .trim();
}

function firstInitial(givenName: string | undefined): string {
  if (!givenName) return "";
  return normalizeStr(givenName).charAt(0);
}

export function matchCreatorsToAuthors(
  creators: DataCiteCreator[],
  bidsAuthors: string[],
): NameMatchResult[] {
  const results: NameMatchResult[] = [];
  const matchedAuthors = new Set<string>();
  const matchedCreatorIdx = new Set<number>();

  // Parse all BIDS authors upfront
  const parsedAuthors = bidsAuthors.map((a) => ({
    original: a,
    parsed: parseAuthorName(a),
  }));

  // Pass 1: exact full-name match
  for (let ci = 0; ci < creators.length; ci++) {
    if (matchedCreatorIdx.has(ci)) continue;
    const c = creators[ci];
    const cNorm = normalizeStr(c.name);

    for (const a of parsedAuthors) {
      if (matchedAuthors.has(a.original)) continue;
      // Compare normalized full name (handles "Last, First" vs "Last, First")
      if (normalizeStr(a.original) === cNorm) {
        results.push({ bidsAuthor: a.original, matchedCreator: c, confidence: "exact" });
        matchedAuthors.add(a.original);
        matchedCreatorIdx.add(ci);
        break;
      }
      // Also try "First Last" == "Last, First" cross-format
      if (a.parsed.familyName && a.parsed.givenName) {
        const aFlipped = normalizeStr(`${a.parsed.givenName} ${a.parsed.familyName}`);
        if (aFlipped === cNorm) {
          results.push({ bidsAuthor: a.original, matchedCreator: c, confidence: "exact" });
          matchedAuthors.add(a.original);
          matchedCreatorIdx.add(ci);
          break;
        }
      }
    }
  }

  // Pass 2: family name + first initial
  for (let ci = 0; ci < creators.length; ci++) {
    if (matchedCreatorIdx.has(ci)) continue;
    const c = creators[ci];
    if (!c.familyName) continue;
    const cFamily = normalizeStr(c.familyName);
    const cInitial = firstInitial(c.givenName);

    for (const a of parsedAuthors) {
      if (matchedAuthors.has(a.original)) continue;
      if (!a.parsed.familyName) continue;
      const aFamily = normalizeStr(a.parsed.familyName);
      if (aFamily !== cFamily) continue;
      const aInitial = firstInitial(a.parsed.givenName);
      if (aInitial && cInitial && aInitial === cInitial) {
        results.push({ bidsAuthor: a.original, matchedCreator: c, confidence: "high" });
        matchedAuthors.add(a.original);
        matchedCreatorIdx.add(ci);
        break;
      }
    }
  }

  // Pass 3: family name only (medium confidence)
  for (let ci = 0; ci < creators.length; ci++) {
    if (matchedCreatorIdx.has(ci)) continue;
    const c = creators[ci];
    if (!c.familyName) continue;
    const cFamily = normalizeStr(c.familyName);

    for (const a of parsedAuthors) {
      if (matchedAuthors.has(a.original)) continue;
      if (!a.parsed.familyName) continue;
      if (normalizeStr(a.parsed.familyName) === cFamily) {
        results.push({ bidsAuthor: a.original, matchedCreator: c, confidence: "medium" });
        matchedAuthors.add(a.original);
        matchedCreatorIdx.add(ci);
        break;
      }
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Main discovery function
// ---------------------------------------------------------------------------

const BATCH_SIZE = 5;

export async function discoverOrcidsFromReferencedDois(
  bidsDescription: Record<string, unknown>,
  existingAuthors?: Record<string, AuthorEnrichmentV2>,
): Promise<OrcidDiscoveryResult> {
  const extracted = extractDoisFromBids(bidsDescription);
  if (extracted.length === 0) {
    return { discoveries: {}, unresolvedDois: [], totalDoisQueried: 0 };
  }

  const bidsAuthors = Array.isArray(bidsDescription.Authors)
    ? (bidsDescription.Authors as unknown[]).filter((a): a is string => typeof a === "string")
    : [];
  if (bidsAuthors.length === 0) {
    return { discoveries: {}, unresolvedDois: [], totalDoisQueried: extracted.length };
  }

  // Authors that already have ORCIDs
  const alreadyEnriched = new Set<string>();
  if (existingAuthors) {
    for (const [name, data] of Object.entries(existingAuthors)) {
      if (data.orcid) alreadyEnriched.add(name);
    }
  }

  // Authors still needing ORCIDs
  const needsOrcid = bidsAuthors.filter((a) => !alreadyEnriched.has(a));
  if (needsOrcid.length === 0) {
    return { discoveries: {}, unresolvedDois: [], totalDoisQueried: extracted.length };
  }

  // Query DOIs in batches
  const unresolvedDois: string[] = [];
  const allCreatorsByDoi = new Map<string, DataCiteCreator[]>();

  for (let i = 0; i < extracted.length; i += BATCH_SIZE) {
    const batch = extracted.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map((e) => queryDataCiteDoi(e.doi)),
    );
    for (let j = 0; j < batch.length; j++) {
      const r = results[j];
      if (r.status === "fulfilled" && r.value) {
        allCreatorsByDoi.set(batch[j].doi, r.value.creators);
      } else {
        unresolvedDois.push(batch[j].doi);
      }
    }
  }

  // Match creators to authors and extract ORCIDs
  const discoveries: Record<string, OrcidDiscovery> = {};

  for (const [doi, creators] of allCreatorsByDoi) {
    // Only match creators that have ORCIDs
    const creatorsWithOrcid = creators.filter((c) =>
      c.nameIdentifiers?.some((ni) => ni.nameIdentifierScheme === "ORCID"),
    );
    if (creatorsWithOrcid.length === 0) continue;

    const matches = matchCreatorsToAuthors(creatorsWithOrcid, needsOrcid);
    for (const match of matches) {
      if (discoveries[match.bidsAuthor]) continue; // first DOI wins

      const orcidEntry = match.matchedCreator.nameIdentifiers.find(
        (ni) => ni.nameIdentifierScheme === "ORCID",
      );
      if (!orcidEntry) continue;

      // Extract bare ORCID (strip URL prefix)
      const orcid = orcidEntry.nameIdentifier
        .replace(/^https?:\/\/orcid\.org\//i, "")
        .trim();

      const affiliations = match.matchedCreator.affiliation
        ?.filter((a) => a.name)
        .map((a) => ({
          name: a.name,
          ...(a.affiliationIdentifier && { identifier: a.affiliationIdentifier }),
          ...(a.affiliationIdentifierScheme && { scheme: a.affiliationIdentifierScheme }),
        }));

      discoveries[match.bidsAuthor] = {
        orcid,
        affiliations: affiliations?.length ? affiliations : undefined,
        sourceDoi: doi,
        confidence: match.confidence,
      };
    }
  }

  return {
    discoveries,
    unresolvedDois,
    totalDoisQueried: extracted.length,
  };
}
