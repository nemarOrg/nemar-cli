/**
 * Everything `nemar compute submit` does BEFORE it asks NEMAR for anything (epic #2021 phase D3b, #2024):
 * read what the job asks for, build and check the specification, pack and scan the code, and make the
 * request. It sends nothing about the job and prints nothing, so `--dry-run` is exactly this and a test can run it with
 * no server at all; a local refusal is a value (`refused`) that the command turns into exit 2.
 *
 * ORDER, each step refusing before the next begins (so the cheapest check comes first and no byte of code
 * is read for a job that is already wrong):
 *  1. the flags: `--mem`, `--time`, numbers, `--dataset`, `--env`, `--image`;
 *  2. the target: a file, a folder or (for an image job) nothing;
 *  3. the headers: the script's block and the folder's `nemar-job.toml`, merged under the flags;
 *  4. the specification, with a placeholder for the bundle: `JobSpecSchema` (the Worker's own), the dataset
 *     versions the data plane can name, and the 64 KiB launch bound (`launchSpecFits`);
 *  5. the command line itself against the credential scan (a name, an argument, an environment value);
 *  6. the code: collect, apply the Worker's caps before reading, read each file once through the credential
 *     scan, apply the caps again to the real digests, build the archive;
 *  7. the request, validated against the STRICT request schema the Worker validates with.
 */

import { statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { SpecFields } from "../../../shared/compute-header.js";
import { launchSpecFits } from "../../../shared/contract/compute-launch.js";
import {
  type ComputeSubmitRequest,
  ComputeSubmitRequestSchema,
} from "../../../shared/contract/compute-submit-request.js";
import {
  COMPUTE_IMAGE_REF_RE,
  JOB_ENV_ALLOWLIST,
  type JobSpec,
  JobSpecSchema,
  datasetVersionWithoutTag,
  isSafeComputePath,
} from "../../../shared/contract/compute.js";
import {
  type FieldSource,
  type HeaderRead,
  SPEC_DEFAULTS,
  type SpecFlags,
  defaultJobName,
  flagsToFields,
  headerKindForFile,
  mergeSpecFields,
  readFolderHeader,
  readScriptHeader,
} from "./header.js";
import {
  type Collected,
  type PackRefusal,
  type PackedBundle,
  type Skipped,
  UnreadablePath,
  collectFile,
  collectFolder,
  packCollected,
} from "./pack.js";
import {
  type Finding,
  SECRET_REMEDY,
  describeFinding,
  scanFile,
  scanValue,
} from "./secret-scan.js";

// --- The input ---------------------------------------------------------------------------------------

export interface PrepareInput {
  /** The file or folder named on the command line; undefined when none was. */
  path: string | undefined;
  flags: SpecFlags;
  /** `--image`. */
  image: string | undefined;
  /** `--env NAME=value`, as typed. */
  env: string[];
  /** The directory a relative `path` is read from. */
  cwd: string;
}

export interface Prepared {
  request: ComputeSubmitRequest;
  /** Present for a job with code: the archive to upload. Image jobs with no code have none. */
  archive: Uint8Array | null;
  /** The packed bundle's figures, or null. */
  bundle: PackedBundle | null;
  /** What the specification says and which source said it, for `--dry-run`. */
  from: Partial<Record<keyof SpecFields, FieldSource>>;
  /** What was left out of the bundle. */
  skipped: Skipped | null;
  /** Where the code came from, for the summary. */
  target: { kind: "file" | "folder" | "none"; label: string };
}

export type PrepareResult = { ok: true; prepared: Prepared } | { ok: false; refused: Refusal };

/** A local refusal: lines to print (to standard error) and exit 2. Never holds a value of a secret. */
export interface Refusal {
  lines: string[];
  /** Extra detail lines under the first (a list of paths, say). */
  detail?: string[];
}

const refuse = (...lines: string[]): { ok: false; refused: Refusal } => ({
  ok: false,
  refused: { lines },
});

/** The `docker://` form is the one the command takes; a tag is not a pin. */
const IMAGE_FLAG_RE = /^docker:\/\//;

const ENV_NAMES: readonly string[] = JOB_ENV_ALLOWLIST;

function parseEnv(items: readonly string[]): { env: Record<string, string> } | { problem: string } {
  const env: Record<string, string> = {};
  for (const item of items) {
    const at = item.indexOf("=");
    if (at <= 0) return { problem: "--env is NAME=value." };
    const name = item.slice(0, at);
    if (!ENV_NAMES.includes(name)) {
      return { problem: `--env names one of: ${ENV_NAMES.join(", ")}.` };
    }
    if (Object.hasOwn(env, name)) return { problem: `--env ${name} is given twice.` };
    env[name] = item.slice(at + 1);
  }
  return { env };
}

function problemsOf(read: HeaderRead): string[] | null {
  return read.ok ? null : read.problems;
}

function issueLines(spec: unknown): string[] | null {
  const parsed = JobSpecSchema.safeParse(spec);
  if (parsed.success) return null;
  return parsed.error.issues.map((issue) => {
    const field = issue.path.length > 0 ? issue.path.join(".") : "the job";
    // A zod message for an enum or a literal can quote the value that was typed; only the field and the
    // rule's own words are kept.
    const message =
      issue.code === "custom" && issue.message
        ? issue.message
        : issue.code === "invalid_enum_value"
          ? `must be one of ${issue.options.join(", ")}`
          : issue.code === "too_small" || issue.code === "too_big"
            ? "is out of range"
            : "is not valid";
    return `${field}: ${message}`;
  });
}

function describePackRefusal(refusal: PackRefusal): Refusal {
  const detail =
    refusal.largest?.map((f) => `  ${f.path}  ${f.size.toLocaleString("en-US")} bytes`) ?? [];
  const head =
    refusal.path !== undefined ? `${refusal.message} (${refusal.path})` : refusal.message;
  return {
    lines: [head],
    ...(detail.length > 0 ? { detail: ["The largest files:", ...detail] } : {}),
  };
}

// --- The one function --------------------------------------------------------------------------------

export function prepareSubmission(input: PrepareInput): PrepareResult {
  try {
    return prepare(input);
  } catch (error) {
    // A file that cannot be read, or that vanished while the bundle was made: a local refusal that names
    // the relative path and nothing else.
    if (error instanceof UnreadablePath) return refuse(`${error.path} cannot be read.`);
    throw error;
  }
}

function prepare(input: PrepareInput): PrepareResult {
  const { flags } = input;

  // 1. The flags.
  const flagRead = flagsToFields(flags);
  if (!flagRead.ok) return { ok: false, refused: { lines: flagRead.problems } };
  const envRead = parseEnv(input.env);
  if ("problem" in envRead) return refuse(envRead.problem);

  let image: string | undefined;
  if (input.image !== undefined) {
    if (!IMAGE_FLAG_RE.test(input.image) || !COMPUTE_IMAGE_REF_RE.test(input.image)) {
      return refuse(
        "--image is docker://<registry>/<repo>@sha256:<64 hex digits>: an image is named by its digest, and a tag is not a pin.",
      );
    }
    image = input.image;
    if (flags.runtime !== undefined && flags.runtime !== "image") {
      return refuse("--image runs a container image; --runtime must be image or left out.");
    }
  }
  const imageMode = image !== undefined || flags.runtime === "image";

  // 2. The target.
  const entryFlag = flags.entry;
  let kind: "file" | "folder" | "none";
  let abs: string | null = null;
  if (input.path === undefined) {
    if (imageMode && entryFlag === undefined) kind = "none";
    else {
      kind = "folder";
      abs = resolve(input.cwd);
    }
  } else {
    abs = resolve(input.cwd, input.path);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(abs);
    } catch {
      return refuse("There is no such file or folder.");
    }
    if (st.isFile()) kind = "file";
    else if (st.isDirectory()) kind = "folder";
    else return refuse("That is neither a file nor a folder.");
  }

  // 3. The headers, and the entry they hang on.
  let folderHeader: HeaderRead = { ok: true, found: false, fields: {} };
  if (kind === "folder" && abs !== null) folderHeader = readFolderHeader(abs);
  const folderProblems = problemsOf(folderHeader);
  if (folderProblems) return { ok: false, refused: { lines: folderProblems } };
  const fileFields = folderHeader.ok ? folderHeader.fields : {};

  let entry: string | undefined;
  if (kind === "file" && abs !== null) {
    entry = basename(abs);
    if (entryFlag !== undefined && entryFlag !== entry) {
      return refuse("--entry names a file in a folder; the path given is a single file.");
    }
  } else if (kind === "folder") {
    entry = entryFlag ?? fileFields.entry;
    if (entry !== undefined) entry = entry.replace(/^(?:\.\/)+/, "");
    if (entry === undefined && !imageMode) {
      return refuse('Name the file to run: --entry <file>, or entry = "..." in nemar-job.toml.');
    }
  }
  if (entry !== undefined && !isSafeComputePath(entry, 240)) {
    return refuse(
      "The entry must be a relative path inside the folder, without .. or a backslash.",
    );
  }

  let scriptHeader: HeaderRead = { ok: true, found: false, fields: {} };
  if (entry !== undefined && abs !== null && headerKindForFile(entry) !== null) {
    const scriptPath = kind === "file" ? abs : join(abs, entry);
    try {
      if (statSync(scriptPath).isFile()) scriptHeader = readScriptHeader(scriptPath, entry);
    } catch {
      // The entry is not a file in the folder; the bundle check below says so.
    }
  }
  const scriptProblems = problemsOf(scriptHeader);
  if (scriptProblems) return { ok: false, refused: { lines: scriptProblems } };
  const headerFields = scriptHeader.ok ? scriptHeader.fields : {};

  // 4. The specification.
  const inferred =
    image !== undefined
      ? "image"
      : entry !== undefined && headerKindForFile(entry) === "python"
        ? "python"
        : entry !== undefined && headerKindForFile(entry) === "matlab"
          ? "matlab"
          : undefined;
  const defaults: SpecFields = {
    ...SPEC_DEFAULTS,
    ...(inferred !== undefined ? { runtime: inferred } : {}),
    name: defaultJobName(entry ?? (abs !== null ? basename(abs) : "job")),
  };
  const merged = mergeSpecFields({
    flags: {
      ...flagRead.fields,
      ...(image !== undefined ? { runtime: "image" } : {}),
      ...(entry !== undefined && entryFlag !== undefined ? { entry } : {}),
    },
    header: headerFields,
    file: fileFields,
    defaults,
  });
  const f = merged.fields;
  if (f.runtime === undefined) {
    return refuse(
      "Say how to run it: --runtime python, matlab or image (a file ending .py or .m picks its own).",
    );
  }
  if (f.runtime === "image" && image === undefined) {
    return refuse(
      "An image job names its image: --image docker://<registry>/<repo>@sha256:<digest>.",
    );
  }
  const versionless = (f.datasets ?? []).find((d) => d.version === undefined);
  if (versionless) {
    return refuse(
      "A dataset needs its version, like nm000104@1.0.2, so the job can be run again on the same data.",
    );
  }

  // `--` after an image job with no code is the command; everywhere else it is the entry's arguments.
  const words = f.args ?? [];
  const commandJob = f.runtime === "image" && entry === undefined;
  if (commandJob && words.length === 0) {
    return refuse("An image job with no code needs the command to run, after --.");
  }

  const base: Record<string, unknown> = {
    name: f.name,
    runtime: f.runtime,
    ...(entry !== undefined ? { entry } : {}),
    ...(commandJob ? { command: words } : { args: words }),
    datasets: (f.datasets ?? []).map((d) => ({ id: d.id, version: d.version })),
    partition: f.partition,
    nodes: f.nodes,
    cores: f.cores,
    ...(f.memory_mb !== undefined ? { memory_mb: f.memory_mb } : {}),
    gpus: f.gpus,
    minutes: f.minutes,
    env: envRead.env,
    ...(image !== undefined ? { image } : {}),
  };
  const withCode = kind !== "none";
  const placeholder = { size: 1, sha256: "0".repeat(64) };
  const draft = { ...base, ...(withCode ? { bundle: placeholder } : {}) };
  const issues = issueLines(draft);
  if (issues)
    return {
      ok: false,
      refused: { lines: ["The job is not valid:", ...issues.map((l) => `  ${l}`)] },
    };
  const draftSpec = JobSpecSchema.parse(draft);
  const untagged = datasetVersionWithoutTag(draftSpec.datasets);
  if (untagged !== null) {
    return refuse(
      `${untagged}: a dataset version is like 1.0.2 (or v1.0.2, or latest) so the data plane can name it.`,
    );
  }
  if (!launchSpecFits(draftSpec))
    return refuse(
      "The job asks for too much to launch: its arguments or environment are too large.",
    );

  // 5. The command line against the credential scan.
  const spoken: Finding[] = [
    ...scanValue("name", String(f.name ?? "")),
    ...words.flatMap((w, i) => scanValue(`argument ${i + 1}`, w)),
    ...Object.entries(envRead.env).flatMap(([k, v]) => scanValue(`environment ${k}`, v)),
  ];
  if (spoken.length > 0) return { ok: false, refused: secretRefusal(spoken) };

  // 6. The code.
  let packed: PackedBundle | null = null;
  let skipped: Skipped | null = null;
  let label = "no code (a container image and a command)";
  if (withCode && abs !== null) {
    let collected: Collected;
    if (kind === "file") {
      collected = collectFile(abs);
      label = `file ${basename(abs)}`;
    } else {
      const walk = collectFolder(abs);
      if (!walk.ok) return { ok: false, refused: { lines: walk.problems } };
      collected = walk.collected;
      label = `folder ${basename(abs) || abs}`;
    }
    skipped = collected.skipped;
    const findings: Finding[] = [];
    const result = packCollected(collected, {
      ...(entry !== undefined ? { entry } : {}),
      inspect: (path, bytes) => {
        const found = scanFile(path, bytes);
        findings.push(...found);
        return found.length;
      },
    });
    if (!result.ok) {
      if (result.reason === "inspected") return { ok: false, refused: secretRefusal(findings) };
      return { ok: false, refused: describePackRefusal(result.refusal) };
    }
    packed = result.bundle;
  }

  // 7. The request.
  const finalSpec: JobSpec = JobSpecSchema.parse({
    ...base,
    ...(packed ? { bundle: { size: packed.size, sha256: packed.sha256 } } : {}),
  });
  const request: ComputeSubmitRequest = {
    spec: finalSpec,
    ...(packed ? { manifest: packed.manifest } : {}),
  };
  const strict = ComputeSubmitRequestSchema.safeParse(request);
  if (!strict.success) {
    return refuse(
      "The request this command made is not one NEMAR accepts; this is a bug in the command.",
    );
  }
  return {
    ok: true,
    prepared: {
      request: strict.data,
      archive: packed ? packed.archive : null,
      bundle: packed,
      from: merged.from,
      skipped,
      target: { kind, label },
    },
  };
}

/** The credential scan's refusal: places and rule names, the remedy, never a value. */
export function secretRefusal(findings: readonly Finding[]): Refusal {
  const shown = findings.slice(0, 50);
  return {
    lines: ["The job holds what looks like a credential:"],
    detail: [
      ...shown.map((f) => `  ${describeFinding(f)}`),
      ...(findings.length > shown.length
        ? [`  ... and ${findings.length - shown.length} more`]
        : []),
      SECRET_REMEDY,
    ],
  };
}
