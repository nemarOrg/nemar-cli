/**
 * The `__complete` dispatch guard in src/index.ts's `main()` (epic #1144
 * phase 5b, issue #1149, D1 -- #1173 review).
 *
 * The guard used to check `process.argv[2] === "__complete"` positionally,
 * so any token typed before it -- a global flag like `--verbose` -- shifted
 * `__complete` out of position 2 and the guard silently stopped matching.
 * Falling through does not just make completion slow: Commander has no
 * `__complete` command registered at all (see src/commands/completion.ts's
 * own doc comment), so `parseAsync()` takes the `unknownCommand()` branch.
 * The real, measurable cost is what runs BEFORE that branch even gets a
 * chance to reject the request: `initUpdateCheck()`, which does a blocking
 * npm-registry fetch on a cold cache -- a fetch a shell pressing TAB should
 * never trigger.
 *
 * Driven entirely through the real CLI subprocess, matching
 * test/completion-network.unit.test.ts's pattern: the guard IS the
 * orchestration logic in `main()`, so there is no extracted helper worth
 * calling in isolation (`.rules/testing.md`'s [STRICT] "test the entry
 * point, not the piece" -- a test that imported some hand-pulled-out
 * predicate function would not exercise the actual argv main() receives).
 *
 * Every existing completion test sets `NEMAR_NO_UPDATE_CHECK=1`, which masks
 * this exact bug outright (`initUpdateCheck()` returns null immediately
 * regardless of whether the guard fired). None of the cases below set it,
 * so that masking cannot quietly come back. The signal instead is the
 * VERBOSE-only "[update-check] First run..." line `initUpdateCheck()`
 * prints SYNCHRONOUSLY, before it ever awaits the network fetch -- a
 * network-independent tell for "did the cold-start branch run at all",
 * which is the property this guard controls.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "bun";

const CLI_ENTRY = join(import.meta.dir, "..", "src", "index.ts");
const REPO_ROOT = join(import.meta.dir, "..");

let configDir: string;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "nemar-completion-argv-"));
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

/**
 * Spawns the real CLI with a fresh config dir (cold update-check cache) and
 * VERBOSE set, but deliberately WITHOUT NEMAR_NO_UPDATE_CHECK -- the whole
 * point is to leave initUpdateCheck()'s real cold-start path reachable, so
 * a regression that stops dispatching completion actually falls through to
 * it, exactly as it would for a real user.
 */
async function runColdStart(
  args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    NEMAR_CONFIG_DIR: configDir,
    VERBOSE: "1",
    NO_COLOR: "1",
  };
  env.FORCE_COLOR = undefined;
  env.CLICOLOR_FORCE = undefined;
  const proc = spawn({
    cmd: ["bun", "run", CLI_ENTRY, ...args],
    cwd: REPO_ROOT,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

describe("regression: the __complete guard must not be bypassed by a preceding token (#1173)", () => {
  test("a leading global flag (--verbose __complete) still dispatches completion, zero network", async () => {
    const result = await runColdStart(["--verbose", "__complete", "--", "dataset", "get", ""]);
    expect(result.exitCode).toBe(0);
    // Completion output shape: candidate lines followed by the cobra directive.
    expect(result.stdout.trimEnd().split("\n").pop()).toBe(":4");
    // The tell for "initUpdateCheck()'s cold-start branch ran": it prints
    // this synchronously, before ever awaiting the network fetch. Its
    // absence proves the guard fired and returned before initUpdateCheck()
    // was even reached -- not merely that a fetch happened to be fast.
    expect(result.stderr).not.toContain("[update-check] First run");
    // update-check.json is only ever written by writeCache(), which only
    // runs after a real fetch resolves with a version -- absence confirms
    // that path was never entered either.
    expect(existsSync(join(configDir, "update-check.json"))).toBe(false);
  });

  test("a second global-flag shape (--no-color __complete) also dispatches, zero network", async () => {
    const result = await runColdStart(["--no-color", "__complete", "--", "admin", ""]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toContain("[update-check] First run");
    expect(existsSync(join(configDir, "update-check.json"))).toBe(false);
  });

  test("the literal string '__complete' as a POSITIONAL VALUE must not dispatch completion", async () => {
    // `nemar dataset get __complete`: the first non-flag token is `dataset`,
    // not `__complete` -- completion must NOT fire here, and the normal
    // command path (which DOES pay initUpdateCheck()'s cold-start cost)
    // must run instead, exactly as it would for any other command.
    const result = await runColdStart(["dataset", "get", "__complete"]);
    expect(result.stderr).toContain("[update-check] First run");
  });

  test("bare __complete with no preceding token still works (unaffected by the fix)", async () => {
    const result = await runColdStart(["__complete", "--", "dataset", ""]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toContain("[update-check] First run");
    expect(existsSync(join(configDir, "update-check.json"))).toBe(false);
  });
});
