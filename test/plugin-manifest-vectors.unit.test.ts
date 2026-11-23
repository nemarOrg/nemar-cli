/**
 * `shared/contract/plugin-manifest-vectors.json`: plugin manifests and the verdicts nemar-cli gives them, for
 * nemar-process to replay against its byte copy of `plugin-manifest.schema.json` and its port of
 * `pluginManifestProblem` (ADR 0134 decision 6, epic #2324 phase 5 N1).
 *
 * The file is what this test computes from the cases below: the schema verdict (Ajv on the shared JSON
 * Schema and zod must agree) and, for a manifest the schema accepts, the rule word of
 * `pluginManifestProblem` (null when every rule holds). `NEMAR_WRITE_PLUGIN_VECTORS=1` rewrites it.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020";
import {
  PLUGIN_MANIFEST_FORMAT,
  PLUGIN_MANIFEST_PROBLEMS,
  type PluginManifest,
  PluginManifestSchema,
  pluginManifestProblem,
} from "../shared/contract/plugin-manifest";
import manifestSchema from "../shared/contract/plugin-manifest.schema.json";

const ajv = new Ajv2020({ allErrors: true, strict: true });
ajv.addSchema(manifestSchema);
const ajvManifest = ajv.getSchema(`${manifestSchema.$id}#/$defs/PluginManifest`);
if (!ajvManifest) throw new Error("manifest schema member not found");

const quality = (): PluginManifest => ({
  format: PLUGIN_MANIFEST_FORMAT,
  name: "nemar-quality",
  version: "1.0.0-b1",
  entry: "nemar_process.plugins.nemar_quality",
  checkpoint: "quality",
  reads: { dataset: false, recipes: ["nemar-floor", "nemar-ica"] },
  parameters: {},
  outputs: {
    metrics: {
      percentGoodChannels: {
        unit: "%",
        description: "Share of channels kept by the floor.",
        bounds: { min: 0, max: 100 },
      },
      percentBrainComponents: {
        unit: "%",
        description: "Share of components ICLabel calls brain.",
        bounds: { min: 0, max: 100 },
        headline: true,
      },
    },
    figures: {},
  },
});

const figures = (): PluginManifest => ({
  format: PLUGIN_MANIFEST_FORMAT,
  name: "nemar-segment",
  version: "1.0.0-b1",
  entry: "nemar_process.plugins.nemar_segment",
  checkpoint: "figures",
  reads: { dataset: false, recipes: ["nemar-floor", "nemar-ica"] },
  parameters: { seconds: 2 },
  outputs: {
    metrics: {},
    figures: {
      midsegment: {
        formats: ["png"],
        time_series: true,
        caption: "Two seconds of cleaned data from the middle of the recording.",
        max_bytes: 400_000,
      },
    },
  },
});

/** A copy of `base` changed by `mut`. */
const edit = (
  base: () => PluginManifest,
  mut: (m: Record<string, unknown> & PluginManifest) => void,
): unknown => {
  const m = structuredClone(base()) as Record<string, unknown> & PluginManifest;
  mut(m);
  return m;
};

const CASES: Array<[string, unknown]> = [
  ["quality_valid", quality()],
  ["figures_valid", figures()],
  [
    "bounds_reversed",
    edit(quality, (m) => {
      m.outputs.metrics.percentGoodChannels = {
        unit: "%",
        description: "x",
        bounds: { min: 100, max: 0 },
      };
    }),
  ],
  [
    "bounds_open_ended",
    edit(quality, (m) => {
      m.outputs.metrics.percentGoodChannels = {
        unit: "%",
        description: "x",
        bounds: { min: 0, max: null },
      };
    }),
  ],
  [
    "bounds_equal",
    edit(quality, (m) => {
      m.outputs.metrics.percentGoodChannels = {
        unit: "%",
        description: "x",
        bounds: { min: 50, max: 50 },
      };
    }),
  ],
  [
    "bounds_reversed_before_figures_without_figure",
    edit(figures, (m) => {
      m.outputs.figures = {};
      m.outputs.metrics = {
        share: { unit: "%", description: "x", bounds: { min: 1, max: 0 } },
      };
    }),
  ],
  [
    "quality_without_metric",
    edit(quality, (m) => {
      m.outputs.metrics = {};
    }),
  ],
  [
    "figures_without_figure",
    edit(figures, (m) => {
      m.outputs.figures = {};
    }),
  ],
  [
    "time_series_svg",
    edit(figures, (m) => {
      m.outputs.figures.midsegment.formats = ["svg"];
    }),
  ],
  [
    "time_series_png_and_webp",
    edit(figures, (m) => {
      m.outputs.figures.midsegment.formats = ["png", "webp"];
    }),
  ],
  [
    "map_svg",
    edit(figures, (m) => {
      m.outputs.figures.midsegment = {
        formats: ["svg"],
        time_series: false,
        caption: "Class histogram.",
        max_bytes: 200_000,
      };
    }),
  ],
  [
    "unknown_top_key",
    edit(quality, (m) => {
      m.extra = 1;
    }),
  ],
  [
    "checkpoint_iclabel",
    edit(quality, (m) => {
      (m as Record<string, unknown>).checkpoint = "iclabel";
    }),
  ],
  [
    "figure_over_cap",
    edit(figures, (m) => {
      m.outputs.figures.midsegment.max_bytes = 1_048_577;
    }),
  ],
  [
    "entry_not_a_module_path",
    edit(quality, (m) => {
      m.entry = "nemar_process/plugins";
    }),
  ],
  [
    "metric_name_with_a_dot",
    edit(quality, (m) => {
      (m.outputs.metrics as Record<string, unknown>)["line.noise"] = {
        unit: "dB",
        description: "x",
      };
    }),
  ],
];

const VECTORS_PATH = join(import.meta.dir, "../shared/contract/plugin-manifest-vectors.json");

const computed = {
  format: "nemar.plugin-manifest-vectors.v1",
  note: "Generated by test/plugin-manifest-vectors.unit.test.ts from shared/contract/plugin-manifest.ts and plugin-manifest.schema.json; do not hand-edit (NEMAR_WRITE_PLUGIN_VECTORS=1 rewrites it). Validate against #/$defs/PluginManifest, not the document root.",
  vectors: CASES.map(([name, manifest]) => {
    const parsed = PluginManifestSchema.safeParse(manifest);
    return {
      name,
      manifest,
      schema_valid: parsed.success,
      problem: parsed.success ? pluginManifestProblem(parsed.data) : null,
    };
  }),
};

describe("plugin manifest vectors", () => {
  test("Ajv on the shared schema and zod give every case the same verdict", () => {
    for (const [name, manifest] of CASES) {
      expect(ajvManifest(manifest) as boolean, name).toBe(
        PluginManifestSchema.safeParse(manifest).success,
      );
    }
  });

  test("the cases cover a valid manifest of each checkpoint, every problem word and a schema refusal", () => {
    const v = computed.vectors;
    expect(v.filter((c) => c.schema_valid && c.problem === null).map((c) => c.name)).toEqual(
      expect.arrayContaining(["quality_valid", "figures_valid"]),
    );
    for (const word of PLUGIN_MANIFEST_PROBLEMS) {
      expect(
        v.some((c) => c.problem === word),
        word,
      ).toBe(true);
    }
    expect(v.find((c) => c.name === "time_series_svg")?.schema_valid).toBe(false);
    expect(v.find((c) => c.name === "map_svg")?.schema_valid).toBe(true);
  });

  test("rule precedence and the bounds boundary", () => {
    const v = (name: string) => computed.vectors.find((c) => c.name === name);
    expect(v("bounds_reversed_before_figures_without_figure")?.problem).toBe("bounds_reversed");
    expect(v("bounds_equal")).toMatchObject({ schema_valid: true, problem: null });
  });

  test("a manifest is judged by #/$defs/PluginManifest: the document root accepts what it refuses", () => {
    const root = new Ajv2020({ strict: true }).compile(manifestSchema);
    const iclabel = CASES.find(([name]) => name === "checkpoint_iclabel")?.[1];
    expect(root(iclabel)).toBe(true);
    expect(ajvManifest(iclabel) as boolean).toBe(false);
  });

  test("the file equals what the code computes", () => {
    if (process.env.NEMAR_WRITE_PLUGIN_VECTORS === "1") {
      writeFileSync(VECTORS_PATH, `${JSON.stringify(computed, null, 2)}\n`);
    }
    expect(JSON.parse(readFileSync(VECTORS_PATH, "utf8"))).toEqual(computed);
  });
});
