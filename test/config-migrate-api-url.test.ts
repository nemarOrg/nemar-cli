import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LEGACY_URL = "https://api.osc.earth/nemar";
const LEGACY_URL_TRAILING_SLASH = "https://api.osc.earth/nemar/";
const LEGACY_PERSONAL_PROD = "https://nemar-api.neuromechanist.workers.dev";
const LEGACY_PERSONAL_DEV = "https://nemar-api-dev.shirazi-10f.workers.dev";
const NEW_URL = "https://api.nemar.org";
const SCCN_DEV_URL = "https://nemar-api-dev.sccn-org.workers.dev";
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
        sccnDev: { apiUrl: SCCN_DEV_URL, apiKey: "k4" },
        custom: { apiUrl: CUSTOM_URL, apiKey: "k5" },
        // Legacy-flat migration produces accounts with no apiUrl when none
        // was stored. Optional chaining in migrateApiUrl must not crash here
        // and must leave the field absent.
        partial: { apiKey: "k6" },
        // Trailing-slash variant of the legacy default — must be normalized
        // and rewritten just like the canonical legacy URL.
        slashed: { apiUrl: LEGACY_URL_TRAILING_SLASH, apiKey: "k7" },
        // Pre-Phase-10 personal prod worker — now read-only, must rewrite.
        personalProd: { apiUrl: LEGACY_PERSONAL_PROD, apiKey: "k8" },
        // Pre-Phase-10 personal dev worker — was the shipped dev default in
        // 0.7.x, now dead. Must rewrite even though host contains workers.dev.
        personalDev: { apiUrl: LEGACY_PERSONAL_DEV, apiKey: "k9" },
      },
      // Stale top-level apiUrl from pre-multi-account configs. migrateApiUrl
      // must drop this when accounts is already populated, otherwise the
      // Conf schema default keeps re-asserting it on every write.
      apiUrl: LEGACY_URL,
    }),
  );
});

afterAll(() => {
  // biome-ignore lint/performance/noDelete: env var cleanup; assigning undefined leaves the key as the literal string "undefined" for child processes
  delete process.env.NEMAR_CONFIG_DIR;
  if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
});

describe("migrateApiUrl", () => {
  test("importing config.ts triggers migration of all stored apiUrl entries", async () => {
    // Module load runs migrateApiUrl() at top level
    await import("../src/lib/config.ts");

    const after = JSON.parse(await Bun.file(join(testDir, "config.json")).text()) as {
      accounts: Record<string, { apiUrl?: string }>;
      apiUrl?: string;
    };

    // Canonical legacy URL rewritten
    expect(after.accounts.alice.apiUrl).toBe(NEW_URL);
    expect(after.accounts.bob.apiUrl).toBe(NEW_URL);
    // Already-correct URL stays
    expect(after.accounts.carol.apiUrl).toBe(NEW_URL);
    // Live SCCN dev worker untouched (real dev builds depend on it)
    expect(after.accounts.sccnDev.apiUrl).toBe(SCCN_DEV_URL);
    // Arbitrary self-hosted URL untouched
    expect(after.accounts.custom.apiUrl).toBe(CUSTOM_URL);
    // Account with no apiUrl: must not crash, must not invent one
    expect(after.accounts.partial.apiUrl).toBeUndefined();
    // Trailing-slash variant normalized and rewritten
    expect(after.accounts.slashed.apiUrl).toBe(NEW_URL);
    // Dead personal-account workers rewritten despite workers.dev substring
    expect(after.accounts.personalProd.apiUrl).toBe(NEW_URL);
    expect(after.accounts.personalDev.apiUrl).toBe(NEW_URL);
    // Stale top-level apiUrl dropped
    expect(after.apiUrl).toBeUndefined();
  });
});
