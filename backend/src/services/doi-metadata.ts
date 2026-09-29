/**
 * Resolve what each candidate DOI actually is before the enrichment LLM
 * assigns it a relation type (#1549).
 *
 * The enrichment prompt used to see only README prose and bare DOI strings,
 * so it could not tell a dataset's own data descriptor from the EEG-BIDS
 * specification or from a typo'd DOI that resolves to an unrelated paper.
 * This module looks each DOI up (DataCite content negotiation, which answers
 * for Crossref and DataCite DOIs in one shape, with Crossref's REST API as
 * the fallback) and renders a compact "Resolved DOI metadata" block for the
 * enrichment, validation, and correction prompts.
 *
 * Bounded by design: at most {@link MAX_RESOLVED_DOIS} lookups per run, a
 * short per-request timeout, and a small concurrency window, so a slow
 * registry cannot stall enrichment or exhaust the Worker's subrequest budget.
 * A failed lookup degrades to "unresolved": the LLM then labels that DOI the
 * way it did before this module existed.
 */

import type { RelatedIdentifierEntry } from "../../../shared/datacite-constants.js";
import { normalizeDoiKey } from "../../../shared/never-data-paper.js";
import { extractDoisFromBids } from "./doi-orcid-discovery.js";

export interface ResolvedDoi {
  /** Normalized DOI (see normalizeDoiKey). */
  doi: string;
  title?: string;
  first_author?: string;
  year?: number;
  /** Journal, proceedings, or repository name. */
  container?: string;
  /** DataCite resourceTypeGeneral / resourceType, or the Crossref `type`. */
  type?: string;
}

export interface DoiResolution {
  resolved: ResolvedDoi[];
  /** Looked up, but neither registry answered. */
  unresolved: string[];
  /** Not looked up because the candidate list exceeded the cap. */
  skipped: string[];
}

export const EMPTY_DOI_RESOLUTION: DoiResolution = { resolved: [], unresolved: [], skipped: [] };

export const MAX_RESOLVED_DOIS = 15;
const RESOLVE_TIMEOUT_MS = 8_000;
const RESOLVE_CONCURRENCY = 5;
// Polite pool: identify ourselves per Crossref etiquette (same identity as
// the ORCID-discovery client in doi-orcid-discovery.ts).
const USER_AGENT = "NEMAR/1.0 (https://nemar.org; mailto:nemar@ucsd.edu)";
const DATACITE_CN = "https://api.datacite.org/application/vnd.datacite.datacite+json";

const DOI_IN_TEXT = /\b10\.\d{4,9}\/[^\s"'<>()[\]{},;]+/g;
const DOI_SHAPE = /^10\.\d{4,9}\/\S+$/;

/**
 * Every DOI the enrichment will consider, normalized and deduplicated, in
 * priority order: BIDS fields (SourceDatasets, ReferencesAndLinks,
 * HowToAcknowledge), then DOI entries already in related_identifiers, then
 * DOIs found anywhere in the README. The order decides which DOIs survive
 * the lookup cap. The dataset's own NEMAR DOI (the README badge) and its
 * version DOIs are skipped: they are the dataset itself, never a relation.
 */
export function collectCandidateDois(
  readmeContent: string,
  bidsDescription: Record<string, unknown>,
  relatedIdentifiers: RelatedIdentifierEntry[] = [],
  datasetId?: string,
): string[] {
  const ownPrefix = datasetId ? `10.82901/nemar.${datasetId.toLowerCase()}` : undefined;
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (raw: string) => {
    // Prose often ends a DOI with sentence punctuation.
    const key = normalizeDoiKey(raw).replace(/[.:]+$/, "");
    if (ownPrefix && (key === ownPrefix || key.startsWith(`${ownPrefix}.`))) return;
    if (DOI_SHAPE.test(key) && !seen.has(key)) {
      seen.add(key);
      out.push(key);
    }
  };
  for (const { doi } of extractDoisFromBids(bidsDescription)) add(doi);
  for (const r of relatedIdentifiers) {
    if (r.identifier_type === "DOI") add(r.identifier);
  }
  for (const m of readmeContent.matchAll(DOI_IN_TEXT)) add(m[0]);
  return out;
}

function firstString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function toYear(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(n) && n > 1000 && n < 3000 ? n : undefined;
}

/** Map a DataCite content-negotiation JSON document onto ResolvedDoi. */
export function parseDataCiteJson(doi: string, raw: unknown): ResolvedDoi | null {
  if (!raw || typeof raw !== "object") return null;
  const d = raw as Record<string, unknown>;
  const titles = Array.isArray(d.titles) ? (d.titles as Array<{ title?: unknown }>) : [];
  const creators = Array.isArray(d.creators)
    ? (d.creators as Array<{ name?: unknown; familyName?: unknown }>)
    : [];
  const types = (d.types ?? {}) as { resourceTypeGeneral?: unknown; resourceType?: unknown };
  const container = (d.container ?? {}) as { title?: unknown };
  const publisher = d.publisher as { name?: unknown } | string | undefined;
  const title = firstString(titles[0]?.title);
  if (!title) return null;
  return {
    doi,
    title,
    first_author: firstString(creators[0]?.familyName) ?? firstString(creators[0]?.name),
    year: toYear(d.publicationYear),
    container:
      firstString(container.title) ??
      (typeof publisher === "string" ? firstString(publisher) : firstString(publisher?.name)),
    type: firstString(types.resourceType) ?? firstString(types.resourceTypeGeneral),
  };
}

/** Map a Crossref `/works/{doi}` response onto ResolvedDoi. */
export function parseCrossrefWork(doi: string, raw: unknown): ResolvedDoi | null {
  if (!raw || typeof raw !== "object") return null;
  const m = (raw as { message?: Record<string, unknown> }).message;
  if (!m) return null;
  const title = firstString(Array.isArray(m.title) ? m.title[0] : undefined);
  if (!title) return null;
  const authors = Array.isArray(m.author)
    ? (m.author as Array<{ family?: unknown; name?: unknown }>)
    : [];
  const issued = m.issued as { "date-parts"?: unknown[][] } | undefined;
  return {
    doi,
    title,
    first_author: firstString(authors[0]?.family) ?? firstString(authors[0]?.name),
    year: toYear(issued?.["date-parts"]?.[0]?.[0]),
    container:
      firstString(Array.isArray(m["container-title"]) ? m["container-title"][0] : undefined) ??
      firstString(m.publisher),
    type: firstString(m.type),
  };
}

async function fetchJson(url: string, accept: string, label: string): Promise<unknown | null> {
  try {
    const response = await fetch(url, {
      headers: { Accept: accept, "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(RESOLVE_TIMEOUT_MS),
    });
    if (!response.ok) {
      // 404 is the ordinary "this registry does not know the DOI" answer.
      if (response.status !== 404) {
        console.warn(`[doi-metadata] ${label} returned HTTP ${response.status} for ${url}`);
      }
      return null;
    }
    return await response.json();
  } catch (err) {
    console.warn(
      `[doi-metadata] ${label} lookup failed for ${url}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/** Look one DOI up in DataCite (content negotiation covers Crossref DOIs
 *  too), then Crossref. Null when neither registry has a title for it.
 *  The Crossref leg only runs when DataCite errors or lacks a title; live
 *  registries cannot force that, so the integration suite covers the parser
 *  (parseCrossrefWork) on a live Crossref response rather than the branch. */
export async function resolveDoi(doi: string): Promise<ResolvedDoi | null> {
  const key = normalizeDoiKey(doi);
  const dc = await fetchJson(
    `${DATACITE_CN}/${encodeURIComponent(key)}`,
    "application/vnd.datacite.datacite+json",
    "DataCite",
  );
  const fromDataCite = parseDataCiteJson(key, dc);
  if (fromDataCite) return fromDataCite;
  const cr = await fetchJson(
    `https://api.crossref.org/works/${encodeURIComponent(key)}`,
    "application/json",
    "Crossref",
  );
  return parseCrossrefWork(key, cr);
}

/** Resolve up to {@link MAX_RESOLVED_DOIS} candidates, a few at a time. */
export async function resolveDoisForEnrichment(
  dois: string[],
  cap: number = MAX_RESOLVED_DOIS,
): Promise<DoiResolution> {
  const toResolve = dois.slice(0, cap);
  const resolved: ResolvedDoi[] = [];
  const unresolved: string[] = [];
  for (let i = 0; i < toResolve.length; i += RESOLVE_CONCURRENCY) {
    const chunk = toResolve.slice(i, i + RESOLVE_CONCURRENCY);
    const results = await Promise.all(chunk.map((doi) => resolveDoi(doi)));
    results.forEach((result, j) => {
      if (result) resolved.push(result);
      else unresolved.push(chunk[j]);
    });
  }
  return { resolved, unresolved, skipped: dois.slice(cap) };
}

/** Normalized DOI -> resolved title, for the title rule of the
 *  never-data-paper guard. */
export function titlesByDoi(resolution: DoiResolution): Map<string, string> {
  const titles = new Map<string, string>();
  for (const r of resolution.resolved) if (r.title) titles.set(r.doi, r.title);
  return titles;
}

/** Prompt block listing what each candidate DOI is. Empty string when there
 *  is nothing to show, so callers can append it unconditionally. */
export function formatResolvedDoiBlock(resolution: DoiResolution): string {
  const { resolved, unresolved } = resolution;
  if (resolved.length === 0 && unresolved.length === 0) return "";
  const lines = resolved.map((r) => {
    const fields = [
      `title: "${r.title}"`,
      r.first_author && `first author: ${r.first_author}`,
      r.year && `year: ${r.year}`,
      r.container && `venue: ${r.container}`,
      r.type && `type: ${r.type}`,
    ].filter(Boolean);
    return `- ${r.doi} | ${fields.join(" | ")}`;
  });
  for (const doi of unresolved) lines.push(`- ${doi} | unresolved (no registry record found)`);
  return `## Resolved DOI metadata
What each DOI in the sources actually is, looked up in DataCite / Crossref. Compare titles,
authors, and years with the dataset's own name and authors when choosing relation types.
${lines.join("\n")}`;
}
