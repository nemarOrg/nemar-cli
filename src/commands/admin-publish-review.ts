/**
 * `nemar admin publish show | start`: the automated review of a publication request, from the
 * administrator's side (ADR 0102, section 8).
 *
 *   nemar admin publish show <ds>            the review of the active request, in the Worker's words
 *   nemar admin publish start <ds>           start the review of the current screened commit
 *   nemar admin publish start --all          start every review that can be started
 *
 * Registered on the `publish` group by `admin-publish.ts`. Every sentence about a review comes
 * from the Worker (`describePublicationReview`), and `publication-review-display.ts` prints it;
 * this file decides nothing about a review. What it does decide is the exit code: 0 when the thing
 * asked for happened or already exists, 1 for everything else (#1581).
 */

import chalk from "chalk";
import type { Command } from "commander";
import ora from "ora";
import { reportFailure, say, signedIn } from "../lib/admin-output.js";
import { getPublicationReview } from "../lib/api/publish.js";
import { markReportedExit } from "../lib/debug-log.js";
import { reviewDetailLines } from "../lib/publication-review-display.js";
import { plain } from "../lib/terminal-text.js";

const DATASET_ID_RE = /^(nm|on|xx)\d{6}$/;

/** A dataset id typed on the command line, checked before anything is sent; null when it is not one. */
function checkedDataset(raw: string, json: boolean): string | null {
  if (DATASET_ID_RE.test(raw)) return raw;
  say(json)(chalk.red(`"${plain(raw)}" is not a dataset id (like nm000108).`));
  process.exitCode = 1;
  // The answer to what was typed, not a crash.
  markReportedExit();
  return null;
}

export function registerReviewCommands(group: Command): void {
  group
    .command("show")
    .description("Show the automated review of a publication request")
    .argument("<dataset-id>", "Dataset ID")
    .option("--json", "Output the detail as JSON instead of text")
    .addHelpText(
      "after",
      `
Description:
  Read the review of the dataset's active publication request: its identifier
  screen, then the review's outcome with every reason it is not a pass and what
  clears it, the four questions it asked, the facts the platform used to lower an
  answer, what the model found and said, the evidence it was given, what it was
  shown, any override on record, and the command to run next.

  The findings and the summary are written by the model, from text the depositor
  wrote, and are printed under labels that say so: they inform your decision and
  never make it. Whether a README names the depositors is not assessed.

Examples:
  $ nemar admin publish show nm000480
  $ nemar admin publish show nm000480 --json`,
    )
    .action(async (datasetArg: string, options: { json?: boolean }) => {
      const json = options.json === true;
      if (!signedIn(json)) return;
      const datasetId = checkedDataset(datasetArg, json);
      if (datasetId === null) return;

      const spinner = json ? null : ora("Reading the review...").start();
      try {
        const detail = await getPublicationReview(datasetId);
        spinner?.stop();
        if (json) {
          console.log(JSON.stringify(detail, null, 2));
          return;
        }
        console.log();
        for (const line of reviewDetailLines(detail)) console.log(line);
        console.log();
      } catch (error) {
        reportFailure(error, spinner, "Could not read the review", json);
      }
    });
}
