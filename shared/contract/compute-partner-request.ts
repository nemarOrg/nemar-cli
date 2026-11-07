/**
 * The REQUESTS of the partner contract (epic #2021 phase D4, #2025; ADR 0118, the amendment of this
 * phase; ADR 0119, the addendum): `POST /compute/holds` and `POST /compute/jobs/:id/report`. Strict ON
 * PURPOSE, like the job specification: the Worker validates them as they come IN, and a mistyped key must
 * be refused rather than stripped from the record (a hold body is also kept byte for byte as the job's
 * `spec.json`). No released command-line interface parses one as a response. Every RESPONSE of these
 * routes is open and lives in `./compute-partner.ts`, which imports nothing strict
 * (`test/contract-schemas.test.ts` lists this file in `STRICT_BY_DESIGN` and holds the other files to it).
 */

import { z } from "zod";
import { COMPUTE_KINDS } from "../compute-state.js";
import { COMPUTE_SHA256_RE, PARTITIONS, PARTITION_NAMES, computeSafeInt } from "./compute.js";

/** The most bytes of a hold body: nine small fields. */
export const COMPUTE_HOLD_BODY_MAX_BYTES = 8192;

/**
 * What a partner's hold says (`POST /compute/holds`): the application and its version, the kind and the
 * resources per node. A GPU partition needs a GPU and a CPU partition takes none.
 */
export const ComputeHoldRequestSchema = z
  .object({
    app_id: z.string().regex(/^[A-Za-z0-9._-]{1,80}$/),
    app_version: z.string().regex(/^[A-Za-z0-9._+-]{1,64}$/),
    kind: z.enum(COMPUTE_KINDS),
    partition: z.enum(PARTITION_NAMES),
    nodes: computeSafeInt(1, 64),
    cores: computeSafeInt(0, 256),
    memory_mb: computeSafeInt(1, 16_777_216).nullish(),
    gpus: computeSafeInt(0, 8),
    minutes: computeSafeInt(1, 10080),
  })
  .strict()
  .superRefine((body, ctx) => {
    const gpuPool = PARTITIONS[body.partition].pool === "gpu";
    if (gpuPool && body.gpus < 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["gpus"],
        message: "a GPU partition needs a GPU",
      });
    }
    if (!gpuPool && body.gpus !== 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["gpus"],
        message: "a CPU partition takes no GPU",
      });
    }
  });

export type ComputeHoldRequest = z.infer<typeof ComputeHoldRequestSchema>;

/** The most files one report may declare: one `CopyObject` each, and a Worker may make 1,000 subrequests. */
export const COMPUTE_REPORT_FILES_MAX = 500;

/** The longest path of a declared file, in characters (the contract's output path). */
export const COMPUTE_REPORT_PATH_MAX = 512;

/** One file the partner uploads for the record. Closed: a typo is refused, not dropped. */
export const ComputeReportFileSchema = z
  .object({
    path: z.string().min(1).max(COMPUTE_REPORT_PATH_MAX),
    size: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    sha256: z.string().regex(COMPUTE_SHA256_RE),
  })
  .strict();

export type ComputeReportFile = z.infer<typeof ComputeReportFileSchema>;

/** A Tapis job id as the contract takes it: what Tapis uses, 1 to 128 characters. */
export const COMPUTE_TAPIS_JOB_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * `POST /compute/jobs/:id/report`: the Tapis job the partner launched under the reservation, and
 * optionally the files it uploads for the person's record. `files` is at most
 * {@link COMPUTE_REPORT_FILES_MAX} entries; each is addressed by the Worker (`incoming/<id>/<path>`), and
 * copied into the record only after the report is verified.
 */
export const ComputeReportRequestSchema = z
  .object({
    tapis_job_id: z.string().regex(COMPUTE_TAPIS_JOB_ID_RE),
    files: z.array(ComputeReportFileSchema).min(1).max(COMPUTE_REPORT_FILES_MAX).optional(),
  })
  .strict();

export type ComputeReportRequest = z.infer<typeof ComputeReportRequestSchema>;

/** The most bytes of a report body: 500 entries of a 512-character path (four bytes each), a size and a digest. */
export const COMPUTE_REPORT_BODY_MAX_BYTES = COMPUTE_REPORT_FILES_MAX * 2400 + 4096;
