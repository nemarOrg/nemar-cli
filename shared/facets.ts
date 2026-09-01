/**
 * The declared facet vocabulary for dataset search/filtering (epic #1144
 * phase 3, issue #1147). Every column Phases 2 and 2b added to `datasets` is
 * filterable -- a column that is populated but unfilterable is a column only
 * a future phase can use, which is the gap this epic exists to close. See
 * `.context/decisions/0032-facet-filters-are-declared-once-and-report-what-they-exclude.md`.
 *
 * This file is the CLI/wire-facing half of the split: facet key, CLI flag,
 * value kind, enum members, unit, label. NO SQL, no D1 types -- those live in
 * `backend/src/services/dataset-facets.ts`, which binds each of these keys to
 * columns and NULL semantics. `backend/test/facet-table-correspondence.unit.test.ts`
 * asserts the two files declare the exact same set of keys in both
 * directions, so a half-added facet fails CI rather than silently doing
 * nothing when a flag is wired to it in a later phase.
 *
 * Deliberately NOT included here (see the plan's D5 "Deliberately not
 * filterable" list): `recordings_measured`, `bytes_present` (bookkeeping
 * denominators, not user-facing facts) and the `*_at` sweep-state stamps.
 * Also not here: the pre-existing bespoke filters (`search`, `modality`,
 * `author`, `task`, `hasDoi`, `hasHed`, `dataComplete`, `recent`,
 * `licenseTiers`) -- their semantics (FTS routing, LIKE-joined lists) don't
 * fit this table and keep their existing home in
 * `backend/src/services/dataset-filters.ts`.
 *
 * Zero dependencies beyond `shared/contract`, so both `src/` (CLI, phase 4)
 * and `backend/` (SQL binding) import the SAME vocabulary.
 */

import { datasetSourceSchema } from "./contract/dataset.js";

/** How a facet's value is denominated for parsing and display. Distinct from
 *  the backend's SQL-binding "kind" (scalar/pair/pair-with-fallback/enum/
 *  text/version-prefix) in `dataset-facets.ts` -- this is what the CLI and a
 *  human need to know; that is what the SQL builder needs to know. */
export type FacetValueKind = "number" | "bytes" | "duration" | "enum" | "text" | "version";

export interface FacetDefinition {
  /** Stable identifier used internally (the `FacetKey` that indexes
   *  `FacetFilterValues` and `dataset-facets.ts`'s SQL table). NOT
   *  necessarily the HTTP query-string parameter -- see {@link queryParam}.
   *  Several keys (`recording-length`, `electrode-system`, `bids-version`,
   *  `hed-version`) are hyphenated to match the CLI flag; the wire form of
   *  those four is the underscored `queryParam` instead (#1165 review I3:
   *  a hyphenated query param, e.g. `?recording-length=`, is off the
   *  snake_case house style every other param uses -- `has_hed`,
   *  `data_complete`, `min_score`). */
  readonly key: string;
  /** The CLI flag phase 4 will register (e.g. `--recording-length`).
   *  Kebab-case, independent of {@link queryParam}. */
  readonly flag: string;
  /** The HTTP query-string parameter name (e.g. `recording_length`),
   *  snake_case per the house style. Equal to {@link key} for every facet
   *  whose key has no hyphen; explicitly overridden below for the four that
   *  do, so `key` can stay hyphenated (matching `flag`) without leaking a
   *  hyphen onto the wire. */
  readonly queryParam: string;
  readonly valueKind: FacetValueKind;
  /** Human-readable label for help text / the phase 5 facets endpoint. */
  readonly label: string;
  /** Display unit for a `number`/`bytes`/`duration` facet (e.g. "channels",
   *  "subjects"). Absent for enum/text/version facets. */
  readonly unit?: string;
  /** Valid members for an `enum` facet. Absent otherwise. */
  readonly enumValues?: readonly string[];
}

/**
 * Enum members verified against all 755 public rows at plan time (see D5):
 * `electrode_system` is 10-10 x341, other x49, egi-geodesic x43, 10-20 x40,
 * 10-05 x26, biosemi x11, NULL x245. `power_line_frequency` is 50/60 by
 * schema (inheritable.schema.json), not by observation -- migration 0071
 * drops anything else to NULL, so the filter enum matches the write path.
 * `zarr_status` mirrors migration 0035's CHECK constraint exactly.
 */
const ELECTRODE_SYSTEM_VALUES = [
  "10-05",
  "10-10",
  "10-20",
  "biosemi",
  "egi-geodesic",
  "other",
] as const;
const POWERLINE_VALUES = ["50", "60"] as const;
const ZARR_STATUS_VALUES = ["ready", "pending", "failed"] as const;
/** Reuses the contract's `source` enum rather than re-deriving it, so the two
 *  can't drift (`datasetSourceSchema.options` is `["openneuro","nemar","gin","other"]`). */
const SOURCE_VALUES = datasetSourceSchema.options;

/**
 * Twenty facets, five kinds. Order here is the canonical order the backend's
 * generic facet walk applies clauses in (`dataset-facets.ts` iterates in this
 * same order) -- stable but not semantically load-bearing, since every clause
 * is AND-ed.
 */
export const FACETS: readonly FacetDefinition[] = [
  {
    key: "subjects",
    flag: "--subjects",
    queryParam: "subjects",
    valueKind: "number",
    label: "Subject count",
    unit: "subjects",
  },
  {
    key: "channels",
    flag: "--channels",
    queryParam: "channels",
    valueKind: "number",
    label: "Channel count",
    unit: "channels",
  },
  {
    key: "sessions",
    flag: "--sessions",
    queryParam: "sessions",
    valueKind: "number",
    label: "Session count",
    unit: "sessions",
  },
  { key: "size", flag: "--size", queryParam: "size", valueKind: "bytes", label: "Dataset size" },
  {
    key: "files",
    flag: "--files",
    queryParam: "files",
    valueKind: "number",
    label: "File count",
    unit: "files",
  },
  {
    key: "citations",
    flag: "--citations",
    queryParam: "citations",
    valueKind: "number",
    label: "Citation count",
    unit: "citations",
  },
  {
    key: "duration",
    flag: "--duration",
    queryParam: "duration",
    valueKind: "duration",
    label: "Total recording duration",
  },
  {
    key: "recording-length",
    flag: "--recording-length",
    // #1165 review I3: snake_case on the wire (D1's column name too),
    // hyphenated everywhere else (key, flag) -- see the queryParam doc
    // comment on FacetDefinition.
    queryParam: "recording_length",
    valueKind: "duration",
    label: "Per-recording duration",
  },
  {
    key: "recordings",
    flag: "--recordings",
    queryParam: "recordings",
    valueKind: "number",
    label: "Recording count",
    unit: "recordings",
  },
  {
    key: "unavailable",
    flag: "--unavailable",
    queryParam: "unavailable",
    valueKind: "number",
    label: "Unavailable recording count",
    unit: "recordings",
  },
  {
    key: "age",
    flag: "--age",
    queryParam: "age",
    valueKind: "number",
    label: "Participant age",
    unit: "years",
  },
  {
    key: "rate",
    flag: "--rate",
    queryParam: "rate",
    valueKind: "number",
    label: "Sampling rate",
    unit: "Hz",
  },
  {
    key: "powerline",
    flag: "--powerline",
    queryParam: "powerline",
    valueKind: "enum",
    label: "Power line frequency",
    enumValues: POWERLINE_VALUES,
  },
  {
    key: "reference",
    flag: "--reference",
    queryParam: "reference",
    valueKind: "text",
    label: "EEG reference",
  },
  {
    key: "placement",
    flag: "--placement",
    queryParam: "placement",
    valueKind: "text",
    label: "Electrode placement scheme",
  },
  {
    key: "electrode-system",
    flag: "--electrode-system",
    // #1165 review I3: snake_case on the wire; see recording-length above.
    queryParam: "electrode_system",
    valueKind: "enum",
    label: "Electrode system",
    enumValues: ELECTRODE_SYSTEM_VALUES,
  },
  {
    key: "source",
    flag: "--source",
    queryParam: "source",
    valueKind: "enum",
    label: "Source archive",
    enumValues: SOURCE_VALUES,
  },
  {
    key: "zarr",
    flag: "--zarr",
    queryParam: "zarr",
    valueKind: "enum",
    label: "Zarr conversion status",
    enumValues: ZARR_STATUS_VALUES,
  },
  {
    key: "bids-version",
    flag: "--bids-version",
    // #1165 review I3: snake_case on the wire; see recording-length above.
    queryParam: "bids_version",
    valueKind: "version",
    label: "BIDS version",
  },
  {
    key: "hed-version",
    flag: "--hed-version",
    // #1165 review I3: snake_case on the wire; see recording-length above.
    queryParam: "hed_version",
    valueKind: "version",
    label: "HED version",
  },
] as const;

export type FacetKey = (typeof FACETS)[number]["key"];

const FACETS_BY_KEY = new Map(FACETS.map((f) => [f.key, f]));

export function getFacetDefinition(key: string): FacetDefinition | undefined {
  return FACETS_BY_KEY.get(key);
}
