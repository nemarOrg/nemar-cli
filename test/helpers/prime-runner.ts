/**
 * Run `primeIndexStat` in its own process and send that process `signal` while the
 * filter process is out of the repository's configuration, so a test can see what the
 * real handler (or, for SIGKILL, no handler) leaves behind.
 *
 * usage: bun run prime-runner.ts <dataset dir> <signal> <delay ms> <chunk> <chunk size> <path>...
 *
 * The signal is sent in chunk number `chunk` (from 0), `delay` milliseconds after that
 * chunk's value was taken out, so a test can let its `git add --refresh` start first.
 * Prints the result as one JSON line if it lives to. A signal sent to the test runner
 * itself would end the test run, hence the separate process.
 */

import { primeIndexStat } from "../../src/lib/git-annex/index-prime";

const [dir, signal, delay, target, chunkPaths, ...paths] = process.argv.slice(2);
const result = await primeIndexStat(dir, paths, {
  chunkPaths: Number(chunkPaths),
  onSuspended: (chunk) => {
    if (chunk !== Number(target)) return;
    const send = () => process.kill(process.pid, signal as NodeJS.Signals);
    if (Number(delay) > 0) setTimeout(send, Number(delay));
    else send();
  },
});
console.log(JSON.stringify(result));
