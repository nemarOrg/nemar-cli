/**
 * The steps of `nemar admin repull` past the open pull request (ADR 0111, decisions 2, 3, 6 and 7;
 * epic #1046 phase 6):
 *
 *   nemar admin repull status <id>   what the record says (`lib/repull/status.ts`)
 *   nemar admin repull resume <id>   the head, main, the identifier screen and the gates, and a
 *                                    held claim resolved from GitHub (`lib/repull/resume.ts`);
 *                                    it never merges
 *
 * Registered on `repullCommand` by `admin-repull.ts`. The shared argument parsers and the
 * report of a refusal are exported for the merge command.
 */

import { Command, InvalidArgumentError } from "commander";
import {
  ACKNOWLEDGMENT_MAX_LENGTH,
  ACKNOWLEDGMENT_MIN_LENGTH,
} from "../../shared/publication-limits.js";
import { failMessage, requireSignedIn, say } from "../lib/admin-command.js";
import { ApiError, errorDetail } from "../lib/api/errors.js";
import { listRepullScreens, listRepulls } from "../lib/api/repull.js";
import { confirm } from "../lib/confirm.js";
import { markReportedExit, markUsageExit } from "../lib/debug-log.js";
import { ExecuteRefused } from "../lib/repull/execute/verify-plan.js";
import { type ResumeResult, resumeRepull } from "../lib/repull/resume.js";
import { olderLine, statusLines } from "../lib/repull/status.js";

/** Exit code of a step that stopped resumable or waits: run it again. */
export const EXIT_WAITING = 3;

/** A dataset id typed on the command line, or null after saying so (exit 1). */
export function datasetArg(raw: string, json: boolean): string | null {
  if (/^[a-z]{2}\d{6}$/.test(raw)) return raw;
  failMessage(`"${raw}" is not a dataset id (like on004362).`, { json, answered: true });
  markUsageExit();
  return null;
}

/** `--wait-minutes`: a whole number of minutes, 0 to 120. */
export function parseMinutes(value: string): number {
  const n = Number(value);
  if (!/^\d{1,3}$/.test(value.trim()) || n > 120) {
    throw new InvalidArgumentError("a whole number of minutes from 0 to 120 is required.");
  }
  return n;
}

/** `--acknowledge-identifier-screen`: the publication path's length rule (ADR 0086). */
export function parseReason(value: string): string {
  const reason = value.trim();
  if (reason.length < ACKNOWLEDGMENT_MIN_LENGTH || reason.length > ACKNOWLEDGMENT_MAX_LENGTH) {
    throw new InvalidArgumentError(
      `a reason of ${ACKNOWLEDGMENT_MIN_LENGTH} to ${ACKNOWLEDGMENT_MAX_LENGTH} characters is required.`,
    );
  }
  return reason;
}

/** Report a refusal of a step past the open pull request: exit 3 when it left a record behind. */
export function reportRefused(err: unknown, json: boolean, out: (line: string) => void): void {
  if (err instanceof ExecuteRefused) {
    failMessage(`Refused (${err.code}): ${err.message}`, { json, answered: true });
    for (const line of err.lines) out(line);
    if (err.resumable) process.exitCode = EXIT_WAITING;
    return;
  }
  failMessage(`Failed: ${errorDetail(err)}`, { json, answered: err instanceof ApiError });
}

export const statusCommand = new Command("status")
  .argument("<datasetId>")
  .description("Show the record of a dataset's re-pulls: state, pull request, screen, what is next")
  .option("--json", "Print the records and the newest one's screens as JSON")
  .action(async (datasetId: string, options: { json?: boolean }) => {
    const json = options.json === true;
    if (!requireSignedIn(json)) return;
    if (!datasetArg(datasetId, json)) return;
    try {
      const { repulls } = await listRepulls({ dataset: datasetId, limit: 5 });
      const newest = repulls[0];
      const screens = newest ? await listRepullScreens(newest.id) : null;
      if (json) {
        console.log(JSON.stringify({ repulls, screens }, null, 2));
        return;
      }
      if (!newest) {
        console.log(`${datasetId} has no re-pull on record.`);
        return;
      }
      for (const line of statusLines(newest, screens?.exempt ? null : (screens?.screens ?? []))) {
        console.log(line);
      }
      if (repulls.length > 1) {
        console.log("Earlier attempts:");
        for (const row of repulls.slice(1)) console.log(olderLine(row));
      }
    } catch (err) {
      failMessage(`Could not read the re-pulls of ${datasetId}: ${errorDetail(err)}`, {
        json,
        answered: err instanceof ApiError,
      });
    }
  });

const RESUME_HELP = `
Takes a dataset's open re-pull up where it stopped, past its open pull request, on this machine
with your own GitHub token (GH_TOKEN, else \`gh auth token\`). It never merges.

  pr_open      reads the pull request: one found merged is recorded (the Worker reads it on
               GitHub), one closed unmerged ends the record abandoned; a head moved by
               enrichment is recorded, any other is refused (head-foreign). NEMAR's main must be
               the base or have moved by enrichment only; when it moved and GitHub reports the
               pull request dirty or behind, the commit is made again on the new main and pushed
               with a lease (asked first unless --yes). Then the identifier screen of the head is
               dispatched (when none exists or it produced no verdict), and once it passes and
               GitHub reports the pull request clean, the gates are recorded: gates_clear.
  gates_clear  a held claim to merge is resolved from GitHub: a merge is recorded, and a claim
               GitHub says did not merge expires once it is 30 minutes old.

A screen that asks for a person is acknowledged with --acknowledge-identifier-screen "<reason>",
after you read it with \`nemar admin repull status <id>\`; a direct identifier cannot be.

Exit codes:
  0  ready to merge (gates_clear), or the record went as far as this slice goes.
  3  waiting (for the screen, GitHub, a person) after --wait-minutes, or stopped with why
     recorded on the record; run resume again.
  1  refused before anything was written, nothing to resume, or the record ended (abandoned).`;

export const resumeCommand = new Command("resume")
  .argument("<datasetId>")
  .description("Take an open re-pull on past its pull request: screen, gates (never merges)")
  .option(
    "--wait-minutes <n>",
    "How long to wait for the screen and GitHub (0 reads once)",
    parseMinutes,
    10,
  )
  .option(
    "--acknowledge-identifier-screen <reason>",
    "Your reason for a screen verdict that asks for a person (ADR 0086)",
    parseReason,
  )
  .option("-y, --yes", "Do not ask before re-synthesizing the release branch")
  .option("--json", "Print the record as JSON")
  .addHelpText("after", RESUME_HELP)
  .action(
    async (
      datasetId: string,
      options: {
        waitMinutes: number;
        acknowledgeIdentifierScreen?: string;
        yes?: boolean;
        json?: boolean;
      },
    ) => {
      const json = options.json === true;
      const out = say(json);
      if (!requireSignedIn(json)) return;
      if (!datasetArg(datasetId, json)) return;
      let result: ResumeResult;
      try {
        result = await resumeRepull({
          datasetId,
          waitMinutes: options.waitMinutes,
          ...(options.acknowledgeIdentifierScreen
            ? { acknowledgment: options.acknowledgeIdentifierScreen }
            : {}),
          ...(options.yes
            ? {}
            : {
                confirm: async (question: string) =>
                  (await confirm(question, { yes: false })) === "confirmed",
              }),
          out: (line) => out(line),
          ...(process.env.NEMAR_REPULL_POLL_MS && /^\d+$/.test(process.env.NEMAR_REPULL_POLL_MS)
            ? { pollMs: Number(process.env.NEMAR_REPULL_POLL_MS) }
            : {}),
        });
      } catch (err) {
        reportRefused(err, json, out);
        return;
      }
      const { row } = result;
      if (json) {
        console.log(
          JSON.stringify(
            { repull: row, outcome: result.outcome, waiting_for: result.waitingFor ?? null },
            null,
            2,
          ),
        );
      }
      switch (result.outcome) {
        case "ready":
          out(`Ready to merge: nemar admin repull merge ${datasetId}`);
          break;
        case "waiting":
          out(`Waiting for ${result.waitingFor}. Run resume again.`);
          process.exitCode = EXIT_WAITING;
          markReportedExit();
          break;
        case "ended":
          process.exitCode = 1;
          markReportedExit();
          break;
        case "nothing":
          out(
            row
              ? `${datasetId} has no open re-pull; the newest, #${row.id}, is ${row.status}.`
              : `${datasetId} has no re-pull on record.`,
          );
          process.exitCode = 1;
          markReportedExit();
          break;
        default:
          out(`Re-pull #${row?.id} of ${datasetId} is ${row?.status}.`);
      }
    },
  );
