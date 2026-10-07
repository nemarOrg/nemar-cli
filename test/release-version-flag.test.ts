/**
 * #1493: `nemar dataset release <id> --version X.Y.Z` was swallowed by the
 * root `-v, --version`: the CLI printed its own version and exited 0, so a
 * scripted release (`-y`) silently did nothing.
 *
 * The unit tests run bindShadowedOptionValues over the REAL command tree: the
 * command groups src/index.ts registers, under a root declared the way
 * src/index.ts declares it. A hand-kept copy of the tree would keep passing
 * after a flag was added or renamed in src/commands, which is exactly the
 * drift this guard exists to catch. The entry-point tests drive the real CLI
 * (`bun run src/index.ts`) with no account key configured, so reaching the
 * release handler shows up as its "Not authenticated" refusal, while a
 * swallowed flag prints the version.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "bun";
import { Command, type Option } from "commander";
import { adminCommand } from "../src/commands/admin";
import { authCommand } from "../src/commands/auth";
import { completionCommand } from "../src/commands/completion";
import {
  createDownloadCommand,
  createUploadCommand,
  datasetCommand,
} from "../src/commands/dataset";
import { doctorCommand } from "../src/commands/doctor";
import { sandboxCommand } from "../src/commands/sandbox";
import { MissingShadowedValueError, bindShadowedOptionValues } from "../src/lib/argv-shadowing";
import { version } from "../src/lib/version";

// ---------------------------------------------------------------------------
// The real command tree
// ---------------------------------------------------------------------------

// The module-level command groups src/index.ts passes to addCommand().
// addCommand() sets the child's `.parent`, and these objects are shared with
// every other test file in the same `bun test` process, so each one's parent
// is put back in afterAll.
const SHARED_GROUPS = [
  adminCommand,
  authCommand,
  completionCommand,
  datasetCommand,
  doctorCommand,
  sandboxCommand,
];

// Declared in src/index.ts itself rather than imported, so the tree below
// cannot see them. None takes a flag an ancestor also declares. The drift test
// at the bottom of the unit tests fails when src/index.ts gains or loses a
// top-level command, so this list cannot go stale unnoticed.
const INLINE_ROOT_COMMANDS = ["login", "logout", "register", "signup", "switch", "whoami"];

/** The root exactly as src/index.ts declares it: `-v, --version` plus four booleans. */
function declareRoot(): Command {
  return new Command("nemar")
    .version(version, "-v, --version", "Output the current version")
    .option("--no-color", "Disable colored output")
    .option("--verbose", "Enable verbose output")
    .option("--help-all", "Show detailed help with examples and descriptions")
    .option("--debug", "Write a diagnostic log for this run");
}

class StoppedBeforeAction extends Error {}

/** What Commander had parsed for the command that was about to run. */
interface Reached {
  name: string;
  opts: Record<string, unknown>;
  optsWithGlobals: Record<string, unknown>;
  processedArgs: unknown[];
}

let program: Command;
const reached: Reached[] = [];
const originalParents = SHARED_GROUPS.map((c) => c.parent);

beforeAll(() => {
  program = declareRoot();
  // The root's own --version handler would otherwise process.exit(0) the test
  // runner if the pre-pass ever failed to protect a subcommand's flag.
  program.exitOverride();
  for (const group of SHARED_GROUPS) program.addCommand(group);
  // Fresh instances, as in src/index.ts: Commander gives a Command one parent.
  program.addCommand(createDownloadCommand());
  program.addCommand(createUploadCommand());
  // Stop at the command that would run, before its action touches the network
  // or the account. What Commander parsed for that command is the evidence.
  program.hook("preAction", (_root, actionCommand) => {
    reached.push({
      name: actionCommand.name(),
      opts: { ...actionCommand.opts() },
      optsWithGlobals: { ...actionCommand.optsWithGlobals() },
      processedArgs: [...actionCommand.processedArgs],
    });
    throw new StoppedBeforeAction();
  });
});

afterAll(() => {
  SHARED_GROUPS.forEach((group, i) => {
    group.parent = originalParents[i];
  });
});

/** The parse called process.exit(), which would have ended the whole `bun test` run. */
class ProcessExitCalled extends Error {}

/**
 * Commander 12 never clears the option values a parse stored, and the command
 * groups are shared with every other test file in this process. After a parse
 * (including one that died on a usage error before reaching any command), drop
 * what it set, keeping declared defaults, so no case sees, or leaves behind,
 * another case's flags.
 */
function forgetParsedOptions(command: Command): void {
  const state = command as unknown as {
    _optionValues?: Record<string, unknown>;
    _optionValueSources?: Record<string, unknown>;
  };
  for (const [key, source] of Object.entries(state._optionValueSources ?? {})) {
    if (source === "default") continue;
    delete state._optionValues?.[key];
    delete state._optionValueSources?.[key];
  }
  for (const sub of command.commands) forgetParsedOptions(sub);
}

/**
 * Parse `argv` the way src/index.ts does and return what Commander had parsed
 * for the command it reached. Only the throwaway root has exitOverride(); a usage error raised by
 * a shared command (a missing <dataset-id>, say) calls process.exit(1), which
 * would abort every test file in the run, so process.exit and stderr are
 * trapped for the length of the parse and the exit surfaces as a failure.
 */
async function reach(argv: string[]): Promise<Reached> {
  reached.length = 0;
  const realExit = process.exit;
  const realWrite = process.stderr.write;
  let stderr = "";
  process.exit = ((code?: number) => {
    throw new ProcessExitCalled(`process.exit(${code}) during parse: ${stderr.trim()}`);
  }) as typeof process.exit;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  let outcome: unknown;
  try {
    await program.parseAsync(bindShadowedOptionValues(program, argv), { from: "user" });
  } catch (err) {
    outcome = err;
  } finally {
    process.exit = realExit;
    process.stderr.write = realWrite;
  }
  forgetParsedOptions(program);
  if (!(outcome instanceof StoppedBeforeAction)) {
    throw outcome ?? new Error("the parse finished without reaching a command");
  }
  return reached[0];
}

describe("bindShadowedOptionValues on the real command tree", () => {
  test("joins a shadowed value option of the addressed subcommand", () => {
    expect(
      bindShadowedOptionValues(program, [
        "dataset",
        "release",
        "nm000104",
        "--version",
        "2.0.0",
        "-y",
      ]),
    ).toEqual(["dataset", "release", "nm000104", "--version=2.0.0", "-y"]);
  });

  test("works with global flags before and after the subcommand", () => {
    expect(
      bindShadowedOptionValues(program, [
        "--debug",
        "dataset",
        "release",
        "--version",
        "1.2.3",
        "nm1",
      ]),
    ).toEqual(["--debug", "dataset", "release", "--version=1.2.3", "nm1"]);
    expect(
      bindShadowedOptionValues(program, [
        "dataset",
        "release",
        "nm1",
        "--version",
        "1.2.3",
        "--verbose",
      ]),
    ).toEqual(["dataset", "release", "nm1", "--version=1.2.3", "--verbose"]);
  });

  test("leaves everything else alone", () => {
    const cases = [
      // The root's own flag, with no subcommand to hand it to.
      ["--version"],
      ["-v"],
      ["dataset", "--version"],
      // Already the equals form.
      ["dataset", "release", "nm1", "--version=2.0.0"],
      // After `--` nothing is an option, valueless or not.
      ["dataset", "release", "nm1", "--", "--version", "2.0.0"],
      ["dataset", "release", "nm1", "--", "--version"],
      // Options of the leaf that no ancestor declares.
      ["dataset", "upload", "./x", "--jobs", "4", "--verbose"],
      ["dataset", "validate", "./x", "-v"],
      ["dataset", "validate", "./x", "--version-info"],
      // Not a command of this program.
      ["unknown", "--version", "1"],
    ];
    for (const argv of cases) {
      expect(bindShadowedOptionValues(program, argv)).toEqual(argv);
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
        bindShadowedOptionValues(program, argv);
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

  // A BOOLEAN option that shadows an ancestor's (#1220: `dataset validate`
  // declares `-v, --verbose`, the root declares `--verbose`) takes no value,
  // so the token after it is a positional. Joining them would turn the path
  // into `--verbose=./x` and silently validate the current directory instead.
  test("a boolean collision followed by a positional is untouched", async () => {
    for (const argv of [
      ["dataset", "validate", "--verbose", "./x"],
      ["dataset", "search", "--verbose", "covid"],
      ["--verbose", "dataset", "validate", "./x"],
    ]) {
      expect(bindShadowedOptionValues(program, argv)).toEqual(argv);
    }
    const validate = await reach(["dataset", "validate", "--verbose", "./x"]);
    expect(validate.name).toBe("validate");
    expect(validate.processedArgs).toEqual(["./x"]);
  });

  // Each parse below uses values no other case uses, and reach() clears what a
  // parse stored: Commander 12 never resets option values, and the shared
  // `release` command would otherwise carry them into later cases and files.
  test("Commander then hands the value to the subcommand", async () => {
    const release = await reach(["dataset", "release", "nm1", "--version", "3.1.4", "-y"]);
    expect(release.name).toBe("release");
    expect(release.opts.version).toBe("3.1.4");
    expect(release.processedArgs).toEqual(["nm1"]);
  });

  test("reach() reports a usage error from a shared command instead of exiting", async () => {
    const exitBefore = process.exit;
    const writeBefore = process.stderr.write;
    // <dataset-id> is missing, so Commander calls process.exit(1) on `release`.
    await expect(reach(["dataset", "release", "--version", "4.0.4"])).rejects.toThrow(
      /process\.exit\(1\) during parse: error: missing required argument 'dataset-id'/,
    );
    expect(process.exit).toBe(exitBefore);
    expect(process.stderr.write).toBe(writeBefore);
    // ... and the failed parse left nothing behind on the shared command.
    const release = await reach(["dataset", "release", "nm1", "-y"]);
    expect(release.opts.version).toBeUndefined();
  });

  // `admin recover status` redeclares --recover-file from its parent group
  // `admin recover`, which is also value-taking. The parent's parseOptions
  // consumes the flag AND its value either way and `status` reads it back
  // through optsWithGlobals() (src/commands/admin.ts), so the join must leave
  // that design working.
  test("a value option shared with a value-taking group still resolves", async () => {
    const status = await reach(["admin", "recover", "status", "--recover-file", "recover-1.json"]);
    expect(status.name).toBe("status");
    expect(status.optsWithGlobals.recoverFile).toBe("recover-1.json");
  });
});

// ---------------------------------------------------------------------------
// Invariant over the whole tree
// ---------------------------------------------------------------------------

interface ShadowedPair {
  path: string[];
  option: Option;
}

function flagsOf(option: Option): string[] {
  return [option.long, option.short].filter((f): f is string => typeof f === "string");
}

/**
 * Every command below the root with a value-taking option whose long flag an
 * ancestor also declares. Every command, not only tree leaves: the pre-pass
 * addresses the deepest command NAMED on the line, and `admin recover` is both
 * a group and a command with its own options.
 */
function shadowedValueOptions(root: Command): ShadowedPair[] {
  const found: ShadowedPair[] = [];
  const visit = (cmd: Command, path: string[], ancestors: Command[]) => {
    const ancestorFlags = new Set(ancestors.flatMap((a) => a.options.flatMap(flagsOf)));
    for (const option of cmd.options) {
      if (!(option.required || option.optional)) continue;
      if (option.long && ancestorFlags.has(option.long)) found.push({ path, option });
    }
    for (const sub of cmd.commands) visit(sub, [...path, sub.name()], [...ancestors, cmd]);
  };
  for (const sub of root.commands) visit(sub, [sub.name()], [root]);
  return found;
}

describe("every shadowed value option in the real tree is bound", () => {
  test("the walk finds the known collision, so it cannot pass vacuously", () => {
    const names = shadowedValueOptions(program).map((p) => `${p.path.join(" ")} ${p.option.long}`);
    expect(names).toContain("dataset release --version");
  });

  test("--flag value is joined to --flag=value for each of them", () => {
    for (const { path, option } of shadowedValueOptions(program)) {
      const flag = option.long as string;
      expect(bindShadowedOptionValues(program, [...path, flag, "some-value"])).toEqual([
        ...path,
        `${flag}=some-value`,
      ]);
    }
  });

  test("none takes an OPTIONAL value, which the pre-pass cannot deliver bare", () => {
    // `--flag [value]` with no value has no spelling the shadowing ancestor
    // does not claim, so it would still be swallowed. If this fails, decide
    // how that flag is meant to work before adding it: the pre-pass can only
    // join a value, or fail a required one that is missing.
    const optional = shadowedValueOptions(program)
      .filter((p) => !p.option.required)
      .map((p) => `${p.path.join(" ")} ${p.option.flags}`);
    expect(optional).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The real tree above must be the real program
// ---------------------------------------------------------------------------

// Nothing here may depend on the network. The CLI is pointed at a closed port
// through config.json (the account's apiUrl) rather than an environment
// variable: this file has to stay in the offline `unit-pure` CI tier, and a
// test that names the live-backend variable or helper is routed to the soft
// `integration-dev` tier instead (see the file-sorting grep in test.yml).
const CLI_ENTRY = join(import.meta.dir, "..", "src", "index.ts");
const REPO_ROOT = join(import.meta.dir, "..");
const UNREACHABLE_API = "http://127.0.0.1:9";
let configDir: string;

async function spawnCli(args: string[]) {
  // Drop every TEST_* variable so an ambient live-backend setting cannot
  // override the config.json URL above.
  const env: Record<string, string | undefined> = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("TEST_")),
  );
  env.NEMAR_CONFIG_DIR = configDir;
  env.NEMAR_NO_UPDATE_CHECK = "1";
  env.NO_COLOR = "1";
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

describe("spawned CLI", () => {
  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "nemar-release-version-"));
    // An account with an apiUrl and no key: the notices call fails fast
    // against the closed port, and the release handler refuses with "Not
    // authenticated".
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({
        activeAccount: "argv-shadow",
        accounts: { "argv-shadow": { apiUrl: UNREACHABLE_API } },
      }),
    );
  });

  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true });
  });

  describe("the tree under test matches src/index.ts", () => {
    test("same global options and same top-level commands as `nemar --help`", async () => {
      const help = (await spawnCli(["--help"])).stdout.split("\n");
      const section = (title: string) =>
        help
          .slice(help.indexOf(`${title}:`) + 1)
          .join("\n")
          .split("\n\n")[0]
          .split("\n")
          // Wrapped descriptions are indented further than the entries.
          .filter((line) => /^ {2}\S/.test(line));

      // `-h, --help` is Commander's own and not part of options[].
      const optionFlags = section("Options").map((line) => line.trim().split(/ {2,}/)[0]);
      expect(optionFlags).toEqual([...program.options.map((o) => o.flags), "-h, --help"]);

      const commandNames = section("Commands").map((line) => line.trim().split(/\s/)[0]);
      expect([...commandNames].sort()).toEqual(
        [...program.commands.map((c) => c.name()), ...INLINE_ROOT_COMMANDS, "help"].sort(),
      );
    });
  });

  describe("nemar entry point", () => {
    test("dataset release --version X.Y.Z reaches the release handler", async () => {
      const r = await spawnCli(["dataset", "release", "nm000104", "--version", "2.0.0", "-y"]);
      expect(r.stdout.trim()).not.toBe(version);
      expect(r.stdout).toContain("Not authenticated");
      expect(r.exitCode).toBe(1);
    });

    test("dataset release --version with no value fails like Commander", async () => {
      for (const args of [
        ["dataset", "release", "nm000104", "--version"],
        ["dataset", "release", "nm000104", "--version", "-y"],
      ]) {
        const r = await spawnCli(args);
        expect(r.stdout.trim()).not.toBe(version);
        expect(r.stderr).toContain("error: option '--version <version>' argument missing");
        // Reported by Commander as a usage error, so the exit handler does not
        // add its "attach a debug log to a bug report" nudge, which an error
        // thrown out of main() would get.
        expect(r.stderr).not.toContain("Run again with --debug");
        expect(r.exitCode).toBe(1);
      }
    });

    test("the root --version still prints the CLI version", async () => {
      const r = await spawnCli(["--version"]);
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe(version);
    });
  });
});
