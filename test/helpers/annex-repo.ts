/**
 * Real git-annex repositories for the upload tests, built through the production
 * init path (an unlocked adjusted branch with NEMAR's `annex.largefiles`), plus a
 * directory special remote standing in for the S3 one.
 *
 * Nothing here replaces behavior: every repository is a real one, every remote is
 * git-annex's own `directory` remote, and the tests read their answers back from
 * git-annex. The helper only removes the boilerplate that six test files would
 * otherwise each retype.
 */

import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { configureLargefiles, initDataset } from "../../src/lib/git-annex/init";
import { runCommand } from "../../src/lib/git-annex/run-command";

/** Run a command and return its output; a thin alias so tests read like shell. */
export async function run(
  cmd: string[],
  cwd?: string,
  options: { stdin?: string; env?: Record<string, string> } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const { stdout, stderr, exitCode } = await runCommand(cmd, { cwd, ...options });
  return { stdout, stderr, exitCode };
}

/** git-annex marks object files read-only; rm needs write+execute on directories. */
export function chmodTreeWritable(dir: string): void {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      try {
        chmodSync(full, 0o755);
      } catch {}
      chmodTreeWritable(full);
    } else {
      try {
        chmodSync(full, 0o644);
      } catch {}
    }
  }
}

/** A scratch directory outside any repository, removed (read-only objects and all) by `cleanup`. */
export function makeScratch(prefix: string): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), `${prefix}-`));
  return {
    root,
    cleanup: () => {
      try {
        chmodTreeWritable(root);
      } catch {}
      rmSync(root, { recursive: true, force: true });
    },
  };
}

let counter = 0;

/** A fresh dataset repository with the identity git needs and NEMAR's policy configured. */
export async function newDatasetRepo(root: string, name: string): Promise<string> {
  counter += 1;
  const dir = join(root, `${name}-${counter}`);
  mkdirSync(dir, { recursive: true });
  const init = await initDataset(dir, { author: { name: "Test", email: "test@test.com" } });
  if (!init.success) throw new Error(`initDataset failed: ${init.error}`);
  // git-annex branch writes (config, add, initremote, copy) run without the author env
  // initDataset sets for its own commands, and CI runners have no global identity.
  await run(["git", "config", "user.email", "test@test.com"], dir);
  await run(["git", "config", "user.name", "Test"], dir);
  const largefiles = await configureLargefiles(dir);
  if (!largefiles.success) throw new Error(`configureLargefiles failed: ${largefiles.error}`);
  return dir;
}

/** Write a file (creating parents) with `content`, or `size` filler bytes. */
export function writeFile(dir: string, relPath: string, content: string | Buffer | number): void {
  const full = join(dir, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, typeof content === "number" ? "x".repeat(content) : content);
}

/**
 * Register a git-annex `directory` special remote called `name` and return the
 * directory that holds its objects. The remote is real: content is copied into it
 * and the location log records that, exactly as for the S3 remote.
 */
export async function initDirectoryRemote(
  root: string,
  repo: string,
  name: string,
): Promise<string> {
  counter += 1;
  const storeDir = join(root, `${name}-store-${counter}`);
  mkdirSync(storeDir, { recursive: true });
  const init = await run(
    [
      "git",
      "annex",
      "initremote",
      name,
      "type=directory",
      `directory=${storeDir}`,
      "encryption=none",
    ],
    repo,
  );
  if (init.exitCode !== 0) throw new Error(`initremote failed: ${init.stderr}`);
  return storeDir;
}

/** Paths git-annex considers annexed in the working tree (present or not). */
export async function annexedSet(dir: string): Promise<Set<string>> {
  const { stdout, exitCode, stderr } = await run(["git", "annex", "find", "--include", "*"], dir);
  if (exitCode !== 0) throw new Error(`git annex find failed: ${stderr}`);
  return new Set(stdout.split("\n").filter(Boolean));
}
