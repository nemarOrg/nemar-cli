/**
 * `nemar compute`: use NEMAR compute (epic #2021, ADR 0118). This group is the person's own side; the
 * administrator's is `nemar admin compute` (src/commands/admin-compute.ts).
 *
 *   nemar compute request-access [--purpose <text>] [--accept-terms] [--json]
 *   nemar compute balance | limits | queue | list | status <job>      (phase D2, ./compute-read.ts)
 *
 * Submission (phase D3) is added to this group by the phase that builds it.
 */

import { Command } from "commander";
import { requestAccessCommand } from "./compute-access.js";
import {
  balanceCommand,
  limitsCommand,
  listCommand,
  queueCommand,
  statusCommand,
} from "./compute-read.js";

export const computeCommand = new Command("compute").description(
  "Use NEMAR compute: ask for access, see your balance, limits and jobs, and (in later releases) run jobs",
);

computeCommand.addCommand(requestAccessCommand);
computeCommand.addCommand(balanceCommand);
computeCommand.addCommand(limitsCommand);
computeCommand.addCommand(queueCommand);
computeCommand.addCommand(listCommand);
computeCommand.addCommand(statusCommand);
