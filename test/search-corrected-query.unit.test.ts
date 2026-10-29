/**
 * What a person sees when the backend replaced a misspelled word (`corrected_query`).
 *
 * Driven through the real CLI subprocess against a local stub of the search endpoint (the same
 * harness as search-score-column.unit.test.ts), because the line is rendered by the command's
 * action handler and that is the entry point. A wrong correction is only tolerable if it is
 * visible, so the assertions are about the person reading the terminal and the script reading
 * `--json`.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "bun";
import { STUB_SEARCH_BODY, startSearchStub } from "./helpers/search-stub";

const CLI_ENTRY = join(import.meta.dir, "..", "src", "index.ts");
const REPO_ROOT = join(import.meta.dir, "..");

async function runSearch(
  query: string,
  body: unknown,
  args: string[] = [],
): Promise<{ stdout: string; exitCode: number }> {
  const configDir = mkdtempSync(join(tmpdir(), "nemar-search-corrected-"));
  const stub = startSearchStub(body);
  const env = {
    ...process.env,
    NEMAR_CONFIG_DIR: configDir,
    NO_COLOR: "1",
    TEST_API_URL: stub.url,
    NEMAR_NO_UPDATE_CHECK: "1",
  };
  env.FORCE_COLOR = undefined;
  env.CLICOLOR_FORCE = undefined;
  try {
    const proc = spawn({
      cmd: ["bun", "run", CLI_ENTRY, "dataset", "search", query, ...args],
      cwd: REPO_ROOT,
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    return { stdout, exitCode: await proc.exited };
  } finally {
    stub.stop();
    rmSync(configDir, { recursive: true, force: true });
  }
}

describe("nemar dataset search, when a misspelling was corrected", () => {
  const corrected = { ...STUB_SEARCH_BODY, corrected_query: "bilingual performance study" };

  test("says what was searched, before the results", async () => {
    const { stdout, exitCode } = await runSearch("bilinugual performance study", corrected);
    expect(exitCode).toBe(0);
    const note =
      'Showing results for "bilingual performance study" instead of "bilinugual performance study".';
    expect(stdout).toContain(note);
    expect(stdout.indexOf(note)).toBeLessThan(stdout.indexOf("Search results for"));
  });

  test("says nothing about a correction when there was none", async () => {
    const { stdout, exitCode } = await runSearch("P300", STUB_SEARCH_BODY);
    expect(exitCode).toBe(0);
    expect(stdout).not.toContain("Showing results for");
  });

  test("says it even when the corrected query found nothing", async () => {
    const { stdout, exitCode } = await runSearch("bilinugual performance study", {
      ...corrected,
      results: [],
      count: 0,
    });
    expect(exitCode).toBe(0);
    expect(stdout).toContain('Showing results for "bilingual performance study"');
    expect(stdout).toContain("No datasets match your search.");
  });

  test("--json carries the field through untouched, for scripts", async () => {
    const { stdout, exitCode } = await runSearch("bilinugual performance study", corrected, [
      "--json",
    ]);
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout).corrected_query).toBe("bilingual performance study");
  });
});
