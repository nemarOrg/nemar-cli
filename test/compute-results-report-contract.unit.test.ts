/**
 * The results report, `nemar.results-report.v1` (ADR 0134 decision 8, epic #2324 phase 6).
 *
 * Shared definitions: a checkpoint's counts and a failure equal the live progress schema's, the
 * checkpoint map equals the recipe progress file's, `result` equals the launch specification's
 * `$defs/result`, value for value; zod reuses the same schemas. Counts: every counts object the report
 * accepts, neuroschema `checkpointCounts` accepts. Agreement: a corpus judged by Ajv on the shared JSON
 * Schema and by zod gives the verdict it names (rules a schema cannot state are zod's only).
 */

import { describe, expect, test } from "bun:test";
import { Ajv2020 } from "ajv/dist/2020";
import { z } from "zod";
import launchSchema from "../shared/contract/compute-launch.schema.json";
import progressSchema from "../shared/contract/compute-progress.schema.json";
import recipeSchema from "../shared/contract/compute-recipe-progress.schema.json";
import {
  RESULTS_REPORT_FILE,
  RESULTS_REPORT_FORMAT,
  RESULTS_REPORT_LAUNCHER_FILES,
  RESULTS_REPORT_MAX_TABLES,
  RESULTS_REPORT_MODES,
  RESULTS_REPORT_RECORD_LEVELS,
  RESULTS_REPORT_VERIFIED_KINDS,
  ResultsReportSchema,
  refineResultsCheckpoints,
  refineResultsReport,
} from "../shared/contract/compute-results-report";
import reportSchema from "../shared/contract/compute-results-report.schema.json";
import * as contractIndex from "../shared/contract/index";
import { compileNeuroschemaValidator } from "./contract/neuroschema-validator.js";

const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true });
ajv.addSchema(reportSchema);
const ajvReport = ajv.getSchema(`${reportSchema.$id}#/$defs/ResultsReport`);
if (!ajvReport) throw new Error("results report schema member not found");

const HEX = "ab".repeat(32);
const counts = (passed: number, failed: number, skipped: number, total: number) => ({
  passed,
  failed,
  skipped,
  total,
});

const valid = () => ({
  format: RESULTS_REPORT_FORMAT,
  mode: "standalone",
  run_id: "0123456789abcdef0123456789abcdef",
  started_utc: "2026-11-23T10:00:00Z",
  finished_utc: "2026-11-23T10:05:00Z",
  launcher_version: "0.1.0",
  specification: { sha256: HEX },
  image: {
    uri: `ghcr.io/nemarorg/nemar-python@sha256:${HEX}`,
    digest: `sha256:${HEX}`,
    verification: null as unknown,
  },
  bundle_sha256: null as string | null,
  inputs: [{ name: "eeg", files: 12, bytes: 4096 }],
  result: {
    job_id: `job_${"0".repeat(24)}`,
    failure_code: null,
    detail: null,
    exit_number: 0,
    entry_exit_code: 0,
  },
  launcher_files: [
    { name: "result.json", sha256: HEX, size: 120 },
    { name: "progress.json", sha256: HEX, size: 300 },
  ],
  outputs: { files: 3, bytes: 2048, manifest_sha256: HEX },
  tables: [
    {
      path: "product/desc-nemarfloor_recordings.tsv",
      sha256: HEX,
      size: 512,
      rows: 3,
      succeeded: 2,
      failed: 1,
      skipped: 0,
      problem: null as string | null,
    },
  ],
  checkpoints: {
    recipe: { id: "nemar-floor", version: "1.0.0-b1" },
    table: "product/desc-nemarfloor_recordings.tsv",
    map: [
      { checkpoint: "import", steps: ["load", "signal_channels"] },
      { checkpoint: "preprocess", steps: ["flatline", "qc_amplitude"] },
      { checkpoint: "quality", steps: ["qc"] },
    ],
    counts: {
      import: counts(2, 1, 0, 3),
      preprocess: counts(2, 0, 1, 3),
      quality: counts(2, 0, 1, 3),
    },
    failures: {
      import: [
        {
          path: "sub-03/eeg/sub-03_task-rest_eeg.set",
          code: "load_failed",
          step: "load",
          checkpoint: "import",
        },
      ],
      preprocess: [],
      quality: [],
    },
  } as unknown,
  checkpoints_reason: null as string | null,
  records: [
    {
      path: "product/desc-nemarfloor_signalJourney.json",
      sha256: HEX,
      size: 900,
      level: "dataset",
    },
  ],
});

type Report = ReturnType<typeof valid>;
const both = (doc: unknown) => ({
  ajv: ajvReport(doc) as boolean,
  zod: ResultsReportSchema.safeParse(doc).success,
});

describe("the words and numbers", () => {
  test("are the contract's", () => {
    expect(RESULTS_REPORT_FORMAT).toBe("nemar.results-report.v1");
    expect(RESULTS_REPORT_FILE).toBe("results-report.json");
    expect(RESULTS_REPORT_MODES).toEqual(["standalone"]);
    expect(RESULTS_REPORT_LAUNCHER_FILES).toEqual([
      "result.json",
      "provenance.json",
      "manifest.json",
      "progress.json",
    ]);
    expect(RESULTS_REPORT_MAX_TABLES).toBe(64);
    expect(RESULTS_REPORT_VERIFIED_KINDS).toEqual(["image", "sif"]);
    expect(RESULTS_REPORT_RECORD_LEVELS).toEqual(["dataset", "recording"]);
    const r = reportSchema.$defs.ResultsReport.properties;
    expect(r.format.const).toBe(RESULTS_REPORT_FORMAT);
    expect(r.mode.enum).toEqual([...RESULTS_REPORT_MODES]);
    expect(r.launcher_files.items.properties.name.enum).toEqual([...RESULTS_REPORT_LAUNCHER_FILES]);
    expect(r.tables.maxItems).toBe(RESULTS_REPORT_MAX_TABLES);
    expect(r.records.items.properties.level.enum).toEqual([...RESULTS_REPORT_RECORD_LEVELS]);
  });

  test("the contract index re-exports the module", () => {
    expect(contractIndex.ResultsReportSchema).toBe(ResultsReportSchema);
  });
});

describe("the definitions shared with other schemas are theirs, value for value", () => {
  const defs = reportSchema.$defs as Record<string, unknown>;
  test("counts and failures are the live progress object's", () => {
    const names = [
      "CheckpointName",
      "FailureCode",
      "StepId",
      "ProgressPath",
      "Count",
      "CheckpointCounts",
      "ProgressFailure",
    ];
    for (const name of names) {
      expect(defs[name], name).toEqual((progressSchema.$defs as Record<string, unknown>)[name]);
    }
  });

  test("the checkpoint map is the recipe progress file's", () => {
    expect(defs.CheckpointMap).toEqual(recipeSchema.$defs.CheckpointMap);
  });

  test("result is the launch specification's launcher result", () => {
    expect(defs.result).toEqual(launchSchema.$defs.result);
  });

  test("the image reference is the launch specification's, but for its description", () => {
    const { description: reportText, ...reportUri } =
      reportSchema.$defs.ResultsReport.properties.image.properties.uri;
    const { description: _launchText, ...launchUri } = launchSchema.properties.image.properties.uri;
    expect(reportUri).toEqual(launchUri);
    // The report has no image file, so its description names only the rule it enforces.
    expect(reportText).not.toContain("sif");
    expect(reportText).toContain("must equal image.digest");
  });
});

describe("every counts object the report accepts, neuroschema checkpointCounts accepts", () => {
  const nscCounts = compileNeuroschemaValidator("nsc:/definitions/checkpointCounts.schema.json");
  test("the valid report's counts", () => {
    const report = valid();
    expect(both(report)).toEqual({ ajv: true, zod: true });
    const c = (report.checkpoints as { counts: Record<string, unknown> }).counts;
    for (const [name, value] of Object.entries(c)) expect(nscCounts(value), name).toBe(true);
  });
});

describe("Ajv and zod agree", () => {
  type Case = [string, (d: Report) => unknown, boolean];
  const withCheckpoints = (d: Report, f: (c: Record<string, unknown>) => unknown) => ({
    ...d,
    checkpoints: f({ ...(d.checkpoints as Record<string, unknown>) }),
  });
  const cases: Case[] = [
    ["valid", (d) => d, true],
    [
      "no checkpoints, with a reason",
      (d) => ({ ...d, checkpoints: null, checkpoints_reason: "progress_file_not_seen" }),
      true,
    ],
    ["no checkpoints and no reason", (d) => ({ ...d, checkpoints: null }), false],
    ["checkpoints and a reason", (d) => ({ ...d, checkpoints_reason: "x" }), false],
    ["a command job, no bundle", (d) => ({ ...d, bundle_sha256: null }), true],
    ["a bundle digest", (d) => ({ ...d, bundle_sha256: HEX }), true],
    ["another format", (d) => ({ ...d, format: "nemar.results-report.v2" }), false],
    ["another mode", (d) => ({ ...d, mode: "service" }), false],
    ["an unknown key", (d) => ({ ...d, host: "x" }), false],
    ["a run id of 31 hex", (d) => ({ ...d, run_id: "0".repeat(31) }), false],
    ["a time with fractions", (d) => ({ ...d, started_utc: "2026-11-23T10:00:00.5Z" }), false],
    ["a time with an offset", (d) => ({ ...d, started_utc: "2026-11-23T10:00:00+01:00" }), false],
    ["finished before started", (d) => ({ ...d, finished_utc: "2026-11-23T09:00:00Z" }), false],
    [
      "a cosign image verification",
      (d) => ({
        ...d,
        image: {
          ...d.image,
          verification: { by: "cosign", kind: "image", cosign_version: "3.0.2" },
        },
      }),
      true,
    ],
    [
      "a cosign sif verification",
      (d) => ({
        ...d,
        image: {
          ...d.image,
          verification: {
            by: "cosign",
            kind: "sif",
            cosign_version: "3.0.2",
            sif_manifest: `sha256:${HEX}`,
            sif_layer: `sha256:${"cd".repeat(32)}`,
          },
        },
      }),
      true,
    ],
    [
      "a sif verification without its layer",
      (d) => ({
        ...d,
        image: {
          ...d.image,
          verification: {
            by: "cosign",
            kind: "sif",
            cosign_version: "3.0.2",
            sif_manifest: `sha256:${HEX}`,
          },
        },
      }),
      false,
    ],
    [
      "an image verification naming a manifest",
      (d) => ({
        ...d,
        image: {
          ...d.image,
          verification: {
            by: "cosign",
            kind: "image",
            cosign_version: "3.0.2",
            sif_manifest: `sha256:${HEX}`,
          },
        },
      }),
      false,
    ],
    [
      "another verifier",
      (d) => ({
        ...d,
        image: { ...d.image, verification: { by: "notary", kind: "image", cosign_version: "1" } },
      }),
      false,
    ],
    [
      "an image not pinned by digest",
      (d) => ({ ...d, image: { ...d.image, uri: "ghcr.io/x/y:latest" } }),
      false,
    ],
    [
      "an input name with a slash",
      (d) => ({ ...d, inputs: [{ name: "a/b", files: 1, bytes: 1 }] }),
      false,
    ],
    ["an input named twice", (d) => ({ ...d, inputs: [d.inputs[0], d.inputs[0]] }), false],
    [
      "a launcher file named twice",
      (d) => ({ ...d, launcher_files: [d.launcher_files[0], d.launcher_files[0]] }),
      false,
    ],
    [
      "an unknown launcher file",
      (d) => ({ ...d, launcher_files: [{ name: "launcher.log", sha256: HEX, size: 1 }] }),
      false,
    ],
    [
      "a failed result",
      (d) => ({
        ...d,
        result: { ...d.result, failure_code: "time_limit", detail: null, exit_number: 15 },
      }),
      true,
    ],
    [
      "a result whose exit does not match its code",
      (d) => ({ ...d, result: { ...d.result, failure_code: "time_limit", exit_number: 0 } }),
      false,
    ],
    [
      "outputs past the file cap",
      (d) => ({ ...d, outputs: { ...d.outputs, files: 100001 } }),
      false,
    ],
    [
      "a table with an absolute path",
      (d) => ({ ...d, tables: [{ ...d.tables[0], path: "/abs/x_recordings.tsv" }] }),
      false,
    ],
    [
      "a table with a .. segment",
      (d) => ({ ...d, tables: [{ ...d.tables[0], path: "../x_recordings.tsv" }] }),
      false,
    ],
    [
      "a table problem word",
      (d) => ({ ...d, tables: [{ ...d.tables[0], problem: "digest_differs" }] }),
      true,
    ],
    [
      "a table problem sentence",
      (d) => ({ ...d, tables: [{ ...d.tables[0], problem: "Digest differs" }] }),
      false,
    ],
    ["65 tables", (d) => ({ ...d, tables: Array.from({ length: 65 }, () => d.tables[0]) }), false],
    [
      "a record at another level",
      (d) => ({ ...d, records: [{ ...d.records[0], level: "subject" }] }),
      false,
    ],
    [
      "a checkpoint with stored",
      (d) => withCheckpoints(d, (c) => ({ ...c, map: [{ checkpoint: "stored", steps: ["x"] }] })),
      false,
    ],
    [
      "checkpoint counts with an unknown key",
      (d) =>
        withCheckpoints(d, (c) => ({
          ...c,
          counts: { import: { ...counts(1, 0, 0, 1), remaining: 0 } },
        })),
      false,
    ],
    ["checkpoint counts empty", (d) => withCheckpoints(d, (c) => ({ ...c, counts: {} })), false],
    [
      "eleven failures at one checkpoint",
      (d) =>
        withCheckpoints(d, (c) => ({
          ...c,
          failures: {
            import: Array.from({ length: 11 }, (_, i) => ({
              path: `sub-${i}/x.set`,
              code: "load_failed",
              step: "load",
              checkpoint: "import",
            })),
          },
        })),
      false,
    ],
    [
      "checkpoints with an unknown key",
      (d) => withCheckpoints(d, (c) => ({ ...c, host: "x" })),
      false,
    ],
    [
      "a checkpoint table outside the pattern",
      (d) => withCheckpoints(d, (c) => ({ ...c, table: "x.tsv" })),
      false,
    ],
    [
      "an image reference not pinned to the digest",
      (d) => ({
        ...d,
        image: { ...d.image, uri: `ghcr.io/nemarorg/nemar-python@sha256:${"ef".repeat(32)}` },
      }),
      false,
    ],
    [
      "failures at nine checkpoints",
      (d) =>
        withCheckpoints(d, (c) => ({
          ...c,
          failures: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`c${i}`, []])),
        })),
      false,
    ],
    [
      "counts missing a map checkpoint",
      (d) =>
        withCheckpoints(d, (c) => ({
          ...c,
          counts: { import: counts(2, 1, 0, 3), preprocess: counts(2, 0, 1, 3) },
        })),
      false,
    ],
    [
      "counts naming a checkpoint the map does not",
      (d) =>
        withCheckpoints(d, (c) => ({
          ...c,
          counts: { ...(c.counts as object), validate: counts(3, 0, 0, 3) },
        })),
      false,
    ],
    [
      "failures missing a map checkpoint",
      (d) =>
        withCheckpoints(d, (c) => ({
          ...c,
          failures: { import: (c.failures as { import: unknown[] }).import, preprocess: [] },
        })),
      false,
    ],
    [
      "a failure listed under another checkpoint",
      (d) =>
        withCheckpoints(d, (c) => ({
          ...c,
          counts: {
            import: counts(2, 1, 0, 3),
            preprocess: counts(1, 1, 1, 3),
            quality: counts(1, 0, 2, 3),
          },
          failures: {
            import: (c.failures as { import: unknown[] }).import,
            preprocess: (c.failures as { import: unknown[] }).import,
            quality: [],
          },
        })),
      false,
    ],
    [
      "a column counting past its total",
      (d) =>
        withCheckpoints(d, (c) => ({
          ...c,
          counts: { ...(c.counts as object), quality: counts(3, 0, 1, 3) },
        })),
      false,
    ],
    [
      "columns with different totals",
      (d) =>
        withCheckpoints(d, (c) => ({
          ...c,
          counts: { ...(c.counts as object), quality: counts(2, 0, 1, 4) },
        })),
      false,
    ],
    [
      "more failures listed than counted",
      (d) =>
        withCheckpoints(d, (c) => ({
          ...c,
          counts: { ...(c.counts as object), import: counts(3, 0, 0, 3) },
        })),
      false,
    ],
  ];
  const zodOnly = new Set([
    "finished before started",
    "an input named twice",
    "a launcher file named twice",
    "an image reference not pinned to the digest",
    "counts missing a map checkpoint",
    "counts naming a checkpoint the map does not",
    "failures missing a map checkpoint",
    "a failure listed under another checkpoint",
    "a column counting past its total",
    "columns with different totals",
    "more failures listed than counted",
  ]);
  for (const [name, build, expected] of cases) {
    test(name, () => {
      const verdict = both(build(valid()));
      expect(verdict.zod, "zod").toBe(expected);
      expect(verdict.ajv, "ajv").toBe(zodOnly.has(name) ? true : expected);
    });
  }
});

describe("each checkpoints rule is zod's own, by its message", () => {
  const messages = (doc: unknown) => {
    const parsed = ResultsReportSchema.safeParse(doc);
    return parsed.success ? [] : parsed.error.issues.map((i) => i.message);
  };
  const withFailures = (failures: unknown) => {
    const d = valid();
    return { ...d, checkpoints: { ...(d.checkpoints as object), failures } };
  };
  test("failures at nine checkpoints names the key count", () => {
    const failures = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`c${i}`, []]));
    expect(messages(withFailures(failures))).toContain("failures holds at most 8 checkpoints");
  });

  test("failures missing a map checkpoint names the key rule", () => {
    const d = valid();
    const listed = (d.checkpoints as { failures: { import: unknown[] } }).failures.import;
    expect(messages(withFailures({ import: listed, preprocess: [] }))).toContain(
      "failures names exactly the map's checkpoints",
    );
  });

  test("a failure under another key names the listing rule", () => {
    const d = valid();
    const listed = (d.checkpoints as { failures: { import: unknown[] } }).failures.import;
    expect(messages(withFailures({ import: [], preprocess: listed, quality: [] }))).toContain(
      "a failure is listed under its checkpoint",
    );
  });

  test("counts missing a map checkpoint names the progress rule", () => {
    const d = valid();
    const c = d.checkpoints as { counts: Record<string, unknown> };
    const { quality: _q, ...rest } = c.counts;
    const doc = { ...d, checkpoints: { ...c, counts: rest } };
    expect(messages(doc)).toContain("the counts do not hold together: checkpoints_differ");
  });

  test("more failures listed than counted names the progress rule", () => {
    const d = valid();
    const c = d.checkpoints as { counts: Record<string, unknown> };
    const doc = {
      ...d,
      checkpoints: { ...c, counts: { ...c.counts, import: counts(3, 0, 0, 3) } },
    };
    expect(messages(doc)).toContain("the counts do not hold together: failures_over_count");
  });

  test("an unpinned image reference names the pin rule", () => {
    const d = valid();
    const doc = {
      ...d,
      image: { ...d.image, uri: `ghcr.io/nemarorg/nemar-python@sha256:${"ef".repeat(32)}` },
    };
    expect(messages(doc)).toContain("the image reference is not pinned to the image digest");
  });
});

describe("each cross rule is reported once, by one rule", () => {
  /** The issues a refinement gives for a value, run by zod itself on a value it does not parse. */
  const issuesOf = (refine: (v: never, ctx: z.RefinementCtx) => void, value: unknown) => {
    const parsed = z
      .any()
      .superRefine((v, ctx) => refine(v as never, ctx))
      .safeParse(value);
    return parsed.success
      ? []
      : parsed.error.issues.map((i) => ({ path: i.path, message: i.message }));
  };

  test("a bad image digest is one issue, the digest's, not also the pin's", () => {
    const d = valid();
    const doc = { ...d, image: { ...d.image, digest: "sha256:XYZ" } };
    const parsed = ResultsReportSchema.safeParse(doc);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.map((i) => i.path.join("."))).toEqual(["image.digest"]);
    }
    // The refinement alone, as zod would run it if the field issue did not stop it: no pin issue.
    expect(issuesOf(refineResultsReport, doc)).toEqual([]);
  });

  test("an empty map does not reach the live progress rules", () => {
    const d = valid();
    const c = d.checkpoints as Record<string, unknown>;
    expect(issuesOf(refineResultsCheckpoints, { ...c, map: [], failures: {} })).toEqual([]);
  });

  test("a failure naming a checkpoint the map lacks is one issue, failure_checkpoint_differs", () => {
    const d = valid();
    const c = d.checkpoints as { failures: { import: { checkpoint: string }[] } };
    const stray = { ...c.failures.import[0], checkpoint: "validate" };
    const doc = {
      ...d,
      checkpoints: { ...c, failures: { ...c.failures, import: [stray] } },
    };
    const parsed = ResultsReportSchema.safeParse(doc);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.map((i) => ({ path: i.path, message: i.message }))).toEqual([
        {
          path: ["checkpoints", "counts"],
          message: "the counts do not hold together: failure_checkpoint_differs",
        },
      ]);
    }
  });
});
