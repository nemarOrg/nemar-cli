/**
 * `nemar admin compute jobs`: an administrator's two commands on one compute job (epic #2005 phase A5,
 * #2010; ADR 0118). Phase A7 (#2012) extends this group.
 *
 *   nemar admin compute jobs cancel <id>    cancel a job: at Tapis, or here for a job that never started
 *   nemar admin compute jobs advance <id>   one step: submit a `created` job, or read a submitted one
 *                                           back from Tapis, or give a finished one what it is owed
 *
 * `advance` is how a job moves in development, where no compute cron runs. Both call the same code the
 * Worker's webhook, its 30-minute tick and a person's own cancel run. They print the job as the Worker
 * shows it to an administrator: fixed words, numbers and times, the four flags, and `platform failure`,
 * an information flag that says NEMAR caused the failure so that it can be compensated by a manual grant
 * (nothing is refunded automatically). Never an identity, a specification, a token or a log.
 *
 * A job id is `job_` and 24 lowercase hexadecimal digits, checked before anything is sent. Every command
 * takes `--json` (standard output stays pure JSON) and exits 1 on any failure.
 */

import { Command } from "commander";
import type {
  ComputeJobAdminResponse,
  ComputeJobView,
} from "../../shared/contract/compute-admin.js";
import { COMPUTE_JOB_ID_RE } from "../../shared/contract/compute.js";
import { formatSu } from "../../shared/contract/compute.js";
import { failMessage, failWith, requireSignedIn } from "../lib/admin-command.js";
import { advanceComputeJobAsAdmin, cancelComputeJobAsAdmin } from "../lib/api/compute.js";
import { plain } from "../lib/terminal-text.js";

const say = (line: string): void => console.log(line);

/** The job as lines for a terminal; everything the Worker sent is made plain first. */
function printJob(res: ComputeJobAdminResponse): void {
  const job: ComputeJobView | null = res.job;
  say(`outcome: ${plain(res.outcome)}${res.submit ? ` (submit: ${plain(res.submit)})` : ""}`);
  if (job === null) return;
  say(`job ${plain(job.id)}`);
  say(
    `  state: ${plain(job.state)}${job.tapis_status ? ` (Tapis ${plain(job.tapis_status)})` : ""}` +
      `${job.cancel_requested ? "  cancel requested" : ""}`,
  );
  if (job.failure_code) {
    say(
      `  failure: ${plain(job.failure_code)}${job.failure_detail ? ` / ${plain(job.failure_detail)}` : ""}`,
    );
    say(
      `  platform failure: ${job.platform_failure ? "yes (NEMAR caused it; compensate by a manual grant if warranted)" : "no"}`,
    );
  }
  say(`  partition: ${plain(job.partition)} (${plain(job.pool)})`);
  say(
    `  held ${formatSu(job.held_milli)} SU, charged ${formatSu(job.charged_milli)} SU, ${job.settled ? "settled" : "not settled"}`,
  );
  say(`  flags: ${job.flags.length > 0 ? job.flags.map(plain).join(", ") : "none"}`);
  say(
    `  results: upload ${job.outputs_completed ? "complete" : "not complete"}, ` +
      `${job.results_verified ? "verified" : "not verified"}, ` +
      `files ${job.records_copied ? "copied to the records" : "not copied yet"}`,
  );
  say(`  created ${plain(job.created_at)}${job.ended_at ? `, ended ${plain(job.ended_at)}` : ""}`);
}

/** A job id typed on the command line, or null after saying why (exit 1, nothing sent). */
function jobIdArg(id: string, json: boolean): string | null {
  if (COMPUTE_JOB_ID_RE.test(id)) return id;
  failMessage(`"${id}" is not a job id: it is job_ and 24 lowercase hexadecimal digits.`, {
    json,
    answered: true,
  });
  return null;
}

const CANCEL_HELP = `
Cancels one compute job. A job that never reached Tapis is ended here and its hold released; one that
did is cancelled AT TAPIS and becomes cancelled when Tapis says so, charged what it used. The intent is
recorded first, so a Tapis that cannot be reached now is asked again by the Worker's own sweep. A job
that has already ended, other than cancelled, is refused.

Admin or owner. --json prints the Worker's answer as it is.

Exit codes:
  0  the cancel was recorded (or the job was already cancelled).
  1  the id is not a job id, there is no such job, it has ended, or the Worker refused.`;

const ADVANCE_HELP = `
Takes one compute job one step, wherever it is: a created job is submitted to Tapis (once, whatever a
lost answer did), a submitted one is read back from Tapis and brought to the state Tapis shows, and a
finished one gets what it is still owed (its settlement, the copy of its files). The way a job moves in
development, where no compute cron runs. It does what the webhook and the 30-minute tick do, and no more.

The submit is refused while compute is switched off: a created job stays created (the answer is
"waiting", with submit compute_disabled), and everything else, a read-back, a settlement, a copy, still
happens, because a job that is already on a cluster is never stranded by the switch.

Admin or owner. --json prints the Worker's answer as it is.

Exit codes:
  0  the step was taken (or there was nothing to do); the outcome says which.
  1  the id is not a job id, there is no such job, or the Worker refused.`;

const jobsCommand = new Command("jobs").description("Cancel or advance one compute job (admin)");

jobsCommand
  .command("cancel <id>")
  .description("Cancel a compute job")
  .option("--json", "Print the Worker's answer as JSON")
  .addHelpText("after", CANCEL_HELP)
  .action(async (id: string, o: { json?: boolean }) => {
    const json = o.json === true;
    if (!requireSignedIn(json)) return;
    const jobId = jobIdArg(id, json);
    if (jobId === null) return;
    try {
      const res = await cancelComputeJobAsAdmin(jobId);
      if (json) console.log(JSON.stringify(res, null, 2));
      else printJob(res);
    } catch (err) {
      failWith(err, null, "Could not cancel the job.", undefined, { json });
    }
  });

jobsCommand
  .command("advance <id>")
  .description("Take a compute job one step on")
  .option("--json", "Print the Worker's answer as JSON")
  .addHelpText("after", ADVANCE_HELP)
  .action(async (id: string, o: { json?: boolean }) => {
    const json = o.json === true;
    if (!requireSignedIn(json)) return;
    const jobId = jobIdArg(id, json);
    if (jobId === null) return;
    try {
      const res = await advanceComputeJobAsAdmin(jobId);
      if (json) console.log(JSON.stringify(res, null, 2));
      else printJob(res);
    } catch (err) {
      failWith(err, null, "Could not advance the job.", undefined, { json });
    }
  });

export { jobsCommand };
