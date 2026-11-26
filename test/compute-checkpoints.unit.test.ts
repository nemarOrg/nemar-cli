/**
 * The checkpoint counting rules (ADR 0134 decisions 2 to 4, epic #2324 phase 2): the table reader, the
 * outcome of each row at each checkpoint, the counts, the failure lists, the live progress rules, the
 * disagreement rule, what a run shows, and the neuroschema entries, validated against the vendored
 * neuroschema bundle. The vectors file nemar-process replays (phase 3) is held equal to what this
 * module computes; `NEMAR_WRITE_PROGRESS_VECTORS=1` rewrites it.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  NOT_RUN_CODE,
  PIPELINE_CELL_MARKS,
  PIPELINE_STALLED_SECONDS,
  type PipelineCellMark,
  type PipelineGridStatus,
  type RecordingRow,
  countRecordings,
  failuresByCheckpoint,
  firstCheckpointOf,
  liveDisagrees,
  parseRecordingsTable,
  pipelineCellMark,
  pipelineRunStatus,
  processingDatasetEntry,
  processingEntryProblem,
  processingRecordEntry,
  processingRecordProblem,
  progressProblem,
  readRecordingsHeader,
  readRecordingsRow,
  recordingOutcomes,
  signalJourneyLink,
  storedCounts,
} from "../shared/compute-checkpoints";
import { RECORD_STEP, declaredCheckpoints, findRecipe } from "../shared/compute-recipes";
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
  skipped?: RecordingRow["skipped_steps"],
): RecordingRow => ({
  path,
  status,
  code,
  step,
  ...(skipped === undefined ? {} : { skipped_steps: skipped }),
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

  test("skipped_steps: the plugin pairs of a succeeded row are read, a rule's own skips left alone", () => {
    const at = header.indexOf("skipped_steps");
    const withSkips = (status: string, code: string, step: string, cell: string) => {
      const cells = line("a.set", status, code, step).split("\t");
      cells[at] = cell;
      return cells.join("\t");
    };
    const read = (cell: string, status = "succeeded", code = "n/a", step = "n/a") =>
      parseRecordingsTable(`${header.join("\t")}\n${withSkips(status, code, step, cell)}\n`);
    expect(read("bad_windows:too_short,nemar-quality:plugin_failed")).toEqual({
      ok: true,
      rows: [
        row("a.set", "succeeded", null, null, [{ step: "nemar-quality", code: "plugin_failed" }]),
      ],
    });
    // spaces around a step or a reason are trimmed
    for (const cell of [
      "bad_windows:too_short, nemar-quality:plugin_failed",
      "bad_windows:too_short,nemar-quality :plugin_failed",
    ]) {
      expect(read(cell), cell).toEqual({
        ok: true,
        rows: [
          row("a.set", "succeeded", null, null, [{ step: "nemar-quality", code: "plugin_failed" }]),
        ],
      });
    }
    // a rule's skip only, an empty cell and n/a: no plugin pairs, the row as before
    for (const cell of ["bad_windows:too_short", "", "n/a"]) {
      expect(read(cell)).toEqual({ ok: true, rows: [row("a.set", "succeeded", null, null)] });
    }
    // a failed row's cell is not read
    expect(read("nemar-quality:Bad Word", "failed", "load_failed", "load")).toEqual({
      ok: true,
      rows: [row("a.set", "failed", "load_failed", "load")],
    });
    // a malformed plugin pair is refused
    for (const cell of [
      "nemar-quality",
      "nemar-quality:",
      "nemar-quality:Bad Word",
      "nemar-quality:a,nemar-quality:b",
    ]) {
      expect(read(cell), cell).toEqual({ ok: false, reason: "bad_skipped_steps" });
    }
    // a table without the column reads as before
    const bare = "path\tstatus\tcode\tstep\na.set\tsucceeded\tn/a\tn/a\n";
    expect(parseRecordingsTable(bare)).toEqual({
      ok: true,
      rows: [row("a.set", "succeeded", null, null)],
    });
  });

  test("an empty table with only a header has no rows", () => {
    expect(parseRecordingsTable(`${header.join("\t")}\n`)).toEqual({ ok: true, rows: [] });
  });

  test("refuses a table of more rows than PROGRESS_MAX_RECORDINGS", () => {
    const head = "path\tstatus\tcode\tstep\n";
    const text = head + "a\tsucceeded\tn/a\tn/a\n".repeat(1_000_001);
    expect(parseRecordingsTable(text)).toEqual({ ok: false, reason: "too_many_rows" });
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
    ).toEqual(["passed", "passed", "skipped", "skipped", "skipped"]);
  });

  test("the step `record` counts against the last declared checkpoint; a step-less fault against the first", () => {
    expect(RECORD_STEP).toBe("record");
    expect(firstCheckpointOf(row("a", "failed", "disk_error", "record"), F)).toBe("quality");
    expect(firstCheckpointOf(row("a", "failed", "disk_error", "record"), I)).toBe("quality");
    expect(recordingOutcomes(row("a", "failed", "disk_error", "record"), F)).toEqual([
      { status: "passed", code: null, step: null },
      { status: "passed", code: null, step: null },
      { status: "failed", code: "disk_error", step: "record" },
    ]);
    expect(firstCheckpointOf(row("a", "failed", "disk_error", null), I)).toBe("import");
  });

  test("a succeeded recording that skipped a plugin is skipped at that plugin's checkpoint only; totals still sum", () => {
    const skippedQuality = row("a", "succeeded", null, null, [
      { step: "nemar-quality", code: "plugin_failed" },
    ]);
    expect(recordingOutcomes(skippedQuality, I)).toEqual([
      { status: "passed", code: null, step: null },
      { status: "passed", code: null, step: null },
      { status: "passed", code: null, step: null },
      { status: "passed", code: null, step: null },
      { status: "skipped", code: "plugin_failed", step: "nemar-quality" },
    ]);
    // a recipe that does not run the plugin ignores it
    expect(recordingOutcomes(skippedQuality, F).map((o) => o.status)).toEqual([
      "passed",
      "passed",
      "passed",
    ]);
    const rows = [row("b", "succeeded", null, null), skippedQuality];
    const counts = countRecordings(rows, I);
    for (const c of Object.values(counts)) expect(c.passed + c.failed + c.skipped).toBe(c.total);
    expect(counts.quality).toEqual({ passed: 1, failed: 0, skipped: 1, total: 2 });
    expect(counts.iclabel).toEqual({ passed: 2, failed: 0, skipped: 0, total: 2 });
    expect(failuresByCheckpoint(rows, I).quality).toEqual([
      { path: "a", code: "plugin_failed", step: "nemar-quality", checkpoint: "quality" },
    ]);
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

  test("a path neuroschema 0.6.0 relativeLocation refuses is left out of the failure lists", () => {
    for (const path of ["./a.set", "sub-01//a.set", "sub-01/./a.set", "a%2e.set", "a.set "]) {
      expect(
        failuresByCheckpoint([row(path, "failed", "load_failed", "load")], F).import,
        path,
      ).toEqual([]);
    }
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
  type In = Parameters<typeof pipelineRunStatus>[0];
  const c = (stampState: In["stampState"], jobState: In["jobState"], age: number | null) => ({
    stampState,
    jobState,
    reportedAt: age === null ? null : now - age,
  });
  test.each([
    ["succeeded stamp", c("succeeded", "finished", 9999), "finished"],
    ["failed stamp", c("failed", "failed", null), "failed"],
    ["refused stamp", c("refused", null, null), "failed"],
    ["dispatched stamp, finished job", c("dispatched", "finished", 9999), "finished"],
    ["dispatched stamp, failed job", c("dispatched", "failed", 9999), "failed"],
    ["dispatched stamp, cancelled job", c("dispatched", "cancelled", null), "failed"],
    ["unreported job", c("dispatched", "unreported", 10), "stalled"],
    ["running, report 179 s old", c("dispatched", "running", 179), "running"],
    ["running, report 180 s old", c("dispatched", "running", 180), "running"],
    ["running, report 181 s old", c("dispatched", "running", 181), "stalled"],
    ["queued, report 181 s old", c("dispatched", "queued", 181), "stalled"],
    ["submitted, report 181 s old", c("dispatched", "submitted", 181), "stalled"],
    ["archiving, report 999 s old", c("dispatched", "archiving", 999), "running"],
    ["created, report 999 s old", c("dispatched", "created", 999), "running"],
    ["never reported, queued", c("dispatched", "queued", null), "waiting"],
    ["never reported, created", c("dispatched", "created", null), "waiting"],
    ["never reported, running", c("dispatched", "running", null), "running"],
    ["never reported, archiving", c("dispatched", "archiving", null), "running"],
    ["no job yet", c("dispatched", null, null), "waiting"],
  ] as Array<[string, Omit<In, "now">, string]>)("%s", (_label, input, expected) => {
    expect(pipelineRunStatus({ ...input, now })).toBe(
      expected as ReturnType<typeof pipelineRunStatus>,
    );
  });

  test("stalled is three report cadences", () => {
    expect(PIPELINE_STALLED_SECONDS).toBe(180);
  });
});

describe("neuroschema entries, validated against the vendored bundle", () => {
  const nscProcessing = compileNeuroschemaValidator("nsc:/extensions/processing.schema.json");
  const nscSignalJourney = compileNeuroschemaValidator("nsc:/extensions/signalJourney.schema.json");
  const rows = [
    row("a.set", "succeeded", null, null),
    row("b.set", "failed", "load_failed", "load"),
    row("c.set", "failed", "step_failed", "bad_channels"),
  ];
  const counts = countRecordings(rows, F);
  const stored = { passed: 1, failed: 0, skipped: 2, total: 3 };
  const built = processingDatasetEntry({
    recipeVersion: floor.version,
    declared: declaredCheckpoints(floor),
    counts: { ...counts, stored },
  });
  if (built === null) throw new Error("entry");
  const entry = built;

  test("the processing entry lists the declared checkpoints with stored and holds the writer's rules", () => {
    expect(entry.declared_checkpoints).toEqual(["import", "preprocess", "quality", "stored"]);
    expect(processingEntryProblem(entry)).toBeNull();
    const doc = { level: "dataset", recipes: { "nemar-floor": entry } };
    if (!nscProcessing(doc)) throw new Error(formatAjvErrors(nscProcessing));
  });

  test("a declared checkpoint with no counts builds no entry, and nothing throws", () => {
    expect(
      processingDatasetEntry({
        recipeVersion: floor.version,
        declared: declaredCheckpoints(floor),
        counts: { import: counts.import, quality: counts.quality, stored },
      }),
    ).toBeNull();
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
    // neuroschema 0.6.0 relativeLocation: no . segment, no empty segment, none of % ? #.
    for (const location of ["./x.json", "a//x.json", "x.json/", "x%2ejson", "x.json#y"]) {
      const link = {
        recipe_version: "1.0.0",
        processing_status: "completed",
        location,
        sha256: "a".repeat(64),
        sj_version: "0.1.0",
      };
      expect(nscSignalJourney({ recipes: { "nemar-floor": link } }), location).toBe(false);
      expect(
        signalJourneyLink({
          recipeVersion: "1.0.0",
          status: "completed",
          location,
          sha256: "a".repeat(64),
          sjVersion: "0.1.0",
        }),
        location,
      ).toBeNull();
    }
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
        row("sub-08/eeg/h.set", "failed", "disk_error", "record"),
        row("sub-09/eeg/i.set", "failed", "step_failed", "qc_amplitude"),
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
        row("d.set", "skipped", "ica_ineligible", "ica_eligibility"),
        row("e.set", "failed", "out_of_memory", "asr"),
        row("f.set", "failed", "step_failed", "iclabel"),
        row("g.set", "failed", "internal_error", "record"),
        row("h.set", "failed", "step_failed", "iclabel_locations"),
        row("i.set", "succeeded", null, null, [{ step: "nemar-quality", code: "plugin_failed" }]),
      ],
    },
    {
      name: "floor_live_partial",
      recipe: "nemar-floor",
      rows: [
        row("sub-01/eeg/a.set", "succeeded", null, null),
        row("sub-02/eeg/b.set", "failed", "load_failed", "load"),
      ],
      total: 5,
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

// Phase B4: a recording's own entries, which summed over a run's rows are the run's reconciled counts.
describe("record-level entries", () => {
  const nscProcessing = compileNeuroschemaValidator("nsc:/extensions/processing.schema.json");
  const nscSignalJourney = compileNeuroschemaValidator("nsc:/extensions/signalJourney.schema.json");
  const VECTORS = JSON.parse(
    readFileSync(join(import.meta.dir, "../shared/contract/compute-progress-vectors.json"), "utf8"),
  ) as { vectors: Array<{ name: string; recipe: string; total: number; rows: RecordingRow[] }> };

  test("storedCounts: kept stores the last checkpoint's passed, lost fails them, none skips all (MUTATION: swap kept and lost)", () => {
    expect(storedCounts("kept", 3, 5)).toEqual({ passed: 3, failed: 0, skipped: 2, total: 5 });
    expect(storedCounts("lost", 3, 5)).toEqual({ passed: 0, failed: 3, skipped: 2, total: 5 });
    expect(storedCounts("none", 3, 5)).toEqual({ passed: 0, failed: 0, skipped: 5, total: 5 });
  });

  test("over every vector of a completed table, the entries sum to the reconciled counts with stored kept, validate and keep the writer's rules (MUTATION: stored passed for every row)", () => {
    let checked = 0;
    for (const v of VECTORS.vectors) {
      // A killed run's unwritten recordings have no row and no entry; only a run whose rows are its total.
      if (v.total !== v.rows.length) continue;
      const recipe = v.recipe === "nemar-floor" ? floor : ica;
      const declared = declaredCheckpoints(recipe);
      const sums: Record<
        string,
        { passed: number; failed: number; skipped: number; total: number }
      > = Object.fromEntries(
        declared.map((d) => [d, { passed: 0, failed: 0, skipped: 0, total: 0 }]),
      );
      for (const r of v.rows) {
        const entry = processingRecordEntry({
          recipeVersion: recipe.version,
          checkpoints: recipe.checkpoints,
          row: r,
        });
        expect([v.name, r.path, processingRecordProblem(entry, declared)]).toEqual([
          v.name,
          r.path,
          null,
        ]);
        const doc = { level: "record", recipes: { [recipe.name]: entry } };
        if (!nscProcessing(doc)) throw new Error(`${r.path}: ${formatAjvErrors(nscProcessing)}`);
        for (const d of declared) {
          sums[d][entry.checkpoints[d].status] += 1;
          sums[d].total += 1;
        }
        checked++;
      }
      const counts = countRecordings(v.rows, recipe.checkpoints);
      const last = counts[recipe.checkpoints[recipe.checkpoints.length - 1].checkpoint];
      expect([v.name, sums]).toEqual([
        v.name,
        { ...counts, stored: storedCounts("kept", last.passed, last.total) },
      ]);
    }
    expect(checked).toBeGreaterThan(10);
  });

  test("a recording that did not pass carries its first code and step to stored; one that passed is stored", () => {
    const failed = processingRecordEntry({
      recipeVersion: floor.version,
      checkpoints: F,
      row: row("b.set", "failed", "step_failed", "bad_channels"),
    });
    expect(failed.checkpoints).toEqual({
      import: { status: "passed", code: null, step: null },
      preprocess: { status: "failed", code: "step_failed", step: "bad_channels" },
      quality: { status: "skipped", code: "step_failed", step: "bad_channels" },
      stored: { status: "skipped", code: "step_failed", step: "bad_channels" },
    });
    const plugin = processingRecordEntry({
      recipeVersion: ica.version,
      checkpoints: I,
      row: row("i.set", "succeeded", null, null, [
        { step: "nemar-quality", code: "plugin_failed" },
      ]),
    });
    expect(plugin.checkpoints.quality).toEqual({
      status: "skipped",
      code: "plugin_failed",
      step: "nemar-quality",
    });
    expect(plugin.checkpoints.stored).toEqual(plugin.checkpoints.quality);
    const passed = processingRecordEntry({
      recipeVersion: floor.version,
      checkpoints: F,
      row: row("a.set", "succeeded", null, null),
    });
    expect(Object.values(passed.checkpoints).every((o) => o.status === "passed")).toBe(true);
  });

  test("processingRecordProblem: the declared keys in order, and the cascade (MUTATION: drop the code comparison)", () => {
    const declared = declaredCheckpoints(floor);
    const ok = processingRecordEntry({
      recipeVersion: floor.version,
      checkpoints: F,
      row: row("b.set", "failed", "load_failed", "load"),
    });
    expect(processingRecordProblem(ok, declared)).toBeNull();
    const { stored, ...noStored } = ok.checkpoints;
    expect(processingRecordProblem({ ...ok, checkpoints: noStored }, declared)).toBe("keys_differ");
    expect(processingRecordProblem({ ...ok, checkpoints: { stored, ...noStored } }, declared)).toBe(
      "keys_differ",
    );
    const passedAfter = {
      ...ok,
      checkpoints: {
        ...ok.checkpoints,
        quality: { status: "passed" as const, code: null, step: null },
      },
    };
    expect(processingRecordProblem(passedAfter, declared)).toBe("cascade_broken");
    const otherCode = {
      ...ok,
      checkpoints: {
        ...ok.checkpoints,
        stored: { status: "skipped" as const, code: "other_code", step: "load" },
      },
    };
    expect(processingRecordProblem(otherCode, declared)).toBe("cascade_broken");
    const otherStep = {
      ...ok,
      checkpoints: {
        ...ok.checkpoints,
        stored: { status: "skipped" as const, code: "load_failed", step: null },
      },
    };
    expect(processingRecordProblem(otherStep, declared)).toBe("cascade_broken");
  });

  test("a recording's completed link takes neuroschema's relativeLocation, Unicode included, and validates", () => {
    const location = "sub-01/eeg/sub-01_tâche_desc-nemarfloor_signalJourney.json";
    const link = signalJourneyLink({
      recipeVersion: floor.version,
      status: "completed",
      location,
      sha256: "a".repeat(64),
      sjVersion: "0.1.0",
    });
    expect(link?.location).toBe(location);
    if (!nscSignalJourney({ recipes: { "nemar-floor": link } })) {
      throw new Error(formatAjvErrors(nscSignalJourney));
    }
    const long = `${"a/".repeat(511)}x.json`;
    expect([...long].length).toBeGreaterThan(1024);
    expect(
      signalJourneyLink({
        recipeVersion: floor.version,
        status: "completed",
        location: long,
        sha256: "a".repeat(64),
        sjVersion: "0.1.0",
      }),
    ).toBeNull();
  });

  test("the one-row reader reads every line exactly as the whole-table reader does", () => {
    const text = [
      "path\tstatus\tcode\tstep\tskipped_steps",
      "sub-01/eeg/a.set\tsucceeded\tn/a\tn/a\tnemar-quality:plugin_failed",
      "sub-02/eeg/b.edf\tfailed\tload_failed\tload\tn/a",
      "sub-05/eeg/e.bdf\tskipped\tunsupported_format\tn/a\tn/a",
    ].join("\n");
    const whole = parseRecordingsTable(text);
    if (!whole.ok) throw new Error(whole.reason);
    const lines = text.split("\n");
    const head = readRecordingsHeader(lines[0]);
    if (!head.ok) throw new Error(head.reason);
    expect(lines.slice(1).map((l) => readRecordingsRow(l, head.header))).toEqual(
      whole.rows.map((r) => ({ ok: true, row: r })),
    );
    expect(readRecordingsHeader("path\tstatus\tcode")).toEqual({
      ok: false,
      reason: "missing_column",
    });
    expect(readRecordingsRow("a\tsucceeded", head.header)).toEqual({
      ok: false,
      reason: "row_width",
    });
  });
});

describe("pipelineCellMark: what a grid cell shows", () => {
  const c = (passed: number, failed: number, skipped: number, total: number) => ({
    passed,
    failed,
    skipped,
    total,
  });
  const mark = (
    status: PipelineGridStatus,
    counts: ReturnType<typeof c> | null,
    cellReconciled = false,
    runReconciled = false,
  ) => pipelineCellMark({ status, counts, cellReconciled, runReconciled });

  test("the precedence table", () => {
    const table: [
      PipelineGridStatus,
      ReturnType<typeof c> | null,
      boolean,
      boolean,
      PipelineCellMark,
    ][] = [
      // 1. no run
      ["not_started", c(3, 0, 0, 3), true, true, "not_started"],
      ["not_started", null, false, false, "not_started"],
      // 2. a complete cell, live or ended
      ["running", c(3, 0, 0, 3), false, false, "passed"],
      ["running", c(1, 1, 1, 3), false, false, "failed"],
      ["running", c(2, 0, 1, 3), false, false, "skipped"],
      ["finished", c(3, 0, 0, 3), true, true, "passed"],
      ["finished", c(0, 0, 3, 3), true, true, "skipped"],
      ["failed", c(2, 1, 0, 3), true, true, "failed"],
      // a zero total is complete only once the run has ended
      ["running", c(0, 0, 0, 0), false, false, "running"],
      ["finished", c(0, 0, 0, 0), true, true, "passed"],
      // 3. an incomplete or missing cell of a live run: the run's status
      ["waiting", null, false, false, "waiting"],
      ["running", c(1, 0, 0, 3), false, false, "running"],
      ["stalled", c(1, 1, 0, 3), false, false, "stalled"],
      // 4. an incomplete or missing cell of an ended run
      ["finished", c(0, 0, 0, 3), false, true, "pending"], // `stored` waiting for the derivative store
      ["finished", null, false, false, "pending"], // the sync has not reached the run
      ["failed", c(1, 0, 0, 3), true, false, "pending"],
      ["finished", null, false, true, "no_counts"], // an outcome without counts
      ["failed", c(1, 0, 0, 3), true, true, "no_counts"],
    ];
    for (const [status, counts, cellReconciled, runReconciled, want] of table) {
      expect([
        status,
        counts,
        cellReconciled,
        runReconciled,
        mark(status, counts, cellReconciled, runReconciled),
      ]).toEqual([status, counts, cellReconciled, runReconciled, want]);
    }
  });

  test("a run that ended with no job has its outcome: its cells have no counts, never pending (MUTATION: ignore hasJob)", () => {
    const jobless = (counts: ReturnType<typeof c> | null) =>
      pipelineCellMark({
        status: "failed",
        counts,
        cellReconciled: false,
        runReconciled: false,
        hasJob: false,
      });
    expect(jobless(null)).toBe("no_counts");
    // With a job, the same unreconciled run waits for the sync.
    expect(mark("failed", null, false, false)).toBe("pending");
    // hasJob says nothing about a live run, which shows its status.
    expect(
      pipelineCellMark({
        status: "waiting",
        counts: null,
        cellReconciled: false,
        runReconciled: false,
        hasJob: false,
      }),
    ).toBe("waiting");
  });

  test("failed wins over passed and skipped in a complete cell", () => {
    expect(mark("finished", c(5, 1, 0, 6), true, true)).toBe("failed");
    expect(mark("finished", c(0, 1, 5, 6), true, true)).toBe("failed");
  });

  test("every word the mark can give is a declared mark, and every declared mark is given", () => {
    const seen = new Set<string>();
    const statuses: PipelineGridStatus[] = [
      "not_started",
      "waiting",
      "running",
      "stalled",
      "finished",
      "failed",
    ];
    for (const status of statuses) {
      for (const counts of [
        null,
        c(0, 0, 0, 0),
        c(1, 0, 0, 1),
        c(0, 1, 0, 1),
        c(0, 0, 1, 1),
        c(0, 0, 0, 1),
      ]) {
        for (const cellReconciled of [false, true]) {
          for (const runReconciled of [false, true]) {
            seen.add(mark(status, counts, cellReconciled, runReconciled));
          }
        }
      }
    }
    expect([...seen].sort()).toEqual([...PIPELINE_CELL_MARKS].sort());
  });
});
