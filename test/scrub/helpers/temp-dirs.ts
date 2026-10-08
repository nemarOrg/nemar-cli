/**
 * One registry of the temp directories the scrub tests make, and their removal.
 *
 * A full `bun run test:scrub` once left about 8,500 `s3-scrub-*` directories (34 GB) on the
 * system disk, because `tempDir` and `copyDir` made directories nothing removed. Every directory
 * made here is recorded, and `removeTempDirs` removes exactly those, never another path.
 *
 * Three removals, because each covers what the others miss (measured with bun 1.4.2):
 * - a test file calls `afterAll(removeTempDirs)`, so a file's directories are gone when it ends
 *   (a top-level `afterAll` in an imported module registers for the FIRST importing file only:
 *   the module is evaluated once per process);
 * - `temp-dirs-preload.ts`, preloaded by `bun run test:scrub`, removes whatever is left when the
 *   whole run ends;
 * - `process.on("exit")`, for use outside `bun test`, which does not emit "exit" to test code.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const created = new Set<string>();

/** A new directory under the OS temp directory (`TMPDIR` when set), recorded for removal. */
export function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  created.add(dir);
  return dir;
}

/**
 * Remove every recorded directory that is still there. It never throws: a cleanup failure must
 * not fail or hide the run's own result, so it is reported on stderr and the path stays recorded
 * for the next removal to try again.
 */
export function removeTempDirs(): void {
  for (const dir of created) {
    try {
      rmSync(dir, { recursive: true, force: true });
      created.delete(dir);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException)?.code ?? "error";
      console.error(`temp-dirs: could not remove ${dir} (${code})`);
    }
  }
}

process.on("exit", removeTempDirs);
