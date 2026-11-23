/**
 * The results report, `nemar.results-report.v1` (ADR 0134 decision 8, epic #2324 phase 6): what the
 * launcher's standalone entry writes at `<out>/launcher/results-report.json` after a job ran on a
 * person's own machine, with no NEMAR service involved. It says what ran, on what, what came out and,
 * when the job wrote a recipe progress file (`./compute-recipe-progress.ts`), the checkpoint counts of
 * its recordings by the same rules the backend reconciles a run with (`../compute-checkpoints.ts`).
 *
 * THE JSON SCHEMA NEXT TO THIS FILE (`compute-results-report.schema.json`) IS COPIED BYTE FOR BYTE BY
 * `nemarOrg/nemar-process` (`launcher/schema/compute-results-report.v1.json`), whose launcher validates
 * the report against it before it writes it. `test/compute-results-report-contract.unit.test.ts` holds
 * the two to each other, and holds the definitions it shares with other schemas equal to them: a
 * checkpoint's counts and a failure item are the live progress object's (`./compute-progress.ts`),
 * arranged here per checkpoint, the checkpoint map is the recipe progress file's, and `result` is the
 * launcher's `result.json` (`LauncherResultSchema`).
 *
 * Paths are relative to the job's output directory; no host path is ever in the report. A problem the
 * launcher met while building the report is a fixed word inside it, never a change of the job's exit.
 * Rules no schema can state (zod enforces them): input names and launcher file names are unique; the
 * run finished no earlier than it started; the `@sha256:<hex>` the image reference ends with is
 * `image.digest`; and in `checkpoints`, `counts` and `failures` each name exactly the map's checkpoints,
 * each failure is listed under its own checkpoint, and the counts and failures hold together by the
 * live progress object's rules (`progressProblem` in `../compute-checkpoints.ts`).
 *
 * It is closed at every level: the launcher writes it and a mistyped key is a bug. Like
 * `./compute-progress.ts`, this file is exempted by name in `test/contract-schemas.test.ts`.
 *
 * Nothing here reads a clock, a database or a network.
 */

import { z } from "zod";
import { progressProblem } from "../compute-checkpoints.js";
import { LOCAL_DATASET_NAME_RE, LOCAL_LAUNCH_MAX_DATASETS } from "./compute-local-launch.js";
import {
  PROGRESS_CHECKPOINT_RE,
  PROGRESS_FAILURE_CODE_RE,
  PROGRESS_FORMAT,
  PROGRESS_MAX_CHECKPOINTS,
  PROGRESS_MAX_FAILURES,
  PROGRESS_MAX_RECORDINGS,
  type ProgressCheckpointCounts,
  ProgressCheckpointCountsSchema,
  type ProgressFailure,
  ProgressFailureSchema,
} from "./compute-progress.js";
import {
  RECIPE_PROGRESS_RECIPE_ID_RE,
  RECIPE_PROGRESS_TABLE_RE,
  RECIPE_PROGRESS_VERSION_RE,
  RecipeCheckpointMapSchema,
} from "./compute-recipe-progress.js";
import {
  COMPUTE_IMAGE_DIGEST_RE,
  COMPUTE_IMAGE_REF_RE,
  COMPUTE_MAX_OUTPUT_FILES,
  COMPUTE_SHA256_RE,
  LauncherResultSchema,
  computePathSchema,
} from "./compute.js";

/** The format word of the results report; a later version is refused by name. */
export const RESULTS_REPORT_FORMAT = "nemar.results-report.v1";

/** The report's file name in the launcher directory. */
export const RESULTS_REPORT_FILE = "results-report.json";

/** The modes a report can come from. Only standalone writes one in this version. */
export const RESULTS_REPORT_MODES = ["standalone"] as const;

/** The launcher files the report lists, with their digests. */
export const RESULTS_REPORT_LAUNCHER_FILES = [
  "result.json",
  "provenance.json",
  "manifest.json",
  "progress.json",
] as const;

/** The most recordings tables one report lists. */
export const RESULTS_REPORT_MAX_TABLES = 64;

/** A run id: 32 lowercase hex digits, random for each run. */
export const RESULTS_REPORT_RUN_ID_RE = /^[0-9a-f]{32}$/;

/** A time in UTC, to the second: `YYYY-MM-DDTHH:MM:SSZ`. */
export const RESULTS_REPORT_UTC_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/;

/** How a pulled image was verified. */
export const RESULTS_REPORT_VERIFIERS = ["cosign"] as const;

/** What was verified: the container image, or the Singularity image file published beside it. */
export const RESULTS_REPORT_VERIFIED_KINDS = ["image", "sif"] as const;

/** Where a signalJourney record sits: beside a recordings table (the dataset's) or a recording's. */
export const RESULTS_REPORT_RECORD_LEVELS = ["dataset", "recording"] as const;

const sha256 = z.string().regex(COMPUTE_SHA256_RE);
const size = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const count = z.number().int().min(0).max(PROGRESS_MAX_RECORDINGS);
const word = z.string().regex(PROGRESS_FAILURE_CODE_RE);
const outputPath = computePathSchema(512);
const version = z.string().regex(RECIPE_PROGRESS_VERSION_RE);

/** How the image was verified, when the run pulled it (`--pull`); null when it did not. */
export const ResultsReportVerificationSchema = z
  .object({
    by: z.enum(RESULTS_REPORT_VERIFIERS),
    kind: z.enum(RESULTS_REPORT_VERIFIED_KINDS),
    cosign_version: version,
    sif_manifest: z.string().regex(COMPUTE_IMAGE_DIGEST_RE).optional(),
    sif_layer: z.string().regex(COMPUTE_IMAGE_DIGEST_RE).optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    const has = v.sif_manifest !== undefined || v.sif_layer !== undefined;
    const both = v.sif_manifest !== undefined && v.sif_layer !== undefined;
    if (v.kind === "sif" ? !both : has) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["kind"],
        message: "a sif verification names its manifest and layer, an image one names neither",
      });
    }
  });

/** One recordings table the job wrote, read by the launcher from outside the container. */
export const ResultsReportTableSchema = z
  .object({
    path: outputPath,
    sha256,
    size,
    rows: count,
    succeeded: count,
    failed: count,
    skipped: count,
    problem: word.nullable(),
  })
  .strict();

const checkpointCount = (o: object) => Object.keys(o).length;

/**
 * The checkpoint counts of the job's recordings, by the backend's reconcile rules. Rules no schema can
 * state: `counts` and `failures` each name exactly the map's checkpoints; each failure's `checkpoint` is
 * the key it is listed under; and the counts and failures hold together by the live progress object's
 * rules (`progressProblem` in `../compute-checkpoints.ts`: no column counts more than its total, every
 * column has the same total, and no checkpoint lists more failures than it counts as failed or skipped).
 */
export const ResultsReportCheckpointsSchema = z
  .object({
    recipe: z
      .object({
        id: z.string().regex(RECIPE_PROGRESS_RECIPE_ID_RE),
        version,
      })
      .strict(),
    table: z.string().regex(RECIPE_PROGRESS_TABLE_RE),
    map: RecipeCheckpointMapSchema,
    counts: z
      .record(z.string().regex(PROGRESS_CHECKPOINT_RE), ProgressCheckpointCountsSchema)
      .refine((o) => {
        const n = checkpointCount(o);
        return n >= 1 && n <= PROGRESS_MAX_CHECKPOINTS;
      }, `counts holds 1 to ${PROGRESS_MAX_CHECKPOINTS} checkpoints`),
    failures: z
      .record(
        z.string().regex(PROGRESS_CHECKPOINT_RE),
        z.array(ProgressFailureSchema).max(PROGRESS_MAX_FAILURES),
      )
      .refine(
        (o) => checkpointCount(o) <= PROGRESS_MAX_CHECKPOINTS,
        `failures holds at most ${PROGRESS_MAX_CHECKPOINTS} checkpoints`,
      ),
  })
  .strict()
  .superRefine((c, ctx) => refineResultsCheckpoints(c, ctx));

/**
 * The rules of the checkpoints block no schema can state (see {@link ResultsReportCheckpointsSchema}).
 * Zod runs it only on a block whose fields parsed; it is exported so its guards can be tested alone.
 */
export function refineResultsCheckpoints(
  c: {
    map: readonly { checkpoint: string }[];
    counts: Record<string, ProgressCheckpointCounts>;
    failures: Record<string, ProgressFailure[]>;
  },
  ctx: z.RefinementCtx,
): void {
  const refuse = (path: (string | number)[], message: string) =>
    ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });
  const declared = c.map.map((m) => m.checkpoint);
  const keys = Object.keys(c.failures);
  if (keys.length !== declared.length || !declared.every((d) => keys.includes(d))) {
    refuse(["failures"], "failures names exactly the map's checkpoints");
  }
  for (const [key, list] of Object.entries(c.failures)) {
    list.forEach((f, i) => {
      // A failure naming a checkpoint the map lacks is progressProblem's (failure_checkpoint_differs).
      if (f.checkpoint !== key && declared.includes(f.checkpoint)) {
        refuse(["failures", key, i, "checkpoint"], "a failure is listed under its checkpoint");
      }
    });
  }
  // The live progress object's rules, read over the same counts and the failures in one list: the
  // counts name exactly the map's checkpoints (checkpoints_differ) and hold together. An empty map is
  // the map's own issue, so the rules are not read over it.
  if (declared.length === 0) return;
  const problem = progressProblem(
    {
      format: PROGRESS_FORMAT,
      checkpoint: declared[0],
      counts: c.counts,
      failures: Object.values(c.failures).flat(),
    },
    c.map,
  );
  if (problem !== null) refuse(["counts"], `the counts do not hold together: ${problem}`);
}

/** The results report. */
export const ResultsReportSchema = z
  .object({
    format: z.literal(RESULTS_REPORT_FORMAT),
    mode: z.enum(RESULTS_REPORT_MODES),
    run_id: z.string().regex(RESULTS_REPORT_RUN_ID_RE),
    started_utc: z.string().regex(RESULTS_REPORT_UTC_RE),
    finished_utc: z.string().regex(RESULTS_REPORT_UTC_RE),
    launcher_version: version,
    specification: z.object({ sha256 }).strict(),
    image: z
      .object({
        uri: z.string().max(512).regex(COMPUTE_IMAGE_REF_RE),
        digest: z.string().regex(COMPUTE_IMAGE_DIGEST_RE),
        verification: ResultsReportVerificationSchema.nullable(),
      })
      .strict(),
    bundle_sha256: sha256.nullable(),
    inputs: z
      .array(
        z
          .object({ name: z.string().regex(LOCAL_DATASET_NAME_RE), files: size, bytes: size })
          .strict(),
      )
      .max(LOCAL_LAUNCH_MAX_DATASETS),
    result: LauncherResultSchema,
    launcher_files: z
      .array(z.object({ name: z.enum(RESULTS_REPORT_LAUNCHER_FILES), sha256, size }).strict())
      .max(RESULTS_REPORT_LAUNCHER_FILES.length),
    outputs: z
      .object({
        files: z.number().int().min(0).max(COMPUTE_MAX_OUTPUT_FILES),
        bytes: size,
        manifest_sha256: sha256,
      })
      .strict(),
    tables: z.array(ResultsReportTableSchema).max(RESULTS_REPORT_MAX_TABLES),
    checkpoints: ResultsReportCheckpointsSchema.nullable(),
    checkpoints_reason: word.nullable(),
    records: z
      .array(
        z
          .object({ path: outputPath, sha256, size, level: z.enum(RESULTS_REPORT_RECORD_LEVELS) })
          .strict(),
      )
      .max(COMPUTE_MAX_OUTPUT_FILES),
  })
  .strict()
  .superRefine((report, ctx) => refineResultsReport(report, ctx));

/**
 * The rules of the report no schema can state (see the module's docblock). Zod runs it only on a report
 * whose fields parsed; it is exported so its guards can be tested alone.
 */
export function refineResultsReport(
  report: {
    checkpoints: unknown;
    checkpoints_reason: string | null;
    inputs: readonly { name: string }[];
    launcher_files: readonly { name: string }[];
    image: { uri: string; digest: string };
    started_utc: string;
    finished_utc: string;
  },
  ctx: z.RefinementCtx,
): void {
  const refuse = (path: (string | number)[], message: string) =>
    ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });
  if ((report.checkpoints === null) === (report.checkpoints_reason === null)) {
    refuse(["checkpoints_reason"], "a reason exactly when there are no checkpoint counts");
  }
  const unique = (names: string[], path: string) => {
    const seen = new Set<string>();
    names.forEach((n, i) => {
      if (seen.has(n)) refuse([path, i, "name"], "a name is listed twice");
      seen.add(n);
    });
  };
  unique(
    report.inputs.map((i) => i.name),
    "inputs",
  );
  unique(
    report.launcher_files.map((f) => f.name),
    "launcher_files",
  );
  // Only when both fields are well formed, as in refineRunnable, so a field issue is not doubled.
  if (
    COMPUTE_IMAGE_DIGEST_RE.test(report.image.digest) &&
    COMPUTE_IMAGE_REF_RE.test(report.image.uri) &&
    !report.image.uri.endsWith(report.image.digest)
  ) {
    refuse(["image", "uri"], "the image reference is not pinned to the image digest");
  }
  if (report.finished_utc < report.started_utc) {
    refuse(["finished_utc"], "the run finished no earlier than it started");
  }
}

export type ResultsReportVerification = z.infer<typeof ResultsReportVerificationSchema>;
export type ResultsReportTable = z.infer<typeof ResultsReportTableSchema>;
export type ResultsReportCheckpoints = z.infer<typeof ResultsReportCheckpointsSchema>;
export type ResultsReport = z.infer<typeof ResultsReportSchema>;
