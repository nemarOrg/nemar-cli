/**
 * `nemar compute`: use NEMAR compute (epic #2021, ADR 0118). This group is the person's own side; the
 * administrator's is `nemar admin compute` (src/commands/admin-compute.ts).
 *
 *   nemar compute request-access [--purpose <text>] [--accept-terms] [--json]
 *   nemar compute balance | limits | queue | list | status <job>      (phase D2, ./compute-read.ts)
 *   nemar compute submit [path] [options] [-- args]                  (phase D3b, ./compute-submit.ts)
 *   nemar compute logs <job> | results <job> | cancel <job>          (phase D3b, ./compute-jobs.ts)
 */

import { Command } from "commander";
import { requestAccessCommand } from "./compute-access.js";
import { cancelCommand, logsCommand, resultsCommand } from "./compute-jobs.js";
import {
  balanceCommand,
  limitsCommand,
  listCommand,
  queueCommand,
  statusCommand,
} from "./compute-read.js";
import { submitCommand } from "./compute-submit.js";

export const computeCommand = new Command("compute").description(
  "Use NEMAR compute: ask for access, run jobs, and see your balance, limits, jobs and results",
);

computeCommand.addCommand(requestAccessCommand);
computeCommand.addCommand(balanceCommand);
computeCommand.addCommand(limitsCommand);
computeCommand.addCommand(queueCommand);
computeCommand.addCommand(listCommand);
computeCommand.addCommand(statusCommand);
computeCommand.addCommand(submitCommand);
computeCommand.addCommand(logsCommand);
computeCommand.addCommand(resultsCommand);
computeCommand.addCommand(cancelCommand);
