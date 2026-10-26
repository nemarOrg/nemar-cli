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
import { repullTrailerLines } from "../../../shared/repull-squash.js";
import { runCommand } from "../git-annex/run-command.js";
import { ISOLATED_GIT_ENV } from "./execute/workdir.js";

// The two lines: one formatter, `repullTrailerLines` in `shared/repull-squash.ts`, which builds the
// squash message the administrator's gate and the Worker's merge both send, the check below, and
// the N.0.1 patch commit (`patchMessage`). Three sites still write the same lines by hand: the
// re-pull commit's own message (`execute/synthesize.ts`) and the N.0.0 and N.0.1 pull request
// bodies (`execute/pull-request.ts`, `patch-turn.ts`).
export { repullTrailerLines };

/**
 * Why `message` (a whole commit message: subject, body, trailers) does not carry both expected
 * trailers in its last paragraph as git reads them, or null when it does. Each of the two keys must
 * appear there once, with the record's value, and match the ledger proof's pattern; other trailers
 * beside them are allowed, as the proof's patterns allow them, and nothing is required of the rest.
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
