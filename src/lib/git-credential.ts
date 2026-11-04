/**
 * `nemar auth git-credential`: a git credential helper for authenticated NEMAR data hosts
 * (ADR 0114).
 *
 * git starts a helper as `<helper> get|store|erase` and talks to it on stdin and stdout in
 * `key=value` lines. This one answers `get` for one kind of request only: `protocol` and `host`
 * name an origin that is on this CLI's list of data hosts (`src/lib/data-hosts.ts`). The answer
 * is the user name `nemar` and the stored API key as the password, which the data host reads as
 * HTTP Basic. Any other host, any `http` request for a host that is not a loopback test host,
 * and a missing key get no answer at all, so git falls through to whatever else it is
 * configured to ask. `store` and `erase` do nothing: the key lives in the CLI's own config and
 * never in git's credential store or a clone's `.git/config`.
 *
 * stdout is read by git, so a run prints exactly the answer and nothing else (the entry point
 * skips the update check, the notices and the dev-build banner for this command).
 */

import { type DataHostOptions, isAllowedDataHost } from "./data-hosts.js";

/** The user name given to git; the data host ignores it. */
export const CREDENTIAL_USERNAME = "nemar";

/** Parse the lines git sends: `key=value`, ended by a blank line. */
export function parseCredentialInput(text: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const clean = line.replace(/\r$/, "");
    if (clean === "") break;
    const at = clean.indexOf("=");
    if (at <= 0) continue;
    fields[clean.slice(0, at)] = clean.slice(at + 1);
  }
  return fields;
}

/** True when git's request (`protocol` and `host`) names an allow-listed data host. */
export function asksForDataHost(
  input: Record<string, string>,
  options: DataHostOptions = {},
): boolean {
  const { protocol, host } = input;
  if (!protocol || !host) return false;
  // `host` carries the port when there is one. Anything that is not a plain authority (a
  // path, credentials) cannot be the origin of a data host.
  if (/[/?#@\s]/.test(host)) return false;
  return isAllowedDataHost(`${protocol}://${host}`, options);
}

/**
 * What to print for one helper call. Empty for everything but a `get` for an allow-listed host
 * with a key stored.
 */
export function credentialAnswer(
  operation: string,
  input: Record<string, string>,
  apiKey: string | undefined,
  options: DataHostOptions = {},
): string {
  if (operation !== "get" || !apiKey || !asksForDataHost(input, options)) return "";
  return `username=${CREDENTIAL_USERNAME}\npassword=${apiKey}\n`;
}

/**
 * Whether `argv` (the command line without the program) runs this helper. The entry point uses
 * it to keep the helper's output exactly what git expects.
 */
export function isGitCredentialInvocation(argv: readonly string[]): boolean {
  const words = argv.filter((arg) => !arg.startsWith("-"));
  return words[0] === "auth" && words[1] === "git-credential";
}
