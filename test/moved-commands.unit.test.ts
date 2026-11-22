/**
 * Moved-command stubs (ADR 0135 decision 5), driven through the real entry point
 * (`bun run src/index.ts admin <old path> ...`) for every row of MOVED_COMMANDS.
 *
 * Each run gets an isolated NEMAR_CONFIG_DIR holding an admin account whose
 * stored apiUrl is a local Bun.serve stand-in that records every request: a stub
 * that ran anything, or even fetched /notices, shows up as a request. The update
 * check is off, since it goes to the npm registry and not to the stand-in, except
 * in the one test that seeds its cache with a newer version.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "bun";
import { Command } from "commander";
import {
  MOVED_COMMANDS,
  isMovedCommandStub,
  movedCommandMessage,
  registerMovedCommands,
} from "../src/lib/moved-commands";
import { FIXTURE_STUB_PATHS, buildFixtureProgram } from "./fixtures/moved-commands/tree-def";

const REPO_ROOT = join(import.meta.dir, "..");
const CLI_ENTRY = join(REPO_ROOT, "src", "index.ts");
const TREE_FIXTURE = join(import.meta.dir, "fixtures", "moved-commands", "tree.ts");

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching the escape byte is the point
const stripAnsi = (text: string): string => text.replace(/\u001B\[[0-9;]*m/g, "");

let configDir: string;
let server: ReturnType<typeof Bun.serve>;
let requests: string[] = [];

function writeAdminConfig(dir: string): void {
  writeFileSync(
    join(dir, "config.json"),
    JSON.stringify({
      activeAccount: "root",
      accounts: {
        root: {
          apiKey: "test-admin-key",
          username: "root",
          role: "admin",
          apiUrl: `http://localhost:${server.port}`,
        },
      },
    }),
  );
}

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      requests.push(`${req.method} ${new URL(req.url).pathname}`);
      return Response.json({ error: "a moved-command stub must make no request" }, { status: 500 });
    },
  });
  configDir = mkdtempSync(join(tmpdir(), "nemar-moved-commands-"));
  writeAdminConfig(configDir);
});

afterAll(() => {
  server.stop(true);
  rmSync(configDir, { recursive: true, force: true });
});

beforeEach(() => {
  requests = [];
});

async function run(
  entry: string,
  args: string[],
  { dir = configDir, updateCheck = false }: { dir?: string; updateCheck?: boolean } = {},
) {
  const env: Record<string, string | undefined> = {
    ...process.env,
    NEMAR_CONFIG_DIR: dir,
    NEMAR_NO_UPDATE_CHECK: updateCheck ? undefined : "1",
    NO_COLOR: "1",
  };
  env.FORCE_COLOR = undefined;
  env.CLICOLOR_FORCE = undefined;
  env.NEMAR_DEBUG = undefined;
  const proc = spawn({
    cmd: ["bun", "run", entry, ...args],
    cwd: REPO_ROOT,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout: stripAnsi(stdout), stderr: stripAnsi(stderr), exitCode };
}

const stderrLines = (stderr: string): string[] => stderr.split("\n").filter((l) => l.trim() !== "");

/**
 * Argument shapes a caller might still send: bare, a real call, help, junk options, and
 * the root's own options, which Commander would otherwise act on before the stub.
 */
const ARGUMENT_SHAPES: readonly string[][] = [
  [],
  ["nm000104", "--execute", "--yes"],
  ["--help"],
  ["approve", "nm000104", "--json", "--no-such-option", "value"],
  ["nm000104", "--version", "2.0.0"],
  ["-v"],
  ["--debug"],
];

describe("every moved admin command fails at once, without a request", () => {
  for (const row of MOVED_COMMANDS) {
    const expected = movedCommandMessage(
      `nemar admin ${row.oldPath}`,
      `nemar admin ${row.newPath}`,
    );

    test.each(ARGUMENT_SHAPES.map((shape) => [shape.join(" ") || "(no arguments)", shape]))(
      `admin ${row.oldPath} %s`,
      async (_label, shape) => {
        const result = await run(CLI_ENTRY, ["admin", ...row.oldPath.split(" "), ...shape]);
        expect(result.exitCode).toBe(1);
        expect(stderrLines(result.stderr)).toEqual([expected]);
        expect(result.stdout).toBe("");
        expect(requests).toEqual([]);
      },
    );

    test(`the pointer for admin ${row.oldPath} names a live command`, async () => {
      const result = await run(CLI_ENTRY, ["admin", ...row.newPath.split(" "), "--help"]);
      expect(result.exitCode).toBe(0);
      expect(requests).toEqual([]);
    });
  }

  test("the existing ADR 0125 stubs keep their wording", () => {
    expect(
      MOVED_COMMANDS.map((r) =>
        movedCommandMessage(`nemar admin ${r.oldPath}`, `nemar admin ${r.newPath}`),
      ),
    ).toEqual([
      "'nemar admin publish' moved to 'nemar admin repo publish'. Nothing was run.",
      "'nemar admin withdraw' moved to 'nemar admin repo withdraw'. Nothing was run.",
      "'nemar admin restore' moved to 'nemar admin repo restore'. Nothing was run.",
    ]);
  });

  test("no stub is listed in admin --help", async () => {
    const { stdout } = await run(CLI_ENTRY, ["admin", "--help-all"]);
    const listed = stdout.split("\n").map((l) => /^ {2}(\S+)/.exec(l)?.[1]);
    for (const row of MOVED_COMMANDS) {
      if (!row.oldPath.includes(" ")) expect(listed).not.toContain(row.oldPath);
    }
  });
});

describe("stubs under a live group and under a gone group", () => {
  const cases: [string[], string, string][] = [
    [["fleet", "annex-policy", "--apply"], "fleet annex-policy", "rework annex policy"],
    [["s3"], "s3", "dataset s3"],
    [["s3", "lock", "nm000104", "--yes"], "s3 lock", "dataset s3 lock"],
    [["s3", "credential-check"], "s3", "dataset s3"],
  ];
  const rootOptions: string[][] = [[], ["--version", "2.0.0"], ["-v"], ["--debug"]];

  test.each(
    cases.flatMap(([args, oldPath, newPath]) =>
      rootOptions.map((extra) => [
        [...args, ...extra].join(" "),
        [...args, ...extra],
        oldPath,
        newPath,
      ]),
    ),
  )("admin %s points at the row it matches", async (_label, args, oldPath, newPath) => {
    const result = await run(TREE_FIXTURE, ["admin", ...(args as string[])]);
    expect(result.exitCode).toBe(1);
    expect(stderrLines(result.stderr)).toEqual([
      movedCommandMessage(`nemar admin ${oldPath}`, `nemar admin ${newPath}`),
    ]);
    expect(result.stdout).toBe("");
  });

  test("the live sibling of a stub still runs", async () => {
    const result = await run(TREE_FIXTURE, ["admin", "fleet", "drift"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("LIVE fleet drift ran");
  });

  test("every stub registration creates, nested or not, is recognized as a stub", () => {
    const { admin } = buildFixtureProgram();
    const found = new Map<string, boolean>();
    const walk = (cmd: Command, path: string[]): void => {
      for (const sub of cmd.commands) {
        const subPath = [...path, sub.name()];
        found.set(subPath.join(" "), isMovedCommandStub(sub));
        walk(sub, subPath);
      }
    };
    walk(admin, []);
    const stubPaths = [...found].filter(([, isStub]) => isStub).map(([p]) => p);
    expect(stubPaths.sort()).toEqual([...FIXTURE_STUB_PATHS].sort());
    // Every hidden command in the fixture is one of those stubs, so none escaped the registry.
    const hidden: string[] = [];
    const walkHidden = (cmd: Command, path: string[]): void => {
      for (const sub of cmd.commands) {
        const subPath = [...path, sub.name()];
        if ((sub as unknown as { _hidden: boolean })._hidden) hidden.push(subPath.join(" "));
        walkHidden(sub, subPath);
      }
    };
    walkHidden(admin, []);
    expect(hidden.sort()).toEqual([...FIXTURE_STUB_PATHS].sort());
  });
});

describe("an outdated CLI prints no update banner after a stub", () => {
  test("the pointer is still the only stderr line", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nemar-moved-commands-update-"));
    try {
      writeAdminConfig(dir);
      writeFileSync(
        join(dir, "update-check.json"),
        JSON.stringify({ checkedAt: Date.now(), latestVersion: "999.0.0" }),
      );
      // Control: the seeded cache does print the banner on a live command.
      const control = await run(CLI_ENTRY, ["admin", "repo", "--help"], {
        dir,
        updateCheck: true,
      });
      expect(control.stderr).toContain("Update available");
      const row = MOVED_COMMANDS[0];
      const result = await run(CLI_ENTRY, ["admin", ...row.oldPath.split(" "), "nm000104"], {
        dir,
        updateCheck: true,
      });
      expect(result.exitCode).toBe(1);
      expect(stderrLines(result.stderr)).toEqual([
        movedCommandMessage(`nemar admin ${row.oldPath}`, `nemar admin ${row.newPath}`),
      ]);
      expect(requests).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("registerMovedCommands refuses a table that cannot be right", () => {
  function tree(): Command {
    const root = new Command("admin");
    root.command("fleet").command("drift");
    root.command("repo").command("publish");
    return root;
  }

  test("an old path that is still a live command", () => {
    expect(() =>
      registerMovedCommands(tree(), [{ oldPath: "fleet drift", newPath: "repo publish" }]),
    ).toThrow("still a live command");
  });

  test("an old path listed twice", () => {
    expect(() =>
      registerMovedCommands(tree(), [
        { oldPath: "publish", newPath: "repo publish" },
        { oldPath: "publish", newPath: "repo publish" },
      ]),
    ).toThrow("duplicate old path");
  });

  test("an old path under a gone group with no row of its own", () => {
    expect(() =>
      registerMovedCommands(tree(), [{ oldPath: "s3 lock", newPath: "repo publish" }]),
    ).toThrow("add a row for 's3'");
  });
});
