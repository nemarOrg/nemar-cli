/**
 * git-annex service: subprocess wrapper.
 *
 * Split from lib/git-annex.ts by concern (#908, epic #902); body moved
 * verbatim. Every other git-annex/* module (and e2e-test) shells out
 * through runCommand -- keep GIT_TERMINAL_PROMPT=0 and the unsetEnv
 * delete-vs-blank semantics (#768) intact; both are pinned by
 * test/run-command-env.test.ts.
 */

import { spawn } from "bun";
import chalk from "chalk";
import { isVerbose, vlog } from "../verbose.js";

/**
 * Run a command and return stdout, stderr, and exit code.
 *
 * Sets GIT_TERMINAL_PROMPT=0 to prevent git from blocking on credential
 * prompts (which causes the CLI to appear hung). Callers can override
 * via options.env.
 *
 * An optional `timeout` (ms) kills the subprocess if exceeded; the returned
 * stderr will contain a timeout message and exitCode defaults to 1.
 */
export async function runCommand(
  cmd: string[],
  options: {
    cwd?: string;
    env?: Record<string, string>;
    /**
     * Names to remove from the child's environment entirely. Setting a var to
     * "" is NOT the same as unsetting it: git-annex signs S3 requests when
     * AWS_ACCESS_KEY_ID is present (even empty) and only falls back to anonymous
     * access when it is absent. Used to fetch annexed metadata from OpenNeuro's
     * public bucket without NEMAR's CI creds (#768).
     */
    unsetEnv?: string[];
    /** Kill the process after this many milliseconds */
    timeout?: number;
  } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const childEnv: Record<string, string | undefined> = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    ...options.env,
  };
  for (const key of options.unsetEnv ?? []) delete childEnv[key];
  const proc = spawn({
    cmd,
    cwd: options.cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: childEnv,
  });

  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (options.timeout) {
    timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, options.timeout);
  }

  if (isVerbose()) {
    const cwdHint = options.cwd ? ` (cwd=${options.cwd})` : "";
    vlog(chalk.dim(`$ ${cmd.join(" ")}${cwdHint}`));
  }

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  if (timer) clearTimeout(timer);

  if (isVerbose()) {
    if (stdout.trim()) vlog(chalk.dim(stdout.trimEnd()));
    if (stderr.trim()) vlog(chalk.yellow(stderr.trimEnd()));
    vlog(chalk.dim(`(exit ${exitCode})`));
  }

  if (timedOut) {
    return {
      stdout,
      // `timedOut === true` implies options.timeout was set (see the guard
      // earlier in this function), so the cast is sound. Using a type-only
      // assertion rather than `?? 0` keeps the original semantics: a future
      // refactor that reaches this branch without a timeout configured will
      // surface the bug as an obvious "NaN s" message rather than a silent
      // "0s" misreport.
      stderr:
        stderr || `Command timed out after ${Math.round((options.timeout as number) / 1000)}s`,
      exitCode: exitCode ?? 1,
    };
  }

  return { stdout, stderr, exitCode };
}
