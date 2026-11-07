/**
 * `nemar compute balance|limits|queue|list|status`: what a person reads about their own compute (epic #2021
 * phase D2, #2023; ADR 0118, the addendum of that phase). Registered on `computeCommand` (`./compute.ts`).
 *
 *   nemar compute balance           access, and each pool: granted, held, charged and available SU
 *   nemar compute limits            the partitions offered and their ceilings, and the other limits
 *   nemar compute queue             how long jobs have waited to start lately, per partition
 *   nemar compute list              your jobs, newest first   [--state <state>] [--limit <n>] [--all]
 *   nemar compute status <job>      one job
 *
 * All five READ: `GET /compute/me`, `/compute/me/jobs` and `/compute/me/jobs/:id`. They work in every access
 * state, so a person without a grant sees why (and how to ask for one), and they work with compute switched
 * off, because they read what the ledger already holds. Money is service units (SU) with three decimals
 * (`12.500`), formed from whole thousandths with integer arithmetic; nothing is rounded or floated. Every
 * string that came from the network passes `plain()`. With `--json`, standard output is exactly the
 * Worker's answer (for `list --all`, one document with every page's jobs), and any sentence goes to
 * standard error. Every command exits 1 on any failure: not signed in, a refusal, or a read that could not
 * be made (never an empty answer in its place).
 */

import chalk from "chalk";
import { Command } from "commander";
import { COMPUTE_STATES } from "../../shared/compute-state.js";
import { ACCOUNT_COPY } from "../../shared/contract/account-copy.js";
import {
  COMPUTE_JOBS_PAGE_DEFAULT,
  COMPUTE_JOBS_PAGE_MAX,
  type ComputeUserJob,
} from "../../shared/contract/compute-user.js";
import { COMPUTE_JOB_ID_RE } from "../../shared/contract/compute.js";
import { failMessage, failWith, requireSignedIn } from "../lib/admin-command.js";
import { getComputeMe, getMyComputeJob, listMyComputeJobs } from "../lib/api/compute.js";
import { plain } from "../lib/terminal-text.js";

// --- Formatting ------------------------------------------------------------------------------------

/** Whole milli-SU as SU with exactly three decimals: 12500 is `12.500`, -500 is `-0.500`. Integer math only. */
export function suFixed(milli: number): string {
  if (!Number.isSafeInteger(milli)) throw new RangeError("an amount is a whole number of milli-SU");
  const abs = Math.abs(milli);
  const whole = Math.floor(abs / 1000);
  const fraction = String(abs % 1000).padStart(3, "0");
  return `${milli < 0 ? "-" : ""}${whole}.${fraction}`;
}

/** Seconds as `38s`, `4m 12s`, `1h 5m`. */
export function durationText(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

/** Minutes as `45m`, `2h`, `1h 30m`. */
function minutesText(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

const pad = (text: string, width: number) => text.padEnd(width);

function stateLabel(state: string): string {
  const key = `compute_access.state.${state}` as keyof typeof ACCOUNT_COPY;
  return plain(key in ACCOUNT_COPY ? ACCOUNT_COPY[key] : state);
}

/** What a person in this state should read next, in the words the website uses. */
function stateNote(state: string): string | null {
  switch (state) {
    case "none":
      return ACCOUNT_COPY["cli.compute_access.cta"];
    case "requested":
      return ACCOUNT_COPY["compute_access.requested.lede"];
    case "suspended":
      return ACCOUNT_COPY["compute_access.suspended.body"];
    case "denied":
    case "revoked":
      return ACCOUNT_COPY["compute_access.closed.body"];
    default:
      return null;
  }
}

function jobLine(job: ComputeUserJob): string {
  const when = plain(job.created_at);
  const charged = job.charged_milli > 0 ? `${suFixed(job.charged_milli)} SU` : "-";
  return [
    pad(plain(job.id), 29),
    pad(plain(job.state), 11),
    pad(plain(job.partition), 13),
    pad(plain(job.source), 9),
    pad(when, 20),
    charged,
  ].join(" ");
}

const JOB_HEADER = [
  pad("JOB", 29),
  pad("STATE", 11),
  pad("PARTITION", 13),
  pad("SOURCE", 9),
  pad("CREATED (UTC)", 20),
  "CHARGED",
].join(" ");

// --- Shared command plumbing -------------------------------------------------------------------------

interface JsonOption {
  json?: boolean;
}

const JSON_FLAG = ["--json", "Print the Worker's answer as JSON"] as const;

/** Run a read: signed in first, then the body; any failure prints once and exits 1. */
async function run(o: JsonOption, failure: string, body: () => Promise<void>): Promise<void> {
  const json = o.json === true;
  if (!requireSignedIn(json)) return;
  try {
    await body();
  } catch (err) {
    failWith(err, null, failure, undefined, { json });
  }
}

// --- balance ---------------------------------------------------------------------------------------------

const BALANCE_HELP = `
Description:
  Shows your compute access and, for each pool (cpu and gpu), the service units (SU) granted to you, held
  for jobs that have not finished, charged so far, and still available. Available is granted minus held
  minus charged and can be negative after an overrun. Amounts are SU with three decimals.

  It works in every access state: without a grant it says so and how to ask for one.

Exit codes:
  0  the balance was read.
  1  you are not signed in, or the balance could not be read (nothing is printed in its place).

Examples:
  $ nemar compute balance
  $ nemar compute balance --json`;

export const balanceCommand = new Command("balance")
  .description("Show your compute access and balance")
  .option(...JSON_FLAG)
  .addHelpText("after", BALANCE_HELP)
  .action(async (o: JsonOption) => {
    await run(o, "Could not read your compute balance.", async () => {
      const me = await getComputeMe();
      if (o.json) {
        console.log(JSON.stringify(me, null, 2));
        return;
      }
      console.log(`${chalk.bold("Compute access:")} ${stateLabel(me.access.state)}`);
      const note = stateNote(me.access.state);
      if (note) console.log(chalk.dim(`  ${plain(note)}`));
      // A frozen pool is the reason for a refusal only while access is held: for every other state the
      // note above already says why (paused, answered, not asked), and "an admin can lift it" would be
      // the wrong thing to tell a person whose access ended.
      if (me.frozen && me.access.state === "active") {
        console.log(
          chalk.yellow(
            "  Your pools are frozen, so new jobs are refused. Contact support to find out why.",
          ),
        );
      }
      console.log("");
      console.log(
        chalk.dim(
          `${pad("POOL", 6)} ${pad("GRANTED", 14)} ${pad("HELD", 14)} ${pad("CHARGED", 14)} AVAILABLE`,
        ),
      );
      for (const word of ["cpu", "gpu"] as const) {
        const pool = me.pools[word];
        console.log(
          `${pad(word, 6)} ${pad(suFixed(pool.granted_milli), 14)} ${pad(suFixed(pool.held_milli), 14)} ${pad(
            suFixed(pool.charged_milli),
            14,
          )} ${suFixed(pool.available_milli)}`,
        );
      }
      console.log(chalk.dim("\nAmounts are service units (SU)."));
    });
  });

// --- limits ----------------------------------------------------------------------------------------------

const LIMITS_HELP = `
Description:
  Shows what one job may ask for on each partition offered to you (nodes, cores per node, GPUs per node
  and the longest run), how many jobs you may have created, queued or running at once, and how long your
  results are kept.

Exit codes:
  0  the limits were read.
  1  you are not signed in, or the limits could not be read.

Examples:
  $ nemar compute limits
  $ nemar compute limits --json`;

export const limitsCommand = new Command("limits")
  .description("Show the partitions offered to you and your limits")
  .option(...JSON_FLAG)
  .addHelpText("after", LIMITS_HELP)
  .action(async (o: JsonOption) => {
    await run(o, "Could not read your compute limits.", async () => {
      const me = await getComputeMe();
      if (o.json) {
        console.log(JSON.stringify(me, null, 2));
        return;
      }
      console.log(
        `${chalk.bold("Jobs at once:")} ${me.limits.max_live_jobs} created, queued or running`,
      );
      console.log(`${chalk.bold("Results kept:")} ${me.limits.results_days} days`);
      console.log("");
      console.log(
        chalk.dim(
          `${pad("PARTITION", 14)} ${pad("POOL", 5)} ${pad("NODES", 6)} ${pad("CORES/NODE", 11)} ${pad("GPUS/NODE", 10)} LONGEST RUN`,
        ),
      );
      for (const p of me.limits.partitions) {
        console.log(
          `${pad(plain(p.name), 14)} ${pad(plain(p.pool), 5)} ${pad(String(p.max_nodes), 6)} ${pad(
            String(p.max_cores_per_node),
            11,
          )} ${pad(String(p.max_gpus_per_node), 10)} ${minutesText(p.max_minutes)}`,
        );
      }
      if (me.limits.partitions.length === 0) console.log("No partition is offered right now.");
    });
  });

// --- queue -----------------------------------------------------------------------------------------------

const QUEUE_HELP = `
Description:
  Shows, for each partition offered to you, how long jobs have waited between being submitted to the
  scheduler and starting: the median and the 90th percentile over the jobs that started in the last 7
  days. With fewer than 5 such jobs there is no estimate, only the count. It describes the whole platform's
  queue, not yours, and it is a recent average, not a promise.

Exit codes:
  0  the estimates were read.
  1  you are not signed in, or they could not be read.

Examples:
  $ nemar compute queue
  $ nemar compute queue --json`;

export const queueCommand = new Command("queue")
  .description("Show recent queue waits per partition")
  .option(...JSON_FLAG)
  .addHelpText("after", QUEUE_HELP)
  .action(async (o: JsonOption) => {
    await run(o, "Could not read the queue estimates.", async () => {
      const me = await getComputeMe();
      if (o.json) {
        console.log(JSON.stringify(me, null, 2));
        return;
      }
      console.log(
        chalk.dim(
          `${pad("PARTITION", 14)} ${pad("MEDIAN", 10)} ${pad("90TH PERCENTILE", 16)} JOBS`,
        ),
      );
      for (const q of me.queue) {
        const enough = q.median_seconds !== null && q.p90_seconds !== null;
        console.log(
          `${pad(plain(q.partition), 14)} ${pad(
            enough ? durationText(q.median_seconds as number) : "-",
            10,
          )} ${pad(enough ? durationText(q.p90_seconds as number) : "-", 16)} ${q.count}${
            enough ? "" : " (too few for an estimate)"
          }`,
        );
      }
      console.log(
        chalk.dim(`\nJobs that started in the last ${me.queue[0]?.window_days ?? 7} days.`),
      );
    });
  });

// --- list ------------------------------------------------------------------------------------------------

interface ListOptions extends JsonOption {
  state?: string;
  limit?: string;
  all?: boolean;
}

const LIST_HELP = `
Description:
  Lists your compute jobs, newest first, from every front door (this command line, the website and a
  partner site). By default one page of ${COMPUTE_JOBS_PAGE_DEFAULT}; --limit sets the page size (1 to ${COMPUTE_JOBS_PAGE_MAX}) and --all
  reads every page. --state keeps one state (${COMPUTE_STATES.join(", ")}).

Exit codes:
  0  the list was read (an empty list is a list).
  1  you are not signed in, an option is not valid, or the list could not be read.

Examples:
  $ nemar compute list
  $ nemar compute list --state running
  $ nemar compute list --all --json`;

export const listCommand = new Command("list")
  .description("List your compute jobs")
  .option("--state <state>", "Only jobs in this state")
  .option(
    "--limit <n>",
    `Jobs per page (1-${COMPUTE_JOBS_PAGE_MAX}, default ${COMPUTE_JOBS_PAGE_DEFAULT})`,
  )
  .option("--all", "Read every page")
  .option(...JSON_FLAG)
  .addHelpText("after", LIST_HELP)
  .action(async (o: ListOptions) => {
    const json = o.json === true;
    if (o.state !== undefined && !(COMPUTE_STATES as readonly string[]).includes(o.state)) {
      failMessage(`--state is one of ${COMPUTE_STATES.join(", ")}.`, { json, answered: true });
      return;
    }
    let limit: number | undefined;
    if (o.limit !== undefined) {
      limit = /^[0-9]{1,9}$/.test(o.limit) ? Number(o.limit) : Number.NaN;
      if (!(limit >= 1 && limit <= COMPUTE_JOBS_PAGE_MAX)) {
        failMessage(`--limit is a whole number from 1 to ${COMPUTE_JOBS_PAGE_MAX}.`, {
          json,
          answered: true,
        });
        return;
      }
    }
    await run(o, "Could not read your compute jobs.", async () => {
      const jobs: ComputeUserJob[] = [];
      let after: string | undefined;
      let next: string | null = null;
      // One page, or every page with --all (the cursor is opaque: it is passed back as given).
      do {
        const page = await listMyComputeJobs({
          ...(o.state === undefined ? {} : { state: o.state }),
          ...(limit === undefined ? {} : { limit }),
          ...(after === undefined ? {} : { after }),
        });
        jobs.push(...page.jobs);
        next = page.next_after;
        after = next ?? undefined;
      } while (o.all === true && next !== null);
      if (json) {
        console.log(JSON.stringify({ jobs, next_after: o.all === true ? null : next }, null, 2));
        return;
      }
      if (jobs.length === 0) {
        console.log("No jobs.");
        return;
      }
      console.log(chalk.dim(JOB_HEADER));
      for (const job of jobs) console.log(jobLine(job));
      if (next !== null) {
        console.log(chalk.dim("\nMore jobs exist: use --all, or --limit for a larger page."));
      }
    });
  });

// --- status ----------------------------------------------------------------------------------------------

const STATUS_HELP = `
Description:
  Shows one of your jobs: its state, where it runs, what it asked for, when it was created, started and
  ended, what it was charged, and the failure code of a job that failed. A job that is running is read
  back from the cluster when the stored record is more than a minute old; if that cannot be done the stored
  record is shown and the output says it may be out of date.

  <job> is the job id, like job_0123456789abcdef01234567.

Exit codes:
  0  the job was read.
  1  you are not signed in, the id is not a job id, there is no such job of yours, or it could not be read.

Examples:
  $ nemar compute status job_0123456789abcdef01234567
  $ nemar compute status job_0123456789abcdef01234567 --json`;

export const statusCommand = new Command("status")
  .description("Show one of your compute jobs")
  .argument("<job>", "The job id")
  .option(...JSON_FLAG)
  .addHelpText("after", STATUS_HELP)
  .action(async (jobId: string, o: JsonOption) => {
    const json = o.json === true;
    if (!COMPUTE_JOB_ID_RE.test(jobId)) {
      failMessage("A job id is job_ and 24 lowercase hexadecimal digits.", {
        json,
        answered: true,
      });
      return;
    }
    await run(o, "Could not read that job.", async () => {
      const res = await getMyComputeJob(jobId);
      if (json) {
        console.log(JSON.stringify(res, null, 2));
        return;
      }
      const job = res.job;
      const r = job.resources;
      const row = (label: string, value: string) =>
        console.log(`${chalk.bold(pad(`${label}:`, 11))} ${value}`);
      row("Job", plain(job.id));
      row("State", plain(job.state) + (job.cancel_requested ? " (cancel requested)" : ""));
      row("Source", plain(job.source));
      row("Partition", `${plain(job.partition)} (${plain(job.pool)})`);
      row(
        "Resources",
        `${r.nodes} node${r.nodes === 1 ? "" : "s"}, ${r.cores_per_node} cores each${
          r.gpus > 0 ? `, ${r.gpus} GPU${r.gpus === 1 ? "" : "s"}` : ""
        }${r.memory_mb !== null ? `, ${r.memory_mb} MB` : ""}, up to ${minutesText(r.minutes)}`,
      );
      row("Created", `${plain(job.created_at)} UTC`);
      row("Started", job.started_at ? `${plain(job.started_at)} UTC` : "-");
      row("Ended", job.ended_at ? `${plain(job.ended_at)} UTC` : "-");
      row("Charged", `${suFixed(job.charged_milli)} SU`);
      if (job.failure_code) row("Failure", plain(job.failure_code));
      if (res.stale === true) {
        console.log(
          chalk.yellow("\nThis may be out of date: the cluster could not be asked just now."),
        );
      }
    });
  });
