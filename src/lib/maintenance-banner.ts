import chalk from "chalk";
import type { MaintenanceError } from "./api.js";

let printed = false;

/**
 * Print a bordered maintenance banner to stderr, at most once per process.
 * Called from `request()` the first time a MaintenanceError is thrown so the
 * banner surfaces even when per-command catches swallow the error to print
 * `err.message` themselves.
 */
export function printMaintenanceBanner(err: MaintenanceError): void {
  if (printed) return;
  printed = true;
  const border = chalk.yellow("\u2500".repeat(60));
  const tag = chalk.yellow.bold("[MAINTENANCE]");
  const modeLine = chalk.dim(`mode: ${err.mode}`);
  const etaLine = err.eta ? `\n${chalk.dim(`eta:  ${err.eta}`)}` : "";
  process.stderr.write(`${border}\n${tag} ${err.message}\n${modeLine}${etaLine}\n${border}\n`);
}
