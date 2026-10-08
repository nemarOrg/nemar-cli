/**
 * A `git` that behaves exactly like the real one except for the invocations a test
 * asks it to break.
 *
 * Fault injection for the failure paths of code that shells out to git: the shim
 * sits first on PATH, matches the argument string against each rule, and fails or
 * kills only those calls, letting every other call (including the ones git-annex
 * makes internally) run the real git untouched. Nothing is simulated beyond the
 * exit status of the calls named; the repository, the index and the commits are all
 * real.
 */

import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface ShimRule {
  /** A substring of the space-joined arguments, for example `ls-files -v`. */
  match: string;
  /** How many matching calls to let through untouched before breaking any; default 0. */
  after?: number;
  /** How many matching calls to break before passing through again; default: all of them. */
  times?: number;
  /** Exit status to fail with (default 128). Ignored when `kill` is set. */
  exit?: number;
  /** Kill the process with SIGKILL instead of exiting, the way an OOM kill looks. */
  kill?: boolean;
  /** Text for stderr. */
  message?: string;
  /**
   * Print this to stdout and exit with `exit` (default 0) WITHOUT running git: a git
   * that succeeds and says something nobody expected.
   */
  stdout?: string;
}

const quote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * Put the shim first on PATH for the current process (children inherit it) and
 * return the function that removes it. Always call the restorer in a `finally`.
 */
export function installGitShim(root: string, rules: ShimRule[]): () => void {
  const real = Bun.which("git");
  if (!real) throw new Error("git not found");
  const dir = join(root, `git-shim-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  const blocks = rules.map((rule, i) => {
    const counter = join(dir, `rule-${i}.count`);
    const skipped = join(dir, `rule-${i}.skip`);
    writeFileSync(counter, String(rule.times ?? -1));
    writeFileSync(skipped, String(rule.after ?? 0));
    let action: string;
    if (rule.kill) action = "kill -KILL $$";
    else if (rule.stdout !== undefined) {
      action = `printf '%s\\n' ${quote(rule.stdout)}; exit ${rule.exit ?? 0}`;
    } else {
      action = `echo ${quote(rule.message ?? "fatal: shim: injected failure")} >&2; exit ${rule.exit ?? 128}`;
    }
    return [
      `case "$args" in *${quote(rule.match)}*)`,
      `  skip=$(cat ${quote(skipped)})`,
      `  if [ "$skip" -gt 0 ]; then echo $((skip - 1)) > ${quote(skipped)}; else`,
      `  n=$(cat ${quote(counter)})`,
      `  if [ "$n" != "0" ]; then`,
      `    if [ "$n" -gt 0 ]; then echo $((n - 1)) > ${quote(counter)}; fi`,
      `    ${action}`,
      "  fi",
      "  fi;;",
      "esac",
    ].join("\n");
  });
  const script = [
    "#!/bin/sh",
    `real=${quote(real)}`,
    'args=" $* "',
    ...blocks,
    'exec "$real" "$@"',
    "",
  ].join("\n");
  writeFileSync(join(dir, "git"), script);
  chmodSync(join(dir, "git"), 0o755);
  const previous = process.env.PATH;
  process.env.PATH = `${dir}:${previous ?? ""}`;
  return () => {
    if (previous === undefined) Reflect.deleteProperty(process.env, "PATH");
    else process.env.PATH = previous;
  };
}
