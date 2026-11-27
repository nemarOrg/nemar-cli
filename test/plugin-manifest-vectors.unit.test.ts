/**
 * `shared/contract/plugin-manifest-vectors.json`: plugin manifests and the verdicts nemar-cli gives them, for
 * nemar-process to replay against its byte copy of `plugin-manifest.schema.json` and its port of
 * `pluginManifestProblem` (ADR 0134 decision 6, ADR 0137 decision 4, epic #2324 phases 5 N1 and N1b).
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
  reads: { dataset: false, recipes: ["nemar-ica"] },
  parameters: {},
  outputs: {
    metrics: {
      "nemar-quality:percentBrainComponents": {
        unit: "%",
        description: "Share of components ICLabel calls brain.",
        bounds: { min: 0, max: 100 },
        headline: true,
      },
    },
    views: {
      icclasses: {
        kind: "nemar.ic-classes",
        kind_version: 1,
        caption: "Components by ICLabel class.",
        roles: { histogram: { format: "json", max_bytes: 65_536, dims: [] } },
      },
    },
  },
});

const spectrum = (): PluginManifest => ({
  format: PLUGIN_MANIFEST_FORMAT,
  name: "nemar-spectrum",
  version: "1.0.0-b1",
  entry: "nemar_process.plugins.nemar_spectrum",
  checkpoint: "quality",
  reads: { dataset: false, recipes: ["nemar-ica"] },
  parameters: { window_s: 2, overlap: 0.5, upper_hz: 125 },
  outputs: {
    metrics: {},
    views: {
      spectrum: {
        kind: "nemar.spectrum",
        kind_version: 1,
        caption: "Power spectrum of each channel, in dB re 1 uV^2/Hz.",
        roles: {
          values: { format: "tsv", max_bytes: 1_048_576, dims: ["freq", "sensor"] },
          layout: { from: "recipe" },
        },
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

type Loose = Record<string, unknown>;

const CASES: Array<[string, unknown]> = [
  ["quality_valid", quality()],
  ["views_only_valid", spectrum()],
  [
    "metrics_only_valid",
    edit(quality, (m) => {
      m.outputs.views = {};
    }),
  ],
  [
    "bounds_reversed",
    edit(quality, (m) => {
      m.outputs.metrics["nemar-quality:percentBrainComponents"] = {
        unit: "%",
        description: "x",
        bounds: { min: 100, max: 0 },
      };
    }),
  ],
  [
    "bounds_open_ended",
    edit(quality, (m) => {
      m.outputs.metrics["nemar-quality:percentBrainComponents"] = {
        unit: "%",
        description: "x",
        bounds: { min: 0, max: null },
      };
    }),
  ],
  [
    "bounds_equal",
    edit(quality, (m) => {
      m.outputs.metrics["nemar-quality:percentBrainComponents"] = {
        unit: "%",
        description: "x",
        bounds: { min: 50, max: 50 },
      };
    }),
  ],
  [
    "plugin_without_output",
    edit(quality, (m) => {
      m.outputs = { metrics: {}, views: {} };
    }),
  ],
  [
    "metric_not_prefixed",
    edit(quality, (m) => {
      m.outputs.metrics = { percentBrainComponents: { unit: "%", description: "x" } };
    }),
  ],
  [
    "metric_prefixed_by_another_plugin",
    edit(quality, (m) => {
      m.outputs.metrics = { "nemar-spectrum:alphaPeak": { unit: "Hz", description: "x" } };
    }),
  ],
  [
    "metric_prefix_extends_the_name",
    edit(quality, (m) => {
      m.outputs.metrics = { "nemar-qualityx:share": { unit: "%", description: "x" } };
    }),
  ],
  [
    "bounds_reversed_before_metric_not_prefixed",
    edit(quality, (m) => {
      m.outputs.metrics = {
        share: { unit: "%", description: "x", bounds: { min: 1, max: 0 } },
      };
    }),
  ],
  [
    "metric_suffix_starts_with_a_digit",
    edit(quality, (m) => {
      m.outputs.metrics = { "nemar-quality:9x": { unit: "%", description: "x" } };
    }),
  ],
  [
    "metric_name_with_a_dot",
    edit(quality, (m) => {
      (m.outputs.metrics as Loose)["nemar-quality:line.noise"] = {
        unit: "dB",
        description: "x",
      };
    }),
  ],
  [
    "plugin_name_with_a_dot",
    edit(quality, (m) => {
      m.name = "nemar.quality";
    }),
  ],
  [
    "plugin_name_starts_with_a_digit",
    edit(quality, (m) => {
      m.name = "9quality";
    }),
  ],
  [
    "unknown_top_key",
    edit(quality, (m) => {
      m.extra = 1;
    }),
  ],
  [
    "checkpoint_figures",
    edit(quality, (m) => {
      (m as Loose).checkpoint = "figures";
    }),
  ],
  [
    "checkpoint_iclabel",
    edit(quality, (m) => {
      (m as Loose).checkpoint = "iclabel";
    }),
  ],
  [
    "outputs_figures",
    edit(quality, (m) => {
      (m.outputs as Loose).figures = {};
    }),
  ],
  [
    "view_role_over_cap",
    edit(spectrum, (m) => {
      ((m.outputs.views.spectrum?.roles as Loose).values as Loose).max_bytes = 4_194_305;
    }),
  ],
  [
    "view_role_at_cap",
    edit(spectrum, (m) => {
      ((m.outputs.views.spectrum?.roles as Loose).values as Loose).max_bytes = 4_194_304;
    }),
  ],
  [
    "view_without_roles",
    edit(spectrum, (m) => {
      (m.outputs.views.spectrum as unknown as Loose).roles = {};
    }),
  ],
  [
    "view_kind_not_namespaced",
    edit(spectrum, (m) => {
      (m.outputs.views.spectrum as unknown as Loose).kind = "spectrum";
    }),
  ],
  [
    "view_kind_unregistered",
    edit(spectrum, (m) => {
      (m.outputs.views.spectrum as unknown as Loose).kind = "acme.ridgeline";
    }),
  ],
  [
    "view_recipe_role_from_plugin",
    edit(spectrum, (m) => {
      (m.outputs.views.spectrum?.roles as Loose).layout = { from: "plugin" };
    }),
  ],
  [
    "view_role_three_dims",
    edit(spectrum, (m) => {
      ((m.outputs.views.spectrum?.roles as Loose).values as Loose).dims = [
        "freq",
        "sensor",
        "epoch",
      ];
    }),
  ],
  [
    "view_role_unit_without_columns",
    edit(spectrum, (m) => {
      ((m.outputs.views.spectrum?.roles as Loose).values as Loose).unit = "dB";
    }),
  ],
  [
    "view_role_unit_at_cap",
    edit(spectrum, (m) => {
      ((m.outputs.views.spectrum?.roles as Loose).values as Loose).unit = "\u{1D400}".repeat(32);
    }),
  ],
  [
    "view_role_unit_over_cap",
    edit(spectrum, (m) => {
      ((m.outputs.views.spectrum?.roles as Loose).values as Loose).unit = "\u{1D400}".repeat(33);
    }),
  ],
  [
    "view_role_unit_empty",
    edit(spectrum, (m) => {
      ((m.outputs.views.spectrum?.roles as Loose).values as Loose).unit = "";
    }),
  ],
  [
    "view_role_unit_beside_column_units",
    edit(spectrum, (m) => {
      const values = (m.outputs.views.spectrum?.roles as Loose).values as Loose;
      values.unit = "dB";
      values.columns = [
        { name: "freq_hz", type: "number", unit: "Hz" },
        { name: "Cz", type: "number" },
      ];
    }),
  ],
  [
    "view_recipe_role_with_unit",
    edit(spectrum, (m) => {
      (m.outputs.views.spectrum?.roles as Loose).layout = { from: "recipe", unit: "mm" };
    }),
  ],
  [
    "entry_not_a_module_path",
    edit(quality, (m) => {
      m.entry = "nemar_process/plugins";
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

  test("the cases cover valid manifests, every problem word and the schema refusals", () => {
    const v = computed.vectors;
    expect(v.filter((c) => c.schema_valid && c.problem === null).map((c) => c.name)).toEqual(
      expect.arrayContaining(["quality_valid", "views_only_valid", "metrics_only_valid"]),
    );
    for (const word of PLUGIN_MANIFEST_PROBLEMS) {
      expect(
        v.some((c) => c.problem === word),
        word,
      ).toBe(true);
    }
    for (const refused of [
      "checkpoint_figures",
      "outputs_figures",
      "metric_suffix_starts_with_a_digit",
      "plugin_name_with_a_dot",
      "view_role_over_cap",
    ]) {
      expect(v.find((c) => c.name === refused)?.schema_valid, refused).toBe(false);
    }
    for (const refused of [
      "view_role_unit_over_cap",
      "view_role_unit_empty",
      "view_recipe_role_with_unit",
    ]) {
      expect(v.find((c) => c.name === refused)?.schema_valid, refused).toBe(false);
    }
    for (const accepted of [
      "view_role_unit_without_columns",
      "view_role_unit_at_cap",
      "view_role_unit_beside_column_units",
    ]) {
      expect(
        v.find((c) => c.name === accepted),
        accepted,
      ).toMatchObject({
        schema_valid: true,
        problem: null,
      });
    }
    expect(v.find((c) => c.name === "view_role_at_cap")).toMatchObject({
      schema_valid: true,
      problem: null,
    });
    // the registry is the loader's check (kind_unregistered), not the schema's
    expect(v.find((c) => c.name === "view_kind_unregistered")).toMatchObject({
      schema_valid: true,
      problem: null,
    });
    // the figure vectors are gone: no valid figures manifest, no figures_without_figure word
    expect(v.map((c) => c.name)).not.toContain("figures_valid");
    expect(v.map((c) => c.problem)).not.toContain("figures_without_figure");
  });

  test("rule precedence and the bounds boundary", () => {
    const v = (name: string) => computed.vectors.find((c) => c.name === name);
    expect(v("bounds_reversed_before_metric_not_prefixed")?.problem).toBe("bounds_reversed");
    expect(v("metric_not_prefixed")?.problem).toBe("metric_not_prefixed");
    expect(v("metric_prefixed_by_another_plugin")?.problem).toBe("metric_not_prefixed");
    expect(v("metric_prefix_extends_the_name")?.problem).toBe("metric_not_prefixed");
    expect(v("plugin_without_output")?.problem).toBe("plugin_without_output");
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
