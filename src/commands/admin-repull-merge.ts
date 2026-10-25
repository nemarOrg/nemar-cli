/**
 * `nemar admin repull merge <id>`: merge an upstream re-pull's pull request, as the administrator,
 * through the one gate `nemar admin pr-reviews` also merges re-pulls through (`lib/repull/merge.ts`;
 * ADR 0111, decisions 6 and 7; ADR 0093). It squash-merges at the screened head with a message
 * that ends with the re-pull commit's trailers, under one unit of the day's merge cap, and mints
 * one version DOI. Registered on `repullCommand` by `admin-repull.ts`.
 */

import { Command } from "commander";
import { failMessage, requireSignedIn, say } from "../lib/admin-command.js";
import { getCurrentUser } from "../lib/api/auth.js";
import { ApiError, errorDetail } from "../lib/api/errors.js";
import { getConfigDir } from "../lib/config.js";
import { confirm } from "../lib/confirm.js";
import { markReportedExit } from "../lib/debug-log.js";
import {
  adminGitHubToken,
  githubApiBase,
  identityMatches,
  whoAmI,
} from "../lib/pr-review-approve.js";
import {
  type GateContext,
  type MergeOutcome,
  checkRepullMerge,
  sendRepullMerge,
} from "../lib/repull/merge.js";
import { EXIT_WAITING, datasetArg } from "./admin-repull-resume.js";

const MERGE_HELP = `
Merges the dataset's re-pull pull request with your own GitHub login (GH_TOKEN, else \`gh auth
token\`), once its record is gates_clear (\`nemar admin repull resume <id>\` gets it there). Before
anything is written it checks that the pull request is open at the screened head, that NEMAR's main
moved by enrichment only, that the automated review of that head allows it (one that failed, is
running or cannot be read needs --force), that the identifier screen of that head passes, that
GitHub reports the pull request clean, and that the squash message carries the re-pull commit's
two trailers as its last paragraph. Then it asks (one irreversible version DOI; --yes answers),
claims one unit of today's re-pull merge cap, squash-merges at the screened commit (GitHub refuses
a head that moved since), and records the merge.

A claim already held for the screened head (a merge whose answer was lost) is used again: the merge
is sent under it, without a second claim.

Exit codes:
  0  merged.
  3  the merge was claimed and its outcome is unknown, or GitHub did not merge it and the claim is
     kept for now: run resume (which reads GitHub) or merge again.
  1  refused before anything was written (not ready, the review, the screen, main, GitHub's
     state, the cap, a declined confirmation), or failed.`;

/** The administrator's GitHub credential, a person's and the one linked to their account. */
async function adminToken(base: string): Promise<{ token: string; login: string } | string> {
  const token = await adminGitHubToken();
  if (!token.ok) return `No GitHub token: ${token.reason}`;
  const me = await whoAmI(token.token, base);
  if (!me.ok) return me.reason;
  let linked: string | null;
  try {
    linked = (await getCurrentUser()).github_username ?? null;
  } catch (err) {
    return `Your NEMAR account could not be read: ${errorDetail(err)}`;
  }
  if (identityMatches(linked, me.user.login) === "mismatch") {
    return `Your GitHub token belongs to @${me.user.login}, but your NEMAR account is linked to @${linked}; a merge is recorded under the login that makes it.`;
  }
  return { token: token.token, login: me.user.login };
}

/** What a merge that did not happen means for the exit code: 3 while a claim is held. */
function reportNotMerged(r: Extract<MergeOutcome, { merged: false }>, json: boolean): void {
  failMessage(`Not merged (${r.stage}): ${r.reason}`, { json, answered: true });
  if (r.claimHeld) {
    process.exitCode = EXIT_WAITING;
    markReportedExit();
  }
}

export const mergeCommand = new Command("merge")
  .argument("<datasetId>")
  .description("Squash-merge a re-pull's pull request through its gate (mints one version DOI)")
  .option("--force", "Merge although the automated review failed, is running or could not be read")
  .option("-y, --yes", "Do not ask before merging")
  .option("--json", "Print the record as JSON")
  .addHelpText("after", MERGE_HELP)
  .action(
    async (datasetId: string, options: { force?: boolean; yes?: boolean; json?: boolean }) => {
      const json = options.json === true;
      const out = say(json);
      if (!requireSignedIn(json)) return;
      if (!datasetArg(datasetId, json)) return;
      let base: string;
      try {
        base = githubApiBase();
      } catch (err) {
        failMessage(errorDetail(err), { json, answered: true });
        return;
      }
      const who = await adminToken(base);
      if (typeof who === "string") {
        failMessage(who, { json, answered: true });
        return;
      }
      const ctx: GateContext = {
        datasetId,
        token: who.token,
        base,
        env: process.env,
        configDir: getConfigDir(),
        force: options.force === true,
      };
      try {
        const checked = await checkRepullMerge(ctx);
        if (!checked.ok) {
          failMessage(`Not merged (${checked.stage}): ${checked.reason}`, { json, answered: true });
          return;
        }
        const { check } = checked;
        out(
          `Merge ${datasetId} pull request #${check.prNumber} (re-pull #${check.row.id}, v${check.row.to_version}) at ${check.head.slice(0, 12)} as @${who.login}, by squash.`,
        );
        for (const w of check.warnings) out(`  ${w}`);
        const result = await sendRepullMerge(ctx, check, {
          ...(options.yes
            ? {}
            : {
                confirm: async (question: string) =>
                  (await confirm(question, { yes: false })) === "confirmed",
              }),
          out,
        });
        if (!result.merged) {
          reportNotMerged(result, json);
          return;
        }
        if (json) console.log(JSON.stringify({ repull: result.row, merged: true }, null, 2));
        out(
          `Merged ${datasetId} pull request #${check.prNumber}${result.mergeSha ? ` as ${result.mergeSha.slice(0, 12)}` : ""}. Once v${check.row.to_version} is tagged, nemar admin repull resume ${datasetId} records the release.`,
        );
      } catch (err) {
        failMessage(`Merge failed: ${errorDetail(err)}`, {
          json,
          answered: err instanceof ApiError,
        });
      }
    },
  );
