#!/usr/bin/env node
/**
 * Install-time heads-up about missing external tools.
 *
 * NEMAR needs git, git-annex, gh, aws, and deno (none are bundled). This prints
 * a concise warning at install time naming what's missing and pointing to
 * `nemar doctor` for versions + platform-specific install commands. It NEVER
 * fails the install (always exits 0) and stays quiet in CI.
 *
 * Note: Bun may skip dependency lifecycle scripts unless trusted, so this is a
 * best-effort nudge; `nemar doctor` and the signup check are the reliable paths.
 */
import { spawnSync } from "node:child_process";

if (process.env.CI || process.env.NEMAR_SKIP_POSTINSTALL) process.exit(0);

const TOOLS = [
  ["git", ["--version"]],
  ["git-annex", ["version"]],
  ["gh", ["--version"]],
  ["aws", ["--version"]],
  ["deno", ["--version"]],
];

const isPresent = ([cmd, args]) => {
  try {
    const r = spawnSync(cmd, args, { stdio: "ignore", timeout: 8000 });
    return !r.error; // ENOENT (not installed) surfaces as r.error
  } catch {
    return false;
  }
};

const missing = TOOLS.filter((t) => !isPresent(t)).map(([cmd]) => cmd);

if (missing.length > 0) {
  const y = (s) => (process.stdout.isTTY ? `\x1b[33m${s}\x1b[0m` : s);
  console.warn("");
  console.warn(y("NEMAR: some tools you'll need aren't installed yet:"));
  console.warn(`  ${missing.join(", ")}`);
  console.warn("  Run `nemar doctor` for versions and platform-specific install commands.");
  console.warn("");
}

process.exit(0);
