/**
 * CLI update check
 *
 * Checks the npm registry for a newer version of nemar-cli and displays
 * a banner after command output. Uses a check-on-next-run pattern:
 * reads cached result synchronously, fires background fetch if stale.
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

function refreshCacheInBackground(): void {
  fetch(NPM_URL, { signal: AbortSignal.timeout(3000) })
    .then((r) => r.json())
    .then((data: unknown) => {
      const { version } = data as { version: string };
      if (!version) return;
      mkdirSync(CONFIG_DIR, { recursive: true });
      const cache: UpdateCache = { checkedAt: Date.now(), latestVersion: version };
      writeFileSync(CACHE_FILE, JSON.stringify(cache));
    })
    .catch((err) => {
      if (process.env.VERBOSE) {
        process.stderr.write(
          `[update-check] Refresh failed: ${err instanceof Error ? err.message : err}\n`,
        );
      }
    });
}

function detectInstallMethod(): "bunx" | "bun" {
  const argv1 = process.argv[1] || "";
  if (argv1.includes("bunx") || argv1.includes(".cache/bun")) return "bunx";
  return "bun";
}

/**
 * Read update cache synchronously and kick off background refresh if stale.
 * Returns the latest version string if an update is available, null otherwise.
 */
export function initUpdateCheck(): string | null {
  if (process.env.NEMAR_NO_UPDATE_CHECK === "1") return null;

  const cache = readCache();
  const isFresh = cache && Date.now() - cache.checkedAt < CACHE_TTL_MS;

  if (!isFresh) {
    refreshCacheInBackground();
  }

  if (!cache) return null;

  try {
    const normalized = normalizeVersion(currentVersion);
    if (compareVersions(cache.latestVersion, normalized) > 0) {
      return cache.latestVersion;
    }
  } catch {
    // Invalid version format; skip
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
