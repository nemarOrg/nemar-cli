/**
 * Verbose logging state for CLI commands.
 *
 * Commands set this via `setVerbose(true)` (typically wired to a `--verbose`
 * flag); helpers in `git-annex.ts` and elsewhere check `isVerbose()` to decide
 * whether to print full subprocess invocations and stderr.
 *
 * Keep this dependency-free so any module can import it.
 */

let verbose = false;

export function setVerbose(value: boolean): void {
  verbose = value;
}

export function isVerbose(): boolean {
  return verbose;
}

/** Print to stderr only when verbose is on. Cheap no-op otherwise. */
export function vlog(message: string): void {
  if (verbose) {
    process.stderr.write(`${message}\n`);
  }
}
