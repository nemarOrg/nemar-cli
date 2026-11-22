/**
 * A throwaway command tree for test/moved-commands.unit.test.ts: rows the real
 * table does not have yet (an old path under a live group, and old paths under
 * a gone group) go through the real registerMovedCommands. Each live leaf
 * prints a marker, so a stub that fell through to one would show.
 */

import { Command } from "commander";
import { type MovedCommand, registerMovedCommands } from "../../../src/lib/moved-commands";

export const FIXTURE_ROWS: readonly MovedCommand[] = [
  { oldPath: "fleet annex-policy", newPath: "rework annex policy" },
  { oldPath: "s3", newPath: "dataset s3" },
  { oldPath: "s3 lock", newPath: "dataset s3 lock" },
];

/** The paths below `admin` that registration turns into stubs (one per first missing word). */
export const FIXTURE_STUB_PATHS: readonly string[] = ["fleet annex-policy", "s3"];

export function buildFixtureProgram(): { program: Command; admin: Command } {
  const program = new Command("nemar").version("9.9.9", "-v, --version").option("--debug");
  const admin = program.command("admin");
  admin
    .command("fleet")
    .command("drift")
    .action(() => console.log("LIVE fleet drift ran"));
  admin
    .command("rework")
    .command("annex")
    .command("policy")
    .action(() => console.log("LIVE ran"));
  admin
    .command("dataset")
    .command("s3")
    .command("lock")
    .action(() => console.log("LIVE ran"));
  registerMovedCommands(admin, FIXTURE_ROWS);
  return { program, admin };
}
