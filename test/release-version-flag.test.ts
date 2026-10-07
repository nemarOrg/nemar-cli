/**
 * #1493: `nemar dataset release <id> --version X.Y.Z` was swallowed by the
 * root `-v, --version`: the CLI printed its own version and exited 0, so a
 * scripted release (`-y`) silently did nothing.
 *
 * Unit tests pin bindShadowedOptionValues on a small program with the same
 * shape; the entry-point tests drive the real CLI (`bun run src/index.ts`)
 * with no account configured, so reaching the release handler shows up as its
 * "Not authenticated" refusal, while a swallowed flag prints the version.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "bun";
import { Command } from "commander";
import { MissingShadowedValueError, bindShadowedOptionValues } from "../src/lib/argv-shadowing";
import { version } from "../src/lib/version";

function miniProgram(): Command {
  const program = new Command("nemar")
    .version("9.9.9", "-v, --version")
    .option("--verbose")
    .option("--debug");
  const dataset = new Command("dataset");
  dataset
    .command("release")
    .argument("<id>")
    .option("--type <type>")
    .option("--version <version>")
    .option("-y, --yes");
  dataset.command("validate").argument("<path>").option("-v, --verbose");
  dataset.command("upload").argument("<path>").option("-j, --jobs <n>");
  program.addCommand(dataset);
  return program;
}

describe("bindShadowedOptionValues", () => {
  const p = miniProgram();

  test("joins a shadowed value option of the addressed subcommand", () => {
    expect(
      bindShadowedOptionValues(p, ["dataset", "release", "nm000104", "--version", "2.0.0", "-y"]),
    ).toEqual(["dataset", "release", "nm000104", "--version=2.0.0", "-y"]);
  });

  test("works with global flags before and after the subcommand", () => {
    expect(
      bindShadowedOptionValues(p, ["--debug", "dataset", "release", "--version", "1.2.3", "nm1"]),
    ).toEqual(["--debug", "dataset", "release", "--version=1.2.3", "nm1"]);
  });

  test("leaves everything else alone", () => {
    const cases = [
      ["--version"],
      ["-v"],
      ["dataset", "--version"],
      ["dataset", "release", "nm1", "--version=2.0.0"],
      ["dataset", "release", "nm1", "--", "--version", "2.0.0"],
      ["dataset", "upload", "./x", "--jobs", "4", "--verbose"],
      ["dataset", "validate", "./x", "-v"],
      ["unknown", "--version", "1"],
    ];
    for (const argv of cases) {
      expect(bindShadowedOptionValues(p, argv)).toEqual(argv);
    }
  });

  // Changed deliberately from "left alone" (#1493 review): a bare shadowed
  // --version used to fall through to the root, which printed the CLI version
  // and exited 0, the same silent no-op as the spaced form for a scripted -y
  // release. It is now Commander's own "argument missing" error.
  test("a shadowed value option with no value is an error", () => {
    const cases = [
      ["dataset", "release", "nm1", "--version"],
      ["dataset", "release", "nm1", "--version", "-y"],
      ["dataset", "release", "nm1", "--version", "--yes"],
      ["dataset", "release", "--version", "-y", "nm1"],
      ["--debug", "dataset", "release", "nm1", "--version"],
    ];
    for (const argv of cases) {
      let caught: unknown;
      try {
        bindShadowedOptionValues(p, argv);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(MissingShadowedValueError);
      expect((caught as MissingShadowedValueError).message).toBe(
        "error: option '--version <version>' argument missing",
      );
      expect((caught as MissingShadowedValueError).command.name()).toBe("release");
    }
  });

  test("Commander then hands the value to the subcommand", async () => {
    let seen: string | undefined;
    const prog = miniProgram().exitOverride();
    const release = prog.commands[0].commands.find((c) => c.name() === "release");
    release?.action((_id: string, opts: { version?: string }) => {
      seen = opts.version;
    });
    await prog.parseAsync(
      bindShadowedOptionValues(prog, ["dataset", "release", "nm1", "--version", "2.0.0"]),
      { from: "user" },
    );
    expect(seen).toBe("2.0.0");
  });
});

// ---------------------------------------------------------------------------
// Real entry point
// ---------------------------------------------------------------------------

const CLI_ENTRY = join(import.meta.dir, "..", "src", "index.ts");
const REPO_ROOT = join(import.meta.dir, "..");
let configDir: string;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "nemar-release-version-"));
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

async function runCli(args: string[]) {
  const env: Record<string, string | undefined> = {
    ...process.env,
    NEMAR_CONFIG_DIR: configDir,
    // Unreachable on purpose: nothing here may depend on the network.
    TEST_API_URL: "http://127.0.0.1:9",
    NEMAR_NO_UPDATE_CHECK: "1",
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
  return { stdout, stderr, exitCode: await proc.exited };
}

describe("nemar entry point", () => {
  test("dataset release --version X.Y.Z reaches the release handler", async () => {
    const r = await runCli(["dataset", "release", "nm000104", "--version", "2.0.0", "-y"]);
    expect(r.stdout.trim()).not.toBe(version);
    expect(r.stdout).toContain("Not authenticated");
    expect(r.exitCode).toBe(1);
  });

  test("dataset release --version with no value fails like Commander", async () => {
    for (const args of [
      ["dataset", "release", "nm000104", "--version"],
      ["dataset", "release", "nm000104", "--version", "-y"],
    ]) {
      const r = await runCli(args);
      expect(r.stdout.trim()).not.toBe(version);
      expect(r.stderr).toContain("error: option '--version <version>' argument missing");
      expect(r.exitCode).toBe(1);
    }
  });

  test("the root --version still prints the CLI version", async () => {
    const r = await runCli(["--version"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe(version);
  });
});
