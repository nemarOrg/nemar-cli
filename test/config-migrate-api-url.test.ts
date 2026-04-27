import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LEGACY_URL = "https://api.osc.earth/nemar";
const LEGACY_URL_TRAILING_SLASH = "https://api.osc.earth/nemar/";
const LEGACY_URL_UPPERCASE_HOST = "HTTPS://API.OSC.EARTH/nemar";
const LEGACY_PERSONAL_PROD = "https://nemar-api.neuromechanist.workers.dev";
const LEGACY_PERSONAL_DEV = "https://nemar-api-dev.shirazi-10f.workers.dev";
const NEW_URL = "https://api.nemar.org";
const SCCN_DEV_URL = "https://nemar-api-dev.sccn-org.workers.dev";
const CUSTOM_URL = "https://api.example.com/nemar";

// Module-level state in src/lib/config.ts captures NEMAR_CONFIG_DIR at first
// import. Bun caches modules across tests, so we set up the config once,
// import once, and assert all migration scenarios from one snapshot. A second
// idempotency assertion calls the exported function directly.

const testDir = join(tmpdir(), `nemar-cfg-migrate-${Date.now()}-${process.pid}`);
const configPath = join(testDir, "config.json");

function readConfig(): {
  accounts?: Record<string, { apiUrl?: string; apiKey?: string }>;
  apiUrl?: string;
} {
  return JSON.parse(readFileSync(configPath, "utf8"));
}

beforeAll(() => {
  mkdirSync(testDir, { recursive: true });
  process.env.NEMAR_CONFIG_DIR = testDir;
  writeFileSync(
    configPath,
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
        // Trailing-slash variant of the legacy default; must be normalized
        // and rewritten just like the canonical legacy URL.
        slashed: { apiUrl: LEGACY_URL_TRAILING_SLASH, apiKey: "k7" },
        // Pre-Phase-10 personal prod worker; now read-only, must rewrite.
        personalProd: { apiUrl: LEGACY_PERSONAL_PROD, apiKey: "k8" },
        // Pre-Phase-10 personal dev worker; was the shipped dev default in
        // 0.7.x, now dead. Must rewrite even though host contains workers.dev.
        personalDev: { apiUrl: LEGACY_PERSONAL_DEV, apiKey: "k9" },
        // Hand-edited or future legacy variant with uppercase scheme/host.
        // normalizeApiUrl lowercases scheme+host so this must match the set.
        upper: { apiUrl: LEGACY_URL_UPPERCASE_HOST, apiKey: "k10" },
        // Empty-string apiUrl is a realistic corruption mode (failed write,
        // hand edit). Migration must not crash on `new URL("")` and must
        // leave the field as-is so downstream `apiUrl || DEFAULT` falls back.
        empty: { apiUrl: "", apiKey: "k11" },
      },
      // Stale top-level apiUrl from pre-multi-account configs. migrateApiUrl
      // must drop this when accounts is already populated, otherwise users
      // see two apiUrls in config.json with no signal which one wins.
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
  test("first launch rewrites legacy URLs, drops top-level field, leaves live URLs alone", async () => {
    // Module load runs migrateApiUrl() at top level.
    await import("../src/lib/config.ts");

    const after = readConfig();
    const accounts = after.accounts ?? {};

    // Canonical legacy URL rewritten.
    expect(accounts.alice?.apiUrl).toBe(NEW_URL);
    expect(accounts.bob?.apiUrl).toBe(NEW_URL);
    // Already-correct URL stays.
    expect(accounts.carol?.apiUrl).toBe(NEW_URL);
    // Live SCCN dev worker untouched (real dev builds depend on it).
    expect(accounts.sccnDev?.apiUrl).toBe(SCCN_DEV_URL);
    // Arbitrary self-hosted URL untouched.
    expect(accounts.custom?.apiUrl).toBe(CUSTOM_URL);
    // Account with no apiUrl: must not crash, must not invent one.
    expect(accounts.partial?.apiUrl).toBeUndefined();
    // Trailing-slash variant normalized and rewritten.
    expect(accounts.slashed?.apiUrl).toBe(NEW_URL);
    // Dead personal-account workers rewritten despite workers.dev substring.
    expect(accounts.personalProd?.apiUrl).toBe(NEW_URL);
    expect(accounts.personalDev?.apiUrl).toBe(NEW_URL);
    // Uppercase scheme/host normalized and rewritten.
    expect(accounts.upper?.apiUrl).toBe(NEW_URL);
    // Empty string preserved (downstream falls back via `apiUrl || DEFAULT`).
    expect(accounts.empty?.apiUrl).toBe("");
    // Stale top-level apiUrl dropped.
    expect(after.apiUrl).toBeUndefined();
  });

  test("second invocation is a no-op on a clean config", async () => {
    const { migrateApiUrl } = await import("../src/lib/config.ts");
    const before = readConfig();
    migrateApiUrl();
    const after = readConfig();
    expect(after).toEqual(before);
  });

  test("only top-level field stale: accounts already clean, still drops the field", async () => {
    // Distinct config dir so the module-level Conf store reload picks up
    // fresh state; the previous tests already locked NEMAR_CONFIG_DIR for
    // this process, so we drive migrateApiUrl directly with a hand-rolled
    // store to exercise the branch.
    const { migrateApiUrl } = await import("../src/lib/config.ts");
    writeFileSync(
      configPath,
      JSON.stringify({
        activeAccount: "alice",
        accounts: { alice: { apiUrl: NEW_URL, apiKey: "k1" } },
        apiUrl: LEGACY_URL,
      }),
    );
    migrateApiUrl();
    const after = readConfig();
    expect(after.accounts?.alice?.apiUrl).toBe(NEW_URL);
    expect(after.apiUrl).toBeUndefined();
  });
});
