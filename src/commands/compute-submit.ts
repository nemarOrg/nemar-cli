/**
 * `nemar compute submit`: run a script, a folder or a pinned container image on NEMAR compute (epic #2021
 * phase D3b, #2024; ADR 0118, the amendment of phase D3).
 *
 *   nemar compute submit [path] [--entry --dataset --partition --nodes --cores --mem --gpus --time --name
 *                          --runtime --image --env --wait --dry-run --json] [-- args]
 *
 * What it does, in this order, and what each step can refuse (`src/lib/compute/prepare.ts` is steps 1 to 3):
 *  1. reads the job from the flags, the script's `# /// nemar` header, the folder's `nemar-job.toml` and the
 *     defaults (flags win), checks it against the Worker's own specification schema, packs the code into one
 *     deterministic archive and scans every file for credentials. A refusal is EXIT 2, before any request about the job;
 *  2. with `--dry-run`, prints what would be sent and stops: it sends NOTHING about the job and needs no sign-in;
 *  3. `POST /compute/jobs` with an `Idempotency-Key` (one random key per run, kept across its own retries);
 *  4. for a bundle, one PUT of the archive to the address it was given, then `POST .../finalize` with the
 *     manifest again; an image job is submitted at once;
 *  5. with `--wait`, polls the job until it ends; Ctrl-C stops WAITING and never cancels.
 * Standard output is the answer (human text, or with `--json` ONLY the Worker's answer); every failure is
 * on standard error. The upload address and the signed headers are bearer secrets and are never printed.
 */

import { randomUUID } from "node:crypto";
import chalk from "chalk";
import { Command } from "commander";
import { formatBytesCli } from "../../shared/bytes.js";
import type {
  ComputeFinalizeResponse,
  ComputeSubmitResponse,
} from "../../shared/contract/compute-submit.js";
import type { ComputeUserJobResponse } from "../../shared/contract/compute-user.js";
import { estimateSuMilli } from "../../shared/contract/compute.js";
import { requireSignedIn } from "../lib/admin-command.js";
import {
  computeRefusalCode,
  finalizeComputeJob,
  getMyComputeJob,
  submitComputeJob,
} from "../lib/api/compute.js";
import { ApiError, MaintenanceError } from "../lib/api/errors.js";
import { EXIT_STILL_LIVE, failCompute, failText, refuseLocally } from "../lib/compute/fail.js";
import type { SpecFlags } from "../lib/compute/header.js";
import { type Prepared, prepareSubmission } from "../lib/compute/prepare.js";
import { uploadBundle } from "../lib/compute/upload.js";
import { READ_TIMEOUT_MS, type WaitOutcome, waitForJob } from "../lib/compute/wait.js";
import { plain } from "../lib/terminal-text.js";
import { suFixed } from "./compute-read.js";

// --- Options -------------------------------------------------------------------------------------------

interface SubmitOptions {
  entry?: string;
  dataset?: string[];
  partition?: string;
  nodes?: string;
  cores?: string;
  mem?: string;
  gpus?: string;
  time?: string;
  name?: string;
  runtime?: string;
  image?: string;
  env?: string[];
  wait?: boolean;
  dryRun?: boolean;
  json?: boolean;
}

const collect = (value: string, previous: string[] = []): string[] => [...previous, value];

/** What follows the first `--` on the command line, as typed. */
export function argsAfterDoubleDash(rawArgs: readonly string[]): string[] | null {
  const at = rawArgs.indexOf("--");
  return at === -1 ? null : rawArgs.slice(at + 1);
}

/** The root program's argv (Commander keeps it there), for finding `--`. */
function rawArgsOf(command: Command): readonly string[] {
  let node: Command = command;
  while (node.parent) node = node.parent;
  return (node as Command & { rawArgs?: string[] }).rawArgs ?? process.argv;
}

/**
 * Splits Commander's operands into the path (before `--`, at most one) and the job's arguments (after it).
 * Returns null, having said why, when an operand that is neither was given.
 */
export function splitOperands(
  operands: readonly string[],
  rawArgs: readonly string[],
): { path: string | undefined; args: string[] | undefined } | { error: string } {
  const after = argsAfterDoubleDash(rawArgs);
  const afterCount = after === null ? 0 : after.length;
  const before = operands.slice(0, operands.length - afterCount);
  if (before.length > 1) {
    return {
      error:
        "Give one file or folder; the arguments for your script go after --, like: nemar compute submit run.py -- --fast",
    };
  }
  return { path: before[0], args: after === null ? undefined : [...after] };
}

// --- Output --------------------------------------------------------------------------------------------

const minutesText = (minutes: number): string => {
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
};

function printLeftOut(prepared: Prepared, out: (line: string) => void): void {
  const s = prepared.skipped;
  if (s === null) return;
  const parts: string[] = [];
  if (s.symlinks > 0) parts.push(`${s.symlinks} symbolic link${s.symlinks === 1 ? "" : "s"}`);
  if (s.special > 0) parts.push(`${s.special} special file${s.special === 1 ? "" : "s"}`);
  if (s.directories > 0)
    parts.push(
      `${s.directories} folder${s.directories === 1 ? "" : "s"} (caches, .git, environments, ignored)`,
    );
  if (s.ignored > 0) parts.push(`${s.ignored} file${s.ignored === 1 ? "" : "s"} (ignored)`);
  if (parts.length > 0) out(`  Left out:   ${parts.join(", ")}`);
  if (s.tooLarge.length > 0) {
    const names = s.tooLarge.slice(0, 5).map((f) => `${f.path} (${formatBytesCli(f.size)})`);
    out(
      `  Too large:  ${s.tooLarge.length} file${s.tooLarge.length === 1 ? "" : "s"} over the per-file limit left out: ${names.join(", ")}${s.tooLarge.length > 5 ? ", ..." : ""}`,
    );
    out(
      chalk.dim("              Put data in a dataset or read it from one; a bundle is for code."),
    );
  }
}

function estimate(prepared: Prepared): number | null {
  try {
    const spec = prepared.request.spec;
    return estimateSuMilli({
      partition: spec.partition,
      nodes: spec.nodes,
      cores: spec.cores,
      memory_mb: spec.memory_mb ?? 0,
      gpus: spec.gpus,
      minutes: spec.minutes,
    });
  } catch {
    return null;
  }
}

function printDryRun(prepared: Prepared, json: boolean): void {
  const spec = prepared.request.spec;
  const hold = estimate(prepared);
  if (json) {
    console.log(
      JSON.stringify(
        {
          dry_run: true,
          request: prepared.request,
          archive: prepared.bundle
            ? { size: prepared.bundle.size, sha256: prepared.bundle.sha256 }
            : null,
          files: prepared.bundle ? prepared.bundle.manifest.files.length : 0,
          content_bytes: prepared.bundle ? prepared.bundle.contentBytes : 0,
          estimated_hold_milli: hold,
        },
        null,
        2,
      ),
    );
    return;
  }
  const out = (line: string) => console.log(line);
  out(chalk.bold("Dry run: nothing about the job was sent."));
  out(
    `  Job:        ${plain(spec.name)} (${spec.runtime}${spec.entry ? `, entry ${plain(spec.entry)}` : ""})`,
  );
  if (prepared.bundle) {
    out(
      `  Code:       ${plain(prepared.target.label)}: ${prepared.bundle.manifest.files.length} file${prepared.bundle.manifest.files.length === 1 ? "" : "s"}, ${formatBytesCli(prepared.bundle.contentBytes)}, archive ${formatBytesCli(prepared.bundle.size)}`,
    );
    out(`  Digest:     sha256 ${prepared.bundle.sha256}`);
  } else {
    out(`  Code:       ${plain(prepared.target.label)}`);
  }
  if (spec.image) out(`  Image:      ${plain(spec.image)}`);
  out(
    `  Resources:  ${spec.partition}, ${spec.nodes} node${spec.nodes === 1 ? "" : "s"}, ${spec.cores} core${spec.cores === 1 ? "" : "s"}${spec.gpus > 0 ? `, ${spec.gpus} GPU${spec.gpus === 1 ? "" : "s"}` : ""}${spec.memory_mb !== undefined ? `, ${spec.memory_mb} MB` : ""}, up to ${minutesText(spec.minutes)}`,
  );
  if (spec.datasets.length > 0) {
    out(`  Datasets:   ${spec.datasets.map((d) => `${d.id}@${d.version}`).join(", ")}`);
  }
  const command = spec.command ?? spec.args;
  if (command.length > 0)
    out(`  ${spec.command ? "Command" : "Arguments"}:  ${command.map(plain).join(" ")}`);
  if (hold !== null) {
    out(
      `  Holds:      up to ${suFixed(hold)} SU while it runs; unused time is released when it ends`,
    );
  }
  printLeftOut(prepared, out);
  out(
    chalk.dim(
      `  Set by:     ${Object.entries(prepared.from)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ")}`,
    ),
  );
}

// --- Requests with retries ----------------------------------------------------------------------------------

const RETRY_WAITS_MS = [1000, 2000, 4000] as const;

/** A failure worth asking again: no answer, or a 5xx that is not the maintenance banner. */
function retryable(error: unknown): boolean {
  if (!(error instanceof ApiError) || error instanceof MaintenanceError) return false;
  return error.statusCode === 0 || error.statusCode >= 500;
}

async function withRetries<T>(call: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await call();
    } catch (error) {
      if (!retryable(error) || attempt >= RETRY_WAITS_MS.length) throw error;
      await Bun.sleep(RETRY_WAITS_MS[attempt] as number);
    }
  }
}

/** The job id a `503 storage_unavailable` after the hold carries, if it does. */
function jobIdOf(error: unknown): string | undefined {
  if (!(error instanceof ApiError)) return undefined;
  const body = error.rawBody;
  if (typeof body !== "object" || body === null) return undefined;
  const id = (body as Record<string, unknown>).job_id;
  return typeof id === "string" ? id : undefined;
}

// --- The run ------------------------------------------------------------------------------------------------

const clock = () => new Date().toISOString().slice(11, 19);

const SUBMIT_HELP = `
Description:
  Runs a script, a folder of code or a pinned container image on NEMAR compute and returns the job's id.

  PATH is a script (a .py or .m file) or a folder; with no PATH an image job (--image) has no code and the
  command to run follows --, and any other job uses the current folder. A folder needs --entry (or
  entry = "..." in its nemar-job.toml). What the job asks for comes from, in this order: the flags, a
  "# /// nemar" block in the script ("% /// nemar" in a .m file), the folder's nemar-job.toml, then
  defaults (partition shared, 1 node, 1 core, 1 hour). The block's keys are name, runtime, entry, datasets,
  partition, nodes, cores, memory, time, gpus and args; memory is like 16G and time like 2h or 1h30m.
  Everything after -- is passed to your script as its arguments.

  The code is packed into one archive: .git, caches, virtual environments, node_modules, symbolic links and
  files over 25 MiB are left out (more with a .nemarignore file, one pattern a line), at most 2,000 files and
  100 MiB. Every file is scanned for credentials (private keys, cloud and source-host tokens, NEMAR keys, and
  files named .env, .netrc, id_rsa or *.pem); a finding refuses the job, prints the file and rule and never
  the value, and has no override.

  --image must be docker://<registry>/<repo>@sha256:<digest>; a tag is not accepted. The registry must be
  one NEMAR allows.

  --dry-run packs and scans and prints what would be sent, and sends nothing about the job (it needs no sign-in).
  In a dry run or a local refusal no job data leaves this machine; the command's routine notice and update
  checks can still run.

  Running submit again makes a SECOND job and a second hold: every run has its own Idempotency-Key. A 503
  after the hold is finished by repeating the same key, which the command does itself (three retries); an
  interrupted or failed run is not resumed, and a job left waiting for its bundle ends by itself after an
  hour, or sooner with nemar compute cancel <job>.
  --wait follows the job until it ends. Ctrl-C stops waiting and does NOT cancel the job.

  With --json standard output is only the answer: NEMAR's answer to the submission (or, with --wait, the
  job's last state); with --dry-run it is the request that would have been sent. Failures are on standard
  error.

Exit codes:
  0  the job was submitted (with --wait: it finished); with --dry-run, what would be sent was printed.
  1  NEMAR refused or could not take the job, the job failed or was canceled, or you are not signed in.
  2  refused on this machine before anything about the job was sent: an invalid option or job, a file or folder that
     cannot be packed, over a size limit, or a credential in the code.
  3  with --wait, the wait ended with the job still live (you pressed Ctrl-C, NEMAR could not be
     reached, or the job outlasted its time limit by 30 minutes); the job goes on.

Examples:
  $ nemar compute submit analysis.py --wait
  $ nemar compute submit ./study --entry run.py --dataset nm000104@1.0.2 --cores 8 --mem 16G --time 2h
  $ nemar compute submit analysis.py --dry-run
  $ nemar compute submit analysis.py -- --subject 4 --fast
  $ nemar compute submit --image docker://ghcr.io/team/tool@sha256:<digest> --partition shared -- run-it --fast`;

export const submitCommand = new Command("submit")
  .description("Run a script, a folder or a container image on NEMAR compute")
  .argument("[path]", "A script file or a folder (default: this folder)")
  .argument("[args...]", "Arguments for your script, after --")
  .option("--entry <file>", "The file in the folder to run")
  .option(
    "--dataset <id@version>",
    "A dataset the job reads (repeatable), like nm000104@1.0.2",
    collect,
  )
  .option("--partition <name>", "Where it runs (default shared)")
  .option("--nodes <n>", "Nodes (default 1)")
  .option("--cores <n>", "Cores per node (default 1)")
  .option("--mem <size>", "Memory per node, like 16G")
  .option("--gpus <n>", "GPUs per node (default 0)")
  .option("--time <duration>", "The longest it may run, like 2h or 1h30m (default 1h)")
  .option("--name <text>", "A name for the job (default: the script's name)")
  .option("--runtime <name>", "python, matlab or image (a .py or .m file picks its own)")
  .option(
    "--image <ref>",
    "A container image pinned by digest: docker://<registry>/<repo>@sha256:<digest>",
  )
  .option(
    "--env <NAME=value>",
    "An environment variable from the allowed list (repeatable)",
    collect,
  )
  .option("--wait", "Follow the job until it ends")
  .option("--dry-run", "Pack and check the job and print it; send nothing about it")
  .option("--json", "Print only the answer, as JSON")
  .addHelpText("after", SUBMIT_HELP)
  .action(
    async (pathArg: string | undefined, rest: string[], o: SubmitOptions, command: Command) => {
      const json = o.json === true;
      const operands = [...(pathArg === undefined ? [] : [pathArg]), ...rest];
      const split = splitOperands(operands, rawArgsOf(command));
      if ("error" in split) {
        refuseLocally([split.error]);
        return;
      }
      const flags: SpecFlags = {
        ...(o.name !== undefined ? { name: o.name } : {}),
        ...(o.runtime !== undefined ? { runtime: o.runtime } : {}),
        ...(o.entry !== undefined ? { entry: o.entry } : {}),
        ...(o.dataset !== undefined ? { dataset: o.dataset } : {}),
        ...(o.partition !== undefined ? { partition: o.partition } : {}),
        ...(o.nodes !== undefined ? { nodes: o.nodes } : {}),
        ...(o.cores !== undefined ? { cores: o.cores } : {}),
        ...(o.mem !== undefined ? { mem: o.mem } : {}),
        ...(o.gpus !== undefined ? { gpus: o.gpus } : {}),
        ...(o.time !== undefined ? { time: o.time } : {}),
        ...(split.args !== undefined && split.args.length > 0 ? { args: split.args } : {}),
      };
      const result = prepareSubmission({
        path: split.path,
        flags,
        image: o.image,
        env: o.env ?? [],
        cwd: process.cwd(),
      });
      if (!result.ok) {
        refuseLocally(result.refused.lines, result.refused.detail);
        return;
      }
      const prepared = result.prepared;

      if (o.dryRun) {
        printDryRun(prepared, json);
        return;
      }
      if (!requireSignedIn(json)) return;
      await send(prepared, o, json);
    },
  );

const notice = (json: boolean) => (line: string) =>
  json ? console.error(line) : console.log(line);

/** Steps 3 to 5: ask NEMAR, upload, finalize, wait. */
async function send(prepared: Prepared, o: SubmitOptions, json: boolean): Promise<void> {
  const say = notice(json);
  const key = randomUUID();
  const request = prepared.request;

  let submitted: ComputeSubmitResponse;
  try {
    submitted = await withRetries(() => submitComputeJob(request, key));
  } catch (error) {
    failCompute(error, "Could not submit the job.");
    const stray = jobIdOf(error);
    if (stray !== undefined) {
      console.error(
        chalk.dim(
          `  The job was made as ${plain(stray)} and its hold stands; cancel it with: nemar compute cancel ${plain(stray)}`,
        ),
      );
    }
    return;
  }
  const jobId = submitted.job_id;
  say(
    `Submitted ${chalk.bold(plain(jobId))} (${plain(submitted.name)}), state ${plain(submitted.state)}.`,
  );

  let answer: ComputeSubmitResponse | ComputeFinalizeResponse = submitted;
  if (request.manifest !== undefined && prepared.archive !== null) {
    if (submitted.upload !== undefined) {
      say(
        `Uploading ${formatBytesCli(prepared.archive.length)} (${request.manifest.files.length} file${request.manifest.files.length === 1 ? "" : "s"}) ...`,
      );
      const uploaded = await uploadBundle(submitted.upload, prepared.archive);
      if (!uploaded.ok) {
        const cancel = `nemar compute cancel ${jobId}`;
        const why =
          uploaded.kind === "expired"
            ? "The upload address expired or was refused. Run the command again to make a new job."
            : uploaded.kind === "refused"
              ? `The store refused the upload (HTTP ${uploaded.status}). Run the command again to make a new job.`
              : uploaded.kind === "failed"
                ? `The upload could not be completed after ${uploaded.attempts} attempts. Run the command again to make a new job.`
                : uploaded.kind === "insecure_address"
                  ? "NEMAR gave an upload address that is not https, so it was not used."
                  : "The archive is not the size NEMAR was told.";
        failText(why, {
          answered: uploaded.kind !== "failed",
          hint: `This job waits for its bundle for up to an hour, then ends by itself; end it now with: ${cancel}`,
        });
        return;
      }
    }
    try {
      answer = await withRetries(() =>
        finalizeComputeJob(jobId, request.manifest as NonNullable<typeof request.manifest>),
      );
    } catch (error) {
      failCompute(error, "Could not finish the submission.");
      if (computeRefusalCode(error)?.code !== "upload_expired") {
        console.error(
          chalk.dim(
            `  The job is ${plain(jobId)}; look at it with: nemar compute status ${plain(jobId)}`,
          ),
        );
      }
      return;
    }
    say(`Bundle received, state ${plain(answer.state)}.`);
  }

  if (!o.wait) {
    if (json) console.log(JSON.stringify(answer, null, 2));
    else {
      console.log(
        chalk.dim(`  Watch it: nemar compute status ${jobId}   Logs: nemar compute logs ${jobId}`),
      );
      console.log(chalk.dim(`  Stop it:  nemar compute cancel ${jobId}`));
    }
    return;
  }
  await waitAndReport(jobId, answer, json);
}

function reportOutcome(outcome: WaitOutcome, jobId: string, json: boolean): void {
  const say = notice(json);
  switch (outcome.kind) {
    case "terminal": {
      const state = outcome.job.state;
      if (state === "finished") {
        say(chalk.green(`Job ${jobId} finished.`));
        say(chalk.dim(`  Fetch the results: nemar compute results ${jobId} --download ./results`));
        return;
      }
      failText(
        `Job ${jobId} ${state}${outcome.job.failure_code ? ` (${outcome.job.failure_code})` : ""}.`,
        { answered: true, hint: `Read its log: nemar compute logs ${jobId}` },
      );
      return;
    }
    case "detached":
      process.exitCode = EXIT_STILL_LIVE;
      console.error(
        `\nStopped waiting. Job ${jobId} is still running and was not canceled.\n  Look at it: nemar compute status ${jobId}   Stop it: nemar compute cancel ${jobId}`,
      );
      return;
    case "unavailable":
      process.exitCode = EXIT_STILL_LIVE;
      console.error(
        `NEMAR could not be reached (${plain(outcome.detail)}), so the wait ended. Job ${jobId} may still be running.\n  Look at it: nemar compute status ${jobId}`,
      );
      return;
    case "ceiling":
      process.exitCode = EXIT_STILL_LIVE;
      console.error(
        `Stopped waiting: the job's time limit and a 30-minute allowance have passed and it is still live. Job ${jobId} was not canceled.\n  Look at it: nemar compute status ${jobId}   Stop it: nemar compute cancel ${jobId}`,
      );
      return;
    case "refused":
      failCompute(outcome.error, "Could not read the job.");
      return;
  }
}

async function waitAndReport(
  jobId: string,
  lastAnswer: ComputeSubmitResponse | ComputeFinalizeResponse,
  json: boolean,
): Promise<void> {
  const say = notice(json);
  let latest: ComputeUserJobResponse | null = null;
  const outcome = await waitForJob({
    fetchJob: async (signal) => {
      const read = await getMyComputeJob(jobId, { signal, timeoutMs: READ_TIMEOUT_MS });
      latest = read;
      return read;
    },
    onState: (job, stale) => {
      say(`  ${clock()}  ${plain(job.state)}${stale ? " (may be out of date)" : ""}`);
    },
    onRetry: (detail, failures) => {
      say(
        chalk.dim(`  NEMAR answered with an error (${plain(detail)}); retrying (${failures})...`),
      );
    },
  });
  if (json) {
    const final: unknown = latest ?? lastAnswer;
    console.log(JSON.stringify(final, null, 2));
  }
  reportOutcome(outcome, jobId, json);
}
