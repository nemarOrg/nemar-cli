/**
 * Local dataset configuration management
 *
 * Stores dataset metadata in .nemar/config.json within the dataset directory.
 * This enables resume capability for failed uploads.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface LocalDatasetConfig {
  dataset_id: string;
  github_url: string;
  ssh_url: string;
  s3_prefix: string;
  s3_config: {
    bucket: string;
    region: string;
    public_url: string;
  };
  created_at: string;
  last_upload_at?: string;
}

const CONFIG_DIR = ".nemar";
const CONFIG_FILE = "config.json";

/**
 * Get the path to the .nemar directory for a dataset
 */
export function getConfigDir(datasetPath: string): string {
  return join(datasetPath, CONFIG_DIR);
}

/**
 * Get the path to the config file for a dataset
 */
export function getConfigPath(datasetPath: string): string {
  return join(getConfigDir(datasetPath), CONFIG_FILE);
}

/**
 * Check if a dataset has local NEMAR configuration
 */
export function hasLocalConfig(datasetPath: string): boolean {
  return existsSync(getConfigPath(datasetPath));
}

/**
 * Validate that parsed JSON has required LocalDatasetConfig fields
 */
function isValidConfig(config: unknown): config is LocalDatasetConfig {
  if (!config || typeof config !== "object") return false;
  const c = config as Record<string, unknown>;
  return (
    typeof c.dataset_id === "string" &&
    c.dataset_id.length > 0 &&
    typeof c.github_url === "string" &&
    typeof c.ssh_url === "string" &&
    typeof c.s3_prefix === "string" &&
    typeof c.s3_config === "object" &&
    c.s3_config !== null &&
    typeof c.created_at === "string"
  );
}

/**
 * Read local dataset configuration
 *
 * @returns The parsed config, or null if file doesn't exist or is invalid
 */
export function readLocalConfig(datasetPath: string): LocalDatasetConfig | null {
  const configPath = getConfigPath(datasetPath);
  if (!existsSync(configPath)) {
    return null;
  }

  try {
    const content = readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(content);

    if (!isValidConfig(parsed)) {
      console.error(`Warning: Local config at ${configPath} is invalid or corrupted`);
      console.error(`  Delete it to start fresh: rm -rf ${getConfigDir(datasetPath)}`);
      return null;
    }

    return parsed;
  } catch (error) {
    // File exists but can't be read/parsed - log warning
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Warning: Could not read local config at ${configPath}`);
    console.error(`  Error: ${message}`);
    return null;
  }
}

/**
 * Write local dataset configuration
 *
 * Creates the .nemar directory if it doesn't exist.
 * Logs warning on failure but does not throw.
 */
export function writeLocalConfig(datasetPath: string, config: LocalDatasetConfig): boolean {
  const configDir = getConfigDir(datasetPath);
  const configPath = getConfigPath(datasetPath);

  try {
    if (!existsSync(configDir)) {
      mkdirSync(configDir, { recursive: true });
    }
    writeFileSync(configPath, JSON.stringify(config, null, 2));
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Warning: Could not save local config to ${configPath}`);
    console.error(`  Error: ${message}`);
    console.error("  Resume capability will not be available for this dataset.");
    return false;
  }
}

/**
 * Update the last upload timestamp
 *
 * Does nothing if no local config exists (logs note).
 */
export function updateLastUpload(datasetPath: string): boolean {
  const config = readLocalConfig(datasetPath);
  if (!config) {
    // Config may not exist if write failed earlier - this is expected
    return false;
  }

  config.last_upload_at = new Date().toISOString();
  return writeLocalConfig(datasetPath, config);
}
