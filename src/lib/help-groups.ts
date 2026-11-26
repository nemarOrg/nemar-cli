/**
 * Which subcommands a command group leads with in plain `--help`.
 *
 * `nemar dataset` carries about 21 subcommands, and most of them are not what
 * anyone came for: a git-level escape hatch, a command run a handful of times
 * a year. Listing all of them flat makes the three or four commands people
 * actually type as hard to find as the rest.
 *
 * `nemar admin` used to be folded the same way, when it carried about 50
 * top-level commands. ADR 0135 grouped it into fourteen objects, each a short
 * line, so its plain `--help` now lists all of them and it has no entry here
 * (`test/admin-write-flag.unit.test.ts` pins the fourteen).
 *
 * So plain `--help` renders the names below, in the order they appear here,
 * and folds everything else into a single comma-separated "More commands"
 * line. `--help-all` renders the full list with descriptions, as before.
 *
 * Two properties this table deliberately has:
 *
 * - **It is presentation only.** Nothing here calls Commander's `hidden`,
 *   so a folded command is still dispatched, still completes on TAB
 *   (lib/completion/candidates.ts walks `cmd.commands`), and still has its
 *   own `--help`. The only thing that changes is which names carry a
 *   description in the parent's listing.
 * - **It fails open.** A command missing from this table lands in "More
 *   commands", never nowhere. Adding a subcommand and forgetting this file
 *   costs it a line of prominence, not its visibility.
 *
 * Keyed by the command path below the program name, space-separated
 * (`"dataset"`, `"admin"`, and `"dataset publish"` if a nested group ever
 * needs it). `test/help-tiers.unit.test.ts` fails if a key names a group
 * that does not exist or an entry names a subcommand that does not.
 */
export const COMMON_COMMANDS: Readonly<Record<string, readonly string[]>> = {
  // The deposit-then-consume arc, in the order a depositor meets it, with the
  // two commands a consumer types (search, download) kept adjacent.
  dataset: ["search", "download", "upload", "validate", "screen", "status", "list"],
};
