/**
 * The one write flag (ADR 0135 decision 4).
 *
 * `--apply` is the flag that makes a dry-run-by-default command write. A
 * command that used another spelling keeps it as a hidden alias that sets the
 * same `apply` key, so a script keeps working while its spelling is changed,
 * and the command's action reads only `opts.apply`.
 */

import { type Command, Option } from "commander";

/** The spellings that commands used before `--apply`. */
export type ApplyAlias = "--execute" | "--write" | "--fix";

/**
 * Declares `--apply` on `cmd`, plus each of `aliases` as a hidden option that
 * sets `apply` instead of a key of its own. Returns `cmd` for chaining.
 */
export function addApplyOption(
  cmd: Command,
  description: string,
  aliases: readonly ApplyAlias[] = [],
): Command {
  cmd.option("--apply", description);
  for (const alias of aliases) {
    const option = new Option(alias, `Hidden alias of --apply: ${description}`).hideHelp();
    cmd.addOption(option);
    const key = option.attributeName();
    // Commander's own listener, added by addOption above, has already stored the alias under its
    // own key; move it to `apply` so no action can come to depend on the old spelling. `opts()` is
    // the live store the action receives, so deleting from it removes the key outright. That holds
    // for Commander's default option store only: under storeOptionsAsProperties(), opts() is a copy.
    cmd.on(`option:${option.name()}`, () => {
      delete cmd.opts()[key];
      cmd.setOptionValueWithSource("apply", true, "cli");
    });
  }
  return cmd;
}
