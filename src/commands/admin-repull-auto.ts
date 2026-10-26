/**
 * `nemar admin repull auto`: the automatic re-pull as the Worker reads and records it (ADR 0111,
 * the Phase 7h slice; epic #1046 phase 7). Read-only, an administrator's read, so it names the
 * datasets and ids the weekly report on a public-facing repository never does
 * (`lib/repull/auto-view.ts`).
 *
 * Registered on `repullCommand` by `admin-repull.ts`.
 */

import { Command } from "commander";
import { failMessage, requireSignedIn } from "../lib/admin-command.js";
import { ApiError, errorDetail } from "../lib/api/errors.js";
import { type AutoView, autoJson, autoLines, readAuto } from "../lib/repull/auto-view.js";

const AUTO_HELP = `
Shows the automatic re-pull as the Worker reads and records it. It changes nothing.

  Switches    AUTO_REPULL_ENABLED and AUTO_REPULL_MERGE_ENABLED (each on only as the exact string
              "1", and only in the production Worker; the merge switch acts only while the open
              switch is on) and the two daily caps, each with how the Worker read it. A cap set to
              something unreadable reads 0 and says so.
  Scheduler   when the daily tick and the advance tick last ran, and what the daily tick
              concluded. "Never recorded" means nothing has stamped the row; "unknown" means the
              Worker found no row.
  Open        the open re-pulls the automatic path made, with the word each waits for (a hold) and
              since when, and a claim to merge that is still held. A re-pull an administrator
              opened is not listed here (\`nemar admin repull status <id>\` shows it).
  Dispatches  the newest 20 the Worker sent to the central workflow: its kind, the dataset, its
              state and word, the re-pull it is for, and the run's log.

It names datasets and ids because it is an administrator's read; the weekly report on the public
repository never does. --json prints the same facts.

Exit codes:
  0  read.
  1  the Worker refused (you are not an administrator) or a read failed. Nothing is printed then,
     because a partial table would claim what was not read.`;

export const autoCommand = new Command("auto")
  .description(
    "Show the automatic re-pull: its switches and caps, the scheduler, the open automatic re-pulls and the recent dispatches",
  )
  .option("--json", "Print the same facts as JSON")
  .addHelpText("after", AUTO_HELP)
  .action(async (options: { json?: boolean }) => {
    const json = options.json === true;
    if (!requireSignedIn(json)) return;
    let view: AutoView;
    try {
      view = await readAuto();
    } catch (err) {
      failMessage(`Could not read the automatic re-pull: ${errorDetail(err)}`, {
        json,
        answered: err instanceof ApiError,
      });
      return;
    }
    if (json) {
      console.log(JSON.stringify(autoJson(view), null, 2));
      return;
    }
    for (const line of autoLines(view)) console.log(line);
  });
