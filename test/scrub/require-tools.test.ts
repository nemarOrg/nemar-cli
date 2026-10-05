/**
 * The CI rule for the scrub suites: a missing tool is a failure when NEMAR_REQUIRE_SCRUB_TOOLS=1
 * and a clean skip otherwise. Run in a real subprocess with an empty PATH, so no tool resolves.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FIXTURE = join(import.meta.dir, "git/fixture.ts");

async function importFixture(env: Record<string, string>) {
  const empty = mkdtempSync(join(tmpdir(), "no-tools-"));
  try {
    const proc = Bun.spawn(
      [
        process.execPath,
        "-e",
        `import(${JSON.stringify(FIXTURE)}).then((m) => console.log(JSON.stringify({ tools: m.HAVE_REWRITE_TOOLS, annex: m.HAVE_ANNEX })))`,
      ],
      { env: { PATH: empty, HOME: empty, ...env }, stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, exitCode };
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
}

describe("NEMAR_REQUIRE_SCRUB_TOOLS", () => {
  test("a missing tool is an error that names it", async () => {
    const r = await importFixture({ NEMAR_REQUIRE_SCRUB_TOOLS: "1" });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("NEMAR_REQUIRE_SCRUB_TOOLS=1 and a required tool is missing: git");
  });

  test("without it the same missing tools are a clean skip", async () => {
    const r = await importFixture({});
    expect(r.exitCode, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ tools: false, annex: false });
  });
});
