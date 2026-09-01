/**
 * `nemar __complete` network and latency behaviour (epic #1144 phase 5b,
 * issue #1149 -- plan verification cases 1 and 2).
 *
 * Both cases spawn the REAL CLI from source (`bun run src/index.ts __complete
 * -- ...`), the same subprocess pattern test/facet-cli-options.unit.test.ts
 * uses, so the assertion is about what src/index.ts's `main()` actually does
 * (D1's guard), not a reimplementation of it.
 *
 * D1: `__complete` must sit above `initUpdateCheck()` and return WITHOUT
 * calling `program.parseAsync()`. Be precise about what removing the guard
 * would actually do, since an earlier version of this docstring got it wrong
 * (#1173 review): `__complete` is not a registered Commander command, so
 * parseAsync() would exit 1 with "unknown command" BEFORE any preAction hook
 * runs -- it would not fire `GET /notices`, it would simply stop working.
 * The network cost this guard genuinely avoids today is `initUpdateCheck()`,
 * which blocks on a cold cache and runs before parseAsync() whatever command
 * was typed. `GET /notices` is why `__complete` is not registered as a normal
 * command in the first place, not something this guard skips.
 *
 * These tests assert the guarded path makes ZERO requests, which holds under
 * either account and is the property that actually matters. Case 1 proves the
 * network side directly. Case 2 proves the latency consequence of the same
 * guard using a deliberately SLOW (not merely unreachable) local server: an
 * unreachable host can fail fast or hang depending on the machine's network
 * stack, which would make a timing assertion unreliable in either
 * direction. A server that is reachable but slow to respond means "the
 * guard was removed" and "the network is offline" produce the same
 * observable symptom (a request that takes a while), so this test catches
 * the regression deterministically regardless of what "unreachable" happens
 * to mean on the machine running it.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "bun";

const CLI_ENTRY = join(import.meta.dir, "..", "src", "index.ts");
const REPO_ROOT = join(import.meta.dir, "..");

/** Responds to EVERY path (including /notices) after `delayMs`, and records
 *  every request it receives. */
function startServer(delayMs: number): { url: string; requests: URL[]; stop: () => void } {
  const requests: URL[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      requests.push(new URL(req.url));
      if (delayMs > 0) await Bun.sleep(delayMs);
      return new Response(JSON.stringify({ notices: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  return {
    url: `http://localhost:${server.port}`,
    requests,
    stop: () => server.stop(true),
  };
}

let configDir: string;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "nemar-completion-net-"));
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

async function runComplete(
  words: string[],
  apiUrl: string,
): Promise<{ stdout: string; exitCode: number; elapsedMs: number }> {
  const env = {
    ...process.env,
    NEMAR_CONFIG_DIR: configDir,
    TEST_API_URL: apiUrl,
    NEMAR_NO_UPDATE_CHECK: "1",
    NO_COLOR: "1",
  };
  env.FORCE_COLOR = undefined;
  env.CLICOLOR_FORCE = undefined;
  const start = performance.now();
  const proc = spawn({
    cmd: ["bun", "run", CLI_ENTRY, "__complete", "--", ...words],
    cwd: REPO_ROOT,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  const elapsedMs = performance.now() - start;
  return { stdout, exitCode, elapsedMs };
}

describe("verification case 1: __complete makes zero network requests", () => {
  test("including /notices, which every other command triggers via preAction", async () => {
    const server = startServer(0);
    try {
      const result = await runComplete(["dataset", "list", "--sou"], server.url);
      expect(result.exitCode).toBe(0);
      expect(server.requests.length).toBe(0);
    } finally {
      server.stop();
    }
  });

  test("even when completing a dynamic-cache flag with no cache on disk", async () => {
    const server = startServer(0);
    try {
      const result = await runComplete(["dataset", "list", "--task", ""], server.url);
      expect(result.exitCode).toBe(0);
      expect(server.requests.length).toBe(0);
    } finally {
      server.stop();
    }
  });
});

describe("verification case 2: __complete stays well within budget offline", () => {
  test("cold cache, no cached candidates, server would be slow if ever contacted", async () => {
    // 800ms is comfortably above the 400ms ceiling below but short enough
    // that a regression fails this test quickly instead of hanging it.
    const server = startServer(800);
    try {
      const result = await runComplete(["dataset", "list", "--sou"], server.url);
      expect(result.exitCode).toBe(0);
      // Target budget is ~100ms; pinned at 400ms so this isn't flaky on a
      // loaded machine, while staying well under the server's 800ms delay --
      // a reintroduced network call is still caught, just not by the
      // tightest possible margin.
      expect(result.elapsedMs).toBeLessThan(400);
    } finally {
      server.stop();
    }
  });
});
