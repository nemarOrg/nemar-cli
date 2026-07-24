/**
 * BIDS Validator Service
 *
 * Wraps the BIDS validator (via Deno subprocess) to validate datasets.
 * The validator version is pinned exactly via `validator-version.json` so the
 * CLI and the per-dataset CI workflow always resolve the same release (see
 * issue #586). The weekly `bump-validator.yml` workflow opens a PR when JSR
 * publishes a newer 2.x release.
 *
 * Requirements:
 * - Deno must be installed (https://deno.com)
 * - Network access for first run or when updating
 */

import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "bun";
import validatorPin from "../../validator-version.json" with { type: "json" };

export const VALIDATOR_VERSION = validatorPin.version;
const VALIDATOR_JSR_SPECIFIER = `${validatorPin.specifier}@${VALIDATOR_VERSION}`;
const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 1 day — pin changes weekly via bump-validator.yml

/**
 * BIDS validation issue from the validator
 */
export interface BidsIssue {
  code: string;
  severity: "error" | "warning";
  location: string;
  rule: string;
  subCode?: string;
  issueMessage?: string;
}

/**
 * BIDS validation summary
 */
export interface BidsSummary {
  sessions: string[];
  subjects: string[];
  tasks: string[];
  modalities: string[];
  totalFiles: number;
  size: number;
  dataProcessed: boolean;
  schemaVersion: string;
}

/**
 * BIDS validation result
 */
export interface BidsValidationResult {
  valid: boolean;
  issues: BidsIssue[];
  codeMessages: Record<string, string>;
  summary: BidsSummary;
  errorCount: number;
  warningCount: number;
}

/**
 * Validation options
 */
export interface ValidateOptions {
  /** Path to config file for ignoring/promoting issues */
  config?: string;
  /** Ignore warnings, only report errors */
  ignoreWarnings?: boolean;
  /** Validate derivatives subdirectories recursively */
  recursive?: boolean;
  /** Skip sourcedata and derivatives to speed up validation */
  prune?: boolean;
  /** Verbose output */
  verbose?: boolean;
}

/**
 * Check if Deno is installed
 */
export async function checkDenoInstalled(): Promise<{ installed: boolean; version?: string }> {
  try {
    const proc = spawn({
      cmd: ["deno", "--version"],
      stdout: "pipe",
      stderr: "pipe",
    });

    const output = await new Response(proc.stdout).text();
    await proc.exited;

    const match = output.match(/deno\s+(\d+\.\d+\.\d+)/);
    return {
      installed: true,
      version: match ? match[1] : undefined,
    };
  } catch {
    return { installed: false };
  }
}

/**
 * Check if the Deno cache for the BIDS validator is stale.
 * Uses the modification time of the Deno cache directory as a heuristic.
 * Returns true if cache is older than STALE_THRESHOLD_MS or doesn't exist.
 */
export function isValidatorCacheStale(): boolean {
  try {
    // Deno stores JSR deps in DENO_DIR or ~/.cache/deno (Linux) / ~/Library/Caches/deno (macOS)
    const platform = process.platform;
    const denoDir =
      process.env.DENO_DIR ||
      (platform === "darwin"
        ? join(homedir(), "Library", "Caches", "deno")
        : platform === "win32"
          ? join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "deno")
          : join(homedir(), ".cache", "deno"));

    const registryDir = join(denoDir, "deps");
    if (!existsSync(registryDir)) return true;

    const stats = statSync(registryDir);
    const ageMs = Date.now() - stats.mtimeMs;
    return ageMs > STALE_THRESHOLD_MS;
  } catch {
    return true;
  }
}

/**
 * Force-refresh the BIDS validator cache by running with --reload.
 * Returns the new version string, or null on failure.
 */
export async function updateValidatorCache(): Promise<string | null> {
  try {
    const proc = spawn({
      cmd: [
        "deno",
        "run",
        `--reload=${VALIDATOR_JSR_SPECIFIER}`,
        "-ERWN",
        VALIDATOR_JSR_SPECIFIER,
        "--version",
      ],
      stdout: "pipe",
      stderr: "pipe",
    });

    const output = await new Response(proc.stdout).text();
    await proc.exited;

    const match = output.match(/(\d+\.\d+\.\d+)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

/**
 * Get BIDS validator version from the current cache (does not refresh).
 */
export async function getValidatorVersion(): Promise<string | null> {
  try {
    const proc = spawn({
      cmd: [
        "deno",
        "run",
        "--node-modules-dir=none",
        "-ERWN",
        VALIDATOR_JSR_SPECIFIER,
        "--version",
      ],
      stdout: "pipe",
      stderr: "pipe",
    });

    const output = await new Response(proc.stdout).text();
    await proc.exited;

    const match = output.match(/(\d+\.\d+\.\d+)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

/**
 * Build the deno + bids-validator argument list from common options.
 * When forceReload is true, adds --reload to fetch the latest validator from JSR.
 */
function buildValidatorArgs(
  datasetPath: string,
  options: ValidateOptions & { json?: boolean; extraArgs?: string[]; forceReload?: boolean } = {},
): string[] {
  // --node-modules-dir=none forces Deno to resolve the validator's npm
  // dependency (npm:hash-wasm, used during hashing) from its own global cache
  // rather than an ambient project node_modules. Without it, running from a
  // directory that HAS a node_modules but lacks hash-wasm (e.g. nemar-cli's own
  // tree, or any Node project a user validates from) makes Deno switch to local
  // node_modules resolution and crash with "Could not find a matching package
  // for 'npm:hash-wasm'" -- validation fails with empty output (#1010).
  const args = ["run", "--node-modules-dir=none"];
  if (options.forceReload) {
    args.push(`--reload=${VALIDATOR_JSR_SPECIFIER}`);
  }
  args.push("-ERWN", VALIDATOR_JSR_SPECIFIER, datasetPath);

  if (options.json) {
    args.push("--json");
  }
  if (options.config) {
    args.push("--config", options.config);
  }
  if (options.ignoreWarnings) {
    args.push("--ignoreWarnings");
  }
  if (options.recursive) {
    args.push("--recursive");
  }
  if (options.prune) {
    args.push("--prune");
  }
  if (options.verbose) {
    args.push("--verbose");
  }
  if (options.extraArgs?.length) {
    args.push(...options.extraArgs);
  }

  return args;
}

/**
 * Validate a BIDS dataset (JSON mode, for programmatic use by upload command).
 *
 * @param datasetPath - Path to the BIDS dataset directory
 * @param options - Validation options
 * @returns Validation result with issues and summary
 */
export async function validateBidsDataset(
  datasetPath: string,
  options: ValidateOptions & { forceReload?: boolean } = {},
): Promise<BidsValidationResult> {
  const args = buildValidatorArgs(datasetPath, { ...options, json: true });

  const proc = spawn({
    cmd: ["deno", ...args],
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  // Handle errors
  if (exitCode !== 0 && !stdout.trim()) {
    throw new Error(
      stderr.includes("error:")
        ? stderr.split("\n").find((l) => l.includes("error:")) || "Validation failed"
        : `Validation failed with exit code ${exitCode}`,
    );
  }

  // Parse JSON output
  let result: {
    issues: {
      issues: BidsIssue[];
      codeMessages: Record<string, string>;
    };
    summary: BidsSummary;
  };

  try {
    result = JSON.parse(stdout);
  } catch {
    throw new Error(`Failed to parse validator output: ${stdout.slice(0, 200)}`);
  }

  const issues = result.issues.issues || [];
  const errorCount = issues.filter((i) => i.severity === "error").length;
  const warningCount = issues.filter((i) => i.severity === "warning").length;

  return {
    valid: errorCount === 0,
    issues,
    codeMessages: result.issues.codeMessages || {},
    summary: result.summary,
    errorCount,
    warningCount,
  };
}

/**
 * Run the BIDS validator directly, returning raw stdout/stderr and exit code.
 * Used by the validate command for native text output passthrough.
 */
export async function runBidsValidatorDirect(
  datasetPath: string,
  options: ValidateOptions & { json?: boolean; extraArgs?: string[]; forceReload?: boolean } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const args = buildValidatorArgs(datasetPath, options);

  const proc = spawn({
    cmd: ["deno", ...args],
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  return { stdout, stderr, exitCode };
}

/**
 * Format validation result for console output
 */
export function formatValidationResult(result: BidsValidationResult, color = true): string {
  const lines: string[] = [];

  // Group issues by severity
  const errors = result.issues.filter((i) => i.severity === "error");
  const warnings = result.issues.filter((i) => i.severity === "warning");

  // Header
  if (result.valid) {
    lines.push(color ? "\x1b[32m✓ Dataset is valid BIDS\x1b[0m" : "✓ Dataset is valid BIDS");
  } else {
    lines.push(
      color ? "\x1b[31m✗ Dataset has validation errors\x1b[0m" : "✗ Dataset has validation errors",
    );
  }
  lines.push("");

  // Errors
  if (errors.length > 0) {
    lines.push(color ? "\x1b[31mErrors:\x1b[0m" : "Errors:");
    for (const issue of errors) {
      const code = color ? `\x1b[31m${issue.code}\x1b[0m` : issue.code;
      const msg = result.codeMessages[issue.code]?.split("\n")[0] || "";
      lines.push(`  ${code}: ${msg}`);
      lines.push(`    ${issue.location}`);
      if (issue.issueMessage) {
        lines.push(`    ${issue.issueMessage.split("\n")[0]}`);
      }
    }
    lines.push("");
  }

  // Warnings
  if (warnings.length > 0) {
    lines.push(color ? "\x1b[33mWarnings:\x1b[0m" : "Warnings:");
    for (const issue of warnings) {
      const code = color ? `\x1b[33m${issue.code}\x1b[0m` : issue.code;
      const msg = result.codeMessages[issue.code]?.split("\n")[0] || "";
      lines.push(`  ${code}: ${msg}`);
      lines.push(`    ${issue.location}`);
    }
    lines.push("");
  }

  // Summary
  lines.push("Summary:");
  lines.push(`  Files: ${result.summary.totalFiles}`);
  lines.push(`  Size: ${formatBytes(result.summary.size)}`);
  if (result.summary.subjects.length > 0) {
    lines.push(`  Subjects: ${result.summary.subjects.length}`);
  }
  if (result.summary.sessions.length > 0) {
    lines.push(`  Sessions: ${result.summary.sessions.length}`);
  }
  if (result.summary.tasks.length > 0) {
    lines.push(`  Tasks: ${result.summary.tasks.join(", ")}`);
  }
  if (result.summary.modalities.length > 0) {
    lines.push(`  Modalities: ${result.summary.modalities.join(", ")}`);
  }
  lines.push(`  Schema: BIDS ${result.summary.schemaVersion}`);
  lines.push("");

  // Final count
  const errStr = result.errorCount === 1 ? "error" : "errors";
  const warnStr = result.warningCount === 1 ? "warning" : "warnings";
  lines.push(`${result.errorCount} ${errStr}, ${result.warningCount} ${warnStr}`);

  return lines.join("\n");
}

/**
 * Format bytes to human readable string
 */
function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${Number.parseFloat((bytes / k ** i).toFixed(2))} ${sizes[i]}`;
}
