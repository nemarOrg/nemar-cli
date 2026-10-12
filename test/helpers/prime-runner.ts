/**
 * Run `primeIndexStat` in its own process and send that process `signal` while the
 * filter process is out of the repository's configuration, so a test can see what the
 * real handler (or, for SIGKILL, no handler) leaves behind.
 *
 * usage: bun run prime-runner.ts <dataset dir> <signal> <path>...
 *
 * Prints the result as one JSON line if it lives to. A signal sent to the test runner
 * itself would end the test run, hence the separate process.
 */

import { primeIndexStat } from "../../src/lib/git-annex/index-prime";

const [dir, signal, ...paths] = process.argv.slice(2);
const result = await primeIndexStat(dir, paths, {
  onSuspended: () => {
    process.kill(process.pid, signal as NodeJS.Signals);
  },
});
console.log(JSON.stringify(result));
