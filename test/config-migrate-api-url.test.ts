import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LEGACY_URL = "https://api.osc.earth/nemar";
const NEW_URL = "https://api.nemar.org";
const DEV_URL = "https://nemar-api-dev.sccn-org.workers.dev";
const CUSTOM_URL = "https://api.example.com/nemar";

// Module-level state in src/lib/config.ts captures NEMAR_CONFIG_DIR at first
// import. Bun caches modules across tests, so we set up the config once,
// import once, and assert all migration scenarios from one snapshot.

const testDir = join(tmpdir(), `nemar-cfg-migrate-${Date.now()}-${process.pid}`);

beforeAll(() => {
  mkdirSync(testDir, { recursive: true });
  process.env.NEMAR_CONFIG_DIR = testDir;
  writeFileSync(
    join(testDir, "config.json"),
    JSON.stringify({
      activeAccount: "alice",
      accounts: {
        alice: { apiUrl: LEGACY_URL, apiKey: "k1" },
        bob: { apiUrl: LEGACY_URL, apiKey: "k2" },
        carol: { apiUrl: NEW_URL, apiKey: "k3" },
        dev: { apiUrl: DEV_URL, apiKey: "k4" },
        custom: { apiUrl: CUSTOM_URL, apiKey: "k5" },
      },
    }),
  );
});

afterAll(() => {
  delete process.env.NEMAR_CONFIG_DIR;
  if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
});

describe("migrateApiUrl", () => {
  test("importing config.ts triggers migration of all stored apiUrl entries", async () => {
    // Module load runs migrateApiUrl() at top level
    await import("../src/lib/config.ts");

    const after = JSON.parse(await Bun.file(join(testDir, "config.json")).text()) as {
      accounts: Record<string, { apiUrl: string }>;
    };

    // Both legacy URLs rewritten
    expect(after.accounts.alice.apiUrl).toBe(NEW_URL);
    expect(after.accounts.bob.apiUrl).toBe(NEW_URL);
    // Already-correct URL stays
    expect(after.accounts.carol.apiUrl).toBe(NEW_URL);
    // Non-default URLs untouched
    expect(after.accounts.dev.apiUrl).toBe(DEV_URL);
    expect(after.accounts.custom.apiUrl).toBe(CUSTOM_URL);
  });
});
