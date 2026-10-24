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
 * What it writes: nothing to the mirror, S3, D1 or the NEMAR API. It writes a scratch directory,
 * deleted on exit, on SIGINT and on SIGTERM unless `--keep-workdir`, and the plan file, its output,
 * mode 0600 in the administrator's config directory. `nemar admin repull execute` is Phase 6.
 */

import chalk from "chalk";
import { Command, InvalidArgumentError } from "commander";
import { failMessage, requireSignedIn, say } from "../lib/admin-command.js";
import { getApiUrl } from "../lib/api/client.js";
import { getDataset, getVersionHistory } from "../lib/api/datasets.js";
import { ApiError, errorDetail } from "../lib/api/errors.js";
import { getConfigDir } from "../lib/config.js";
import { markReportedExit } from "../lib/debug-log.js";
import { adminGitHubToken, githubApiBase } from "../lib/pr-review-approve.js";
import { defaultPlanPath, planFileJson, writePlanFile } from "../lib/repull/digest.js";
import { type CatalogFacts, RepullCannotPlan, planRepull } from "../lib/repull/plan.js";
import { countsMarkdown, preflightLines, summaryLines } from "../lib/repull/render.js";
import { openNeuroGraphqlUrl as openNeuroUrlFromEnv } from "../lib/repull/sources.js";

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
     unrecorded tag), a to-tag whose order is unverified, an unpinned key, or a plan refusal (the privacy ledger, a gitlink, a target
     that cannot be computed, a dead key, the fetch bound, a concept DOI that disagrees).
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
  "Plan an upstream re-pull of a mirrored dataset (ADR 0111); read-only",
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
      // A 404 on the versions route (a backend without it) leaves the rows unknown; it is never
      // read as "no rows".
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
