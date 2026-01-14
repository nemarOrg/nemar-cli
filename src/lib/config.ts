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
  apiUrl: z.string().url().default("https://api.nemar.org"),
  username: z.string().optional(),
  email: z.string().email().optional(),
  githubUsername: z.string().optional(), // Required for PR collaboration
});

export type Config = z.infer<typeof configSchema>;

// Create configuration store
const config = new Conf<Config>({
  projectName: "nemar",
  schema: {
    apiKey: { type: "string" },
    apiUrl: { type: "string", default: "https://api.nemar.org" },
    username: { type: "string" },
    email: { type: "string" },
    githubUsername: { type: "string" },
  },
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
  };
}

/**
 * Set a configuration value
 */
export function setConfig<K extends keyof Config>(key: K, value: Config[K]): void {
  config.set(key, value);
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
