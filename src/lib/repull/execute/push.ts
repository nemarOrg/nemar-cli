/**
 * The one way execution pushes (ADR 0111, decision 2): through the write guard, with `--porcelain`
 * so a rejection is told apart from a failure, and with the credentials in the environment, never
 * the argv.
 *
 * Three things are told apart, because the caller treats them differently:
 *  - `rejected`: origin moved under the push (`fetch first`, `non-fast-forward`, a stale lease). The
 *    caller reads origin again and may try once more.
 *  - `remote-rejected`: origin's own rule refused the ref (a hook, a protected branch, a ruleset).
 *    Trying again cannot change it, so the caller stops.
 *  - `failed`: the push did not complete; `cause` is a fixed word for why (authentication, the
 *    network, or `unknown`), taken from git's output but never repeating it, since it names paths.
 */

import { type PushContext, assertRepullPush } from "../write-guard.js";
import { git } from "./workdir.js";

export type PushOutcome = "pushed" | "up-to-date" | "rejected" | "remote-rejected" | "failed";

/** Why a push failed or was refused, in fixed words. */
export type PushCause =
  | "moved"
  | "protected-branch"
  | "hook-declined"
  | "remote-refused"
  | "authentication"
  | "network"
  | "unknown";

export interface PushResult {
  outcome: PushOutcome;
  /** Set for `rejected`, `remote-rejected` and `failed`. */
  cause: PushCause | null;
}

/** The words for a refusal, naming the class. */
export function pushCauseWords(cause: PushCause | null): string {
  switch (cause) {
    case "moved":
      return "the remote moved under the push";
    case "protected-branch":
      return "the remote refused it as a protected branch";
    case "hook-declined":
      return "a hook on the remote declined it";
    case "remote-refused":
      return "the remote refused it";
    case "authentication":
      return "the credentials were refused";
    case "network":
      return "the remote could not be reached";
    default:
      return "for a reason git did not classify";
  }
}

function failureCause(stderr: string): PushCause {
  if (
    /Authentication failed|could not read Username|Permission denied|HTTP 40[13]|The requested URL returned error: 40[13]/i.test(
      stderr,
    )
  ) {
    return "authentication";
  }
  if (
    /Could not resolve host|unable to access|Connection (refused|timed out|reset)|Failed to connect|early EOF/i.test(
      stderr,
    )
  ) {
    return "network";
  }
  return "unknown";
}

/** Push one refspec to `origin` through the guard (`--delete <ref>` deletes one). */
export async function guardedPush(
  repo: string,
  refspec: readonly string[],
  ctx: PushContext,
  env: Record<string, string> | undefined,
  options: readonly string[] = [],
): Promise<PushResult> {
  const args = ["push", "--porcelain", ...options, "origin", ...refspec];
  assertRepullPush(args, ctx);
  const r = await git(repo, args, { ok: true, ...(env ? { env } : {}) });
  // `--porcelain`: `<flag>\t<from>:<to>\t<summary>` per ref; `!` is a rejection, `=` up to date.
  const lines = r.stdout
    .split("\n")
    .map((line) => /^([ +\-*!=])\t[^\t]*\t(.*)$/.exec(line))
    .filter((m): m is RegExpExecArray => m !== null);
  const rejected = lines.filter((m) => m[1] === "!");
  if (rejected.length > 0) {
    const summary = rejected.map((m) => m[2]).join(" ");
    // A ref that moved between the advertisement and the update is a race, whoever reports it.
    const raced =
      /incorrect old value provided|failed to update ref|cannot lock ref|stale info|fetch first|non-fast-forward/i;
    if (/\[remote rejected\]/i.test(summary) && !raced.test(summary)) {
      // GitHub names a protected branch in the summary and in its `remote:` lines on stderr.
      const said = `${summary} ${r.stderr}`;
      const cause: PushCause = /protected branch|GH006|GH013|repository rule violations/i.test(said)
        ? "protected-branch"
        : /hook declined/i.test(summary)
          ? "hook-declined"
          : "remote-refused";
      return { outcome: "remote-rejected", cause };
    }
    return { outcome: "rejected", cause: "moved" };
  }
  if (r.exitCode !== 0) {
    // A refusal git reports only on stderr (no porcelain line) is the remote's, not a race.
    if (
      /\[remote rejected\]|pre-receive hook declined|protected branch hook declined/i.test(r.stderr)
    ) {
      return { outcome: "remote-rejected", cause: "remote-refused" };
    }
    return { outcome: "failed", cause: failureCause(r.stderr) };
  }
  const flags = lines.map((m) => m[1]);
  return {
    outcome: flags.length > 0 && flags.every((f) => f === "=") ? "up-to-date" : "pushed",
    cause: null,
  };
}
