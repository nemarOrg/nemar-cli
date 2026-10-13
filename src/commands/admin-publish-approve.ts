/**
 * `nemar admin publish approve`: approve a publication request and run the orchestrator.
 *
 * Its own file, registered on the `publish` group at the end of `admin-publish.ts`, so the work
 * that follows (the review, the override, `next`) edits this command without editing the group.
 */

import chalk from "chalk";
import type { Command } from "commander";
import ora from "ora";
import {
  PUBLICATION_STEPS,
  PUBLICATION_STEP_LABELS,
  stepsForRelease,
} from "../../shared/publication-steps.js";
import { failWith, requireSignedIn } from "../lib/admin-command.js";
import {
  type PublishProgressInfo,
  type StepResult,
  approvePublication,
  getPublishStatus,
} from "../lib/api/publish.js";
import {
  type ConfirmOptions,
  NO_DESCRIPTION,
  NO_OPTION,
  YES_DESCRIPTION,
  YES_OPTION,
  confirm,
} from "../lib/confirm.js";
import { markReportedExit } from "../lib/debug-log.js";

export function registerApproveCommand(group: Command): void {
  group
    .command("approve")
    .description("Approve and publish a dataset (runs orchestrator)")
    .argument("<dataset-id>", "Dataset ID")
    .option("--resume", "Resume from last failed step")
    .option("--sandbox", "Use Zenodo sandbox for testing")
    .option("--skip-ci-check", "Skip BIDS validation CI check (admin override)")
    .option(
      "--acknowledge-identifier-screen <reason>",
      "Approve over an identifier screen that needs review, recording why (10 to 500 characters)",
    )
    .option(YES_OPTION, YES_DESCRIPTION)
    .option(NO_OPTION, NO_DESCRIPTION)
    .addHelpText(
      "after",
      `
Description:
  Approve a publication request and run the automated orchestrator
  to make the dataset publicly accessible with a permanent DOI.

  The request's IDENTIFIER SCREEN must allow it first. A clean screen passes.
  A screen that needs review, or could not look at everything, passes only with
  --acknowledge-identifier-screen "<reason>", which is recorded with your name.
  Direct identifiers cannot be acknowledged: the depositor fixes the data and
  requests again. A screen that did not run or did not report must be re-run
  with 'nemar admin publish screen <dataset-id>', and so must one whose commit
  is no longer the repository's main. 'nemar admin publish list' shows it.

  An ANONYMOUS RELEASE runs a smaller step set: the GitHub repository stays
  private, no identifier is published, and the depositor is not named. The
  confirmation banner reads the pending request and lists what will actually
  run, so approve one and read the banner rather than this list.

  WARNING: This action is PERMANENT. Published datasets cannot be unpublished.
  Once a DOI is assigned, it is permanent and cannot be deleted.

Orchestrator Steps (execution order; shared/publication-steps.ts):
   1. CI Check          - Verify BIDS validation passes, deploy workflows if missing
   2. Enrichment Check  - Verify metadata pipeline has run (warn-only, non-blocking)
   3. S3 Public Read    - Grant public read access to S3 data
   4. Repo Public       - Publish the catalog row; for an ordinary publication
                          this also makes the GitHub repository public, and for
                          an anonymous release the repository stays private
   5. Tag Protection    - Enable tag protection rules
   6. Create DOI        - Create concept DOI via EZID (or Zenodo if configured)
   7. Update Metadata   - Update dataset metadata from BIDS description
   8. Update README     - Add DOI badge and citation info to README
   9. Create Tag        - Create version tag (e.g., v1.0.0)
  10. Create Release    - Create GitHub release from tag
  11. Upload to Zenodo  - Legacy Zenodo upload (disabled; kept for step history)
  12. Publish DOI       - Make DOI public and findable (permanent, irreversible)
  13. Version DOI       - Mint the version DOI and dispatch the manifest job,
                          which is what records the version. Runs for an
                          anonymous release too, minting RESERVED (#1447)
  14. S3 Lock           - Enable S3 Object Lock (prevents data deletion)
  15. Sync NEMAR        - Legacy nemar.org sync (no-op, retired)
  16. Notify User       - Send publication confirmation email

  (Archive zip generation is not an orchestrator step; the version-DOI
  workflow dispatches it separately.)

  Steps 7, 8, 11 and 12 are skipped for an anonymous release: each one either
  publishes an identifier or writes one into a file the data plane serves
  publicly. See ANONYMOUS_RELEASE_SKIPPED_STEPS in shared/publication-steps.ts,
  which states the reason for each.

Resume Capability:
  If a step fails, the orchestrator saves progress. Use --resume to retry
  from the failed step without re-running successful steps.

  The orchestrator is idempotent - safe to run multiple times. Completed
  steps are automatically skipped.

Examples:
  $ nemar admin publish approve nm000104                    # Run full orchestrator
  $ nemar admin publish approve nm000104 --resume           # Resume from failed step
  $ nemar admin publish approve nm000104 --skip-ci-check    # Override BIDS validation
  $ nemar admin publish approve nm000104 --yes              # Skip confirmation

After Approval:
  - User receives email with DOI and public dataset link
  - Dataset is publicly visible on GitHub
  - Tags are protected (prevents version manipulation)
  - Data is protected by S3 Object Lock`,
    )
    .action(
      async (
        datasetId,
        options: ConfirmOptions & {
          resume?: boolean;
          sandbox?: boolean;
          skipCiCheck?: boolean;
          acknowledgeIdentifierScreen?: string;
        },
      ) => {
        if (!requireSignedIn()) return;

        const ack = options.acknowledgeIdentifierScreen?.trim();
        if (ack !== undefined && (ack.length < 10 || ack.length > 500)) {
          console.log(
            chalk.red("--acknowledge-identifier-screen needs a reason of 10 to 500 characters."),
          );
          process.exitCode = 1;
          markReportedExit();
          return;
        }

        const action = options.resume
          ? `Resume publication of ${datasetId}`
          : `Approve and publish ${datasetId}`;
        console.log(chalk.cyan(`\n${action}\n`));

        // Ask the server what this request IS before describing what approving
        // it will do (#1447). An anonymous release runs a strictly smaller step
        // set, and the banner used to be a hand-numbered literal of all sixteen:
        // an admin approving one was told the repository would be made public
        // and the DOI published irreversibly, and neither happens. A banner that
        // describes the wrong operation is worse than no banner, because it is
        // the screen the decision is made from.
        let anonymousRelease = false;
        let planUnknownReason: string | null = null;
        try {
          anonymousRelease = (await getPublishStatus(datasetId)).anonymous === true;
        } catch (err) {
          // Unreadable state is not a reason to refuse an approval the admin can
          // still make, but it IS a reason to stop asserting what will happen --
          // and to say WHY. A bare `catch {}` here printed "could not read the
          // request's state" for an expired key, a 404 and a network failure
          // alike, which is three different next actions rendered as one.
          planUnknownReason = err instanceof Error ? err.message : String(err);
        }

        const steps = stepsForRelease(anonymousRelease);
        if (planUnknownReason === null) {
          console.log(
            anonymousRelease
              ? `This is an ANONYMOUS RELEASE and will run ${steps.length} of the ${PUBLICATION_STEPS.length} orchestrator steps:`
              : `This will run the following ${steps.length}-step orchestrator:`,
          );
        } else {
          console.log(
            chalk.yellow(
              `Could not read the request's state (${planUnknownReason}), so this lists all ${steps.length} steps; an anonymous release runs fewer.`,
            ),
          );
        }
        // Two columns, generated from the step list rather than typed out, so
        // adding a step cannot leave the banner describing the old publication.
        const half = Math.ceil(steps.length / 2);
        for (let i = 0; i < half; i++) {
          const left = steps[i];
          const right = steps[i + half];
          const label = (step: (typeof steps)[number], n: number): string => {
            const text =
              step === "doi_create" && options.sandbox
                ? `${PUBLICATION_STEP_LABELS[step]} (SANDBOX)`
                : PUBLICATION_STEP_LABELS[step];
            return `${String(n).padStart(2, " ")}. ${text}`;
          };
          const leftCell = label(left, i + 1).padEnd(34, " ");
          console.log(`   ${leftCell}${right ? label(right, i + half + 1) : ""}`.trimEnd());
        }
        if (anonymousRelease) {
          console.log();
          console.log(
            chalk.yellow("  The GitHub repository stays PRIVATE and no identifier is published:"),
          );
          console.log(
            chalk.yellow(
              "  the concept and version DOIs stay reserved until the deposit is published for real.",
            ),
          );
        }
        console.log();

        // Sandbox warning
        if (options.sandbox) {
          console.log(chalk.yellow("━".repeat(60)));
          console.log(chalk.yellow.bold("                 SANDBOX MODE ENABLED"));
          console.log(chalk.yellow("━".repeat(60)));
          console.log(chalk.yellow("  • DOI will be created in sandbox mode (EZID test shoulder)"));
          console.log(chalk.yellow("  • DOI will NOT be indexed by DataCite"));
          console.log(chalk.yellow("  • DOI will NOT resolve in production"));
          console.log(chalk.yellow("  • Use this for testing workflows only"));
          console.log(chalk.yellow("━".repeat(60)));
          console.log();
        }

        const confirmResult = await confirm(`${action}?`, options);
        if (confirmResult !== "confirmed") {
          console.log(chalk.dim(confirmResult === "declined" ? "Skipped" : "Cancelled"));
          // Nothing was approved, and a script that asked for an approval has to be able to tell.
          // The administrator's own answer is not a crash, so no bug-report hint.
          process.exitCode = 1;
          markReportedExit();
          return;
        }

        const initialSpinnerText = "Running publication workflow (this may take a few minutes)...";
        const spinner = ora(initialSpinnerText).start();

        // Most recent step label rendered into the spinner; kept on the
        // outer scope so onRetry can restore the same line after the
        // retry notice instead of falling back to the generic text.
        let currentSpinnerText = initialSpinnerText;

        /**
         * Render the spinner line for a progress event. Shows the step
         * position and, for s3_lock, a running locked/total ratio so the
         * admin can see thousands-of-objects datasets making progress
         * instead of staring at a static spinner for minutes. See #284.
         */
        function renderProgress(info: PublishProgressInfo): string {
          const stepLabel = info.step.replace(/_/g, " ");
          const head = `Step ${info.stepIndex}/${info.stepTotal}: ${stepLabel}`;
          if (
            info.step === "s3_lock" &&
            info.s3LockLocked !== undefined &&
            info.s3LockTotal !== undefined &&
            info.s3LockTotal > 0
          ) {
            const pct = ((info.s3LockLocked / info.s3LockTotal) * 100).toFixed(1);
            const resumeSuffix = info.s3LockResumed ? " (resumed)" : "";
            return `${head} | Locking S3 objects: ${info.s3LockLocked}/${info.s3LockTotal} (${pct}%)${resumeSuffix}`;
          }
          if (info.step === "s3_lock" && info.s3LockLocked !== undefined) {
            // Total not yet known (rare; first response before server has
            // counted). Show running count without the denominator so the
            // line still advances.
            const resumeSuffix = info.s3LockResumed ? " (resumed)" : "";
            return `${head} | Locking S3 objects: ${info.s3LockLocked}${resumeSuffix}`;
          }
          return head;
        }

        try {
          const result = await approvePublication(
            datasetId,
            !!options.resume,
            !!options.sandbox,
            !!options.skipCiCheck,
            (info) => {
              // Surface transient failures the CLI is about to retry. We pause
              // the spinner so the message isn't overwritten, then resume it.
              spinner.stop();
              const stepLabel = info.step ? info.step.replace(/_/g, " ") : "step";
              console.log(chalk.yellow(`  [!] ${stepLabel} failed: ${info.error}`));
              console.log(
                chalk.dim(
                  `  Retrying in ${Math.round(info.delayMs / 1000)}s (attempt ${info.attempt + 1}/${info.maxAttempts})...`,
                ),
              );
              spinner.start(currentSpinnerText);
            },
            (info) => {
              currentSpinnerText = renderProgress(info);
              spinner.text = currentSpinnerText;
            },
            ack,
          );
          spinner.succeed(result.message);

          // Display step-by-step results if available
          if (result.step_results && result.step_results.length > 0) {
            console.log();
            const allSteps = result.step_results;
            const totalSteps = allSteps.length;
            allSteps.forEach((sr: StepResult, idx: number) => {
              const stepNum = `[${String(idx + 1).padStart(2, " ")}/${totalSteps}]`;
              const stepName = sr.step.replace(/_/g, " ");
              if (sr.status === "completed") {
                const durationSec = (sr.duration_ms / 1000).toFixed(1);
                const retryNote = sr.attempts > 1 ? ` (attempt ${sr.attempts})` : "";
                console.log(
                  `  ${chalk.green("[x]")} ${chalk.dim(stepNum)} ${stepName} ${chalk.dim(`(${durationSec}s${retryNote})`)}`,
                );
              } else if (sr.status === "failed") {
                console.log(
                  `  ${chalk.red("[!]")} ${chalk.dim(stepNum)} ${stepName}${sr.error ? `: ${chalk.red(sr.error)}` : ""}`,
                );
              } else {
                console.log(
                  `  ${chalk.dim("[-]")} ${chalk.dim(stepNum)} ${chalk.dim(stepName)} ${chalk.dim("(skipped)")}`,
                );
              }
            });
            console.log();
          } else if (result.steps_completed) {
            // Fallback for responses without step_results
            console.log();
            for (const step of result.steps_completed) {
              console.log(`  ${chalk.green("[x]")} ${step.replace(/_/g, " ")}`);
            }
            console.log();
          }

          // Surface non-fatal orchestrator warnings (e.g. notify_user email
          // failure) so operators know to follow up without re-running.
          if (result.warning) {
            console.log(chalk.yellow(`  Warning: ${result.warning}`));
          }
        } catch (error) {
          failWith(error, spinner, "Failed to approve publication", {
            422: "Fix the CI issues and retry with --resume",
          });

          // After all retries fail, surface the per-attempt step timeline the
          // retry loop attached to the error so the admin sees which step
          // failed when, instead of just the final 500 message.
          const stepResults = (error as { stepResults?: StepResult[] }).stepResults;
          if (stepResults && stepResults.length > 0) {
            console.log();
            console.log(chalk.dim("Step timeline (last attempt):"));
            const totalSteps = stepResults.length;
            stepResults.forEach((sr, idx) => {
              const stepNum = `[${String(idx + 1).padStart(2, " ")}/${totalSteps}]`;
              const stepName = sr.step.replace(/_/g, " ");
              const durationSec = (sr.duration_ms / 1000).toFixed(1);
              const retryNote = sr.attempts > 1 ? ` (attempt ${sr.attempts})` : "";
              if (sr.status === "completed") {
                console.log(
                  `  ${chalk.green("[x]")} ${chalk.dim(stepNum)} ${stepName} ${chalk.dim(`(${durationSec}s${retryNote})`)}`,
                );
              } else if (sr.status === "failed") {
                console.log(
                  `  ${chalk.red("[!]")} ${chalk.dim(stepNum)} ${stepName}${sr.error ? `: ${chalk.red(sr.error)}` : ""}`,
                );
              } else {
                console.log(
                  `  ${chalk.dim("[-]")} ${chalk.dim(stepNum)} ${chalk.dim(stepName)} ${chalk.dim("(skipped)")}`,
                );
              }
            });
            console.log();
          }
        }
      },
    );
}
