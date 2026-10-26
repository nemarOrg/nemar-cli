/**
 * This checkout's CLI as a release build runs it: the same source, with `package.json` naming a
 * release version (`X.Y.Z`).
 *
 * An automatic re-pull run refuses any CLI that is not the release its dispatch names (ADR 0111,
 * the Phase 7d amendment), and a checkout's own version is a development one (`0.10.24-dev11`), so
 * the suites that drive an automatic run through the real entry point need a build whose version is
 * a release. The version is read through `src/lib/version.ts`'s relative import of `package.json`,
 * so `src/` is copied beside a `package.json` that differs from this checkout's in that one field;
 * every other directory the CLI reads (`shared/`, `scripts/`, `node_modules/`, the root JSON files)
 * is a symlink to this checkout's own, so the code under test is this checkout's, byte for byte. A
 * change to `src/` after the copy is not in it: make the copy once per suite, after any edit.
 */

import {
  cpSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const LINKED = ["shared", "scripts", "node_modules", "validator-version.json", "tsconfig.json"];

export interface ReleaseCli {
  /** The entry point to `bun run`. */
  entry: string;
  /** The release version the copy reports. */
  version: string;
  /** Remove the copy: its symlinks first, so nothing they point at is touched. */
  cleanup(): void;
}

/** The release a development version is on its way to: `0.10.24-dev11` is `0.10.24`. */
export function releaseOf(version: string): string {
  const m = /^(\d+\.\d+\.\d+)/.exec(version);
  if (!m) throw new Error(`not a version: ${version}`);
  return m[1] as string;
}

export function releaseCli(): ReleaseCli {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
    version: string;
  };
  const version = releaseOf(pkg.version);
  const root = mkdtempSync(join(tmpdir(), "nemar-release-cli-"));
  cpSync(join(REPO_ROOT, "src"), join(root, "src"), { recursive: true });
  writeFileSync(join(root, "package.json"), `${JSON.stringify({ ...pkg, version }, null, 2)}\n`);
  for (const name of LINKED) symlinkSync(join(REPO_ROOT, name), join(root, name));
  return {
    entry: join(root, "src", "index.ts"),
    version,
    cleanup() {
      for (const name of LINKED) {
        const link = join(root, name);
        try {
          if (lstatSync(link).isSymbolicLink()) unlinkSync(link);
        } catch {
          // already gone
        }
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
}
