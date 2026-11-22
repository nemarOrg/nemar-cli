/**
 * A throwaway command tree for test/moved-commands.unit.test.ts: rows the real
 * table does not have yet (an old path under a live group, and old paths under
 * a gone group) go through the real registerMovedCommands. The live leaf
 * prints a marker, so a stub that fell through to it would show.
 */

import { Command } from "commander";
import { registerMovedCommands } from "../../../src/lib/moved-commands";

const root = new Command("admin");
const fleet = root.command("fleet");
fleet.command("drift").action(() => console.log("LIVE fleet drift ran"));
root
  .command("rework")
  .command("annex")
  .command("policy")
  .action(() => console.log("LIVE ran"));
root
  .command("dataset")
  .command("s3")
  .command("lock")
  .action(() => console.log("LIVE ran"));

registerMovedCommands(root, [
  { oldPath: "fleet annex-policy", newPath: "rework annex policy" },
  { oldPath: "s3", newPath: "dataset s3" },
  { oldPath: "s3 lock", newPath: "dataset s3 lock" },
]);

const program = new Command("nemar");
program.addCommand(root);
await program.parseAsync(process.argv.slice(2), { from: "user" });
