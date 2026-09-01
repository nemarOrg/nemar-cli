/**
 * `nemar dataset search` must never emit an ANSI escape code when colour is
 * disabled -- under NO_COLOR=1, under --no-color, and when stdout is piped
 * (non-TTY). This is issue #1150's own Definition of Done item (epic #1144
 * phase 6, D5): the plan explicitly says chalk 5's claim to handle all three
 * itself is something to VERIFY, not restate (.rules/documentation.md's "a
 * claim in a plan is a claim in the code").
 *
 * Driven through the real `nemar dataset search` subprocess against the
 * live, public, read-only search endpoint (no auth, no mutation possible)
 * so this is the actual entry point, not a re-implementation of chalk's
 * logic. Asserts on raw bytes (a literal escape byte), not a chalk API.
 *
 * FORCE_COLOR/CLICOLOR_FORCE are stripped from every spawn's env: this
 * sandbox's ambient shell sets FORCE_COLOR=1 (confirmed by direct probe
 * during implementation -- see test/cli-output.unit.test.ts and
 * test/completion-candidate-sanitization.unit.test.ts for the same
 * precedent), which outranks NO_COLOR/non-TTY in chalk's own precedence
 * order and would make every "no colour" assertion below vacuously true
 * for the wrong reason if left set.
 *
 * TEST_API_URL is also explicitly cleared. `bun test` runs every file in
 * one process, and test/maintenance-client.test.ts's `afterAll` restores it
 * with `process.env.TEST_API_URL = previousTestApiUrl` -- unguarded, unlike
 * test/publish-progress.test.ts's equivalent restore. Node/Bun coerce
 * assigning `undefined` to a `process.env` key into the literal string
 * `"undefined"` rather than deleting it, so once that file has run in this
 * environment (no test/.env.test => TEST_API_URL was never set to begin
 * with), `process.env.TEST_API_URL` is left holding `"undefined"` for every
 * test that runs afterward in the same process -- a real, pre-existing
 * test-isolation bug (confirmed by a 2-file repro:
 * `bun test test/maintenance-client.test.ts test/search-color.unit.test.ts`
 * fails 5/12 with `getApiUrl()` returning the string "undefined"; this file
 * alone, or with test/api.test.ts + test/cli.test.ts instead, passes clean).
 * Clearing it here is a workaround for THIS file rather than a fix for that
 * one -- see the phase report for the recommended follow-up.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "bun";

const CLI_ENTRY = join(import.meta.dir, "..", "src", "index.ts");
const REPO_ROOT = join(import.meta.dir, "..");
const ESC = String.fromCharCode(27);

// A query guaranteed to have at least one dataset with an https://api.nemar.org
// snippet and an HED-flagged row, so a "colour on" run actually has
// something to colour (id, HED badge, matched snippet term) -- otherwise an
// empty or trivial result set would make the "no escape codes" assertions
// pass for the wrong reason (nothing was ever going to print colour).
const LIVE_QUERY = "P300";

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function runSearch(
  envOverrides: Record<string, string | undefined>,
  extraArgs: string[] = [],
): Promise<RunResult> {
  const configDir = mkdtempSync(join(tmpdir(), "nemar-search-color-"));
  const env: Record<string, string | undefined> = {
    ...process.env,
    NEMAR_CONFIG_DIR: configDir,
    FORCE_COLOR: undefined,
    CLICOLOR_FORCE: undefined,
    NO_COLOR: undefined,
    // See the file-level comment: neutralises a pre-existing cross-file
    // test-isolation bug rather than depending on it not having run yet.
    TEST_API_URL: undefined,
    ...envOverrides,
  };
  try {
    const proc = spawn({
      cmd: ["bun", "run", CLI_ENTRY, "dataset", "search", LIVE_QUERY, "--limit", "5", ...extraArgs],
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
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
}

describe("nemar dataset search colour output (#1150 DoD)", () => {
  test("positive control: FORCE_COLOR=1 actually emits an escape byte", async () => {
    const result = await runSearch({ FORCE_COLOR: "1" });
    expect(result.exitCode).toBe(0);
    // Proves the assertions below aren't vacuously true because this
    // command never colours anything in the first place.
    expect(result.stdout.includes(ESC)).toBe(true);
  });

  test("NO_COLOR=1 emits no escape byte", async () => {
    const result = await runSearch({ NO_COLOR: "1" });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.includes(ESC)).toBe(false);
    expect(result.stderr.includes(ESC)).toBe(false);
  });

  test("--no-color emits no escape byte", async () => {
    const result = await runSearch({}, ["--no-color"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.includes(ESC)).toBe(false);
  });

  test("piped/non-TTY stdout (no NO_COLOR, no --no-color) emits no escape byte", async () => {
    const result = await runSearch({});
    expect(result.exitCode).toBe(0);
    expect(result.stdout.includes(ESC)).toBe(false);
  });

  test("TERM=dumb still produces readable output and exits 0 (#1150 D7)", async () => {
    const result = await runSearch({ TERM: "dumb" });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.includes(ESC)).toBe(false);
    expect(result.stdout).toContain("Search results for");
    expect(result.stdout).not.toContain("Score");
  });
});
