/**
 * `nemar admin repull abandon <id>`: end a dataset's open re-pull by hand (ADR 0111, decision 3;
 * `lib/repull/abandon.ts`). Registered on `repullCommand` by `admin-repull.ts`.
 */

import { Command } from "commander";
import { failMessage, requireSignedIn, say } from "../lib/admin-command.js";
import { confirm } from "../lib/confirm.js";
import { markReportedExit } from "../lib/debug-log.js";
import { type AbandonResult, abandonRepull } from "../lib/repull/abandon.js";
import { datasetArg, reportRefused } from "./admin-repull-resume.js";

const ABANDON_HELP = `
Ends the dataset's open re-pull, on this machine with your own GitHub token (GH_TOKEN, else
\`gh auth token\`). It reads every pull request of the re-pull's release branch first, and a merged
one refuses: a merge minted a DOI, and resume records it. A held claim to merge refuses too (resume
resolves it from GitHub).

  before the merge   (planned to gates_clear) closes N.0.0's pull request and deletes its release
                     branch, when they exist and are this re-pull's, reports the objects its copy
                     and uploads wrote that no tree on main names (they stay in NEMAR's bucket,
                     unlocked; nothing is deleted, and the staging manifest that lists them is
                     kept), and ends the record abandoned. A new attempt at the tag is then allowed.
  merged             refused (wait-for-release): run resume, which records the release, the
                     lineage, the sweep stamps and the lock; then abandon declines N.0.1.
  after the release  (released, patch_synthesized, patch_gates_clear) closes only N.0.1's pull
                     request and deletes its branch, when they exist, and ends the record
                     patch_declined. v<N.0.0> stays released; its corrections remain corrections
                     in the next plan.
  N.0.1 merged       refused (wait-for-release): run resume.

It asks before it closes or deletes anything (--yes answers), and removes the record's working
directory and checkpoint. Abandon works on a dataset that became anonymous or withdrawn.

Exit codes:
  0  the record is ended.
  1  refused (nothing was closed, deleted or recorded), or nothing to end.
  3  refused after something was closed or deleted (its why says which); run abandon again.`;

function report(result: AbandonResult, datasetId: string, out: (line: string) => void): void {
  const { row, report: r } = result;
  if (!row || !r) return;
  if (r.branch === "kept-foreign" || r.branch === "kept-unreadable") {
    out(
      `The release branch was kept: it ${r.branch === "kept-foreign" ? "holds a commit that is not this re-pull's or enrichment's" : "could not be read"}; check what it holds before removing it by hand.`,
    );
  }
  if (result.outcome === "abandoned") {
    out(
      r.orphans
        ? `Orphans: ${r.orphans.objects} object(s), ${r.orphans.bytes} byte(s), stay in NEMAR's bucket (not locked, not deleted).`
        : `Orphans: not counted (${r.orphansUnknown}); what the copy wrote stays in NEMAR's bucket.`,
    );
    out(
      `Re-pull #${row.id} of ${datasetId} is abandoned. Plan the dataset again to re-pull ${row.to_tag}.`,
    );
  } else {
    out(
      `Re-pull #${row.id} of ${datasetId} is patch_declined: v${row.to_version} stays released, and N.0.1 is not made.`,
    );
  }
}

export const abandonCommand = new Command("abandon")
  .argument("<datasetId>")
  .description("End an open re-pull: abandoned before its merge, patch_declined after its release")
  .option("-y, --yes", "Do not ask before closing and deleting")
  .option("--json", "Print the record as JSON")
  .addHelpText("after", ABANDON_HELP)
  .action(async (datasetId: string, options: { yes?: boolean; json?: boolean }) => {
    const json = options.json === true;
    const out = say(json);
    if (!requireSignedIn(json)) return;
    if (!datasetArg(datasetId, json)) return;
    let result: AbandonResult;
    try {
      result = await abandonRepull({
        datasetId,
        ...(options.yes
          ? {}
          : {
              confirm: async (question: string) =>
                (await confirm(question, { yes: false })) === "confirmed",
            }),
        out: (line) => out(line),
      });
    } catch (err) {
      reportRefused(err, json, out);
      return;
    }
    if (json) {
      console.log(
        JSON.stringify(
          { repull: result.row, outcome: result.outcome, report: result.report ?? null },
          null,
          2,
        ),
      );
    }
    if (result.outcome === "nothing") {
      failMessage(
        result.row
          ? `${datasetId} has no open re-pull; the newest, #${result.row.id}, is ${result.row.status}.`
          : `${datasetId} has no re-pull on record.`,
        { json, answered: true },
      );
      process.exitCode = 1;
      markReportedExit();
      return;
    }
    report(result, datasetId, out);
  });
