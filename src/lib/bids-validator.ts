/**
 * BIDS Validator Service
 *
 * Wraps the BIDS validator (via Deno subprocess) to validate datasets.
 * Always uses the latest validator from JSR.
 *
 * Requirements:
 * - Deno must be installed (https://deno.com)
 * - Network access for first run (caches validator locally)
 */

import { spawn } from "bun";

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
  /** Any additional pass-through options for the BIDS validator */
  [key: string]: unknown;
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
 * Get BIDS validator version
 */
export async function getValidatorVersion(): Promise<string | null> {
  try {
    const proc = spawn({
      cmd: ["deno", "run", "-ERWN", "jsr:@bids/validator", "--version"],
      stdout: "pipe",
      stderr: "pipe",
    });

    const output = await new Response(proc.stdout).text();
    await proc.exited;

    // Output is like "bids-validator 2.2.7" with ANSI codes
    const match = output.match(/(\d+\.\d+\.\d+)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

/**
 * Validate a BIDS dataset
 *
 * @param datasetPath - Path to the BIDS dataset directory
 * @param options - Validation options
 * @returns Validation result with issues and summary
 */
export async function validateBidsDataset(
  datasetPath: string,
  options: ValidateOptions = {},
): Promise<BidsValidationResult> {
  // Build command arguments
  const args = ["run", "-ERWN", "jsr:@bids/validator", datasetPath, "--json"];

  // Validate that --format flag doesn't conflict with hardcoded --json
  if (options.format && options.format !== "json") {
    throw new Error(
      `Conflicting flags: CLI always uses --json for internal parsing.\nThe --format flag with value "${options.format}" is not compatible.\nTo get pretty JSON output, use: nemar dataset validate --json | jq`,
    );
  }

  // Known options with explicit handling
  const knownOptions = new Set([
    "config",
    "ignoreWarnings",
    "recursive",
    "prune",
    "verbose",
    "format", // Add to known options since we validate it above
  ]);

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

  // Pass through additional options
  // Note: Commander.js normalizes both --max-rows and --maxRows to maxRows in options object
  // We convert to kebab-case (--max-rows) as required by the BIDS validator
  // Unknown flags are passed through and validated by the BIDS validator itself
  const passThroughFlags: string[] = [];

  for (const [key, value] of Object.entries(options)) {
    if (knownOptions.has(key) || value === undefined || value === null) {
      continue;
    }

    passThroughFlags.push(key);
    // Convert camelCase to kebab-case for BIDS validator
    const flagName = key.replace(/([A-Z])/g, "-$1").toLowerCase();

    if (typeof value === "boolean") {
      if (value) {
        args.push(`--${flagName}`);
      } else {
        // Explicitly reject --no-* flags since BIDS validator behavior is undefined
        throw new Error(
          `Boolean flag --no-${flagName} (from option '${key}: false') is not supported.\nThe BIDS validator only accepts positive boolean flags.\nRemove this flag or set ${key} to true.`,
        );
      }
      continue;
    }

    if (Array.isArray(value)) {
      // Validate array is not empty
      if (value.length === 0) {
        throw new Error(
          `Empty array for flag --${flagName}.\nRemove this flag or provide at least one value.`,
        );
      }

      // Validate array items are primitives
      for (const item of value) {
        if (typeof item !== "string" && typeof item !== "number" && typeof item !== "boolean") {
          throw new Error(
            `Invalid value for flag --${flagName}: array contains non-primitive value (${typeof item}).\nArray values must be strings, numbers, or booleans.`,
          );
        }
        args.push(`--${flagName}`, String(item));
      }
      continue;
    }

    args.push(`--${flagName}`, String(value));
  }

  // Log pass-through flags for debugging
  if (passThroughFlags.length > 0 && options.verbose) {
    console.log(`[DEBUG] Pass-through flags: ${passThroughFlags.join(", ")}`);
  }

  // Log full command in verbose mode
  if (options.verbose) {
    console.log(`[DEBUG] Running: deno ${args.join(" ")}`);
  }

  // Run validator with error handling for spawn failures
  let proc: ReturnType<typeof spawn>;
  try {
    proc = spawn({
      cmd: ["deno", ...args],
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (spawnError) {
    const errorMsg = spawnError instanceof Error ? spawnError.message : String(spawnError);

    if (errorMsg.includes("ENOENT")) {
      throw new Error(
        `Cannot execute 'deno' command.\nDeno may have been uninstalled or PATH changed.\nRun: nemar dataset validate --version-info\nOriginal error: ${errorMsg}`,
      );
    }

    if (errorMsg.includes("EACCES")) {
      throw new Error(
        `Permission denied executing Deno.\nCheck that deno binary has execute permissions.\nOriginal error: ${errorMsg}`,
      );
    }

    throw new Error(
      `Failed to spawn BIDS validator process.\nError: ${errorMsg}\nCommand: deno ${args.join(" ")}`,
    );
  }

  const stdout = await new Response(proc.stdout as ReadableStream).text();
  const stderr = await new Response(proc.stderr as ReadableStream).text();
  const exitCode = await proc.exited;

  // Always log stderr if present (warnings, deprecations, etc.)
  if (stderr.trim()) {
    console.error(`[BIDS Validator]: ${stderr.trim()}`);
  }

  // Handle fatal errors (no JSON output produced)
  if (exitCode !== 0 && !stdout.trim()) {
    const errorLine = stderr.includes("error:")
      ? stderr.split("\n").find((l) => l.includes("error:"))
      : null;
    throw new Error(
      `BIDS validation failed with exit code ${exitCode}.\n${errorLine ? `Error: ${errorLine}\n` : ""}${
        passThroughFlags.length > 0
          ? `Note: Using pass-through flags: ${passThroughFlags.join(", ")}\n`
          : ""
      }Run with --verbose for more details.`,
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
  } catch (parseError) {
    throw new Error(
      `Failed to parse BIDS validator output as JSON.\nThis may be caused by incompatible flags or validator errors.\nParse error: ${(parseError as Error).message}\nOutput (first 500 chars): ${stdout.slice(0, 500)}`,
    );
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
