/**
 * Quality documents of NEMAR's pipeline runs (ADR 0137 decision 8, epic #2324 phase B1): the dataset
 * `dataQuality` summary a recipe writes beside its dataset record, checked and kept in D1 per run, and the
 * projection of one recording's `dataQuality` entry from its signalJourney record.
 *
 *   `checkDatasetQualityDocument`  a run's `desc-<label>_dataquality.json`, checked against the run
 *   `CURRENT_QUALITY_DOCUMENTS_SQL` the summary of each recipe's current public derivative, for a page
 *   `recordQualityEntry`           one recording's entry, from the bytes of its record
 *
 * THE WORKER CANNOT RUN AJV (it compiles schemas with `new Function`), so the schemas here are zod mirrors of
 * the vendored neuroschema 0.6.0 `dataQuality`, held to Ajv over a corpus by
 * `test/quality-documents-contract.unit.test.ts`, which also holds every pattern below to the bundle's own
 * text. A string length is counted in code points, as JSON Schema counts it. Every integer is capped at
 * 2^53 - 1, as every neuroschema integer is.
 *
 * WHAT IS TRUSTED. Nothing a job wrote is taken on its word: the dataset summary must be one entry, keyed by
 * the stamp's recipe; its identity must be the stamp's; its `record_sha256` must be the digest of the dataset
 * record's bytes read in the same reconciliation; its counts must be the recordings table's; its metric
 * names must be the recipe's own or a plugin's the recipe runs; and the writer's rules no schema can state
 * are run again (nemar-process `dataquality.problems`). The dataset a document belongs to is bound from the
 * stamp when it is stored and from the D1 row when it is read, never from the document.
 *
 * A recording's views are not validated whole here: B2's view mirror (`quality-views.ts`) checks each
 * declaration before the route serves it. This file checks what the entry itself states: its identity, its
 * metrics and their producers, the head of each view (key, kind, source), the views skipped, the copy each
 * store input names, and `nemar.record-checks.v1`.
 */

import { z } from "zod";
import {
  DATA_QUALITY_MAX_BYTES,
  DATA_QUALITY_VIEWS_MAX,
  JSON_SAFE_INTEGER,
  NOT_PROCESSED_MAX,
  PROFILE_OF_INPUT,
  type RecordFinding,
  metricNameOutsideRecipe,
  metricPlugin,
  recordChecks,
} from "../../../shared/contract/data-quality.js";
import { QUALITY_RELATIVE_LOCATION_SOURCE } from "../../../shared/contract/quality-route.js";
import { readIJson, sha256HexOfBytes } from "../../../shared/contract/view-digest.js";
import { PIPELINE_TERMS, type PipelineTermId } from "./compute-pipeline-eligibility.js";

// --- Patterns ----------------------------------------------------------------------------------------

const unicode = (source: string): RegExp => new RegExp(source, "u");

/**
 * The neuroschema 0.6.0 patterns this file checks, compiled as Ajv compiles them (the `u` flag). Each
 * `source` equals the vendored bundle's pattern's (the contract test compares them), so a re-vendor that
 * changes one fails until it is copied here.
 */
export const QUALITY_PATTERNS = Object.freeze({
  recipeId: unicode(String.raw`^[a-z0-9-]{1,64}$(?!\n)`),
  version: unicode(String.raw`^[0-9A-Za-z._+-]{1,64}$(?!\n)`),
  sha256: unicode(String.raw`^[0-9a-f]{64}$(?!\n)`),
  failureCode: unicode(String.raw`^[a-z][a-z0-9_]{0,63}$(?!\n)`),
  metricName: unicode(String.raw`^[A-Za-z][A-Za-z0-9_-]*(:[A-Za-z][A-Za-z0-9_-]*)?$(?!\n)`),
  relativeLocation: unicode(QUALITY_RELATIVE_LOCATION_SOURCE),
  viewKey: unicode(String.raw`^[a-z][a-z0-9_]{0,63}$(?!\n)`),
  kindName: unicode(String.raw`^[a-z][a-z0-9]*(\.[a-z][a-z0-9-]*)+$(?!\n)`),
  pluginName: unicode(String.raw`^[A-Za-z][A-Za-z0-9_-]{0,63}$(?!\n)`),
});

/** Code points, as JSON Schema's `minLength` and `maxLength` count them. */
const codePoints = (s: string): number => {
  let n = 0;
  for (const _ of s) n++;
  return n;
};

const text = (pattern: RegExp | null, min = 0, max = Number.POSITIVE_INFINITY) =>
  z.string().refine((s) => {
    const n = codePoints(s);
    return n >= min && n <= max && (pattern === null || pattern.test(s));
  });

const P = QUALITY_PATTERNS;
const int53 = z.number().int().min(0).max(JSON_SAFE_INTEGER);
const finite = z.number().finite();
const nullableNumber = finite.nullable();

const recipeId = text(P.recipeId);
const version = text(P.version);
const sha256 = text(P.sha256);
const failureCode = text(P.failureCode);
const metricName = text(P.metricName, 0, 128);
const relativeLocation = text(P.relativeLocation, 1, 1024);
const unit = text(null, 1, 32);
const description = text(null, 1, 500);
const inputKind = z.enum(["bids", "zarr"]);
const profile = z.enum(["archive", "serving"]);

/** neuroschema `inputProfilePairing`: a `zarr` input describes the serving copy and a `bids` input the archive. */
const paired = (e: { input_kind: "bids" | "zarr"; profile: "archive" | "serving" }) =>
  PROFILE_OF_INPUT[e.input_kind] === e.profile;

/** neuroschema `range`: either end may be null. */
export const RangeSchema = z.object({ min: nullableNumber, max: nullableNumber }).strict();

export const CheckpointCountsSchema = z
  .object({ passed: int53, failed: int53, skipped: int53, total: int53 })
  .strict();

// --- The dataset summary -------------------------------------------------------------------------------

/** `dataQuality#/$defs/distribution`. */
export const DistributionSchema = z
  .object({
    n: int53,
    unit,
    description: description.optional(),
    min: nullableNumber,
    median: nullableNumber,
    max: nullableNumber,
    histogram: z
      .object({
        edges: z.array(finite).min(2),
        counts: z.array(int53).min(1),
        underflow: int53,
        overflow: int53,
        missing: int53.optional(),
      })
      .strict(),
  })
  .strict();

/** `dataQuality#/$defs/notProcessed`. */
export const NotProcessedSchema = z
  .object({
    path: relativeLocation,
    status: z.enum(["failed", "skipped"]),
    code: failureCode,
  })
  .strict();

/** `dataQuality#/$defs/datasetRecipeSummary`. */
export const DatasetRecipeSummarySchema = z
  .object({
    recipe_version: version,
    dataset_version: version.nullable(),
    input_kind: inputKind,
    profile,
    record_sha256: sha256,
    counts: CheckpointCountsSchema,
    distributions: z.record(metricName, DistributionSchema),
    observed_range: z.record(metricName, RangeSchema),
    not_processed: z.array(NotProcessedSchema).max(NOT_PROCESSED_MAX),
    not_processed_truncated: int53,
  })
  .strict()
  .refine(paired);

export type DatasetRecipeSummary = z.infer<typeof DatasetRecipeSummarySchema>;

/** `dataQuality` at `level: dataset`: closed at its root, `level` and `recipes` only. */
export const DatasetQualityDocumentSchema = z
  .object({
    level: z.literal("dataset"),
    recipes: z.record(recipeId, DatasetRecipeSummarySchema),
  })
  .strict();

/**
 * The words of a writer rule broken (nemar-process `dataquality.problems`, which refuses to write such a
 * document): counts that do not add up to the total; listed and left-out recordings that are not exactly
 * the failed and the skipped; a distribution whose counts, edges, `n` or summary values break the rules;
 * an `observed_range` that is not each distribution's min and max; an integer beyond 2^53 - 1.
 */
export const WRITER_RULE_WORDS = [
  "counts_unbalanced",
  "listing_mismatch",
  "distribution_invalid",
  "observed_range_mismatch",
  "integer_unsafe",
] as const;
export type WriterRuleWord = (typeof WRITER_RULE_WORDS)[number];

const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0);

/** Whether one distribution keeps the writer's rules. */
function distributionHolds(d: z.infer<typeof DistributionSchema>): boolean {
  const { edges, counts, underflow, overflow } = d.histogram;
  if (counts.length !== edges.length - 1) return false;
  for (let i = 1; i < edges.length; i++) if (!(edges[i - 1] < edges[i])) return false;
  // n is the bins, the underflow and the overflow; a missing value is in none of them.
  if (d.n !== sum(counts) + underflow + overflow) return false;
  if (d.n === 0) return d.min === null && d.median === null && d.max === null;
  return (
    d.min !== null && d.median !== null && d.max !== null && d.min <= d.median && d.median <= d.max
  );
}

/**
 * The first writer rule a dataset summary breaks, or null. `unsafeInteger` is the reader's flag for an
 * integer literal beyond 2^53 - 1 anywhere in the document.
 */
export function writerRuleBroken(
  entry: DatasetRecipeSummary,
  unsafeInteger: boolean,
): WriterRuleWord | null {
  const c = entry.counts;
  if (c.passed + c.failed + c.skipped !== c.total) return "counts_unbalanced";
  if (entry.not_processed.length + entry.not_processed_truncated !== c.failed + c.skipped) {
    return "listing_mismatch";
  }
  for (const d of Object.values(entry.distributions)) {
    if (!distributionHolds(d)) return "distribution_invalid";
  }
  const names = Object.keys(entry.distributions);
  const ranged = Object.keys(entry.observed_range);
  if (names.length !== ranged.length) return "observed_range_mismatch";
  for (const name of names) {
    const range = entry.observed_range[name];
    const d = entry.distributions[name];
    if (range === undefined || range.min !== d.min || range.max !== d.max) {
      return "observed_range_mismatch";
    }
  }
  if (unsafeInteger) return "integer_unsafe";
  return null;
}

// --- Checking a run's dataset summary -------------------------------------------------------------------

/**
 * Why a run's dataset summary is not kept, a fixed word for the log (`quality_not_written reason=`):
 * besides {@link WRITER_RULE_WORDS}, the document is over its size, is not UTF-8 I-JSON, breaks the schema,
 * is not one entry of the stamp's recipe, states another identity than the stamp's, names another dataset
 * record than the one the run wrote, counts other recordings than its recordings table, names a metric of
 * a plugin the recipe does not run, or, written again as the entry D1 keeps, is longer than the column takes
 * (`entry_too_large`: `JSON.stringify` prints a number such as `1000e17` in 21 characters, so an entry can
 * outgrow the document it came from, and a row the CHECK refuses would fail the whole reconciliation).
 */
export const QUALITY_DOCUMENT_REFUSALS = [
  "document_too_large",
  "document_unreadable",
  "document_invalid",
  "recipe_mismatch",
  ...WRITER_RULE_WORDS,
  "identity_mismatch",
  "record_digest_mismatch",
  "counts_mismatch",
  "metric_unknown_plugin",
  "entry_too_large",
] as const;
export type QualityDocumentRefusal = (typeof QUALITY_DOCUMENT_REFUSALS)[number];

/** What a run's summary is checked against: its stamp, its dataset record and its recordings table. */
export interface QualityDocumentContext {
  stamp: {
    recipe: string;
    recipeVersion: string;
    /** The stamp's data-plane version tag, which the recipe was given as `--dataset-version`. */
    version: string;
    input: "bids" | "zarr";
  };
  /** The plugins the recipe version runs at its `quality` checkpoint. */
  plugins: readonly string[];
  /** SHA-256 of the dataset record's bytes, read in the same reconciliation. */
  recordSha256: string;
  /** The recordings table's own counts: its rows by status, and every row. */
  counts: { passed: number; failed: number; skipped: number; total: number };
}

export type QualityDocumentCheck =
  | { ok: true; entry: DatasetRecipeSummary; entryText: string }
  | { ok: false; reason: QualityDocumentRefusal };

const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** UTF-8 text with no byte order mark (one is kept, and refused by the reader), or null. */
function utf8(bytes: Uint8Array): string | null {
  try {
    return STRICT_UTF8.decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Check a run's dataset `dataQuality` document, in this order: its size, that it is UTF-8 I-JSON, the
 * schema, that it is one entry keyed by the stamp's recipe, the writer's rules, the stamp's identity
 * (recipe version, dataset version and input; the schema pairs the input with the copy it describes, so
 * the `profile` follows from the input and is not compared again), the dataset record's digest, the
 * recordings table's counts, and the metric names. The entry kept is the document's own entry, member for
 * member, as `entryText`.
 */
export function checkDatasetQualityDocument(
  bytes: Uint8Array,
  ctx: QualityDocumentContext,
): QualityDocumentCheck {
  const refuse = (reason: QualityDocumentRefusal): QualityDocumentCheck => ({ ok: false, reason });
  if (bytes.byteLength > DATA_QUALITY_MAX_BYTES) return refuse("document_too_large");
  const textOf = utf8(bytes);
  const read = textOf === null ? null : readIJson(textOf);
  if (read === null || !read.ok) return refuse("document_unreadable");
  const parsed = DatasetQualityDocumentSchema.safeParse(read.value);
  if (!parsed.success) return refuse("document_invalid");
  const raw = (read.value as { recipes: Record<string, unknown> }).recipes;
  const keys = Object.keys(raw);
  if (keys.length !== 1 || keys[0] !== ctx.stamp.recipe) return refuse("recipe_mismatch");
  const entry = parsed.data.recipes[ctx.stamp.recipe];
  const broken = writerRuleBroken(entry, read.unsafeInteger);
  if (broken !== null) return refuse(broken);
  if (
    entry.recipe_version !== ctx.stamp.recipeVersion ||
    entry.dataset_version !== ctx.stamp.version ||
    entry.input_kind !== ctx.stamp.input
  ) {
    return refuse("identity_mismatch");
  }
  if (entry.record_sha256 !== ctx.recordSha256) return refuse("record_digest_mismatch");
  const c = entry.counts;
  if (
    c.passed !== ctx.counts.passed ||
    c.failed !== ctx.counts.failed ||
    c.skipped !== ctx.counts.skipped ||
    c.total !== ctx.counts.total
  ) {
    return refuse("counts_mismatch");
  }
  const names = [...Object.keys(entry.distributions), ...Object.keys(entry.observed_range)];
  if (metricNameOutsideRecipe(names, ctx.plugins) !== null) return refuse("metric_unknown_plugin");
  const entryText = JSON.stringify(raw[ctx.stamp.recipe]);
  // The column holds at most this many characters (migration 0151); a UTF-16 length is never fewer.
  if (entryText.length > DATA_QUALITY_MAX_BYTES) return refuse("entry_too_large");
  return { ok: true, entry, entryText };
}

// --- Reading the current summaries ----------------------------------------------------------------------

/**
 * A derivative row that may be shown on a public page (ADR 0137 decision 7, ADR 0123): stored, of
 * retention `catalog` or `published`, not a superseded `catalog` row (a later `catalog` row of its dataset,
 * recipe, input and profile replaced it), and not past its date (a deletion dates its rows to now). A
 * `published` row is public whatever its `superseded_at`: publishing a superseded row keeps the date it was
 * superseded and never clears it (`promotePublishedSql`), and the owner's publication is the newer decision.
 * A `canary` row, a row being copied, a failed row and an expired one are never public.
 */
const PUBLIC_DERIVATIVE_SQL = (d: string): string =>
  `${d}.state = 'stored' AND ${d}.retention IN ('catalog', 'published')
   AND (${d}.retention = 'published' OR ${d}.superseded_at IS NULL)
   AND (${d}.expires_at IS NULL OR ${d}.expires_at > datetime('now'))`;

/**
 * A derivative row `d` that is its dataset and recipe's CURRENT PUBLIC derivative (ADR 0137 decision 7): a
 * public row (`PUBLIC_DERIVATIVE_SQL`), and the newest such row by `stored_at`, the larger key winning a tie.
 */
export const CURRENT_PUBLIC_DERIVATIVE_SQL = (d: string): string =>
  `${PUBLIC_DERIVATIVE_SQL(d)}
   AND NOT EXISTS (SELECT 1 FROM compute_derivatives n
     WHERE n.dataset_id = ${d}.dataset_id AND n.recipe = ${d}.recipe
       AND ${PUBLIC_DERIVATIVE_SQL("n")}
       AND (n.stored_at > ${d}.stored_at OR (n.stored_at = ${d}.stored_at AND n.key > ${d}.key)))`;

/**
 * The terms of the dataset gate, the pipeline eligibility's own (`compute-pipeline-eligibility.ts`) so the
 * two never drift: what a public page may show of a dataset's pipeline: the quality route's gate and the dataset summary's on
 * `metadata.json` and the page bundle, one predicate for both. Not `eeg`, `has_version` or
 * `real_dataset`, which decide what is RUN, not what is SHOWN.
 */
export const QUALITY_GATE_TERMS: readonly PipelineTermId[] = Object.freeze([
  "active",
  "public",
  "not_anonymous",
  "first_published",
  "not_withdrawn",
  "not_tombstoned",
]);

/** The gate over `datasets d`: every term of {@link QUALITY_GATE_TERMS}, ANDed. */
export const QUALITY_DATASET_GATE_SQL = QUALITY_GATE_TERMS.map((id) => {
  const term = PIPELINE_TERMS.find((t) => t.id === id);
  if (term === undefined) throw new Error(`no pipeline term ${id}`);
  return `(${term.sql})`;
}).join("\n     AND ");

/**
 * The dataset summary of each recipe's current public derivative of a dataset (`?1`): the derivative is
 * picked first and its run's summary joined, so a current derivative without a summary shows none rather
 * than an older run's. The dataset is bound on both rows; nothing is read from the entry. The dataset must
 * pass `QUALITY_DATASET_GATE_SQL`, the quality route's own gate, so a withdrawn, tombstoned, never published
 * or concealed dataset shows none, exactly as the route refuses it (owner ruling of 2026-11-25, review of
 * #2383).
 */
export const CURRENT_QUALITY_DOCUMENTS_SQL = `SELECT cd.recipe, q.entry
  FROM compute_derivatives cd
  JOIN compute_quality_documents q
    ON q.stamp_id = cd.stamp_id AND q.dataset_id = cd.dataset_id AND q.recipe = cd.recipe
  JOIN datasets d ON d.dataset_id = cd.dataset_id AND ${QUALITY_DATASET_GATE_SQL}
  WHERE cd.dataset_id = ?1 AND ${CURRENT_PUBLIC_DERIVATIVE_SQL("cd")}
  ORDER BY cd.recipe`;

/**
 * The `recipes` of a dataset's `dataQuality` at `level: dataset`, from the rows of
 * {@link CURRENT_QUALITY_DOCUMENTS_SQL}: the summary of each recipe's current public derivative, none for a
 * withdrawn dataset. A stored entry that does not parse as an object is left out with a log line. The
 * caller gates the dataset (public, not concealed) before it reads the rows.
 */
export function qualityEntriesOf(
  datasetId: string,
  rows: readonly { recipe: string; entry: string }[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const row of rows) {
    let entry: unknown;
    try {
      entry = JSON.parse(row.entry);
    } catch {
      entry = null;
    }
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      console.warn(
        `[quality-documents] entry_unreadable dataset=${datasetId} recipe=${row.recipe}`,
      );
      continue;
    }
    out[row.recipe] = entry;
  }
  return out;
}

// --- One recording's entry ------------------------------------------------------------------------------

const PluginRefSchema = z.object({ name: text(P.pluginName), version }).strict();
const RecipeRefSchema = z.object({ name: recipeId, version }).strict();

/** `qualityMetric`: exactly one producer, a plugin or a recipe. */
export const QualityMetricSchema = z
  .object({
    value: nullableNumber,
    unit,
    description,
    bounds: RangeSchema.optional(),
    plugin: PluginRefSchema.optional(),
    recipe: RecipeRefSchema.optional(),
  })
  .strict()
  .refine((m) => (m.plugin === undefined) !== (m.recipe === undefined));

/** `dataQuality#/$defs/viewSkipped`: any `failureCode` word, nemar-process's own among them. */
export const ViewSkippedSchema = z
  .object({ key: text(P.viewKey), kind: text(P.kindName, 0, 128), reason: failureCode })
  .strict();

/** `view#/$defs/viewSource`: exactly one of a plugin or a recipe. */
const ViewSourceSchema = z.union([
  z.object({ plugin: PluginRefSchema }).strict(),
  z.object({ recipe: RecipeRefSchema }).strict(),
]);

/** What this phase reads of a view: its key, kind and source. B2's view mirror reads the rest. */
const ViewHeadSchema = z
  .object({ key: text(P.viewKey), kind: text(P.kindName, 0, 128), source: ViewSourceSchema })
  .passthrough();

/**
 * neuroschema's rule of a recording's entry: every store input of its views names the copy the entry's
 * run read (the store's `profile` is the entry's), so a view of the serving copy cannot ride in an entry of
 * the archive.
 */
function storesNameEntryProfile(entry: { profile: string; views: unknown[] }): boolean {
  for (const view of entry.views) {
    const inputs = (view as { inputs?: unknown }).inputs;
    if (!Array.isArray(inputs)) continue;
    for (const input of inputs) {
      const store = (input as { store?: unknown } | null)?.store;
      if (typeof store !== "object" || store === null || Array.isArray(store)) continue;
      if ("profile" in store && (store as { profile: unknown }).profile !== entry.profile) {
        return false;
      }
    }
  }
  return true;
}

/** `dataQuality#/$defs/recordRecipeResults`, its views read to their head (see the header). */
export const RecordRecipeResultsSchema = z
  .object({
    recipe_version: version,
    input_kind: inputKind,
    profile,
    record_sha256: sha256,
    metrics: z.record(metricName, QualityMetricSchema).refine((metrics) =>
      // A bare name is a recipe's metric and needs the producer `recipe`; `<plugin>:<name>` needs `plugin`.
      Object.entries(metrics).every(([name, m]) =>
        metricPlugin(name) === null ? m.recipe !== undefined : m.plugin !== undefined,
      ),
    ),
    views: z.array(ViewHeadSchema).max(DATA_QUALITY_VIEWS_MAX),
    views_skipped: z.array(ViewSkippedSchema).max(DATA_QUALITY_VIEWS_MAX).optional(),
  })
  .strict()
  .refine(paired)
  .refine(storesNameEntryProfile);

/**
 * Why a recording's entry is not projected, a fixed word: the record is not UTF-8 I-JSON, or holds an
 * integer literal beyond 2^53 - 1 (`integer_unsafe`: every neuroschema integer is capped there, and the
 * reader's flag covers the whole record, as it covers the whole dataset document), or is not in the
 * shape a recipe writes; it names another recipe or version than the stamp's; a recipe metric carries a
 * plugin's prefix, a plugin step's metric does not carry its plugin's, or a metric names a plugin the recipe
 * does not run; the entry breaks the schema (a metric name that is not a `metricName` is refused before it
 * is copied); a view's source names a plugin the recipe version does not run at its `quality` checkpoint
 * (`view_unknown_plugin`: `nemar.record-checks.v1` leaves a plugin's view to its plugin, so the backend
 * holds the plugin to the recipe); or `nemar.record-checks.v1` finds something.
 */
export const RECORD_ENTRY_REFUSALS = [
  "record_unreadable",
  "integer_unsafe",
  "record_shape",
  "identity_mismatch",
  "metric_not_bare",
  "metric_not_prefixed",
  "metric_unknown_plugin",
  "entry_invalid",
  "view_unknown_plugin",
  "record_checks",
] as const;
export type RecordEntryRefusal = (typeof RECORD_ENTRY_REFUSALS)[number];

export type RecordEntry =
  | {
      ok: true;
      entry: Record<string, unknown>;
      /** What the record says it is of: `extensions.nemar.dataset.id` and `.recording.path`, as written. */
      of: { dataset: unknown; recording: unknown };
    }
  | { ok: false; reason: RecordEntryRefusal; findings?: RecordFinding[] };

const objectOf = (v: unknown): Record<string, unknown> | null =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/** Whether a name is a neuroschema `metricName` (a letter first, so never `__proto__`). */
const isMetricName = (name: string): boolean => metricName.safeParse(name).success;

/**
 * One recording's `dataQuality` entry for its recipe (`recordRecipeResults`), projected from the bytes of
 * its signalJourney record as nemar-process's own end-to-end test projects it (`record_entry`):
 *
 * - `metrics`: the recipe's own metrics (`extensions.nemar.metrics`, every name bare), then the
 *   `qualityMetrics` of the step of each plugin the record says `ran` (the step whose `stepId` is the
 *   plugin's name, every name `<plugin>:<name>`, the plugin one the recipe runs at `quality`). A value is
 *   never read from `summaryMetrics`, where a recipe may keep another shape (`lineNoiseBeforeDb` per
 *   frequency there, one number in `extensions.nemar.metrics`).
 * - `views` and `views_skipped` as the record declares them (`extensions.nemar`), no views when it
 *   declares none.
 * - the identity from the stamp, which must be the record's (`extensions.nemar.recipe`), and the copy that
 *   identity's input describes; `record_sha256` the digest of these bytes.
 *
 * The entry is checked against the schema and then by `nemar.record-checks.v1`; any finding refuses it.
 */
export async function recordQualityEntry(
  bytes: Uint8Array,
  stamp: {
    recipe: string;
    recipeVersion: string;
    input: "bids" | "zarr";
    /** The plugins the recipe version runs at its `quality` checkpoint. */
    plugins: readonly string[];
  },
): Promise<RecordEntry> {
  const refuse = (reason: RecordEntryRefusal, findings?: RecordFinding[]): RecordEntry =>
    findings === undefined ? { ok: false, reason } : { ok: false, reason, findings };
  const textOf = utf8(bytes);
  const read = textOf === null ? null : readIJson(textOf);
  if (read === null || !read.ok) return refuse("record_unreadable");
  if (read.unsafeInteger) return refuse("integer_unsafe");
  const record = objectOf(read.value);
  const nemar = objectOf(objectOf(record?.extensions)?.nemar);
  const recipe = objectOf(nemar?.recipe);
  if (record === null || nemar === null || recipe === null) return refuse("record_shape");
  if (recipe.id !== stamp.recipe || recipe.version !== stamp.recipeVersion) {
    return refuse("identity_mismatch");
  }

  const own = nemar.metrics === undefined ? {} : objectOf(nemar.metrics);
  const plugins = nemar.plugins === undefined ? [] : nemar.plugins;
  const steps = record.processingSteps;
  if (own === null || !Array.isArray(plugins) || !Array.isArray(steps)) {
    return refuse("record_shape");
  }
  const metrics: Record<string, unknown> = {};
  // A name is checked before it is copied: a member named `__proto__` (an own member, as the reader makes
  // it) would otherwise set the prototype of `metrics` and leave the schema nothing to refuse.
  for (const [name, metric] of Object.entries(own)) {
    if (!isMetricName(name)) return refuse("entry_invalid");
    if (metricPlugin(name) !== null) return refuse("metric_not_bare");
    metrics[name] = metric;
  }
  for (const plugin of plugins) {
    const p = objectOf(plugin);
    if (p === null || typeof p.name !== "string") return refuse("record_shape");
    if (p.status !== "ran") continue;
    const step = steps.map(objectOf).find((s) => s !== null && s.stepId === p.name) ?? null;
    const reported = step?.qualityMetrics === undefined ? {} : objectOf(step.qualityMetrics);
    if (reported === null) return refuse("record_shape");
    for (const [name, metric] of Object.entries(reported)) {
      if (!isMetricName(name)) return refuse("entry_invalid");
      if (metricPlugin(name) !== p.name) return refuse("metric_not_prefixed");
      metrics[name] = metric;
    }
  }
  if (metricNameOutsideRecipe(Object.keys(metrics), stamp.plugins) !== null) {
    return refuse("metric_unknown_plugin");
  }

  const entry: Record<string, unknown> = {
    recipe_version: stamp.recipeVersion,
    input_kind: stamp.input,
    profile: PROFILE_OF_INPUT[stamp.input],
    record_sha256: await sha256HexOfBytes(bytes),
    metrics,
    views: nemar.views === undefined ? [] : nemar.views,
    ...(nemar.views_skipped === undefined ? {} : { views_skipped: nemar.views_skipped }),
  };
  if (!RecordRecipeResultsSchema.safeParse(entry).success) return refuse("entry_invalid");
  for (const view of entry.views as { source: { plugin?: { name: string } } }[]) {
    const plugin = view.source.plugin;
    if (plugin !== undefined && !stamp.plugins.includes(plugin.name)) {
      return refuse("view_unknown_plugin");
    }
  }
  const findings = recordChecks(stamp.recipe, entry);
  if (findings.length > 0) return refuse("record_checks", findings);
  return {
    ok: true,
    entry,
    of: { dataset: objectOf(nemar.dataset)?.id, recording: objectOf(nemar.recording)?.path },
  };
}
