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
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  // Without this, a CLI that threw at import returns "" and every assertion
  // that compares two help outputs compares empty to empty and passes -- which
  // is exactly the shape `.rules/testing.md` calls a test that cannot fail.
  if (exitCode !== 0) {
    throw new Error(
      `nemar ${args.join(" ")} exited ${exitCode}\n--- stderr ---\n${stderr}\n--- stdout ---\n${stdout}`,
    );
  }
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

/**
 * Names of the subcommands rendered WITH a description.
 *
 * Two layouts, because the formatter uses both: `  <term>  <description>` when
 * the term fits the section's column, and the term alone on its line with the
 * description indented underneath when it does not (see formatItem). A parser
 * that knew only the first would silently count zero for a section full of
 * long terms, which is a test that cannot fail rather than one that passes.
 */
export function describedCommands(output: string): string[] {
  const lines = commandsBlock(output).split("\n").slice(1);
  const names: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const inline = /^ {2}(\S.*?) {2,}\S/.exec(line);
    if (inline) {
      names.push(inline[1].split(/[\s|]/)[0]);
      continue;
    }
    // Term alone: two-space indent, no trailing description, and the next line
    // is the description indented further.
    const alone = /^ {2}(\S[^ ].*)$/.exec(line);
    if (alone && /^ {4,}\S/.test(lines[i + 1] ?? "")) {
      names.push(alone[1].split(/[\s|]/)[0]);
    }
  }
  return names;
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
