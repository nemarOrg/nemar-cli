/**
 * One centralized provenance-envelope builder for the three recording-level
 * MCP tools (epic #1065 phase 3, issue #1295; plan decision 5).
 *
 * `computeProvenanceEnvelope` (`shared/contract/mcp.ts`) is the pure
 * assembly function; this file is the ONE place that decides what to feed
 * it for a v3 store versus a legacy (v1/v2) one, so `list_recordings`,
 * `get_events`, and `render_overview` cannot silently diverge on the
 * inference rule for a legacy index.
 *
 * Deliberately takes the resolved INDEX-LEVEL FACTS
 * (`datasetId`/`engineVersion`/`doi`/`license`/`citation`/`isLegacy`) as
 * plain fields rather than a whole parsed `ZarrIndexDocument`: those facts
 * are exactly what each tool's cached projection already carries (decision
 * 4's "recordings"/"events/*"/"overview/*" projections each cache the
 * index-level facts they were built from, not just the per-store rows), so
 * an envelope can be built on a projection-CACHE HIT without a second
 * `index.json` fetch -- the invariant the plan's own test list asks for
 * ("a second call is a cache hit with NO index fetch in the request log").
 * A caller resolves `engineVersion`/`doi`/`license`/`citation`/`isLegacy`
 * once, at projection-build time, from whichever `ZarrIndexDocument` it
 * just parsed (see `list-recordings.ts`'s `buildProjection`), and caches
 * them alongside the per-store rows.
 *
 * **v3**: every field comes straight off the index/store/group, exactly as
 * `computeProvenanceEnvelope`'s own doc describes.
 *
 * **Legacy (v1/v2)**: `engineVersion` is the format version itself as a
 * string (e.g. `"1"`) -- a legacy index carries no engine stamp at all;
 * `doi`/`license`/`citation` are always `null` from the index side (a
 * legacy index never hoisted them) -- the catalog row's own `doi`/`license`
 * still win via `computeProvenanceEnvelope`'s `fromCatalogOrIndex` rule.
 * `source_tree` is always `"raw"` here because a legacy store under
 * `derivatives/`, `sourcedata/`, or `code/` is never handed to this
 * function in the first place -- ADR 0027 made discovery raw-only for v3,
 * and phase 3's list/events/overview tools apply the identical exclusion to
 * a legacy index themselves (each counts the exclusion, per decision 5/6),
 * so by the time a store reaches here its path is already known-raw.
 * `derived` is always `false` and `sss` is always absent -- ADR 0028's SSS
 * record is a v3-only concept; a legacy index predates it. Every legacy
 * envelope carries {@link LEGACY_ENVELOPE_NOTE}, since `source_tree`/
 * `derived`/`engine_version` are all INFERRED, not read off the document.
 *
 * **No usable commit**: the envelope schema requires a 40-hex
 * `source_commit`; when the reader's `sourceCommit` is `null` (a legacy
 * document with an empty `source_commit`, #1197's on008083 case), no
 * envelope can be built at all -- callers omit `envelope` (optional on
 * every phase 3 output schema) and surface {@link EnvelopeResult.note}
 * instead.
 */

import {
  type ProvenanceEnvelope,
  computeProvenanceEnvelope,
} from "../../../shared/contract/mcp.js";
import type { ZarrGroup, ZarrStore } from "../../../shared/contract/zarr-index.js";
import type { PublicDatasetRow } from "./catalog-row.js";

const LEGACY_NON_RAW_PREFIXES = ["derivatives/", "sourcedata/", "code/"];

/** True for a store path under `derivatives/`, `sourcedata/`, or `code/`
 *  -- the ADR 0027 exclusion, applicable only to a legacy (v1/v2) index
 *  today, since the v3 producer never publishes such a path at all. */
export function isLegacyNonRawPath(path: string): boolean {
  return LEGACY_NON_RAW_PREFIXES.some((prefix) => path.startsWith(prefix));
}

export const LEGACY_ENVELOPE_NOTE =
  "legacy index v1: re-conversion pending; source_tree, derived and engine stamp are inferred";
export const NO_COMMIT_NOTE =
  "index.json carries no usable (40-hex) source_commit; envelope omitted";

/** The store shape this function reads from: a v3 `ZarrStore`, or a legacy
 *  store, which carries only `path` (plus whatever the caller already
 *  resolved -- v3-only fields are simply absent on a legacy store). Every
 *  phase 3 projection already synthesizes `source_tree`/`derived` for a
 *  legacy store (`"raw"`/`false`) before caching it, so this function never
 *  needs to re-derive them itself. */
export type EnvelopeStoreInput = { path: string } & Partial<
  Pick<ZarrStore, "source_tree" | "derived" | "sss" | "units_report">
>;

/** The index-level facts a cached projection carries, resolved once at
 *  projection-build time (see the module doc). */
export interface EnvelopeIndexFacts {
  datasetId: string;
  /** `index.engine_version` (v3) or `String(formatVersion)` (legacy). */
  engineVersion: string;
  doi: string | null;
  license: string | null;
  citation: string | null;
  /** True when the source projection came from a v1/v2 (legacy) index --
   *  drives {@link LEGACY_ENVELOPE_NOTE} and the non-raw-path guard below. */
  isLegacy: boolean;
}

export interface BuildEnvelopeForStoreInput {
  indexFacts: EnvelopeIndexFacts;
  /** From the reader/projection; `null` means no usable commit. */
  sourceCommit: string | null;
  indexEtag: string | null;
  row: PublicDatasetRow;
  store: EnvelopeStoreInput;
  group?: Pick<ZarrGroup, "rate" | "source_rate_hz">;
  /** `"int16"` only when the caller actually decoded a view or level-0
   *  array for this call (decision 5) -- `list_recordings` and `get_events`
   *  never do, so they leave this `null`. */
  dtype?: string | null;
}

export interface EnvelopeResult {
  envelope: ProvenanceEnvelope | null;
  note: string | null;
}

/** Build (or explain why not) the provenance envelope for one store. Never
 *  throws on a missing commit -- returns `{envelope: null, note}` instead,
 *  since that is a normal, expected state for a freshly-discovered v1
 *  dataset, not a bug. DOES throw if handed a legacy store under
 *  `derivatives/`/`sourcedata/`/`code/`: every phase 3 tool must exclude
 *  such a store BEFORE calling this (and count the exclusion), so reaching
 *  this function with one is a caller bug, not a data condition to degrade
 *  gracefully around. */
export function buildEnvelopeForStore(input: BuildEnvelopeForStoreInput): EnvelopeResult {
  const { indexFacts, sourceCommit, indexEtag, row, store, group, dtype } = input;

  if (!sourceCommit) {
    return { envelope: null, note: NO_COMMIT_NOTE };
  }

  const catalogEntry = {
    doi: row.concept_doi,
    license: row.license,
    zarr_verify_status:
      (row.zarr_verify_status as "verified" | "failed" | "unverifiable" | null) ?? null,
  };

  if (!indexFacts.isLegacy) {
    const envelope = computeProvenanceEnvelope({
      index: {
        dataset_id: indexFacts.datasetId,
        source_commit: sourceCommit,
        engine_version: indexFacts.engineVersion,
        doi: indexFacts.doi,
        license: indexFacts.license,
        citation: indexFacts.citation,
      },
      store: {
        source_tree: store.source_tree ?? "raw",
        derived: store.derived ?? false,
        sss: store.sss,
        units_report: store.units_report,
      },
      group,
      catalogEntry,
      indexEtag,
      dtype: dtype ?? null,
      note: null,
    });
    return { envelope, note: null };
  }

  if (isLegacyNonRawPath(store.path)) {
    throw new Error(
      `buildEnvelopeForStore: "${store.path}" is a legacy non-raw path (derivatives/, sourcedata/, or code/) and must be excluded by the caller (and counted) before an envelope is built for it -- ADR 0027`,
    );
  }

  const envelope = computeProvenanceEnvelope({
    index: {
      dataset_id: indexFacts.datasetId,
      source_commit: sourceCommit,
      engine_version: indexFacts.engineVersion,
      doi: null,
      license: null,
      citation: null,
    },
    store: {
      source_tree: "raw",
      derived: false,
      sss: undefined,
      units_report: undefined,
    },
    group,
    catalogEntry,
    indexEtag,
    dtype: dtype ?? null,
    note: LEGACY_ENVELOPE_NOTE,
  });
  return { envelope, note: LEGACY_ENVELOPE_NOTE };
}
