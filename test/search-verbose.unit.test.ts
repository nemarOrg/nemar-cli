/**
 * `nemar dataset search --verbose` actually turns the README snippet line on
 * (owner decision 2026-09-03, partially supersedes #1150 D2: Score stays
 * dropped, the snippet line flips from always-on to opt-in). Driven through
 * the real CLI subprocess against a local stub (see helpers/search-stub.ts),
 * not by calling `renderSearchResultLines({ snippets: true })` directly --
 * that only proves the renderer's own branch works (covered already by
 * test/search-column-width.unit.test.ts), not that the `search` command's
 * `--verbose` flag actually reaches it.
 *
 * That distinction is load-bearing, not decorative (.rules/testing.md "test
 * the entry point, not the piece"): this repo's root command binds `-v` to
 * `--version` (`.version(version, "-v, --version", ...)`, src/index.ts), and
 * Commander resolves every token in the full argv against the
 * currently-parsing command's OWN options top-down, before subcommand
 * dispatch -- so root's `--verbose` (also one of its four global options)
 * silently consumes a same-named subcommand-local option's value no matter
 * where in argv it appears. A unit test against `renderSearchResultLines`
 * alone cannot see this: it would have stayed green even when
 * `nemar dataset search --verbose` did nothing at all, which is exactly what
 * happened during implementation until `searchVerboseRequested()`
 * (src/commands/dataset.ts) was written to read the value via
 * `searchCommand.optsWithGlobals()` instead of `options.verbose`.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "bun";
import { startSearchStub } from "./helpers/search-stub";

const CLI_ENTRY = join(import.meta.dir, "..", "src", "index.ts");
const REPO_ROOT = join(import.meta.dir, "..");
const QUERY = "P300";

async function runSearch(
  args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const configDir = mkdtempSync(join(tmpdir(), "nemar-search-verbose-"));
  const stub = startSearchStub();
  const env: Record<string, string | undefined> = {
    ...process.env,
    NEMAR_CONFIG_DIR: configDir,
    NO_COLOR: "1",
    FORCE_COLOR: undefined,
    CLICOLOR_FORCE: undefined,
    TEST_API_URL: stub.url,
    NEMAR_NO_UPDATE_CHECK: "1",
  };
  try {
    const proc = spawn({
      cmd: ["bun", "run", CLI_ENTRY, "dataset", "search", QUERY, "--limit", "5", ...args],
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
    stub.stop();
    rmSync(configDir, { recursive: true, force: true });
  }
}

describe("nemar dataset search --verbose (owner decision 2026-09-03)", () => {
  test("with no flag, the stub's snippet text is not printed", async () => {
    const { stdout, exitCode } = await runSearch([]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Search results for");
    // helpers/search-stub.ts's fixture snippet, sanitised text.
    expect(stdout).not.toContain("Target (");
    expect(stdout).not.toContain("expected");
  });

  test("--verbose actually reaches the renderer and prints the snippet line", async () => {
    const { stdout, exitCode } = await runSearch(["--verbose"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Search results for");
    // The row itself must still be there -- --verbose adds a line, it does
    // not replace the compact table.
    expect(stdout).toContain("nm900111");
    expect(stdout).toContain("P300");
    expect(stdout).toContain("expected");
  });

  test("the second stub result (no snippet field) never grows a blank snippet line under --verbose", async () => {
    const { stdout, exitCode } = await runSearch(["--verbose"]);
    expect(exitCode).toBe(0);
    const lines = stdout.split("\n");
    const secondRowIndex = lines.findIndex((line) => line.includes("nm900222"));
    expect(secondRowIndex).toBeGreaterThan(-1);
    // Whatever follows the second row is either blank (end of table) or the
    // "For details" footer -- never a snippet line, since that result has
    // no `snippet` field in the stub fixture.
    const nextLine = lines[secondRowIndex + 1] ?? "";
    expect(nextLine.trim().startsWith("Target") || nextLine.includes("expected")).toBe(false);
  });

  // A regression guard for the exact footgun discovered implementing this
  // flag, not a claim that `-v` is a supported alias: the root command's
  // `-v, --version` unconditionally wins, so `-v` must never be documented
  // or relied on as shorthand for `--verbose` here. If this starts failing
  // because `-v` began enabling snippets, `--help`'s option table (asserted
  // in test/cli.test.ts) needs updating in the same PR, not just this test.
  test("-v is version's alias, not verbose's: it prints the version and never runs the search", async () => {
    const { stdout, exitCode } = await runSearch(["-v"]);
    expect(exitCode).toBe(0);
    expect(stdout).not.toContain("Search results for");
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
