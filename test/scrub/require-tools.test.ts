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

describe("the scanner suites outside test/scrub obey the same rule (T12)", () => {
  /** Run one test file with no tool on PATH, as `bun test ./file` would. */
  async function runWithoutTools(file: string, require: boolean) {
    const empty = mkdtempSync(join(tmpdir(), "no-tools-"));
    try {
      const proc = Bun.spawn([process.execPath, "test", `./${file}`], {
        cwd: join(import.meta.dir, "../.."),
        env: {
          PATH: empty,
          HOME: empty,
          NO_COLOR: "1",
          ...(require ? { NEMAR_REQUIRE_SCRUB_TOOLS: "1" } : {}),
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      return { exitCode, all: `${stdout}\n${stderr}` };
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  }

  for (const [file, tool] of [
    ["test/identifier-scrub.test.ts", "uv"],
    ["test/identifier-fleet.test.ts", "aws"],
  ] as const) {
    test(`${file}: a missing ${tool} skips on a laptop and FAILS under NEMAR_REQUIRE_SCRUB_TOOLS=1`, async () => {
      const required = await runWithoutTools(file, true);
      expect(required.exitCode, required.all).not.toBe(0);
      expect(required.all).toContain(`a required tool is missing: ${tool}`);
      const relaxed = await runWithoutTools(file, false);
      expect(relaxed.exitCode, relaxed.all).toBe(0);
      expect(relaxed.all).toMatch(/\d+ skip/);
    }, 120_000);
  }
});

describe("a bare `bun test` leaves test/scrub out; `bun run test:scrub` puts it back (T12)", () => {
  async function bunTest(args: string[]) {
    const proc = Bun.spawn([process.execPath, "test", ...args], {
      cwd: join(import.meta.dir, "../.."),
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { exitCode, all: `${stdout}\n${stderr}` };
  }

  test("bunfig.toml hides the suite from a bare run; the script's flag runs it", async () => {
    const bare = await bunTest(["test/scrub/ledger.test.ts"]);
    expect(bare.exitCode, bare.all).not.toBe(0);
    expect(bare.all).not.toMatch(/Ran \d+ tests? across/);
    // The override the package.json script and the CI job use.
    const script = JSON.parse(await Bun.file(join(import.meta.dir, "../../package.json")).text())
      .scripts["test:scrub"] as string;
    const flag = /--path-ignore-patterns='[^']+'/.exec(script)?.[0]?.replace(/'/g, "");
    expect(flag).toBeDefined();
    const run = await bunTest([flag as string, "test/scrub/ledger.test.ts"]);
    expect(run.exitCode, run.all).toBe(0);
    expect(run.all).toMatch(/Ran \d+ tests across 1 file/);
  }, 120_000);
});
