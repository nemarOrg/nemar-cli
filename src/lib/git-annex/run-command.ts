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

/** Header tuples that carry credentials in git-annex's printed `HttpExceptionRequest`. */
const CREDENTIAL_HEADER =
  /\(\s*"((?:x-amz-)[^"]*|authorization|proxy-authorization)"\s*,\s*"[^"]*"\s*\)/gi;

/** The shortest value worth blanking: a shorter "secret" would blank half of any message. */
const MIN_SECRET_LENGTH = 8;

/**
 * Take credentials out of text a subprocess printed. A failed S3 request makes git-annex
 * print the whole request it built, and that dump carries `("X-Amz-Security-Token",
 * "<token>")` (only `Authorization` is redacted by git-annex itself). Header tuples named
 * `x-amz-*`, `authorization` and `proxy-authorization` are blanked, and so is any value
 * in `secrets` of at least {@link MIN_SECRET_LENGTH} characters, wherever it appears.
 * Exported for unit tests.
 */
export function redactCredentials(text: string, secrets: readonly string[] = []): string {
  let out = text.replace(CREDENTIAL_HEADER, '("$1","<redacted>")');
  for (const secret of secrets) {
    if (secret.length >= MIN_SECRET_LENGTH) out = out.split(secret).join("<redacted>");
  }
  return out;
}

/**
 * The AWS credentials a command runs with, as values to blank from anything it printed:
 * the ones it is given in `env` and the ones it inherits from this process (the import
 * path runs on ambient AWS_* variables, and the child sees both).
 */
export function credentialValues(env?: Record<string, string | undefined>): string[] {
  const names = ["AWS_SESSION_TOKEN", "AWS_SECRET_ACCESS_KEY", "AWS_ACCESS_KEY_ID"] as const;
  const values = new Set<string>();
  for (const source of [process.env, env ?? {}]) {
    for (const name of names) {
      const v = source[name];
      if (typeof v === "string" && v.length > 0) values.add(v);
    }
  }
  return [...values];
}

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
    /**
     * Fed to the child on stdin and then closed. Needed by git-annex's `--batch`
     * interfaces, which are the difference between one process and one per item.
     */
    stdin?: string;
  } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean }> {
  const childEnv: Record<string, string | undefined> = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    ...options.env,
  };
  for (const key of options.unsetEnv ?? []) delete childEnv[key];
  const proc = spawn({
    cmd,
    cwd: options.cwd,
    ...(options.stdin === undefined
      ? {}
      : { stdin: new TextEncoder().encode(options.stdin) as Uint8Array }),
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

  // What the log shows is credential-free: a failed S3 request makes git-annex print the
  // request it built, session token included, and a credential could as well be in an
  // argument.
  const secrets = isVerbose() ? credentialValues(childEnv) : [];
  if (isVerbose()) {
    const cwdHint = options.cwd ? ` (cwd=${options.cwd})` : "";
    vlog(chalk.dim(redactCredentials(`$ ${cmd.join(" ")}${cwdHint}`, secrets)));
  }

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  if (timer) clearTimeout(timer);

  if (isVerbose()) {
    if (stdout.trim()) vlog(chalk.dim(redactCredentials(stdout.trimEnd(), secrets)));
    if (stderr.trim()) vlog(chalk.yellow(redactCredentials(stderr.trimEnd(), secrets)));
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
      timedOut: true,
    };
  }

  return { stdout, stderr, exitCode, timedOut: false };
}
