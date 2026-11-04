/**
 * The launch specification `nemar.launch-spec.v1` and the launcher's routes (epic #2005 phase A1,
 * #2006; ADR 0118): the one document NEMAR's Worker hands the launcher on the node, in the
 * environment variable `NEMAR_LAUNCH_SPEC`, and the three shapes the launcher exchanges with the
 * Worker, distinct from the user-facing job specification in `./compute.ts`.
 *
 * THE JSON SCHEMA NEXT TO THIS FILE IS SHARED BYTE FOR BYTE with `nemarOrg/nemar-process`
 * (`launcher/schema/launch-spec.v1.json`), where the launcher is written. The launcher cannot
 * import this file, so `compute-launch.schema.json` is the contract both sides check against, and
 * `test/compute-contract.unit.test.ts` holds the two to each other: the schema's keys and
 * enumerations are read back against these constants, and a differential corpus is judged by both.
 * Whichever repository's phase merges first writes the file; the other copies it, never edits it.
 *
 * Like `./compute.ts`, this file is strict on purpose and exempted by name in
 * `test/contract-schemas.test.ts`: the Worker writes the launch specification, nothing parses it
 * as a response, and an unknown key is a bug to refuse rather than strip.
 *
 * What the launch specification does NOT carry, on purpose: a URL for the code bundle (the
 * launcher asks the Worker for a presigned address with `job_token`), any storage credential, and
 * the user's identity. The token travels in a header, never a URL.
 *
 * On the node, under Tapis's output directory: the container's one writable mount is `work/`, with
 * its outputs in `work/outputs/<path>`; the directory `launcher/` is never mounted into it and
 * holds `result.json`, `provenance.json`, `manifest.json` and `launcher.log`. In the results
 * bucket the launcher uploads, by presigned URL, to `jobs/<id>/outputs/<path>` and to
 * `jobs/<id>/launcher/<file>`. Exit numbers: 0, and 10 to 16 for the seven launcher failure codes
 * of `shared/compute-state.ts` in their order.
 */

import { z } from "zod";
import {
  COMPUTE_DATASET_ID_RE,
  COMPUTE_DATASET_VERSION_RE,
  COMPUTE_DOT_SEGMENT_RE,
  COMPUTE_IMAGE_DIGEST_RE,
  COMPUTE_JOB_ID_RE,
  COMPUTE_SHA256_RE,
  JOB_ENV_ALLOWLIST,
  LAUNCHER_FILE_NAMES,
  type LauncherFileName,
  computeEnvValueSchema,
  computeGlobSchema,
  computePathSchema,
  computeSafeInt,
  isSafeComputePath,
} from "./compute.js";

/** The name of the schema, and of the document's contract. */
export const LAUNCH_SPEC_VERSION = "nemar.launch-spec.v1";

/** The launcher reads at most this many bytes of the specification. */
export const LAUNCH_SPEC_MAX_BYTES = 64 * 1024;

/**
 * `python` runs NEMAR's runtime image and `image` runs the submitter's own. MATLAB is refused
 * before a launch specification is built; a document that names it is outside this schema, which
 * the launcher reports as `runtime_error` with the detail `unsupported_runtime`.
 */
export const LAUNCH_RUNTIMES = ["python", "image"] as const;

const safeInt = computeSafeInt;
const relativePath = computePathSchema;

const API_BASE_RE = /^https?:\/\/[^\s/?#][^\s?#]*$/;
const URL_RE = /^https?:\/\/[^\s]+$/;
const JOB_TOKEN_RE = /^[A-Za-z0-9_-]{16,256}$/;
const SIF_RE = /^[A-Za-z0-9._/+-]{1,256}$/;
const IMAGE_URI_RE = /^[^\s]{1,512}$/;
/** UTC, as the presigning calls write it; the shape is checked, not the calendar. */
const TIMESTAMP_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)?Z$/;
/** Where an upload goes under `jobs/<id>/`: an output, or one of the four launcher files. */
const UPLOAD_PATH_RE = new RegExp(
  `^(?:outputs/(?:[^/\\\\\\u0000-\\u001f\\u007f]+/)*[^/\\\\\\u0000-\\u001f\\u007f]+|launcher/(?:${LAUNCHER_FILE_NAMES.map(
    (n) => n.replace(".", "\\."),
  ).join("|")}))$`,
);

const launchEnvSchema = z
  .object(
    Object.fromEntries(
      JOB_ENV_ALLOWLIST.map((name) => [name, computeEnvValueSchema.optional()]),
    ) as {
      [K in (typeof JOB_ENV_ALLOWLIST)[number]]: z.ZodOptional<typeof computeEnvValueSchema>;
    },
  )
  .strict();

/**
 * The launch specification. Every key but `entry`, `command` and `bundle` is required, so the
 * Worker writes an explicit document and the launcher never has to guess a default; exactly one of
 * `entry` and `command` is present, and an `entry` comes with the `bundle` that holds it. No
 * unknown key is accepted, at any level.
 */
export const LaunchSpecSchema = z
  .object({
    /** The NEMAR job id, which is also the prefix of the job's keys. */
    job_id: z.string().regex(COMPUTE_JOB_ID_RE),
    runtime: z.enum(LAUNCH_RUNTIMES),
    /** A path inside the bundle. */
    entry: relativePath(240).optional(),
    /** An argument vector for an image job, run as given. */
    command: z.array(z.string().min(1).max(1024)).min(1).max(64).optional(),
    args: z.array(z.string().max(1024)).max(64),
    /** The archive's own digest and size; the launcher is given no URL and asks the Worker. */
    bundle: z
      .object({ sha256: z.string().regex(COMPUTE_SHA256_RE), size: safeInt(1) })
      .strict()
      .optional(),
    datasets: z
      .array(
        z
          .object({
            id: z.string().regex(COMPUTE_DATASET_ID_RE),
            version: z.string().regex(COMPUTE_DATASET_VERSION_RE),
            include: z.array(computeGlobSchema).max(64).optional(),
          })
          .strict(),
      )
      .max(20),
    /** The NEMAR API the launcher calls with `job_token`: no query, no fragment. */
    api_base: z.string().max(512).regex(API_BASE_RE),
    image: z
      .object({
        uri: z.string().regex(IMAGE_URI_RE),
        digest: z.string().regex(COMPUTE_IMAGE_DIGEST_RE),
        /** The Singularity image file on the node that the launcher runs. */
        sif: z.string().regex(SIF_RE),
      })
      .strict(),
    env: launchEnvSchema,
    resources: z.object({ gpus: safeInt(0, 8) }).strict(),
    limits: z.object({ max_files: safeInt(1, 1_000_000), max_total_bytes: safeInt(1) }).strict(),
    /** The per-job token, sent in `X-Compute-Job-Token` to the bundle, outputs and complete routes. */
    job_token: z.string().regex(JOB_TOKEN_RE),
  })
  .strict()
  .superRefine((spec, ctx) => {
    const refuse = (path: string, message: string) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
    if ((spec.entry === undefined) === (spec.command === undefined)) {
      refuse("entry", "exactly one of entry and command");
    }
    if (spec.entry !== undefined && spec.bundle === undefined) {
      refuse("bundle", "an entry needs the bundle that holds it");
    }
  });

export type LaunchSpec = z.infer<typeof LaunchSpecSchema>;

/**
 * Every UTF-16 code unit at or above U+007F as a lowercase `\uXXXX` escape. JSON allows non-ASCII
 * only inside strings, so the result is the same document in plain ASCII; a character outside the
 * Basic Multilingual Plane becomes its two surrogate escapes.
 */
function asciiOnly(json: string): string {
  return json.replace(/[\u007f-\uffff]/g, (c) => {
    return `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`;
  });
}

/**
 * The text for `NEMAR_LAUNCH_SPEC`: the specification validated, as ASCII-only JSON (see
 * `asciiOnly`), within 64 KiB. The size is checked AFTER escaping, because that is what the
 * launcher reads and the digest covers; a non-ASCII character costs six bytes. Keys follow the
 * schema's order and there is no whitespace, so one document is one text. Throws TypeError (naming
 * the failing keys, never a value, since the document holds a token) for a document that is not
 * valid and RangeError for one over the size the launcher reads.
 */
export function encodeLaunchSpec(spec: unknown): string {
  const parsed = LaunchSpecSchema.safeParse(spec);
  if (!parsed.success) {
    const keys = [...new Set(parsed.error.issues.map((i) => i.path.join(".") || "(document)"))];
    throw new TypeError(`not a valid launch specification: ${keys.join(", ")}`);
  }
  const text = asciiOnly(JSON.stringify(parsed.data));
  if (text.length > LAUNCH_SPEC_MAX_BYTES) {
    throw new RangeError("the launch specification is over 64 KiB");
  }
  return text;
}

// --- The routes the launcher calls -------------------------------------------------------------

const urlSchema = z.string().max(4096).regex(URL_RE);
const timestampSchema = z.string().regex(TIMESTAMP_RE);

/** `POST <api_base>/compute/jobs/<id>/bundle`: a short-lived presigned GET of the job's archive. */
export const BundleResponseSchema = z
  .object({ url: urlSchema, expires_at: timestampSchema })
  .strict();

/**
 * `POST <api_base>/compute/jobs/<id>/outputs`: every output with its size and checksum, and the
 * sizes of the four launcher files, each named once.
 */
export const OutputsRequestSchema = z
  .object({
    outputs: z
      .array(
        z
          .object({
            path: relativePath(512),
            size: safeInt(0),
            sha256: z.string().regex(COMPUTE_SHA256_RE),
          })
          .strict(),
      )
      .max(100_000),
    launcher: z
      .array(z.object({ name: z.enum(LAUNCHER_FILE_NAMES), size: safeInt(0) }).strict())
      .length(LAUNCHER_FILE_NAMES.length),
  })
  .strict()
  .superRefine((request, ctx) => {
    if (new Set(request.launcher.map((f) => f.name)).size !== LAUNCHER_FILE_NAMES.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["launcher"],
        message: "each launcher file is named once",
      });
    }
  });

/**
 * The answer: one presigned PUT address per file, for the path under `jobs/<id>/` (`outputs/...`
 * or `launcher/...`), valid until `expires_at`.
 */
export const OutputsResponseSchema = z
  .object({
    uploads: z
      .array(
        z
          .object({
            path: z
              .string()
              .max(600)
              .regex(UPLOAD_PATH_RE)
              .refine((p) => !COMPUTE_DOT_SEGMENT_RE.test(p), { message: "no . or .. segments" }),
            url: urlSchema,
          })
          .strict(),
      )
      .max(100_004),
    expires_at: timestampSchema,
  })
  .strict();

// --- Where the launcher's files live in the results bucket -------------------------------------

function assertJobId(jobId: string): void {
  if (!COMPUTE_JOB_ID_RE.test(jobId)) throw new RangeError("not a job id");
}

/** `jobs/<id>/outputs/<path>`: one output of one job. Throws for a path that could escape. */
export function resultsOutputKey(jobId: string, path: string): string {
  assertJobId(jobId);
  if (!isSafeComputePath(path, 512)) throw new RangeError("not a safe output path");
  return `jobs/${jobId}/outputs/${path}`;
}

/** `jobs/<id>/launcher/<file>`: one of the launcher's four files. */
export function resultsLauncherKey(jobId: string, name: LauncherFileName): string {
  assertJobId(jobId);
  if (!(LAUNCHER_FILE_NAMES as readonly string[]).includes(name)) {
    throw new RangeError("not a launcher file");
  }
  return `jobs/${jobId}/launcher/${name}`;
}
