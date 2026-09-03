/**
 * Issue #1049: `nemar admin recover` was broken in published npm builds
 * because `scripts/recover-datasets.json` was never shipped (package.json
 * "files" omitted it) AND `defaultRecoverDatasetsPath()` hardcoded a
 * "two levels up from this source file" resolution that only holds for a
 * repo checkout (src/commands/ -> src/ -> repo root); the published,
 * single-file `dist/index.js` bundle sits only ONE level above the
 * package's `scripts/` dir, so the old code resolved to a path outside
 * the installed package entirely and 404'd on every real run.
 *
 * Both halves are driven through their real entry points here, no mocks:
 *  - `bun pm pack` is the actual npm packaging tool, so the packed-file-list
 *    assertion is what a real `npm publish` would ship, not a re-read of
 *    package.json's "files" array.
 *  - the path-resolution assertions run the real `nemar admin recover`
 *    command as a subprocess, once from source (`bun run src/index.ts`) and
 *    once from a real `bun build` bundle placed at the same repo-relative
 *    layout npm installs it at (dist/index.js next to scripts/), so the
 *    fallback branch in defaultRecoverDatasetsPath() is exercised for real.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "bun";
import rootPkg from "../package.json";

const REPO_ROOT = join(import.meta.dir, "..");
const CLI_ENTRY = join(REPO_ROOT, "src", "index.ts");
const DIST_ENTRY = join(REPO_ROOT, "dist", "index.js");
const RECOVER_JSON = join(REPO_ROOT, "scripts", "recover-datasets.json");

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function run(
  cmd: string[],
  envOverrides?: Record<string, string | undefined>,
): Promise<RunResult> {
  const proc = spawn({
    cmd,
    cwd: REPO_ROOT,
    env: { ...process.env, NEMAR_NO_UPDATE_CHECK: "1", ...envOverrides },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

function seedAuthenticatedConfig(configDir: string): void {
  writeFileSync(
    join(configDir, "config.json"),
    JSON.stringify({
      activeAccount: "recoverpkguser",
      accounts: { recoverpkguser: { apiKey: "test-admin-key" } },
    }),
  );
}

/** The dry-run recover path never calls the backend itself, but every real
 *  `nemar` invocation fires a `GET /notices` preAction hook first (mirrors
 *  test/zarr-fidelity-sweep-cli.test.ts's harness) -- point it at a local
 *  stub instead of the real production API so this stays a pure, offline
 *  test of path resolution. */
function startNoticesStub(): { url: string; stop: () => void } {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/notices") {
        return new Response(JSON.stringify({ notices: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return { url: `http://localhost:${server.port}`, stop: () => server.stop(true) };
}

describe("npm package includes scripts/recover-datasets.json (#1049)", () => {
  test("package.json 'files' lists it", () => {
    expect(rootPkg.files).toContain("scripts/recover-datasets.json");
  });

  test("the file actually exists on disk (a files entry alone proves nothing)", () => {
    expect(existsSync(RECOVER_JSON)).toBe(true);
  });

  test("`bun pm pack` (the real npm packaging tool) actually includes it in the tarball", async () => {
    const result = await run(["bun", "pm", "pack", "--dry-run", "--ignore-scripts", "--quiet"]);
    expect(result.exitCode).toBe(0);
    // --quiet still prints the tarball filename; run without --quiet once
    // more captured to stderr/stdout isn't guaranteed stable across bun
    // versions, so assert on a second, verbose invocation instead.
    const verbose = await run(["bun", "pm", "pack", "--dry-run", "--ignore-scripts"]);
    expect(verbose.exitCode).toBe(0);
    expect(verbose.stdout).toContain("scripts/recover-datasets.json");
  });
});

describe("nemar admin recover resolves its default file from source (#1049)", () => {
  test("`bun run src/index.ts admin recover --all --json` loads the real 45-entry list", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "nemar-recover-src-"));
    seedAuthenticatedConfig(configDir);
    const notices = startNoticesStub();
    try {
      const result = await run(["bun", "run", CLI_ENTRY, "admin", "recover", "--all", "--json"], {
        NEMAR_CONFIG_DIR: configDir,
        TEST_API_URL: notices.url,
      });
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.dry_run).toBe(true);
      expect(parsed.targets.length).toBe(45);
      expect(parsed.targets).toContain("on002814");
    } finally {
      notices.stop();
      rmSync(configDir, { recursive: true, force: true });
    }
  });
});

describe("nemar admin recover resolves its default file from a published-layout dist bundle (#1049)", () => {
  test("a real `bun build` bundle at dist/index.js (sibling of scripts/, the npm-installed layout) finds the file", async () => {
    // Build the actual single-file bundle at the same repo-relative path npm
    // ships it at (dist/index.js next to scripts/) -- dist/ is gitignored so
    // this doesn't touch tracked files. This is the exact layout the old
    // "two levels up from import.meta.dir" resolution 404'd against, because
    // from dist/ that resolution lands one directory ABOVE the installed
    // package instead of at its scripts/ dir.
    const build = await run([
      "bun",
      "build",
      CLI_ENTRY,
      "--outdir",
      join(REPO_ROOT, "dist"),
      "--target",
      "bun",
    ]);
    expect(build.exitCode).toBe(0);
    expect(existsSync(DIST_ENTRY)).toBe(true);

    const configDir = mkdtempSync(join(tmpdir(), "nemar-recover-dist-"));
    seedAuthenticatedConfig(configDir);
    const notices = startNoticesStub();
    try {
      const result = await run(["bun", DIST_ENTRY, "admin", "recover", "--all", "--json"], {
        NEMAR_CONFIG_DIR: configDir,
        TEST_API_URL: notices.url,
      });
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.dry_run).toBe(true);
      expect(parsed.targets.length).toBe(45);
      expect(parsed.targets).toContain("on002814");
    } finally {
      notices.stop();
      rmSync(configDir, { recursive: true, force: true });
    }
  });
});
