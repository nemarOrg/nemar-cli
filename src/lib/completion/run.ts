/**
 * Entry point for `nemar __complete -- <words...>` (epic #1144 phase 5b,
 * issue #1149, D1). `program` is passed in by src/index.ts's `main()` rather
 * than imported from a module that imports index.ts, so this file never
 * creates an import cycle back to the module that builds the Command tree.
 *
 * Two guarantees this function makes that nothing else in the CLI has to:
 * it never performs network I/O (D1 -- not even a fetch with a short
 * timeout, since a timeout still pays DNS and connect on exactly the
 * captive-portal networks where this matters), and CANDIDATE RESOLUTION
 * never throws. The scope of that second one is deliberate: the try/catch
 * covers getCandidates(), not the stdout writes after it, so an EPIPE from
 * a closed stdout is still unhandled. Every shell script here invokes this
 * via command substitution and reads to EOF, so that path is not reachable
 * from the supported callers -- but it is not a whole-function guarantee
 * and the earlier wording implied it was (#1173 review). A
 * completion request that crashes mid-TAB is worse than one that silently
 * offers nothing, so any failure in candidate resolution is swallowed here
 * and degrades to zero candidates -- the same "no stack trace at the
 * prompt" policy D3 applies to the cache, extended to this whole path.
 */

import type { Command } from "commander";
import { CompletionDirective, getCandidates } from "./candidates.js";

export async function runComplete(program: Command, argv: string[]): Promise<void> {
  // The shell scripts (D4) always invoke `nemar __complete -- <words...>`;
  // drop the literal `--` separator if the caller passed it through.
  const words = argv[0] === "--" ? argv.slice(1) : argv;

  let candidates: string[] = [];
  try {
    candidates = getCandidates(program, words);
  } catch (err) {
    if (process.env.VERBOSE) {
      process.stderr.write(
        `[completion] candidate lookup failed: ${err instanceof Error ? err.message : err}\n`,
      );
    }
    candidates = [];
  }

  for (const candidate of candidates) {
    process.stdout.write(`${candidate}\n`);
  }
  process.stdout.write(`:${CompletionDirective.NoFileComp}\n`);
}
