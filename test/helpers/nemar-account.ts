/**
 * A real stored NEMAR account in a throwaway config directory, written through the CLI's own
 * `upsertAccount`, for tests that run the CLI (or the special remote) as a child process with
 * `NEMAR_CONFIG_DIR` pointing at it.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { upsertAccount } from "../../src/lib/config";

/**
 * Make a config directory holding one active account with `apiKey` (and none when it is
 * null: an empty directory, which is a signed-out CLI). `apiUrl` is where the CLI's own API
 * calls (notices, say) would go; point it at a local port so nothing leaves the machine.
 */
export function makeConfigDir(apiKey: string | null, apiUrl = "http://127.0.0.1:9"): string {
  const dir = mkdtempSync(join(tmpdir(), "nemar-cfg-"));
  if (apiKey === null) return dir;
  const previous = process.env.NEMAR_CONFIG_DIR;
  process.env.NEMAR_CONFIG_DIR = dir;
  try {
    upsertAccount("fixture", { apiKey, apiUrl, keySource: "paste" });
  } finally {
    if (previous === undefined) Reflect.deleteProperty(process.env, "NEMAR_CONFIG_DIR");
    else process.env.NEMAR_CONFIG_DIR = previous;
  }
  return dir;
}

/** A well-formed fake API key that is valid for nothing. */
export function fakeApiKey(): string {
  return `nmr_fixture_${crypto.randomUUID().replaceAll("-", "")}`;
}

/**
 * The test process's environment without anything that steers the CLI: no `TEST_*` variable (a
 * live-backend suite that ran earlier in the same process may have left one, and it outranks a
 * stored account's API URL) and no `NEMAR_*` variable. A test adds the few it means to set.
 */
export function cliBaseEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (name.startsWith("TEST_") || name.startsWith("NEMAR_")) continue;
    env[name] = value;
  }
  return env;
}
