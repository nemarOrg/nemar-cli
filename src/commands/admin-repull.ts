/**
 * `nemar admin repull`: an upstream re-pull of a mirrored dataset (ADR 0111, epic #1046).
 *
 *   nemar admin repull plan <id>   the read-only plan: what N.0.0 would hold, what N.0.1 would
 *                                  replay, what would be copied from which pinned upstream object
 *
 * The plan reads NEMAR's API (the dataset row and its version rows, two GETs), the GitHub REST API
 * once (the open pull requests), and git over HTTPS, which spends no REST quota. It writes nothing
 * anywhere but a scratch directory, deleted on exit unless `--keep-workdir`, and the plan file
 * (mode 0600). `nemar admin repull execute` is Phase 6.
 */

import chalk from "chalk";
import { Command } from "commander";
import { failMessage, requireSignedIn, say } from "../lib/admin-command.js";
import { getApiUrl } from "../lib/api/client.js";
import { getDataset, getVersionHistory } from "../lib/api/datasets.js";
import { ApiError, errorDetail } from "../lib/api/errors.js";
import { getConfigDir } from "../lib/config.js";
import { markReportedExit } from "../lib/debug-log.js";
import { adminGitHubToken, githubApiBase } from "../lib/pr-review-approve.js";
import { defaultPlanPath, planFileJson, writePlanFile } from "../lib/repull/digest.js";
import {
  type CatalogFacts,
  DEFAULT_MAX_FETCH_BYTES,
  RepullCannotPlan,
  planRepull,
} from "../lib/repull/plan.js";
import { countsMarkdown, preflightLines, summaryLines } from "../lib/repull/render.js";

/** Exit codes: 0 executable, 3 planned but not executable, 1 could not plan. */
export const EXIT_NOT_EXECUTABLE = 3;

const PLAN_HELP = `
A dry run, always. It compares upstream at the tag NEMAR's latest version mirrors (from_tag)
with upstream at --to-tag (default: the mirror's highest tag) and NEMAR's main, path by path, and
writes the plan to --out or $NEMAR_CONFIG_DIR/repull/<id>/<to>.<digest8>.json (mode 0600).

Nothing is written to GitHub, S3 or the NEMAR API. Clones go into a scratch directory that is
deleted on exit unless --keep-workdir. Blobs of 1 MiB or more are fetched only when a check needs
them, up to --max-fetch-gb in total; past that a path counts as unexplained.

What NEMAR already holds comes from the git-annex location log; --bucket-listing reads a
listing of the bucket instead, with the ambient AWS credentials (aws s3api list-objects-v2).

--from-tag on a mirror whose tag is not recorded gives a dry run only: the plan is made and shown,
and is never executable. --from-tag that disagrees with the recorded tag refuses.

The default output holds counts and no path or key; --json prints the plan itself (it holds
paths, and a path can be an identifier). --counts prints the counts as Markdown for an issue.

Exit codes: 0 the plan is executable, 3 it was made but is not executable (a refusal, an
unpinned key, or a preflight check that is not ok), 1 nothing could be planned.`;

export const repullCommand = new Command("repull").description(
  "Plan an upstream re-pull of a mirrored dataset (ADR 0111); read-only",
);

repullCommand
  .command("plan <datasetId>")
  .description("Plan a re-pull of a newer upstream snapshot as the next major version (read-only)")
  .option("--to-tag <tag>", "The upstream tag to pull (default: the mirror's highest)")
  .option(
    "--from-tag <tag>",
    "The upstream tag NEMAR mirrors, when it is not recorded (dry run only)",
  )
  .option("--out <file>", "Write the plan here instead of the default path")
  .option("--json", "Print the plan itself")
  .option("--counts", "Print the counts as Markdown, with no path or key")
  .option("--keep-workdir", "Keep the scratch clones and print where they are")
  .option("--max-fetch-gb <n>", "Bound on large blobs fetched for checks", "5")
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
        maxFetchGb?: string;
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
      const gb = Number(options.maxFetchGb ?? "5");
      if (!Number.isFinite(gb) || gb < 0) {
        failMessage(`--max-fetch-gb must be a number of GB, not "${options.maxFetchGb}".`, {
          json,
          answered: true,
        });
        return;
      }

      // The two NEMAR API reads. A 404 on the versions route (a dev worker, or a dataset with no
      // rows the caller may read) leaves the rows unknown; it is never read as "no rows".
      let catalog: CatalogFacts;
      try {
        let dataset: CatalogFacts["dataset"] = null;
        try {
          dataset = await getDataset(datasetId);
        } catch (err) {
          if (!(err instanceof ApiError && err.statusCode === 404)) throw err;
        }
        let versions: CatalogFacts["versions"] = null;
        if (dataset) {
          try {
            const history = await getVersionHistory(datasetId);
            versions = history.versions.map((v) => ({
              version: v.version,
              source_version: v.source_version ?? null,
              source_version_basis: v.source_version_basis ?? null,
            }));
          } catch (err) {
            if (!(err instanceof ApiError && err.statusCode === 404)) throw err;
          }
        }
        catalog = { dataset, versions };
      } catch (err) {
        failMessage(`Could not read ${datasetId} from the NEMAR API: ${errorDetail(err)}`, {
          json,
          answered: err instanceof ApiError,
        });
        return;
      }

      let apiBase: string;
      try {
        apiBase = githubApiBase();
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
          maxFetchBytes: gb === 5 ? DEFAULT_MAX_FETCH_BYTES : Math.floor(gb * 1024 ** 3),
          keepWorkdir: options.keepWorkdir === true,
          catalog,
          github: { token: token.ok ? token.token : null, apiBase },
          environment: getApiUrl(),
          presence: options.bucketListing ? "bucket-listing" : "location-log",
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
