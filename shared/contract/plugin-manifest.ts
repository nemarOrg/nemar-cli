/**
 * The quality plugin manifest, `nemar.plugin-manifest.v1` (ADR 0134 decisions 6 and 9, epic #2324 phase
 * 2): what a plugin declares before it runs. A plugin is a Python module; its manifest names it, its
 * version, the module to load, the checkpoint it belongs to, what it reads, its fixed parameters, and the
 * metrics and figures it writes. Declared once here; nemar-process (phase 5) loads plugins and copies
 * `plugin-manifest.schema.json` byte for byte.
 *
 * A declared metric, with a run's `value` (a number or null) and the plugin's `{name, version}`, is a
 * valid neuroschema `qualityMetric`: its `bounds` are the valid range the plugin declares for the value,
 * not a quality threshold. A figure is a display image in one of a fixed list of formats under a size
 * cap; a figure that draws a time series is raster only (PNG or WebP), because a vector trace stores the
 * samples as coordinates. A plugin never writes samples.
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

/** The checkpoints a plugin may belong to. */
export const PLUGIN_CHECKPOINTS = ["quality", "figures"] as const;

/** The display formats a figure may take. */
export const PLUGIN_FIGURE_FORMATS = ["png", "svg", "webp"] as const;

/** The raster formats, the only ones a time-series figure may take. */
export const PLUGIN_RASTER_FORMATS = ["png", "webp"] as const;

/** The largest figure a plugin may write, in bytes. */
export const PLUGIN_FIGURE_MAX_BYTES = 1_048_576;

/** The largest manifest, in bytes. */
export const PLUGIN_MANIFEST_MAX_BYTES = 65_536;

export const PLUGIN_MAX_METRICS = 64;
export const PLUGIN_MAX_FIGURES = 32;
export const PLUGIN_MAX_PARAMETERS = 32;
export const PLUGIN_MAX_RECIPES = 8;
export const PLUGIN_PARAMETER_STRING_MAX = 256;
export const PLUGIN_PARAMETER_LIST_MAX = 64;

/** A plugin's name: neuroschema `processingTypes` `plugin.name`. */
export const PLUGIN_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}(?![\s\S])/;

/** A version: neuroschema `processingTypes` `version`. */
export const PLUGIN_VERSION_RE = /^[0-9A-Za-z._+-]{1,64}(?![\s\S])/;

/** A Python module path: dotted identifiers, at most 128 characters. */
export const PLUGIN_ENTRY_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*(?![\s\S])/;

/** A recipe id: neuroschema `processingTypes` `recipeId`. */
export const PLUGIN_RECIPE_RE = /^[a-z0-9-]{1,64}(?![\s\S])/;

/** A metric's name: neuroschema `processingTypes` `metricName`. */
export const PLUGIN_METRIC_RE = /^[A-Za-z][A-Za-z0-9_:-]{0,127}(?![\s\S])/;

/** A figure's or a parameter's name. */
export const PLUGIN_KEY_RE = /^[a-z][a-z0-9_]{0,63}(?![\s\S])/;

const keyCount = (min: number, max: number) => (o: Record<string, unknown>) => {
  const n = Object.keys(o).length;
  return n >= min && n <= max;
};

const parameterValue = z.union([
  z.number(),
  z.string().max(PLUGIN_PARAMETER_STRING_MAX),
  z.boolean(),
  z.null(),
  z.array(z.number()).max(PLUGIN_PARAMETER_LIST_MAX),
]);

const rangeSchema = z.object({ min: z.number().nullable(), max: z.number().nullable() }).strict();

/** One metric a plugin writes: neuroschema `qualityMetric` without the run's value and the plugin. */
export const PluginMetricSchema = z
  .object({
    unit: z.string().min(1).max(32),
    description: z.string().min(1).max(500),
    bounds: rangeSchema.optional(),
    headline: z.boolean().optional(),
  })
  .strict();

/** One figure a plugin writes. */
export const PluginFigureSchema = z
  .object({
    formats: z
      .array(z.enum(PLUGIN_FIGURE_FORMATS))
      .min(1)
      .max(PLUGIN_FIGURE_FORMATS.length)
      .refine((a) => new Set(a).size === a.length, "formats repeat"),
    time_series: z.boolean(),
    caption: z.string().min(1).max(500),
    max_bytes: z.number().int().min(1).max(PLUGIN_FIGURE_MAX_BYTES),
  })
  .strict()
  .refine(
    (f) =>
      !f.time_series ||
      f.formats.every((x) => (PLUGIN_RASTER_FORMATS as readonly string[]).includes(x)),
    "a time-series figure is raster only",
  );

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
          .record(z.string().regex(PLUGIN_METRIC_RE), PluginMetricSchema)
          .refine(keyCount(0, PLUGIN_MAX_METRICS), "too many metrics"),
        figures: z
          .record(z.string().regex(PLUGIN_KEY_RE), PluginFigureSchema)
          .refine(keyCount(0, PLUGIN_MAX_FIGURES), "too many figures"),
      })
      .strict(),
  })
  .strict();

export type PluginMetric = z.infer<typeof PluginMetricSchema>;
export type PluginFigure = z.infer<typeof PluginFigureSchema>;
export type PluginManifest = z.infer<typeof PluginManifestSchema>;

/** The words of {@link pluginManifestProblem}. */
export const PLUGIN_MANIFEST_PROBLEMS = [
  "bounds_reversed",
  "quality_without_metric",
  "figures_without_figure",
] as const;

/**
 * The rules no schema states: a metric's bounds have `min <= max` when both are set; a `quality` plugin
 * declares at least one metric and a `figures` plugin at least one figure. Null when they hold.
 */
export function pluginManifestProblem(
  manifest: PluginManifest,
): (typeof PLUGIN_MANIFEST_PROBLEMS)[number] | null {
  for (const metric of Object.values(manifest.outputs.metrics)) {
    const b = metric.bounds;
    if (b && b.min !== null && b.max !== null && b.min > b.max) return "bounds_reversed";
  }
  if (manifest.checkpoint === "quality" && Object.keys(manifest.outputs.metrics).length === 0) {
    return "quality_without_metric";
  }
  if (manifest.checkpoint === "figures" && Object.keys(manifest.outputs.figures).length === 0) {
    return "figures_without_figure";
  }
  return null;
}
