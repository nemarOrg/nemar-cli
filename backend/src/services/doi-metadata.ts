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
 * Bounded by design: at most {@link MAX_RESOLVED_DOIS} lookups per run and a
 * small concurrency window, so a slow registry cannot stall enrichment or
 * exhaust the Worker's subrequest budget. Lookups go through the run's
 * registry cache (doi-registry.ts), so a DOI that ORCID discovery already
 * fetched costs nothing here. A lookup that got no answer is `failed`, not
 * `unresolved`: the run still completes, labeling that DOI the way it did
 * before this module existed, and the reindex response reports the count and
 * a warning so the operator can reindex the dataset again (nothing in the
 * backend retries).
 */

import type { RelatedIdentifierEntry } from "../../../shared/datacite-constants.js";
import { isOwnNemarDoi, normalizeDoiKey } from "../../../shared/never-data-paper.js";
import { extractDoisFromBids } from "./doi-orcid-discovery.js";
import { type RegistryCache, type RegistryRecord, fetchRegistryRecord } from "./doi-registry.js";

export interface ResolvedDoi {
  /** Normalized DOI (see normalizeDoiKey). */
  doi: string;
  title?: string;
  first_author?: string;
  year?: number;
  /** Journal, proceedings, or repository name. */
  container?: string;
  /** DataCite resourceType (else resourceTypeGeneral), or the Crossref `type`. */
  type?: string;
  /** DataCite resourceTypeGeneral only; never set from Crossref. `Dataset`
   *  is what licenses a References -> IsDerivedFrom promotion. */
  resource_type_general?: string;
}

export interface DoiResolution {
  resolved: ResolvedDoi[];
  /** Every registry asked answered that it has no usable record. */
  unresolved: string[];
  /** At least one registry gave no answer (429, 5xx, timeout, network) and
   *  none resolved the DOI. Worth retrying; says nothing about the DOI. */
  failed: string[];
  /** Not looked up because the candidate list exceeded the cap. */
  skipped: string[];
}

/** Counts only, for the enrichment and reindex response bodies. */
export interface DoiResolutionSummary {
  resolved: number;
  unresolved: number;
  failed: number;
  skipped: number;
}

export const EMPTY_DOI_RESOLUTION: DoiResolution = {
  resolved: [],
  unresolved: [],
  failed: [],
  skipped: [],
};

export const MAX_RESOLVED_DOIS = 15;
const RESOLVE_CONCURRENCY = 5;
/** Overall budget for stage 1d. One chunk's worst case is a DataCite
 *  timeout followed by a Crossref timeout (10 s each, doi-registry.ts), so
 *  25 s lets a single slow chunk run its course while the whole stage stays
 *  well under the ~60 s three hung chunks would otherwise take. Lookups not
 *  finished by then count as `failed`. */
export const RESOLVE_DEADLINE_MS = 25_000;
const MAX_TITLE_CHARS = 300;
const MAX_FIELD_CHARS = 120;

// Same character class as nemar-citations' `_DOI_BARE`: parentheses are kept
// so `10.1016/S0006-3223(99)00000-0` survives, and normalizeDoiKey trims the
// unmatched `)` of a DOI captured from `(see 10.x/y)` or a Markdown link.
const DOI_IN_TEXT = /\b10\.\d{4,9}\/[-._;()/:\w]+/gi;
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
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (raw: string) => {
    const key = normalizeDoiKey(raw);
    if (isOwnNemarDoi(key, datasetId)) return;
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

/**
 * Registry text is untrusted: it lands in an LLM prompt. Strip markup
 * (Crossref titles carry `<i>`, `<scp>`, `<sub>`), control characters, and
 * line breaks, so a title cannot open a new prompt section; swap double
 * quotes for single ones, since titles are shown quoted; and cap the length.
 */
export function sanitizeRegistryText(value: string, maxChars: number): string {
  const flat = value
    .replace(/<[^>]*>/g, " ")
    .replace(/\p{Cc}/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/"/g, "'");
  return flat.length > maxChars ? `${flat.slice(0, maxChars - 3).trimEnd()}...` : flat;
}

function cleanString(value: unknown, maxChars = MAX_FIELD_CHARS): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = sanitizeRegistryText(value, maxChars);
  return clean || undefined;
}

function toYear(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(n) && n > 1000 && n < 3000 ? n : undefined;
}

/** Map a DataCite content-negotiation JSON document onto ResolvedDoi. Null
 *  when the document has no usable title. */
export function parseDataCiteJson(doi: string, raw: unknown): ResolvedDoi | null {
  if (!raw || typeof raw !== "object") return null;
  const d = raw as Record<string, unknown>;
  const titles = Array.isArray(d.titles) ? (d.titles as Array<{ title?: unknown } | null>) : [];
  const creators = Array.isArray(d.creators)
    ? (d.creators as Array<{ name?: unknown; familyName?: unknown } | null>)
    : [];
  const types = (d.types ?? {}) as { resourceTypeGeneral?: unknown; resourceType?: unknown };
  const container = (d.container ?? {}) as { title?: unknown };
  const publisher = d.publisher as { name?: unknown } | string | null | undefined;
  const title = cleanString(titles[0]?.title, MAX_TITLE_CHARS);
  if (!title) return null;
  return {
    doi,
    title,
    first_author: cleanString(creators[0]?.familyName) ?? cleanString(creators[0]?.name),
    year: toYear(d.publicationYear),
    container:
      cleanString(container.title) ??
      (typeof publisher === "string" ? cleanString(publisher) : cleanString(publisher?.name)),
    type: cleanString(types.resourceType) ?? cleanString(types.resourceTypeGeneral),
    resource_type_general: cleanString(types.resourceTypeGeneral),
  };
}

/** Map a Crossref `/works/{doi}` response onto ResolvedDoi. Null when the
 *  response has no usable title. */
export function parseCrossrefWork(doi: string, raw: unknown): ResolvedDoi | null {
  if (!raw || typeof raw !== "object") return null;
  const m = (raw as { message?: Record<string, unknown> | null }).message;
  if (!m || typeof m !== "object") return null;
  const title = cleanString(Array.isArray(m.title) ? m.title[0] : undefined, MAX_TITLE_CHARS);
  if (!title) return null;
  const authors = Array.isArray(m.author)
    ? (m.author as Array<{ family?: unknown; name?: unknown } | null>)
    : [];
  const issued = m.issued as { "date-parts"?: unknown } | null | undefined;
  const dateParts = issued?.["date-parts"];
  const firstPart = Array.isArray(dateParts) && Array.isArray(dateParts[0]) ? dateParts[0] : [];
  return {
    doi,
    title,
    first_author: cleanString(authors[0]?.family) ?? cleanString(authors[0]?.name),
    year: toYear(firstPart[0]),
    container:
      cleanString(Array.isArray(m["container-title"]) ? m["container-title"][0] : undefined) ??
      cleanString(m.publisher),
    type: cleanString(m.type),
  };
}

export type DoiLookup =
  | { status: "resolved"; record: ResolvedDoi }
  | { status: "unresolved" }
  | { status: "failed" };

/**
 * What the registry answers for one DOI add up to. `dataCite` is always
 * asked; `crossref` only when DataCite gave no usable record (undefined when
 * it was not asked). `unresolved` only when every registry asked answered
 * definitively without a usable record; `failed` when any of them gave no
 * answer at all, since the missing answer might have resolved it.
 */
export function interpretRegistryRecords(
  doi: string,
  dataCite: RegistryRecord,
  crossref?: RegistryRecord,
): DoiLookup {
  const fromDataCite = dataCite.outcome === "found" ? parseDataCiteJson(doi, dataCite.body) : null;
  if (fromDataCite) return { status: "resolved", record: fromDataCite };
  const fromCrossref = crossref?.outcome === "found" ? parseCrossrefWork(doi, crossref.body) : null;
  if (fromCrossref) return { status: "resolved", record: fromCrossref };
  const anyFailed = dataCite.outcome === "failed" || crossref?.outcome === "failed";
  return anyFailed ? { status: "failed" } : { status: "unresolved" };
}

/** Look one DOI up in DataCite (content negotiation covers Crossref DOIs
 *  too), then, only when DataCite has no usable record, in Crossref. */
export async function resolveDoi(
  doi: string,
  cache?: RegistryCache,
  deadline?: AbortSignal,
): Promise<DoiLookup> {
  const key = normalizeDoiKey(doi);
  const dataCite = await fetchRegistryRecord("DataCite", key, cache, deadline);
  const first = interpretRegistryRecords(key, dataCite);
  if (first.status === "resolved") return first;
  const crossref = await fetchRegistryRecord("Crossref", key, cache, deadline);
  return interpretRegistryRecords(key, dataCite, crossref);
}

/**
 * Resolve up to `cap` candidates, a few at a time, within `deadline`
 * (default {@link RESOLVE_DEADLINE_MS}). Never throws for a registry
 * problem: a lookup the deadline cuts short, or one that never starts
 * because the deadline has passed, is `failed`; an answer already in the
 * run's cache still counts.
 */
export async function resolveDoisForEnrichment(
  dois: string[],
  cache?: RegistryCache,
  cap: number = MAX_RESOLVED_DOIS,
  deadline: AbortSignal = AbortSignal.timeout(RESOLVE_DEADLINE_MS),
): Promise<DoiResolution> {
  const toResolve = dois.slice(0, cap);
  const resolution: DoiResolution = {
    resolved: [],
    unresolved: [],
    failed: [],
    skipped: dois.slice(cap),
  };
  for (let i = 0; i < toResolve.length; i += RESOLVE_CONCURRENCY) {
    const chunk = toResolve.slice(i, i + RESOLVE_CONCURRENCY);
    const lookups = await Promise.all(chunk.map((doi) => resolveDoi(doi, cache, deadline)));
    lookups.forEach((lookup, j) => {
      if (lookup.status === "resolved") resolution.resolved.push(lookup.record);
      else resolution[lookup.status].push(chunk[j]);
    });
  }
  if (deadline.aborted && resolution.failed.length > 0) {
    console.warn(
      `[doi-metadata] Stage 1d deadline reached; ${resolution.failed.length} DOI lookup(s) counted as failed: ${resolution.failed.join(", ")}`,
    );
  }
  return resolution;
}

export function summarizeDoiResolution(resolution: DoiResolution): DoiResolutionSummary {
  return {
    resolved: resolution.resolved.length,
    unresolved: resolution.unresolved.length,
    failed: resolution.failed.length,
    skipped: resolution.skipped.length,
  };
}

/** Normalized DOI -> resolved title, for the title rule of the
 *  never-data-paper guard. */
export function titlesByDoi(resolution: DoiResolution): Map<string, string> {
  const titles = new Map<string, string>();
  for (const r of resolution.resolved) if (r.title) titles.set(r.doi, r.title);
  return titles;
}

/** Normalized DOIs whose DataCite resourceTypeGeneral is `Dataset`: the only
 *  DOIs mergeWithExisting lets the LLM mark IsDerivedFrom. */
export function datasetDoisOf(resolution: DoiResolution): Set<string> {
  const dois = new Set<string>();
  for (const r of resolution.resolved) {
    if (r.resource_type_general?.toLowerCase() === "dataset") dois.add(r.doi);
  }
  return dois;
}

/** Prompt block listing what each candidate DOI is, including the ones that
 *  were not resolved and why. Empty string when there is nothing to show, so
 *  callers can append it unconditionally. All text from the registries was
 *  sanitized when it was parsed. */
export function formatResolvedDoiBlock(resolution: DoiResolution): string {
  const { resolved, unresolved, failed, skipped } = resolution;
  const total = resolved.length + unresolved.length + failed.length + skipped.length;
  if (total === 0) return "";
  const lines = resolved.map((r) => {
    const fields = [
      `title: "${r.title}"`,
      r.first_author && `first author: ${r.first_author}`,
      r.year && `year: ${r.year}`,
      r.container && `venue: ${r.container}`,
      r.type && `type: ${r.type}`,
      r.resource_type_general &&
        r.resource_type_general !== r.type &&
        `DataCite class: ${r.resource_type_general}`,
    ].filter(Boolean);
    return `- ${r.doi} | ${fields.join(" | ")}`;
  });
  for (const doi of unresolved) lines.push(`- ${doi} | unresolved (no registry record found)`);
  for (const doi of failed) lines.push(`- ${doi} | lookup failed (registry did not answer)`);
  // Past the cap: said explicitly, so a data paper listed after the 15th DOI
  // is not labeled as though its metadata had been checked.
  for (const doi of skipped) lines.push(`- ${doi} | not looked up (over the per-run cap)`);
  return `## Resolved DOI metadata
What each DOI in the sources actually is, looked up in DataCite / Crossref. Compare titles,
authors, and years with the dataset's own name and authors when choosing relation types.
${lines.join("\n")}`;
}
