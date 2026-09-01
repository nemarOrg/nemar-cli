/**
 * Completion cache degradation (epic #1144 phase 5b, issue #1149 -- plan
 * verification case 5, D3): "missing file, unreadable file, malformed JSON,
 * a JSON value of the wrong shape, an expired entry" must all degrade to
 * static candidates and exit 0 -- never a thrown error surfaced at the
 * shell prompt.
 *
 * Driven through the real `nemar __complete` subprocess for the entry-point
 * guarantee (exit code included -- readCompletionCache() returning null is
 * necessary but not sufficient; something upstream has to still print the
 * static fallback and exit cleanly). A second describe block below calls
 * readCompletionCache() directly as a SUPPLEMENT: run.ts wraps the whole
 * candidate lookup in its own try/catch (D1's "never throws" guarantee for
 * __complete as a whole), which means a regression that deletes cache.ts's
 * own try/catch is invisible at the subprocess/exit-code level -- run.ts's
 * outer net silently catches it too. Only a direct call can tell the two
 * layers apart.
 *
 * `--source` is used as the "has a static fallback" flag (declared in
 * shared/facets.ts) and `--task` as the "dynamic-only, no static fallback"
 * flag, so degradation is checked on both shapes: falls back to something,
 * and falls back to nothing, but never falls back to a crash.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "bun";
import { datasetSourceSchema } from "../shared/contract/dataset";
import { readCompletionCache } from "../src/lib/completion/cache";

const CLI_ENTRY = join(import.meta.dir, "..", "src", "index.ts");
const REPO_ROOT = join(import.meta.dir, "..");
const STATIC_SOURCE_VALUES = [...datasetSourceSchema.options].sort();

async function runComplete(
  configDir: string,
  words: string[],
): Promise<{ candidates: string[]; directiveLine: string; exitCode: number }> {
  const env = { ...process.env, NEMAR_CONFIG_DIR: configDir, NO_COLOR: "1" };
  env.FORCE_COLOR = undefined;
  env.CLICOLOR_FORCE = undefined;
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
  const lines = stdout.split("\n").filter((_, i, arr) => i < arr.length - 1 || arr[i] !== "");
  const directiveLine = lines[lines.length - 1] ?? "";
  const candidates = lines.slice(0, -1);
  return { candidates, directiveLine, exitCode };
}

function cacheFile(dir: string): string {
  return join(dir, "completion-cache.json");
}

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "nemar-completion-cache-"));
}

describe("verification case 5: cache degradation", () => {
  test("absent: no cache file at all", async () => {
    const dir = freshDir();
    try {
      const source = await runComplete(dir, ["dataset", "list", "--source", ""]);
      expect(source.exitCode).toBe(0);
      expect(source.candidates.sort()).toEqual(STATIC_SOURCE_VALUES);

      const task = await runComplete(dir, ["dataset", "list", "--task", ""]);
      expect(task.exitCode).toBe(0);
      expect(task.candidates).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("unreadable: the cache path is a directory, not a file", async () => {
    const dir = freshDir();
    try {
      mkdirSync(cacheFile(dir));
      const source = await runComplete(dir, ["dataset", "list", "--source", ""]);
      expect(source.exitCode).toBe(0);
      expect(source.candidates.sort()).toEqual(STATIC_SOURCE_VALUES);

      const task = await runComplete(dir, ["dataset", "list", "--task", ""]);
      expect(task.exitCode).toBe(0);
      expect(task.candidates).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("malformed JSON", async () => {
    const dir = freshDir();
    try {
      writeFileSync(cacheFile(dir), "{not valid json at all");
      const source = await runComplete(dir, ["dataset", "list", "--source", ""]);
      expect(source.exitCode).toBe(0);
      expect(source.candidates.sort()).toEqual(STATIC_SOURCE_VALUES);

      const task = await runComplete(dir, ["dataset", "list", "--task", ""]);
      expect(task.exitCode).toBe(0);
      expect(task.candidates).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("right JSON, wrong shape: task carries an array instead of {values,...}", async () => {
    const dir = freshDir();
    try {
      writeFileSync(
        cacheFile(dir),
        JSON.stringify({ cachedAt: Date.now(), data: { task: ["not", "an", "object"] } }),
      );
      const source = await runComplete(dir, ["dataset", "list", "--source", ""]);
      expect(source.exitCode).toBe(0);
      expect(source.candidates.sort()).toEqual(STATIC_SOURCE_VALUES);

      const task = await runComplete(dir, ["dataset", "list", "--task", ""]);
      expect(task.exitCode).toBe(0);
      expect(task.candidates).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // A second, independently-discriminating wrong-shape case. The task/array
  // case above happens to also be caught by run.ts's outer try/catch (a
  // vocabulary entry's `.value` access throws when the entry is a bare
  // string, not an object) -- defense in depth, but it means that case
  // alone does not PROVE readCompletionCache's own zod validation is doing
  // anything. This one is a shape violation that would NOT throw if
  // unvalidated -- a numeric `value` silently stringifies -- so it can only
  // be caught by the schema check itself.
  test("right JSON, wrong shape: a vocabulary entry's value is a number, not a string", async () => {
    const dir = freshDir();
    try {
      writeFileSync(
        cacheFile(dir),
        JSON.stringify({
          cachedAt: Date.now(),
          data: { modality: [{ value: 123, count: 5 }] },
        }),
      );
      const modality = await runComplete(dir, ["dataset", "list", "--modality", ""]);
      expect(modality.exitCode).toBe(0);
      expect(modality.candidates).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("expired: well-formed and otherwise valid, but past the one-hour TTL", async () => {
    const dir = freshDir();
    try {
      const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
      writeFileSync(
        cacheFile(dir),
        JSON.stringify({
          cachedAt: twoHoursAgo,
          data: {
            task: { values: [{ value: "rest", count: 5 }], distinct_total: 1, truncated: false },
          },
        }),
      );
      const task = await runComplete(dir, ["dataset", "list", "--task", ""]);
      expect(task.exitCode).toBe(0);
      // The whole point of this case: an otherwise-valid "rest" entry must
      // NOT surface once its cachedAt is past the TTL.
      expect(task.candidates).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("positive control: a fresh, well-formed cache IS used", async () => {
    const dir = freshDir();
    try {
      writeFileSync(
        cacheFile(dir),
        JSON.stringify({
          cachedAt: Date.now(),
          data: {
            task: { values: [{ value: "rest", count: 5 }], distinct_total: 1, truncated: false },
          },
        }),
      );
      const task = await runComplete(dir, ["dataset", "list", "--task", ""]);
      expect(task.exitCode).toBe(0);
      expect(task.candidates).toEqual(["rest"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("readCompletionCache() directly (supplements the subprocess tests above)", () => {
  let directDir: string;

  beforeAll(() => {
    directDir = freshDir();
    process.env.NEMAR_CONFIG_DIR = directDir;
  });

  afterEach(() => {
    // Each test that writes a cache file (or a directory standing in for
    // one) cleans up so the next one starts from "absent" again, without
    // tearing down the whole config dir. force:true covers "absent" too.
    rmSync(cacheFile(directDir), { recursive: true, force: true });
  });

  afterAll(() => {
    // biome-ignore lint/performance/noDelete: env var cleanup, matches test/config-migrate-api-url.test.ts's convention
    delete process.env.NEMAR_CONFIG_DIR;
    rmSync(directDir, { recursive: true, force: true });
  });

  test("absent: returns null, does not throw", () => {
    expect(readCompletionCache()).toBeNull();
  });

  test("unreadable (a directory at the cache path): returns null, does not throw", () => {
    mkdirSync(cacheFile(directDir));
    expect(readCompletionCache()).toBeNull();
  });

  test("malformed JSON: returns null, does not throw", () => {
    writeFileSync(cacheFile(directDir), "{not valid json at all");
    expect(readCompletionCache()).toBeNull();
  });
});
