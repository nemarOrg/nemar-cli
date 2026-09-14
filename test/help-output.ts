/**
 * Spawning the CLI for its `--help` output, and reading the rendered blocks
 * back out.
 *
 * Offline by construction: `--help` exits inside Commander before the
 * `preAction` hook that fetches notices ever runs, and `NEMAR_NO_UPDATE_CHECK=1`
 * suppresses the one other outbound call the entry point makes, so a help test
 * spawns a real CLI process without touching the network.
 */

import { join } from "node:path";
import { spawn } from "bun";

const ENTRY = join(import.meta.dir, "..", "src", "index.ts");

export async function help(args: string[], env: Record<string, string> = {}): Promise<string> {
  const proc = spawn(["bun", "run", ENTRY, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, NEMAR_NO_UPDATE_CHECK: "1", FORCE_COLOR: "0", ...env },
  });
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;
  return stdout;
}

/** The `Commands:` block, up to the blank line that closes it. */
function commandsBlock(output: string): string {
  const start = output.indexOf("Commands:");
  if (start === -1) return "";
  const rest = output.slice(start);
  const end = rest.indexOf("\n\n");
  return end === -1 ? rest : rest.slice(0, end);
}

/** Names of the subcommands rendered WITH a description (the lead block). */
export function describedCommands(output: string): string[] {
  return (
    commandsBlock(output)
      .split("\n")
      .slice(1)
      // `  <term>  <description>`, where the term may itself carry spaces
      // (`download [options] <dataset-id>`) and a wrapped description
      // continuation line starts with far more than two spaces.
      .map((line) => /^ {2}(\S.*?) {2,}\S/.exec(line)?.[1])
      .filter((term): term is string => term !== undefined)
      .map((term) => term.split(/[\s|]/)[0])
  );
}

/** Names on the comma-separated overflow line, if the group has one. */
export function foldedCommands(output: string): string[] {
  const start = output.indexOf("More commands");
  if (start === -1) return [];
  const rest = output.slice(output.indexOf("\n", start) + 1);
  const end = rest.indexOf("\n\n");
  return (end === -1 ? rest : rest.slice(0, end))
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
}

/** Long-option flags a command's own `--help` advertises. */
export function optionFlags(output: string): string[] {
  return [...output.matchAll(/(--[a-z0-9][a-z0-9-]*)/g)].map((m) => m[1]).sort();
}
