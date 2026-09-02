/**
 * SQL binding for the declared facet vocabulary (epic #1144 phase 3, issue
 * #1147). `shared/facets.ts` is the CLI/wire-facing vocabulary (key, flag,
 * value kind, enum members); this file is the other half -- per facet key,
 * the SQL kind (`scalar` | `pair` | `pair-with-fallback` | `enum` | `text` |
 * `version-prefix`), the column(s), and the NULL test `include_unknown`
 * widens with. See
 * `.context/decisions/0032-facet-filters-are-declared-once-and-report-what-they-exclude.md`.
 *
 * `backend/test/facet-table-correspondence.unit.test.ts` asserts this file and
 * `shared/facets.ts` declare the exact same set of keys in both directions.
 *
 * Two filter kinds, because half the columns Phases 2/2b added are ranges:
 *  - `scalar`: one column holds one value. `col >= ? AND col <= ?`.
 *  - `pair`: two columns hold a min and a max. The correct semantic is
 *    OVERLAP, not containment -- `--age 5..18` must match a dataset spanning
 *    12..25, because that dataset does contain participants in the requested
 *    range. `col_max >= ? AND col_min <= ?`.
 *  - `pair-with-fallback` (channels only): the derived per-recording pair
 *    (`channel_count_min/max`, 0% populated until the sweep runs) is
 *    authoritative but often absent; `n_channels` (one sampled sidecar,
 *    72% populated) is a known-imperfect but currently-available fallback.
 *    `COALESCE(col_max, fallback) >= ? AND COALESCE(col_min, fallback) <= ?`
 *    collapses to the plain scalar check when the pair is NULL and to the
 *    true overlap when it's populated.
 *
 * `buildFacetClauses` is called from `dataset-filters.ts#buildDatasetFilterClauses`
 * as a generic walk over this table -- the existing bespoke filters (search,
 * modality, author, task, hasDoi, hasHed, dataComplete, recent, licenseTiers)
 * are NOT migrated here; their semantics don't fit a declared table and
 * migrating them was out of scope (see the plan's D2).
 */

import type { FacetKey } from "../../../shared/facets.js";
import { FACETS } from "../../../shared/facets.js";
import { type RangeValueKind, parseRange } from "../../../shared/range.js";

/**
 * Escape SQLite LIKE wildcards, identical to `dataset-filters.ts#escapeLikePattern`.
 * Reimplemented here (not imported) so this file stays a leaf that only
 * depends on `shared/` -- `dataset-filters.ts` is the one that imports FROM
 * this file (to call {@link buildFacetClauses}), and an import the other way
 * would recreate the exact two-file cycle that file's own header comment
 * documents fixing once already, one layer down. Both copies are one line
 * over the same wildcard set; a change to SQLite's LIKE escaping rules would
 * need both, which is an acceptable trade against a cycle.
 */
function escapeLikePattern(raw: string): string {
  return raw.replace(/[\\%_]/g, "\\$&");
}

export type FacetSqlKind =
  | "scalar"
  | "pair"
  | "pair-with-fallback"
  | "enum"
  | "text"
  | "version-prefix";

interface ScalarFacetSpec {
  readonly key: FacetKey;
  readonly kind: "scalar";
  readonly column: string;
  readonly rangeKind: RangeValueKind;
  readonly nullTest: string;
}

interface PairFacetSpec {
  readonly key: FacetKey;
  readonly kind: "pair";
  readonly minColumn: string;
  readonly maxColumn: string;
  readonly rangeKind: RangeValueKind;
  readonly nullTest: string;
}

interface PairWithFallbackFacetSpec {
  readonly key: FacetKey;
  readonly kind: "pair-with-fallback";
  readonly minColumn: string;
  readonly maxColumn: string;
  readonly fallbackColumn: string;
  readonly rangeKind: RangeValueKind;
  readonly nullTest: string;
}

interface EnumFacetSpec {
  readonly key: FacetKey;
  readonly kind: "enum";
  readonly column: string;
  /** True when the column has numeric (not text) affinity -- e.g.
   *  `power_line_frequency` is REAL even though its enum members are
   *  written as strings ("50"/"60") in `shared/facets.ts`. */
  readonly numeric?: boolean;
  readonly nullTest: string;
}

interface TextFacetSpec {
  readonly key: FacetKey;
  readonly kind: "text";
  readonly column: string;
  readonly nullTest: string;
}

interface VersionPrefixFacetSpec {
  readonly key: FacetKey;
  readonly kind: "version-prefix";
  readonly column: string;
  readonly nullTest: string;
}

export type FacetSqlSpec =
  | ScalarFacetSpec
  | PairFacetSpec
  | PairWithFallbackFacetSpec
  | EnumFacetSpec
  | TextFacetSpec
  | VersionPrefixFacetSpec;

/**
 * The twenty facets, bound to `datasets` columns (all read via the `d`
 * alias, matching every other clause in `dataset-filters.ts`). Order matches
 * `shared/facets.ts#FACETS` for readability; the correspondence test checks
 * set equality, not order.
 */
export const FACET_DEFINITIONS: readonly FacetSqlSpec[] = [
  {
    key: "subjects",
    kind: "scalar",
    column: "d.subject_count",
    rangeKind: "number",
    nullTest: "d.subject_count IS NULL",
  },
  {
    key: "channels",
    kind: "pair-with-fallback",
    minColumn: "d.channel_count_min",
    maxColumn: "d.channel_count_max",
    fallbackColumn: "d.n_channels",
    rangeKind: "number",
    // Mirrors D1's exemplar-fallback rule exactly: the pair collapses to the
    // exemplar when unpopulated, so "unknown" is defined the same way.
    nullTest: "COALESCE(d.channel_count_max, d.n_channels) IS NULL",
  },
  {
    key: "sessions",
    kind: "scalar",
    column: "d.sessions_count",
    rangeKind: "number",
    nullTest: "d.sessions_count IS NULL",
  },
  {
    key: "size",
    kind: "scalar",
    column: "d.file_size",
    rangeKind: "bytes",
    nullTest: "d.file_size IS NULL",
  },
  {
    key: "files",
    kind: "scalar",
    column: "d.total_files",
    rangeKind: "number",
    nullTest: "d.total_files IS NULL",
  },
  {
    key: "citations",
    kind: "scalar",
    // Derived, not stored (#1182): the num_citations column is gone and the
    // total is the sum of the two addends everywhere it is served (see the
    // catalog projections). Both addends are NOT NULL DEFAULT 0 (migration
    // 0048), so the sum is never NULL -- this nullTest never matches a row,
    // which is correct: there is no "unknown citation count" state for
    // include_unknown to widen into.
    column: "(d.num_dataset_citations + d.num_datapaper_citations)",
    rangeKind: "number",
    nullTest: "(d.num_dataset_citations + d.num_datapaper_citations) IS NULL",
  },
  {
    key: "duration",
    kind: "scalar",
    column: "d.total_recording_duration",
    rangeKind: "duration",
    nullTest: "d.total_recording_duration IS NULL",
  },
  {
    key: "recording-length",
    kind: "pair",
    minColumn: "d.recording_duration_min",
    maxColumn: "d.recording_duration_max",
    rangeKind: "duration",
    // OR, not AND (#1165 review P2): either bound unknown means the row's
    // range isn't fully known, so include_unknown=1 must widen it in.
    // Migration 0070 documents this pair (with channel_count_min/max) as
    // written together, atomically, only on a successful recording-stats
    // sweep read -- so in practice the two columns never split -- but
    // that is a fact about how the write path currently behaves, not a
    // property this predicate should lean on; see the age_min/age_max
    // pair below, where the equivalent atomic-write assumption is false.
    nullTest: "(d.recording_duration_min IS NULL OR d.recording_duration_max IS NULL)",
  },
  {
    key: "recordings",
    kind: "scalar",
    column: "d.recording_count",
    rangeKind: "number",
    nullTest: "d.recording_count IS NULL",
  },
  {
    key: "unavailable",
    kind: "scalar",
    // Real 0 values are distinct from NULL (no successful sweep yet) --
    // read the raw column, never COALESCE to zero (migration 0070).
    column: "d.recordings_unavailable",
    rangeKind: "number",
    nullTest: "d.recordings_unavailable IS NULL",
  },
  {
    key: "age",
    kind: "pair",
    minColumn: "d.age_min",
    maxColumn: "d.age_max",
    rangeKind: "number",
    // OR, not AND (#1165 review P2): either bound unknown means the row's
    // range isn't fully known, so include_unknown=1 must widen it in. This
    // pair is NOT written atomically like recording_duration_min/max above:
    // migration 0020 added age_min/age_max well before the recording-stats
    // sweep existed, populated independently by two different paths
    // (llm-enrich's webhook and refreshMetadataAfterVersionDoi), and
    // migration 0023's backfill explicitly COALESCE-preserves each bound
    // on its own -- a row can genuinely have one bound set and the other
    // still NULL.
    nullTest: "(d.age_min IS NULL OR d.age_max IS NULL)",
  },
  {
    key: "rate",
    kind: "scalar",
    column: "d.sampling_frequency",
    rangeKind: "number",
    nullTest: "d.sampling_frequency IS NULL",
  },
  {
    key: "powerline",
    kind: "enum",
    column: "d.power_line_frequency",
    numeric: true,
    nullTest: "d.power_line_frequency IS NULL",
  },
  {
    key: "reference",
    kind: "text",
    column: "d.eeg_reference",
    nullTest: "d.eeg_reference IS NULL",
  },
  {
    key: "placement",
    kind: "text",
    column: "d.placement_scheme",
    nullTest: "d.placement_scheme IS NULL",
  },
  {
    key: "electrode-system",
    kind: "enum",
    column: "d.electrode_system",
    nullTest: "d.electrode_system IS NULL",
  },
  { key: "source", kind: "enum", column: "d.source", nullTest: "d.source IS NULL" },
  { key: "zarr", kind: "enum", column: "d.zarr_status", nullTest: "d.zarr_status IS NULL" },
  {
    key: "bids-version",
    kind: "version-prefix",
    column: "d.bids_version",
    nullTest: "d.bids_version IS NULL",
  },
  {
    key: "hed-version",
    kind: "version-prefix",
    column: "d.hed_version",
    nullTest: "d.hed_version IS NULL",
  },
];

/**
 * Every facet declared in `shared/facets.ts` MUST have an SQL binding here.
 *
 * ADR 0032 says a half-added facet "fails CI instead of a flag silently doing
 * nothing". That was true of CI and only CI: the correspondence test was the
 * single thing standing between a declared-but-unbound facet and production,
 * with no defence behind it (#1177 cross-phase review). Verified: a facet in
 * `FACETS` with no entry below makes `GET /datasets?<its param>=1..5` return
 * 200 with EVERY row, filter silently ignored -- a plausible, wrong answer,
 * which is the worst shape of failure this epic has.
 *
 * Throwing at module scope is deliberate. This is a programming error, not a
 * data condition: the two tables are both source, edited together, and an
 * inconsistency means the filter engine cannot be trusted at all. Failing the
 * import fails the deploy loudly, which is strictly better than serving
 * unfiltered results that look filtered. Same posture as
 * the facet binding, which throws rather than emit wrong SQL.
 */
const UNBOUND_FACETS = FACETS.filter((f) => !FACET_DEFINITIONS.some((d) => d.key === f.key));
if (UNBOUND_FACETS.length > 0) {
  const keys = UNBOUND_FACETS.map((f) => f.key).join(", ");
  throw new Error(
    `dataset-facets: ${UNBOUND_FACETS.length} facet(s) declared in shared/facets.ts have no SQL binding, so their filters would silently return unfiltered results: ${keys}`,
  );
}

const FACET_DEFINITIONS_BY_KEY = new Map(FACET_DEFINITIONS.map((s) => [s.key, s]));

// --- Parsed filter values -----------------------------------------------

export interface FacetRangeValue {
  readonly kind: "range";
  readonly min: number | null;
  readonly max: number | null;
}
export interface FacetEnumValue {
  readonly kind: "enum";
  readonly values: readonly string[];
}
export interface FacetTextValue {
  readonly kind: "text";
  readonly value: string;
}
export interface FacetVersionValue {
  readonly kind: "version";
  /** Leading `v` already stripped (production holds both `1.2.1` and
   *  `v1.2.1`; the comparison strips both sides the same way). */
  readonly prefix: string;
}
export type FacetValue = FacetRangeValue | FacetEnumValue | FacetTextValue | FacetVersionValue;

/** Parsed, validated facet values -- what `buildFacetClauses` consumes.
 *  Absent key = facet not active. Built by {@link parseFacetFilters}. */
export type FacetFilterValues = Partial<Record<FacetKey, FacetValue>>;

/** True when at least one facet is active. Used both to gate the
 *  `excluded_unknown` computation (an unfiltered list pays nothing for it)
 *  and by `dataset-search.ts#hasActiveFilters`, which folds this in instead
 *  of hand-enumerating twenty facet keys as a third maintained list. */
export function isAnyFacetActive(facets: FacetFilterValues | undefined): boolean {
  return Boolean(facets && Object.keys(facets).length > 0);
}

/**
 * Thrown by {@link parseFacetFilters} when an `enum`-kind facet gets a token
 * outside its declared vocabulary (#1165 review P1). Mirrors
 * {@link RangeParseError}'s role: a rejection the route handler is expected
 * to translate into a 400, naming the bad token and listing the valid
 * values rather than silently ignoring it. See ADR 0032 for why this is
 * deliberately NOT the same policy `parseLicenseTierFilter` uses for the
 * pre-existing `license` param.
 */
export class FacetEnumParseError extends Error {
  constructor(
    readonly key: FacetKey,
    readonly badTokens: readonly string[],
    readonly allowedValues: readonly string[],
  ) {
    super(
      `Invalid value${badTokens.length > 1 ? "s" : ""} for facet "${key}": ` +
        `${badTokens.map((t) => `"${t}"`).join(", ")} -- must be one of: ${allowedValues.join(", ")}`,
    );
    this.name = "FacetEnumParseError";
  }
}

/**
 * Parse every facet's raw query-string value (via `getParam(queryParam)`,
 * keyed by the facet's snake_case wire `queryParam` -- e.g.
 * `?recording_length=10..20` -- NOT its (possibly hyphenated) internal
 * `key`; see `shared/facets.ts`'s `queryParam` doc comment, #1165 review
 * I3) into a validated {@link FacetFilterValues} bag, indexed by `key`.
 * Throws {@link RangeParseError} (from `shared/range.ts`) on an invalid
 * range, or {@link FacetEnumParseError} on an unrecognised enum token
 * (#1165 review P1); the caller (the route handler) is expected to
 * translate either into a 400. This is a deliberate asymmetry with the
 * pre-existing `license` param (`parseLicenseTierFilter`), which still
 * drops unrecognised tokens silently -- see ADR 0032.
 */
export function parseFacetFilters(
  getParam: (key: string) => string | undefined,
): FacetFilterValues {
  const result: Partial<Record<FacetKey, FacetValue>> = {};
  for (const facet of FACETS) {
    const raw = getParam(facet.queryParam);
    if (raw === undefined || raw.trim() === "") continue;
    switch (facet.valueKind) {
      case "number":
      case "bytes":
      case "duration": {
        const bounds = parseRange(raw, facet.valueKind);
        result[facet.key] = { kind: "range", min: bounds.min, max: bounds.max };
        break;
      }
      case "enum": {
        const allowed = new Set(facet.enumValues ?? []);
        const tokens = raw
          .split(",")
          .map((t) => t.trim().toLowerCase())
          .filter((t) => t !== "");
        const badTokens = [...new Set(tokens.filter((t) => !allowed.has(t)))];
        if (badTokens.length > 0) {
          throw new FacetEnumParseError(facet.key, badTokens, facet.enumValues ?? []);
        }
        const values = [...new Set(tokens)];
        if (values.length > 0) {
          result[facet.key] = { kind: "enum", values };
        }
        break;
      }
      case "text": {
        result[facet.key] = { kind: "text", value: raw };
        break;
      }
      case "version": {
        const prefix = raw.trim().replace(/^v/i, "");
        if (prefix !== "") {
          result[facet.key] = { kind: "version", prefix };
        }
        break;
      }
    }
  }
  return result;
}

interface BuiltPredicate {
  sql: string;
  params: (string | number)[];
}

function buildRangePredicate(
  spec: ScalarFacetSpec | PairFacetSpec | PairWithFallbackFacetSpec,
  value: FacetRangeValue,
): BuiltPredicate | null {
  const clauses: string[] = [];
  const params: number[] = [];
  if (spec.kind === "scalar") {
    if (value.min !== null) {
      clauses.push(`${spec.column} >= ?`);
      params.push(value.min);
    }
    if (value.max !== null) {
      clauses.push(`${spec.column} <= ?`);
      params.push(value.max);
    }
  } else if (spec.kind === "pair") {
    // Overlap, not containment: the dataset's [min,max] must intersect the
    // requested [value.min,value.max], not sit entirely inside it.
    if (value.min !== null) {
      clauses.push(`${spec.maxColumn} >= ?`);
      params.push(value.min);
    }
    if (value.max !== null) {
      clauses.push(`${spec.minColumn} <= ?`);
      params.push(value.max);
    }
  } else {
    // pair-with-fallback: same overlap shape, degrading to the exemplar
    // scalar on each side when the derived pair column is NULL.
    if (value.min !== null) {
      clauses.push(`COALESCE(${spec.maxColumn}, ${spec.fallbackColumn}) >= ?`);
      params.push(value.min);
    }
    if (value.max !== null) {
      clauses.push(`COALESCE(${spec.minColumn}, ${spec.fallbackColumn}) <= ?`);
      params.push(value.max);
    }
  }
  if (clauses.length === 0) return null;
  return { sql: clauses.join(" AND "), params };
}

function buildEnumPredicate(spec: EnumFacetSpec, value: FacetEnumValue): BuiltPredicate | null {
  if (value.values.length === 0) return null;
  const placeholders = value.values.map(() => "?").join(", ");
  const params: (string | number)[] = spec.numeric
    ? value.values.map((v) => Number(v))
    : [...value.values];
  return { sql: `${spec.column} IN (${placeholders})`, params };
}

function buildTextPredicate(spec: TextFacetSpec, value: FacetTextValue): BuiltPredicate {
  const pattern = `%${escapeLikePattern(value.value.toLowerCase())}%`;
  return { sql: `LOWER(${spec.column}) LIKE ? ESCAPE '\\'`, params: [pattern] };
}

function buildVersionPredicate(
  spec: VersionPrefixFacetSpec,
  value: FacetVersionValue,
): BuiltPredicate {
  // `bids_version`/`hed_version` are prefix/exact only (D5): production holds
  // 1.9.0, 1.10.0, 1.10.1, 1.11.0, and a lexicographic `>=` is wrong on that
  // data today ('1.9.0' > '1.10.0' as strings). LTRIM's second argument is a
  // set of characters, not a case-insensitive prefix -- 'vV' strips a leading
  // 'v' OR 'V' from the STORED value (production holds "v1.2.1"; a stored
  // "V1.2.1" is untested but not ruled out), matching how the parsed filter
  // value already had its own leading 'v' stripped case-insensitively via
  // `/^v/i` (#1165 review M4: a bare `'v'` here would silently stop matching
  // the moment a stored value used the uppercase form).
  const normalizedColumn = `LTRIM(${spec.column}, 'vV')`;
  const pattern = `${escapeLikePattern(value.prefix)}.%`;
  return {
    sql: `(${normalizedColumn} = ? OR ${normalizedColumn} LIKE ? ESCAPE '\\')`,
    params: [value.prefix, pattern],
  };
}

function buildPredicate(spec: FacetSqlSpec, value: FacetValue): BuiltPredicate | null {
  switch (spec.kind) {
    case "scalar":
    case "pair":
    case "pair-with-fallback":
      if (value.kind !== "range") return null;
      return buildRangePredicate(spec, value);
    case "enum":
      if (value.kind !== "enum") return null;
      return buildEnumPredicate(spec, value);
    case "text":
      if (value.kind !== "text") return null;
      return buildTextPredicate(spec, value);
    case "version-prefix":
      if (value.kind !== "version") return null;
      return buildVersionPredicate(spec, value);
  }
}

/**
 * Append one AND-clause per active facet to `params`/the returned SQL
 * fragment. When `includeUnknown` is set, EVERY active facet's predicate is
 * widened with its declared NULL test (D4, ADR 0005): `(predicate OR
 * nullTest)`. Facets absent from `facets` are skipped entirely -- an
 * unfiltered call returns `""` and pushes nothing, exactly like
 * `buildDatasetFilterClauses` with no legacy filters set.
 */
export function buildFacetClauses(
  params: (string | number)[],
  facets: FacetFilterValues | undefined,
  includeUnknown: boolean,
): string {
  if (!facets) return "";
  let clauses = "";
  for (const spec of FACET_DEFINITIONS) {
    const value = facets[spec.key];
    if (value === undefined) continue;
    const built = buildPredicate(spec, value);
    if (!built) continue;
    clauses += includeUnknown ? ` AND ((${built.sql}) OR ${spec.nullTest})` : ` AND (${built.sql})`;
    params.push(...built.params);
  }
  return clauses;
}

/** One `, SUM(...)` clause per active facet, plus the parallel key list a
 *  caller needs to map each `unk_N` result column back to its {@link FacetKey}. */
export interface ExcludedUnknownBreakdownSql {
  /** `", SUM(CASE WHEN <nullTest> THEN 1 ELSE 0 END) AS unk_0, ..."` -- append
   *  directly after `SELECT COUNT(*) AS total`. Empty string when no facet is
   *  active, so `SELECT COUNT(*) AS total${selectFragment} FROM ...` degrades
   *  to a plain count with no behaviour change. */
  readonly selectFragment: string;
  /** `keysInOrder[i]` is the {@link FacetKey} whose count the result row's
   *  `unk_<i>` column holds, in the SAME order the SUM clauses were emitted. */
  readonly keysInOrder: FacetKey[];
}

/**
 * Epic #1144 phase 4 (#1148), D5: builds the conditional-aggregation SELECT
 * fragment that gives `excluded_unknown_by_facet` its per-facet breakdown in
 * the SAME query that already computes the widened `excluded_unknown` total
 * -- no extra round trip. `unk_N` (a positional index, not the facet key
 * itself) because four facet keys are hyphenated (`recording-length`,
 * `electrode-system`, `bids-version`, `hed-version`) and are not valid SQL
 * identifiers unquoted; the caller maps `unk_N` back to a real {@link
 * FacetKey} via `keysInOrder`.
 *
 * MUST be run against `FROM datasets d ...` directly, never against a query
 * wrapping the row projection: `nullTest` expressions read raw columns like
 * `d.subject_count IS NULL`, and the projection already COALESCEs several of
 * those to a default (`COALESCE(d.subject_count, 0) AS participants`) before
 * an outer query could see them, and drops the `d` alias entirely. See D5's
 * "one structural change" in the phase 4 plan.
 */
export function buildExcludedUnknownBreakdownSql(
  facets: FacetFilterValues | undefined,
): ExcludedUnknownBreakdownSql {
  if (!facets) return { selectFragment: "", keysInOrder: [] };
  const keysInOrder: FacetKey[] = [];
  let selectFragment = "";
  for (const spec of FACET_DEFINITIONS) {
    if (facets[spec.key] === undefined) continue;
    selectFragment += `, SUM(CASE WHEN ${spec.nullTest} THEN 1 ELSE 0 END) AS unk_${keysInOrder.length}`;
    keysInOrder.push(spec.key);
  }
  return { selectFragment, keysInOrder };
}
