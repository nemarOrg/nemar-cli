/**
 * requireAuth guard behavior (#907). Real subprocesses, real config store —
 * no mocks. Each case runs a tiny harness under `bun` with NEMAR_CONFIG_DIR
 * pointed at an isolated temp dir (the config module resolves the dir lazily
 * per call, issue #489), and NO_COLOR=1 so chalk output is plain text.
 *
 * requireAuth must stay byte-compatible with the 14 inline guards it
 * replaced in commands/dataset.ts: two exact lines, exit code 1.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LIB_DIR = join(import.meta.dir, "..", "src", "lib");
const scratch = mkdtempSync(join(tmpdir(), "nemar-cli-output-"));

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function runHarness(harnessSource: string, configDir: string) {
  const harnessPath = join(scratch, `harness-${Math.random().toString(36).slice(2)}.ts`);
  writeFileSync(harnessPath, harnessSource);
  const env = { ...process.env, NEMAR_CONFIG_DIR: configDir, NO_COLOR: "1" };
  // FORCE_COLOR (inherited from some terminals/CI) overrides NO_COLOR in
  // chalk; drop it so the harness output is deterministic plain text.
  delete env.FORCE_COLOR;
  delete env.CLICOLOR_FORCE;
  const proc = Bun.spawnSync(["bun", harnessPath], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

describe("requireAuth", () => {
  test("unauthenticated: prints the exact two-line error and exits 1", () => {
    const configDir = mkdtempSync(join(tmpdir(), "nemar-cfg-empty-"));
    const result = runHarness(
      `import { requireAuth } from ${JSON.stringify(join(LIB_DIR, "cli-output.ts"))};\n` +
        `requireAuth();\n` +
        `console.log("PASSED_GUARD");\n`,
      configDir,
    );
    rmSync(configDir, { recursive: true, force: true });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("Error: Not authenticated\nRun 'nemar auth login' first\n");
    expect(result.stdout).not.toContain("PASSED_GUARD");
  });

  test("authenticated (real config store with apiKey): continues, exit 0", () => {
    const configDir = mkdtempSync(join(tmpdir(), "nemar-cfg-authed-"));
    const result = runHarness(
      `import { setConfig } from ${JSON.stringify(join(LIB_DIR, "config.ts"))};\n` +
        `import { requireAuth } from ${JSON.stringify(join(LIB_DIR, "cli-output.ts"))};\n` +
        `setConfig("apiKey", "nemar_test_key_for_guard");\n` +
        `requireAuth();\n` +
        `console.log("PASSED_GUARD");\n`,
      configDir,
    );
    rmSync(configDir, { recursive: true, force: true });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("PASSED_GUARD");
    expect(result.stdout).not.toContain("Not authenticated");
  });
});
