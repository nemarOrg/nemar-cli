/**
 * Two guards of a re-pull execution's working directory (ADR 0111; epic #1046 phase 6):
 * `withIsolatedGit`, which puts `GIT_CONFIG_GLOBAL=/dev/null` and `GIT_CONFIG_NOSYSTEM=1` in the
 * process environment for every git subprocess and must put the user's values back however calls
 * overlap, and the plan lock's release, which removes only the lock its own process holds. The
 * lock's contention is driven end to end in `repull-execute-prepare.test.ts`.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ISOLATED_GIT_ENV, acquireLock, withIsolatedGit } from "../src/lib/repull/execute/workdir";

const NAMES = Object.keys(ISOLATED_GIT_ENV);
const saved = NAMES.map((k) => [k, process.env[k]] as const);

afterEach(() => {
  for (const [k, v] of saved) {
    if (v === undefined) Reflect.deleteProperty(process.env, k);
    else process.env[k] = v;
  }
});

describe("withIsolatedGit", () => {
  test("isolates inside and puts the user's values back after", async () => {
    process.env.GIT_CONFIG_GLOBAL = "/home/someone/.gitconfig";
    Reflect.deleteProperty(process.env, "GIT_CONFIG_NOSYSTEM");
    await withIsolatedGit(async () => {
      expect(process.env.GIT_CONFIG_GLOBAL).toBe("/dev/null");
      expect(process.env.GIT_CONFIG_NOSYSTEM).toBe("1");
    });
    expect(process.env.GIT_CONFIG_GLOBAL).toBe("/home/someone/.gitconfig");
    expect("GIT_CONFIG_NOSYSTEM" in process.env).toBe(false);
  });

  test("overlapping calls keep the isolation until the last ends, then restore the user's values", async () => {
    process.env.GIT_CONFIG_GLOBAL = "/home/someone/.gitconfig";
    Reflect.deleteProperty(process.env, "GIT_CONFIG_NOSYSTEM");
    const gates = { first: () => {}, second: () => {} };
    const first = withIsolatedGit(
      () =>
        new Promise<void>((r) => {
          gates.first = r;
        }),
    );
    const second = withIsolatedGit(
      () =>
        new Promise<void>((r) => {
          gates.second = r;
        }),
    );
    // The first to start ends first: the second is still running and must stay isolated.
    gates.first();
    await first;
    expect(process.env.GIT_CONFIG_GLOBAL).toBe("/dev/null");
    gates.second();
    await second;
    expect(process.env.GIT_CONFIG_GLOBAL).toBe("/home/someone/.gitconfig");
    expect("GIT_CONFIG_NOSYSTEM" in process.env).toBe(false);
  });

  test("a call that throws still restores", async () => {
    process.env.GIT_CONFIG_GLOBAL = "/home/someone/.gitconfig";
    await expect(
      withIsolatedGit(async () => {
        throw new Error("refused");
      }),
    ).rejects.toThrow("refused");
    expect(process.env.GIT_CONFIG_GLOBAL).toBe("/home/someone/.gitconfig");
  });
});

describe("the plan lock", () => {
  test("is taken with this process's id and released by it", () => {
    const dir = mkdtempSync(join(tmpdir(), "nemar-repull-lock-"));
    try {
      const lock = join(dir, "plan.lock");
      const release = acquireLock(lock);
      expect(readFileSync(join(lock, "pid"), "utf8")).toBe(`${process.pid}\n`);
      release();
      expect(existsSync(lock)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a release never removes a lock another process now holds", () => {
    const dir = mkdtempSync(join(tmpdir(), "nemar-repull-lock-"));
    try {
      const lock = join(dir, "plan.lock");
      const release = acquireLock(lock);
      // Taken over in between (this run was judged crashed): the lock is another run's now.
      writeFileSync(join(lock, "pid"), "1\n");
      release();
      expect(readFileSync(join(lock, "pid"), "utf8")).toBe("1\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
