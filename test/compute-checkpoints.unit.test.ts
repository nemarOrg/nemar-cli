/**
 * The checkpoint counting rules (ADR 0134 decisions 2 to 4, epic #2324 phase 2): the table reader, the
 * outcome of each row at each checkpoint, the counts, the failure lists, the live progress rules, the
 * disagreement rule, what a run shows, and the neuroschema entries, validated against the vendored
 * neuroschema 0.5.0 bundle. The vectors file nemar-process replays (phase 3) is held equal to what this
 * module computes; `NEMAR_WRITE_PROGRESS_VECTORS=1` rewrites it.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  NOT_RUN_CODE,
  PIPELINE_STALLED_SECONDS,
  type RecordingRow,
  countRecordings,
  failuresByCheckpoint,
  firstCheckpointOf,
  liveDisagrees,
  parseRecordingsTable,
  pipelineRunStatus,
  processingDatasetEntry,
  processingEntryProblem,
  progressProblem,
  recordingOutcomes,
  signalJourneyLink,
} from "../shared/compute-checkpoints";
import { findRecipe } from "../shared/compute-recipes";
import { PROGRESS_FORMAT, type Progress } from "../shared/contract/compute-progress";
import { NEUROSCHEMA_VERSION } from "../shared/contract/index";
import {
  compileNeuroschemaDatasetValidator,
  compileNeuroschemaValidator,
  formatAjvErrors,
} from "./contract/neuroschema-validator.js";

const floor = findRecipe("nemar-floor");
const ica = findRecipe("nemar-ica");
if (!floor || !ica) throw new Error("registry");
const F = floor.checkpoints;
const I = ica.checkpoints;

const row = (
  path: string,
  status: RecordingRow["status"],
  code: string | null,
  step: string | null,
) => ({
  path,
  status,
  code,
  step,
});

describe("parseRecordingsTable", () => {
  const header = [
    "path",
    "datatype",
    "status",
    "code",
    "step",
    "detail",
    "n_channels",
    "n_signal_channels",
    "duration_s",
    "srate_hz",
    "plan_hash",
    "pct_good_channels",
    "pct_good_samples",
    "line_hz",
    "line_db_before",
    "line_db_after",
    "n_bad_channels",
    "n_not_assessed",
    "n_bad_segments",
    "skipped_steps",
    "record_content_sha256",
  ];
  const line = (path: string, status: string, code: string, step: string) =>
    [path, "eeg", status, code, step, ...Array(header.length - 5).fill("n/a")].join("\t");

  test("reads the floor's real header, n/a as null, and ignores the other columns", () => {
    const text = `${header.join("\t")}\n${line("a.set", "succeeded", "n/a", "n/a")}\n${line("b.set", "failed", "load_failed", "load")}\n`;
    expect(parseRecordingsTable(text)).toEqual({
      ok: true,
      rows: [row("a.set", "succeeded", null, null), row("b.set", "failed", "load_failed", "load")],
    });
  });

  test("tolerates CRLF and trailing blank lines", () => {
    const text = `${header.join("\t")}\r\n${line("a.set", "skipped", "time_budget", "n/a")}\r\n\r\n`;
    const read = parseRecordingsTable(text);
    expect(read).toEqual({ ok: true, rows: [row("a.set", "skipped", "time_budget", null)] });
  });

  test("an empty table with only a header has no rows", () => {
    expect(parseRecordingsTable(`${header.join("\t")}\n`)).toEqual({ ok: true, rows: [] });
  });

  test.each([
    ["empty_table", ""],
    ["missing_column", `${header.filter((c) => c !== "step").join("\t")}\n`],
    ["row_width", `${header.join("\t")}\na.set\tsucceeded\n`],
    ["bad_status", `${header.join("\t")}\n${line("a.set", "ok", "n/a", "n/a")}\n`],
    ["missing_code", `${header.join("\t")}\n${line("a.set", "failed", "n/a", "load")}\n`],
  ])("refuses %s", (reason, text) => {
    expect(parseRecordingsTable(text)).toEqual({ ok: false, reason });
  });
});

describe("recordingOutcomes", () => {
  test("succeeded passes everywhere", () => {
    expect(recordingOutcomes(row("a", "succeeded", null, null), F).map((o) => o.status)).toEqual([
      "passed",
      "passed",
      "passed",
    ]);
  });

  test("failed at a mapped step: passed before, failed at, skipped after with the same code and step", () => {
    expect(recordingOutcomes(row("a", "failed", "step_failed", "drift"), F)).toEqual([
      { status: "passed", code: null, step: null },
      { status: "failed", code: "step_failed", step: "drift" },
      { status: "skipped", code: "step_failed", step: "drift" },
    ]);
  });

  test("failed with no step or an unknown step fails at the first checkpoint", () => {
    for (const step of [null, "no_such_step"]) {
      expect(recordingOutcomes(row("a", "failed", "disk_error", step), F)).toEqual([
        { status: "failed", code: "disk_error", step: null },
        { status: "skipped", code: "disk_error", step: null },
        { status: "skipped", code: "disk_error", step: null },
      ]);
    }
  });

  test("skipped with no step is skipped everywhere; skipped at a step passes before it", () => {
    expect(
      recordingOutcomes(row("a", "skipped", "unsupported_format", null), F).map((o) => o.status),
    ).toEqual(["skipped", "skipped", "skipped"]);
    expect(
      recordingOutcomes(row("a", "skipped", "ica_ineligible", "ica"), I).map((o) => o.status),
    ).toEqual(["passed", "passed", "skipped", "skipped"]);
  });

  test("nemar-ica's re-run qc counts against preprocess", () => {
    expect(firstCheckpointOf(row("a", "failed", "step_failed", "qc"), I)).toBe("preprocess");
    expect(firstCheckpointOf(row("a", "failed", "step_failed", "qc"), F)).toBe("quality");
    expect(firstCheckpointOf(row("a", "succeeded", null, null), F)).toBeNull();
  });
});

describe("countRecordings and failuresByCheckpoint", () => {
  const rows = [
    row("a.set", "succeeded", null, null),
    row("b.set", "failed", "load_failed", "load"),
    row("c.set", "failed", "step_failed", "bad_channels"),
    row("d.set", "skipped", "unsupported_format", null),
  ];

  test("every column sums to the total and all totals are equal", () => {
    const counts = countRecordings(rows, F);
    expect(counts).toEqual({
      import: { passed: 2, failed: 1, skipped: 1, total: 4 },
      preprocess: { passed: 1, failed: 1, skipped: 2, total: 4 },
      quality: { passed: 1, failed: 0, skipped: 3, total: 4 },
    });
  });

  test("recordings a killed run never wrote are skipped everywhere; the total is never below the rows", () => {
    expect(countRecordings(rows, F, 6).quality).toEqual({
      passed: 1,
      failed: 0,
      skipped: 5,
      total: 6,
    });
    expect(countRecordings(rows, F, 2).import.total).toBe(4);
    expect(NOT_RUN_CODE).toBe("not_run");
  });

  test("failures go to the checkpoint they first did not pass, at most ten each, in table order", () => {
    const lists = failuresByCheckpoint(rows, F);
    expect(lists.import.map((f) => f.path)).toEqual(["b.set", "d.set"]);
    expect(lists.preprocess).toEqual([
      { path: "c.set", code: "step_failed", step: "bad_channels", checkpoint: "preprocess" },
    ]);
    expect(lists.quality).toEqual([]);
    const many = Array.from({ length: 12 }, (_, i) =>
      row(`x${i}.set`, "failed", "load_failed", "load"),
    );
    expect(failuresByCheckpoint(many, F).import).toHaveLength(10);
    expect(
      failuresByCheckpoint([row("/abs.set", "failed", "load_failed", "load")], F).import,
    ).toEqual([]);
  });
});

describe("progressProblem", () => {
  const live = (): Progress => ({
    format: PROGRESS_FORMAT,
    checkpoint: "preprocess",
    counts: {
      import: { passed: 3, failed: 1, skipped: 0, total: 6 },
      preprocess: { passed: 2, failed: 0, skipped: 1, total: 6 },
      quality: { passed: 1, failed: 0, skipped: 1, total: 6 },
    },
    failures: [{ path: "b.set", code: "load_failed", step: "load", checkpoint: "import" }],
  });
  const withCounts = (over: Partial<Progress["counts"]>) => {
    const p = live();
    p.counts = { ...p.counts, ...over } as Progress["counts"];
    return p;
  };

  test("a consistent object has no problem", () => {
    expect(progressProblem(live(), F)).toBeNull();
  });

  test.each([
    [
      "checkpoints_differ (missing)",
      (() => {
        const p = live();
        p.counts = { import: p.counts.import, preprocess: p.counts.preprocess };
        return p;
      })(),
      "checkpoints_differ",
    ],
    [
      "checkpoints_differ (stored sent)",
      withCounts({ stored: { passed: 0, failed: 0, skipped: 0, total: 6 } }),
      "checkpoints_differ",
    ],
    [
      "counts_over_total",
      withCounts({ import: { passed: 6, failed: 1, skipped: 0, total: 6 } }),
      "counts_over_total",
    ],
    [
      "totals_differ",
      withCounts({ quality: { passed: 1, failed: 0, skipped: 1, total: 7 } }),
      "totals_differ",
    ],
    ["checkpoint_unknown", { ...live(), checkpoint: "ica" }, "checkpoint_unknown"],
    [
      "failure_checkpoint_differs",
      { ...live(), failures: [{ path: "b.set", code: "x", step: null, checkpoint: "ica" }] },
      "failure_checkpoint_differs",
    ],
    [
      "failures_over_count",
      {
        ...live(),
        failures: [
          { path: "b.set", code: "x", step: null, checkpoint: "import" },
          { path: "c.set", code: "x", step: null, checkpoint: "import" },
        ],
      },
      "failures_over_count",
    ],
  ] as Array<[string, Progress, string]>)("%s", (_label, p, word) => {
    expect(progressProblem(p, F)).toBe(word as ReturnType<typeof progressProblem>);
  });
});

describe("liveDisagrees", () => {
  const c = (passed: number, failed: number, skipped: number, total: number) => ({
    passed,
    failed,
    skipped,
    total,
  });
  test("lag is not a disagreement; an excess or another total is", () => {
    expect(liveDisagrees(c(3, 0, 0, 10), c(8, 1, 1, 10))).toBe(false);
    expect(liveDisagrees(c(8, 1, 1, 10), c(8, 1, 1, 10))).toBe(false);
    expect(liveDisagrees(c(9, 0, 0, 10), c(8, 1, 1, 10))).toBe(true);
    expect(liveDisagrees(c(0, 2, 0, 10), c(8, 1, 1, 10))).toBe(true);
    expect(liveDisagrees(c(0, 0, 2, 10), c(8, 1, 1, 10))).toBe(true);
    expect(liveDisagrees(c(1, 0, 0, 9), c(8, 1, 1, 10))).toBe(true);
  });
});

describe("pipelineRunStatus", () => {
  const now = 1_800_000_000;
  test.each([
    [
      "succeeded stamp",
      { stampState: "succeeded", jobState: "finished", reportedAt: now - 9999 },
      "finished",
    ],
    ["failed stamp", { stampState: "failed", jobState: "failed", reportedAt: null }, "failed"],
    ["refused stamp", { stampState: "refused", jobState: null, reportedAt: null }, "failed"],
    [
      "unreported job",
      { stampState: "dispatched", jobState: "unreported", reportedAt: now - 10 },
      "stalled",
    ],
    [
      "report 179 s old",
      { stampState: "dispatched", jobState: "running", reportedAt: now - 179 },
      "running",
    ],
    [
      "report 180 s old",
      { stampState: "dispatched", jobState: "running", reportedAt: now - 180 },
      "running",
    ],
    [
      "report 181 s old",
      { stampState: "dispatched", jobState: "running", reportedAt: now - 181 },
      "stalled",
    ],
    [
      "never reported, queued",
      { stampState: "dispatched", jobState: "queued", reportedAt: null },
      "waiting",
    ],
    [
      "never reported, running",
      { stampState: "dispatched", jobState: "running", reportedAt: null },
      "running",
    ],
    ["no job yet", { stampState: "dispatched", jobState: null, reportedAt: null }, "waiting"],
  ])("%s", (_label, input, expected) => {
    expect(pipelineRunStatus({ ...input, now })).toBe(
      expected as ReturnType<typeof pipelineRunStatus>,
    );
  });

  test("stalled is three report cadences", () => {
    expect(PIPELINE_STALLED_SECONDS).toBe(180);
  });
});

describe("neuroschema entries, validated against the vendored 0.5.0 bundle", () => {
  const nscProcessing = compileNeuroschemaValidator("nsc:/extensions/processing.schema.json");
  const nscSignalJourney = compileNeuroschemaValidator("nsc:/extensions/signalJourney.schema.json");
  const rows = [
    row("a.set", "succeeded", null, null),
    row("b.set", "failed", "load_failed", "load"),
    row("c.set", "failed", "step_failed", "bad_channels"),
  ];
  const counts = countRecordings(rows, F);
  const stored = { passed: 1, failed: 0, skipped: 2, total: 3 };
  const entry = processingDatasetEntry({
    recipeVersion: floor.version,
    checkpoints: F,
    counts: { ...counts, stored },
  });

  test("the processing entry lists the declared checkpoints with stored and holds the writer's rules", () => {
    expect(entry.declared_checkpoints).toEqual(["import", "preprocess", "quality", "stored"]);
    expect(processingEntryProblem(entry)).toBeNull();
    const doc = { level: "dataset", recipes: { "nemar-floor": entry } };
    if (!nscProcessing(doc)) throw new Error(formatAjvErrors(nscProcessing));
  });

  test("processingEntryProblem refuses each broken copy", () => {
    const broken = (mut: (e: typeof entry) => void) => {
      const e = structuredClone(entry);
      mut(e);
      return processingEntryProblem(e);
    };
    expect(broken((e) => e.declared_checkpoints.pop())).toBe("keys_differ");
    expect(
      broken((e) => {
        e.counts.quality.skipped += 1;
      }),
    ).toBe("sums_differ");
    expect(
      broken((e) => {
        e.counts.stored = { passed: 1, failed: 0, skipped: 3, total: 4 };
      }),
    ).toBe("totals_differ");
    expect(
      broken((e) => {
        e.counts.quality = { passed: 2, failed: 0, skipped: 1, total: 3 };
      }),
    ).toBe("cascade_broken");
  });

  test("signalJourney links: in_progress and failed carry no record, completed carries all three", () => {
    const inProgress = signalJourneyLink({
      recipeVersion: "1.0.0",
      status: "in_progress",
      location: "x.json",
    });
    const failed = signalJourneyLink({ recipeVersion: "1.0.0", status: "failed" });
    const completed = signalJourneyLink({
      recipeVersion: "1.0.0",
      status: "completed",
      location: "desc-nemarfloor_signalJourney.json",
      sha256: "a".repeat(64),
      sjVersion: "0.1.0",
    });
    expect(inProgress).toMatchObject({ location: null, sha256: null, sj_version: null });
    for (const link of [inProgress, failed, completed]) {
      const doc = { recipes: { "nemar-floor": link } };
      if (!nscSignalJourney(doc)) throw new Error(formatAjvErrors(nscSignalJourney));
    }
    expect(
      signalJourneyLink({
        recipeVersion: "1.0.0",
        status: "completed",
        location: "x.json",
        sha256: "A".repeat(64),
        sjVersion: "0.1.0",
      }),
    ).toBeNull();
    expect(
      signalJourneyLink({
        recipeVersion: "1.0.0",
        status: "completed",
        location: "x.json",
        sha256: "a".repeat(64),
        sjVersion: "0.1",
      }),
    ).toBeNull();
    expect(
      signalJourneyLink({
        recipeVersion: "1.0.0",
        status: "completed",
        location: "/x.json",
        sha256: "a".repeat(64),
        sjVersion: "0.1.0",
      }),
    ).toBeNull();
  });

  test("both entries validate inside a whole dataset document through the dataset root", () => {
    const validate = compileNeuroschemaDatasetValidator();
    const doc = {
      schema_version: NEUROSCHEMA_VERSION,
      doc_type: "dataset",
      dataset_id: "nm000108",
      name: "x",
      source: "nemar",
      recording_modality: ["EEG"],
      extensions: {
        processing: { level: "dataset", recipes: { "nemar-floor": entry } },
        signalJourney: {
          recipes: {
            "nemar-floor": signalJourneyLink({ recipeVersion: "1.0.0", status: "failed" }),
          },
        },
      },
    };
    if (!validate(doc)) throw new Error(formatAjvErrors(validate));
  });
});

// The vectors nemar-process replays (phase 3): rows in, outcomes and counts out, per recipe map.
describe("the progress vectors file", () => {
  const VECTORS_PATH = join(import.meta.dir, "../shared/contract/compute-progress-vectors.json");
  const inputs: Array<{
    name: string;
    recipe: "nemar-floor" | "nemar-ica";
    rows: RecordingRow[];
    total?: number;
  }> = [
    {
      name: "floor_mixed",
      recipe: "nemar-floor",
      rows: [
        row("sub-01/eeg/a.set", "succeeded", null, null),
        row("sub-02/eeg/b.edf", "failed", "load_failed", "load"),
        row("sub-03/eeg/c.set", "failed", "all_channels_flagged", "bad_channels"),
        row("sub-04/eeg/d.set", "failed", "step_failed", "qc"),
        row("sub-05/eeg/e.bdf", "skipped", "unsupported_format", null),
        row("sub-06/eeg/f.set", "failed", "disk_error", null),
        row("sub-07/eeg/g.set", "skipped", "time_budget", null),
      ],
    },
    {
      name: "floor_killed",
      recipe: "nemar-floor",
      rows: [row("a.set", "succeeded", null, null)],
      total: 3,
    },
    {
      name: "ica_mixed",
      recipe: "nemar-ica",
      rows: [
        row("a.set", "succeeded", null, null),
        row("b.set", "failed", "step_failed", "qc"),
        row("c.set", "failed", "ica_degenerate", "ica"),
        row("d.set", "skipped", "ica_ineligible", "ica"),
        row("e.set", "failed", "out_of_memory", "asr"),
        row("f.set", "failed", "step_failed", "iclabel"),
      ],
    },
  ];
  const computed = {
    format: "nemar.progress-vectors.v1",
    note: "Generated by test/compute-checkpoints.unit.test.ts from shared/compute-checkpoints.ts; do not hand-edit (NEMAR_WRITE_PROGRESS_VECTORS=1 rewrites it).",
    maps: Object.fromEntries(
      [floor, ica].map((r) => [
        r.name,
        {
          version: r.version,
          checkpoints: r.checkpoints.map((c) => ({
            checkpoint: c.checkpoint,
            steps: [...c.steps],
          })),
        },
      ]),
    ),
    vectors: inputs.map((v) => {
      const map = (v.recipe === "nemar-floor" ? floor : ica).checkpoints;
      return {
        name: v.name,
        recipe: v.recipe,
        total: v.total ?? v.rows.length,
        rows: v.rows,
        outcomes: v.rows.map((r) => recordingOutcomes(r, map)),
        counts: countRecordings(v.rows, map, v.total),
        failures: failuresByCheckpoint(v.rows, map),
      };
    }),
  };

  test("the file equals what the code computes", () => {
    if (process.env.NEMAR_WRITE_PROGRESS_VECTORS === "1") {
      writeFileSync(VECTORS_PATH, `${JSON.stringify(computed, null, 2)}\n`);
    }
    expect(JSON.parse(readFileSync(VECTORS_PATH, "utf8"))).toEqual(computed);
  });
});
