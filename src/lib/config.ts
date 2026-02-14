/**
 * Configuration management for NEMAR CLI
 *
 * Supports multiple accounts with switching, similar to `gh auth switch`.
 * Credentials are stored per-account and the active account is tracked.
 *
 * Storage layout:
 * - Linux/macOS: ~/.config/nemar/config.json
 * - Windows: %APPDATA%/nemar/config.json
 *
 * Config structure:
 * {
 *   "activeAccount": "username",
 *   "accounts": {
 *     "username": { apiKey, apiUrl, username, email, githubUsername, ... }
 *   }
 * }
 */

import Conf from "conf";
import { z } from "zod";

// Per-account configuration schema
const accountSchema = z.object({
  apiKey: z.string().optional(),
  apiUrl: z.string().url().default("https://api.osc.earth/nemar"),
  username: z.string().optional(),
  email: z.string().email().optional(),
  githubUsername: z.string().optional(),
  sandboxCompleted: z.boolean().optional(),
  sandboxDatasetId: z.string().optional(),
});

export type Config = z.infer<typeof accountSchema>;

/** Summary of a stored account for listing */
export interface AccountInfo {
  username: string;
  email?: string;
  githubUsername?: string;
  active: boolean;
}

// Full store schema (accounts map + activeAccount + legacy flat fields)
interface StoreSchema {
  activeAccount?: string;
  accounts?: Record<string, Config>;
  // Legacy flat fields (pre-migration)
  apiKey?: string;
  apiUrl?: string;
  username?: string;
  email?: string;
  githubUsername?: string;
  sandboxCompleted?: boolean;
  sandboxDatasetId?: string;
}

// Create configuration store
const config = new Conf<StoreSchema>({
  projectName: "nemar",
  schema: {
    activeAccount: { type: "string" },
    accounts: { type: "object" },
    apiKey: { type: "string" },
    apiUrl: { type: "string", default: "https://api.osc.earth/nemar" },
    username: { type: "string" },
    email: { type: "string" },
    githubUsername: { type: "string" },
    sandboxCompleted: { type: "boolean" },
    sandboxDatasetId: { type: "string" },
  },
  ...(process.env.NEMAR_CONFIG_DIR ? { cwd: process.env.NEMAR_CONFIG_DIR } : {}),
});

const ACCOUNT_FIELDS: (keyof Config)[] = [
  "apiKey",
  "apiUrl",
  "username",
  "email",
  "githubUsername",
  "sandboxCompleted",
  "sandboxDatasetId",
];

/**
 * Migrate legacy flat config to multi-account structure.
 * Called automatically on first access. Safe to call multiple times.
 */
export function migrateConfig(): void {
  // Already migrated if accounts exists
  if (config.get("accounts")) return;

  const legacyKey = config.get("apiKey") as string | undefined;
  const legacyUsername = config.get("username") as string | undefined;

  // Nothing to migrate if no credentials stored
  if (!legacyKey && !legacyUsername) return;

  const accountName = legacyUsername || "default";
  const account: Config = {
    apiUrl: "https://api.osc.earth/nemar",
  };

  for (const field of ACCOUNT_FIELDS) {
    const val = config.get(field as keyof StoreSchema);
    if (val !== undefined) {
      (account as Record<string, unknown>)[field] = val;
    }
  }

  // Write new structure
  config.set("accounts", { [accountName]: account });
  config.set("activeAccount", accountName);

  // Remove legacy flat fields
  for (const field of ACCOUNT_FIELDS) {
    config.delete(field as keyof StoreSchema);
  }
}

// Run migration on module load
migrateConfig();

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
  const active = getActiveAccountName();
  if (!active) {
    return { apiUrl: "https://api.osc.earth/nemar" };
  }
  const accounts = getAccountsMap();
  return accounts[active] || { apiUrl: "https://api.osc.earth/nemar" };
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
  const active = getActiveAccountName();
  if (!active) {
    // No active account yet; create a temporary one
    const accounts = getAccountsMap();
    const name = "default";
    accounts[name] = { ...(accounts[name] || {}), [key]: value };
    config.set("accounts", accounts);
    config.set("activeAccount", name);
    return;
  }
  const accounts = getAccountsMap();
  if (!accounts[active]) {
    accounts[active] = { apiUrl: "https://api.osc.earth/nemar" };
  }
  (accounts[active] as Record<string, unknown>)[key] = value;
  config.set("accounts", accounts);
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
 * Returns the username that was removed, or undefined.
 */
export function clearConfig(): string | undefined {
  const active = getActiveAccountName();
  if (!active) {
    config.clear();
    return undefined;
  }

  const accounts = getAccountsMap();
  const removedUsername = active;
  delete accounts[active];

  const remaining = Object.keys(accounts);
  if (remaining.length > 0) {
    config.set("accounts", accounts);
    config.set("activeAccount", remaining[0]);
  } else {
    config.clear();
  }
  return removedUsername;
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
  config.set("accounts", accounts);
  config.set("activeAccount", username);
}

/**
 * Switch to a different stored account by NEMAR username or GitHub username.
 * Returns the account that was switched to, or null if not found.
 */
export function switchAccount(identifier: string): Config | null {
  const accounts = getAccountsMap();

  // Try direct key match first (NEMAR username)
  if (accounts[identifier]) {
    config.set("activeAccount", identifier);
    return accounts[identifier];
  }

  // Try matching by GitHub username
  for (const [key, acct] of Object.entries(accounts)) {
    if (acct.githubUsername === identifier) {
      config.set("activeAccount", key);
      return acct;
    }
  }

  return null;
}

/**
 * Remove a specific account by username.
 * If it was the active account, switches to next available.
 * Returns true if the account was found and removed.
 */
export function removeAccount(username: string): boolean {
  const accounts = getAccountsMap();
  if (!accounts[username]) return false;

  delete accounts[username];
  const active = getActiveAccountName();

  const remaining = Object.keys(accounts);
  if (remaining.length > 0) {
    config.set("accounts", accounts);
    if (active === username) {
      config.set("activeAccount", remaining[0]);
    }
  } else {
    config.clear();
  }
  return true;
}
