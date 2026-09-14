/**
 * Re-registering content NEMAR holds but never advertised (#1392).
 *
 * The sweep that repairs 528 imported datasets, driven against real git-annex
 * repositories with a real `type=directory` remote and a real bare origin. The
 * one boundary that is injected is the bucket listing, because S3 is the one
 * thing a test cannot have; the implementation behind it reads an actual
 * directory of actual objects, so "what the bucket holds" is never a fixture.
 *
 * Every assertion about a registration reads the location log, never a return
 * value, for the reason the issue exists.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ObjectSource,
  repairDatasetKeyRegistration,
  resolveRemoteUuid,
  scanDatasetKeyRegistration,
  sweepKeyRegistration,
} from "../src/lib/fleet-key-registration";
import { runCommand } from "../src/lib/git-annex/run-command";

let root: string;
let origin: string;
let store: string;
let workRoot: string;
const scratch: string[] = [];

async function run(args: string[], cwd: string): Promise<string> {
  const { stdout, stderr, exitCode } = await runCommand(args, { cwd });
  if (exitCode !== 0) {
    throw new Error(`${args.join(" ")} failed: ${stderr.trim() || `exit ${exitCode}`}`);
  }
  return stdout;
}

function removeTree(dir: string): void {
  Bun.spawnSync(["chmod", "-R", "u+w", dir]);
  rmSync(dir, { recursive: true, force: true });
}

/**
 * What the directory remote actually holds, read off disk.
 *
 * git-annex lays a `type=directory` store out as `<a>/<b>/<key>/<key>`, so the
 * key is the name of the directory holding the object. This stands in for the
 * S3 listing at the same boundary and with the same contract: bare keys.
 */
function directoryObjectSource(dir: string): ObjectSource {
  return async () => {
    const keys = new Set<string>();
    const walk = (path: string, depth: number): void => {
      if (!existsSync(path)) return;
      for (const name of readdirSync(path, { withFileTypes: true })) {
        if (!name.isDirectory()) continue;
        if (depth === 2) keys.add(name.name);
        else walk(join(path, name.name), depth + 1);
      }
    };
    walk(dir, 0);
    return keys;
  };
}

/** A clone of origin with the annex initialized, as the sweep makes one. */
async function cloneForScan(name = "scan"): Promise<string> {
  const path = join(root, name);
  await run(["git", "clone", "-q", origin, path], root);
  await run(["git", "config", "user.email", "test@nemar.test"], path);
  await run(["git", "config", "user.name", "NEMAR Test"], path);
  await run(["git", "annex", "init", "--quiet", name], path);
  return path;
}

/** The remote's UUID, read the way a clone has to read it: from the branch. */
async function uuidOf(datasetPath: string): Promise<string> {
  const uuid = await resolveRemoteUuid(datasetPath);
  if (!uuid) throw new Error("no nemar-s3 in remote.log");
  return uuid;
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "nemar-keyreg-fleet-"));
  scratch.push(root);
  origin = join(root, "origin.git");
  store = join(root, "store");
  workRoot = join(root, "work");
  mkdirSync(store, { recursive: true });
  mkdirSync(workRoot, { recursive: true });
  await run(["git", "init", "-q", "--bare", "--initial-branch", "main", origin], root);

  const seed = join(root, "seed");
  mkdirSync(seed, { recursive: true });
  await run(["git", "init", "-q", "--initial-branch", "main", "."], seed);
  await run(["git", "config", "user.email", "test@nemar.test"], seed);
  await run(["git", "config", "user.name", "NEMAR Test"], seed);
  await run(["git", "annex", "init", "--quiet", "seed"], seed);
  // Named `nemar-s3` so the module finds it in remote.log exactly as it does in
  // an imported dataset.
  await run(
    [
      "git",
      "annex",
      "initremote",
      "nemar-s3",
      "type=directory",
      `directory=${store}`,
      "encryption=none",
    ],
    seed,
  );
  for (let i = 0; i < 4; i++) {
    writeFileSync(join(seed, `rec${i}.bin`), `recording-${i}-`.repeat(300));
  }
  await run(["git", "annex", "add", "--quiet", "."], seed);
  await run(["git", "commit", "-qm", "add recordings"], seed);
  await run(["git", "remote", "add", "origin", origin], seed);
  // Push BEFORE copying, so origin learns the remote from `remote.log` and never
  // learns that the content reached it. That is the state #1392 left 528 datasets
  // in -- objects in the bucket, location log silent -- reproduced without having
  // to un-say anything afterwards.
  await run(["git", "push", "-q", "origin", "main", "git-annex"], seed);
  await run(["git", "annex", "copy", "--quiet", "--to", "nemar-s3", "."], seed);
}, 240_000);

afterEach(() => {
  while (scratch.length > 0) {
    const dir = scratch.pop();
    if (!dir || !existsSync(dir)) continue;
    removeTree(dir);
  }
});

describe("scanDatasetKeyRegistration", () => {
  test("reports content the bucket holds and the log does not", async () => {
    const path = await cloneForScan();
    const state = await scanDatasetKeyRegistration("on999999", path, directoryObjectSource(store));

    expect(state.remoteUuid).toMatch(/^[0-9a-f-]{36}$/);
    expect(state.annexed).toHaveLength(4);
    expect(state.registered).toEqual([]);
    expect(state.inBucket).toHaveLength(4);
    expect(state.toRegister).toEqual(state.annexed);
    expect(state.missingContent).toEqual([]);
  }, 240_000);

  test("separates content the bucket does not hold from a lost registration", async () => {
    // The #1396 shape. An empty bucket is not "every registration was lost", and
    // the two need opposite responses: one is repaired here, the other needs the
    // content transferred.
    const path = await cloneForScan();
    const state = await scanDatasetKeyRegistration("on999999", path, async () => new Set());

    expect(state.toRegister).toEqual([]);
    expect(state.missingContent).toHaveLength(4);
  }, 240_000);

  test("resolveRemoteUuid reads the UUID out of the git-annex branch", async () => {
    const path = await cloneForScan();
    const uuid = await resolveRemoteUuid(path);
    // A clone never ran initremote, so `git config remote.nemar-s3.annex-uuid` is
    // absent; the git-annex branch is the only place the UUID exists.
    expect(uuid).toMatch(/^[0-9a-f-]{36}$/);
    const fromLog = await run(["git", "show", "git-annex:remote.log"], path);
    expect(fromLog).toContain(`${uuid} `);
    expect(await resolveRemoteUuid(path, "no-such-remote")).toBeNull();
  }, 240_000);
});

describe("repairDatasetKeyRegistration", () => {
  test("registers the keys, proves it from the log, and pushes", async () => {
    const outcome = await repairDatasetKeyRegistration("on999999", directoryObjectSource(store), {
      workRoot,
      apply: true,
      originUrl: origin,
    });

    expect(outcome.action).toBe("repaired");
    expect(outcome.pushed).toBe(true);
    expect(outcome.state?.toRegister).toHaveLength(4);

    // The claim that matters, asked of a FRESH clone of origin rather than of the
    // clone that did the work.
    const after = await cloneForScan("after");
    const recorded = await run(
      ["git", "annex", "find", "--include", "*", "--in", await uuidOf(after), "--format=${key}\n"],
      after,
    );
    expect(recorded.split("\n").filter(Boolean)).toHaveLength(4);
  }, 240_000);

  test("changes nothing without --apply", async () => {
    const outcome = await repairDatasetKeyRegistration("on999999", directoryObjectSource(store), {
      workRoot,
      originUrl: origin,
    });

    expect(outcome.action).toBe("would-repair");
    expect(outcome.pushed).toBe(false);

    const after = await cloneForScan("after");
    const recorded = await run(
      ["git", "annex", "find", "--include", "*", "--in", await uuidOf(after), "--format=${key}\n"],
      after,
    );
    expect(recorded.split("\n").filter(Boolean)).toEqual([]);
  }, 240_000);

  test("leaves a dataset alone when the bucket cannot account for its content", async () => {
    // on006159 has 221 of 480 keys with no object at all. Registering the other
    // 259 would be true but would also make a dataset whose real problem is
    // missing content look like it had been repaired.
    const partial = directoryObjectSource(store);
    const outcome = await repairDatasetKeyRegistration(
      "on999999",
      async (id) => {
        const all = [...(await partial(id))];
        return new Set(all.slice(0, 2));
      },
      { workRoot, apply: true, originUrl: origin },
    );

    expect(outcome.action).toBe("skipped-missing-content");
    expect(outcome.pushed).toBe(false);
    expect(outcome.state?.missingContent).toHaveLength(2);
    expect(outcome.notes[0]).toContain("#1396");

    const after = await cloneForScan("after");
    const recorded = await run(
      ["git", "annex", "find", "--include", "*", "--in", await uuidOf(after), "--format=${key}\n"],
      after,
    );
    expect(recorded.split("\n").filter(Boolean)).toEqual([]);
  }, 240_000);

  test("a second run reports compliant and pushes nothing", async () => {
    await repairDatasetKeyRegistration("on999999", directoryObjectSource(store), {
      workRoot,
      apply: true,
      originUrl: origin,
    });
    const before = await run(["git", "rev-parse", "git-annex"], origin);

    const second = await repairDatasetKeyRegistration("on999999", directoryObjectSource(store), {
      workRoot,
      apply: true,
      originUrl: origin,
    });

    expect(second.action).toBe("compliant");
    expect(second.pushed).toBe(false);
    expect(await run(["git", "rev-parse", "git-annex"], origin)).toBe(before);
  }, 240_000);

  test("a rehearsal registers locally and pushes nothing", async () => {
    const before = await run(["git", "rev-parse", "git-annex"], origin);
    const outcome = await repairDatasetKeyRegistration("on999999", directoryObjectSource(store), {
      workRoot,
      apply: true,
      push: false,
      originUrl: origin,
    });

    expect(outcome.action).toBe("repaired");
    expect(outcome.pushed).toBe(false);
    expect(await run(["git", "rev-parse", "git-annex"], origin)).toBe(before);
  }, 240_000);

  test("a repository with no NEMAR remote is skipped, not failed", async () => {
    const outcome = await repairDatasetKeyRegistration("on999999", directoryObjectSource(store), {
      workRoot,
      apply: true,
      originUrl: origin,
      remoteName: "not-configured",
    });
    expect(outcome.action).toBe("skipped-no-remote");
    expect(outcome.pushed).toBe(false);
  }, 240_000);
});

describe("sweepKeyRegistration", () => {
  test("tallies every dataset and counts the keys it registered", async () => {
    const seen: string[] = [];
    const sweep = await sweepKeyRegistration(["on999999"], directoryObjectSource(store), {
      workRoot,
      apply: true,
      originUrl: origin,
      concurrency: 2,
      onDataset: (outcome) => seen.push(outcome.datasetId),
    });

    expect(seen).toEqual(["on999999"]);
    expect(sweep.tally.repaired).toBe(1);
    expect(sweep.tally.failed).toBe(0);
    expect(sweep.keysRegistered).toBe(4);
  }, 240_000);

  test("a dataset that cannot be cloned is one failure, not the end of the sweep", async () => {
    const sweep = await sweepKeyRegistration(
      ["on999999", "on999998"],
      directoryObjectSource(store),
      {
        workRoot,
        apply: true,
        // Both ids clone from the same real origin; the second run's path differs,
        // so only a genuinely bad URL fails. Point the sweep at one that is not a
        // repository at all.
        originUrl: join(root, "not-a-repository"),
        concurrency: 2,
      },
    );
    expect(sweep.tally.failed).toBe(2);
    expect(sweep.outcomes[0].error).toBeTruthy();
  }, 240_000);
});
