/**
 * D1 (epic #1144 phase 6, issue #1150): the `Score` column is dropped from
 * the human-readable `nemar dataset search` table, not merely recalibrated.
 * `rrfFuse`'s RRF score (k=60, ceiling 1/61+1/61 ~= 0.0328) is a fused
 * ranking artefact; the CLI's old 0.8/0.5 thresholds were COSINE values,
 * applied to that RRF scale, so real semantic hits rendered dim while a
 * degraded lexical fallback (score 1 for every row) rendered a confident
 * wall of green -- the column was actively inverted, not just uninformative.
 * `score` stays in `--json`: it is real data scripts may use, only the
 * human table is misleading.
 *
 * Driven through the real subprocess against the live, public, read-only
 * search endpoint -- the actual rendering entry point, not a
 * re-implementation of the table-building logic.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "bun";
import { startSearchStub } from "./helpers/search-stub";

const CLI_ENTRY = join(import.meta.dir, "..", "src", "index.ts");
const REPO_ROOT = join(import.meta.dir, "..");
// Was a live query against api.nemar.org. Now a local stub: see
// helpers/search-stub.ts for why (rate limiting under a full suite run,
// plus non-deterministic fixtures for a renderer assertion).
const QUERY = "P300";

async function runSearch(args: string[]): Promise<{ stdout: string; exitCode: number }> {
  const configDir = mkdtempSync(join(tmpdir(), "nemar-search-score-"));
  const stub = startSearchStub();
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
      cmd: ["bun", "run", CLI_ENTRY, "dataset", "search", QUERY, ...args],
      cwd: REPO_ROOT,
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    return { stdout, exitCode };
  } finally {
    stub.stop();
    rmSync(configDir, { recursive: true, force: true });
  }
}

describe("search result table: Score column (#1150 D1)", () => {
  test("the human table has no Score column header", async () => {
    const { stdout, exitCode } = await runSearch(["--limit", "5"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Search results for");
    // The header row itself: ID/Name/Modality/Subj/HED, no Score.
    const headerLine = stdout.split("\n").find((line) => line.startsWith("ID"));
    expect(headerLine).toBeDefined();
    expect(headerLine).not.toContain("Score");
  });

  test("no row renders a bare numeric RRF score", async () => {
    const { stdout, exitCode } = await runSearch(["--limit", "5"]);
    expect(exitCode).toBe(0);
    // The old renderer's score column always started a row with something
    // shaped like "0.03" or "1" padded to 5 chars, immediately followed by
    // the id (a two-letter prefix + six digits). Assert that shape is gone:
    // every row now starts directly with the id.
    const lines = stdout.split("\n");
    const idLines = lines.filter((line) => /^(nm|on|ds|xx)\d{6}/.test(line));
    expect(idLines.length).toBeGreaterThan(0);
    for (const line of idLines) {
      // The id must be the very first thing on the line -- no leading score
      // column and padding before it.
      expect(
        line.startsWith("nm") ||
          line.startsWith("on") ||
          line.startsWith("ds") ||
          line.startsWith("xx"),
      ).toBe(true);
    }
  });

  test("--json still carries the real score field", async () => {
    const { stdout, exitCode } = await runSearch(["--limit", "3", "--json"]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(Array.isArray(parsed.results)).toBe(true);
    expect(parsed.results.length).toBeGreaterThan(0);
    for (const result of parsed.results) {
      expect(typeof result.score).toBe("number");
    }
  });
});
