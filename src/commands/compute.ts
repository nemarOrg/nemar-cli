/**
 * `nemar compute`: use NEMAR compute (epic #2021, ADR 0118). This group is the person's own side; the
 * administrator's is `nemar admin compute` (src/commands/admin-compute.ts).
 *
 *   nemar compute request-access [--purpose <text>] [--accept-terms] [--json]
 *
 * The balance, the usage and the jobs (phase D2) and submission (phase D3) are added to this group by the
 * phases that build them.
 */

import { Command } from "commander";
import { requestAccessCommand } from "./compute-access.js";

export const computeCommand = new Command("compute").description(
  "Use NEMAR compute: ask for access, and (in later releases) see your balance and run jobs",
);

computeCommand.addCommand(requestAccessCommand);
