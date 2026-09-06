/**
 * Configuration management for NEMAR CLI
 *
 * Supports multiple accounts with switching, similar to `gh auth switch`.
 * Credentials are stored per-account and the active account is tracked.
 *
 * Storage layout:
 * - All platforms: ~/.config/nemar/config.json
 *
 * Config structure:
 * {
 *   "activeAccount": "username",
 *   "accounts": {
 *     "username": { apiKey, apiUrl, username, email, githubUsername, ... }
 *   }
 * }
 */

import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import Conf from "conf";
import { z } from "zod";
import type { AssignableTo, ProfileGapWireEntry } from "../../shared/contract/profile-gaps.js";

export const DEFAULT_API_URL = "https://api.nemar.org";

/**
 * Hosts that pointed at NEMAR backends before the SCCN cutover and are now
 * either retired or stuck in MAINTENANCE_MODE. migrateApiUrl() rewrites any
 * stored apiUrl matching one of these (after trailing-slash and host-case
 * normalization, see normalizeApiUrl) to DEFAULT_API_URL.
 *
 * Live hosts (api.nemar.org, *.sccn-org.workers.dev) are deliberately absent
 * so dev builds and self-hosted URLs are untouched.
 */
const LEGACY_API_URLS: ReadonlySet<string> = new Set([
  // Pre-Phase-9 default; redirected to api.nemar.org but slated for sunset
  "https://api.osc.earth/nemar",
  // Legacy personal-account workers (dead / read-only after Phase 10)
  "https://nemar-api.neuromechanist.workers.dev",
  "https://nemar-api-dev.shirazi-10f.workers.dev",
]);

/**
 * Strip trailing slashes and lowercase scheme+host so equivalent URL spellings
 * compare equal. Path is intentionally left untouched: legacy entries above
 * use lowercase paths and we don't want a hand-edited "/Nemar" to collide
 * with a hypothetical future legacy that differs only in path case.
 *
 * On parse failure (malformed stored URL), logs once and returns the trimmed
 * raw input so the LEGACY_API_URLS lookup falls through to a no-op rather
 * than crashing CLI startup.
 */
function normalizeApiUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  try {
    const parsed = new URL(trimmed);
    parsed.protocol = parsed.protocol.toLowerCase();
    parsed.host = parsed.host.toLowerCase();
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    console.error(`[nemar] could not parse stored apiUrl ${JSON.stringify(raw)}; leaving as-is`);
    return trimmed;
  }
}

/**
 * Resolve the config directory on each call. Read from NEMAR_CONFIG_DIR
 * lazily (not captured at module load) so test files that set the env var
 * in beforeAll always win, regardless of which test file imported this
 * module first. See issue #489 for the test-ordering hazard the eager
 * capture used to cause.
 *
 * Standardized default: ~/.config/nemar/ on all platforms.
 */
export function getConfigDir(): string {
  return process.env.NEMAR_CONFIG_DIR || join(homedir(), ".config", "nemar");
}

/**
 * One cached `profile_gaps` entry, as it comes back off disk.
 *
 * Separate from the wire's `profileGapSchema` (shared/contract/user.ts) because
 * it validates a different source -- a JSON file this or an older build wrote,
 * not an HTTP response -- but it must stay loose in exactly the same way, so
 * both are pinned to the one declaration of that shape below.
 */
const cachedProfileGapSchema = z
  .object({
    field: z.string(),
    blocks: z.array(z.string()).optional(),
    set_on: z.array(z.string()).optional(),
  })
  .passthrough();

/** A cache entry must stay something the gap renderer can take; a tightening
 *  here stops compiling rather than throwing at a user's terminal. */
export const _cachedProfileGapIsRenderable: AssignableTo<
  ProfileGapWireEntry,
  z.infer<typeof cachedProfileGapSchema>
> = true;

// Per-account configuration schema
const accountSchema = z.object({
  apiKey: z.string().optional(),
  apiUrl: z.string().url().default(DEFAULT_API_URL),
  username: z.string().optional(),
  email: z.string().email().optional(),
  githubUsername: z.string().optional(),
  sandboxCompleted: z.boolean().optional(),
  sandboxDatasetId: z.string().optional(),
  dismissedNoticeIds: z.array(z.number()).optional(),
  /**
   * Upload access as of the last `auth status --refresh` (ADR 0040). Cached
   * rather than fetched on every `auth status` so the command stays usable
   * offline; absent means "never refreshed", which the status output reports
   * as unknown rather than guessing "not granted".
   */
  serviceAccess: z.boolean().optional(),
  /**
   * What the account was still missing as of the last `auth status --refresh`
   * (#1268, ADR 0045) — the backend's `profile_gaps`, cached beside
   * `serviceAccess` and for the same reason: `auth status` stays usable
   * offline, and absent means "never refreshed", which the Profile block
   * reports as not-checked rather than as "nothing missing".
   *
   * Stored as the WIRE entries rather than as rendered sentences, so a CLI
   * upgrade re-renders an old cache through its new copy table instead of
   * replaying yesterday's wording. `blocks`/`set_on` are loose string arrays
   * for the same reason they are on the wire: a vocabulary this build has not
   * heard of must round-trip rather than fail to parse.
   */
  profileGaps: z.array(cachedProfileGapSchema).optional(),
  /**
   * Whether a VERIFIED ORCID iD is linked, as of the last refresh (#1268).
   *
   * Cached for one reason: it decides where a missing NAME is set. With an iD
   * linked the record owns the name and `PATCH /auth/profile` refuses the edit,
   * so telling that person to run `nemar auth profile set-name` is advice that
   * cannot work. A refused upload-access request names the field and not the
   * account state, so the renderer has nowhere else to learn it. Absent
   * defaults to false, which is the pre-#1268 wording.
   */
  orcidVerified: z.boolean().optional(),
  /**
   * Cached from `/auth/login` and `auth status --refresh` (#1256). Not
   * authoritative -- always re-check with the backend for anything
   * access-control-sensitive -- but lets the `--debug` diagnostic bundle
   * report a role without an extra network call.
   */
  role: z.string().optional(),
  /**
   * The address `nemar auth profile set-email` last sent a code to (#1266).
   * Remembered so `verify-email <code>` needs only the code, the way the
   * website's Settings form remembers it across the two steps. Cleared on a
   * successful verification; harmless if stale, since the code is bound to
   * both the address and the account and simply will not verify.
   */
  pendingEmailChange: z.string().email().optional(),
});

export type Config = z.infer<typeof accountSchema>;

/** Summary of a stored account for listing */
export interface AccountInfo {
  username: string;
  email?: string;
  githubUsername?: string;
  active: boolean;
}

// Full store schema. Legacy flat fields are kept so migrateConfig() can read
// pre-multi-account configs and convert them to the accounts structure.
interface StoreSchema {
  activeAccount?: string;
  accounts?: Record<string, Config>;
  // Legacy flat fields (read by migrateConfig, not used at runtime)
  apiKey?: string;
  apiUrl?: string;
  username?: string;
  email?: string;
  githubUsername?: string;
  sandboxCompleted?: boolean;
  sandboxDatasetId?: string;
}

/**
 * Migrate config from the old OS-native path to the new standardized path.
 * Old paths (set by `conf` with projectName "nemar"):
 *   macOS:  ~/Library/Preferences/nemar-nodejs/config.json
 *   Linux:  ~/.config/nemar-nodejs/config.json
 *
 * Only runs once: if old config exists and new config does not.
 */
function migrateConfigPath(targetDir: string): void {
  // Skip migration when using a custom config dir (e.g., tests)
  if (process.env.NEMAR_CONFIG_DIR) return;

  const newConfigFile = join(targetDir, "config.json");
  if (existsSync(newConfigFile)) return;

  const oldPaths: string[] = [];
  if (process.platform === "darwin") {
    oldPaths.push(join(homedir(), "Library", "Preferences", "nemar-nodejs", "config.json"));
  }
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || join(homedir(), "AppData", "Roaming");
    oldPaths.push(join(appData, "nemar-nodejs", "config.json"));
  }
  // Linux default (also check on macOS in case XDG was used)
  oldPaths.push(join(homedir(), ".config", "nemar-nodejs", "config.json"));

  for (const oldPath of oldPaths) {
    if (existsSync(oldPath)) {
      try {
        mkdirSync(targetDir, { recursive: true });
        copyFileSync(oldPath, newConfigFile);
        console.error(
          `[nemar] Config migrated from ${oldPath} to ${newConfigFile}\n[nemar] You can safely remove the old file.`,
        );
        return;
      } catch (err) {
        console.error(
          `[nemar] Failed to migrate config from ${oldPath}:`,
          err,
          `\n[nemar] You can manually copy ${oldPath} to ${newConfigFile}`,
        );
      }
    }
  }
}

/**
 * Conf instance cache, keyed by the config dir that produced it. When the
 * env var changes between calls (test isolation flips NEMAR_CONFIG_DIR), we
 * detect the mismatch and rebuild against the new dir, then re-run schema
 * migrations once for that dir.
 */
let cachedStore: Conf<StoreSchema> | null = null;
let cachedStoreDir: string | null = null;
const migrationsRunForDirs = new Set<string>();

function getStore(): Conf<StoreSchema> {
  const dir = getConfigDir();
  if (cachedStore && cachedStoreDir === dir) return cachedStore;

  migrateConfigPath(dir);

  cachedStore = new Conf<StoreSchema>({
    projectName: "nemar",
    schema: {
      activeAccount: { type: "string" },
      accounts: { type: "object" },
      apiKey: { type: "string" },
      // Top-level apiUrl is a legacy flat field consumed only by migrateConfig()
      // when converting pre-multi-account configs. No schema default: with one,
      // every Conf construction (i.e. every CLI start) merges the default into
      // the on-disk store when the key is absent, fighting migrateApiUrl()'s
      // cleanup. Without the default, once cleanup runs the field stays gone.
      apiUrl: { type: "string" },
      username: { type: "string" },
      email: { type: "string" },
      githubUsername: { type: "string" },
      sandboxCompleted: { type: "boolean" },
      sandboxDatasetId: { type: "string" },
    },
    cwd: dir,
  });
  cachedStoreDir = dir;

  // Run structural migrations once per dir. Re-entrancy is gated by the
  // cache-hit short-circuit at the top of this function (cachedStore is set
  // a few lines above): the recursive getStore() call inside
  // migrateConfig()/migrateApiUrl() hits that early return before this
  // block can re-fire. migrationsRunForDirs additionally guards against
  // the dir-flip-and-revisit case (e.g. tests that toggle NEMAR_CONFIG_DIR
  // between two known paths) — migrations stay idempotent and don't
  // re-execute when a previously-seen dir comes back into view.
  if (!migrationsRunForDirs.has(dir)) {
    migrationsRunForDirs.add(dir);
    migrateConfig();
    migrateApiUrl();
  }

  return cachedStore;
}

/**
 * Drop the in-memory store cache. Tests that rely on bun's `--rerun-each` or
 * that need a guaranteed-fresh Conf instance for a previously-seen dir can
 * call this to force the next getStore() to rebuild and re-run migrations.
 * Not exported for production use.
 */
export function __resetStoreCacheForTesting(): void {
  cachedStore = null;
  cachedStoreDir = null;
  migrationsRunForDirs.clear();
}

const ACCOUNT_FIELDS: (keyof Config)[] = [
  "apiKey",
  "apiUrl",
  "username",
  "email",
  "githubUsername",
  "sandboxCompleted",
  "sandboxDatasetId",
  "dismissedNoticeIds",
];

/**
 * Migrate legacy flat config to multi-account structure.
 * Safe to call multiple times; auto-invoked from getStore() on first init
 * for a given config dir.
 */
export function migrateConfig(): void {
  const config = getStore();
  // Already migrated if accounts exists and has entries
  const existing = config.get("accounts") as Record<string, Config> | undefined;
  if (existing && Object.keys(existing).length > 0) return;

  const legacyKey = config.get("apiKey") as string | undefined;
  const legacyUsername = config.get("username") as string | undefined;

  // Nothing to migrate if no credentials stored
  if (!legacyKey && !legacyUsername) return;

  try {
    const accountName = legacyUsername || "default";
    const account = {} as Config;

    for (const field of ACCOUNT_FIELDS) {
      const val = config.get(field as keyof StoreSchema);
      if (val !== undefined) {
        (account as Record<string, unknown>)[field] = val;
      }
    }

    // Atomic write: replace entire store at once
    config.store = { activeAccount: accountName, accounts: { [accountName]: account } };
  } catch (error) {
    console.error("Config migration failed (legacy config preserved):", error);
  }
}

/**
 * Rewrite stored apiUrl entries that still point at a retired NEMAR backend
 * to DEFAULT_API_URL, and drop the leftover top-level apiUrl field that
 * pre-multi-account configs left behind.
 *
 * Match is by normalized URL (trailing slash stripped, scheme/host lowercased)
 * against LEGACY_API_URLS. Live URLs and arbitrary self-hosted/dev workers.dev
 * URLs are untouched.
 *
 * Idempotent and safe under concurrent CLI launches: a second run is a no-op,
 * and Conf writes via atomic file replace.
 *
 * If the underlying config write fails (EACCES, ENOSPC, FS race), we log and
 * continue rather than abort CLI startup.
 */
export function migrateApiUrl(): void {
  const config = getStore();
  const store = config.store as StoreSchema;
  const accounts = store.accounts;
  let changed = false;

  if (accounts) {
    for (const [name, account] of Object.entries(accounts)) {
      const url = account?.apiUrl;
      if (!url) continue;
      if (LEGACY_API_URLS.has(normalizeApiUrl(url))) {
        accounts[name] = { ...account, apiUrl: DEFAULT_API_URL };
        console.error(
          `[nemar] migrated stored apiUrl for account "${name}": ${url} -> ${DEFAULT_API_URL}`,
        );
        changed = true;
      }
    }
  }

  // Drop the stale top-level apiUrl. migrateConfig() consumes it on first run;
  // after accounts is populated the field is unused and only confuses users
  // inspecting config.json (two apiUrl values, one top-level and one per
  // account, with no obvious indication that only the per-account one wins).
  const topLevel = store.apiUrl;
  if (accounts && Object.keys(accounts).length > 0 && topLevel !== undefined) {
    // Destructure to drop the key entirely. Assigning `undefined` would still
    // satisfy `JSON.stringify` (undefined fields are dropped) but trips the
    // AJV schema validation Conf runs before write.
    const { apiUrl: _legacy, ...next } = store;
    try {
      config.store = next as StoreSchema;
      console.error(`[nemar] removed stale top-level apiUrl from config (was: ${topLevel})`);
      changed = false; // single-write path: account rewrites are already in `next`
    } catch (error) {
      // In-memory `accounts` was mutated above; the file write failed so the
      // next CLI invocation re-reads the legacy URLs from disk and retries.
      console.error("API URL cleanup failed (config file unchanged):", error);
    }
  }

  if (changed) {
    try {
      config.store = { ...config.store, accounts };
    } catch (error) {
      // Same as above: in-memory mutation lost on next read; migration retries.
      console.error("API URL migration failed (config file unchanged):", error);
    }
  }
}

/**
 * Get the active account name
 */
function getActiveAccountName(): string | undefined {
  return getStore().get("activeAccount") as string | undefined;
}

/**
 * Get the accounts map
 */
function getAccountsMap(): Record<string, Config> {
  return (getStore().get("accounts") as Record<string, Config>) || {};
}

/**
 * Get the current (active account) configuration
 */
export function getConfig(): Config {
  const defaultConfig: Config = { apiUrl: DEFAULT_API_URL };
  const active = getActiveAccountName();
  if (!active) return defaultConfig;
  return getAccountsMap()[active] || defaultConfig;
}

/**
 * Check if user has completed sandbox training
 */
export function isSandboxCompleted(): boolean {
  return !!getConfig().sandboxCompleted;
}

/**
 * Set a configuration value on the active account
 */
export function setConfig<K extends keyof Config>(key: K, value: Config[K]): void {
  const config = getStore();
  const name = (config.get("activeAccount") as string | undefined) || "default";
  const accounts = (config.get("accounts") as Record<string, Config>) || {};

  if (!accounts[name]) {
    accounts[name] = { apiUrl: DEFAULT_API_URL };
  }
  (accounts[name] as Record<string, unknown>)[key] = value;

  config.store = { ...config.store, accounts, activeAccount: name };
}

/**
 * Delete a configuration value from the active account
 */
export function deleteConfig<K extends keyof Config>(key: K): void {
  const active = getActiveAccountName();
  if (!active) return;
  const accounts = getAccountsMap();
  if (accounts[active]) {
    delete (accounts[active] as Record<string, unknown>)[key];
    getStore().set("accounts", accounts);
  }
}

/**
 * Clear the active account (remove it from accounts).
 * If other accounts remain, switches to the first available.
 */
export function clearConfig(): void {
  const config = getStore();
  const active = getActiveAccountName();
  if (!active) {
    config.clear();
    return;
  }

  const accounts = getAccountsMap();
  delete accounts[active];

  const remaining = Object.keys(accounts);
  if (remaining.length > 0) {
    config.store = { ...config.store, accounts, activeAccount: remaining[0] };
  } else {
    config.clear();
  }
}

/**
 * Clear all accounts and reset config entirely
 */
export function clearAllConfig(): void {
  getStore().clear();
}

/**
 * Check if user is authenticated (active account has an API key)
 */
export function isAuthenticated(): boolean {
  return !!getConfig().apiKey;
}

/**
 * Get the configuration file path
 */
export function getConfigPath(): string {
  return getStore().path;
}

/**
 * List all stored accounts with basic info
 */
export function getAccounts(): AccountInfo[] {
  const accounts = getAccountsMap();
  const active = getActiveAccountName();
  return Object.entries(accounts).map(([name, acct]) => ({
    username: acct.username || name,
    email: acct.email,
    githubUsername: acct.githubUsername,
    active: name === active,
  }));
}

/**
 * Store or update an account in the accounts map and set it as active.
 * The account is keyed by username.
 */
export function storeAccount(username: string, accountConfig: Config): void {
  const config = getStore();
  const accounts = getAccountsMap();
  accounts[username] = accountConfig;
  config.store = { ...config.store, accounts, activeAccount: username };
}

/**
 * What {@link renameActiveAccount} did.
 *
 * Three outcomes rather than a boolean, because the caller has to tell the two
 * "did nothing" cases apart: `unchanged` is the ordinary path (the key was
 * already right, or there is nothing to rename) and says nothing to the user,
 * while `key_taken` leaves this machine holding two accounts whose stored name
 * and map key disagree — which is worth one line of warning, since
 * `nemar auth switch <name>` will then select the OTHER one.
 */
export type RenameAccountResult = "renamed" | "unchanged" | "key_taken";

/**
 * Re-key the ACTIVE account after its username changed on the server (#1266).
 *
 * The accounts map is keyed by username and `switchAccount` looks an account
 * up by that key, so writing the new username into the account's fields and
 * leaving the key alone produces an account that `nemar auth switch <new>`
 * cannot find and `nemar auth switch <old>` finds under a name that no longer
 * exists. `nemar auth profile set-username` is the first thing that can change
 * a username from the CLI, so it is the first thing that has to move the key.
 *
 * Never clobbers a DIFFERENT stored account to do it. Two accounts on one
 * machine can legitimately end up here — sign in as `harlow`, sign in as
 * `alovelace`, then rename `harlow` to `alovelace` on the server — and
 * overwriting the second entry would delete a working API key to fix a name.
 * The account keeps its old key and still works; only the lookup name is
 * stale, and the caller says so.
 */
export function renameActiveAccount(newUsername: string): RenameAccountResult {
  const name = newUsername.trim();
  if (!name) return "unchanged";
  const config = getStore();
  const active = getActiveAccountName();
  if (!active || active === name) return "unchanged";
  const accounts = getAccountsMap();
  const current = accounts[active];
  if (!current) return "unchanged";
  if (accounts[name]) return "key_taken";

  delete accounts[active];
  accounts[name] = { ...current, username: name };
  config.store = { ...config.store, accounts, activeAccount: name };
  return "renamed";
}

/**
 * Switch to a different stored account by NEMAR username or GitHub username.
 * Returns the account that was switched to, or null if not found.
 */
export function switchAccount(identifier: string): Config | null {
  const config = getStore();
  const accounts = getAccountsMap();

  // Try direct key match first (NEMAR username)
  if (accounts[identifier]) {
    config.store = { ...config.store, activeAccount: identifier };
    return accounts[identifier];
  }

  // Try matching by GitHub username
  for (const [key, acct] of Object.entries(accounts)) {
    if (acct.githubUsername === identifier) {
      config.store = { ...config.store, activeAccount: key };
      return acct;
    }
  }

  return null;
}
