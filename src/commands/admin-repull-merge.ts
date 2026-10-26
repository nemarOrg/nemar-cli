/**
 * `nemar admin repull merge <id>`: merge an upstream re-pull's pull request, as the administrator,
 * through the one gate `nemar admin pr-reviews` also merges re-pulls through (`lib/repull/merge.ts`;
 * ADR 0111, decisions 6 and 7; ADR 0093). It squash-merges at the screened head with a message
 * that ends with the re-pull commit's trailers, under one unit of the day's merge cap, and mints
 * one version DOI. Registered on `repullCommand` by `admin-repull.ts`.
 */

import { Command } from "commander";
import {
  ACKNOWLEDGMENT_MAX_LENGTH,
  ACKNOWLEDGMENT_MIN_LENGTH,
} from "../../shared/publication-limits.js";
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
token\`; it must belong to a person, and when your NEMAR account names a GitHub login it must be
that one), once its record is gates_clear (\`nemar admin repull resume <id>\` gets it there).
Before anything is written it checks that the pull request is open, not a draft, into main at the
screened head, that NEMAR's main moved by enrichment only, that the automated review of that head
allows it (one that failed, is running or cannot be read needs --force), that the identifier screen
of that head passes, that GitHub reports the pull request clean, and that the squash message
carries the re-pull commit's two trailers as its last paragraph. Then it reads the review once
more and asks (one irreversible version DOI; --yes answers), and, holding the record's lock (no
resume or execute of it runs meanwhile), claims one unit of today's re-pull merge cap,
squash-merges at the screened commit (GitHub refuses a head that moved since), and records the
merge.

A claim already held for the screened head (a merge whose answer was lost) is used again, without
a second claim, after the Worker reads the dataset, the screen for you and the live head again,
and only while the claim is younger than 25 minutes; an older one is expired by resume at 30.

--bids-failure-reason "<text>" (10 to 500 characters) merges a re-pull you opened over a failed
BIDS validation, with your reason recorded beside the claim. It is taken only while GitHub reports
the pull request unstable, a check that is not required failing; blocked, where this dataset's
rules require BIDS validation and a merge would be a bypass, is refused before anything is
written, and so is clean, which needs no override. The Worker then reads, at the screened head,
that BIDS validation completed with failure and version-check with success before it records the
claim; every other check of the gate (the review, the screen, main, the message) is unchanged. It
never applies to a re-pull the automatic path opened, and never uses a claim already held.
A merge GitHub did not make keeps its claim: run merge again within 25 minutes of the claim to
send it under the claim once GitHub reports the pull request clean, or, if the head moved, run
resume, which expires the claim once it is 30 minutes old and then records the new head.

Exit codes:
  0  merged and recorded.
  3  a claim is held and nothing more is known (the merge's outcome is unknown, GitHub did not merge
     it, or the held claim may not be used now), or GitHub merged it and the merge is not recorded
     yet: run resume (which reads GitHub and records the merge) or merge again.
  1  refused before anything was written (not ready, the review, the screen, main, GitHub's
     state, the cap, a declined confirmation), or failed.`;

/**
 * The administrator's GitHub credential: a person's (never an App or workflow token), and, when
 * their NEMAR account names a GitHub login, that login; an account that names none is not checked
 * (`identityMatches` answers `unlinked`), as `pr-reviews` does, and only a different login refuses.
 */
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
  .option(
    "--bids-failure-reason <text>",
    "Merge a re-pull you opened over a failed BIDS validation (unstable only), recording why",
  )
  .option("-y, --yes", "Do not ask before merging")
  .option("--json", "Print the record as JSON")
  .addHelpText("after", MERGE_HELP)
  .action(
    async (
      datasetId: string,
      options: { force?: boolean; yes?: boolean; json?: boolean; bidsFailureReason?: string },
    ) => {
      const json = options.json === true;
      const out = say(json);
      if (!requireSignedIn(json)) return;
      if (!datasetArg(datasetId, json)) return;
      const reason = options.bidsFailureReason?.trim();
      if (
        reason !== undefined &&
        (reason.length < ACKNOWLEDGMENT_MIN_LENGTH || reason.length > ACKNOWLEDGMENT_MAX_LENGTH)
      ) {
        failMessage(
          `--bids-failure-reason takes ${ACKNOWLEDGMENT_MIN_LENGTH} to ${ACKNOWLEDGMENT_MAX_LENGTH} characters, the rule a reason for an identifier screen takes.`,
          { json, answered: true },
        );
        return;
      }
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
        ...(reason !== undefined ? { bidsFailureReason: reason } : {}),
      };
      try {
        const checked = await checkRepullMerge(ctx);
        if (!checked.ok) {
          failMessage(`Not merged (${checked.stage}): ${checked.reason}`, { json, answered: true });
          return;
        }
        const { check } = checked;
        out(
          `Merge ${datasetId} pull request #${check.prNumber} (re-pull #${check.row.id}, v${check.row.to_version}) at ${check.head.slice(0, 12)} as @${who.login}, by squash${reason !== undefined ? ", over a failed BIDS validation" : ""}.`,
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
        if (json) {
          console.log(
            JSON.stringify(
              { repull: result.row, merged: true, recorded: result.recorded },
              null,
              2,
            ),
          );
        }
        if (!result.recorded) {
          // Merged on GitHub, not on the record: resume reads GitHub and records it.
          out(
            `GitHub merged ${datasetId} pull request #${check.prNumber}; the merge is not recorded yet. Run nemar admin repull resume ${datasetId}, which records it.`,
          );
          process.exitCode = EXIT_WAITING;
          markReportedExit();
          return;
        }
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
