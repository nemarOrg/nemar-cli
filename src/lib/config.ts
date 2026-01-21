/**
 * Configuration management for NEMAR CLI
 *
 * Handles user configuration storage in a cross-platform manner:
 * - Linux/macOS: ~/.config/nemar/
 * - Windows: %APPDATA%/nemar/
 */

import Conf from "conf";
import { z } from "zod";

// Configuration schema
const configSchema = z.object({
  apiKey: z.string().optional(),
  apiUrl: z.string().url().default("https://api.osc.earth/nemar"),
  username: z.string().optional(),
  email: z.string().email().optional(),
  githubUsername: z.string().optional(), // Required for PR collaboration
  sandboxCompleted: z.boolean().optional(), // True after completing sandbox training
  sandboxDatasetId: z.string().optional(), // Dataset ID from sandbox training (xx000xxx)
});

export type Config = z.infer<typeof configSchema>;

// Create configuration store
// Support NEMAR_CONFIG_DIR env var for testing isolation
const config = new Conf<Config>({
  projectName: "nemar",
  schema: {
    apiKey: { type: "string" },
    apiUrl: { type: "string", default: "https://api.osc.earth/nemar" },
    username: { type: "string" },
    email: { type: "string" },
    githubUsername: { type: "string" },
    sandboxCompleted: { type: "boolean" },
    sandboxDatasetId: { type: "string" },
  },
  // Allow custom config directory for testing
  ...(process.env.NEMAR_CONFIG_DIR ? { cwd: process.env.NEMAR_CONFIG_DIR } : {}),
});

/**
 * Get the current configuration
 */
export function getConfig(): Config {
  return {
    apiKey: config.get("apiKey"),
    apiUrl: config.get("apiUrl"),
    username: config.get("username"),
    email: config.get("email"),
    githubUsername: config.get("githubUsername"),
    sandboxCompleted: config.get("sandboxCompleted"),
    sandboxDatasetId: config.get("sandboxDatasetId"),
  };
}

/**
 * Check if user has completed sandbox training
 */
export function isSandboxCompleted(): boolean {
  return !!config.get("sandboxCompleted");
}

/**
 * Set a configuration value
 */
export function setConfig<K extends keyof Config>(key: K, value: Config[K]): void {
  config.set(key, value);
}

/**
 * Delete a configuration value
 */
export function deleteConfig<K extends keyof Config>(key: K): void {
  config.delete(key);
}

/**
 * Clear all configuration (logout)
 */
export function clearConfig(): void {
  config.clear();
}

/**
 * Check if user is authenticated
 */
export function isAuthenticated(): boolean {
  return !!config.get("apiKey");
}

/**
 * Get the configuration file path
 */
export function getConfigPath(): string {
  return config.path;
}
