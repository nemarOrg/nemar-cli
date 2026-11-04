/**
 * The compute gateway's contract (epic #2005 phase A1, #2006; ADR 0118): the job specification
 * every front door submits, the partition and rate tables that turn resources and time into
 * service units, the owner policy the gateway reads, and the shapes of the files the launcher
 * leaves on the node. Authored in zod, importing only zod and `../compute-state.js`, so the Worker,
 * the CLI and the tests read one declaration.
 *
 * MONEY IS INTEGER THOUSANDTHS OF AN EXPANSE SERVICE UNIT (SU). One SU is one core-hour with up to
 * 2 GB of memory per core, or one GPU-hour. Every `*Milli` figure and every `*_milli` column is
 * such an integer; nothing here is, or may become, a floating-point amount.
 *
 * NOTHING HERE WAS MEASURED AGAINST THE TENANT YET. The rate table, the `debug` ceilings and the
 * preempt basis below are the design's, unconfirmed with SDSC (design section 12, question 5);
 * each is marked where it is declared and stays marked until the first charge is compared with
 * Expanse's own record.
 */

import { z } from "zod";
import {
  COMPUTE_WORD_RE,
  LAUNCHER_EXIT_OK,
  LAUNCHER_FAILURE_CODES,
  launcherExitNumber,
} from "../compute-state.js";

// --- Shared patterns ---------------------------------------------------------------------------

/** The characters no path or pattern may hold: control characters and DEL, written as escapes. */
const CONTROL_CHARS = "\\u0000-\\u001f\\u007f";

/** A path segment holds no slash, backslash, control character or DEL. */
const SEGMENT = `[^/\\\\${CONTROL_CHARS}]+`;

/** A relative path of non-empty segments; `.` and `..` segments are refused separately. */
export const COMPUTE_PATH_RE = new RegExp(`^(?:${SEGMENT}/)*${SEGMENT}$`);

/** A `.` or `..` segment anywhere in a path. */
export const COMPUTE_DOT_SEGMENT_RE = /(?:^|\/)\.\.?(?:\/|$)/;

/** A glob holds no backslash, control character or DEL... */
const COMPUTE_GLOB_CHARS_RE = new RegExp(`^[^\\\\${CONTROL_CHARS}]+$`);

/** ...and stays inside its dataset: no absolute start and no `..` segment. */
const COMPUTE_GLOB_ESCAPES_RE = /^\/|(?:^|\/)\.\.(?:\/|$)/;

/** A relative path with no empty, `.` or `..` segment, no backslash and no control character. */
export function isSafeComputePath(path: string, maxLength = 512): boolean {
  return (
    typeof path === "string" &&
    path.length >= 1 &&
    path.length <= maxLength &&
    COMPUTE_PATH_RE.test(path) &&
    !COMPUTE_DOT_SEGMENT_RE.test(path)
  );
}

/** A NEMAR job id: `job_` and 24 lowercase hex digits. */
export const COMPUTE_JOB_ID_RE = /^job_[0-9a-f]{24}$/;

export const COMPUTE_SHA256_RE = /^[0-9a-f]{64}$/;
export const COMPUTE_IMAGE_DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

/** Two lowercase letters and six digits: `nm000104`, `on000001`, `xx099900`, `ds002718`. */
export const COMPUTE_DATASET_ID_RE = /^[a-z]{2}[0-9]{6}$/;
export const COMPUTE_DATASET_VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/;

const MAX_SAFE = Number.MAX_SAFE_INTEGER;

/** A whole number in [min, max], never beyond what a double holds exactly. */
export const computeSafeInt = (min: number, max: number = MAX_SAFE) =>
  z.number().int().min(min).max(max);
const safeInt = computeSafeInt;

const jobIdSchema = z.string().regex(COMPUTE_JOB_ID_RE);
const sha256Schema = z.string().regex(COMPUTE_SHA256_RE);

/** A safe relative path of at most `maxLength` characters, as `isSafeComputePath` judges it. */
export function computePathSchema(maxLength: number) {
  return z
    .string()
    .min(1)
    .max(maxLength)
    .regex(COMPUTE_PATH_RE)
    .refine((p) => !COMPUTE_DOT_SEGMENT_RE.test(p), {
      message: "a path may not hold . or .. segments",
    });
}
const relativePath = computePathSchema;

/** A dataset include pattern: at most 256 characters that never leave the dataset. */
export const computeGlobSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(COMPUTE_GLOB_CHARS_RE)
  .refine((g) => !COMPUTE_GLOB_ESCAPES_RE.test(g), {
    message: "a pattern may not leave the dataset",
  });

/** A freezing helper, so a default shared by every caller cannot be changed by one of them. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value)) deepFreeze(inner);
  }
  return value;
}

// --- Pools, partitions and the rate table ------------------------------------------------------

/** Expanse CPU and Expanse GPU are separate ACCESS resources, so each person has one pool each. */
export const COMPUTE_POOLS = ["cpu", "gpu"] as const;

export type ComputePool = (typeof COMPUTE_POOLS)[number];

export const PARTITION_NAMES = [
  "shared",
  "compute",
  "debug",
  "large-shared",
  "preempt",
  "gpu-shared",
  "gpu",
  "gpu-debug",
  "gpu-preempt",
] as const;

export type PartitionName = (typeof PARTITION_NAMES)[number];

/** What one job may ask of a partition. Whole numbers; `maxGpusPerNode` 0 means no GPU. */
export const ComputeCeilingSchema = z
  .object({
    maxNodes: safeInt(1, 64),
    maxCoresPerNode: safeInt(0, 256),
    maxGpusPerNode: safeInt(0, 8),
    maxMinutes: safeInt(1, 10080),
  })
  .strict();

export type ComputeCeiling = z.infer<typeof ComputeCeilingSchema>;

/**
 * How a partition is charged, from the design's table:
 * `core_or_memory`: per node, the larger of cores and memory over 2 GB, in core-units;
 * `whole_cpu_node`: 128 core-units per node whatever was asked for;
 * `gpu_or_memory`: per node, the larger of GPUs and memory over 92 GB, in GPU-units;
 * `whole_gpu_node`: 4 GPU-units per node whatever was asked for.
 */
export type ComputeRateKind =
  | "core_or_memory"
  | "whole_cpu_node"
  | "gpu_or_memory"
  | "whole_gpu_node";

export interface ComputePartition {
  pool: ComputePool;
  rate: ComputeRateKind;
  /** Preempt partitions are charged at 800/1000 of the rate and Expanse does not refund a preemption. */
  preempt: boolean;
  /**
   * The default per-job ceiling when the partition is offered to people, or null when it is not:
   * `large-shared` and the preempt partitions are NEMAR's pipelines only, with limits set per
   * pipeline. The owner's policy decides what is offered; a partition with a ceiling there is.
   */
  ceiling: ComputeCeiling | null;
}

/** 48 hours, the ceiling for people on every partition that is not a debug partition. */
const FORTY_EIGHT_HOURS = 2880;

/**
 * UNCONFIRMED (design section 12, question 5): the `debug` and `gpu-debug` ceilings are what the
 * design calls "as Expanse allows", 30 minutes, with node counts from Expanse's public guide; the
 * 40 cores of a GPU node are its public description. Until SDSC confirms, the owner adjusts them
 * with `policy set` and nothing depends on them being exact.
 */
export const PARTITIONS: Readonly<Record<PartitionName, ComputePartition>> = deepFreeze({
  shared: {
    pool: "cpu",
    rate: "core_or_memory",
    preempt: false,
    ceiling: { maxNodes: 1, maxCoresPerNode: 64, maxGpusPerNode: 0, maxMinutes: FORTY_EIGHT_HOURS },
  },
  compute: {
    pool: "cpu",
    rate: "whole_cpu_node",
    preempt: false,
    ceiling: {
      maxNodes: 2,
      maxCoresPerNode: 128,
      maxGpusPerNode: 0,
      maxMinutes: FORTY_EIGHT_HOURS,
    },
  },
  debug: {
    pool: "cpu",
    rate: "core_or_memory",
    preempt: false,
    ceiling: { maxNodes: 2, maxCoresPerNode: 128, maxGpusPerNode: 0, maxMinutes: 30 },
  },
  "large-shared": { pool: "cpu", rate: "core_or_memory", preempt: false, ceiling: null },
  preempt: { pool: "cpu", rate: "core_or_memory", preempt: true, ceiling: null },
  "gpu-shared": {
    pool: "gpu",
    rate: "gpu_or_memory",
    preempt: false,
    ceiling: { maxNodes: 1, maxCoresPerNode: 40, maxGpusPerNode: 3, maxMinutes: FORTY_EIGHT_HOURS },
  },
  gpu: {
    pool: "gpu",
    rate: "whole_gpu_node",
    preempt: false,
    ceiling: { maxNodes: 1, maxCoresPerNode: 40, maxGpusPerNode: 4, maxMinutes: FORTY_EIGHT_HOURS },
  },
  "gpu-debug": {
    pool: "gpu",
    rate: "gpu_or_memory",
    preempt: false,
    ceiling: { maxNodes: 1, maxCoresPerNode: 40, maxGpusPerNode: 4, maxMinutes: 30 },
  },
  "gpu-preempt": { pool: "gpu", rate: "gpu_or_memory", preempt: true, ceiling: null },
} satisfies Record<PartitionName, ComputePartition>);

/**
 * The rate table, version 1, in milli-SU. UNCONFIRMED with SDSC before the first charge (design
 * section 12, question 5): the 2048 MB per core-unit and the 94208 MB (92 GB) per GPU-unit are the
 * design's reading of Expanse's published definition, the 800/1000 preempt factor is Expanse's
 * published 0.8 and the basis it applies to (the final amount, rounded up once) is the design's,
 * and the minimum of one SU per job is Expanse's charge on reservation.
 */
export const RATE_TABLE_V1 = {
  version: 1,
  milliPerSu: 1000,
  /** Core-units a whole `compute` node is charged per hour. */
  cpuNodeCores: 128,
  /** GPU-units a whole `gpu` node is charged per hour. */
  gpuNodeGpus: 4,
  memoryMbPerCoreUnit: 2048,
  memoryMbPerGpuUnit: 94208,
  preemptNumerator: 800,
  preemptDenominator: 1000,
  minChargeMilli: 1000,
} as const;

/** What a job reserves, per node, as Tapis and the job specification both say it. */
export interface ComputeResources {
  nodes: number;
  cores?: number;
  memory_mb?: number;
  gpus?: number;
}

function wholeNumber(name: string, value: unknown, min: number): bigint {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min) {
    throw new RangeError(`${name} must be a whole number of at least ${min}`);
  }
  return BigInt(value);
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}

/**
 * What a run of `seconds` costs in milli-SU on `partition` with `resources`: the rate per hour
 * times the seconds over 3600, times 800/1000 on a preempt partition, rounded up to the next
 * thousandth ONCE, and never under the 1000 minimum (which applies to the final amount, so a
 * preempt job also pays at least one SU). Exact integer arithmetic throughout.
 *
 * Throws RangeError for a partition that is not one, a resource or a time that is not a whole
 * non-negative number (`nodes` at least 1), or an amount too large to hold exactly. A caller that
 * has Tapis's times rounds the seconds up first.
 */
export function suMilliFor(
  partition: PartitionName,
  resources: ComputeResources,
  seconds: number,
): number {
  if (!Object.hasOwn(PARTITIONS, partition)) throw new RangeError("not a partition");
  const info = PARTITIONS[partition];
  const nodes = wholeNumber("nodes", resources.nodes, 1);
  const cores = wholeNumber("cores", resources.cores ?? 0, 0);
  const memoryMb = wholeNumber("memory_mb", resources.memory_mb ?? 0, 0);
  const gpus = wholeNumber("gpus", resources.gpus ?? 0, 0);
  const secs = wholeNumber("seconds", seconds, 0);
  const t = RATE_TABLE_V1;
  const unit = BigInt(t.milliPerSu);

  let perNode: bigint;
  switch (info.rate) {
    case "core_or_memory": {
      const byCores = cores * unit;
      const byMemory = ceilDiv(memoryMb * unit, BigInt(t.memoryMbPerCoreUnit));
      perNode = byCores > byMemory ? byCores : byMemory;
      break;
    }
    case "whole_cpu_node":
      perNode = BigInt(t.cpuNodeCores) * unit;
      break;
    case "gpu_or_memory": {
      const byGpus = gpus * unit;
      const byMemory = ceilDiv(memoryMb * unit, BigInt(t.memoryMbPerGpuUnit));
      perNode = byGpus > byMemory ? byGpus : byMemory;
      break;
    }
    case "whole_gpu_node":
      perNode = BigInt(t.gpuNodeGpus) * unit;
      break;
  }

  const ratePerHour = perNode * nodes;
  const numerator = info.preempt ? BigInt(t.preemptNumerator) : 1n;
  const denominator = info.preempt ? BigInt(t.preemptDenominator) : 1n;
  const amount = ceilDiv(ratePerHour * secs * numerator, 3600n * denominator);
  const minimum = BigInt(t.minChargeMilli);
  const charged = amount < minimum ? minimum : amount;
  if (charged > BigInt(MAX_SAFE)) throw new RangeError("amount too large to hold exactly");
  return Number(charged);
}

/** The hold for a job: what it would cost if it ran for every minute it asked for. */
export function estimateSuMilli(
  spec: ComputeResources & { partition: PartitionName; minutes: number },
): number {
  const minutes = wholeNumber("minutes", spec.minutes, 0);
  return suMilliFor(spec.partition, spec, Number(minutes * 60n));
}

const SU_DECIMAL_RE = /^([0-9]+)(?:\.([0-9]{1,3}))?$/;

/**
 * Parses an amount of SU written as a plain decimal into whole milli-SU: `12.5` is 12500. At most
 * three decimals, no sign, no exponent, no separators, no spaces; anything else, and anything too
 * large to hold exactly, is null.
 */
export function parseSuToMilli(text: string): number | null {
  if (typeof text !== "string") return null;
  const match = SU_DECIMAL_RE.exec(text);
  if (!match) return null;
  const milli = BigInt(match[1]) * 1000n + BigInt((match[2] ?? "").padEnd(3, "0"));
  if (milli > BigInt(MAX_SAFE)) return null;
  return Number(milli);
}

/** The shortest exact decimal for whole milli-SU: 12500 is `12.5`, 12000 is `12`, -500 is `-0.5`. */
export function formatSu(milli: number): string {
  if (!Number.isSafeInteger(milli)) throw new RangeError("an amount is a whole number of milli-SU");
  const abs = Math.abs(milli);
  const whole = Math.floor(abs / 1000);
  const fraction = abs % 1000;
  const decimals = fraction === 0 ? "" : `.${String(fraction).padStart(3, "0").replace(/0+$/, "")}`;
  return `${milli < 0 ? "-" : ""}${whole}${decimals}`;
}

// --- Results and the launcher's world ----------------------------------------------------------

/**
 * The largest single result file, 5 GB, until presigned multipart `UploadPart` is verified on R2.
 * Decimal gigabytes, so it sits under the 5 GiB one presigned PUT accepts.
 */
export const RESULT_MAX_FILE_BYTES = 5_000_000_000;

/** The Tapis owner, and the pseudonymous gateway user, of every NEMAR pipeline job. */
export const PIPELINES_TAPIS_OWNER = "nemar-pipelines";

/** On the node, under Tapis's output directory: the container's one writable mount. */
export const LAUNCHER_WORK_DIR = "work";

/** Where the entry writes its results, inside the work directory. */
export const LAUNCHER_OUTPUTS_DIR = "work/outputs";

/** The directory the container never has mounted; only the launcher writes here. */
export const LAUNCHER_DIR = "launcher";

/** The four files of the launcher directory, and of `jobs/<id>/launcher/` in the results bucket. */
export const LAUNCHER_FILES = {
  result: "result.json",
  provenance: "provenance.json",
  manifest: "manifest.json",
  log: "launcher.log",
} as const;

export const LAUNCHER_FILE_NAMES = [
  "result.json",
  "provenance.json",
  "manifest.json",
  "launcher.log",
] as const;

export type LauncherFileName = (typeof LAUNCHER_FILE_NAMES)[number];

/** The environment variables the launcher reads or sets. None is ever a job's own to set. */
export const LAUNCHER_ENV = {
  /** The launch specification, JSON (`shared/contract/compute-launch.ts`). */
  SPEC: "NEMAR_LAUNCH_SPEC",
  /** Where the entry writes its outputs, set inside the container. */
  OUT: "NEMAR_OUT",
  /** An optional root of NEMAR's own copy of datasets on the node. */
  LOCAL_DATASETS_ROOT: "NEMAR_LOCAL_DATASETS_ROOT",
  /** An optional override of the host Python that runs the launcher. */
  HOST_PYTHON: "NEMAR_HOST_PYTHON",
} as const;

/**
 * The environment names a job may set: thread counts and determinism, never a path, a loader or
 * anything the launcher reads. The first release's list, chosen in phase A1 for the owner to
 * confirm; widening it changes `compute-launch.schema.json`, which `nemar-process` copies.
 */
export const JOB_ENV_ALLOWLIST = [
  "OMP_NUM_THREADS",
  "MKL_NUM_THREADS",
  "OPENBLAS_NUM_THREADS",
  "NUMEXPR_NUM_THREADS",
  "PYTHONHASHSEED",
  "MPLBACKEND",
] as const;

export type JobEnvName = (typeof JOB_ENV_ALLOWLIST)[number];

/** Printable ASCII, so a value cannot carry a newline or a control character into a script. */
const ENV_VALUE_RE = /^[ -~]*$/;

export const computeEnvValueSchema = z.string().max(256).regex(ENV_VALUE_RE);

/** The environment a job asks for: names from the allowlist only, each a short printable value. */
export const computeJobEnvSchema = z.record(z.enum(JOB_ENV_ALLOWLIST), computeEnvValueSchema);

// --- The job specification ---------------------------------------------------------------------

export const JOB_RUNTIMES = ["python", "matlab", "image"] as const;

export type JobRuntime = (typeof JOB_RUNTIMES)[number];

const JOB_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,79}$/;
const RECIPE_NAME_RE = /^[a-z][a-z0-9-]{0,63}$/;

/**
 * An image pinned by digest: `[docker://]registry[:port]/path@sha256:<64 hex>`, lowercase. A tag
 * is not a pin, and the registry must also be one the owner's policy allows (a route's check).
 */
const IMAGE_REF_RE =
  /^(?:docker:\/\/)?[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]{1,5})?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+@sha256:[0-9a-f]{64}$/;

const bundleRefSchema = z.object({ size: safeInt(1), sha256: sha256Schema }).strict();

const datasetRefSchema = z
  .object({
    id: z.string().regex(COMPUTE_DATASET_ID_RE),
    version: z.string().regex(COMPUTE_DATASET_VERSION_RE),
    include: z.array(computeGlobSchema).max(64).optional(),
  })
  .strict();

const argSchema = z.string().max(1024);

/**
 * One job as every front door states it and the record keeps it. Resources are per node. A script
 * or folder job names an `entry` and the bundle that holds it; an image job names a digest-pinned
 * `image` and a `command` (and may carry a bundle); a recipe job names a `recipe` and needs none
 * of those. Unknown keys are refused, so a typo is never silently dropped from the record.
 *
 * The output directory is `outputs`, which the launcher's layout fixes (`work/outputs/`). `matlab`
 * is a valid specification; a route refuses it as `runtime_unavailable` until it is licensed.
 */
export const JobSpecSchema = z
  .object({
    name: z.string().regex(JOB_NAME_RE),
    runtime: z.enum(JOB_RUNTIMES),
    entry: relativePath(240).optional(),
    command: z.array(z.string().min(1).max(1024)).min(1).max(64).optional(),
    args: z.array(argSchema).max(64).default([]),
    bundle: bundleRefSchema.optional(),
    datasets: z.array(datasetRefSchema).max(20).default([]),
    partition: z.enum(PARTITION_NAMES),
    nodes: safeInt(1, 64).default(1),
    cores: safeInt(1, 256).default(1),
    memory_mb: safeInt(1, 16_777_216).optional(),
    gpus: safeInt(0, 8).default(0),
    minutes: safeInt(1, 10080),
    output_dir: z.literal("outputs").default("outputs"),
    env: computeJobEnvSchema.default({}),
    recipe: z.string().regex(RECIPE_NAME_RE).optional(),
    image: z.string().max(512).regex(IMAGE_REF_RE).optional(),
  })
  .strict()
  .superRefine((spec, ctx) => {
    const refuse = (path: string, message: string) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
    if (spec.entry !== undefined && spec.command !== undefined) {
      refuse("command", "an entry and a command are one or the other");
    }
    if (spec.runtime === "image" && spec.image === undefined) {
      refuse("image", "an image job names a digest-pinned image");
    }
    if (spec.runtime !== "image" && spec.image !== undefined) {
      refuse("image", "only an image job names an image");
    }
    if (spec.recipe === undefined && spec.entry === undefined && spec.command === undefined) {
      refuse("entry", "a job with no recipe names an entry or a command");
    }
    if (spec.entry !== undefined && spec.bundle === undefined) {
      refuse("bundle", "an entry needs the bundle that holds it");
    }
  });

export type JobSpec = z.infer<typeof JobSpecSchema>;

// --- The owner policy --------------------------------------------------------------------------

const CLIENT_ID_RE = /^[A-Za-z0-9_.-]{1,64}$/;

/** A registry host with an optional port and path, lowercase, no scheme: `ghcr.io/team`. */
const REGISTRY_RE =
  /^[a-z0-9]+(?:[.-][a-z0-9]+)*(?::[0-9]{1,5})?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$/;

const ceilingsShape = Object.fromEntries(
  PARTITION_NAMES.map((name) => [name, ComputeCeilingSchema.optional()]),
) as { [K in PartitionName]: z.ZodOptional<typeof ComputeCeilingSchema> };

/** A partner client's own caps, whole numbers. Epic B registers the client; the owner sets these. */
export const ComputeClientCapsSchema = z
  .object({ maxOpenReservations: safeInt(0, 100_000), maxReservedMilliPerDay: safeInt(0) })
  .strict();

/**
 * Everything the owner sets without a deploy, validated strictly on every write
 * (`nemar admin compute policy set`, owner only, audited). A partition that has a ceiling here is
 * offered to people; one without is for NEMAR's pipelines only. Grants and caps are whole numbers
 * of milli-SU, bytes, jobs, days or minutes.
 */
export const ComputePolicySchema = z
  .object({
    /** What approval opens, per pool, and whether and how often it renews. */
    defaultGrantMilli: z.object({ cpu: safeInt(0), gpu: safeInt(0) }).strict(),
    renewal: z
      .object({ enabled: z.boolean(), everyDays: safeInt(1, 366).nullable() })
      .strict()
      .refine((r) => !r.enabled || r.everyDays !== null, {
        message: "renewal that is on says how often",
        path: ["everyDays"],
      }),
    ceilings: z.object(ceilingsShape).strict(),
    /** Running and queued jobs one person may have at once. */
    maxLiveJobsPerPerson: safeInt(0, 1000),
    /** NEMAR's own pipelines: jobs a day, and the share of Expanse's concurrency they may hold. */
    pipelines: z
      .object({
        dailyJobCap: safeInt(0, 100_000),
        maxLiveJobs: z.object({ cpu: safeInt(0, 1000), gpu: safeInt(0, 1000) }).strict(),
      })
      .strict(),
    clients: z.record(z.string().regex(CLIENT_ID_RE), ComputeClientCapsSchema),
    /** Minutes a reservation may wait for its Tapis job before NEMAR searches and releases. */
    reservationWaitMinutes: safeInt(1, 1440),
    retention: z
      .object({
        recordsYears: safeInt(1, 30),
        logsDays: safeInt(1, 3650),
        /** Results are never kept fewer than 14 days, which a download link renewal relies on. */
        resultsDays: safeInt(14, 365),
      })
      .strict(),
    resultLimits: z
      .object({
        maxJobBytes: safeInt(1),
        maxFiles: safeInt(1, 100_000),
        maxStoredBytesPerPerson: safeInt(1),
        maxStoredBytesTotal: safeInt(1),
      })
      .strict(),
    /** A final charge within this of the provisional one is routine; a larger one is reported. */
    settle: z.object({ toleranceMilli: safeInt(0), tolerancePercent: safeInt(0, 100) }).strict(),
    /** Registries a container image may come from. */
    registries: z.array(z.string().min(1).max(255).regex(REGISTRY_RE)).max(64),
    bundleLimits: z
      .object({
        maxTotalBytes: safeInt(1),
        maxFiles: safeInt(1, 100_000),
        maxFileBytes: safeInt(1),
      })
      .strict(),
  })
  .strict();

export type ComputePolicy = z.infer<typeof ComputePolicySchema>;

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

/**
 * The policy in force when no version has been set. Closed by default: no grant, no registry, no
 * partner client, renewal off, and small caps. The values the design and the phase issue fix are
 * 0 grants, 30 minutes, 7 years, 365 days, 30 days and the result limits; the rest (live jobs,
 * pipeline caps, settle tolerance, bundle limits) are initial values the owner adjusts.
 */
export const DEFAULT_COMPUTE_POLICY: ComputePolicy = deepFreeze({
  defaultGrantMilli: { cpu: 0, gpu: 0 },
  renewal: { enabled: false, everyDays: null },
  ceilings: Object.fromEntries(
    PARTITION_NAMES.flatMap((name) => {
      const ceiling = PARTITIONS[name].ceiling;
      return ceiling ? [[name, { ...ceiling }]] : [];
    }),
  ) as ComputePolicy["ceilings"],
  maxLiveJobsPerPerson: 4,
  pipelines: { dailyJobCap: 50, maxLiveJobs: { cpu: 8, gpu: 4 } },
  clients: {},
  reservationWaitMinutes: 30,
  retention: { recordsYears: 7, logsDays: 365, resultsDays: 30 },
  resultLimits: {
    maxJobBytes: 20 * GIB,
    maxFiles: 5000,
    maxStoredBytesPerPerson: 50 * GIB,
    maxStoredBytesTotal: 1024 * GIB,
  },
  settle: { toleranceMilli: 1000, tolerancePercent: 5 },
  registries: [],
  bundleLimits: { maxTotalBytes: 100 * MIB, maxFiles: 2000, maxFileBytes: 25 * MIB },
});

// --- The launcher's own documents --------------------------------------------------------------

const manifestFileSchema = z
  .object({ path: relativePath(512), size: safeInt(0), sha256: sha256Schema })
  .strict();

/** `launcher/manifest.json`: every output's path, size and checksum, hashed by the launcher. */
export const ResultManifestSchema = z
  .object({ job_id: jobIdSchema, files: z.array(manifestFileSchema).max(100_000) })
  .strict();

const entryExitCodeSchema = z.number().int().min(-255).max(255).nullable();

/**
 * `launcher/result.json`: the one fixed failure code (or null), the exit number the launcher ends
 * with, and the entry's own exit code. The exit number is 0 for no failure and otherwise the one
 * `launcherExitNumber` gives that code, so the two cannot disagree.
 */
export const LauncherResultSchema = z
  .object({
    job_id: jobIdSchema,
    failure_code: z.enum(LAUNCHER_FAILURE_CODES).nullable(),
    detail: z.string().regex(COMPUTE_WORD_RE).nullable(),
    exit_number: z.number().int(),
    entry_exit_code: entryExitCodeSchema,
  })
  .strict()
  .superRefine((result, ctx) => {
    const expected =
      result.failure_code === null ? LAUNCHER_EXIT_OK : launcherExitNumber(result.failure_code);
    if (result.exit_number !== expected) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["exit_number"],
        message: "the exit number is the one the failure code gives",
      });
    }
  });

const stagingRecordSchema = z
  .object({
    id: z.string().regex(COMPUTE_DATASET_ID_RE),
    version: z.string().regex(COMPUTE_DATASET_VERSION_RE),
    mode: z.enum(["bind", "download"]),
    files: safeInt(0),
    bytes: safeInt(0),
  })
  .strict();

/**
 * `launcher/provenance.json`, written from outside the container: what ran and how. The
 * specification digest is the SHA-256 of the launch specification text the launcher received.
 * Nothing the container wrote is in it.
 */
export const LauncherProvenanceSchema = z
  .object({
    job_id: jobIdSchema,
    spec_digest: sha256Schema,
    bundle_digest: sha256Schema.nullable(),
    image: z
      .object({
        uri: z.string().regex(/^[^\s]{1,512}$/),
        digest: z.string().regex(COMPUTE_IMAGE_DIGEST_RE),
      })
      .strict(),
    runtime_version: z.string().regex(new RegExp(`^[^${CONTROL_CHARS}]{1,128}$`)),
    staging: z.array(stagingRecordSchema).max(20),
    /** Seconds per phase, keyed by a fixed word such as `code_fetch`, `staging`, `run`, `upload`. */
    timings: z
      .record(z.string().regex(COMPUTE_WORD_RE), z.number().finite().min(0))
      .refine((t) => Object.keys(t).length <= 16, { message: "at most 16 phases" }),
    slurm_job_id: z
      .string()
      .regex(/^[0-9A-Za-z_+.-]{1,64}$/)
      .nullable(),
    entry_exit_code: entryExitCodeSchema,
  })
  .strict();
