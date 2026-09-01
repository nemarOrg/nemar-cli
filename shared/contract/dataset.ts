/**
 * Dataset wire-shape contract (epic #896, #898).
 *
 * Single source of truth for the dataset shapes the CLI, website, data plane,
 * and third parties (EEGDash, ...) exchange. Three related shapes:
 *  - catalogItemSchema  : api.nemar.org GET /datasets list/search rows
 *  - datasetDetailSchema: api.nemar.org GET /datasets/:id (superset of the item)
 *  - neuroschemaDatasetSchema: data.nemar.org landing payload, which conforms to
 *    the neuroschema v0.4.0 `core/dataset.schema.json` (the canonical, language-
 *    agnostic dataset-metadata schema; enforced against the vendored JSON Schema
 *    in test/contract/neuroschema-conformance.test.ts).
 *
 * Objects are `.passthrough()` on purpose: the contract asserts REQUIRED fields
 * and their types (a lower bound), so additive backend fields never break it.
 * `latest_version` uses the coercing versionTagSchema, so today's bare-version
 * rows still validate while the canonical output is the `vX.Y.Z` tag.
 *
 * Zero deps beyond zod (extraction-ready for @nemar/contract).
 */

import { z } from "zod";
import { versionTagSchema } from "./version.js";

/**
 * neuroschema version this contract's dataset shape conforms to. Single source;
 * backend services/data-router.ts imports this instead of a hardcoded literal.
 */
export const NEUROSCHEMA_VERSION = "0.4.0";

/** neuroschema `source` enum. */
export const datasetSourceSchema = z.enum(["openneuro", "nemar", "gin", "other"]);
export type DatasetSource = z.infer<typeof datasetSourceSchema>;

/** 0/1 tri-state used across the catalog columns (1/0, or null = not classified). */
const zeroOneNullable = z.union([z.literal(0), z.literal(1)]).nullable();

/**
 * api.nemar.org catalog row (GET /datasets, public + "mine" branches).
 * Mirrors backend/src/routes/datasets/catalog.ts. Comma-joined string fields
 * (modalities/tasks/authors) are the current wire form; #899 does not change them.
 */
export const catalogItemSchema = z
  .object({
    dataset_id: z.string(),
    // Aliased `d.dataset_id AS id` on the public branch, but the ?mine=true
    // branch selects dataset_id WITHOUT the alias, so `id` is not universally
    // present. dataset_id is the reliable key; id is optional.
    id: z.string().optional(),
    name: z.string(),
    description: z.string().nullable().optional(),
    status: z.string(),
    visibility: z.string(),
    concept_doi: z.string().nullable().optional(),
    doi: z.string().nullable().optional(),
    created_at: z.string(),
    updated_at: z.string().optional(),
    owner_username: z.string().nullable().optional(),
    source: z.string().nullable().optional(),
    modalities: z.string().optional(),
    participants: z.number().int().nonnegative(),
    tasks: z.string().optional(),
    authors: z.string().optional(),
    license: z.string().optional(),
    // #895: value is fixed by #970 (epic #967 Phase 3) -- file_size now sources
    // from the version manifest's declared total, not the annex-blind S3-objects
    // sum; the SHAPE was stable throughout and stays so here.
    file_size: z.number().nonnegative(),
    file_size_formatted: z.string().optional(),
    // Honest total file count (manifest-first, S3-sum fallback for pre-manifest
    // datasets), added alongside data_complete/bytes_present in #970. Absent on
    // older backends.
    total_files: z.number().nonnegative().nullable().optional(),
    num_citations: z.number().int().nonnegative().optional(),
    n_channels: z.number().int().nullable().optional(),
    electrode_system: z.string().nullable().optional(),
    has_hed: zeroOneNullable.optional(),
    hed_version: z.string().nullable().optional(),
    // Data completeness of the latest version (#970): 1 = every annex-keyed
    // manifest entry verified present at its declared size, 0 = incomplete (the
    // #967 signature), null = not audited yet.
    data_complete: zeroOneNullable.optional(),
    // Actual bytes present in S3 (#970) -- distinct from file_size when
    // data_complete=0.
    bytes_present: z.number().nonnegative().nullable().optional(),
    // Canonical output is the vX.Y.Z tag; coercing schema keeps today's bare
    // rows valid. null when the dataset has no published version yet.
    latest_version: versionTagSchema.nullable().optional(),
    // Epic #1144 phase 3 (#1147), D7: every column the facet filter table
    // (shared/facets.ts + backend/src/services/dataset-facets.ts) can filter
    // on is also projected here, raw and nullable -- a facet a caller can
    // filter by but never see the value of is a result set with no way to
    // check. Absent on older backends (additive, passthrough).
    sessions_count: z.number().int().nullable().optional(),
    age_min: z.number().nullable().optional(),
    age_max: z.number().nullable().optional(),
    bids_version: z.string().nullable().optional(),
    zarr_status: z.enum(["pending", "ready", "failed"]).nullable().optional(),
    total_recording_duration: z.number().nullable().optional(),
    recording_duration_min: z.number().nullable().optional(),
    recording_duration_max: z.number().nullable().optional(),
    recording_count: z.number().int().nullable().optional(),
    recordings_unavailable: z.number().int().nullable().optional(),
    channel_count_min: z.number().int().nullable().optional(),
    channel_count_max: z.number().int().nullable().optional(),
    sampling_frequency: z.number().nullable().optional(),
    power_line_frequency: z.number().nullable().optional(),
    eeg_reference: z.string().nullable().optional(),
    placement_scheme: z.string().nullable().optional(),
  })
  .passthrough();
export type CatalogItem = z.infer<typeof catalogItemSchema>;

/**
 * GET /datasets/:id detail. Backend returns `SELECT d.* , participants,
 * latest_version, owner_username, owner_github` — a superset of the catalog row
 * (#853/#864 parity). Unlike the list query, the detail query does NOT COALESCE
 * the metadata columns, so file_size/modalities/tasks/authors/license come
 * through as raw JSON `null` for an un-backfilled dataset — override them to
 * nullable here (the list schema keeps them strict because the list COALESCEs).
 * Passthrough covers the many other raw `d.*` columns.
 */
export const datasetDetailSchema = catalogItemSchema
  .extend({
    file_size: z.number().nonnegative().nullable(),
    modalities: z.string().nullable().optional(),
    tasks: z.string().nullable().optional(),
    authors: z.string().nullable().optional(),
    license: z.string().nullable().optional(),
    owner_github: z.string().nullable().optional(),
    // Deposit attestation (migration 0067). NULL on rows created before the
    // policy, by server-side imports, or by pre-attestation CLIs.
    attestation_deposit_type: z.enum(["owner", "redistribution"]).nullable().optional(),
    attestation_key_status: z.enum(["destroyed", "retained"]).nullable().optional(),
    attestation_deidentified: zeroOneNullable.optional(),
    attestation_no_duplicate: zeroOneNullable.optional(),
    attestation_upstream_source: z.string().nullable().optional(),
    attestation_accepted_at: z.string().nullable().optional(),
  })
  .passthrough();
export type DatasetDetail = z.infer<typeof datasetDetailSchema>;

/**
 * GET /datasets/search hit (reduced projection, services/dataset-search.ts
 * SearchResult). The id is aliased `d.dataset_id AS id` — the wire key is `id`,
 * NOT `dataset_id` — and there is no `latest_version`. The columns are selected
 * raw (no COALESCE), so the string fields can be null; participants (subject_count)
 * can be null too.
 */
export const searchHitSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    modalities: z.string().nullable().optional(),
    participants: z.number().int().nullable().optional(),
    doi: z.string().nullable().optional(),
    tasks: z.string().nullable().optional(),
    authors: z.string().nullable().optional(),
    has_hed: zeroOneNullable.optional(),
    score: z.number().optional(),
    snippet: z.string().optional(),
  })
  .passthrough();
export type SearchHit = z.infer<typeof searchHitSchema>;

/**
 * Epic #1144 phase 4 (#1148), D5: per-facet breakdown of `excluded_unknown`,
 * keyed by `FacetKey` (`shared/facets.ts`) -- how many rows in the WIDENED
 * population are unknown for EACH active facet individually. Buckets do NOT
 * sum to `excluded_unknown`: a row unknown in two active facets counts once
 * toward the total but once in EACH bucket, so `sum(values) >=
 * excluded_unknown`, with equality only when no row is unknown in more than
 * one active facet. A consumer must never present these as a partition of
 * the total. Always present together with `excluded_unknown` (same
 * success/failure gate: both are computed by one query and both are omitted
 * together on failure), never on its own.
 */
const excludedUnknownByFacetSchema = z.record(z.string(), z.number().int().nonnegative());

/** Envelope for GET /datasets. */
export const datasetListEnvelopeSchema = z
  .object({
    datasets: z.array(catalogItemSchema),
    count: z.number().int().nonnegative(),
    total_count: z.number().int().nonnegative().optional(),
    limit: z.number().int().optional(),
    offset: z.number().int().optional(),
    // Epic #1144 phase 3 (#1147), D4/ADR 0005: rows hidden by the default
    // unknown-excluded facet policy -- the count that would have matched
    // with `include_unknown=1`, minus the count that did. Present only when
    // a facet is active; absent (never 0-as-a-substitute) when the widened
    // count itself failed, so its absence never masquerades as "nothing was
    // excluded".
    excluded_unknown: z.number().int().nonnegative().optional(),
    excluded_unknown_by_facet: excludedUnknownByFacetSchema.optional(),
  })
  .passthrough();
export type DatasetListEnvelope = z.infer<typeof datasetListEnvelopeSchema>;

/**
 * Envelope for GET /datasets/search. `count` (#1145, epic #1144 phase 1) is
 * the true total matching the query + filters, independent of page size --
 * and independent of the candidate windows `results` is drawn from, so it
 * can legitimately exceed `candidate_ceiling` (review round 3 C3: `count` is
 * NOT "the same population `results` is sliced from"). `truncated` is a
 * derived convenience: `count > candidate_ceiling`. `warning` is set only
 * when the exact count query itself failed and `count` fell back to a
 * page-derived lower bound (review round 3 I1) -- mirrors
 * datasetListEnvelopeSchema's established `warning` vocabulary.
 * `returned`/`offset`/`limit`/`candidate_ceiling` are additive, mirroring the
 * naming precedent of datasetListEnvelopeSchema above. `method` is one of the
 * five values the backend actually emits (review round 3 I6/I7); still
 * optional since not every historical/degraded response is guaranteed to set it.
 */
export const datasetSearchEnvelopeSchema = z
  .object({
    results: z.array(searchHitSchema),
    count: z.number().int().nonnegative(),
    returned: z.number().int().nonnegative().optional(),
    offset: z.number().int().nonnegative().optional(),
    limit: z.number().int().optional(),
    candidate_ceiling: z.number().int().optional(),
    truncated: z.boolean().optional(),
    method: z.enum(["exact_id", "text", "text_fallback", "semantic", "unavailable"]).optional(),
    min_score: z.number().optional(),
    warning: z.string().optional(),
    // Epic #1144 phase 3 (#1147), D4/ADR 0005: see datasetListEnvelopeSchema's
    // `excluded_unknown` for the exact semantics -- identical field, mirrored
    // here since /datasets/search now shares the same facet engine.
    excluded_unknown: z.number().int().nonnegative().optional(),
    excluded_unknown_by_facet: excludedUnknownByFacetSchema.optional(),
  })
  .passthrough();

/** Envelope for GET /datasets/:id. */
export const datasetDetailEnvelopeSchema = z.object({ dataset: datasetDetailSchema }).passthrough();

/**
 * data.nemar.org landing payload — conforms to neuroschema v0.4.0
 * core/dataset.schema.json. Passthrough + optional on the deep nested blocks
 * (demographics/data_summary/provenance/extensions) which neuroschema fully
 * specifies and the JSON-Schema conformance test enforces; here we pin the
 * required envelope + identity fields.
 */
export const neuroschemaDatasetSchema = z
  .object({
    schema_version: z.literal(NEUROSCHEMA_VERSION),
    doc_type: z.literal("dataset"),
    dataset_id: z.string().regex(/^[a-z]{2}\d+$/, "neuroschema dataset_id pattern"),
    name: z.string(),
    source: datasetSourceSchema,
    recording_modality: z.array(z.string()).min(1),
    description: z.string().nullable().optional(),
    bids_version: z.string().nullable().optional(),
    license: z.string().nullable().optional(),
  })
  .passthrough();
export type NeuroschemaDataset = z.infer<typeof neuroschemaDatasetSchema>;
