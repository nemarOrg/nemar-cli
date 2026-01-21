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
 * Read local dataset configuration
 */
export function readLocalConfig(datasetPath: string): LocalDatasetConfig | null {
  const configPath = getConfigPath(datasetPath);
  if (!existsSync(configPath)) {
    return null;
  }

  try {
    const content = readFileSync(configPath, "utf-8");
    return JSON.parse(content) as LocalDatasetConfig;
  } catch {
    return null;
  }
}

/**
 * Write local dataset configuration
 */
export function writeLocalConfig(datasetPath: string, config: LocalDatasetConfig): void {
  const configDir = getConfigDir(datasetPath);
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
  }

  const configPath = getConfigPath(datasetPath);
  writeFileSync(configPath, JSON.stringify(config, null, 2));
}

/**
 * Update the last upload timestamp
 */
export function updateLastUpload(datasetPath: string): void {
  const config = readLocalConfig(datasetPath);
  if (config) {
    config.last_upload_at = new Date().toISOString();
    writeLocalConfig(datasetPath, config);
  }
}

/**
 * Get the dataset ID from local config
 */
export function getLocalDatasetId(datasetPath: string): string | null {
  const config = readLocalConfig(datasetPath);
  return config?.dataset_id ?? null;
}
