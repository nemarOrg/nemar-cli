/**
 * `nemar compute logs|results|cancel`: what a person does with a job they submitted (epic #2021 phase D3b,
 * #2024; ADR 0118, the amendment of phase D3). Registered on `computeCommand` (`./compute.ts`).
 *
 *   nemar compute logs <job> [--tail <n>]               the job's log (at most its first 1 MiB)
 *   nemar compute results <job> [--download <dir>] [--renew]   the files a finished job made
 *   nemar compute cancel <job> [--yes]                  stop a job
 *
 * Each takes `--json`: standard output is then ONLY the answer (for `results`, one document with every page
 * of files), and every sentence of failure is on standard error. Exit codes: 0 done, 1 NEMAR refused or
 * could not answer, or a file could not be downloaded and verified, 2 refused here before anything was sent.
 *
 * RESULTS ARE BEARER LINKS. Each link downloads one file for anyone who holds it until it expires (seven
 * days after it was made). So the human listing prints no link; `--download` uses them without showing
 * them; `--json` prints them because that is what was asked for; no link is written to any file the command
 * makes, and the debug log redacts a presigned address's signature. A download is sent with NO NEMAR
 * credential: the link is its own authority, and the API key never goes to the store.
 */

import { createHash } from "node:crypto";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, resolve, sep } from "node:path";
import chalk from "chalk";
import { Command } from "commander";
import inquirer from "inquirer";
import { formatBytesCli } from "../../shared/bytes.js";
import type { ComputeResultsResponse } from "../../shared/contract/compute-submit.js";
import { COMPUTE_JOB_ID_RE, isSafeComputePath } from "../../shared/contract/compute.js";
import { requireSignedIn } from "../lib/admin-command.js";
import {
  cancelComputeJob,
  getComputeLogs,
  getComputeResults,
  renewComputeResults,
} from "../lib/api/compute.js";
import { failCompute, refuseLocally } from "../lib/compute/fail.js";
import { plain } from "../lib/terminal-text.js";

interface JsonOption {
  json?: boolean;
}

const JSON_FLAG = ["--json", "Print only the answer, as JSON"] as const;

const JOB_ID_SENTENCE = "A job id is job_ and 24 lowercase hexadecimal digits.";

/** The job id, or null after refusing (exit 2). */
function checkedJob(raw: string): string | null {
  if (COMPUTE_JOB_ID_RE.test(raw)) return raw;
  refuseLocally([JOB_ID_SENTENCE]);
  return null;
}

// --- logs ---------------------------------------------------------------------------------------------------

/**
 * A job's log made safe for a terminal. It is the job's own output, so anything it prints can be in it,
 * including an escape sequence that rewrites the screen: control characters other than newline and tab,
 * and the invisible and direction-changing ones, are removed.
 */
export function plainLog(text: string): string {
  return text.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (ch) =>
    ch === "\n" || ch === "\t" ? ch : "",
  );
}

/** The last `n` lines of `text`. A final newline does not make an empty last line. */
export function lastLines(text: string, n: number): string {
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines.slice(-n).join("\n") + (text.endsWith("\n") && lines.length > 0 ? "\n" : "");
}

const LOGS_HELP = `
Description:
  Prints the log of one of your jobs (what the job wrote to its output): at most the FIRST 1 MiB, with a
  note on standard error when it was cut. A job that has not started has no log yet. A running job's log
  is read as it is now. --tail <n> keeps only the last n lines of what was returned.

  With --json standard output is { "job_id", "truncated", "text" } and nothing else.

Exit codes:
  0  the log was printed.
  1  you are not signed in, there is no such job of yours, it has no log yet, or NEMAR could not answer.
  2  the job id or --tail is not valid (nothing was sent).

Examples:
  $ nemar compute logs job_0123456789abcdef01234567
  $ nemar compute logs job_0123456789abcdef01234567 --tail 50`;

export const logsCommand = new Command("logs")
  .description("Print the log of a job")
  .argument("<job>", "The job id")
  .option("--tail <n>", "Only the last n lines")
  .option(...JSON_FLAG)
  .addHelpText("after", LOGS_HELP)
  .action(async (raw: string, o: JsonOption & { tail?: string }) => {
    const job = checkedJob(raw);
    if (job === null) return;
    let tail: number | undefined;
    if (o.tail !== undefined) {
      tail = /^[0-9]{1,9}$/.test(o.tail) ? Number(o.tail) : Number.NaN;
      if (!(tail >= 1)) {
        refuseLocally(["--tail is a whole number of lines, 1 or more."]);
        return;
      }
    }
    if (!requireSignedIn(o.json)) return;
    try {
      const log = await getComputeLogs(job);
      const text = tail === undefined ? log.text : lastLines(log.text, tail);
      if (o.json) {
        console.log(JSON.stringify({ job_id: job, truncated: log.truncated, text }, null, 2));
        return;
      }
      process.stdout.write(plainLog(text));
      if (text !== "" && !text.endsWith("\n")) process.stdout.write("\n");
      if (log.truncated) {
        console.error(
          chalk.dim(
            `The log was cut at 1 MiB: this is its beginning${tail === undefined ? "" : ", and --tail is of that part"}.`,
          ),
        );
      }
    } catch (error) {
      failCompute(error, "Could not read the log.");
    }
  });

// --- results ------------------------------------------------------------------------------------------------

type ResultFile = ComputeResultsResponse["files"][number];

/**
 * Whether a result path is one that may be written under the download folder: relative, no `..`, no empty
 * segment, no backslash or control character, no drive letter. A path NEMAR sends is checked again here:
 * the folder is the person's, and what is written into it is decided on this machine.
 */
export function safeResultPath(path: string): boolean {
  return isSafeComputePath(path, 1024) && !/^[A-Za-z]:/.test(path);
}

/** Every page of the results as one document; the links are the Worker's, unchanged. */
async function fetchAllResults(job: string, renew: boolean): Promise<ComputeResultsResponse> {
  const read = renew ? renewComputeResults : getComputeResults;
  let page = await read(job);
  const files = [...page.files];
  const seen = new Set<string>();
  while (page.truncated && page.next_after !== null && !seen.has(page.next_after)) {
    seen.add(page.next_after);
    page = await read(job, page.next_after);
    files.push(...page.files);
  }
  return { ...page, files, truncated: false, next_after: null };
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Download one file to `dir` and verify its size and SHA-256. Returns null on success, or a short reason. */
async function downloadOne(dir: string, file: ResultFile): Promise<"ok" | "skipped" | string> {
  if (!safeResultPath(file.path)) return "the path is not one that may be written";
  const root = resolve(dir);
  const dest = resolve(root, file.path);
  if (!dest.startsWith(root + sep)) return "the path leaves the download folder";
  if (existsSync(dest) && statSync(dest).isFile() && statSync(dest).size === file.size) {
    if (sha256File(dest) === file.sha256) return "skipped";
  }
  mkdirSync(dirname(dest), { recursive: true });
  const part = `${dest}.part`;
  try {
    // No credential of ours goes to the store: the link is the authority.
    const response = await fetch(file.url);
    if (!response.ok || response.body === null) return `HTTP ${response.status}`;
    const hash = createHash("sha256");
    const out = createWriteStream(part);
    let bytes = 0;
    let tooBig = false;
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.length;
        if (bytes > file.size) {
          tooBig = true;
          break;
        }
        hash.update(value);
        if (!out.write(value)) await new Promise<void>((r) => out.once("drain", () => r()));
      }
    } finally {
      await new Promise<void>((r) => out.end(() => r()));
    }
    if (tooBig) {
      rmSync(part, { force: true });
      return "the file is larger than NEMAR said";
    }
    if (bytes !== file.size || hash.digest("hex") !== file.sha256) {
      rmSync(part, { force: true });
      return "the size or checksum did not match";
    }
    renameSync(part, dest);
    return "ok";
  } catch {
    // The error text of a failed fetch can name the link, which is a bearer secret: it is not kept.
    rmSync(part, { force: true });
    return "the download failed";
  }
}

const RESULTS_HELP = `
Description:
  Lists the files a finished job made, and with --download <dir> fetches them into <dir>, checking each
  file's size and SHA-256 against what NEMAR recorded (a file that does not match is deleted and reported).
  A file already there with the same size and checksum is left alone.

  The links are BEARER links: anyone who holds one can download that file until it expires, seven days
  after it was made. This command prints no link unless you ask with --json; keep them private. --renew
  makes new links for the same files while the files still exist. Results are kept for a limited time
  after a job ends.

  With --json standard output is only NEMAR's answer, every page of files in one document.

Exit codes:
  0  the files were listed (and, with --download, all were fetched and verified).
  1  you are not signed in, there is no such finished job of yours, its results have expired, NEMAR could
     not answer, or a file could not be downloaded and verified.
  2  the job id is not valid (nothing was sent).

Examples:
  $ nemar compute results job_0123456789abcdef01234567
  $ nemar compute results job_0123456789abcdef01234567 --download ./results
  $ nemar compute results job_0123456789abcdef01234567 --renew --json`;

export const resultsCommand = new Command("results")
  .description("List, or download, the files a finished job made")
  .argument("<job>", "The job id")
  .option("--download <dir>", "Download the files into this folder, verifying each")
  .option("--renew", "Make new links for the same files")
  .option(...JSON_FLAG)
  .addHelpText("after", RESULTS_HELP)
  .action(async (raw: string, o: JsonOption & { download?: string; renew?: boolean }) => {
    const job = checkedJob(raw);
    if (job === null) return;
    if (!requireSignedIn(o.json)) return;
    let results: ComputeResultsResponse;
    try {
      results = await fetchAllResults(job, o.renew === true);
    } catch (error) {
      failCompute(error, "Could not read the results.");
      return;
    }
    const say = (line: string) => (o.json ? console.error(line) : console.log(line));
    if (o.json) console.log(JSON.stringify(results, null, 2));
    else {
      const total = results.files.reduce((n, f) => n + f.size, 0);
      console.log(
        `${chalk.bold(job)}: ${results.files.length} file${results.files.length === 1 ? "" : "s"}, ${formatBytesCli(total)}. Links expire ${plain(results.expires_at)}.`,
      );
      for (const f of results.files) {
        console.log(
          `  ${plain(f.path)}  ${formatBytesCli(f.size)}  sha256 ${plain(f.sha256).slice(0, 12)}`,
        );
      }
      console.log(chalk.dim(plain(results.notice)));
    }
    if (o.download === undefined) {
      if (!o.json && results.files.length > 0) {
        say(chalk.dim("Download them with: nemar compute results <job> --download <dir>"));
      }
      return;
    }
    let failed = 0;
    for (const file of results.files) {
      const outcome = await downloadOne(o.download, file);
      if (outcome === "ok") say(`  fetched   ${plain(file.path)}`);
      else if (outcome === "skipped") say(chalk.dim(`  already   ${plain(file.path)}`));
      else {
        failed++;
        console.error(chalk.red(`  FAILED    ${plain(file.path)}: ${plain(outcome)}`));
      }
    }
    if (failed > 0) {
      console.error(
        chalk.red(`${failed} of ${results.files.length} files could not be fetched and verified.`),
      );
      process.exitCode = 1;
    }
  });

// --- cancel -------------------------------------------------------------------------------------------------

const CANCEL_HELP = `
Description:
  Stops one of your jobs. A job that has not started is released and costs nothing; a job that is running
  is stopped and charged for the time it used. A job that has already ended is left as it is and the
  answer says so. It asks you to confirm; --yes skips the question (it is required with --json or when
  there is no terminal to ask).

Exit codes:
  0  the job was canceled, a cancel was recorded, or the job had already ended.
  1  you are not signed in, there is no such job of yours, you answered no, or NEMAR could not answer.
  2  the job id is not valid, or there is no terminal to ask and --yes was not given (nothing was sent).

Examples:
  $ nemar compute cancel job_0123456789abcdef01234567
  $ nemar compute cancel job_0123456789abcdef01234567 --yes --json`;

export const cancelCommand = new Command("cancel")
  .description("Cancel one of your jobs")
  .argument("<job>", "The job id")
  .option("--yes", "Do not ask first")
  .option(...JSON_FLAG)
  .addHelpText("after", CANCEL_HELP)
  .action(async (raw: string, o: JsonOption & { yes?: boolean }) => {
    const job = checkedJob(raw);
    if (job === null) return;
    if (o.yes !== true) {
      if (o.json || !process.stdin.isTTY) {
        refuseLocally(["There is no terminal to ask on: pass --yes to cancel the job."]);
        return;
      }
    }
    if (!requireSignedIn(o.json)) return;
    if (o.yes !== true) {
      const { confirmed } = await inquirer.prompt<{ confirmed: boolean }>([
        { type: "confirm", name: "confirmed", message: `Cancel job ${job}?`, default: false },
      ]);
      if (!confirmed) {
        console.error("Not canceled.");
        process.exitCode = 1;
        return;
      }
    }
    try {
      const answer = await cancelComputeJob(job);
      if (o.json) {
        console.log(JSON.stringify(answer, null, 2));
        return;
      }
      const state = answer.state === null ? "unknown" : plain(answer.state);
      if (answer.cancelled === false) {
        console.log(`Job ${job} had already ended (state ${state}); nothing was canceled.`);
      } else {
        console.log(`Cancel recorded for ${job} (state ${state}). It is carried out shortly.`);
      }
    } catch (error) {
      failCompute(error, "Could not cancel the job.");
    }
  });
