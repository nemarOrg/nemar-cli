/**
 * The quality plugin manifest, `nemar.plugin-manifest.v1` (ADR 0134 decisions 6 and 9 as refined by ADR 0137
 * decision 4, epic #2324): what a plugin declares before it runs. A plugin is a Python module; its manifest
 * names it, its version, the module to load, the checkpoint it belongs to, what it reads, its fixed
 * parameters, and the metrics and views it writes. Declared once here; nemar-process loads plugins and copies
 * `plugin-manifest.schema.json` byte for byte. Version 1 is edited in place (ADR 0137 decision 4): it was
 * never published or pinned outside the epic.
 *
 * A declared metric without `headline`, with a run's `value` (a number or null) and the plugin's
 * `{name, version}`, is a valid neuroschema `qualityMetric`: its `bounds` are the valid range the plugin
 * declares for the value, not a quality threshold. `headline` lives in the manifest only: it says the
 * metric is also written to the record's `summaryMetrics`, and is never part of a `qualityMetric`. A
 * plugin's metric is named `<plugin>:<name>` with its own name as the prefix (`metric_not_prefixed`); the
 * name grammar is neuroschema's `metricName`, and a plugin's name is neuroschema's `plugin.name`, the
 * grammar of a metric name's prefix.
 *
 * A view is data a browser draws, never an image (ADR 0137): a kind and its version from the neuroschema
 * view registry, a caption, and its roles. A role is either produced by the plugin (a format, a byte cap
 * of at most 4 MiB, its dimensions in row-then-column order, and optionally its columns) or
 * `{from: "recipe"}`, which the runner fills with the host recipe's file for that role. Whether the kind,
 * the format and a recipe role exist is the loader's check against the registry and the host recipe
 * (nemar-process), not this schema's: an unknown kind is still valid neuroschema.
 *
 * Every string cap counts code points, as JSON Schema does, so zod and Ajv agree on a string outside
 * the Basic Multilingual Plane.
 *
 * The manifest is closed (`.strict()`): it describes software NEMAR reviews, and an unknown key is a bug
 * to refuse. Rules a schema cannot state are in `pluginManifestProblem`. Like `./compute-progress.ts`,
 * this file is exempted by name in `test/contract-schemas.test.ts`.
 *
 * Nothing here reads a clock, a database or a network.
 */

import { z } from "zod";

/** The format word every manifest carries. */
export const PLUGIN_MANIFEST_FORMAT = "nemar.plugin-manifest.v1";

/** The checkpoints a plugin may belong to: plugins run at `quality` (ADR 0137 decision 1). */
export const PLUGIN_CHECKPOINTS = ["quality"] as const;

/** The largest file one produced view role may be, in bytes: the registry's `bytes_per_role`. */
export const PLUGIN_VIEW_MAX_BYTES = 4_194_304;

/** The largest manifest, in bytes. */
export const PLUGIN_MANIFEST_MAX_BYTES = 65_536;

export const PLUGIN_MAX_METRICS = 64;
export const PLUGIN_MAX_VIEWS = 16;
export const PLUGIN_MAX_VIEW_ROLES = 8;
/** At most two dimensions, rows then columns: a role is a table or a JSON document. */
export const PLUGIN_MAX_VIEW_DIMS = 2;
/** NEMAR's own cap on a produced role's `columns`; neuroschema sets none. */
export const PLUGIN_MAX_VIEW_COLUMNS = 64;
export const PLUGIN_MAX_PARAMETERS = 32;
export const PLUGIN_MAX_RECIPES = 8;
export const PLUGIN_PARAMETER_STRING_MAX = 256;
export const PLUGIN_PARAMETER_LIST_MAX = 64;
export const PLUGIN_METRIC_NAME_MAX = 128;

/** A plugin's name: neuroschema `processingTypes` `plugin.name`, the grammar of a metric name's prefix. */
export const PLUGIN_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}(?![\s\S])/;

/** A version: neuroschema `processingTypes` `version`. */
export const PLUGIN_VERSION_RE = /^[0-9A-Za-z._+-]{1,64}(?![\s\S])/;

/** A Python module path: dotted identifiers, at most 128 characters. */
export const PLUGIN_ENTRY_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*(?![\s\S])/;

/** A recipe id: neuroschema `processingTypes` `recipeId`. */
export const PLUGIN_RECIPE_RE = /^[a-z0-9-]{1,64}(?![\s\S])/;

/**
 * A metric's name: neuroschema `processingTypes` `metricName` (at most {@link PLUGIN_METRIC_NAME_MAX}
 * characters), a bare name or `<prefix>:<name>`. That a plugin's metric is prefixed, and by its own name, is
 * `metric_not_prefixed` in {@link pluginManifestProblem}.
 */
export const PLUGIN_METRIC_RE = /^[A-Za-z][A-Za-z0-9_-]*(?::[A-Za-z][A-Za-z0-9_-]*)?(?![\s\S])/;

/**
 * A view's, a role's, a dimension's or a parameter's name: neuroschema `viewKey`, `roleName` and `dimName`
 * share this grammar.
 */
export const PLUGIN_KEY_RE = /^[a-z][a-z0-9_]{0,63}(?![\s\S])/;

/** A view kind: neuroschema `processingTypes` `kindName` (at most 128 characters). */
export const PLUGIN_VIEW_KIND_RE = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9-]*)+(?![\s\S])/;

/** A data format: neuroschema `processingTypes` `formatName`. */
export const PLUGIN_VIEW_FORMAT_RE = /^[a-z][a-z0-9]{0,15}(?![\s\S])/;

/** A column's name: neuroschema `view` `columnName` (1 to 128 code points, no TAB, CR or LF). */
export const PLUGIN_VIEW_COLUMN_RE = /^[^\t\r\n]+(?![\s\S])/;

/** A column's value type: neuroschema `view` `valueType`. */
export const PLUGIN_VIEW_VALUE_TYPES = ["number", "integer", "string"] as const;

/** A string of `min` to `max` code points (JSON Schema counts code points; `.max` counts UTF-16 units). */
const codePoints = (min: number, max: number, base = z.string()) =>
  base.refine((s) => {
    const n = [...s].length;
    return n >= min && n <= max;
  }, `${min} to ${max} code points`);

const keyCount = (min: number, max: number) => (o: Record<string, unknown>) => {
  const n = Object.keys(o).length;
  return n >= min && n <= max;
};

const parameterValue = z.union([
  z.number(),
  codePoints(0, PLUGIN_PARAMETER_STRING_MAX),
  z.boolean(),
  z.null(),
  z.array(z.number()).max(PLUGIN_PARAMETER_LIST_MAX),
]);

const rangeSchema = z.object({ min: z.number().nullable(), max: z.number().nullable() }).strict();

/** One metric a plugin writes: neuroschema `qualityMetric` without the run's value and the plugin. */
export const PluginMetricSchema = z
  .object({
    unit: codePoints(1, 32),
    description: codePoints(1, 500),
    bounds: rangeSchema.optional(),
    headline: z.boolean().optional(),
  })
  .strict();

/** One column a produced role reads: neuroschema `view` `column`. */
export const PluginViewColumnSchema = z
  .object({
    name: codePoints(1, 128, z.string().regex(PLUGIN_VIEW_COLUMN_RE)),
    type: z.enum(PLUGIN_VIEW_VALUE_TYPES),
    unit: codePoints(1, 32).optional(),
  })
  .strict();

/** A role the plugin produces: the runner checks the plugin's array or mapping against it and writes it. */
export const PluginViewProducedRoleSchema = z
  .object({
    format: z.string().regex(PLUGIN_VIEW_FORMAT_RE),
    max_bytes: z.number().int().min(1).max(PLUGIN_VIEW_MAX_BYTES),
    dims: z
      .array(z.string().regex(PLUGIN_KEY_RE))
      .max(PLUGIN_MAX_VIEW_DIMS)
      .refine((a) => new Set(a).size === a.length, "dims repeat"),
    columns: z.array(PluginViewColumnSchema).min(1).max(PLUGIN_MAX_VIEW_COLUMNS).optional(),
  })
  .strict();

/** A role the host recipe provides: the runner attaches the recipe's file (`role_unprovided` if none). */
export const PluginViewRecipeRoleSchema = z.object({ from: z.literal("recipe") }).strict();

export const PluginViewRoleSchema = z.union([
  PluginViewProducedRoleSchema,
  PluginViewRecipeRoleSchema,
]);

/** One view a plugin writes. */
export const PluginViewSchema = z
  .object({
    kind: z.string().max(128).regex(PLUGIN_VIEW_KIND_RE),
    kind_version: z.number().int().min(1).max(999),
    caption: codePoints(1, 500),
    roles: z
      .record(z.string().regex(PLUGIN_KEY_RE), PluginViewRoleSchema)
      .refine(keyCount(1, PLUGIN_MAX_VIEW_ROLES), `1 to ${PLUGIN_MAX_VIEW_ROLES} roles`),
  })
  .strict();

/** The manifest. */
export const PluginManifestSchema = z
  .object({
    format: z.literal(PLUGIN_MANIFEST_FORMAT),
    name: z.string().regex(PLUGIN_NAME_RE),
    version: z.string().regex(PLUGIN_VERSION_RE),
    entry: z.string().max(128).regex(PLUGIN_ENTRY_RE),
    checkpoint: z.enum(PLUGIN_CHECKPOINTS),
    reads: z
      .object({
        dataset: z.boolean(),
        recipes: z
          .array(z.string().regex(PLUGIN_RECIPE_RE))
          .max(PLUGIN_MAX_RECIPES)
          .refine((a) => new Set(a).size === a.length, "recipes repeat"),
      })
      .strict()
      .refine((r) => r.dataset || r.recipes.length > 0, "a plugin reads something"),
    parameters: z
      .record(z.string().regex(PLUGIN_KEY_RE), parameterValue)
      .refine(keyCount(0, PLUGIN_MAX_PARAMETERS), "too many parameters"),
    outputs: z
      .object({
        metrics: z
          .record(
            z.string().max(PLUGIN_METRIC_NAME_MAX).regex(PLUGIN_METRIC_RE),
            PluginMetricSchema,
          )
          .refine(keyCount(0, PLUGIN_MAX_METRICS), "too many metrics"),
        views: z
          .record(z.string().regex(PLUGIN_KEY_RE), PluginViewSchema)
          .refine(keyCount(0, PLUGIN_MAX_VIEWS), "too many views"),
      })
      .strict(),
  })
  .strict();

export type PluginMetric = z.infer<typeof PluginMetricSchema>;
export type PluginViewRole = z.infer<typeof PluginViewRoleSchema>;
export type PluginView = z.infer<typeof PluginViewSchema>;
export type PluginManifest = z.infer<typeof PluginManifestSchema>;

/** The words of {@link pluginManifestProblem}, in the order it checks them. */
export const PLUGIN_MANIFEST_PROBLEMS = [
  "bounds_reversed",
  "plugin_without_output",
  "metric_not_prefixed",
] as const;

/**
 * The rules no schema states, in this order: a metric's bounds have `min <= max` when both are set
 * (`bounds_reversed`); a plugin declares at least one metric or view (`plugin_without_output`); every
 * metric is named `<plugin>:<name>` with the manifest's own name as the prefix (`metric_not_prefixed`).
 * Null when they hold.
 */
export function pluginManifestProblem(
  manifest: PluginManifest,
): (typeof PLUGIN_MANIFEST_PROBLEMS)[number] | null {
  for (const metric of Object.values(manifest.outputs.metrics)) {
    const b = metric.bounds;
    if (b && b.min !== null && b.max !== null && b.min > b.max) return "bounds_reversed";
  }
  if (
    Object.keys(manifest.outputs.metrics).length === 0 &&
    Object.keys(manifest.outputs.views).length === 0
  ) {
    return "plugin_without_output";
  }
  const prefix = `${manifest.name}:`;
  for (const name of Object.keys(manifest.outputs.metrics)) {
    if (!name.startsWith(prefix)) return "metric_not_prefixed";
  }
  return null;
}
