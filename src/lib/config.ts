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

export const DEFAULT_API_URL = "https://api.nemar.org";

/**
 * Old default URL pre-Phase-9. Rewritten to DEFAULT_API_URL on CLI launch by
 * migrateApiUrl(). The legacy redirect on personal Cloudflare keeps stale
 * configs working too, but we proactively rewrite so users don't ride the
 * redirect forever.
 */
const LEGACY_DEFAULT_API_URL = "https://api.osc.earth/nemar";

/**
 * Standardized config directory: ~/.config/nemar/ on all platforms.
 * Overridden by NEMAR_CONFIG_DIR env var for test isolation.
 */
const CONFIG_DIR = process.env.NEMAR_CONFIG_DIR || join(homedir(), ".config", "nemar");

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
function migrateConfigPath(): void {
  // Skip migration when using a custom config dir (e.g., tests)
  if (process.env.NEMAR_CONFIG_DIR) return;

  const newConfigFile = join(CONFIG_DIR, "config.json");
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
        mkdirSync(CONFIG_DIR, { recursive: true });
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

// Migrate old config path before creating the Conf instance
migrateConfigPath();

// Create configuration store with standardized path
const config = new Conf<StoreSchema>({
  projectName: "nemar",
  schema: {
    activeAccount: { type: "string" },
    accounts: { type: "object" },
    apiKey: { type: "string" },
    apiUrl: { type: "string", default: DEFAULT_API_URL },
    username: { type: "string" },
    email: { type: "string" },
    githubUsername: { type: "string" },
    sandboxCompleted: { type: "boolean" },
    sandboxDatasetId: { type: "string" },
  },
  cwd: CONFIG_DIR,
});

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
 * Called automatically on module load. Safe to call multiple times.
 */
export function migrateConfig(): void {
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

// Run migration on module load
migrateConfig();

/**
 * Rewrite stored apiUrl entries that still point at the pre-cutover legacy
 * URL. The server-side redirect on the legacy host keeps old configs working,
 * but we rewrite proactively so users converge on the canonical host.
 *
 * Only rewrites *exact* matches of the legacy default. Custom URLs (dev
 * builds, self-hosted, workers.dev fallbacks) are left alone.
 *
 * Idempotent and safe under concurrent CLI launches: the exact-match guard
 * means a second run is a no-op, and Conf writes via atomic file replace, so
 * a racing process sees pre- or post-state, never partial.
 *
 * If the underlying config write fails (EACCES, ENOSPC, FS race), we log and
 * continue rather than abort CLI startup. The legacy redirect is the safety
 * net, so the user's next command still works against the pre-rewrite URL.
 */
export function migrateApiUrl(): void {
  const accounts = config.get("accounts") as Record<string, Config> | undefined;
  if (!accounts) return;
  let changed = false;
  for (const [name, account] of Object.entries(accounts)) {
    if (account?.apiUrl === LEGACY_DEFAULT_API_URL) {
      accounts[name] = { ...account, apiUrl: DEFAULT_API_URL };
      changed = true;
    }
  }
  if (changed) {
    try {
      config.store = { ...config.store, accounts };
    } catch (error) {
      console.error(
        "API URL migration failed (legacy URL preserved, redirect still works):",
        error,
      );
    }
  }
}

migrateApiUrl();

/**
 * Get the active account name
 */
function getActiveAccountName(): string | undefined {
  return config.get("activeAccount") as string | undefined;
}

/**
 * Get the accounts map
 */
function getAccountsMap(): Record<string, Config> {
  return (config.get("accounts") as Record<string, Config>) || {};
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
  const name = getActiveAccountName() || "default";
  const accounts = getAccountsMap();

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
    config.set("accounts", accounts);
  }
}

/**
 * Clear the active account (remove it from accounts).
 * If other accounts remain, switches to the first available.
 */
export function clearConfig(): void {
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
  config.clear();
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
  return config.path;
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
  const accounts = getAccountsMap();
  accounts[username] = accountConfig;
  config.store = { ...config.store, accounts, activeAccount: username };
}

/**
 * Switch to a different stored account by NEMAR username or GitHub username.
 * Returns the account that was switched to, or null if not found.
 */
export function switchAccount(identifier: string): Config | null {
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
