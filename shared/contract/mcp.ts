/**
 * NEMAR MCP server wire contract (issue #1293, phase 1 of epic #1065).
 *
 * ADR 0049 (PR #1292; its number is final once it lands on dev; it carries
 * forward the still-valid parts of ADR 0025) fixes the server's shape: a
 * stateless, recipe-first broker on Cloudflare Workers.
 * The Worker never decodes signal data beyond a capped taste; bulk bytes go
 * direct to S3. This file is the zod vocabulary for that shape -- the
 * provenance envelope every RECORDING-level tool response carries (see the
 * section 6.1 comment below for the phase 2 scoping correction), the read
 * recipe `read_window` hands out by default, and one input/output schema
 * pair per tool.
 *
 * `.passthrough()` throughout, matching `shared/contract/dataset.ts`'s
 * lower-bound convention: these schemas assert required fields and their
 * types, so an additive field on either side of the wire never breaks an
 * older consumer.
 *
 * Zero deps beyond zod and this package's own `zarr-index.ts` (extraction-
 * ready for `@nemar/contract`, matching the rest of this directory).
 */

import { z } from "zod";
import {
  DATASET_ID_RE,
  SOURCE_COMMIT_RE,
  type ZarrArrayMetadata,
  type ZarrGroup,
  type ZarrIndex,
  type ZarrStore,
  assertSssIffDerived,
  zarrSssSchema,
  zarrUnitsReportSchema,
} from "./zarr-index.js";

// ---------------------------------------------------------------------------
// catalog.json (top-level Zarr discovery front door, #1062)
// ---------------------------------------------------------------------------

/** One row of `GET https://zarr.nemar.org/catalog.json`. Only the fields the
 *  MCP tools read are named; the real document carries more (see
 *  `zarr-catalog.ts`'s producer query) and `.passthrough()` keeps the rest
 *  reachable without widening this schema for every additive column. */
export const zarrCatalogEntrySchema = z
  .object({
    dataset_id: z.string().regex(DATASET_ID_RE),
    name: z.string(),
    doi: z.string().nullable().optional(),
    license: z.string().nullable().optional(),
    modalities: z.array(z.string()).optional(),
    tasks: z.array(z.string()).optional(),
    subject_count: z.number().int().nonnegative().nullable().optional(),
    has_hed: z
      .union([z.literal(0), z.literal(1)])
      .nullable()
      .optional(),
    hed_version: z.string().nullable().optional(),
    store_count: z.number().int().nonnegative().nullable().optional(),
    recording_count: z.number().int().nonnegative().nullable().optional(),
    recordings_unavailable: z.number().int().nonnegative().nullable().optional(),
    total_recording_duration: z.number().nullable().optional(),
    zarr_converted_at: z.string().nullable().optional(),
    zarr_source_commit: z.string().nullable().optional(),
    zarr_errors: z.number().int().nonnegative().nullable().optional(),
    zarr_verify_status: z.enum(["verified", "failed", "unverifiable"]).nullable().optional(),
    zarr_verified_at: z.string().nullable().optional(),
    index_url: z.string().nullable().optional(),
  })
  .passthrough();
export type ZarrCatalogEntry = z.infer<typeof zarrCatalogEntrySchema>;

export const zarrCatalogSchema = z
  .object({
    format: z.literal("nemar-zarr-catalog"),
    format_version: z.number().int(),
    generated_utc: z.string(),
    contract_base: z.string(),
    count: z.number().int().nonnegative(),
    datasets: z.array(zarrCatalogEntrySchema),
  })
  .passthrough();
export type ZarrCatalog = z.infer<typeof zarrCatalogSchema>;

/** The catalog and every D1-backed row carry `has_hed` as `0 | 1 | null`
 *  (`shared/contract/dataset.ts`'s `zeroOneNullable` convention); the MCP
 *  tools answer a boolean. This is the ONE place that conversion lives, so a
 *  phase 2 call site never re-derives `=== 1` by hand. */
export function flagToBoolean(value: 0 | 1 | null | undefined): boolean | null {
  if (value === undefined || value === null) return null;
  return value === 1;
}

// ---------------------------------------------------------------------------
// Citation composition (issue #1064 / #1294) -- a line-for-line TypeScript
// port of `dataset_citation` in `scripts/zarr/generate_zarr.py` (lines 4456
// to 4485), so `describe_dataset` and the Zarr index's own `citation` field
// agree on the exact same string for the same row.
// ---------------------------------------------------------------------------

/** Matches `_CITATION_PUBLISHER` in `scripts/zarr/generate_zarr.py`, and
 *  `publisher` in `backend/src/services/datacite.ts`, shortened to the form
 *  a reference list actually carries. */
const CITATION_PUBLISHER = "NEMAR";

/** The subset of a `datasets` row (or the public `GET /datasets/:id`
 *  response's `dataset` object) {@link composeCitation} reads. Every field
 *  is optional/nullable: a row missing everything but `name` still composes
 *  a (short) citation, and a row missing `name` entirely composes none. */
export interface ComposeCitationInput {
  name?: string | null;
  authors?: string | null;
  concept_doi?: string | null;
  doi?: string | null;
  /** Already the canonical `vX.Y.Z` tag (`toVersionTag`/`withCanonicalLatestVersion`
   *  in `shared/contract/version.ts`) -- this function does not normalize it. */
  latest_version?: string | null;
  created_at?: string | null;
}

/**
 * A ready-to-paste citation string for a dataset, or `null` when the row
 * does not carry enough to make one honestly (no `name`).
 *
 * Port of `dataset_citation(row)` in `scripts/zarr/generate_zarr.py`: every
 * part comes from the public row, and a missing part omits its segment
 * instead of printing an empty one. `doi` prefers `concept_doi`, falling
 * back to `doi` -- each candidate is trimmed BEFORE the fallback check, so a
 * whitespace-only `concept_doi` (e.g. `"  "`, truthy in the Python `or` this
 * ports but not what a human would call "present") correctly falls through
 * to `doi` rather than winning empty; a leading `doi:` prefix (if either
 * ever carries one) is stripped before building the `https://doi.org/...`
 * segment. `created_at`'s year is its first four characters, included only
 * when they are EXACTLY four digits -- stricter than the Python original
 * (`year.isdigit()`, which also accepts a short prefix like `"20"` from a
 * malformed `created_at`); tightening the TypeScript port is deliberate,
 * not a drift from the source of truth, and is a converter-side follow-up
 * to align `dataset_citation` itself, not scope for this file.
 */
export function composeCitation(row: ComposeCitationInput | null | undefined): string | null {
  if (!row || typeof row !== "object") return null;
  const name = (row.name ?? "").trim();
  if (!name) return null;
  const authors = (row.authors ?? "").trim();
  const doi = (row.concept_doi ?? "").trim() || (row.doi ?? "").trim();
  const version = (row.latest_version ?? "").trim();
  const year = (row.created_at ?? "").slice(0, 4);
  const parts: string[] = [];
  if (authors) parts.push(authors);
  if (/^\d{4}$/.test(year)) parts.push(`(${year})`);
  parts.push(`${name}${version ? ` (${version})` : ""}.`);
  parts.push(`${CITATION_PUBLISHER}.`);
  if (doi) parts.push(`https://doi.org/${doi.startsWith("doi:") ? doi.slice(4) : doi}`);
  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// Provenance envelope (design doc section 6.1) -- rides RECORDING-level tool
// responses (`list_recordings`, `get_events`, `render_overview`,
// `read_window`; phases 3 and 4), not optional and not only when asked,
// there. Dataset-level tools (`search_datasets`, `describe_dataset`) never
// construct one: they carry `doi`, `license`,
// `citation`, `zarr_status`, `zarr_source_commit` and `zarr_verify_status`
// directly on their own output schema instead -- an index-document read (what
// this envelope is built from) is exactly the cost `describe_dataset` avoids
// (see its schema's doc and `.context/mcp-server-design.md` section 5). Phase 1's
// design doc said "every tool's output includes a provenance envelope"; this is
// the phase 2 correction to that sentence.
// ---------------------------------------------------------------------------

/** The closed set the standing fidelity sweep stamps into `sweep_stamps`
 *  (`services/sweep-stamps.ts`'s `ZARR_VERIFY_STATUS_PATH`). Exported so a
 *  registration mirror (`backend/src/mcp/schemas.ts`) builds its own enum
 *  from this array rather than hand-duplicating the three literals. */
export const ZARR_VERIFY_STATUS_VALUES = ["verified", "failed", "unverifiable"] as const;

/** `has_zarr` (the catalog filter) means converted; this rides separately and
 *  is never a filter default -- a fresh conversion answers `null` here until
 *  the daily fidelity sweep reaches it (ADR 0005: verification is reported,
 *  never a precondition for serving). */
export const zarrVerifyStatusSchema = z.enum(ZARR_VERIFY_STATUS_VALUES).nullable();

export const provenanceEnvelopeSchema = z
  .object({
    dataset_id: z.string().regex(DATASET_ID_RE),
    doi: z.string().nullable(),
    license: z.string().nullable(),
    citation: z.string().nullable(),
    source_commit: z.string().regex(SOURCE_COMMIT_RE),
    /** The index.json HTTP response's ETag, when the caller fetched it
     *  through the edge cache and kept the header -- null when unknown, never
     *  fabricated. */
    index_etag: z.string().nullable(),
    engine_version: z.string(),
    source_tree: z.literal("raw"),
    derived: z.boolean(),
    /** Present exactly when `derived` is true (ADR 0028 MEG). */
    sss: zarrSssSchema.optional(),
    /** Every served level-0 array is int16-quantized and rate-capped relative
     *  to the source recording -- there is no lossless path today, so this is
     *  a constant fact about the serving copy, not a per-store measurement
     *  (the honesty layer E4 in the draft ecosystem plan asked for). */
    lossy: z.boolean(),
    /** From the array-metadata fetch (`zarr.json`), not index.json -- null
     *  until a caller has actually read that document. */
    dtype: z.string().nullable(),
    /** The SERVING rate after the NEMAR modality cap (group.rate). */
    effective_rate_hz: z.number().nullable(),
    /** The recording's own rate before the cap (group.source_rate_hz). */
    source_rate_hz: z.number().nullable(),
    units_report: zarrUnitsReportSchema.nullable().optional(),
    zarr_verify_status: zarrVerifyStatusSchema,
    /** A short caveat the caller should surface verbatim (e.g. "this dataset
     *  has 3 recordings pending conversion"). Null when there is none. */
    note: z.string().nullable().optional(),
  })
  .passthrough()
  .superRefine(assertSssIffDerived);
export type ProvenanceEnvelope = z.infer<typeof provenanceEnvelopeSchema>;

/** The catalog row is D1-backed and the system of record for `doi` and
 *  `license`: when a row is supplied and carries the key, its value wins EVEN
 *  WHEN NULL. A DOI invalidated in D1 after the last conversion hoisted it
 *  into index.json must not come back from the stale index. The index copy is
 *  consulted only when no catalog row was supplied at all, or the row omits
 *  the key. */
function fromCatalogOrIndex(
  catalogEntry: Pick<ZarrCatalogEntry, "doi" | "license"> | undefined,
  index: Pick<ZarrIndex, "doi" | "license">,
  key: "doi" | "license",
): string | null {
  if (catalogEntry !== undefined && catalogEntry[key] !== undefined) {
    return catalogEntry[key] ?? null;
  }
  return index[key] ?? null;
}

/** Assemble the envelope from an index document, the store it names, and
 *  (optionally) the store's channel group and the dataset's catalog.json
 *  entry. `doi`/`license` come from the catalog row when one is supplied
 *  (see `fromCatalogOrIndex`: its null is authoritative) and from the index's
 *  hoisted copy only when no row is; every other field has exactly one
 *  source. Throws when `derived` and `sss` disagree (ADR 0028). */
export function computeProvenanceEnvelope(input: {
  index: Pick<
    ZarrIndex,
    "dataset_id" | "source_commit" | "engine_version" | "doi" | "license" | "citation"
  >;
  store: Pick<ZarrStore, "source_tree" | "derived" | "sss" | "units_report">;
  group?: Pick<ZarrGroup, "rate" | "source_rate_hz">;
  catalogEntry?: Pick<ZarrCatalogEntry, "doi" | "license" | "zarr_verify_status">;
  indexEtag?: string | null;
  dtype?: string | null;
  note?: string | null;
}): ProvenanceEnvelope {
  const { index, store, group, catalogEntry, indexEtag, dtype, note } = input;
  return provenanceEnvelopeSchema.parse({
    dataset_id: index.dataset_id,
    doi: fromCatalogOrIndex(catalogEntry, index, "doi"),
    license: fromCatalogOrIndex(catalogEntry, index, "license"),
    citation: index.citation ?? null,
    source_commit: index.source_commit,
    index_etag: indexEtag ?? null,
    engine_version: index.engine_version,
    source_tree: store.source_tree,
    derived: store.derived,
    sss: store.sss,
    lossy: true,
    dtype: dtype ?? null,
    effective_rate_hz: group?.rate ?? null,
    source_rate_hz: group?.source_rate_hz ?? null,
    units_report: store.units_report ?? null,
    zarr_verify_status: catalogEntry?.zarr_verify_status ?? null,
    note: note ?? null,
  });
}

// ---------------------------------------------------------------------------
// Read recipe -- the default `read_window` contract (ADR 0049)
// ---------------------------------------------------------------------------

/** A half-open `[start, end)` index range; a backwards range is a bug in the
 *  caller, never something to hand a client as a "recipe". */
const rangeSchema = z
  .object({
    start: z.number().int().nonnegative(),
    end: z.number().int().nonnegative(),
  })
  .passthrough()
  .refine((v) => v.end >= v.start, { message: "end must be >= start", path: ["end"] });

export const readRecipeHowToSchema = z
  .object({
    /** Python, `zarr` + anonymous S3 -- the desktop/HPC lane (E2 in the draft
     *  ecosystem plan; eegprep/MNE consume the array this produces). */
    python_zarr: z.string(),
    /** TypeScript/JavaScript, `zarrita` -- the browser lane and this
     *  server's own spike decode path. */
    zarrita: z.string(),
  })
  .passthrough();
export type ReadRecipeHowTo = z.infer<typeof readRecipeHowToSchema>;

export const readRecipeSchema = z
  .object({
    contract_base: z.string(),
    data_base: z.string(),
    s3_uri: z.string(),
    s3_region: z.string(),
    s3_anonymous: z.boolean(),
    /** The store's `zarr` path, relative to contract_base / data_base. */
    zarr: z.string(),
    group: z.string(),
    /** `"0"` for the level-0 signal array, or a positive integer view level. */
    level: z.union([z.literal("0"), z.number().int().positive()]),
    /** Absolute URL: `contract_base` + the path `layout.level0`/`layout.view`
     *  computes, so a caller never has to fill the template itself. */
    array_path: z.string(),
    /** From the array-metadata fetch; null until a caller has made it. */
    dtype: z.string().nullable(),
    codecs: z.array(z.unknown()).optional(),
    chunk_samples: z.number().int().positive().nullable(),
    shard_samples: z.number().int().positive().nullable(),
    n_channels: z.number().int().nonnegative().nullable(),
    sample_slice: rangeSchema.optional(),
    channel_slice: rangeSchema.optional(),
    /** Where to find the physical-units conversion -- `layout.scale_offset`
     *  verbatim, not the scale/offset values themselves (those live in the
     *  level-0 array's own attrs, one more fetch away). */
    scale_offset: z.string(),
    how_to: readRecipeHowToSchema,
  })
  .passthrough();
export type ReadRecipe = z.infer<typeof readRecipeSchema>;

const LAYOUT_PLACEHOLDER_RE = /<zarr>|<group>|<L>/g;

/** Fill a `layout` template in ONE pass, so a value substituted for one
 *  placeholder is never re-scanned for another (sequential `replace` calls
 *  would let a `<group>` inside a store path eat the template's own slot).
 *  Throws when the template lacks a placeholder the caller supplied a value
 *  for: a recipe whose URL still carries `<L>` looks valid and fails only at
 *  the fetch, so the failure has to happen here. */
function fillTemplate(
  template: string,
  vars: { zarr: string; group: string; level?: string },
): string {
  const values: Record<string, string> = {
    "<zarr>": vars.zarr,
    "<group>": vars.group,
    "<L>": vars.level ?? "",
  };
  const seen = new Set<string>();
  const filled = template.replace(LAYOUT_PLACEHOLDER_RE, (placeholder) => {
    seen.add(placeholder);
    return values[placeholder];
  });
  const required = ["<zarr>", "<group>", ...(vars.level !== undefined ? ["<L>"] : [])];
  const missing = required.filter((ph) => !seen.has(ph));
  if (missing.length > 0) {
    throw new Error(`layout template "${template}" lacks ${missing.join(", ")}`);
  }
  return filled;
}

function buildHowTo(opts: {
  s3Uri: string;
  contractBase: string;
  relativePath: string;
}): ReadRecipeHowTo {
  const s3Path = `${opts.s3Uri}${opts.relativePath}`;
  const httpPath = `${opts.contractBase}${opts.relativePath}`;
  return {
    python_zarr: [
      "import zarr",
      "",
      `arr = zarr.open("${s3Path}", mode="r", storage_options={"anon": True})`,
      "window = arr[:, start_sample:end_sample]",
      "# physical = digital * scale + offset -- see the recipe's scale_offset field",
    ].join("\n"),
    zarrita: [
      'import * as zarr from "zarrita";',
      "",
      `const store = new zarr.FetchStore("${httpPath}");`,
      'const arr = await zarr.open.v3(store, { kind: "array" });',
      "const window = await zarr.get(arr, [null, zarr.slice(startSample, endSample)]);",
      "// physical = digital * scale + offset -- see the recipe's scale_offset field",
    ].join("\n"),
  };
}

/**
 * Compute a read recipe from an index document plus the store/group it names
 * -- no probing, per `layout`'s own doc comment. Throws if `groupName` is not
 * one of the store's groups.
 *
 * `arrayMetadata` is the ONE extra fetch (`GET <array_path>/zarr.json`, the
 * array's own Zarr v3 metadata, `zarrArrayMetadataSchema`) a caller makes to
 * fill in `dtype`/`codecs`. Zarr spells it `data_type`; this is the one place
 * it becomes the recipe's `dtype`. Omit it and `dtype` is null and `codecs`
 * absent, which is a valid recipe -- a client that already knows the codec
 * shape (every store uses the same blosc/zstd configuration today) does not
 * have to make that fetch at all.
 */
export function buildReadRecipe(input: {
  index: Pick<
    ZarrIndex,
    "contract_base" | "data_base" | "s3_uri" | "s3_region" | "s3_anonymous" | "layout"
  >;
  store: Pick<ZarrStore, "zarr" | "groups">;
  groupName: string;
  level?: "0" | number;
  sampleSlice?: { start: number; end: number };
  channelSlice?: { start: number; end: number };
  arrayMetadata?: Pick<ZarrArrayMetadata, "data_type" | "codecs">;
}): ReadRecipe {
  const { index, store, groupName, level = "0", sampleSlice, channelSlice, arrayMetadata } = input;
  const group = store.groups?.find((g) => g.name === groupName);
  if (!group) {
    throw new Error(`recording ${store.zarr} has no group named "${groupName}"`);
  }
  const isLevel0 = level === "0" || level === 0;
  const relativePath = isLevel0
    ? fillTemplate(index.layout.level0, { zarr: store.zarr, group: groupName })
    : fillTemplate(index.layout.view, { zarr: store.zarr, group: groupName, level: String(level) });
  const arrayPath = `${index.contract_base}${relativePath}`;

  return readRecipeSchema.parse({
    contract_base: index.contract_base,
    data_base: index.data_base,
    s3_uri: index.s3_uri,
    s3_region: index.s3_region,
    s3_anonymous: index.s3_anonymous,
    zarr: store.zarr,
    group: groupName,
    level: isLevel0 ? "0" : level,
    array_path: arrayPath,
    dtype: arrayMetadata?.data_type ?? null,
    codecs: arrayMetadata?.codecs,
    chunk_samples: group.chunk_samples ?? null,
    shard_samples: group.shard_samples ?? null,
    n_channels: group.n_channels ?? null,
    sample_slice: sampleSlice,
    channel_slice: channelSlice,
    scale_offset: index.layout.scale_offset,
    how_to: buildHowTo({
      s3Uri: index.s3_uri,
      contractBase: index.contract_base,
      relativePath,
    }),
  });
}

// ---------------------------------------------------------------------------
// Tool schemas -- one input/output pair per tool, ordered by cost (issue #1065)
// ---------------------------------------------------------------------------

export const MCP_TOOL_NAMES = [
  "search_datasets",
  "describe_dataset",
  "list_recordings",
  "get_events",
  "render_overview",
  "read_window",
] as const;
export type McpToolName = (typeof MCP_TOOL_NAMES)[number];

export const SEARCH_DATASETS_DEFAULT_LIMIT = 20;
export const SEARCH_DATASETS_MAX_LIMIT = 100;

/** Wraps the public catalog: `GET /datasets/search` (`executeDatasetSearch`,
 *  FTS plus Vectorize) when `query` is present, since that route 400s without
 *  `q`, and the plain `GET /datasets` list otherwise. `modality`, `task`,
 *  `has_hed` and `has_zarr` are real server-side filters on both; there is no
 *  participant-count filter server-side today, so none is offered here (a
 *  caller reads `subject_count` off each hit). `has_zarr` filters on the
 *  catalog's converted flag, never `zarr_verify_status` -- see
 *  `zarrVerifyStatusSchema`'s doc. */
export const searchDatasetsInputSchema = z
  .object({
    query: z.string().optional(),
    modality: z.string().optional(),
    task: z.string().optional(),
    has_hed: z.boolean().optional(),
    has_zarr: z.boolean().optional(),
    limit: z
      .number()
      .int()
      .positive()
      .max(SEARCH_DATASETS_MAX_LIMIT)
      .default(SEARCH_DATASETS_DEFAULT_LIMIT),
  })
  .passthrough();
export type SearchDatasetsInput = z.infer<typeof searchDatasetsInputSchema>;

export const searchDatasetsHitSchema = z
  .object({
    dataset_id: z.string().regex(DATASET_ID_RE),
    name: z.string(),
    doi: z.string().nullable().optional(),
    license: z.string().nullable().optional(),
    modalities: z.array(z.string()).optional(),
    tasks: z.array(z.string()).optional(),
    subject_count: z.number().int().nullable().optional(),
    /** Boolean here; the catalog row's `0 | 1 | null` goes through
     *  `flagToBoolean`, never an inline `=== 1`. */
    has_hed: z.boolean().nullable().optional(),
    has_zarr: z.boolean(),
  })
  .passthrough();
export type SearchDatasetsHit = z.infer<typeof searchDatasetsHitSchema>;

export const searchDatasetsOutputSchema = z
  .object({
    results: z.array(searchDatasetsHitSchema),
    count: z.number().int().nonnegative(),
    limit: z.number().int(),
    /** A caveat the caller should surface verbatim -- e.g. the search index
     *  degraded to a fallback, or a hit's license/Zarr status could not be
     *  resolved. Null/absent when there is none. */
    note: z.string().nullable().optional(),
    /** True when more rows matched than this response's candidate window
     *  could return (mirrors `executeDatasetSearch`'s own `truncated` on the
     *  `query` path); absent when the tool cannot know (the no-`query`
     *  catalog-list path always answers its own exact `count`, so this is
     *  never set there). */
    truncated: z.boolean().optional(),
  })
  .passthrough();
export type SearchDatasetsOutput = z.infer<typeof searchDatasetsOutputSchema>;

/** Served from the D1 row plus catalog.json (compute-minimization rule,
 *  never from index.json -- the largest index is 12.8 MB). No signal bytes. */
export const describeDatasetInputSchema = z
  .object({ dataset_id: z.string().regex(DATASET_ID_RE) })
  .passthrough();
export type DescribeDatasetInput = z.infer<typeof describeDatasetInputSchema>;

/** The closed set of tools `describe_dataset`'s `cost_hint.next_cheapest_tool`
 *  may name. Exported for the same hand-duplication reason as
 *  {@link ZARR_VERIFY_STATUS_VALUES}. */
export const NEXT_CHEAPEST_TOOL_VALUES = [
  "list_recordings",
  "get_events",
  "render_overview",
  "read_window",
] as const;

export const describeDatasetCostHintSchema = z
  .object({
    next_cheapest_tool: z.enum(NEXT_CHEAPEST_TOOL_VALUES),
    reason: z.string(),
  })
  .passthrough();

/** The closed set `datasets.zarr_status` holds. Exported for the same
 *  hand-duplication reason as {@link ZARR_VERIFY_STATUS_VALUES}. */
export const ZARR_STATUS_VALUES = ["pending", "ready", "failed"] as const;

export const describeDatasetOutputSchema = z
  .object({
    dataset_id: z.string().regex(DATASET_ID_RE),
    name: z.string(),
    doi: z.string().nullable(),
    license: z.string().nullable(),
    citation: z.string().nullable(),
    modalities: z.array(z.string()).optional(),
    tasks: z.array(z.string()).optional(),
    subject_count: z.number().int().nullable().optional(),
    has_hed: z.boolean().nullable().optional(),
    hed_version: z.string().nullable().optional(),
    recording_count: z.number().int().nullable().optional(),
    total_recording_duration_s: z.number().nullable().optional(),
    zarr_status: z.enum(ZARR_STATUS_VALUES).nullable().optional(),
    zarr_verify_status: zarrVerifyStatusSchema.optional(),
    /** Additive, phase 2 (#1294): the commit the catalog's `zarr_status`/
     *  `zarr_verify_status` verdict was reached against -- present exactly
     *  when the dataset has ever converted (null before a first conversion,
     *  same nullability as `zarr_status` itself). */
    zarr_source_commit: z.string().nullable().optional(),
    /** Additive, phase 2 (#1294): store count backing `zarr_status`, the
     *  same `>0` fact `has_zarr` on `search_datasets` tests for -- surfaced
     *  here too so a caller does not have to re-derive "converted with data"
     *  from `zarr_status` alone. */
    zarr_store_count: z.number().int().nullable().optional(),
    cost_hint: describeDatasetCostHintSchema,
  })
  .passthrough();
export type DescribeDatasetOutput = z.infer<typeof describeDatasetOutputSchema>;

export const LIST_RECORDINGS_DEFAULT_LIMIT = 50;
export const LIST_RECORDINGS_MAX_LIMIT = 500;

/** Parses `index.json` once per (dataset id, source_commit) and caches the
 *  compact projection at the edge -- repeat calls are a cache match plus a
 *  slice (compute-minimization rule). `include_derived` defaults false: a
 *  caller has to opt in to seeing an ADR 0028 SSS-filtered store. */
export const listRecordingsInputSchema = z
  .object({
    dataset_id: z.string().regex(DATASET_ID_RE),
    modality: z.string().optional(),
    min_duration_s: z.number().nonnegative().optional(),
    include_derived: z.boolean().default(false),
    limit: z
      .number()
      .int()
      .positive()
      .max(LIST_RECORDINGS_MAX_LIMIT)
      .default(LIST_RECORDINGS_DEFAULT_LIMIT),
    offset: z.number().int().nonnegative().default(0),
  })
  .passthrough();
export type ListRecordingsInput = z.infer<typeof listRecordingsInputSchema>;

export const recordingGroupSummarySchema = z
  .object({
    name: z.string(),
    modality: z.string().nullable().optional(),
    rate: z.number().nullable().optional(),
    n_channels: z.number().int().nullable().optional(),
    duration_s: z.number().nullable().optional(),
  })
  .passthrough();

export const recordingSummarySchema = z
  .object({
    path: z.string(),
    zarr: z.string(),
    source_tree: z.literal("raw"),
    derived: z.boolean(),
    groups: z.array(recordingGroupSummarySchema).optional(),
  })
  .passthrough();

export const listRecordingsOutputSchema = z
  .object({
    dataset_id: z.string().regex(DATASET_ID_RE),
    source_commit: z.string().regex(SOURCE_COMMIT_RE),
    recordings: z.array(recordingSummarySchema),
    total_count: z.number().int().nonnegative(),
    /** How many derived (ADR 0028) stores this call excluded, so the
     *  omission is visible rather than silent (issue #1065's day-one value). */
    excluded_derived_count: z.number().int().nonnegative(),
    limit: z.number().int(),
    offset: z.number().int(),
  })
  .passthrough();
export type ListRecordingsOutput = z.infer<typeof listRecordingsOutputSchema>;

/** Reads `events.parquet` directly (converter-computed `sample_index`, never
 *  flagged an estimate); falls back to `events.tsv` from `data.nemar.org`
 *  only for a dataset whose index names no `events_parquet`, and flags that
 *  result `estimated: true` -- the fallback's sample index is wrong by a
 *  sub-sample amount wherever source and target rates are not integer
 *  multiples. */
export const getEventsInputSchema = z
  .object({
    dataset_id: z.string().regex(DATASET_ID_RE),
    /** A store's `path` or `zarr` -- either identifies the recording. */
    recording: z.string(),
    group: z.string().optional(),
  })
  .passthrough();
export type GetEventsInput = z.infer<typeof getEventsInputSchema>;

export const eventRowSchema = z
  .object({
    store_path: z.string(),
    group_name: z.string(),
    onset_s: z.number(),
    duration_s: z.number().nullable().optional(),
    sample_index: z.number().int().nonnegative(),
    trial_type: z.string().nullable().optional(),
    value: z.union([z.string(), z.number()]).nullable().optional(),
    hed: z.string().nullable().optional(),
  })
  .passthrough();

export const getEventsOutputSchema = z
  .object({
    dataset_id: z.string().regex(DATASET_ID_RE),
    recording: z.string(),
    events: z.array(eventRowSchema),
    source: z.enum(["events_parquet", "events_tsv_fallback"]),
    estimated: z.boolean(),
  })
  .passthrough();
export type GetEventsOutput = z.infer<typeof getEventsOutputSchema>;

export const RENDER_OVERVIEW_DEFAULT_WIDTH_PX = 800;
export const RENDER_OVERVIEW_MAX_WIDTH_PX = 4000;

/** Reads the `view/*` min-max pyramid, never level 0, and picks the smallest
 *  view level satisfying `width_px` -- cheap by construction (kilobytes). */
export const renderOverviewInputSchema = z
  .object({
    dataset_id: z.string().regex(DATASET_ID_RE),
    recording: z.string(),
    group: z.string().optional(),
    width_px: z
      .number()
      .int()
      .positive()
      .max(RENDER_OVERVIEW_MAX_WIDTH_PX)
      .default(RENDER_OVERVIEW_DEFAULT_WIDTH_PX),
  })
  .passthrough();
export type RenderOverviewInput = z.infer<typeof renderOverviewInputSchema>;

/** Metadata alongside the MCP `image` content block the tool actually
 *  returns -- the PNG bytes ride in the response's `content` array (base64,
 *  per the SDK's `{ type: "image", data, mimeType }` shape), not here. */
export const renderOverviewOutputSchema = z
  .object({
    dataset_id: z.string().regex(DATASET_ID_RE),
    recording: z.string(),
    group: z.string(),
    level: z.number().int().positive(),
    width_px: z.number().int().positive(),
    height_px: z.number().int().positive(),
    mime_type: z.literal("image/png"),
  })
  .passthrough();
export type RenderOverviewOutput = z.infer<typeof renderOverviewOutputSchema>;

/** Hard cap on the opt-in taste: at most this many channel-seconds
 *  (`duration_s x channels.length`) may be decoded inline. Chosen from the
 *  issue's own "something like 60 s times 64 channels" note -- the point at
 *  which a 176 s outer shard read starts costing real Worker memory (ADR
 *  0049 / the isolate ceiling discussion). A taste therefore REQUIRES
 *  `channels`: the schema cannot know a recording's channel count, and a
 *  MEG store in the live catalog has 320, so "omitted means all" would let a
 *  request five times over the cap through. Past the cap, `read_window`
 *  never truncates silently: the input is rejected with a message that names
 *  the cap and points the caller at the recipe (omit `taste`). */
export const READ_WINDOW_TASTE_MAX_DURATION_S = 60;
export const READ_WINDOW_TASTE_MAX_CHANNELS = 64;
export const READ_WINDOW_TASTE_MAX_CHANNEL_SECONDS =
  READ_WINDOW_TASTE_MAX_DURATION_S * READ_WINDOW_TASTE_MAX_CHANNELS;

/**
 * Field-level sanity ceilings for the RECIPE path (`taste: false`, the
 * default), which never decodes anything -- these exist only to reject a
 * garbage request early, not to bound cost. They are deliberately far above
 * {@link READ_WINDOW_TASTE_MAX_DURATION_S} / {@link READ_WINDOW_TASTE_MAX_CHANNELS}:
 * pinning `duration_s`'s or `channels`' own `.max()` to the taste cap would
 * make the combined channel-seconds check below unreachable (any input that
 * satisfies both individual maxes already satisfies their product), which is
 * exactly the bug the mutation check for this file caught -- disabling the
 * `superRefine` body left every existing test green, because the two field
 * maxes were already doing 100% of the rejecting.
 */
const RECIPE_SANITY_MAX_DURATION_S = 24 * 60 * 60;
const RECIPE_SANITY_MAX_CHANNELS = 4096;

/** `read_window` returns a recipe by default (`taste: false`, the documented
 *  default). Setting `taste: true` asks for inline decoded values instead,
 *  and is rejected once `duration_s x channels.length` exceeds
 *  {@link READ_WINDOW_TASTE_MAX_CHANNEL_SECONDS} -- the recipe path has no
 *  such limit, because it never touches the Worker's memory budget; only the
 *  generous sanity ceilings above apply to it. */
export const readWindowInputSchema = z
  .object({
    dataset_id: z.string().regex(DATASET_ID_RE),
    recording: z.string(),
    group: z.string().optional(),
    start_s: z.number().nonnegative().default(0),
    duration_s: z.number().positive().max(RECIPE_SANITY_MAX_DURATION_S).default(10),
    channels: z.array(z.number().int().nonnegative()).max(RECIPE_SANITY_MAX_CHANNELS).optional(),
    taste: z.boolean().default(false),
  })
  .passthrough()
  .superRefine((val, ctx) => {
    if (!val.taste) return;
    if (val.channels === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "taste requires channels: name the channel indices you want " +
          "(list_recordings reports each group's n_channels), or omit taste for a recipe",
        path: ["channels"],
      });
      return;
    }
    const channelSeconds = val.duration_s * val.channels.length;
    if (channelSeconds > READ_WINDOW_TASTE_MAX_CHANNEL_SECONDS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          `taste exceeds the cap of ${READ_WINDOW_TASTE_MAX_CHANNEL_SECONDS} channel-seconds ` +
          `(duration_s x channels = ${channelSeconds}); omit taste for a recipe instead`,
        path: ["duration_s"],
      });
    }
  });
export type ReadWindowInput = z.infer<typeof readWindowInputSchema>;

export const readWindowRecipeResultSchema = z
  .object({
    mode: z.literal("recipe"),
    recipe: readRecipeSchema,
    envelope: provenanceEnvelopeSchema,
  })
  .passthrough();

export const readWindowTasteResultSchema = z
  .object({
    mode: z.literal("taste"),
    start_s: z.number(),
    duration_s: z.number(),
    channels: z.array(z.number().int()),
    sample_rate_hz: z.number(),
    /** `[channel][sample]`, already scaled to physical units. */
    values: z.array(z.array(z.number())),
    envelope: provenanceEnvelopeSchema,
  })
  .passthrough();

export const readWindowOutputSchema = z.discriminatedUnion("mode", [
  readWindowRecipeResultSchema,
  readWindowTasteResultSchema,
]);
export type ReadWindowOutput = z.infer<typeof readWindowOutputSchema>;
