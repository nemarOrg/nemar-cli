/**
 * The one way execution pushes (ADR 0111, decision 2): through the write guard, with `--porcelain`
 * so a rejection (the remote moved) is told apart from a failure, and with the credentials in the
 * environment, never the argv.
 */

import { type PushContext, assertRepullPush } from "../write-guard.js";
import { git } from "./workdir.js";

export type PushOutcome = "pushed" | "up-to-date" | "rejected" | "failed";

/** Push one refspec to `origin` through the guard (`--delete <ref>` deletes one). */
export async function guardedPush(
  repo: string,
  refspec: readonly string[],
  ctx: PushContext,
  env: Record<string, string> | undefined,
  options: readonly string[] = [],
): Promise<PushOutcome> {
  const args = ["push", "--porcelain", ...options, "origin", ...refspec];
  assertRepullPush(args, ctx);
  const r = await git(repo, args, { ok: true, ...(env ? { env } : {}) });
  // `--porcelain`: `<flag>\t<from>:<to>\t<summary>` per ref; `!` is a rejection, `=` up to date.
  const flags = r.stdout
    .split("\n")
    .map((line) => /^([ +\-*!=])\t/.exec(line)?.[1])
    .filter((f): f is string => f !== undefined);
  if (flags.includes("!")) return "rejected";
  if (r.exitCode !== 0) return "failed";
  return flags.length > 0 && flags.every((f) => f === "=") ? "up-to-date" : "pushed";
}
