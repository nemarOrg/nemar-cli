/**
 * Local patch for nemarOrg/nemar-cli#2140: on a resumed upload of a dataset that already
 * exists, integrate the remote's main into the git-annex adjusted branch BEFORE the identifier
 * preflight and the BIDS validation, so the tree those gates read is the tree that is pushed.
 * NEMAR's pipeline commits to main after every validated push, so a later batch otherwise
 * ends in `[rejected] (fetch first)` after its whole copy.
 *
 * This step weakens no NEMAR gate: validation, the identifier preflight, the attestation,
 * publication and the CLI version check all run after it, unchanged, on the integrated tree.
 * Nothing is pushed and nothing is forced here.
 */

import chalk from "chalk";
import { readLocalConfig } from "../dataset-config.js";
import {
  describeIntegrationFailure,
  integrateRemoteIntoAdjustedBranch,
} from "../git-annex/clone-push.js";
import { getCurrentBranch } from "../git-annex/repo-state.js";
import { runCommand } from "../git-annex/run-command.js";
import { FAIL, type Step, ok } from "./types.js";

export type PreValidationIntegration =
  | "skipped-new-dataset"
  | "skipped-dry-run"
  | "skipped-not-adjusted"
  | "skipped-no-remote"
  | "skipped-fetch-failed"
  | "no-remote-branch"
  | "up-to-date"
  | "integrated";

/**
 * Integrate `<remote>/<base>` into the current adjusted branch when the dataset already
 * exists (`.nemar/config.json` present). A fetch failure only warns: the push step retries
 * and fails loud if it must. A conflict (or any merge failure) stops the upload with the
 * paths named and the tree left as it was.
 */
export async function integrateRemoteBeforeValidationStep(
  absolutePath: string,
  options: { dryRun?: boolean },
  remoteName = "origin",
): Promise<Step<PreValidationIntegration>> {
  if (!readLocalConfig(absolutePath)) return ok("skipped-new-dataset");
  if (options.dryRun) {
    console.log(chalk.dim(`  Dry run: ${remoteName} is not fetched or merged`));
    return ok("skipped-dry-run");
  }
  const current = await getCurrentBranch(absolutePath);
  if (!current || !current.startsWith("adjusted/")) return ok("skipped-not-adjusted");
  const remote = await runCommand(["git", "remote", "get-url", remoteName], {
    cwd: absolutePath,
    sensitiveOutput: true,
  });
  if (remote.exitCode !== 0) return ok("skipped-no-remote");

  const baseBranch = current.replace(/^adjusted\//, "").replace(/\(.*\)$/, "");
  console.log(chalk.dim(`  Integrating ${remoteName}/${baseBranch} before validation...`));
  const result = await integrateRemoteIntoAdjustedBranch(
    absolutePath,
    remoteName,
    current,
    baseBranch,
  );
  if (result.success) {
    if (result.outcome === "integrated") {
      console.log(
        chalk.green(
          `  ${remoteName}/${baseBranch} integrated (git annex merge); validating that tree`,
        ),
      );
    }
    return ok(result.outcome);
  }
  if (result.kind === "fetch") {
    console.log(chalk.yellow(`  Could not fetch ${remoteName}: ${result.error}`));
    console.log(chalk.yellow("  Continuing; the push step integrates and retries."));
    return ok("skipped-fetch-failed");
  }
  console.log(
    chalk.red(`  ${remoteName}/${baseBranch} could not be integrated before validation:`),
  );
  console.log(chalk.red(`  ${describeIntegrationFailure(result)}`));
  console.log(chalk.yellow("  Nothing was uploaded or pushed. Resolve the conflict, then re-run."));
  return FAIL;
}
