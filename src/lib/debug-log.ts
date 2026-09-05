/**
 * `--debug` / `NEMAR_DEBUG=1` diagnostic bundle (issue #1256, epic #1250 phase 6).
 *
 * Motivated by #1249: a user's upload failed at "Creating dataset in NEMAR"
 * and it took three emails and three screenshots to learn the CLI version
 * and the failing step. This module lets a user hand over one file instead.
 *
 * Design constraints that shaped this:
 * - `src/lib/api/client.ts`'s `request()` is the ONLY place every HTTP call
 *   goes through, so it is the one place HTTP entries are recorded. Nothing
 *   here talks to the network itself.
 * - The debug log must never contain a credential. Headers and bodies are
 *   redacted at record time (before they are ever held in memory here), not
 *   at write time, so there is no path that skips it.
 * - Environment info (tool versions in particular) requires spawning
 *   subprocesses, which is async. `process.on("exit", ...)` callbacks in
 *   Node/Bun MUST be synchronous, and any of ~270 call sites across the CLI
 *   can call `process.exit()` at any point. So the environment snapshot is
 *   captured once, eagerly, at startup (`primeEnvironmentSnapshot`), cached
 *   as a plain string, and the actual file write at exit is 100% synchronous
 *   (`writeDebugLogSync`).
 */

import { mkdirSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getConfig, getConfigDir } from "./config.js";
import { checkAllTools } from "./prerequisites.js";
import { version } from "./version.js";

/** Keep only the N most recent debug logs (issue #1256). */
export const MAX_DEBUG_LOGS = 10;

/** Truncate a logged HTTP body to this many bytes. */
export const MAX_BODY_BYTES = 2048;

let debugEnabled = false;
let usageExit = false;
let lastStep: string | undefined;
let cachedEnvironmentSection: string | undefined;
const httpEntries: HttpLogEntry[] = [];

export function enableDebug(): void {
  debugEnabled = true;
}

export function isDebugEnabled(): boolean {
  return debugEnabled;
}

/** Whether `--debug` or `NEMAR_DEBUG=1` requests debug mode for this run. */
export function shouldEnableDebug(argv: string[], env: NodeJS.ProcessEnv = process.env): boolean {
  return argv.includes("--debug") || env.NEMAR_DEBUG === "1";
}

/**
 * Mark the current step (e.g. a spinner's label right before it failed).
 * Wired into `printStepFailure` (lib/cli-output.ts), which already centralizes
 * most step-failure reporting across the CLI -- see that file's docstring.
 * Cheap enough to call unconditionally; it is a no-op string assignment
 * when debug mode is off.
 */
export function recordStep(label: string): void {
  lastStep = label;
  dlog(`Step: ${label}`);
}

/** Marks that the process is exiting through Commander's own `_exit` (help,
 * `--version`, or a usage/validation error) rather than a command's own
 * `process.exit()` call. See `markCommanderExitsRecursively` in src/index.ts. */
export function markUsageExit(): void {
  usageExit = true;
}

export function wasUsageExit(): boolean {
  return usageExit;
}

/** Print to stderr only when debug mode is on (mirrors lib/verbose.ts). */
export function dlog(message: string): void {
  if (debugEnabled) {
    process.stderr.write(`[debug] ${message}\n`);
  }
}

// ============================================================================
// Redaction
// ============================================================================

const REDACT_HEADER_NAMES = new Set(["authorization", "cookie", "set-cookie", "x-api-key"]);

/** Redact sensitive header values. Exported for direct unit testing. */
export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key] = REDACT_HEADER_NAMES.has(key.toLowerCase()) ? "[REDACTED]" : value;
  }
  return out;
}

/** JSON body keys whose values are always secrets, regardless of content. */
const SENSITIVE_BODY_KEY_RE =
  /^(api[_-]?key|apikey|password|token|secret|access[_-]?key(_id)?|secret[_-]?access[_-]?key|session[_-]?token|authorization|ssh[_-]?key|private[_-]?key)$/i;

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

/** Mask an email as `f***@domain.tld` (same shape as backend redactRecipient). */
export function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at <= 0) return "***";
  return `${email[0]}***${email.slice(at)}`;
}

function redactJsonValue(key: string, value: unknown): unknown {
  if (Array.isArray(value)) return value.map((v) => redactJsonValue(key, v));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactJsonValue(k, v);
    }
    return out;
  }
  if (typeof value === "string") {
    if (SENSITIVE_BODY_KEY_RE.test(key)) return "[REDACTED]";
    return value.replace(EMAIL_RE, maskEmail);
  }
  return value;
}

const BEARER_RE = /Bearer\s+[A-Za-z0-9\-._~+/=]+/gi;
// AWS access key IDs have a fixed, recognizable shape (AKIA/ASIA + 16 chars).
const AWS_ACCESS_KEY_RE = /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g;
// Secret access keys don't have a distinct shape, so match them by the
// field name that carries one (JSON, form, or query-string style).
const AWS_SECRET_ASSIGN_RE =
  /((?:aws_)?secret_access_key["']?\s*[:=]\s*["']?)[A-Za-z0-9/+=]{20,}/gi;

/** Regex-only secret scrubbing, usable on JSON or arbitrary text. */
function scrubSecretPatterns(text: string): string {
  return text
    .replace(BEARER_RE, "Bearer [REDACTED]")
    .replace(AWS_ACCESS_KEY_RE, "[REDACTED_AWS_KEY]")
    .replace(AWS_SECRET_ASSIGN_RE, "$1[REDACTED]")
    .replace(EMAIL_RE, maskEmail);
}

/**
 * Redact a request/response body: API keys, Bearer tokens, AWS keys/secrets,
 * and email addresses are masked; the result is truncated to `maxBytes`.
 * Exported for direct unit testing.
 */
export function redactBody(raw: string | undefined, maxBytes = MAX_BODY_BYTES): string | undefined {
  if (raw === undefined) return undefined;
  let result = raw;
  try {
    const parsed = JSON.parse(raw);
    result = JSON.stringify(redactJsonValue("", parsed));
  } catch {
    // Not JSON (form data, plain text, empty body) -- fall through to the
    // regex-only pass below.
  }
  result = scrubSecretPatterns(result);
  if (Buffer.byteLength(result, "utf8") > maxBytes) {
    const truncated = Buffer.from(result, "utf8").subarray(0, maxBytes).toString("utf8");
    result = `${truncated}... [truncated]`;
  }
  return result;
}

// ============================================================================
// HTTP request/response log
// ============================================================================

export interface HttpLogEntryInput {
  method: string;
  url: string;
  /** null when the request never got a response (network error). */
  status: number | null;
  durationMs: number;
  requestHeaders: Record<string, string>;
  requestBody?: string;
  responseBody?: string;
  error?: string;
}

/** Same shape as the input; kept as a distinct alias for readability at call sites. */
export type HttpLogEntry = HttpLogEntryInput;

/**
 * Record one HTTP exchange made through `lib/api/client.ts`'s `request()`.
 * Redaction happens here, at record time, so a plaintext secret is never
 * held anywhere in this module's state.
 */
export function recordHttpExchange(entry: HttpLogEntryInput): void {
  if (!debugEnabled) return;
  const redacted: HttpLogEntry = {
    ...entry,
    requestHeaders: redactHeaders(entry.requestHeaders),
    requestBody: redactBody(entry.requestBody),
    responseBody: redactBody(entry.responseBody),
  };
  httpEntries.push(redacted);
  dlog(`${entry.method} ${entry.url} -> ${entry.status ?? "ERROR"} (${entry.durationMs}ms)`);
}

/** Read-only snapshot of recorded HTTP entries. For tests. */
export function getRecordedHttpEntries(): readonly HttpLogEntry[] {
  return httpEntries;
}

// ============================================================================
// Environment section (shared by the debug log and `nemar doctor --report`)
// ============================================================================

/**
 * Fields from the active account worth showing in a bug report. Deliberately
 * short: NEVER apiKey, and only fields the local config actually has today.
 * `role` is populated at login/`auth status --refresh` (see commands/auth.ts).
 * A future account-tiers field (upload access / tier) belongs here once it
 * exists in `Config` -- there is nothing to report yet on this branch.
 */
async function buildEnvironmentLines(): Promise<string[]> {
  const lines: string[] = [];
  const runtime = process.versions.bun ? `Bun ${process.versions.bun}` : `Node ${process.version}`;
  lines.push(`CLI version: ${version}`);
  lines.push(`OS/Arch: ${process.platform}/${process.arch}`);
  lines.push(`Runtime: ${runtime}`);
  lines.push("");
  lines.push("Active account:");
  const cfg = getConfig();
  if (cfg.apiKey) {
    if (cfg.username) lines.push(`  Username: ${cfg.username}`);
    lines.push(`  API URL: ${cfg.apiUrl}`);
    if (cfg.role) lines.push(`  Role: ${cfg.role}`);
    lines.push(`  Sandbox completed: ${!!cfg.sandboxCompleted}`);
  } else {
    lines.push("  (not authenticated)");
  }
  lines.push("");
  lines.push("External tools:");
  const tools = await checkAllTools();
  for (const tool of tools) {
    lines.push(
      `  ${tool.name}: ${tool.available ? (tool.version ?? "installed") : "not installed"}`,
    );
  }
  return lines;
}

/**
 * The environment section of the diagnostic bundle: CLI/OS/Bun version,
 * active account (no credential), and external tool versions. No HTTP
 * trace -- this is what `nemar doctor --report` prints standalone, and what
 * the debug log embeds verbatim.
 */
export async function getEnvironmentReport(): Promise<string> {
  return (await buildEnvironmentLines()).join("\n");
}

/**
 * Capture the environment section once, up front, so the synchronous exit
 * handler never has to await anything. No-op when debug mode is off.
 */
export async function primeEnvironmentSnapshot(): Promise<void> {
  if (!debugEnabled || cachedEnvironmentSection !== undefined) return;
  cachedEnvironmentSection = await getEnvironmentReport();
}

// ============================================================================
// Command line (for the log filename and the "Command:" line)
// ============================================================================

/** Flags immediately followed by a secret value on the command line. */
const SECRET_FLAGS = new Set(["-k", "--key", "--password", "--api-key"]);

/** Redact secret-bearing flags/values before a command line is ever logged. */
export function redactArgv(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    out.push(argv[i]);
    if (SECRET_FLAGS.has(argv[i]) && i + 1 < argv.length) {
      out.push("[REDACTED]");
      i++;
    }
  }
  return out;
}

/**
 * A filesystem-safe label for the log filename: up to the first two
 * non-flag tokens (e.g. `dataset upload ./my-dataset` -> "dataset-upload"),
 * capped at two so a positional argument (dataset path, username, ...)
 * never ends up in the filename.
 */
export function buildCommandLabel(argv: string[]): string {
  const parts: string[] = [];
  for (const token of argv) {
    if (token.startsWith("-")) continue;
    parts.push(token);
    if (parts.length === 2) break;
  }
  const label = parts.length > 0 ? parts.join("-") : "nemar";
  return label.replace(/[^a-zA-Z0-9_-]/g, "_");
}

// ============================================================================
// Writing the log file
// ============================================================================

function buildLogContent(argv: string[], exitCode: number): string {
  const lines: string[] = [];
  lines.push("NEMAR CLI Debug Log");
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Command: nemar ${scrubSecretPatterns(redactArgv(argv).join(" "))}`);
  lines.push("");
  lines.push(cachedEnvironmentSection ?? "(environment snapshot unavailable)");
  lines.push("");
  lines.push("HTTP requests:");
  if (httpEntries.length === 0) {
    lines.push("  (none)");
  } else {
    httpEntries.forEach((entry, index) => {
      lines.push(
        `  [${index + 1}] ${entry.method} ${entry.url} -> ${entry.status ?? "ERROR"} (${entry.durationMs}ms)`,
      );
      if (entry.error) lines.push(`      Error: ${entry.error}`);
      lines.push(`      Request headers: ${JSON.stringify(entry.requestHeaders)}`);
      if (entry.requestBody) lines.push(`      Request body: ${entry.requestBody}`);
      if (entry.responseBody) lines.push(`      Response body: ${entry.responseBody}`);
    });
  }
  lines.push("");
  lines.push(`Failing step: ${lastStep ?? "(none recorded)"}`);
  lines.push(`Exit code: ${exitCode}`);
  return `${lines.join("\n")}\n`;
}

/** Remove all but the `keep` most recent `nemar-*.log` files in `dir`. Names
 * are ISO-timestamp-prefixed, so lexicographic sort is chronological.
 * Exported for direct unit testing of the rotation policy. */
export function pruneLogsDir(dir: string, keep: number): void {
  let entries: string[];
  try {
    entries = readdirSync(dir).filter((name) => name.startsWith("nemar-") && name.endsWith(".log"));
  } catch {
    return;
  }
  entries.sort();
  const excess = entries.length - keep;
  for (let i = 0; i < excess; i++) {
    try {
      unlinkSync(join(dir, entries[i]));
    } catch {
      // Best effort: a log another process already removed isn't an error.
    }
  }
}

/**
 * Write the debug log for this run and prune to the 10 most recent. Fully
 * synchronous so it can run from a `process.on("exit", ...)` handler, which
 * cannot await anything. No-op (returns null) when debug mode is off, or if
 * the log directory can't be written to.
 */
export function writeDebugLogSync(argv: string[], exitCode: number): string | null {
  if (!debugEnabled) return null;
  const dir = join(getConfigDir(), "logs");
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    return null;
  }
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const fileName = `nemar-${timestamp}-${buildCommandLabel(argv)}.log`;
  const filePath = join(dir, fileName);
  try {
    writeFileSync(filePath, buildLogContent(argv, exitCode), "utf8");
  } catch {
    return null;
  }
  pruneLogsDir(dir, MAX_DEBUG_LOGS);
  return filePath;
}

/** Reset all module state. Test-only. */
export function resetDebugStateForTesting(): void {
  debugEnabled = false;
  usageExit = false;
  lastStep = undefined;
  cachedEnvironmentSection = undefined;
  httpEntries.length = 0;
}
