/**
 * Verbose logging flag shared across CLI modules.
 * Kept dependency-free so any module can import it.
 */

let verbose = false;

export function setVerbose(value: boolean): void {
  verbose = value;
}

export function isVerbose(): boolean {
  return verbose;
}

/** Print to stderr only when verbose is on. */
export function vlog(message: string): void {
  if (verbose) {
    process.stderr.write(`${message}\n`);
  }
}
