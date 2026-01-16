/**
 * SSH Key Management for NEMAR CLI
 *
 * Handles automatic SSH key generation and configuration for GitHub access.
 * Creates a dedicated NEMAR SSH key to avoid modifying user's existing SSH setup.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "bun";

/** SSH key file paths */
export interface SSHKeyPaths {
  privateKey: string;
  publicKey: string;
  sshDir: string;
  configFile: string;
}

/** Result of SSH key generation */
export interface SSHKeyResult {
  success: boolean;
  publicKey?: string;
  error?: string;
}

/**
 * Get paths for NEMAR SSH key files
 */
export function getSSHKeyPaths(): SSHKeyPaths {
  const sshDir = join(homedir(), ".ssh");
  return {
    sshDir,
    privateKey: join(sshDir, "nemar_ed25519"),
    publicKey: join(sshDir, "nemar_ed25519.pub"),
    configFile: join(sshDir, "config"),
  };
}

/**
 * Check if NEMAR SSH key exists
 */
export function nemarSSHKeyExists(): boolean {
  const paths = getSSHKeyPaths();
  return existsSync(paths.privateKey) && existsSync(paths.publicKey);
}

/**
 * Generate a new Ed25519 SSH key pair for NEMAR
 */
export async function generateSSHKey(email: string): Promise<SSHKeyResult> {
  const paths = getSSHKeyPaths();

  // Ensure .ssh directory exists with correct permissions
  if (!existsSync(paths.sshDir)) {
    try {
      mkdirSync(paths.sshDir, { mode: 0o700 });
    } catch (error) {
      return { success: false, error: `Cannot create ~/.ssh directory: ${(error as Error).message}` };
    }
  }

  // Check if key already exists
  if (existsSync(paths.privateKey)) {
    // Read and return existing public key
    try {
      const publicKey = readFileSync(paths.publicKey, "utf-8").trim();
      return { success: true, publicKey };
    } catch (error) {
      return { success: false, error: `NEMAR SSH key exists but cannot read public key: ${(error as Error).message}` };
    }
  }

  // Generate new key pair using ssh-keygen
  try {
    const proc = spawn({
      cmd: [
        "ssh-keygen",
        "-t", "ed25519",
        "-f", paths.privateKey,
        "-N", "", // Empty passphrase for automation
        "-C", `nemar-cli-${email}`,
      ],
      stdout: "pipe",
      stderr: "pipe",
    });

    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      return { success: false, error: `ssh-keygen failed: ${stderr}` };
    }

    // Read the generated public key
    const publicKey = readFileSync(paths.publicKey, "utf-8").trim();
    return { success: true, publicKey };
  } catch (error) {
    return { success: false, error: `Failed to generate SSH key: ${(error as Error).message}` };
  }
}

/**
 * Read the NEMAR SSH public key
 */
export function readPublicKey(): string | null {
  const paths = getSSHKeyPaths();
  if (!existsSync(paths.publicKey)) {
    return null;
  }
  try {
    return readFileSync(paths.publicKey, "utf-8").trim();
  } catch {
    return null;
  }
}

/**
 * Check if SSH config already has NEMAR entry for GitHub
 */
export function hasSSHConfigEntry(): boolean {
  const paths = getSSHKeyPaths();
  if (!existsSync(paths.configFile)) {
    return false;
  }
  try {
    const config = readFileSync(paths.configFile, "utf-8");
    // Check if there's a Host github.com entry using our key
    return config.includes("IdentityFile ~/.ssh/nemar_ed25519") ||
           config.includes(`IdentityFile ${paths.privateKey}`);
  } catch {
    return false;
  }
}

/**
 * Add SSH config entry to use NEMAR key for GitHub
 * Uses Match directive to add the key without overriding existing GitHub config
 */
export function configureSSHForGitHub(): { success: boolean; error?: string } {
  const paths = getSSHKeyPaths();

  // Ensure .ssh directory exists
  if (!existsSync(paths.sshDir)) {
    try {
      mkdirSync(paths.sshDir, { mode: 0o700 });
    } catch (error) {
      return { success: false, error: `Cannot create ~/.ssh directory: ${(error as Error).message}` };
    }
  }

  // Check if already configured
  if (hasSSHConfigEntry()) {
    return { success: true };
  }

  // SSH config entry that adds the NEMAR key without overriding existing config
  // Using IdentitiesOnly no allows other keys to also be tried
  const configEntry = `
# NEMAR CLI SSH key (auto-generated)
Host github.com
  AddKeysToAgent yes
  IdentityFile ~/.ssh/nemar_ed25519
  IdentitiesOnly no
`;

  try {
    if (existsSync(paths.configFile)) {
      // Append to existing config
      appendFileSync(paths.configFile, configEntry);
    } else {
      // Create new config file
      writeFileSync(paths.configFile, configEntry.trim() + "\n", { mode: 0o600 });
    }
    return { success: true };
  } catch (error) {
    return { success: false, error: `Failed to update SSH config: ${(error as Error).message}` };
  }
}

/**
 * Test SSH connection to GitHub
 */
export async function testGitHubSSH(): Promise<{
  success: boolean;
  username?: string;
  error?: string;
}> {
  try {
    const proc = spawn({
      cmd: [
        "ssh",
        "-T",
        "-o", "BatchMode=yes",
        "-o", "StrictHostKeyChecking=accept-new",
        "-o", "ConnectTimeout=10",
        "git@github.com",
      ],
      stdout: "pipe",
      stderr: "pipe",
    });

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    await proc.exited;

    const output = stdout + stderr;
    const match = output.match(/Hi ([^!]+)!/);

    if (match) {
      return { success: true, username: match[1] };
    }

    if (output.includes("Permission denied")) {
      return { success: false, error: "Permission denied - SSH key not recognized by GitHub" };
    }

    if (output.includes("successfully authenticated")) {
      return { success: true };
    }

    return { success: false, error: "Could not authenticate with GitHub" };
  } catch (error) {
    return { success: false, error: `SSH connection failed: ${(error as Error).message}` };
  }
}
