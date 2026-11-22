/**
 * Moved admin commands (ADR 0135 decision 5, refining ADR 0125 decision 7).
 *
 * A command that moves keeps its old path registered as a hidden stub that
 * accepts any arguments, runs nothing, makes no request, prints one line naming
 * the new path to stderr and exits 1. There is no forwarding: an unattended
 * workflow that still calls the old path has to fail where someone reads it.
 *
 * Every stub is a row of {@link MOVED_COMMANDS}; a phase that moves a command
 * appends a row and nothing else here. Paths are written relative to the
 * command the table is registered on (`nemar admin`), words separated by one
 * space.
 */

import chalk from "chalk";
import type { Command } from "commander";
import { markReportedExit } from "./debug-log.js";

export interface MovedCommand {
  /** The path that no longer runs, below `nemar admin` (e.g. `publish`, `fleet annex-policy`). */
  readonly oldPath: string;
  /** Where the command lives now, below `nemar admin` (e.g. `repo publish`). */
  readonly newPath: string;
}

/**
 * The one table of moved admin commands.
 *
 * An old path may sit under a group that still exists (`fleet annex-policy`
 * while `fleet` stays), or under a group that is gone as a whole (`s3 lock`
 * once `s3` dissolves). In the second case the gone group itself also needs a
 * row (`s3`), so that `nemar admin s3` alone still gets a pointer;
 * {@link registerMovedCommands} refuses a table without it.
 */
export const MOVED_COMMANDS: readonly MovedCommand[] = [
  // ADR 0125 decision 7: the dataset lifecycle moved under `admin repo`.
  { oldPath: "publish", newPath: "repo publish" },
  { oldPath: "withdraw", newPath: "repo withdraw" },
  { oldPath: "restore", newPath: "repo restore" },
];

const stubs = new WeakSet<Command>();

/**
 * True for a command registered by {@link registerMovedCommands}. The root
 * `preAction` hook uses it to skip the `/notices` request, so a stub makes no
 * request at all.
 */
export function isMovedCommandStub(cmd: Command): boolean {
  return stubs.has(cmd);
}

/** The one stderr line a stub prints; also what the tests assert. */
export function movedCommandMessage(oldFullPath: string, newFullPath: string): string {
  return `'${oldFullPath}' moved to '${newFullPath}'. Nothing was run.`;
}

function words(path: string): string[] {
  const parts = path.trim().split(/\s+/);
  if (parts.length === 0 || parts[0] === "") throw new Error("moved-commands: empty path");
  return parts;
}

function fullName(cmd: Command): string {
  const names: string[] = [];
  for (let c: Command | null = cmd; c; c = c.parent) names.unshift(c.name());
  return names.join(" ");
}

function child(cmd: Command, name: string): Command | undefined {
  return cmd.commands.find((c) => c.name() === name || c.aliases().includes(name));
}

/**
 * Registers every row of `rows` under `root` as a hidden stub.
 *
 * Call it after every live command under `root` is registered, so a row can
 * be checked against the live tree. It throws (and so fails every CLI run and
 * every test) when a row's old path is still a live command, when two rows
 * share an old path, or when an old path sits under a gone group that has no
 * row of its own.
 *
 * One stub is registered per distinct first missing word: under a live group
 * that is the row's last word; under a gone group it is the gone group's name,
 * and the stub picks the longest row matching the words typed after it.
 */
export function registerMovedCommands(
  root: Command,
  rows: readonly MovedCommand[] = MOVED_COMMANDS,
): void {
  const byOldPath = new Map<string, MovedCommand>();
  for (const row of rows) {
    const key = words(row.oldPath).join(" ");
    words(row.newPath);
    if (byOldPath.has(key)) throw new Error(`moved-commands: duplicate old path '${key}'`);
    byOldPath.set(key, row);
  }

  // Each stub is keyed by the path of the word it registers.
  const stubRoots = new Map<string, { parent: Command; name: string }>();
  for (const key of byOldPath.keys()) {
    const parts = key.split(" ");
    let parent = root;
    let depth = 0;
    for (; depth < parts.length; depth++) {
      const next = child(parent, parts[depth]);
      if (!next) break;
      parent = next;
    }
    if (depth === parts.length) {
      throw new Error(`moved-commands: '${key}' is a row but still a live command`);
    }
    const stubPath = parts.slice(0, depth + 1).join(" ");
    if (!byOldPath.has(stubPath)) {
      throw new Error(
        `moved-commands: '${key}' sits under '${stubPath}', which is gone; add a row for '${stubPath}'`,
      );
    }
    stubRoots.set(stubPath, { parent, name: parts[depth] });
  }

  for (const [stubPath, { parent, name }] of stubRoots) {
    const stubWords = stubPath.split(" ");
    const stub = parent
      .command(name, { hidden: true })
      .helpOption(false)
      .allowUnknownOption()
      .allowExcessArguments()
      .action((_opts: unknown, cmd: Command) => {
        // Longest row whose remaining words are the first words typed after the stub.
        let row = byOldPath.get(stubPath) as MovedCommand;
        for (let n = 1; n <= cmd.args.length; n++) {
          const candidate = byOldPath.get([...stubWords, ...cmd.args.slice(0, n)].join(" "));
          if (candidate) row = candidate;
        }
        const prefix = fullName(root);
        const oldFull = `${prefix} ${words(row.oldPath).join(" ")}`;
        const newFull = `${prefix} ${words(row.newPath).join(" ")}`;
        console.error(chalk.red(movedCommandMessage(oldFull, newFull)));
        markReportedExit();
        process.exit(1);
      });
    stubs.add(stub);
  }
}
