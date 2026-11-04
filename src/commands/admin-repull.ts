/**
 * `nemar admin repull`: an upstream re-pull of a mirrored dataset (ADR 0111, epic #1046).
 *
 *   nemar admin repull plan <id>   the read-only plan: what N.0.0 would hold, what N.0.1 would
 *                                  replay, what would be copied from which pinned upstream object
 *
 * What the plan reads: NEMAR's API (the dataset row and its version rows, two GETs made here
 * through the API client), OpenNeuro's latest snapshot tag (one GraphQL query, the import's own),
 * the administrator's GitHub token (`GH_TOKEN`, else `gh auth token`),
 * the GitHub REST API once (the open pull requests), git over HTTPS (which spends no REST quota),
 * the bucket's `annex-uuid` marker (one anonymous GET) and, with `--bucket-listing`, a listing of
 * `nemar-s3`'s prefix with the ambient AWS credentials. Everything after the two API reads and the
 * token goes through the planner's read-only guard (`lib/repull/read-only.ts`).
 *
 * What `plan` writes: nothing to the mirror, S3, D1 or the NEMAR API, except under
 * `--automatic-dispatch` (below), where the run reports its dispatch to the Worker, which stores
 * the state in D1. It writes a scratch directory, deleted on exit, on SIGINT and on SIGTERM unless
 * `--keep-workdir`, and the plan file, its output, mode 0600 in the administrator's config
 * directory.
 *
 *   nemar admin repull execute <plan-file>   the reviewed plan, executed on this machine through
 *                                            its pull request: record, prepare, copy, register,
 *                                            push, open (`lib/repull/execute/`); it never merges
 *   nemar admin repull status <id>           what the record says (`lib/repull/status.ts`)
 *   nemar admin repull resume <id>           past the open pull request: the head, main, the
 *                                            identifier screen and the gates, then after the
 *                                            merge the release and the lock (`lib/repull/
 *                                            resume.ts`); it never merges
 *   nemar admin repull merge <id>            the one merge gate (`lib/repull/merge.ts`)
 *   nemar admin repull abandon <id>          end an open record by hand: before N.0.0 merges
 *                                            `abandoned`, after its release `patch_declined`
 *                                            (`lib/repull/abandon.ts`)
 *   nemar admin repull auto                  the automatic re-pull as the Worker reads it: switches,
 *                                            caps, the scheduler, the open automatic re-pulls and the
 *                                            recent dispatches; read-only (`lib/repull/auto-view.ts`)
 *
 * `plan`, `execute` and `resume` also take `--automatic-dispatch <id>`: the unattended run of one
 * dispatch in the central `run-upstream-repull` workflow (`admin-repull-automatic.ts`).
 */

import chalk from "chalk";
import { Command, InvalidArgumentError } from "commander";
import { failMessage, requireSignedIn, say } from "../lib/admin-command.js";
import { getApiUrl } from "../lib/api/client.js";
import { ApiError, errorDetail } from "../lib/api/errors.js";
import { getConfigDir } from "../lib/config.js";
import { confirm } from "../lib/confirm.js";
import { markReportedExit, markUsageExit } from "../lib/debug-log.js";
import { adminGitHubToken, githubApiBase } from "../lib/pr-review-approve.js";
import { defaultPlanPath, planFileJson, writePlanFile } from "../lib/repull/digest.js";
import { EXECUTE_STATUSES } from "../lib/repull/execute/advance.js";
import { readCatalogFacts } from "../lib/repull/execute/catalog.js";
import { type ExecuteSummary, executeRepull } from "../lib/repull/execute/run.js";
import { ExecuteRefused } from "../lib/repull/execute/verify-plan.js";
import { type CatalogFacts, RepullCannotPlan, planRepull } from "../lib/repull/plan.js";
import { countsMarkdown, preflightLines, summaryLines } from "../lib/repull/render.js";
import { openNeuroGraphqlUrl as openNeuroUrlFromEnv } from "../lib/repull/sources.js";
import { abandonCommand } from "./admin-repull-abandon.js";
import { autoCommand } from "./admin-repull-auto.js";
import { AUTOMATIC_HELP, automaticExecute, automaticPlan } from "./admin-repull-automatic.js";
import { mergeCommand } from "./admin-repull-merge.js";
import { parseMinutes, resumeCommand, statusCommand } from "./admin-repull-resume.js";

/** Exit codes: 0 executable, 3 planned but not executable, 1 nothing planned. */
export const EXIT_NOT_EXECUTABLE = 3;

const PLAN_HELP = `
A dry run: it changes no dataset, no bucket and no record of a re-pull, except for the report an
unattended run (--automatic-dispatch, below) makes to the Worker. It compares upstream at the tag
NEMAR's latest version mirrors (from_tag) with upstream at --to-tag (default: OpenNeuro's latest
snapshot) and NEMAR's main, path by path.
A --to-tag that is not OpenNeuro's latest is planned, and is not executable: that it is newer
than from_tag cannot be proved (upstream's creation order decides, not the tag number).

It writes nothing to the mirror, S3, D1 or the NEMAR API, except under --automatic-dispatch (the
central workflow's run, below): that run reports its dispatch to the Worker, which stores the
state in D1 (started, then refused or failed if the run ends so). Its output is the plan file, written
with mode 0600 to --out or to $NEMAR_CONFIG_DIR/repull/<id>/<to>.<digest8>.json, where
NEMAR_CONFIG_DIR defaults to ~/.config/nemar. Clones go into a scratch directory that is deleted on
exit, on SIGINT and on SIGTERM unless --keep-workdir. Blobs of 1 MiB or more are fetched only when a
check needs them, up to --max-fetch-gb in total; a path whose bytes could not be read is unchecked,
and the plan is then not executable.

What NEMAR already holds comes from the git-annex location log; --bucket-listing reads a
listing of the bucket instead, with the ambient AWS credentials (aws s3api list-objects-v2).

--from-tag on a mirror whose tag is not recorded gives a dry run only: the plan is made and shown,
and is never executable. --from-tag that disagrees with the recorded tag refuses.

The default output holds counts and no path or key; --json prints the plan itself (it holds
paths, and a path can be an identifier); --counts prints the counts as Markdown for an issue.
--json and --counts cannot be combined.

Exit codes:
  0  the plan is executable.
  3  the plan was made and is not executable: a release-pr or annex-uuid check that is not ok,
     a version check that is refused or unchecked, from-tag-not-recorded (--from-tag on an
     unrecorded tag), a to-tag whose order is unverified, an unpinned key, or a plan
     refusal (the privacy ledger, a gitlink, a target that cannot be computed, a dead key,
     the fetch bound, a concept DOI that disagrees).
     Conflicts and corrections alone do not stop a plan: N.0.0 takes upstream's side and N.0.1
     replays NEMAR's corrections.
  1  nothing was planned: a usage error, a dataset that is not an OpenNeuro mirror, a from-tag or
     to-tag refusal (unknown, disagrees, malformed, latest-unknown, to-tag-unrecordable,
     mirror-lag, nothing-to-pull), a dataset never released, or a remote that could not be read.

${AUTOMATIC_HELP}`;

/** `--max-fetch-gb`: a non-negative number of GB. */
function parseGb(value: string): number {
  const gb = Number(value);
  if (value.trim() === "" || !Number.isFinite(gb) || gb < 0) {
    throw new InvalidArgumentError("a non-negative number of GB is required.");
  }
  return gb;
}

export const repullCommand = new Command("repull").description(
  "Plan and execute an upstream re-pull of a mirrored dataset (ADR 0111)",
);

repullCommand
  .command("plan <datasetId>")
  .description(
    "Plan a re-pull of a newer upstream snapshot as the next major version (read-only, except under --automatic-dispatch)",
  )
  .option("--to-tag <tag>", "The upstream tag to pull (default: OpenNeuro's latest snapshot)")
  .option(
    "--from-tag <tag>",
    "The upstream tag NEMAR mirrors, when it is not recorded (dry run only)",
  )
  .option("--out <file>", "Write the plan here instead of the default path")
  .option("--json", "Print the plan itself")
  .option("--counts", "Print the counts as Markdown, with no path or key")
  .option("--keep-workdir", "Keep the scratch clones and print where they are")
  .option("--max-fetch-gb <n>", "Bound on large blobs fetched for checks, in GB", parseGb, 5)
  .option(
    "--bucket-listing",
    "Read what NEMAR holds from a listing of the bucket (ambient AWS credentials), not the location log",
  )
  .option("--automatic-dispatch <id>", "The central workflow's unattended run of a dispatch")
  .addHelpText("after", PLAN_HELP)
  .action(
    async (
      datasetId: string,
      options: {
        toTag?: string;
        fromTag?: string;
        out?: string;
        json?: boolean;
        counts?: boolean;
        keepWorkdir?: boolean;
        maxFetchGb: number;
        bucketListing?: boolean;
        automaticDispatch?: string;
      },
    ) => {
      if (options.automaticDispatch !== undefined) {
        await automaticPlan(options.automaticDispatch, datasetId, options);
        return;
      }
      const json = options.json === true;
      const out = say(json);
      if (!requireSignedIn(json)) return;
      if (!/^[a-z]{2}\d{6}$/.test(datasetId)) {
        failMessage(`"${datasetId}" is not a dataset id (like on004362).`, {
          json,
          answered: true,
        });
        return;
      }
      if (json && options.counts) {
        failMessage("--json and --counts are two outputs; pass one of them.", {
          json,
          answered: true,
        });
        return;
      }

      // The two NEMAR API reads, outside the planner's guard (they are GETs through the API client).
      let catalog: CatalogFacts;
      try {
        catalog = await readCatalogFacts(datasetId);
      } catch (err) {
        failMessage(`Could not read ${datasetId} from the NEMAR API: ${errorDetail(err)}`, {
          json,
          answered: err instanceof ApiError,
        });
        return;
      }

      let apiBase: string;
      let openNeuroGraphqlUrl: string | undefined;
      try {
        apiBase = githubApiBase();
        openNeuroGraphqlUrl = openNeuroUrlFromEnv(process.env);
      } catch (err) {
        failMessage(errorDetail(err), { json, answered: true });
        return;
      }
      const token = await adminGitHubToken();
      if (!token.ok)
        out(chalk.dim(`No GitHub token (${token.reason}); release-pr will be unchecked.`));

      let outcome: Awaited<ReturnType<typeof planRepull>>;
      try {
        outcome = await planRepull({
          datasetId,
          toTag: options.toTag,
          fromTag: options.fromTag,
          maxFetchBytes: Math.floor(options.maxFetchGb * 1024 ** 3),
          keepWorkdir: options.keepWorkdir === true,
          catalog,
          github: { token: token.ok ? token.token : null, apiBase },
          environment: getApiUrl(),
          presence: options.bucketListing ? "bucket-listing" : "location-log",
          openNeuroGraphqlUrl,
        });
      } catch (err) {
        failMessage(
          err instanceof RepullCannotPlan
            ? `Could not plan: ${err.message}`
            : `Planning failed: ${errorDetail(err)}`,
          { json, answered: err instanceof RepullCannotPlan },
        );
        return;
      }

      if (outcome.workdir) out(`Scratch clones kept at ${outcome.workdir}`);
      if (!outcome.planned) {
        if (json) {
          console.log(
            JSON.stringify(
              { planned: false, reason: outcome.reason, preflight: outcome.preflight },
              null,
              2,
            ),
          );
        } else {
          console.log(`Nothing was planned for ${datasetId}: ${outcome.reason}.`);
          console.log("Preflight:");
          for (const line of preflightLines(outcome.preflight)) console.log(line);
        }
        process.exitCode = 1;
        markReportedExit();
        return;
      }

      const file = outcome.file;
      const toTag = String((file.body.upstream as { to_tag: string }).to_tag);
      const path = options.out ?? defaultPlanPath(getConfigDir(), datasetId, toTag, file.digest);
      try {
        writePlanFile(path, file);
      } catch (err) {
        failMessage(`The plan was made but could not be written to ${path}: ${errorDetail(err)}`, {
          json,
          answered: false,
        });
        return;
      }
      if (json) {
        process.stdout.write(planFileJson(file));
      } else if (options.counts) {
        process.stdout.write(countsMarkdown(file));
        out(`Plan file: ${path}`);
      } else {
        for (const line of summaryLines(file, path)) console.log(line);
      }
      if (!file.executable) {
        process.exitCode = EXIT_NOT_EXECUTABLE;
        markReportedExit();
      }
    },
  );

/** Exit code of `execute`: stopped resumable, the record left as it was with why on it. */
export const EXIT_RESUMABLE = 3;

const EXECUTE_HELP = `
Executes a plan made by \`nemar admin repull plan\` and reviewed, on this machine, with your own
GitHub token (GH_TOKEN, else \`gh auth token\`) and the ambient short-lived AWS credentials:

  planned     the record (POST /admin/repulls), after the plan is made again from live sources
              and found to be the reviewed one (its digest), and executable now;
  prepared    the delta materialized in a working clone, scrubbed (ADR 0089, ADR 0091), and
              synthesized into one commit; scrubbed recordings uploaded to <id>/objects/;
  copied      every key the commit names that the plan copies, copied from upstream's bucket at
              the version upstream pinned (aws s3api copy-object ?versionId=);
  registered  the keys recorded at nemar-s3 on NEMAR's git-annex branch, after a listing shows
              every one present at its size;
  pr_open     release/v<N.0.0> pushed and its pull request into main opened.

A dataset has one open re-pull at a time. When it has one of another plan, execute refuses
(repull-in-flight) unless --supersede: then, when that record is yours (not the automatic path's),
for another tag pulled from the same from_tag, and before its merge, this plan is proved and made
again from live sources first, and only then is the old record's pull request closed, its
release branch deleted and the record ended superseded, before this one is recorded.

It never merges: a merge mints a version DOI that cannot be withdrawn. Past pr_open,
\`nemar admin repull resume <id>\` takes the record through the identifier screen and the gates,
and \`nemar admin repull merge <id>\` squash-merges it with a message that ends with the commit's two
trailers, under the daily merge cap. --until stops after a status; a later run takes the record
up where it stopped.

The working directory, $NEMAR_CONFIG_DIR/repull/<id>/work/<digest8>/ (mode 0700), holds the
delta's unscrubbed originals in a local commit until the pull request is open; it is removed then
unless --keep-workdir.

Exit codes:
  0  the requested point was reached (pr_open, or --until).
  3  stopped, resumable: the record is as it was, with why in its last_error; run execute again
     after fixing the cause (past pr_open, run resume), or end the record with
     \`nemar admin repull abandon <id>\`.
  1  refused before anything was written (the plan, the dataset, a declined confirmation), or
     failed.

${AUTOMATIC_HELP} With it, execute settles the release head before it reports the
pull request open: it reads the branch until enrichment has not moved it for five minutes, at most
--settle-minutes (default 30), recording each move enrichment made and refusing any other.`;

/** `--until`: one of the statuses execution stops at. */
function parseUntil(value: string): (typeof EXECUTE_STATUSES)[number] {
  if (!(EXECUTE_STATUSES as readonly string[]).includes(value)) {
    throw new InvalidArgumentError(`one of ${EXECUTE_STATUSES.join(", ")} is required.`);
  }
  return value as (typeof EXECUTE_STATUSES)[number];
}

/** What a run does, up to and including `until` (what it writes, and where it stops). */
function confirmActions(s: ExecuteSummary): string {
  const at = EXECUTE_STATUSES.indexOf(s.until as (typeof EXECUTE_STATUSES)[number]);
  const parts: string[] = [];
  if (at >= EXECUTE_STATUSES.indexOf("prepared")) {
    parts.push("prepare it in a working clone and upload scrubbed recordings to NEMAR's bucket");
  }
  if (at >= EXECUTE_STATUSES.indexOf("copied")) {
    parts.push(`copy up to ${s.copyItems} object(s) from upstream by version`);
  }
  if (at >= EXECUTE_STATUSES.indexOf("registered")) {
    parts.push("register the keys on NEMAR's git-annex branch");
  }
  if (at >= EXECUTE_STATUSES.indexOf("pr_open")) {
    parts.push(`push release/v${s.toVersion} and open its pull request`);
  }
  if (parts.length === 0) return `record the re-pull and stop at ${s.until}`;
  return `${parts.join(", ")}, and stop at ${s.until}`;
}

/** The question asked before anything is written. */
export function confirmQuestion(s: ExecuteSummary): string {
  const where =
    s.status === null
      ? `Execute the re-pull of ${s.datasetId}, upstream ${s.fromTag} to ${s.toTag}, as v${s.toVersion}`
      : `Continue the re-pull of ${s.datasetId} (${s.fromTag} to ${s.toTag}, v${s.toVersion}) from ${s.status}`;
  const first = s.supersedes
    ? `First supersede re-pull #${s.supersedes.id} (to ${s.supersedes.toTag}, ${s.supersedes.status}): close its pull request${s.supersedes.prNumber ? ` #${s.supersedes.prNumber}` : ""}, delete its release branch, and end it superseded; what its copy wrote stays in the bucket. Then: `
    : "";
  return `${first}${where}: ${confirmActions(s)}. Execute never merges; a merge will mint ${s.doiCount} version DOI(s), which cannot be withdrawn. Proceed?`;
}

repullCommand
  .command("execute <planFile>")
  .description("Execute a reviewed re-pull plan through its pull request (never merges)")
  .option(
    "--until <status>",
    `Stop after this status (${EXECUTE_STATUSES.join(", ")})`,
    parseUntil,
    "pr_open" as const,
  )
  .option("--keep-workdir", "Keep the working directory after the pull request is open")
  .option(
    "--normalize-max-gb <n>",
    "Bound on bytes this machine downloads and uploads for the scrub, in GB",
    parseGb,
  )
  .option("--max-fetch-gb <n>", "The planner's bound on large blobs fetched, in GB", parseGb, 5)
  .option(
    "--supersede",
    "End the dataset's open re-pull of an older tag (yours, before its merge) as superseded first",
  )
  .option("-y, --yes", "Do not ask before writing")
  .option("--json", "Print the record as JSON")
  .option("--automatic-dispatch <id>", "The central workflow's unattended run of a dispatch")
  .option(
    "--settle-minutes <n>",
    "With --automatic-dispatch: how long to settle the release head at most (default 30)",
    parseMinutes,
  )
  .addHelpText("after", EXECUTE_HELP)
  .action(
    async (
      planFile: string,
      options: {
        until: (typeof EXECUTE_STATUSES)[number];
        keepWorkdir?: boolean;
        normalizeMaxGb?: number;
        maxFetchGb: number;
        supersede?: boolean;
        yes?: boolean;
        json?: boolean;
        automaticDispatch?: string;
        settleMinutes?: number;
      },
    ) => {
      if (options.automaticDispatch !== undefined) {
        await automaticExecute(options.automaticDispatch, planFile, options);
        return;
      }
      const json = options.json === true;
      const out = say(json);
      if (options.settleMinutes !== undefined) {
        failMessage("--settle-minutes is for --automatic-dispatch only.", { json, answered: true });
        markUsageExit();
        return;
      }
      if (!requireSignedIn(json)) return;
      try {
        const { row, stoppedAt } = await executeRepull({
          planPath: planFile,
          until: options.until,
          supersede: options.supersede === true,
          keepWorkdir: options.keepWorkdir === true,
          ...(options.normalizeMaxGb !== undefined
            ? { normalizeMaxBytes: Math.floor(options.normalizeMaxGb * 1024 ** 3) }
            : {}),
          maxFetchBytes: Math.floor(options.maxFetchGb * 1024 ** 3),
          ...(options.yes
            ? {}
            : {
                confirm: async (summary: ExecuteSummary) =>
                  (await confirm(confirmQuestion(summary), { yes: false })) === "confirmed",
              }),
          out: (line) => out(line),
        });
        if (json) {
          console.log(JSON.stringify({ repull: row, stopped_at: stoppedAt }, null, 2));
        } else {
          console.log(
            `Re-pull #${row.id} of ${row.dataset_id} is ${row.status}${row.pr_number ? `: pull request #${row.pr_number} of ${row.branch}` : ""}.`,
          );
        }
      } catch (err) {
        if (err instanceof ExecuteRefused) {
          failMessage(`Refused (${err.code}): ${err.message}`, { json, answered: true });
          for (const line of err.lines) out(line);
          if (err.resumable) process.exitCode = EXIT_RESUMABLE;
          return;
        }
        failMessage(`Execution failed: ${errorDetail(err)}`, { json, answered: false });
      }
    },
  );

repullCommand.addCommand(statusCommand);
repullCommand.addCommand(resumeCommand);
repullCommand.addCommand(mergeCommand);
repullCommand.addCommand(abandonCommand);
repullCommand.addCommand(autoCommand);
