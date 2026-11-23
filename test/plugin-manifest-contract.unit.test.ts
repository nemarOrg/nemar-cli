/**
 * The quality plugin manifest, `nemar.plugin-manifest.v1` (ADR 0134 decision 6, epic #2324 phase 2).
 *
 * Pins, then agreement: a corpus is judged by Ajv on the shared JSON Schema and by zod, and both must
 * give the verdict the corpus names. Neuroschema: a declared metric plus a run's value and the plugin's
 * name and version is a valid neuroschema `qualityMetric`, and the name and version patterns agree with
 * neuroschema's `processingTypes.plugin`.
 */

import { describe, expect, test } from "bun:test";
import { Ajv2020 } from "ajv/dist/2020";
import * as contractIndex from "../shared/contract/index";
import {
  PLUGIN_CHECKPOINTS,
  PLUGIN_FIGURE_FORMATS,
  PLUGIN_FIGURE_MAX_BYTES,
  PLUGIN_MANIFEST_FORMAT,
  PLUGIN_MANIFEST_MAX_BYTES,
  PLUGIN_MAX_FIGURES,
  PLUGIN_MAX_METRICS,
  PLUGIN_NAME_RE,
  PLUGIN_RASTER_FORMATS,
  PLUGIN_VERSION_RE,
  type PluginManifest,
  PluginManifestSchema,
  pluginManifestProblem,
} from "../shared/contract/plugin-manifest";
import manifestSchema from "../shared/contract/plugin-manifest.schema.json";
import { compileNeuroschemaValidator, formatAjvErrors } from "./contract/neuroschema-validator.js";

const ajv = new Ajv2020({ allErrors: true, strict: true });
ajv.addSchema(manifestSchema);
const ajvManifest = ajv.getSchema(`${manifestSchema.$id}#/$defs/PluginManifest`);
if (!ajvManifest) throw new Error("manifest schema member not found");

const valid = (): PluginManifest => ({
  format: PLUGIN_MANIFEST_FORMAT,
  name: "nemar-dataqual",
  version: "0.1.0",
  entry: "nemar_process.plugins.dataqual",
  checkpoint: "quality",
  reads: { dataset: false, recipes: ["nemar-floor"] },
  parameters: { freqs: [6, 10, 22], label: "x", strict: true, unset: null, threshold: 0.5 },
  outputs: {
    metrics: {
      percentGoodChannels: {
        unit: "%",
        description: "Share of channels kept.",
        bounds: { min: 0, max: 100 },
        headline: true,
      },
    },
    figures: {
      spectrum: {
        formats: ["svg", "png"],
        time_series: false,
        caption: "Power spectrum.",
        max_bytes: 200_000,
      },
      segment: {
        formats: ["webp"],
        time_series: true,
        caption: "Cleaned data.",
        max_bytes: 500_000,
      },
    },
  },
});

const both = (doc: unknown) => ({
  ajv: ajvManifest(doc) as boolean,
  zod: PluginManifestSchema.safeParse(doc).success,
});

/** A copy of the valid manifest changed by `mut`. */
const edit = (mut: (m: Record<string, unknown> & PluginManifest) => void): unknown => {
  const m = structuredClone(valid()) as Record<string, unknown> & PluginManifest;
  mut(m);
  return m;
};

describe("the words and numbers", () => {
  test("are the contract's", () => {
    expect(PLUGIN_MANIFEST_FORMAT).toBe("nemar.plugin-manifest.v1");
    expect([...PLUGIN_CHECKPOINTS]).toEqual(["quality", "figures"]);
    expect([...PLUGIN_FIGURE_FORMATS]).toEqual(["png", "svg", "webp"]);
    expect([...PLUGIN_RASTER_FORMATS]).toEqual(["png", "webp"]);
    expect(PLUGIN_FIGURE_MAX_BYTES).toBe(1_048_576);
    expect(PLUGIN_MANIFEST_MAX_BYTES).toBe(65_536);
    expect(PLUGIN_MAX_METRICS).toBe(64);
    expect(PLUGIN_MAX_FIGURES).toBe(32);
  });

  test("the index re-exports the module", () => {
    expect(contractIndex.PluginManifestSchema).toBe(PluginManifestSchema);
  });
});

describe("agreement corpus", () => {
  const metrics = (n: number) =>
    Object.fromEntries(
      Array.from({ length: n }, (_, i) => [`m${i}`, { unit: "%", description: "x" }]),
    );
  const cases: Array<[string, unknown, boolean]> = [
    ["valid", valid(), true],
    [
      "unknown key at the top",
      edit((m) => {
        m.extra = 1;
      }),
      false,
    ],
    [
      "unknown key in a metric",
      edit((m) => {
        (m.outputs.metrics.percentGoodChannels as Record<string, unknown>).extra = 1;
      }),
      false,
    ],
    [
      "unknown key in a figure",
      edit((m) => {
        (m.outputs.figures.spectrum as Record<string, unknown>).extra = 1;
      }),
      false,
    ],
    [
      "a time-series figure in svg",
      edit((m) => {
        m.outputs.figures.segment.formats = ["svg"];
      }),
      false,
    ],
    [
      "a time-series figure in png and webp",
      edit((m) => {
        m.outputs.figures.segment.formats = ["png", "webp"];
      }),
      true,
    ],
    [
      "a figure in jpg",
      edit((m) => {
        (m.outputs.figures.spectrum as Record<string, unknown>).formats = ["jpg"];
      }),
      false,
    ],
    [
      "repeated formats",
      edit((m) => {
        m.outputs.figures.spectrum.formats = ["png", "png"];
      }),
      false,
    ],
    [
      "a figure at the size cap",
      edit((m) => {
        m.outputs.figures.spectrum.max_bytes = PLUGIN_FIGURE_MAX_BYTES;
      }),
      true,
    ],
    [
      "a figure past the size cap",
      edit((m) => {
        m.outputs.figures.spectrum.max_bytes = PLUGIN_FIGURE_MAX_BYTES + 1;
      }),
      false,
    ],
    [
      "64 metrics",
      edit((m) => {
        m.outputs.metrics = metrics(64);
      }),
      true,
    ],
    [
      "65 metrics",
      edit((m) => {
        m.outputs.metrics = metrics(65);
      }),
      false,
    ],
    [
      "a metric name with a dot",
      edit((m) => {
        m.outputs.metrics = { "line.noise": { unit: "dB", description: "x" } };
      }),
      false,
    ],
    [
      "a namespaced metric name",
      edit((m) => {
        m.outputs.metrics = { "eeg:lineNoise": { unit: "dB", description: "x" } };
      }),
      true,
    ],
    [
      "an empty unit",
      edit((m) => {
        m.outputs.metrics.percentGoodChannels.unit = "";
      }),
      false,
    ],
    [
      "reads nothing",
      edit((m) => {
        m.reads = { dataset: false, recipes: [] };
      }),
      false,
    ],
    [
      "reads the dataset only",
      edit((m) => {
        m.reads = { dataset: true, recipes: [] };
      }),
      true,
    ],
    [
      "a repeated recipe",
      edit((m) => {
        m.reads.recipes = ["nemar-floor", "nemar-floor"];
      }),
      false,
    ],
    [
      "a checkpoint not allowed",
      edit((m) => {
        (m as Record<string, unknown>).checkpoint = "ica";
      }),
      false,
    ],
    [
      "an entry that is not a module path",
      edit((m) => {
        m.entry = "nemar_process/plugins.py";
      }),
      false,
    ],
    [
      "a parameter object",
      edit((m) => {
        (m.parameters as Record<string, unknown>).nested = { a: 1 };
      }),
      false,
    ],
    [
      "a parameter string past 256",
      edit((m) => {
        m.parameters.label = "a".repeat(257);
      }),
      false,
    ],
    [
      "a parameter list of strings",
      edit((m) => {
        (m.parameters as Record<string, unknown>).freqs = ["6"];
      }),
      false,
    ],
    [
      "a caption of 500 astral code points (1,000 UTF-16 units)",
      edit((m) => {
        m.outputs.figures.spectrum.caption = "\u{1F600}".repeat(500);
      }),
      true,
    ],
    [
      "a caption of 501 astral code points",
      edit((m) => {
        m.outputs.figures.spectrum.caption = "\u{1F600}".repeat(501);
      }),
      false,
    ],
    [
      "a unit of 32 astral code points",
      edit((m) => {
        m.outputs.metrics.percentGoodChannels.unit = "\u{1D400}".repeat(32);
      }),
      true,
    ],
    [
      "a wrong format word",
      edit((m) => {
        (m as Record<string, unknown>).format = "nemar.plugin-manifest.v2";
      }),
      false,
    ],
  ];
  test.each(cases)("%s", (_label, doc, verdict) => {
    expect(both(doc)).toEqual({ ajv: verdict, zod: verdict });
  });
});

describe("pluginManifestProblem", () => {
  test("a valid manifest has none", () => {
    expect(pluginManifestProblem(valid())).toBeNull();
  });

  test("refuses reversed bounds, a quality plugin with no metric, a figures plugin with no figure", () => {
    const reversed = valid();
    reversed.outputs.metrics.percentGoodChannels.bounds = { min: 100, max: 0 };
    expect(pluginManifestProblem(reversed)).toBe("bounds_reversed");
    const open = valid();
    open.outputs.metrics.percentGoodChannels.bounds = { min: 0, max: null };
    expect(pluginManifestProblem(open)).toBeNull();
    const noMetric = valid();
    noMetric.outputs.metrics = {};
    expect(pluginManifestProblem(noMetric)).toBe("quality_without_metric");
    const noFigure = { ...valid(), checkpoint: "figures" as const };
    noFigure.outputs = { ...noFigure.outputs, figures: {} };
    expect(pluginManifestProblem(noFigure)).toBe("figures_without_figure");
  });
});

describe("agreement with neuroschema 0.5.0", () => {
  test("a declared metric, a value and the plugin make a valid neuroschema qualityMetric", () => {
    const nsc = compileNeuroschemaValidator("nsc:/definitions/qualityMetric.schema.json");
    const m = valid();
    for (const [, metric] of Object.entries(m.outputs.metrics)) {
      for (const value of [93.5, null]) {
        const doc = { ...metric, value, plugin: { name: m.name, version: m.version } };
        const { headline: _headline, ...withoutHeadline } = doc;
        if (!nsc(withoutHeadline)) throw new Error(formatAjvErrors(nsc));
      }
    }
  });

  test("the name and version patterns agree with neuroschema processingTypes.plugin", () => {
    const nsc = compileNeuroschemaValidator(
      "nsc:/definitions/processingTypes.schema.json#/$defs/plugin",
    );
    for (const [name, version] of [
      ["nemar-dataqual", "0.1.0"],
      ["A.b_c-d", "1.0.0+build"],
      ["-bad", "0.1.0"],
      ["ok", "1 0"],
      ["a".repeat(129), "1"],
      ["ok", "a".repeat(65)],
    ]) {
      const ours = PLUGIN_NAME_RE.test(name) && PLUGIN_VERSION_RE.test(version);
      expect(ours, `${name} ${version}`).toBe(nsc({ name, version }) as boolean);
    }
  });
});
