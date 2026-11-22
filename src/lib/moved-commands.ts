/**
 * Moved admin commands (ADR 0135 decision 5, refining ADR 0125 decision 7).
 *
 * A command that moves keeps its old path registered as a hidden stub that
 * accepts any arguments, runs nothing, makes no request, prints one line naming
 * the new path to stderr and exits 1. A command retired with nothing to
 * replace it gets the same stub; its line says why the command is gone.
 * There is no forwarding: an unattended workflow that still calls the old path
 * has to fail where someone reads it.
 *
 * Every stub is a row of {@link MOVED_COMMANDS}; a phase that moves a command
 * appends a row and nothing else here. Paths are written relative to the
 * command the table is registered on (`nemar admin`), words separated by one
 * space.
 */

import chalk from "chalk";
import type { Command } from "commander";
import { markReportedExit } from "./debug-log.js";

/**
 * One row: an old path and either where the command lives now (`newPath`) or, for a command
 * retired with nothing to replace it, the reason it is gone (`retired`).
 */
export type MovedCommand =
  | {
      /** The path that no longer runs, below `nemar admin` (e.g. `publish`, `fleet annex-policy`). */
      readonly oldPath: string;
      /** Where the command lives now, below `nemar admin` (e.g. `dataset publish`). */
      readonly newPath: string;
    }
  | {
      readonly oldPath: string;
      /** Why the command is gone, one sentence ending in a period. */
      readonly retired: string;
    };

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
  // ADR 0125 decision 7 moved the dataset lifecycle under `admin repo`; ADR 0135 renamed the
  // group to `dataset` (`repo` stays its alias), so these point at the canonical name.
  { oldPath: "publish", newPath: "dataset publish" },
  { oldPath: "withdraw", newPath: "dataset withdraw" },
  { oldPath: "restore", newPath: "dataset restore" },
  // ADR 0135, phase P1: the per-dataset commands gather under `admin dataset`.
  { oldPath: "ci", newPath: "dataset ci" },
  { oldPath: "ci check", newPath: "dataset ci check" },
  { oldPath: "ci add", newPath: "dataset ci add" },
  { oldPath: "ci validate", newPath: "dataset ci validate" },
  { oldPath: "ci sync", newPath: "dataset ci sync" },
  { oldPath: "doi", newPath: "dataset doi" },
  { oldPath: "doi create", newPath: "dataset doi create" },
  { oldPath: "doi info", newPath: "dataset doi info" },
  { oldPath: "doi update", newPath: "dataset doi update" },
  { oldPath: "doi enrich", newPath: "dataset doi enrich" },
  { oldPath: "exemplar", newPath: "dataset exemplar" },
  { oldPath: "exemplar create", newPath: "dataset exemplar create" },
  { oldPath: "exemplar status", newPath: "dataset exemplar status" },
  { oldPath: "exemplar remint-dois", newPath: "dataset exemplar remint-dois" },
  { oldPath: "doctor scan", newPath: "dataset doctor scan" },
  { oldPath: "doctor fix", newPath: "dataset doctor fix" },
  // Retired: the action only printed a deprecation; the backend route answers 410.
  {
    oldPath: "regenerate-iam",
    retired:
      "S3 access uses backend-scoped credentials, so there are no per-user IAM keys to regenerate.",
  },
  // Retired, not moved: `dataset publish` is the request, screen and approve workflow, not a
  // bare flip. The `POST /datasets/:id/publish` route stays (ADR 0135, amendment 2026-11-22).
  {
    oldPath: "make-public",
    retired:
      "a bare visibility flip that skipped the publication request and screen no longer exists; use 'nemar admin dataset publish'.",
  },
  { oldPath: "delete-dataset", newPath: "dataset delete" },
  { oldPath: "bulk-delete", newPath: "dataset bulk-delete" },
  { oldPath: "reindex", newPath: "dataset reindex" },
  { oldPath: "s3", newPath: "dataset s3" },
  { oldPath: "s3 lock", newPath: "dataset s3 lock" },
  { oldPath: "s3 credential-check", newPath: "dataset s3 credential-check" },
  {
    oldPath: "s3 regenerate-iam",
    retired:
      "S3 access uses backend-scoped credentials, so there are no per-user IAM keys to regenerate.",
  }, // ADR 0135, phase P2: the account commands gather under `admin users`.
  { oldPath: "approve", newPath: "users approve" },
  { oldPath: "revoke", newPath: "users revoke" },
  { oldPath: "role", newPath: "users role" },
  { oldPath: "verify", newPath: "users verify" },
  { oldPath: "kind", newPath: "users kind" },
  { oldPath: "keys", newPath: "users keys" },
  { oldPath: "keys create", newPath: "users keys create" },
  { oldPath: "keys list", newPath: "users keys list" },
  { oldPath: "keys revoke", newPath: "users keys revoke" },
  { oldPath: "email-preferences", newPath: "users email-preferences" },
  { oldPath: "email-preferences show", newPath: "users email-preferences show" },
  { oldPath: "email-preferences update", newPath: "users email-preferences update" },
  { oldPath: "duplicates", newPath: "users duplicates" },
  { oldPath: "backfill-usernames", newPath: "users backfill-usernames" },
];

/** Each registered stub, with what it does when addressed: print its pointer and exit 1. */
const stubs = new WeakMap<Command, (args: readonly string[]) => never>();

/**
 * True for a command registered by {@link registerMovedCommands}. The root
 * `preAction` hook uses it to skip the `/notices` request, should Commander
 * ever dispatch to a stub that {@link exitIfMovedCommand} did not catch first.
 */
export function isMovedCommandStub(cmd: Command): boolean {
  return stubs.has(cmd);
}

/**
 * If `argv` (user arguments, `process.argv.slice(2)`) addresses a moved-command
 * stub anywhere under `program`, runs that stub: one line to stderr, exit 1.
 * Otherwise returns and does nothing.
 *
 * The CLI calls it before Commander parses anything, because Commander lets
 * the root consume its own options wherever they appear: `nemar admin publish
 * -v` would print the version and exit 0, and the update banner and the
 * `/notices` request would run around the stub. The walk skips every token
 * that starts with "-" and descends while a word names a subcommand (or an
 * alias); it stops at "--". Commander's implicit `help` word is stepped over,
 * so `nemar admin help publish` gets the pointer too.
 *
 * Skipping a "-" token does not skip that option's value, so the walk is right
 * only while no option on the root, on `admin` or on a group with a stub child
 * takes a value; a value there that spelled a command name would be walked as
 * that command. test/moved-commands.unit.test.ts fails when one appears, and
 * this walk must then learn to step over that option's value.
 */
export function exitIfMovedCommand(program: Command, argv: readonly string[]): void {
  let current = program;
  const end = argv.indexOf("--") < 0 ? argv.length : argv.indexOf("--");
  for (let i = 0; i < end; i++) {
    if (argv[i].startsWith("-")) continue;
    // Commander's implicit `help <words>` addresses the same command as the words themselves.
    if (argv[i] === "help" && current.commands.length > 0 && !child(current, "help")) continue;
    const next = child(current, argv[i]);
    if (!next) return;
    const run = stubs.get(next);
    if (run) run(argv.slice(i + 1, end));
    current = next;
  }
}

/** The one stderr line a stub prints; also what the tests assert. */
export function movedCommandMessage(oldFullPath: string, newFullPath: string): string {
  return `'${oldFullPath}' moved to '${newFullPath}'. Nothing was run.`;
}

/** The one stderr line the stub of a retired command prints. */
export function retiredCommandMessage(oldFullPath: string, reason: string): string {
  return `'${oldFullPath}' was retired: ${reason} Nothing was run.`;
}

/** The line a row's stub prints, with `prefix` (`nemar admin`) before each path. */
export function stubMessage(row: MovedCommand, prefix: string): string {
  const oldFull = `${prefix} ${words(row.oldPath).join(" ")}`;
  if ("retired" in row) return retiredCommandMessage(oldFull, row.retired);
  return movedCommandMessage(oldFull, `${prefix} ${words(row.newPath).join(" ")}`);
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
 * and the stub picks the longest row matching the words typed after it. An
 * option typed before those words (`s3 --profile x lock`) ends the match, so
 * the pointer falls back to the gone group's own row.
 */
export function registerMovedCommands(
  root: Command,
  rows: readonly MovedCommand[] = MOVED_COMMANDS,
): void {
  const byOldPath = new Map<string, MovedCommand>();
  for (const row of rows) {
    const key = words(row.oldPath).join(" ");
    if ("retired" in row) {
      if (!/\S.*\.$/.test(row.retired)) {
        throw new Error(`moved-commands: '${key}' needs a retirement reason ending in a period`);
      }
    } else {
      words(row.newPath);
    }
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
    const run = (args: readonly string[]): never => {
      // Longest row whose remaining words are the first words typed after the stub.
      let row = byOldPath.get(stubPath) as MovedCommand;
      for (let n = 1; n <= args.length; n++) {
        const candidate = byOldPath.get([...stubWords, ...args.slice(0, n)].join(" "));
        if (candidate) row = candidate;
      }
      console.error(chalk.red(stubMessage(row, fullName(root))));
      markReportedExit();
      process.exit(1);
    };
    const stub = parent
      .command(name, { hidden: true })
      .helpOption(false)
      .allowUnknownOption()
      .allowExcessArguments()
      .action((_opts: unknown, cmd: Command) => run(cmd.args));
    stubs.set(stub, run);
  }
}
