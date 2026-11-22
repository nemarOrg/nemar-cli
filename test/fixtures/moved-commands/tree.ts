/**
 * Runs the fixture tree the way src/index.ts runs the real one: the moved-command
 * check first, then Commander.
 */

import { exitIfMovedCommand } from "../../../src/lib/moved-commands";
import { buildFixtureProgram } from "./tree-def";

const { program } = buildFixtureProgram();
const argv = process.argv.slice(2);
exitIfMovedCommand(program, argv);
await program.parseAsync(argv, { from: "user" });
