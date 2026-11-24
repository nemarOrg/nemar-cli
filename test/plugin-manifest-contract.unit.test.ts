/**
 * The quality plugin manifest, `nemar.plugin-manifest.v1` (ADR 0134 decision 6, ADR 0137 decision 4).
 *
 * Pins, then agreement: a corpus is judged by Ajv on the shared JSON Schema and by zod, and both must
 * give the verdict the corpus names. Neuroschema: a declared metric plus a run's value and the plugin's
 * name and version is a valid neuroschema `qualityMetric`, and the name, version, metric-name and view
 * grammars agree with neuroschema 0.6.0's `processingTypes` and `view` definitions.
 */

import { describe, expect, test } from "bun:test";
import { Ajv2020 } from "ajv/dist/2020";
import * as contractIndex from "../shared/contract/index";
import {
  PLUGIN_CHECKPOINTS,
  PLUGIN_ENTRY_RE,
  PLUGIN_KEY_RE,
  PLUGIN_MANIFEST_FORMAT,
  PLUGIN_MANIFEST_MAX_BYTES,
  PLUGIN_MANIFEST_PROBLEMS,
  PLUGIN_MAX_METRICS,
  PLUGIN_MAX_VIEWS,
  PLUGIN_MAX_VIEW_COLUMNS,
  PLUGIN_MAX_VIEW_DIMS,
  PLUGIN_MAX_VIEW_ROLES,
  PLUGIN_METRIC_NAME_MAX,
  PLUGIN_METRIC_RE,
  PLUGIN_NAME_RE,
  PLUGIN_RECIPE_RE,
  PLUGIN_VERSION_RE,
  PLUGIN_VIEW_COLUMN_RE,
  PLUGIN_VIEW_FORMAT_RE,
  PLUGIN_VIEW_KIND_RE,
  PLUGIN_VIEW_MAX_BYTES,
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
  name: "nemar-spectrum",
  version: "0.1.0",
  entry: "nemar_process.plugins.nemar_spectrum",
  checkpoint: "quality",
  reads: { dataset: false, recipes: ["nemar-ica"] },
  parameters: { freqs: [6, 10, 22], label: "x", strict: true, unset: null, threshold: 0.5 },
  outputs: {
    metrics: {
      "nemar-spectrum:alphaPeak": {
        unit: "Hz",
        description: "Frequency of the alpha peak.",
        bounds: { min: 0, max: 125 },
        headline: true,
      },
    },
    views: {
      spectrum: {
        kind: "nemar.spectrum",
        kind_version: 1,
        caption: "Power spectrum per channel.",
        roles: {
          values: {
            format: "tsv",
            max_bytes: 400_000,
            dims: ["freq", "sensor"],
            columns: [{ name: "freq_hz", type: "number", unit: "Hz" }],
          },
          layout: { from: "recipe" },
        },
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

/** The valid manifest's spectrum view, for mutation. */
type Loose = Record<string, unknown>;
const spectrum = (m: PluginManifest) => m.outputs.views.spectrum as unknown as Loose;
const valuesRole = (m: PluginManifest) => (spectrum(m).roles as Loose).values as Loose;

describe("the words and numbers", () => {
  test("are the contract's", () => {
    expect(PLUGIN_MANIFEST_FORMAT).toBe("nemar.plugin-manifest.v1");
    expect([...PLUGIN_CHECKPOINTS]).toEqual(["quality"]);
    expect(PLUGIN_VIEW_MAX_BYTES).toBe(4_194_304);
    expect(PLUGIN_MANIFEST_MAX_BYTES).toBe(65_536);
    expect(PLUGIN_MAX_METRICS).toBe(64);
    expect(PLUGIN_MAX_VIEWS).toBe(16);
    expect(PLUGIN_MAX_VIEW_ROLES).toBe(8);
    expect(PLUGIN_MAX_VIEW_DIMS).toBe(2);
    expect(PLUGIN_MAX_VIEW_COLUMNS).toBe(64);
    expect(PLUGIN_METRIC_NAME_MAX).toBe(128);
    expect([...PLUGIN_MANIFEST_PROBLEMS]).toEqual([
      "bounds_reversed",
      "plugin_without_output",
      "metric_not_prefixed",
    ]);
  });

  test("no figure word is left in the module or the schema", () => {
    const words = Object.keys(contractIndex).filter((k) => /FIGURE|RASTER|PluginFigure/.test(k));
    expect(words).toEqual([]);
    expect(JSON.stringify(manifestSchema)).not.toMatch(/figure/i);
  });

  test("each JSON Schema pattern is the source of its TypeScript regex", () => {
    const d = manifestSchema.$defs;
    const m = d.PluginManifest.properties;
    const view = d.View.properties;
    const role = d.ViewProducedRole.properties;
    const pairs: Array<[string, string, RegExp]> = [
      ["name", m.name.pattern, PLUGIN_NAME_RE],
      ["version", m.version.pattern, PLUGIN_VERSION_RE],
      ["entry", m.entry.pattern, PLUGIN_ENTRY_RE],
      ["recipes", m.reads.properties.recipes.items.pattern, PLUGIN_RECIPE_RE],
      ["parameters", m.parameters.propertyNames.pattern, PLUGIN_KEY_RE],
      ["metrics", m.outputs.properties.metrics.propertyNames.pattern, PLUGIN_METRIC_RE],
      ["views", m.outputs.properties.views.propertyNames.pattern, PLUGIN_KEY_RE],
      ["kind", view.kind.pattern, PLUGIN_VIEW_KIND_RE],
      ["roles", view.roles.propertyNames.pattern, PLUGIN_KEY_RE],
      ["format", role.format.pattern, PLUGIN_VIEW_FORMAT_RE],
      ["dims", role.dims.items.pattern, PLUGIN_KEY_RE],
      ["column name", d.ViewColumn.properties.name.pattern, PLUGIN_VIEW_COLUMN_RE],
    ];
    for (const [where, pattern, re] of pairs) expect(pattern, where).toBe(re.source);
  });

  test("the index re-exports the module", () => {
    expect(contractIndex.PluginManifestSchema).toBe(PluginManifestSchema);
  });

  test("the schema's view byte cap is the registry's bytes_per_role", async () => {
    const registry = (await import("../shared/contract/neuroschema/views/registry.json")).default;
    expect(registry.caps.bytes_per_role).toBe(PLUGIN_VIEW_MAX_BYTES);
  });
});

describe("agreement corpus", () => {
  const metrics = (n: number) =>
    Object.fromEntries(
      Array.from({ length: n }, (_, i) => [
        `nemar-spectrum:m${i}`,
        { unit: "%", description: "x" },
      ]),
    );
  const views = (n: number) =>
    Object.fromEntries(
      Array.from({ length: n }, (_, i) => [
        `v${i}`,
        {
          kind: "nemar.table",
          kind_version: 1,
          caption: "x",
          roles: { table: { from: "recipe" } },
        },
      ]),
    );
  const roles = (n: number) =>
    Object.fromEntries(Array.from({ length: n }, (_, i) => [`r${i}`, { from: "recipe" }]));
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
        (m.outputs.metrics["nemar-spectrum:alphaPeak"] as unknown as Loose).extra = 1;
      }),
      false,
    ],
    [
      "outputs.figures beside outputs.views",
      edit((m) => {
        (m.outputs as Loose).figures = {};
      }),
      false,
    ],
    [
      "outputs.figures in place of outputs.views",
      edit((m) => {
        const o = m.outputs as Loose;
        o.figures = o.views;
        Reflect.deleteProperty(o, "views");
      }),
      false,
    ],
    [
      "the figures checkpoint",
      edit((m) => {
        (m as Loose).checkpoint = "figures";
      }),
      false,
    ],
    [
      "a checkpoint not allowed",
      edit((m) => {
        (m as Loose).checkpoint = "ica";
      }),
      false,
    ],
    [
      "unknown key in a view",
      edit((m) => {
        spectrum(m).extra = 1;
      }),
      false,
    ],
    [
      "a view without a caption",
      edit((m) => {
        Reflect.deleteProperty(spectrum(m), "caption");
      }),
      false,
    ],
    [
      "a view key with a capital",
      edit((m) => {
        m.outputs.views = { Spectrum: m.outputs.views.spectrum } as typeof m.outputs.views;
      }),
      false,
    ],
    [
      "a kind that is not namespaced",
      edit((m) => {
        spectrum(m).kind = "spectrum";
      }),
      false,
    ],
    [
      "an unregistered namespaced kind (the loader's word, not the schema's)",
      edit((m) => {
        spectrum(m).kind = "acme.ridgeline";
      }),
      true,
    ],
    [
      "a kind of 129 characters",
      edit((m) => {
        spectrum(m).kind = `a.${"b".repeat(127)}`;
      }),
      false,
    ],
    [
      "kind_version 0",
      edit((m) => {
        spectrum(m).kind_version = 0;
      }),
      false,
    ],
    [
      "kind_version 999",
      edit((m) => {
        spectrum(m).kind_version = 999;
      }),
      true,
    ],
    [
      "kind_version 1000",
      edit((m) => {
        spectrum(m).kind_version = 1000;
      }),
      false,
    ],
    [
      "a fractional kind_version",
      edit((m) => {
        spectrum(m).kind_version = 1.5;
      }),
      false,
    ],
    [
      "a view with no role",
      edit((m) => {
        spectrum(m).roles = {};
      }),
      false,
    ],
    [
      "a view with 8 roles",
      edit((m) => {
        spectrum(m).roles = roles(8);
      }),
      true,
    ],
    [
      "a view with 9 roles",
      edit((m) => {
        spectrum(m).roles = roles(9);
      }),
      false,
    ],
    [
      "16 views",
      edit((m) => {
        (m.outputs as Loose).views = views(16);
      }),
      true,
    ],
    [
      "17 views",
      edit((m) => {
        (m.outputs as Loose).views = views(17);
      }),
      false,
    ],
    [
      "a role at the byte cap",
      edit((m) => {
        valuesRole(m).max_bytes = PLUGIN_VIEW_MAX_BYTES;
      }),
      true,
    ],
    [
      "a role past the byte cap",
      edit((m) => {
        valuesRole(m).max_bytes = PLUGIN_VIEW_MAX_BYTES + 1;
      }),
      false,
    ],
    [
      "a role of 0 bytes",
      edit((m) => {
        valuesRole(m).max_bytes = 0;
      }),
      false,
    ],
    [
      "a role without dims",
      edit((m) => {
        Reflect.deleteProperty(valuesRole(m), "dims");
      }),
      false,
    ],
    [
      "a role with no dimension (a JSON document)",
      edit((m) => {
        Object.assign(valuesRole(m), { format: "json", dims: [] });
        Reflect.deleteProperty(valuesRole(m), "columns");
      }),
      true,
    ],
    [
      "a role with three dimensions",
      edit((m) => {
        valuesRole(m).dims = ["freq", "sensor", "epoch"];
      }),
      false,
    ],
    [
      "a role with a repeated dimension",
      edit((m) => {
        valuesRole(m).dims = ["sensor", "sensor"];
      }),
      false,
    ],
    [
      "a dimension name with a capital",
      edit((m) => {
        valuesRole(m).dims = ["Freq"];
      }),
      false,
    ],
    [
      "a format with a dot",
      edit((m) => {
        valuesRole(m).format = ".tsv";
      }),
      false,
    ],
    [
      "an image format (the loader refuses it as unwritable)",
      edit((m) => {
        valuesRole(m).format = "png";
      }),
      true,
    ],
    [
      "empty columns",
      edit((m) => {
        valuesRole(m).columns = [];
      }),
      false,
    ],
    [
      "a column of an unknown type",
      edit((m) => {
        valuesRole(m).columns = [{ name: "x", type: "float" }];
      }),
      false,
    ],
    [
      "a column name with a tab",
      edit((m) => {
        valuesRole(m).columns = [{ name: "a\tb", type: "number" }];
      }),
      false,
    ],
    [
      "a column name of 128 astral code points",
      edit((m) => {
        valuesRole(m).columns = [{ name: "\u{1F600}".repeat(128), type: "string" }];
      }),
      true,
    ],
    [
      "a column name of 129 astral code points",
      edit((m) => {
        valuesRole(m).columns = [{ name: "\u{1F600}".repeat(129), type: "string" }];
      }),
      false,
    ],
    [
      "64 columns",
      edit((m) => {
        valuesRole(m).columns = Array.from({ length: 64 }, (_, i) => ({
          name: `c${i}`,
          type: "number",
        }));
      }),
      true,
    ],
    [
      "65 columns",
      edit((m) => {
        valuesRole(m).columns = Array.from({ length: 65 }, (_, i) => ({
          name: `c${i}`,
          type: "number",
        }));
      }),
      false,
    ],
    [
      "a column unit of 32 astral code points",
      edit((m) => {
        valuesRole(m).columns = [{ name: "x", type: "number", unit: "\u{1D400}".repeat(32) }];
      }),
      true,
    ],
    [
      "a column unit of 33 astral code points",
      edit((m) => {
        valuesRole(m).columns = [{ name: "x", type: "number", unit: "\u{1D400}".repeat(33) }];
      }),
      false,
    ],
    [
      "an empty column unit",
      edit((m) => {
        valuesRole(m).columns = [{ name: "x", type: "number", unit: "" }];
      }),
      false,
    ],
    [
      "a column with an unknown key",
      edit((m) => {
        valuesRole(m).columns = [{ name: "x", type: "number", extra: 1 }];
      }),
      false,
    ],
    [
      "a format of 16 characters",
      edit((m) => {
        valuesRole(m).format = `t${"s".repeat(15)}`;
      }),
      true,
    ],
    [
      "a format of 17 characters",
      edit((m) => {
        valuesRole(m).format = `t${"s".repeat(16)}`;
      }),
      false,
    ],
    [
      "a role name with a capital",
      edit((m) => {
        (spectrum(m).roles as Loose).Layout = { from: "recipe" };
      }),
      false,
    ],
    [
      "a role name with a hyphen",
      edit((m) => {
        (spectrum(m).roles as Loose)["sensor-layout"] = { from: "recipe" };
      }),
      false,
    ],
    [
      "a role name with an underscore",
      edit((m) => {
        (spectrum(m).roles as Loose).sensor_layout = { from: "recipe" };
      }),
      true,
    ],
    [
      "a recipe role from elsewhere",
      edit((m) => {
        (spectrum(m).roles as Loose).layout = { from: "plugin" };
      }),
      false,
    ],
    [
      "a recipe role with a format beside it",
      edit((m) => {
        (spectrum(m).roles as Loose).layout = { from: "recipe", format: "tsv" };
      }),
      false,
    ],
    [
      "a produced role with from beside it",
      edit((m) => {
        valuesRole(m).from = "recipe";
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
        m.outputs.metrics = { "nemar-spectrum:line.noise": { unit: "dB", description: "x" } };
      }),
      false,
    ],
    [
      "a metric name whose part after the colon starts with a digit",
      edit((m) => {
        m.outputs.metrics = { "nemar-quality:9x": { unit: "dB", description: "x" } };
      }),
      false,
    ],
    [
      "a metric name with two colons",
      edit((m) => {
        m.outputs.metrics = { "a:b:c": { unit: "dB", description: "x" } };
      }),
      false,
    ],
    [
      "a bare metric name (the schema's grammar; the prefix is a rule)",
      edit((m) => {
        m.outputs.metrics = { alphaPeak: { unit: "Hz", description: "x" } };
      }),
      true,
    ],
    [
      "a metric name of 128 characters",
      edit((m) => {
        m.outputs.metrics = {
          [`nemar-spectrum:${"a".repeat(113)}`]: { unit: "Hz", description: "x" },
        };
      }),
      true,
    ],
    [
      "a metric name of 129 characters",
      edit((m) => {
        m.outputs.metrics = {
          [`nemar-spectrum:${"a".repeat(114)}`]: { unit: "Hz", description: "x" },
        };
      }),
      false,
    ],
    [
      "a plugin name with a dot",
      edit((m) => {
        m.name = "nemar.spectrum";
      }),
      false,
    ],
    [
      "a plugin name of 65 characters",
      edit((m) => {
        m.name = "a".repeat(65);
      }),
      false,
    ],
    [
      "an empty unit",
      edit((m) => {
        m.outputs.metrics["nemar-spectrum:alphaPeak"].unit = "";
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
      "an entry that is not a module path",
      edit((m) => {
        m.entry = "nemar_process/plugins.py";
      }),
      false,
    ],
    [
      "a parameter object",
      edit((m) => {
        (m.parameters as Loose).nested = { a: 1 };
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
        (m.parameters as Loose).freqs = ["6"];
      }),
      false,
    ],
    [
      "a caption of 500 astral code points (1,000 UTF-16 units)",
      edit((m) => {
        spectrum(m).caption = "\u{1F600}".repeat(500);
      }),
      true,
    ],
    [
      "a caption of 501 astral code points",
      edit((m) => {
        spectrum(m).caption = "\u{1F600}".repeat(501);
      }),
      false,
    ],
    [
      "a unit of 32 astral code points",
      edit((m) => {
        m.outputs.metrics["nemar-spectrum:alphaPeak"].unit = "\u{1D400}".repeat(32);
      }),
      true,
    ],
    [
      "a wrong format word",
      edit((m) => {
        (m as Loose).format = "nemar.plugin-manifest.v2";
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

  test("reversed bounds are refused; open and equal bounds are not", () => {
    const reversed = valid();
    reversed.outputs.metrics["nemar-spectrum:alphaPeak"].bounds = { min: 100, max: 0 };
    expect(pluginManifestProblem(reversed)).toBe("bounds_reversed");
    const open = valid();
    open.outputs.metrics["nemar-spectrum:alphaPeak"].bounds = { min: 0, max: null };
    expect(pluginManifestProblem(open)).toBeNull();
    const equal = valid();
    equal.outputs.metrics["nemar-spectrum:alphaPeak"].bounds = { min: 5, max: 5 };
    expect(pluginManifestProblem(equal)).toBeNull();
  });

  test("a plugin needs a metric or a view, and either alone is enough", () => {
    const none = valid();
    none.outputs = { metrics: {}, views: {} };
    expect(pluginManifestProblem(none)).toBe("plugin_without_output");
    const viewsOnly = valid();
    viewsOnly.outputs.metrics = {};
    expect(pluginManifestProblem(viewsOnly)).toBeNull();
    const metricsOnly = valid();
    metricsOnly.outputs.views = {};
    expect(pluginManifestProblem(metricsOnly)).toBeNull();
  });

  test("every metric is <plugin>:<name> with the manifest's own name as the prefix", () => {
    const named = (key: string) => {
      const m = valid();
      m.outputs.metrics[key] = { unit: "Hz", description: "x" };
      return pluginManifestProblem(m);
    };
    expect(named("alphaPeak")).toBe("metric_not_prefixed");
    expect(named("nemar-quality:alphaPeak")).toBe("metric_not_prefixed");
    expect(named("nemar-spectrumx:alphaPeak")).toBe("metric_not_prefixed");
    expect(named("nemar-spectru:alphaPeak")).toBe("metric_not_prefixed");
    expect(named("nemar-spectrum:betaPeak")).toBeNull();
  });

  test("the words are checked in their declared order", () => {
    // reversed bounds on an unprefixed metric: bounds_reversed first
    const both = valid();
    both.outputs.metrics = {
      alpha: { unit: "Hz", description: "x", bounds: { min: 2, max: 1 } },
    };
    expect(pluginManifestProblem(both)).toBe("bounds_reversed");
    // no output at all is plugin_without_output, never a later word
    const none = valid();
    none.outputs = { metrics: {}, views: {} };
    expect(pluginManifestProblem(none)).toBe("plugin_without_output");
  });
});

describe("agreement with neuroschema 0.6.0", () => {
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
      ["A_b-c", "1.0.0+build"],
      ["-bad", "0.1.0"],
      ["1abc", "0.1.0"],
      ["_abc", "0.1.0"],
      ["ok", "1 0"],
      ["a".repeat(64), "1"],
      ["a".repeat(65), "1"],
      ["a".repeat(129), "1"],
      ["ok\n", "1"],
      ["ok", "a".repeat(65)],
    ]) {
      const ours = PLUGIN_NAME_RE.test(name) && PLUGIN_VERSION_RE.test(version);
      expect(ours, `${name} ${version}`).toBe(nsc({ name, version }) as boolean);
    }
  });

  test("the metric name grammar and cap agree with neuroschema processingTypes.metricName", () => {
    const nsc = compileNeuroschemaValidator(
      "nsc:/definitions/processingTypes.schema.json#/$defs/metricName",
    );
    for (const name of [
      "percentBrainComponents",
      "nemar-quality:percentBrainComponents",
      "nemar-quality:9x",
      "nemar-quality:",
      ":x",
      "a:b:c",
      "a.b",
      "a$b",
      "9x",
      "x\n",
      "A_b-c:D_e-f",
      `p:${"a".repeat(126)}`,
      `p:${"a".repeat(127)}`,
    ]) {
      const ours = name.length <= PLUGIN_METRIC_NAME_MAX && PLUGIN_METRIC_RE.test(name);
      expect(ours, name).toBe(nsc(name) as boolean);
    }
  });

  test("every plugin name can prefix a metric name", () => {
    const nsc = compileNeuroschemaValidator(
      "nsc:/definitions/processingTypes.schema.json#/$defs/metricName",
    );
    for (const name of ["nemar-quality", "A_b-c", "a".repeat(64)]) {
      expect(PLUGIN_NAME_RE.test(name), name).toBe(true);
      expect(nsc(`${name}:x`) as boolean, name).toBe(true);
    }
  });

  test("the view grammars agree with neuroschema's", () => {
    const pairs: Array<[string, (s: string) => boolean, string[]]> = [
      [
        "nsc:/definitions/processingTypes.schema.json#/$defs/viewKey",
        (s) => PLUGIN_KEY_RE.test(s),
        ["spectrum", "ic_maps", "Spectrum", "1x", "a".repeat(64), "a".repeat(65), "a-b"],
      ],
      [
        "nsc:/definitions/processingTypes.schema.json#/$defs/roleName",
        (s) => PLUGIN_KEY_RE.test(s),
        ["values", "layout", "Values", "_x", "x\n"],
      ],
      [
        "nsc:/definitions/processingTypes.schema.json#/$defs/dimName",
        (s) => PLUGIN_KEY_RE.test(s),
        ["freq", "sensor", "Freq", "freq-hz"],
      ],
      [
        "nsc:/definitions/processingTypes.schema.json#/$defs/kindName",
        (s) => s.length <= 128 && PLUGIN_VIEW_KIND_RE.test(s),
        [
          "nemar.spectrum",
          "nemar.ic-maps",
          "acme.ridge.v2",
          "spectrum",
          "nemar.",
          "Nemar.x",
          "nemar.-x",
          `a.${"b".repeat(126)}`,
          `a.${"b".repeat(127)}`,
        ],
      ],
      [
        "nsc:/definitions/processingTypes.schema.json#/$defs/formatName",
        (s) => PLUGIN_VIEW_FORMAT_RE.test(s),
        ["tsv", "json", "TSV", ".tsv", "a".repeat(16), "a".repeat(17), "t-sv"],
      ],
      [
        "nsc:/definitions/view.schema.json#/$defs/columnName",
        (s) => [...s].length <= 128 && PLUGIN_VIEW_COLUMN_RE.test(s),
        ["freq_hz", "a b", "a\tb", "a\nb", "", "\u{1F600}".repeat(128), "\u{1F600}".repeat(129)],
      ],
    ];
    for (const [id, ours, samples] of pairs) {
      const nsc = compileNeuroschemaValidator(id);
      for (const s of samples)
        expect(ours(s), `${id} ${JSON.stringify(s)}`).toBe(nsc(s) as boolean);
    }
  });

  test("the declared kinds of the example manifest are in the registry with the declared roles", async () => {
    const registry = (await import("../shared/contract/neuroschema/views/registry.json")).default;
    for (const view of Object.values(valid().outputs.views)) {
      const entry = registry.kinds.find(
        (k) => k.kind === view.kind && k.kind_version === view.kind_version,
      );
      expect(entry, view.kind).toBeDefined();
      for (const [role, spec] of Object.entries(view.roles)) {
        const reg = (entry?.roles as Record<string, { formats: string[]; dims: string[] | null }>)[
          role
        ];
        expect(reg, `${view.kind} ${role}`).toBeDefined();
        if ("format" in spec) {
          expect(reg?.formats).toContain(spec.format);
          if (reg?.dims) expect(spec.dims).toEqual(reg.dims);
        }
      }
    }
  });
});
