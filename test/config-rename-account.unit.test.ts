/**
 * `renameActiveAccount` — the accounts map is keyed by username (#1266, ADR
 * 0044; PR #1269 review).
 *
 * `nemar auth profile set-username` is the first thing that can change a
 * username from the CLI, so it is the first thing that has to move the KEY as
 * well as the field: `switchAccount` looks an account up by that key, and a
 * renamed account whose key stayed behind is one `nemar auth switch <new>`
 * cannot find.
 *
 * The case this file exists for is the one the CLI test cannot reach cheaply:
 * a machine with TWO stored accounts, where the new name is already somebody
 * else's key. Overwriting it would delete a working API key to fix a display
 * name, so the rename declines — and declining is only safe if it is total,
 * which is what the assertions below pin.
 *
 * Real on-disk store through the production `conf` instance, in an isolated
 * NEMAR_CONFIG_DIR. No mocks.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  __resetStoreCacheForTesting,
  getAccounts,
  getConfig,
  renameActiveAccount,
} from "../src/lib/config.js";

const testDir = join(tmpdir(), `nemar-cfg-rename-${Date.now()}-${process.pid}`);
const configPath = join(testDir, "config.json");

/** Two stored accounts, `harlow` active — the shape `nemar auth switch` makes. */
function seedTwoAccounts(): void {
  writeFileSync(
    configPath,
    JSON.stringify({
      activeAccount: "harlow",
      accounts: {
        harlow: { apiKey: "harlow-key", username: "harlow", email: "harlow@example.org" },
        alovelace: { apiKey: "ada-key", username: "alovelace", email: "ada@example.org" },
      },
    }),
  );
  __resetStoreCacheForTesting();
}

function onDisk(): {
  activeAccount?: string;
  accounts: Record<string, { apiKey?: string; username?: string; email?: string }>;
} {
  return JSON.parse(readFileSync(configPath, "utf8"));
}

/**
 * What `NEMAR_CONFIG_DIR` held before this file touched it.
 *
 * `bun test` runs every file in ONE process, so this variable is shared state
 * and restoring it is not tidiness. It used to be "restored" with
 * `process.env.NEMAR_CONFIG_DIR = undefined`, which does not unset anything: it
 * assigns the STRING "undefined", and `getConfigDir()` reads that as a relative
 * path — so every later test in the run wrote its config into `./undefined/` in
 * the working directory, and a test that expected the real default silently got
 * a different one.
 */
let previousConfigDir: string | undefined;

beforeAll(() => {
  previousConfigDir = process.env.NEMAR_CONFIG_DIR;
});

beforeEach(() => {
  mkdirSync(testDir, { recursive: true });
  process.env.NEMAR_CONFIG_DIR = testDir;
  seedTwoAccounts();
});

afterAll(() => {
  // `delete` when it was unset, because assigning undefined is what caused
  // this. The store cache is dropped after, so nothing keeps reading the old
  // directory.
  if (previousConfigDir === undefined) delete process.env.NEMAR_CONFIG_DIR;
  else process.env.NEMAR_CONFIG_DIR = previousConfigDir;
  __resetStoreCacheForTesting();
  rmSync(testDir, { recursive: true, force: true });
});

describe("renameActiveAccount", () => {
  test("refuses to take a key another stored account already holds", () => {
    // The collision path, and the reason it is a no-op rather than an
    // overwrite: `alovelace` is a real account with a real API key, and
    // renaming `harlow` onto it would destroy that key to fix a name.
    expect(renameActiveAccount("alovelace")).toBe("key_taken");

    const stored = onDisk();
    // BOTH entries intact, each with its own credentials.
    expect(Object.keys(stored.accounts).sort()).toEqual(["alovelace", "harlow"]);
    expect(stored.accounts.harlow.apiKey).toBe("harlow-key");
    expect(stored.accounts.alovelace.apiKey).toBe("ada-key");
    // The other account's identity is untouched -- not renamed, not merged.
    expect(stored.accounts.alovelace.username).toBe("alovelace");
    expect(stored.accounts.alovelace.email).toBe("ada@example.org");
    // And the caller is still acting as the account it was acting as.
    expect(stored.activeAccount).toBe("harlow");
    expect(getConfig().apiKey).toBe("harlow-key");
  });

  test("moves the key, the fields and the active pointer when the name is free", () => {
    // The success path, so the refusal above is provably about the COLLISION
    // and not about the function doing nothing at all.
    expect(renameActiveAccount("hgrant")).toBe("renamed");

    const stored = onDisk();
    expect(Object.keys(stored.accounts).sort()).toEqual(["alovelace", "hgrant"]);
    expect(stored.accounts.hgrant.apiKey).toBe("harlow-key");
    expect(stored.accounts.hgrant.username).toBe("hgrant");
    // The credentials moved with the key rather than being left behind.
    expect(stored.accounts.hgrant.email).toBe("harlow@example.org");
    expect(stored.activeAccount).toBe("hgrant");
    expect(getAccounts().find((a) => a.active)?.username).toBe("hgrant");
  });

  test("re-submitting the current name is `unchanged`, not a collision", () => {
    // The ordinary case on every refresh: the account's own key is "taken" by
    // the account itself. Reporting `key_taken` here would print a warning
    // after every successful profile edit.
    expect(renameActiveAccount("harlow")).toBe("unchanged");
    expect(renameActiveAccount("  ")).toBe("unchanged");
    expect(onDisk().activeAccount).toBe("harlow");
    expect(Object.keys(onDisk().accounts).sort()).toEqual(["alovelace", "harlow"]);
  });
});
