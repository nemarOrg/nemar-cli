/**
 * CLI update check
 *
 * Checks the npm registry for a newer version of nemar-cli and displays
 * a banner after command output.
 *
 * Strategy:
 * - If cache exists and is fresh (<24h): use cached result (sync, no delay)
 * - If cache exists but is stale: use cached result, refresh in background
 * - If no cache exists (cold start): do a blocking fetch (up to 5s) so the
 *   user sees the update notice on their very first run
 *
 * Disable with NEMAR_NO_UPDATE_CHECK=1.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import chalk from "chalk";
import { compareVersions } from "./semver.js";
import { version as currentVersion } from "./version.js";

const CONFIG_DIR = process.env.NEMAR_CONFIG_DIR || join(homedir(), ".config", "nemar");
const CACHE_FILE = join(CONFIG_DIR, "update-check.json");
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const NPM_URL = "https://registry.npmjs.org/nemar-cli/latest";
const FETCH_TIMEOUT_MS = 5000;

interface UpdateCache {
  checkedAt: number;
  latestVersion: string;
}

/**
 * Strip pre-release suffix (e.g. "0.7.17-dev" -> "0.7.17")
 * so compareVersions() can parse it as stable semver.
 */
function normalizeVersion(v: string): string {
  return v.replace(/-.*$/, "");
}

function readCache(): UpdateCache | null {
  try {
    if (!existsSync(CACHE_FILE)) return null;
    const raw = readFileSync(CACHE_FILE, "utf-8");
    const data = JSON.parse(raw) as UpdateCache;
    if (typeof data.checkedAt !== "number" || typeof data.latestVersion !== "string") return null;
    return data;
  } catch (err) {
    if (process.env.VERBOSE) {
      process.stderr.write(
        `[update-check] Cache read failed: ${err instanceof Error ? err.message : err}\n`,
      );
    }
    return null;
  }
}

function writeCache(latestVersion: string): void {
  try {
    mkdirSync(CONFIG_DIR, { recursive: true });
    const cache: UpdateCache = { checkedAt: Date.now(), latestVersion };
    writeFileSync(CACHE_FILE, JSON.stringify(cache));
  } catch {
    // Non-critical; cache will be retried next run
  }
}

async function fetchLatestVersion(): Promise<string | null> {
  try {
    const response = await fetch(NPM_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    const data = (await response.json()) as { version?: string };
    return data.version ?? null;
  } catch (err) {
    if (process.env.VERBOSE) {
      process.stderr.write(
        `[update-check] Fetch failed: ${err instanceof Error ? err.message : err}\n`,
      );
    }
    return null;
  }
}

function refreshCacheInBackground(): void {
  fetchLatestVersion().then((version) => {
    if (version) writeCache(version);
  });
}

function checkUpdate(latestVersion: string): string | null {
  try {
    const normalized = normalizeVersion(currentVersion);
    if (compareVersions(latestVersion, normalized) > 0) {
      return latestVersion;
    }
  } catch {
    // Invalid version format; skip
  }
  return null;
}

function detectInstallMethod(): "bunx" | "bun" {
  const argv1 = process.argv[1] || "";
  if (argv1.includes("bunx") || argv1.includes(".cache/bun")) return "bunx";
  return "bun";
}

/**
 * Initialize the update check. Returns the latest version if an update is
 * available, or null. On cold start (no cache), does a blocking fetch so
 * the user sees the notice on their first run.
 */
export async function initUpdateCheck(): Promise<string | null> {
  if (process.env.NEMAR_NO_UPDATE_CHECK === "1") return null;

  const cache = readCache();

  if (cache) {
    const isFresh = Date.now() - cache.checkedAt < CACHE_TTL_MS;
    if (!isFresh) {
      refreshCacheInBackground();
    }
    return checkUpdate(cache.latestVersion);
  }

  // Cold start: no cache exists. Do a blocking fetch so the user sees
  // the update notice on their very first run.
  const latestVersion = await fetchLatestVersion();
  if (latestVersion) {
    writeCache(latestVersion);
    return checkUpdate(latestVersion);
  }

  return null;
}

let bannerPrinted = false;

/**
 * Print update available banner to stderr (keeps stdout clean for piping).
 * Idempotent; only prints once per process.
 */
export function printUpdateBanner(latestVersion: string): void {
  if (bannerPrinted) return;
  bannerPrinted = true;

  const method = detectInstallMethod();
  const cmd = method === "bunx" ? "bunx nemar-cli@latest" : "bun update -g nemar-cli";
  const border = chalk.yellow("\u2500".repeat(50));
  const lines = [
    "",
    border,
    `${chalk.yellow("  Update available: ")}${chalk.dim(currentVersion)} -> ${chalk.green(latestVersion)}`,
    `${chalk.yellow("  Run: ")}${chalk.cyan(cmd)}`,
    border,
    "",
  ].join("\n");
  process.stderr.write(lines);
}
