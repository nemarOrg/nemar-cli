/**
 * Prerequisite checks per CLI command
 *
 * Each NEMAR command has different tool requirements. This module provides
 * fast, clear prerequisite checking with platform-specific install guidance.
 */

import { runCommand } from "./git-annex.js";

export type NemarCommand = "upload" | "download" | "clone" | "push" | "publish";

interface ToolCheck {
  name: string;
  /** Command and args to test installation, e.g. ["git-annex", "version"] */
  cmd: string[];
  required: boolean;
  installInstructions: {
    macos: string;
    linux: string;
  };
}

const TOOL_CHECKS: Record<string, ToolCheck> = {
  "git-annex": {
    name: "git-annex",
    cmd: ["git-annex", "version"],
    required: true,
    installInstructions: {
      macos: "brew install git-annex",
      linux: "sudo apt-get install git-annex  OR  sudo dnf install git-annex",
    },
  },
  gh: {
    name: "GitHub CLI (gh)",
    cmd: ["gh", "--version"],
    required: true,
    installInstructions: {
      macos: "brew install gh",
      linux: "See https://cli.github.com/manual/installation",
    },
  },
  aws: {
    name: "AWS CLI",
    cmd: ["aws", "--version"],
    required: true,
    installInstructions: {
      macos: "brew install awscli",
      linux: "pip install awscli  OR  sudo snap install aws-cli --classic",
    },
  },
  git: {
    name: "git",
    cmd: ["git", "--version"],
    required: true,
    installInstructions: {
      macos: "brew install git  (or install Xcode Command Line Tools)",
      linux: "sudo apt-get install git",
    },
  },
};

/**
 * Required tools per command
 */
const COMMAND_TOOLS: Record<NemarCommand, string[]> = {
  upload: ["git-annex", "gh", "aws"],
  download: ["gh"],
  clone: ["git", "gh"],
  push: ["git-annex", "gh"],
  publish: ["gh", "aws"],
};

/**
 * Get platform-specific install instruction for a tool
 */
function getInstallInstruction(tool: ToolCheck): string {
  const platform = process.platform;
  if (platform === "darwin") return tool.installInstructions.macos;
  return tool.installInstructions.linux;
}

/**
 * Check if a single tool is available in PATH
 */
async function isToolAvailable(toolCheck: ToolCheck): Promise<boolean> {
  try {
    const { exitCode } = await runCommand(toolCheck.cmd);
    return exitCode === 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("ENOENT") && !msg.includes("not found")) {
      console.error(chalk.gray(`  Debug: ${toolCheck.name} check failed unexpectedly: ${msg}`));
    }
    return false;
  }
}

export interface PrerequisiteFailure {
  tool: string;
  installInstruction: string;
}

/**
 * Check all prerequisites for a given command.
 *
 * Prints a clear error and exits with code 1 if any required tool is missing.
 * Runs all checks in parallel for speed.
 */
export async function checkPrerequisitesForCommand(command: NemarCommand): Promise<void> {
  const toolKeys = COMMAND_TOOLS[command];
  const checks = toolKeys.map((key) => TOOL_CHECKS[key]).filter(Boolean);

  const results = await Promise.all(
    checks.map(async (check) => ({
      check,
      available: await isToolAvailable(check),
    })),
  );

  const failures: PrerequisiteFailure[] = results
    .filter((r) => !r.available && r.check.required)
    .map((r) => ({
      tool: r.check.name,
      installInstruction: getInstallInstruction(r.check),
    }));

  if (failures.length === 0) return;

  const lines = ["\nMissing required tools:"];
  for (const failure of failures) {
    lines.push(`  ${failure.tool} not installed`);
    lines.push(`    Install: ${failure.installInstruction}`);
  }
  throw new Error(lines.join("\n"));
}
