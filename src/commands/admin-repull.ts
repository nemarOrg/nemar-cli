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
 * What `plan` writes: nothing to the mirror, S3, D1 or the NEMAR API. It writes a scratch
 * directory, deleted on exit, on SIGINT and on SIGTERM unless `--keep-workdir`, and the plan file,
 * its output, mode 0600 in the administrator's config directory. `execute` and `canary` do write,
 * to the places their entries below name.
 *
 *   nemar admin repull execute <plan-file>   the reviewed plan, executed on this machine through
 *                                            its pull request: record, prepare, copy, register,
 *                                            push, open (`lib/repull/execute/`); it never merges
 *   nemar admin repull status <id>           what the record says (`lib/repull/status.ts`)
 *   nemar admin repull resume <id>           past the open pull request: the head, main, the
 *                                            identifier screen and the gates (`lib/repull/
 *                                            resume.ts`); it never merges
 *   nemar admin repull canary                the real-bucket check of the copy's S3 calls on a
 *                                            scratch prefix (`lib/repull/canary.ts`)
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
import {
  canaryArgsProblem,
  canaryCalls,
  parseCanarySource,
  runCanary,
} from "../lib/repull/canary.js";
import { defaultPlanPath, planFileJson, writePlanFile } from "../lib/repull/digest.js";
import { EXECUTE_STATUSES } from "../lib/repull/execute/advance.js";
import { readCatalogFacts } from "../lib/repull/execute/catalog.js";
import { type ExecuteSummary, executeRepull } from "../lib/repull/execute/run.js";
import { ExecuteRefused } from "../lib/repull/execute/verify-plan.js";
import { type CatalogFacts, RepullCannotPlan, planRepull } from "../lib/repull/plan.js";
import { countsMarkdown, preflightLines, summaryLines } from "../lib/repull/render.js";
import { openNeuroGraphqlUrl as openNeuroUrlFromEnv } from "../lib/repull/sources.js";
import { resumeCommand, statusCommand } from "./admin-repull-resume.js";

/** Exit codes: 0 executable, 3 planned but not executable, 1 nothing planned. */
export const EXIT_NOT_EXECUTABLE = 3;

const PLAN_HELP = `
A dry run, always. It compares upstream at the tag NEMAR's latest version mirrors (from_tag)
with upstream at --to-tag (default: OpenNeuro's latest snapshot) and NEMAR's main, path by path.
A --to-tag that is not OpenNeuro's latest is planned, and is not executable: that it is newer
than from_tag cannot be proved (upstream's creation order decides, not the tag number).

It writes nothing to the mirror, S3, D1 or the NEMAR API. Its output is the plan file, written
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
     mirror-lag, nothing-to-pull), a dataset never released, or a remote that could not be read.`;

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
  .description("Plan a re-pull of a newer upstream snapshot as the next major version (read-only)")
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
      },
    ) => {
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

It never merges: a merge mints a version DOI that cannot be withdrawn. The re-pull merge path is
not built yet, so the pull request is merged by an administrator once the identifier screen and
the gates pass, with a squash message that ends with the pull request body's two trailers.
--until stops after a status; a later run takes the record up where it stopped.

The working directory, $NEMAR_CONFIG_DIR/repull/<id>/work/<digest8>/ (mode 0700), holds the
delta's unscrubbed originals in a local commit until the pull request is open; it is removed then
unless --keep-workdir.

Exit codes:
  0  the requested point was reached (pr_open, or --until).
  3  stopped, resumable: the record is as it was, with why in its last_error; run execute again
     after fixing the cause. Resuming past pr_open and abandoning a re-pull are not built yet.
  1  refused before anything was written (the plan, the dataset, a declined confirmation), or
     failed.`;

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
  return `${where}: ${confirmActions(s)}. Execute never merges; a merge will mint ${s.doiCount} version DOI(s), which cannot be withdrawn. Proceed?`;
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
  .option("-y, --yes", "Do not ask before writing")
  .option("--json", "Print the record as JSON")
  .addHelpText("after", EXECUTE_HELP)
  .action(
    async (
      planFile: string,
      options: {
        until: (typeof EXECUTE_STATUSES)[number];
        keepWorkdir?: boolean;
        normalizeMaxGb?: number;
        maxFetchGb: number;
        yes?: boolean;
        json?: boolean;
      },
    ) => {
      const json = options.json === true;
      const out = say(json);
      if (!requireSignedIn(json)) return;
      try {
        const { row, stoppedAt } = await executeRepull({
          planPath: planFile,
          until: options.until,
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

const CANARY_HELP = `
Checks, against the real buckets, the S3 calls the copy step makes: a copy by version id from
upstream's bucket, a multipart copy in 5 MiB parts, the copies' sizes and ETag, a staging-shaped
key, and deletes by version id that leave the prefix empty (list-object-versions). Run it before
the first production re-pull; only stand-ins have answered these calls otherwise.

--prefix must be nm099999/repull-canary-<word>/ or xx<090001 to 099899>/repull-canary-<word>/,
a scratch prefix; it is never a dataset's objects/ or staging/, nor one of the permanent exemplar
fleet (xx099900 to xx099999). --bucket must be nemar. A dry run (the default) makes no call and
prints the calls --execute would make. It never locks and never bypasses a lock. It uses the
ambient short-lived AWS credentials (ASIA keys), as the copy does.

Exit codes: 0 every step passed (or a dry run); 1 a step failed or the arguments were refused.`;

repullCommand
  .command("canary")
  .description("Check the re-pull's S3 calls against the real buckets on a scratch prefix")
  .requiredOption(
    "--prefix <prefix>",
    "nm099999/repull-canary-<word>/ or xx<090001 to 099899>/repull-canary-<word>/",
  )
  .requiredOption("--source <object>", "A small upstream object: <ds>/<path>@<versionId>")
  .requiredOption(
    "--multipart-source <object>",
    "An upstream object over 10 MiB: <ds>/<path>@<versionId>",
  )
  .option("--bucket <bucket>", "NEMAR's bucket", "nemar")
  .option("--region <region>", "NEMAR's bucket's region", "us-east-2")
  .option("--execute", "Make the calls (a write to the real bucket)")
  .option("--json", "Print the steps as JSON")
  .addHelpText("after", CANARY_HELP)
  .action(
    async (options: {
      prefix: string;
      source: string;
      multipartSource: string;
      bucket: string;
      region: string;
      execute?: boolean;
      json?: boolean;
    }) => {
      const json = options.json === true;
      const out = say(json);
      const single = parseCanarySource(options.source);
      const multipart = parseCanarySource(options.multipartSource);
      if (!single || !multipart) {
        failMessage(
          "--source and --multipart-source take <ds>/<path>@<versionId>; a version id may hold only letters, digits, '.', '_' and '-' (the guard refuses any other character).",
          { json, answered: true },
        );
        markUsageExit();
        return;
      }
      const args = {
        prefix: options.prefix,
        single,
        multipart,
        bucket: options.bucket,
        region: options.region,
      };
      const problem = canaryArgsProblem(args);
      if (problem) {
        failMessage(`Refused: ${problem}.`, {
          json,
          answered: true,
        });
        markUsageExit();
        return;
      }
      if (!options.execute) {
        if (json) {
          console.log(JSON.stringify({ dry_run: true, calls: canaryCalls(args) }, null, 2));
        } else {
          console.log("Dry run; --execute makes these calls:");
          for (const call of canaryCalls(args)) console.log(`  ${call}`);
        }
        return;
      }
      const result = await runCanary({ ...args, env: process.env, out });
      if (json) console.log(JSON.stringify(result, null, 2));
      else
        console.log(result.ok ? "The canary passed." : "The canary FAILED; see the steps above.");
      if (!result.ok) {
        process.exitCode = 1;
        markReportedExit();
      }
    },
  );

repullCommand.addCommand(statusCommand);
repullCommand.addCommand(resumeCommand);
