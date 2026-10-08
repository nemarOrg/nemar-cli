/**
 * A `git` that behaves exactly like the real one except for the invocations a test
 * asks it to change.
 *
 * Fault injection for code that shells out to git: the shim sits first on PATH,
 * matches the argument string against each rule, and changes only those calls,
 * letting every other call (including the ones git-annex makes internally) run the
 * real git untouched. A rule can fail the call, kill it, make it succeed with output
 * nobody expected (`stdout`), run it for real with extra environment variables (`env`),
 * make it hang first (`sleep`), note that it happened (`log`), or make it hold
 * `index.lock` the way a slow git does (`holdLock`). The repository, the index and the
 * commits are all real.
 *
 * `env` exists so a test can steer ONE child process (for example point git-annex's
 * HTTP client at a dead local proxy) without writing to `process.env`: Bun keeps a
 * proxy variable set in-process for every later `fetch` of the whole test run, even
 * after the variable is restored, so a proxy written there fails unrelated tests that
 * happen to run later in the same process.
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
  /**
   * Export these variables for the matching call and run the real git. Combines with
   * nothing else on the rule: it neither fails nor counts.
   */
  env?: Record<string, string>;
  /**
   * Sleep this many seconds, then run the real git: a call that hangs. Like `env` it
   * neither fails nor counts.
   */
  sleep?: number;
  /** Append the call's arguments, one line per call, to this file, then carry on. */
  log?: string;
  /**
   * Instead of running git, hold `.git/index.lock` for this many seconds and then fail:
   * a stand-in for a git busy with slow work. Like the real one it removes its lock and
   * exits when it receives SIGTERM, SIGINT or SIGHUP. `log`, when given, is written once
   * the lock exists, so a test can wait on it.
   */
  holdLock?: number;
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
    if (
      rule.env ||
      rule.sleep !== undefined ||
      rule.log !== undefined ||
      rule.holdLock !== undefined
    ) {
      const lines: string[] = Object.entries(rule.env ?? {}).map(
        ([k, v]) => `  export ${k}=${quote(v)}`,
      );
      if (rule.holdLock !== undefined) {
        lines.push('  gd=$("$real" rev-parse --absolute-git-dir)', '  : > "$gd/index.lock"');
      }
      if (rule.log !== undefined) lines.push(`  printf '%s\\n' "$args" >> ${quote(rule.log)}`);
      if (rule.sleep !== undefined) lines.push(`  sleep ${rule.sleep}`);
      if (rule.holdLock !== undefined) {
        lines.push(
          `  sleep ${rule.holdLock} & pid=$!`,
          `  trap 'kill $pid 2>/dev/null; rm -f "$gd/index.lock"; exit 143' TERM INT HUP`,
          "  wait $pid",
          '  rm -f "$gd/index.lock"',
          "  exit 1",
        );
      }
      return [`case "$args" in *${quote(rule.match)}*)`, ...lines, "  ;;", "esac"].join("\n");
    }
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
