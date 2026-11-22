/**
 * Runs the real CLI entry point against a local Bun.serve stand-in, with an environment built
 * from nothing.
 *
 * The stand-in is the stored apiUrl of an admin account in a fresh NEMAR_CONFIG_DIR, and it
 * records every request except `/notices` (which every command asks for first). The child gets
 * only PATH, HOME, TMPDIR and the NEMAR_* switches below: in a shared `bun test` process another
 * file's setup exports an API override the CLI prefers over the stored apiUrl, which would send a
 * request past the stand-in. With only these variables, the stand-in is the one backend a child
 * can reach.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "bun";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const CLI_ENTRY = join(REPO_ROOT, "src", "index.ts");

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching the escape byte is the point
export const stripAnsi = (text: string): string => text.replace(/\u001B\[[0-9;]*m/g, "");

export interface RecordedRequest {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
}

export interface CliRun {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface IsolatedCli {
  /** Every request the stand-in received since the last {@link IsolatedCli.reset}. */
  readonly requests: RecordedRequest[];
  reset(): void;
  run(args: string[]): Promise<CliRun>;
  /** Like {@link IsolatedCli.run}, but stdout and stderr keep their escape codes. */
  runRaw(args: string[], extraEnv?: Record<string, string>): Promise<CliRun>;
  /** The environment a child gets, for a test that spawns something other than the CLI itself. */
  env(extraEnv?: Record<string, string>): Record<string, string | undefined>;
  /** The CLI entry point, `src/index.ts`. */
  readonly entry: string;
  stop(): void;
}

/**
 * Starts the stand-in and writes the account. `answer` decides each recorded request's response;
 * the default is a 500, so a command that was not meant to reach the backend shows it.
 */
export function startIsolatedCli(
  answer: (req: RecordedRequest) => Response = () =>
    Response.json({ error: "not stood in" }, { status: 500 }),
): IsolatedCli {
  const requests: RecordedRequest[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/notices") return Response.json({ notices: [] });
      const body =
        req.method === "GET"
          ? null
          : ((await req.json().catch(() => null)) as Record<string, unknown> | null);
      const recorded = { method: req.method, path, body };
      requests.push(recorded);
      return answer(recorded);
    },
  });
  const configDir = mkdtempSync(join(tmpdir(), "nemar-isolated-cli-"));
  writeFileSync(
    join(configDir, "config.json"),
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

  const env = (extraEnv: Record<string, string> = {}): Record<string, string | undefined> => ({
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    NEMAR_CONFIG_DIR: configDir,
    NEMAR_NO_UPDATE_CHECK: "1",
    NEMAR_NO_BROWSER: "1",
    NO_COLOR: "1",
    ...extraEnv,
  });

  async function runRaw(args: string[], extraEnv: Record<string, string> = {}): Promise<CliRun> {
    const proc = spawn({
      cmd: ["bun", "run", CLI_ENTRY, ...args],
      cwd: REPO_ROOT,
      env: env(extraEnv),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, exitCode };
  }

  return {
    entry: CLI_ENTRY,
    env,
    requests,
    reset: () => {
      requests.length = 0;
    },
    runRaw,
    run: async (args) => {
      const r = await runRaw(args);
      return { ...r, stdout: stripAnsi(r.stdout), stderr: stripAnsi(r.stderr) };
    },
    stop: () => {
      server.stop(true);
      rmSync(configDir, { recursive: true, force: true });
    },
  };
}
