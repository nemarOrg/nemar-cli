/**
 * Prerequisite checks per CLI command + a full environment ("doctor") check.
 *
 * NEMAR relies on external tools (git, git-annex, gh, aws, deno) that aren't
 * bundled with the CLI. This module detects them, reports versions, and gives
 * platform-specific install guidance (macOS, Linux, AND Windows) so users —
 * especially on Windows, where these tools are hardest to get — find out what's
 * missing early (at `nemar doctor`, install time, and signup) instead of failing
 * mid-upload.
 */

import { runCommand } from "./git-annex/run-command.js";

export type NemarCommand =
  | "upload"
  | "download"
  | "clone"
  | "push"
  | "publish"
  | "update"
  | "release";

interface ToolCheck {
  name: string;
  /** What the tool is needed for (shown by `nemar doctor`). */
  purpose: string;
  /** Command and args to test installation, e.g. ["git-annex", "version"] */
  cmd: string[];
  /** Required for the core upload/validate/download workflow. */
  required: boolean;
  installInstructions: {
    macos: string;
    linux: string;
    windows: string;
  };
}

const TOOL_CHECKS: Record<string, ToolCheck> = {
  git: {
    name: "git",
    purpose: "version control for dataset metadata",
    cmd: ["git", "--version"],
    required: true,
    installInstructions: {
      macos: "brew install git  (or install Xcode Command Line Tools)",
      linux: "sudo apt-get install git  OR  sudo dnf install git",
      windows: "winget install Git.Git  (or https://git-scm.com/download/win)",
    },
  },
  "git-annex": {
    name: "git-annex",
    purpose: "large-file data transfer (upload/download)",
    cmd: ["git-annex", "version"],
    required: true,
    installInstructions: {
      macos: "brew install git-annex",
      linux: "sudo apt-get install git-annex  OR  sudo dnf install git-annex",
      windows: "Download the installer from https://git-annex.branchable.com/install/Windows/",
    },
  },
  gh: {
    name: "GitHub CLI (gh)",
    purpose: "GitHub authentication + repository operations",
    cmd: ["gh", "--version"],
    required: true,
    installInstructions: {
      macos: "brew install gh",
      linux: "See https://cli.github.com/manual/installation",
      windows: "winget install GitHub.cli  (or: scoop install gh)",
    },
  },
  aws: {
    name: "AWS CLI",
    purpose: "S3 data upload/download",
    cmd: ["aws", "--version"],
    required: true,
    installInstructions: {
      macos: "brew install awscli",
      linux: "pip install awscli  OR  sudo snap install aws-cli --classic",
      windows: "winget install Amazon.AWSCLI  (or the MSI from https://aws.amazon.com/cli/)",
    },
  },
  deno: {
    name: "Deno",
    purpose: "BIDS validation",
    cmd: ["deno", "--version"],
    required: true,
    installInstructions: {
      macos: "brew install deno  (or: curl -fsSL https://deno.land/install.sh | sh)",
      linux: "curl -fsSL https://deno.land/install.sh | sh",
      windows: "winget install DenoLand.Deno  (or: irm https://deno.land/install.ps1 | iex)",
    },
  },
};

/**
 * Required tools per command. `deno` is included for `upload` (it drives BIDS
 * validation) so the pre-flight prerequisite check is consistent with deno's
 * `required: true` in TOOL_CHECKS; the upload path also checks it inline via
 * checkDenoInstalled() for a validation-specific message.
 */
const COMMAND_TOOLS: Record<NemarCommand, string[]> = {
  upload: ["git-annex", "gh", "aws", "deno"],
  download: ["gh"],
  clone: ["git", "gh"],
  push: ["git-annex", "gh"],
  publish: ["gh", "aws"],
  update: ["git", "gh"],
  release: ["git", "gh"],
};

export type Platform = "macos" | "linux" | "windows";

/** Map process.platform to our instruction keys. */
export function currentPlatform(): Platform {
  if (process.platform === "darwin") return "macos";
  if (process.platform === "win32") return "windows";
  return "linux";
}

/** Platform-specific install instruction for a tool. Exported for testing. */
export function getInstallInstruction(
  tool: Pick<ToolCheck, "installInstructions">,
  platform: Platform = currentPlatform(),
): string {
  return tool.installInstructions[platform];
}

/**
 * Best-effort version extraction from a `--version` style output.
 *
 * KEEP, not a semver conversion (epic #1225 phase 6 audit): the result is
 * only ever displayed by `nemar doctor` (ToolStatus.version, printed as-is
 * in src/commands/doctor.ts), never parsed further or compared against
 * anything. Converting to `semver.coerce()` would normalize a two-component
 * version like "1.40" to "1.40.0" and change what `nemar doctor` prints, for
 * no comparison it would ever feed. Verified: no caller of `checkAllTools()`,
 * `probeTool()`, or `ToolStatus.version` does anything but display it.
 */
export function parseVersion(output: string): string | undefined {
  const match = output.match(/(\d+\.\d+(?:\.\d+)?)/);
  return match ? match[1] : undefined;
}

/**
 * Cap on a single `--version` probe. Review finding (#1257): before this,
 * `checkAllTools()` had no timeout and now runs before every `--debug`
 * command (see `primeEnvironmentSnapshot` in lib/debug-log.ts) as well as
 * `nemar doctor` itself, so a hung `aws --version` (a wedged credential
 * helper, a broken PATH shim) hung the whole CLI rather than just failing
 * one command's prerequisite check.
 */
const PROBE_TIMEOUT_MS = 4000;

async function probeTool(
  toolCheck: ToolCheck,
): Promise<{ available: boolean; version?: string; timedOut?: boolean }> {
  try {
    const { exitCode, stdout, timedOut } = await runCommand(toolCheck.cmd, {
      timeout: PROBE_TIMEOUT_MS,
    });
    if (timedOut) return { available: false, timedOut: true };
    if (exitCode !== 0) return { available: false };
    return { available: true, version: parseVersion(stdout) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("ENOENT") && !msg.includes("not found")) {
      console.error(`  Warning: ${toolCheck.name} check failed unexpectedly: ${msg}`);
    }
    return { available: false };
  }
}

export interface ToolStatus {
  key: string;
  name: string;
  purpose: string;
  required: boolean;
  available: boolean;
  version?: string;
  /** The probe hit PROBE_TIMEOUT_MS rather than confirming absence. */
  timedOut?: boolean;
  installInstruction: string;
}

/**
 * Probe every known external tool in parallel. Used by `nemar doctor`, the
 * install-time check, and the signup warning.
 */
export async function checkAllTools(): Promise<ToolStatus[]> {
  const entries = Object.entries(TOOL_CHECKS);
  return Promise.all(
    entries.map(async ([key, check]) => {
      const { available, version, timedOut } = await probeTool(check);
      return {
        key,
        name: check.name,
        purpose: check.purpose,
        required: check.required,
        available,
        version,
        timedOut,
        installInstruction: getInstallInstruction(check),
      };
    }),
  );
}

/**
 * Non-fatal heads-up about missing tools. Prints warnings and returns the
 * missing required tools; never throws or exits. Used at signup so users learn
 * what they'll need for upload/validation before they get there.
 */
export async function warnMissingPrerequisites(): Promise<ToolStatus[]> {
  const statuses = await checkAllTools();
  const missing = statuses.filter((s) => s.required && !s.available);
  if (missing.length === 0) return [];

  console.warn("\nHeads up: some tools NEMAR needs for uploading/validating aren't installed yet:");
  for (const tool of missing) {
    console.warn(`  - ${tool.name} (${tool.purpose})`);
    console.warn(`      Install: ${tool.installInstruction}`);
  }
  console.warn("Run `nemar doctor` anytime to re-check. You can finish signup without them.\n");
  return missing;
}

export interface PrerequisiteFailure {
  tool: string;
  installInstruction: string;
  timedOut?: boolean;
}

/**
 * Check prerequisites for a given command. Throws (with install guidance) if any
 * required tool is missing. Runs all checks in parallel for speed.
 */
export async function checkPrerequisitesForCommand(command: NemarCommand): Promise<void> {
  const toolKeys = COMMAND_TOOLS[command];
  const checks = toolKeys.map((key) => TOOL_CHECKS[key]).filter(Boolean);

  const results = await Promise.all(
    checks.map(async (check) => {
      const probe = await probeTool(check);
      return { check, available: probe.available, timedOut: probe.timedOut };
    }),
  );

  const failures: PrerequisiteFailure[] = results
    .filter((r) => !r.available && r.check.required)
    .map((r) => ({
      tool: r.check.name,
      installInstruction: getInstallInstruction(r.check),
      timedOut: r.timedOut,
    }));

  if (failures.length === 0) return;

  const lines = ["\nMissing required tools:"];
  for (const failure of failures) {
    lines.push(
      `  ${failure.tool} ${failure.timedOut ? "timed out while checking" : "not installed"}`,
    );
    lines.push(`    Install: ${failure.installInstruction}`);
  }
  throw new Error(lines.join("\n"));
}
