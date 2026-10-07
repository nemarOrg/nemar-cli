/**
 * Keep a subcommand's value-taking option from being swallowed by a root
 * option of the same name (#1493).
 *
 * Commander recognises a program-level option anywhere on the command line
 * unless positional options are enabled, and enabling them would break every
 * global flag typed after the subcommand (`nemar dataset upload ./x --verbose`).
 * So `nemar dataset release nm000104 --version 2.0.0`, the form the release
 * help documents, was eaten by the root `-v, --version`: the CLI printed its
 * own version and exited 0, and a scripted release (`-y`) silently did nothing.
 * The equals form (`--version=2.0.0`) already reached the subcommand, because
 * the root option is a boolean and does not match `--flag=value`.
 *
 * This rewrites exactly that case before Commander sees it: for the leaf
 * command named on the line, every option that TAKES A VALUE and whose long
 * flag an ancestor declares as a BOOLEAN is joined to its value
 * (`--version 2.0.0` -> `--version=2.0.0`).
 *
 * A shadowed flag with NO value (last token, empty, or followed by another
 * flag) is an error, not a pass-through: left alone, the root would eat it and print
 * the CLI version, which is the same silent no-op for a scripted `-y` release.
 * The function throws {@link MissingShadowedValueError}; the caller reports it
 * through Commander so the message and exit code are Commander's own.
 *
 * Nothing else changes: anything after `--`, a flag spelled `--flag=value`,
 * and boolean collisions (#1220, `-v` vs `-v, --verbose`) are left alone.
 * An ancestor option that takes a value too (`admin recover status
 * --recover-file`, read back through `optsWithGlobals()`) consumes the flag and
 * its value together, so nothing is rewritten there.
 * An OPTIONAL-value shadowed option (`--flag [value]`) is joined when it has a
 * value but cannot be made to work without one: a bare flag has no spelling
 * the root will not claim. None exists today; a test pins that.
 */

import type { Command, Option } from "commander";

/**
 * A shadowed value-taking option was written without a value. Carries the
 * command that declares it so the caller can fail the way Commander would.
 */
export class MissingShadowedValueError extends Error {
  readonly command: Command;
  readonly option: Option;

  constructor(command: Command, option: Option) {
    // Commander's own wording for a required option with no argument.
    super(`error: option '${option.flags}' argument missing`);
    this.name = "MissingShadowedValueError";
    this.command = command;
    this.option = option;
  }
}

function optionFlags(option: Option): string[] {
  return [option.long, option.short].filter((f): f is string => typeof f === "string");
}

function findSubcommand(cmd: Command, name: string): Command | undefined {
  return cmd.commands.find((c) => c.name() === name || c.aliases().includes(name));
}

/**
 * The value-taking options of `command` that an ancestor's BOOLEAN option of
 * the same long flag would claim first, keyed by that long flag.
 *
 * The outermost ancestor declaring a flag is the one Commander parses it
 * with. A boolean takes the flag and leaves the value behind as a stray
 * argument, so those are the options that need a join. An ancestor that takes a
 * value itself (`admin recover --recover-file`) consumes the flag and its value
 * together, so nothing is shadowed.
 */
function shadowedOptions(command: Command, ancestors: readonly Command[]): Map<string, Option> {
  const claimedBy = new Map<string, Option>();
  for (const ancestor of ancestors) {
    for (const o of ancestor.options as readonly Option[]) {
      for (const f of optionFlags(o)) if (!claimedBy.has(f)) claimedBy.set(f, o);
    }
  }
  const shadowed = new Map<string, Option>();
  for (const o of command.options as readonly Option[]) {
    if (!(o.required || o.optional) || !o.long) continue;
    const claimant = claimedBy.get(o.long);
    if (claimant && !(claimant.required || claimant.optional)) shadowed.set(o.long, o);
  }
  return shadowed;
}

/**
 * Return `argv` (user arguments, i.e. `process.argv.slice(2)`) with shadowed
 * value options of the addressed subcommand joined to their values.
 *
 * @throws {MissingShadowedValueError} a shadowed option that requires a value
 *   appears with none.
 */
export function bindShadowedOptionValues(root: Command, argv: string[]): string[] {
  // Walk to the leaf command: descend while a non-flag token names a
  // subcommand of the current one. Every root option is a boolean, so skipping
  // any token starting with "-" is enough here. The one value-taking option on
  // a command that also has subcommands (`admin recover --recover-file`) could
  // only mislead this walk if its value spelled a subcommand name.
  const ancestors: Command[] = [];
  let current = root;
  let leafIndex = -1;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--") break;
    if (token.startsWith("-")) continue;
    const sub = findSubcommand(current, token);
    if (!sub) break;
    ancestors.push(current);
    current = sub;
    leafIndex = i;
  }
  if (leafIndex < 0) return argv;

  const shadowed = shadowedOptions(current, ancestors);
  if (shadowed.size === 0) return argv;

  const out = argv.slice(0, leafIndex + 1);
  for (let i = leafIndex + 1; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--") {
      out.push(...argv.slice(i));
      break;
    }
    const option = shadowed.get(token);
    if (!option) {
      out.push(token);
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && next !== "" && !next.startsWith("-")) {
      out.push(`${token}=${next}`);
      i++;
    } else if (option.required) {
      throw new MissingShadowedValueError(current, option);
    } else {
      out.push(token);
    }
  }
  return out;
}
