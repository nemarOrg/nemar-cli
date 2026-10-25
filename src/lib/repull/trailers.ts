/**
 * The two trailers a re-pull's commit carries (ADR 0111, decision 2), read as git reads them: the
 * last paragraph of the message, through `git interpret-trailers`.
 *
 * The merge that lands N.0.0 on `main` must end its squash commit message with both, because the
 * privacy ledger's fresh-clone proof (ADR 0085) accepts the re-pull's commit appending a
 * `repull-scrubbed` line beside other files only when that commit carries them as git reads
 * trailers; GitHub's default squash message lists each commit of the pull request as a bullet and
 * puts them mid-message, which would fail the dataset (`ledger-commit-not-alone`). So the merge
 * writes the message itself, and checks it here, with the proof's own patterns, before anything is
 * claimed or sent. The re-synthesis onto a moved `main` checks the commit it makes the same way.
 */

import { tmpdir } from "node:os";
import {
  REPULL_PLAN_TRAILER,
  UPSTREAM_SNAPSHOT_TRAILER,
} from "../../../scripts/scrub/git/git-lib.js";
import { runCommand } from "../git-annex/run-command.js";
import { ISOLATED_GIT_ENV } from "./execute/workdir.js";

/** The two lines, exactly as the re-pull commit and its squash merge carry them. */
export function repullTrailerLines(r: {
  upstream_ds: string;
  to_tag: string;
  plan_digest: string;
}): [string, string] {
  return [`Upstream-Snapshot: ${r.upstream_ds}@${r.to_tag}`, `Repull-Plan: ${r.plan_digest}`];
}

/**
 * Why `message` (a whole commit message: subject, body, trailers) does not end with exactly the
 * two expected trailers as git reads them, or null when it does. Each key must appear once, with
 * the expected value, and match the ledger proof's pattern; nothing else is required of the rest.
 */
export async function trailersProblem(
  message: string,
  expected: { upstream_ds: string; to_tag: string; plan_digest: string },
): Promise<string | null> {
  const r = await runCommand(["git", "interpret-trailers", "--parse", "--no-divider"], {
    cwd: tmpdir(),
    stdin: message,
    env: { ...ISOLATED_GIT_ENV },
  });
  if (r.exitCode !== 0) return "git could not read the message's trailers";
  const lines = r.stdout.split("\n").filter((l) => l.trim() !== "");
  const [snapshot, plan] = repullTrailerLines(expected);
  for (const [want, key, pattern] of [
    [snapshot, "Upstream-Snapshot:", UPSTREAM_SNAPSHOT_TRAILER],
    [plan, "Repull-Plan:", REPULL_PLAN_TRAILER],
  ] as const) {
    const named = lines.filter((l) => l.startsWith(key));
    if (named.length !== 1) {
      return named.length === 0
        ? `its last paragraph carries no ${key} trailer`
        : `its last paragraph carries ${named.length} ${key} trailers`;
    }
    if (named[0] !== want || !pattern.test(want)) {
      return `its ${key} trailer is not the re-pull's own`;
    }
  }
  return null;
}
