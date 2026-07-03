/**
 * Upload pipeline: dataset creation and data-transfer steps.
 *
 * Moved verbatim from the upload action in commands/dataset.ts (#907,
 * epic #902); the only intentional changes are import paths and the
 * step-function wrappers. Steps print their own output and never call
 * process.exit (the command sequencer owns exits).
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import chalk from "chalk";
import { errorDetail } from "../api.js";

/**
 * Extract repo full name from github_url (e.g., "https://github.com/nemarDatasets/nm000123").
 * Validate URL format: must be a valid GitHub URL with owner/repo pattern.
 * Returns null when the URL doesn't match (caller prints the failure).
 */
export function parseRepoFullName(githubUrl: string | undefined): string | null {
  const repoMatch = githubUrl?.match(/github\.com\/([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+)/);
  return repoMatch ? repoMatch[1].replace(/\.git$/, "") : null;
}

/** Ensure .nemar/ is gitignored (internal config, not dataset content). Warn-and-continue. */
export function ensureGitignoreHasNemar(absolutePath: string): void {
  try {
    const gitignorePath = resolve(absolutePath, ".gitignore");
    let gitignoreContent = "";
    if (existsSync(gitignorePath)) {
      gitignoreContent = readFileSync(gitignorePath, "utf-8");
    }
    if (!gitignoreContent.includes(".nemar/")) {
      const newContent = gitignoreContent
        ? `${gitignoreContent.trimEnd()}\n.nemar/\n`
        : ".nemar/\n";
      writeFileSync(gitignorePath, newContent);
    }
  } catch (gitignoreErr) {
    console.log(
      chalk.yellow(`  Warning: Could not update .gitignore: ${errorDetail(gitignoreErr)}`),
    );
  }
}
