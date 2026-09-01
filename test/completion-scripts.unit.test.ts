/**
 * `nemar completion bash|zsh|fish` (epic #1144 phase 5b, issue #1149 -- plan
 * verification case 6).
 *
 * Driven through the real CLI subprocess (`bun run src/index.ts completion
 * <shell>`), not by importing the script generators directly, so this pins
 * the actual command's output rather than the generator functions in
 * isolation.
 *
 * Each script is checked for: non-empty, references `__complete` (the only
 * way it can possibly work), and is syntactically valid to its own shell
 * (`bash -n`, `zsh -n`, `fish --no-execute`). A shell not installed on the
 * machine running this suite is skipped, not failed -- reported separately
 * rather than asserted on, since which shells exist here says nothing about
 * whether the generated script is correct.
 *
 * These checks are purely syntactic and cannot catch a script that parses
 * fine but behaves wrongly at runtime (a call wrapped in dead code, or --
 * #1173 -- an array slice quoted without zsh's `(@)` flag, which glues
 * multiple words/candidates into one string). See
 * test/completion-shell-functional.unit.test.ts for the runtime coverage:
 * each emitted script sourced into a real shell with a stub `nemar`,
 * driving actual candidate resolution end to end.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync, which } from "bun";

const CLI_ENTRY = join(import.meta.dir, "..", "src", "index.ts");
const REPO_ROOT = join(import.meta.dir, "..");

async function runCompletionScript(shell: string): Promise<{ stdout: string; exitCode: number }> {
  const proc = spawn({
    cmd: ["bun", "run", CLI_ENTRY, "completion", shell],
    cwd: REPO_ROOT,
    env: { ...process.env, NO_COLOR: "1" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  return { stdout, exitCode };
}

function writeToTempFile(prefix: string, content: string): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const path = join(dir, "script");
  writeFileSync(path, content);
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const SHELLS: Array<{ name: string; binary: string; syntaxCheckArgs: (path: string) => string[] }> =
  [
    { name: "bash", binary: "bash", syntaxCheckArgs: (path) => ["-n", path] },
    { name: "zsh", binary: "zsh", syntaxCheckArgs: (path) => ["-n", path] },
    { name: "fish", binary: "fish", syntaxCheckArgs: (path) => ["--no-execute", path] },
  ];

describe("verification case 6: shell completion scripts", () => {
  for (const shell of SHELLS) {
    const installed = which(shell.binary) !== null;

    test(`${shell.name}: non-empty and references __complete`, async () => {
      const result = await runCompletionScript(shell.name);
      expect(result.exitCode).toBe(0);
      expect(result.stdout.length).toBeGreaterThan(0);
      expect(result.stdout).toContain("__complete");
      expect(result.stdout).toContain("nemar");
    });

    test.skipIf(!installed)(
      `${shell.name}: syntactically valid (${shell.binary} available)`,
      async () => {
        const result = await runCompletionScript(shell.name);
        const { path, cleanup } = writeToTempFile(`nemar-completion-${shell.name}-`, result.stdout);
        try {
          const check = spawnSync({
            cmd: [shell.binary, ...shell.syntaxCheckArgs(path)],
            stdout: "pipe",
            stderr: "pipe",
          });
          expect(check.exitCode).toBe(0);
        } finally {
          cleanup();
        }
      },
    );
  }
});
