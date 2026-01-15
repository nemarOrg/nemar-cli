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
  options: ValidateOptions = {}
): Promise<BidsValidationResult> {
  // Build command arguments
  const args = ["run", "-ERWN", "jsr:@bids/validator", datasetPath, "--json"];

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

  // Run validator
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
    // Real error (not just validation failures)
    throw new Error(
      stderr.includes("error:")
        ? stderr.split("\n").find((l) => l.includes("error:")) || "Validation failed"
        : `Validation failed with exit code ${exitCode}`
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
    lines.push(color ? "\x1b[31m✗ Dataset has validation errors\x1b[0m" : "✗ Dataset has validation errors");
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
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}
